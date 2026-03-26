// ==UserScript==
// @name         북마크 (Glassmorphism v25.1)
// @version      25.1
// @description  v25.0 기반 버그 픽스 & 최적화 — favicon 폴백, 필터 접기복원, 마이그레이션 저장, 드래그 데이터 보존, dirty 안전 처리
// @author       User
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* ═══════════════════════════════════
       유틸리티
       ═══════════════════════════════════ */
    const $ = (tag, attrs, children) => {
        const e = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                const v = attrs[k];
                if (v == null) continue;
                switch (k) {
                    case 'cls':   e.className = v; break;
                    case 'text':  e.textContent = v; break;
                    case 'style':
                        if (typeof v === 'object') { const s = e.style; for (const p in v) s[p] = v[p]; }
                        break;
                    default:
                        if (k.startsWith('on') && typeof v === 'function') {
                            e.addEventListener(k.slice(2).toLowerCase(), v);
                        } else {
                            e.setAttribute(k, v);
                        }
                }
            }
        }
        if (children) {
            if (Array.isArray(children)) {
                const f = children.length > 3 ? document.createDocumentFragment() : null;
                for (const c of children) if (c) (f || e).append(c);
                if (f) e.append(f);
            } else {
                e.append(children);
            }
        }
        return e;
    };

    const btn = (text, cls = '', onclick = null, style = {}) =>
        $('button', { cls: `bm-btn ${cls}`.trim(), text, onclick, style });

    const iconBtn = (icon, title, cls, onclick) =>
        $('button', { cls: `bm-icon-btn ${cls}`.trim(), text: icon, title, 'aria-label': title, onclick });

    const isUrl = s => { try { return /^https?:/.test(new URL(s).protocol); } catch { return false; } };

    const vName = (name, exist = []) => {
        const t = name?.trim();
        if (!t) return '이름을 입력하세요.';
        if (t.length > 30) return '이름은 30자 이하여야 합니다.';
        if (/[:：\/\\<>"|?*]/.test(t)) return '사용할 수 없는 문자가 포함되어 있습니다.';
        if (exist.includes(t)) return '이미 존재하는 이름입니다.';
        return null;
    };

    const pathContains = (ev, el) => {
        try { return ev.composedPath().includes(el); } catch { return false; }
    };

    /* [B1 fix] 빈 문자열 대신 투명 1px data URI 사용 */
    const FALLBACK_ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const faviconUrl = url => {
        try {
            const h = new URL(url).hostname;
            if (!h) return FALLBACK_ICON;
            return `https://www.google.com/s2/favicons?domain=${h}&sz=128`;
        } catch { return FALLBACK_ICON; }
    };

    /* [S3 fix] Range 헤더 제거 — 서버 호환성 문제 */
    const gmFetchText = (url, timeout = 5000) => new Promise(r =>
        GM_xmlhttpRequest({
            method: 'GET', url, timeout,
            onload: res => r(res.status >= 200 && res.status < 400 ? res.responseText?.substring(0, 8192) : null),
            onerror: () => r(null), ontimeout: () => r(null)
        })
    );

    const extractTitle = html => {
        if (!html) return null;
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return m?.[1]?.trim().substring(0, 30) || null;
    };

    /* ═══════════════════════════════════
       DB
       ═══════════════════════════════════ */
    let db = null, shadow = null, isSortMode = false, _isOpen = false,
        _dirty = false, _saveTimer = null, _urlSet = null;

    const validateDB = d => d?.groups && typeof d.groups === 'object';

    const migrateFromV2 = () => {
        const old = GM_getValue('bm_db_v2', null);
        if (!old?.pages) return null;
        const groups = {};
        const pageKeys = Object.keys(old.pages);
        for (const [pageName, pageGroups] of Object.entries(old.pages)) {
            for (const [groupName, items] of Object.entries(pageGroups)) {
                const key = pageKeys.length > 1 ? `${pageName}/${groupName}` : groupName;
                groups[key] = items.map(it => ({
                    name: it.name,
                    url: it.url,
                    addedAt: it.addedAt || Date.now()
                }));
            }
        }
        return { groups };
    };

    const loadDB = () => {
        const raw = GM_getValue('bm_db_v25', null);
        if (validateDB(raw)) return raw;
        const migrated = migrateFromV2();
        if (migrated) {
            /* [B4 fix] 마이그레이션 결과 즉시 저장 */
            GM_setValue('bm_db_v25', migrated);
            return migrated;
        }
        return { groups: { "북마크": [] } };
    };

    db = loadDB();

    /* [M3 fix] save 내부에서 _urlSet 자동 리셋 */
    const saveNow = () => {
        clearTimeout(_saveTimer);
        if (!_dirty) return;
        _dirty = false;
        _urlSet = null;
        try {
            GM_setValue('bm_db_v25', db);
        } catch (e) {
            console.error(e);
            alert('❌ 저장 실패!');
        }
    };

    const saveLazy = () => {
        _dirty = true;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(saveNow, 300);
    };

    /* [M2 fix] save를 직관적으로 단순화 */
    const save = () => {
        _dirty = true;
        saveNow();
    };

    /* [P2 fix] refreshDB 호출 전 미저장 변경 보호 */
    const refreshDB = () => {
        if (_dirty) saveNow();
        const fresh = GM_getValue('bm_db_v25', null);
        if (validateDB(fresh)) { db = fresh; _dirty = false; _urlSet = null; return true; }
        return false;
    };

    /* URL 중복 체크 — Set */
    const buildUrlSet = () => {
        _urlSet = new Set();
        for (const items of Object.values(db.groups)) {
            for (const it of items) _urlSet.add(it.url);
        }
    };
    const isDup = u => { if (!_urlSet) buildUrlSet(); return _urlSet.has(u); };
    const addUrl = u => { if (!_urlSet) buildUrlSet(); _urlSet.add(u); };
    const delUrl = u => { if (_urlSet) _urlSet.delete(u); };

    /* 접기 상태 */
    const _col = new Set(JSON.parse(GM_getValue('bm_collapsed_v25', '[]') || '[]'));
    const saveCol = () => GM_setValue('bm_collapsed_v25', JSON.stringify([..._col]));
    const toggleCol = g => {
        _col.has(g) ? _col.delete(g) : _col.add(g);
        saveCol();
    };

    /* 최근 저장 그룹 */
    const setRecent = g => GM_setValue('bm_recent_v25', g);
    const getRecent = () => GM_getValue('bm_recent_v25', null);

    /* ═══════════════════════════════════
       Toast, Modal, Context
       ═══════════════════════════════════ */
    let _toastTimer = 0;
    const toast = (msg, dur = 2200) => {
        clearTimeout(_toastTimer);
        shadow?.querySelector('.bm-toast')?.remove();
        const t = $('div', { cls: 'bm-toast', text: msg });
        shadow?.append(t);
        requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
        _toastTimer = setTimeout(() => {
            t.classList.remove('show');
            setTimeout(() => t.remove(), 400);
        }, dur);
    };

    const modal = (opts = {}) => {
        const d = document.createElement('dialog');
        d.className = 'bm-modal-bg';
        d.onclick = e => {
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        };
        d.onclose = () => { opts.onClose?.(); d.remove(); };
        shadow.appendChild(d);
        d.showModal();
        return d;
    };

    const popupDismiss = (el, ac) => setTimeout(() => {
        const handler = e => { if (!pathContains(e, el)) { el.remove(); ac.abort(); } };
        shadow.addEventListener('pointerdown', handler, { signal: ac.signal });
        document.addEventListener('pointerdown', handler, { signal: ac.signal, capture: true });
    }, 0);

    let _ctxAC = null;
    const ctxMenu = (e, item, gName, idx) => {
        e.preventDefault();
        _ctxAC?.abort();
        shadow.querySelector('.bm-ctx')?.remove();
        _ctxAC = new AbortController();
        const ac = _ctxAC;
        const actions = [
            { t: '✏️ 편집', fn: () => showGroupMgr(gName) },
            { t: '📋 URL 복사', fn: () => { navigator.clipboard?.writeText(item.url); toast('📋 URL 복사됨'); } },
            { t: '🗑 삭제', c: 'ctx-danger', fn: () => {
                if (!confirm(`"${item.name}" 삭제?`)) return;
                const arr = db.groups[gName];
                const i = arr[idx]?.url === item.url ? idx : arr.findIndex(x => x.url === item.url);
                if (i > -1) { arr.splice(i, 1); delUrl(item.url); }
                save(); rerender();
            }}
        ];
        const m = $('div', { cls: 'bm-ctx', style: { position: 'fixed', zIndex: '999999' } },
            actions.map(a => $('div', {
                cls: `bm-ctx-item ${a.c || ''}`, text: a.t,
                onclick: () => { m.remove(); ac.abort(); a.fn(); }
            }))
        );
        shadow.append(m);
        const r = m.getBoundingClientRect();
        m.style.left = Math.max(0, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
        m.style.top = Math.max(0, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
        popupDismiss(m, ac);
    };

    const bindLP = (el, cb) => {
        let tid = 0, moved = false, fired = false;
        el.ontouchstart = e => {
            moved = fired = false;
            tid = setTimeout(() => { if (!moved) { fired = true; cb({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: () => {} }); } }, 500);
        };
        el.ontouchmove = () => { moved = true; clearTimeout(tid); };
        el.ontouchend = e => { clearTimeout(tid); if (fired) e.preventDefault(); };
        el.ontouchcancel = () => clearTimeout(tid);
    };

    /* ═══════════════════════════════════
       내보내기 / 가져오기
       ═══════════════════════════════════ */
    const exportJSON = () => {
        if (_dirty) saveNow();
        const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
        const u = URL.createObjectURL(blob);
        const a = $('a', { href: u, download: 'bookmarks.json' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    };

    const importJSON = () => {
        const inp = $('input', { type: 'file', accept: '.json', onchange: e => {
            const r = new FileReader();
            r.onload = re => {
                try {
                    const p = JSON.parse(re.target.result);
                    if (!validateDB(p)) throw 1;
                    db = p; save(); rerender();
                    toast('✅ 복구 완료');
                } catch { alert('잘못된 파일 구조입니다.'); }
            };
            if (e.target.files[0]) r.readAsText(e.target.files[0]);
        }});
        inp.click();
    };

    /* ═══════════════════════════════════
       Sortable 관리
       ═══════════════════════════════════ */
    let _sorts = [];
    const killSorts = () => { _sorts.forEach(s => s.destroy()); _sorts.length = 0; };

    /* [B5 fix] 드래그 이동 시 원본 스냅샷을 먼저 확보하여 addedAt 보존 */
    const rebuildGroupFromDOM = (gridEl, snapshot) => {
        const itemMap = new Map();
        for (const it of snapshot) {
            if (!itemMap.has(it.url)) itemMap.set(it.url, []);
            itemMap.get(it.url).push(it);
        }
        const result = [];
        for (const w of gridEl.querySelectorAll('.bm-wrap')) {
            const url = w.href;
            const name = w.querySelector('span')?.textContent || '';
            const candidates = itemMap.get(url);
            if (candidates?.length) {
                const exactIdx = candidates.findIndex(c => c.name === name);
                result.push(exactIdx >= 0 ? candidates.splice(exactIdx, 1)[0] : candidates.shift());
            } else {
                result.push({ name, url, addedAt: Date.now() });
            }
        }
        return result;
    };

    /* ═══════════════════════════════════
       필터
       ═══════════════════════════════════ */
    let _filterRaf = 0;
    /* [B2 fix] sec.dataset.id로 그룹명 참조 */
    const filterItems = (q, container) => {
        cancelAnimationFrame(_filterRaf);
        _filterRaf = requestAnimationFrame(() => {
            const lq = q.toLowerCase();
            for (const sec of container.querySelectorAll('.bm-sec')) {
                const grid = sec.querySelector('.bm-grid');
                if (!grid) continue;
                const gn = sec.dataset.id;
                let vis = false;
                for (const wrap of grid.querySelectorAll('.bm-wrap')) {
                    const match = !q
                        || wrap.textContent.toLowerCase().includes(lq)
                        || (wrap.href || '').toLowerCase().includes(lq);
                    wrap.style.display = match ? '' : 'none';
                    if (match) vis = true;
                }
                if (q) {
                    grid.style.display = vis ? '' : 'none';
                    sec.style.display = vis ? '' : 'none';
                } else {
                    sec.style.display = '';
                    grid.style.display = !isSortMode && _col.has(gn) ? 'none' : '';
                }
            }
        });
    };

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _sTimer = null, _ctr = null;

    /* [S2 fix] _isOpen 상태 변수 사용 */
    const rerender = () => { if (_isOpen) renderDash(); };

    function renderDash() {
        const ov = shadow.querySelector('#bm-overlay');
        if (!ov) return;
        _ctxAC?.abort();
        ov.className = isSortMode ? 'sort-active' : '';
        ov.replaceChildren();

        const groups = db.groups;

        /* [O2 fix] totalCount, maxN 한 번의 순회로 계산 */
        let totalCount = 0, maxN = 1;
        for (const items of Object.values(groups)) {
            totalCount += items.length;
            if (items.length > maxN) maxN = items.length;
        }

        const frag = document.createDocumentFragment();

        /* ── 상단 바 ── */
        const bar = $('div', { cls: 'bm-bar' }, [
            $('input', { type: 'search', placeholder: '🔍 검색...', cls: 'bm-search', oninput: e => {
                clearTimeout(_sTimer);
                _sTimer = setTimeout(() => filterItems(e.target.value.trim(), _ctr ?? shadow), 120);
            }}),
            $('span', {
                text: `${totalCount}개`,
                style: { fontSize: '11px', color: 'var(--c-text-dim)', marginRight: 'auto', fontFamily: 'var(--f-mono)' }
            }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', showQuickAdd),
            iconBtn(isSortMode ? '✅' : '↕️', '정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDash(); }),
            iconBtn('➕', '새 그룹', '', () => {
                const n = prompt("새 그룹:");
                const err = vName(n, Object.keys(groups));
                if (err) { if (n) alert(err); return; }
                groups[n.trim()] = [];
                save(); renderDash();
            }),
            iconBtn('⋯', '더보기', '', e => {
                e.stopPropagation();
                _ctxAC?.abort();
                _ctxAC = new AbortController();
                const menuItems = [
                    { i: '🗂', t: '접기/펼치기', fn: () => {
                        const ks = Object.keys(groups);
                        const all = ks.every(k => _col.has(k));
                        ks.forEach(k => all ? _col.delete(k) : _col.add(k));
                        saveCol();
                        renderDash();
                    }},
                    { i: '💾', t: '백업 (JSON)', fn: exportJSON },
                    { i: '📥', t: '복구', fn: importJSON }
                ];
                const m = $('div', { cls: 'bm-admin-menu' },
                    menuItems.map(a => $('div', {
                        cls: 'bm-admin-item',
                        text: `${a.i} ${a.t}`,
                        onclick: () => { m.remove(); _ctxAC.abort(); a.fn(); }
                    }))
                );
                const r = e.target.getBoundingClientRect();
                Object.assign(m.style, {
                    position: 'fixed',
                    top: (r.bottom + 4) + 'px',
                    right: (innerWidth - r.right) + 'px',
                    zIndex: '999999'
                });
                shadow.append(m);
                popupDismiss(m, _ctxAC);
            })
        ]);

        frag.append($('div', { cls: 'bm-top' }, [bar]));

        /* ── 그룹들 ── */
        _ctr = $('div', { cls: 'bm-ctr', onclick: e => {
            const b = e.target.closest('.bm-mgr-btn');
            if (b) showGroupMgr(b.closest('.bm-sec')?.dataset.id);
        }});

        let secIdx = 0;
        for (const [gn, items] of Object.entries(groups)) {
            const col = _col.has(gn);
            const gEl = $('div', { cls: 'bm-grid', 'data-group': gn });
            if (col && !isSortMode) gEl.style.display = 'none';

            if (!items.length && !isSortMode) {
                gEl.append($('div', { cls: 'bm-empty', text: '비어 있음' }));
            }

            for (let idx = 0; idx < items.length; idx++) {
                const it = items[idx];
                const w = $('a', {
                    cls: 'bm-wrap', href: it.url, target: '_blank',
                    title: it.addedAt ? `추가: ${new Date(it.addedAt).toLocaleDateString()}` : ''
                });
                w.oncontextmenu = e => ctxMenu(e, it, gn, idx);
                bindLP(w, e => ctxMenu(e, it, gn, idx));

                /* [B1 fix] onerror 시 FALLBACK_ICON 사용, 무한루프 방지 */
                const icon = faviconUrl(it.url);
                const img = $('img', { loading: 'lazy', src: icon });
                img.onerror = () => {
                    img.onerror = null;
                    img.src = FALLBACK_ICON;
                    img.style.opacity = '0.3';
                };
                w.append($('div', { cls: 'bm-item' }, [img, $('span', { text: it.name })]));
                gEl.append(w);
            }

            const hdr = $('div', { cls: 'bm-sec-hdr', style: { '--fill': `${(items.length / maxN) * 100}%` } }, [
                $('span', {
                    style: { fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
                    onclick: () => {
                        if (isSortMode) return;
                        toggleCol(gn);
                        const now = _col.has(gn);
                        gEl.style.display = now ? 'none' : '';
                        hdr.firstChild.childNodes[0].textContent = `${now ? '▶' : '📁'} ${gn} `;
                    }
                }, [
                    document.createTextNode(`${isSortMode ? '≡' : (col ? '▶' : '📁')} ${gn} `),
                    $('span', { cls: 'bm-gcnt', text: `${items.length}` })
                ]),
                ...(!isSortMode ? [
                    /* [P1 fix] 사용자 명시 액션은 save() 사용 */
                    $('button', { cls: 'bm-qadd', text: '+', onclick: e => {
                        e.stopPropagation();
                        const u = location.href;
                        if (isDup(u)) return toast('⚠ 이미 저장됨');
                        groups[gn].push({
                            name: (document.title || u).substring(0, 30),
                            url: u, addedAt: Date.now()
                        });
                        addUrl(u); setRecent(gn);
                        save(); renderDash();
                        toast(`✅ "${gn}" 추가됨`);
                    }}),
                    $('button', { cls: 'bm-mgr-btn', text: '관리' })
                ] : [])
            ]);

            const sec = $('div', { cls: 'bm-sec', 'data-id': gn, style: { '--sec-delay': `${secIdx * 0.04}s` } });
            sec.append(hdr, gEl);
            _ctr.append(sec);
            secIdx++;
        }

        frag.append(
            _ctr,
            $('div', { cls: 'bm-hint', text: 'Ctrl+Shift+B: 열기 | Ctrl+Shift+D: 빠른추가 | /: 검색' })
        );
        ov.append(frag);
        killSorts();

        if (isSortMode) {
            _sorts.push(new Sortable(_ctr, {
                animation: 150, handle: '.bm-sec-hdr', draggable: '.bm-sec',
                onEnd: () => {
                    const o = {};
                    _ctr.querySelectorAll('.bm-sec').forEach(s => {
                        if (groups[s.dataset.id]) o[s.dataset.id] = groups[s.dataset.id];
                    });
                    db.groups = o;
                    saveLazy();
                }
            }));
        } else {
            _ctr.querySelectorAll('.bm-grid').forEach(g => {
                if (g.style.display !== 'none') {
                    _sorts.push(new Sortable(g, {
                        group: 'bm-items', animation: 150,
                        delay: 300, delayOnTouchOnly: true,
                        /* [B5 fix] onStart에서 스냅샷 확보 */
                        onStart: ev => {
                            const fromGn = ev.from.dataset.group;
                            const toGn = ev.to?.dataset.group;
                            ev.from._snapshot = [...(db.groups[fromGn] || [])];
                            if (toGn && toGn !== fromGn && ev.to) {
                                ev.to._snapshot = [...(db.groups[toGn] || [])];
                            }
                        },
                        onEnd: ev => {
                            const fromGroup = ev.from.dataset.group;
                            const toGroup = ev.to.dataset.group;

                            /* from 스냅샷은 onStart에서 확보됨 */
                            const fromSnap = ev.from._snapshot || [...(db.groups[fromGroup] || [])];
                            /* to 스냅샷: 그룹 간 이동이면 from+to 합산에서 찾아야 함 */
                            const toSnap = fromGroup !== toGroup
                                ? [...(ev.to._snapshot || db.groups[toGroup] || []), ...fromSnap]
                                : fromSnap;

                            db.groups[fromGroup] = rebuildGroupFromDOM(ev.from, fromSnap);
                            if (fromGroup !== toGroup) {
                                db.groups[toGroup] = rebuildGroupFromDOM(ev.to, toSnap);
                            }

                            delete ev.from._snapshot;
                            delete ev.to._snapshot;
                            saveLazy();
                        }
                    }));
                }
            });
        }
    }

    /* ═══════════════════════════════════
       그룹 관리 모달
       ═══════════════════════════════════ */
    const itemRow = ({ n = '', u = 'https://', isN = false } = {}) => {
        const row = $('div', { cls: 'e-r' });
        const ni = $('input', { type: 'text', cls: 'r-n', value: n, placeholder: isN ? '새 이름' : '이름' });
        const ui = $('input', { type: 'text', cls: 'r-u', value: u, placeholder: 'URL' });
        ui.onpaste = () => setTimeout(async () => {
            if (!isN || ni.value.trim() || !isUrl(ui.value.trim())) return;
            const html = await gmFetchText(ui.value.trim(), 5000);
            const title = extractTitle(html);
            if (title && !ni.value.trim()) ni.value = title;
        }, 100);
        row.append(
            $('span', { cls: 'bm-drag-handle', text: '☰' }),
            $('div', { style: { flex: '1' } }, [
                $('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [
                    $('span', {
                        text: '삭제',
                        style: { color: 'var(--c-red)', cursor: 'pointer', fontSize: '11px' },
                        onclick: () => row.remove()
                    })
                ]),
                ni, ui
            ])
        );
        return row;
    };

    function showGroupMgr(gn) {
        const items = db.groups[gn];
        if (!items) return;
        let sInst;
        const m = modal({ onClose: () => sInst?.destroy() });
        const ni = $('input', { type: 'text', value: gn });
        const list = $('div', { cls: 'bm-scroll-list bm-mt-10' });

        if (!items.length) {
            list.append($('div', {
                text: '북마크 없음',
                style: { color: 'var(--c-text-dim)', fontSize: '13px', textAlign: 'center', padding: '20px' }
            }));
        }
        items.forEach(it => list.append(itemRow({ n: it.name, u: it.url })));

        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🛠 그룹 관리', style: { marginTop: 0 } }),
            $('label', { text: '그룹 이름' }), ni, list,
            btn('+ 추가', 'bm-btn-blue', () => {
                list.append(itemRow({ isN: true }));
                list.scrollTop = list.scrollHeight;
            }, { width: '100%', marginTop: '10px', padding: '10px' }),
            btn('📌 현재 페이지', 'bm-btn-green', () => {
                list.append(itemRow({ n: document.title.substring(0, 30), u: location.href }));
                list.scrollTop = list.scrollHeight;
            }, { width: '100%', marginTop: '5px', padding: '10px' }),
            $('div', { cls: 'bm-flex-row bm-mt-20' }, [
                btn('저장', 'bm-btn-green', () => {
                    const nnm = ni.value.trim();
                    if (!nnm) return alert('이름을 입력하세요.');
                    const nItems = [];
                    let bad = false;
                    for (const r of list.querySelectorAll('.e-r')) {
                        const n = r.querySelector('.r-n').value.trim();
                        const u = r.querySelector('.r-u').value.trim();
                        if (!n || !u) continue;
                        if (!isUrl(u)) { bad = true; continue; }
                        const old = items.find(x => x.url === u);
                        nItems.push({ name: n, url: u, addedAt: old?.addedAt || Date.now() });
                    }
                    if (bad && !confirm('유효하지 않은 URL 제외?')) return;

                    if (nnm !== gn) {
                        if (db.groups[nnm]) return alert('존재하는 이름입니다.');
                        const rebuilt = {};
                        for (const k of Object.keys(db.groups)) {
                            rebuilt[k === gn ? nnm : k] = k === gn ? nItems : db.groups[k];
                        }
                        db.groups = rebuilt;
                        if (_col.has(gn)) { _col.delete(gn); _col.add(nnm); }
                        saveCol();
                    } else {
                        db.groups[gn] = nItems;
                    }
                    save(); rerender(); m.close();
                }, { flex: '2', padding: '12px' }),
                btn('닫기', '', () => m.close(), { flex: '1', background: 'var(--c-text-muted)', padding: '12px' })
            ]),
            btn('🗑 그룹 삭제', 'bm-btn-red', () => {
                if (items.length && !confirm(`"${gn}" 삭제?`)) return;
                delete db.groups[gn];
                save(); rerender(); m.close();
            }, { width: '100%', marginTop: '10px', padding: '10px' })
        ]));

        m.onkeydown = e => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                m.querySelector('.bm-btn-green').click();
            }
        };
        sInst = new Sortable(list, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ═══════════════════════════════════
       빠른 추가
       ═══════════════════════════════════ */
    function showQuickAdd() {
        shadow.querySelector('#bm-quick')?.remove();
        const m = modal();
        m.id = 'bm-quick';
        const cu = location.href;
        const c = $('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🔖 북마크 저장', style: { marginTop: 0 } })
        ]);

        /* [B3 fix] 이미 저장된 경우 경고 + 중복 저장 방지 */
        const dup = isDup(cu);
        if (dup) {
            c.append($('div', {
                text: '⚠ 이미 저장된 URL입니다',
                style: { color: 'var(--c-amber)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }

        const ni = $('input', { type: 'text', value: document.title.substring(0, 30) });
        const ui = $('input', { type: 'text', value: cu });
        c.append($('label', { text: '이름' }), ni, $('label', { text: 'URL' }), ui);

        const saveTo = g => {
            const nn = ni.value.trim(), uu = ui.value.trim();
            if (!nn || !isUrl(uu)) return alert('올바른 값을 입력하세요.');
            if (isDup(uu)) return toast('⚠ 이미 저장된 URL입니다');
            if (!db.groups[g]) db.groups[g] = [];
            db.groups[g].push({ name: nn, url: uu, addedAt: Date.now() });
            addUrl(uu); setRecent(g);
            save(); m.close(); rerender(); updateFab();
            toast('✅ 저장됨');
        };

        /* 최근 그룹 바로저장 */
        const rct = getRecent();
        if (rct && db.groups[rct]) {
            c.append(
                $('p', { text: `최근: ${rct}`, style: { fontSize: '11px', color: 'var(--c-text-dim)', margin: '10px 0 2px' } }),
                btn('⚡ 바로 저장', 'bm-btn-blue', () => saveTo(rct), { width: '100%', padding: '10px' })
            );
        }

        /* 그룹 선택 */
        const groupBtns = $('div', { cls: 'bm-flex-col', style: { marginTop: '15px' } });
        for (const g of Object.keys(db.groups)) {
            groupBtns.append(btn(`📁 ${g}`, '', () => saveTo(g), {
                background: 'var(--c-glass)', color: 'var(--c-text)',
                justifyContent: 'flex-start', padding: '12px'
            }));
        }
        groupBtns.append(btn('+ 새 그룹', '', () => {
            const n = prompt("새 그룹:");
            if (n && !vName(n, Object.keys(db.groups))) saveTo(n.trim());
        }, { background: 'var(--c-surface)', color: 'var(--c-neon)', padding: '12px', border: '1px dashed var(--c-neon-border)' }));

        ni.onkeydown = ui.onkeydown = e => {
            if (e.key === 'Enter' && rct && db.groups[rct]) { e.preventDefault(); saveTo(rct); }
        };

        c.append(groupBtns, $('button', {
            text: '취소',
            style: { width: '100%', border: '0', background: 'none', marginTop: '20px', color: 'var(--c-text-dim)', cursor: 'pointer' },
            onclick: () => m.close()
        }));
        m.append(c);
        setTimeout(() => ni.focus(), 50);
    }

    /* ═══════════════════════════════════
       FAB & 토글
       ═══════════════════════════════════ */
    const updateFab = () => {
        const f = shadow?.querySelector('#bm-fab');
        if (!f || _isOpen) return;
        f.querySelector('.bm-badge')?.remove();
        if (isDup(location.href)) {
            f.style.outline = '3px solid var(--c-neon)';
            f.style.outlineOffset = '2px';
            f.append($('span', { cls: 'bm-badge', text: '✓' }));
        } else {
            f.style.outline = 'none';
        }
    };

    const toggle = (ov, fab) => {
        if (!_isOpen) {
            refreshDB(); renderDash();
            document.body.classList.add('bm-overlay-open');
            ov.style.display = 'block';
            fab.firstChild.textContent = '✕';
            _isOpen = true;
        } else {
            document.body.classList.remove('bm-overlay-open');
            ov.style.display = 'none';
            fab.firstChild.textContent = '🔖';
            _isOpen = false;
            killSorts(); _ctr = null;
            updateFab();
        }
    };

    /* ═══════════════════════════════════
       CSS
       ═══════════════════════════════════ */
    const GLASS_CSS = `
:host {
  --c-glass: rgba(16, 18, 27, 0.72);
  --c-glass-hover: rgba(30, 33, 48, 0.78);
  --c-glass-blur: blur(24px) saturate(200%);
  --c-glass-border: rgba(255,255,255,0.06);
  --c-glass-border-hover: rgba(255,255,255,0.12);
  --c-neon: #00e5ff;
  --c-neon-glow: 0 0 12px rgba(0,229,255,0.35);
  --c-neon-soft: rgba(0,229,255,0.12);
  --c-neon-border: rgba(0,229,255,0.25);
  --c-neon-dim: rgba(0,229,255,0.06);
  --c-success: #4cff8d;
  --c-amber: #ffbe46;
  --c-red: #ff4d6a;
  --c-purple: #b47aff;
  --c-surface: rgba(22,24,35,0.90);
  --c-bg: rgba(12,14,22,0.95);
  --c-text: rgba(255,255,255,0.92);
  --c-text-dim: rgba(255,255,255,0.45);
  --c-text-muted: rgba(255,255,255,0.25);
  --c-border: rgba(255,255,255,0.06);
  --c-overlay: rgba(8,10,18,0.92);
  --f: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --f-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  --r: 10px;
  --fab: 48px;
  --grid-min: 300px;
  --grid-max: 1200px;
  --item-min: 80px;
  --icon: 34px;
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  color-scheme: dark;
}
@media(min-width:769px){:host{--item-min:90px;--icon:40px}}
@media(max-width:768px){:host{--fab:42px}#bm-fab{font-size:20px!important}}
@media(prefers-color-scheme:light){:host{
  --c-glass:rgba(245,247,252,0.82);--c-glass-hover:rgba(235,238,248,0.88);
  --c-surface:rgba(255,255,255,0.92);--c-bg:rgba(240,242,248,0.95);
  --c-text:rgba(20,22,36,0.92);--c-text-dim:rgba(20,22,36,0.45);--c-text-muted:rgba(20,22,36,0.25);
  --c-border:rgba(0,0,0,0.06);--c-overlay:rgba(240,242,248,0.95);
  --c-neon:#0088cc;--c-neon-glow:0 0 12px rgba(0,136,204,0.25);
  --c-neon-soft:rgba(0,136,204,0.10);--c-neon-border:rgba(0,136,204,0.20);
  --c-glass-border:rgba(0,0,0,0.06);--c-glass-border-hover:rgba(0,0,0,0.10);
  --c-red:#dc3545;--c-success:#28a745;color-scheme:light;
}}
*{box-sizing:border-box;font-family:var(--f)}
#bm-fab{
  position:fixed;top:85%;right:10px;width:var(--fab);height:var(--fab);
  background:var(--c-glass);color:var(--c-text);border-radius:50%;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  font-size:22px;user-select:none;border:1px solid var(--c-glass-border);
  backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  box-shadow:0 6px 24px rgba(0,0,0,0.4),var(--c-neon-glow);
  transition:all .3s var(--ease);z-index:99;
}
#bm-fab:hover{
  box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.3);
  border-color:var(--c-neon-border);transform:scale(1.06);
}
.bm-badge{
  position:absolute;top:-5px;right:-5px;background:var(--c-neon);color:#000;
  font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;
  display:flex;align-items:center;justify-content:center;padding:0 4px;
}
#bm-overlay{
  position:fixed;inset:0;background:var(--c-overlay);display:none;overflow-y:auto;
  padding:15px;backdrop-filter:blur(12px) saturate(180%);-webkit-backdrop-filter:blur(12px) saturate(180%);
  color:var(--c-text);text-align:left;
}
.bm-top{
  max-width:var(--grid-max);margin:0 auto 12px;
  position:sticky;top:0;z-index:100;
  background:var(--c-glass);backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  padding:12px 16px;border-radius:16px;border:1px solid var(--c-glass-border);
  box-shadow:0 8px 32px rgba(0,0,0,0.2);
}
.bm-bar{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;width:100%;align-items:center}
.bm-search{
  max-width:180px;padding:8px 14px!important;font-size:13px!important;margin:0!important;
  background:rgba(255,255,255,0.04)!important;border:1px solid var(--c-glass-border)!important;
  border-radius:var(--r)!important;color:var(--c-text)!important;transition:all .2s var(--ease)!important;
}
.bm-search:focus{
  border-color:var(--c-neon-border)!important;
  box-shadow:0 0 12px rgba(0,229,255,0.15)!important;
  background:rgba(255,255,255,0.06)!important;
}
.bm-search::placeholder{color:var(--c-text-muted)!important}
button{outline:0;border:0;font-family:var(--f)}
.bm-btn,.bm-mgr-btn{font-size:11px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bm-btn{
  padding:8px 12px;color:#fff;background:var(--c-surface);border-radius:var(--r);
  border:1px solid var(--c-glass-border);transition:all .15s var(--ease);font-weight:500;
}
.bm-btn:hover{background:var(--c-glass-hover);border-color:var(--c-glass-border-hover);transform:translateY(-1px)}
.bm-btn:active{transform:scale(0.97)}
.bm-btn-blue{background:rgba(0,229,255,0.15);border-color:var(--c-neon-border);color:var(--c-neon)}
.bm-btn-blue:hover{background:rgba(0,229,255,0.25);box-shadow:var(--c-neon-glow)}
.bm-btn-green{background:rgba(76,255,141,0.12);border-color:rgba(76,255,141,0.25);color:var(--c-success)}
.bm-btn-green:hover{background:rgba(76,255,141,0.22);box-shadow:0 0 12px rgba(76,255,141,0.2)}
.bm-btn-red{background:rgba(255,77,106,0.12);border-color:rgba(255,77,106,0.25);color:var(--c-red)}
.bm-btn-red:hover{background:rgba(255,77,106,0.22)}
.bm-icon-btn{
  width:36px;height:36px;font-size:16px;border-radius:var(--r);
  display:inline-flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(255,255,255,0.04);border:1px solid var(--c-glass-border);color:var(--c-text);
  transition:all .2s var(--ease);backdrop-filter:blur(8px);
}
.bm-icon-btn:hover{background:rgba(255,255,255,0.10);border-color:var(--c-glass-border-hover);transform:scale(1.08)}
.bm-icon-btn:active{transform:scale(0.95)}
input{
  width:100%;padding:10px 14px;margin:5px 0;
  border:1px solid var(--c-glass-border);background:rgba(255,255,255,0.04);
  color:var(--c-text);border-radius:var(--r);font-size:14px;transition:all .2s var(--ease);
}
input:focus{border-color:var(--c-neon-border);box-shadow:0 0 12px rgba(0,229,255,0.12);outline:none;background:rgba(255,255,255,0.06)}
label{display:block;font-size:11px;font-weight:600;color:var(--c-text-dim);margin-top:10px;letter-spacing:0.5px;text-transform:uppercase}
.bm-ctr{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(var(--grid-min),1fr));
  gap:16px;max-width:var(--grid-max);margin:0 auto;
}
.bm-sec{
  background:var(--c-glass);border:1px solid var(--c-glass-border);border-radius:14px;
  overflow:hidden;
  box-shadow:0 4px 20px rgba(0,0,0,0.15);transition:all .3s var(--ease);
  animation:bm-sec-in .4s var(--ease) both;animation-delay:var(--sec-delay, 0s);
}
@keyframes bm-sec-in{from{opacity:0;transform:translateY(12px) scale(0.97)}to{opacity:1;transform:none}}
.bm-sec:hover{border-color:var(--c-glass-border-hover);box-shadow:0 8px 32px rgba(0,0,0,0.2)}
.bm-sec-hdr{
  display:flex;justify-content:space-between;align-items:center;
  padding:12px 14px;background:rgba(255,255,255,0.02);position:relative;gap:8px;
  border-bottom:1px solid var(--c-glass-border);
}
.bm-sec-hdr::after{
  content:'';position:absolute;bottom:0;left:0;height:2px;
  background:linear-gradient(90deg,var(--c-neon),transparent);
  width:var(--fill,0%);transition:width .5s var(--ease);opacity:0.7;
}
.bm-gcnt{
  font-weight:400;font-size:11px;color:var(--c-text-dim);
  background:rgba(255,255,255,0.05);padding:2px 8px;border-radius:20px;font-family:var(--f-mono);
}
.bm-mgr-btn{
  border:1px solid var(--c-glass-border);background:rgba(255,255,255,0.04);
  color:var(--c-text-dim);padding:5px 12px;border-radius:var(--r);font-weight:600;
  font-size:11px;transition:all .15s var(--ease);
}
.bm-mgr-btn:hover{background:rgba(255,255,255,0.08);color:var(--c-text);border-color:var(--c-glass-border-hover)}
.bm-qadd{
  width:30px;height:30px;border-radius:50%;border:1px dashed var(--c-neon-border);
  background:transparent;color:var(--c-neon);font-size:16px;font-weight:700;cursor:pointer;
  display:flex;align-items:center;justify-content:center;margin-left:auto;margin-right:8px;
  transition:all .2s var(--ease);
}
.bm-qadd:hover{background:var(--c-neon-dim);box-shadow:var(--c-neon-glow);transform:scale(1.1)}
.bm-grid{
  display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--item-min),1fr));
  gap:14px;padding:16px;min-height:60px;justify-items:center;
}
.bm-wrap{
  display:flex;flex-direction:column;align-items:center;
  text-decoration:none;color:inherit;width:100%;max-width:80px;
}
.bm-item{
  display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;
  padding:8px 4px;border-radius:var(--r);transition:all .2s var(--ease);
}
.bm-item:hover{
  background:rgba(255,255,255,0.06);transform:translateY(-3px) scale(1.02);
  box-shadow:0 4px 16px rgba(0,0,0,0.15);
}
.bm-item img{
  width:var(--icon);height:var(--icon);margin-bottom:6px;border-radius:var(--r);
  background:rgba(255,255,255,0.05);object-fit:contain;transition:transform .2s var(--ease-spring);
}
.bm-item:hover img{transform:scale(1.1)}
.bm-item span{
  font-size:11px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--c-text-dim);transition:color .2s;
}
.bm-item:hover span{color:var(--c-text)}
.bm-empty{
  grid-column:1/-1;text-align:center;color:var(--c-text-muted);font-size:12px;padding:30px;
}
.sort-active .bm-grid{opacity:0.4;pointer-events:none;filter:grayscale(50%)}
.sort-active .bm-sec{border:2px dashed var(--c-neon);cursor:move}
.bm-grid .sortable-ghost{opacity:.3;background:var(--c-neon-dim);border-radius:var(--r)}
dialog.bm-modal-bg{background:transparent;border:0;padding:0;margin:auto;max-width:100vw;max-height:100vh}
dialog.bm-modal-bg::backdrop{background:rgba(0,0,0,0.55);backdrop-filter:blur(8px)}
.bm-modal-content{
  background:var(--c-surface);padding:25px;border-radius:18px;
  width:100%;max-width:min(420px,calc(100vw - 32px));max-height:85vh;overflow-y:auto;
  border:1px solid var(--c-glass-border);
  box-shadow:0 20px 60px rgba(0,0,0,0.4),0 0 0 1px rgba(255,255,255,0.03) inset;
  backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  animation:bm-modal-in .35s var(--ease-spring);
}
@keyframes bm-modal-in{from{opacity:0;transform:scale(0.9) translateY(20px)}to{opacity:1;transform:none}}
.bm-modal-content h3{
  font-size:16px;font-weight:700;
  background:linear-gradient(135deg,var(--c-neon),var(--c-purple));
  -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;
}
.bm-ctx,.bm-admin-menu{
  background:var(--c-glass);border:1px solid var(--c-glass-border);border-radius:12px;
  box-shadow:0 8px 32px rgba(0,0,0,0.3);min-width:150px;overflow:hidden;
  backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  animation:bm-ctx-in .2s var(--ease);
}
@keyframes bm-ctx-in{from{opacity:0;transform:scale(0.92)}to{opacity:1;transform:none}}
.bm-ctx-item,.bm-admin-item{
  padding:11px 16px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;
  transition:background .15s;color:var(--c-text);
}
.bm-ctx-item:hover,.bm-admin-item:hover{background:rgba(255,255,255,0.06)}
.ctx-danger{color:var(--c-red)}
.e-r{
  border-bottom:1px solid var(--c-glass-border);padding:10px 0;
  display:flex;gap:10px;align-items:center;animation:bm-sec-in .25s var(--ease) both;
}
.bm-drag-handle{cursor:grab;font-size:18px;margin-right:10px;color:var(--c-text-muted);transition:color .2s}
.bm-drag-handle:hover{color:var(--c-neon)}
.bm-toast{
  position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(16px);
  background:var(--c-glass);color:var(--c-text);padding:12px 28px;border-radius:var(--r);
  font-size:13px;font-weight:500;opacity:0;transition:all .3s var(--ease-spring);
  pointer-events:none;z-index:999999;border:1px solid var(--c-glass-border);
  backdrop-filter:blur(20px) saturate(200%);-webkit-backdrop-filter:blur(20px) saturate(200%);
  box-shadow:0 8px 32px rgba(0,0,0,0.3);
}
.bm-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bm-hint{
  max-width:var(--grid-max);margin:24px auto 12px;text-align:center;
  font-size:11px;color:var(--c-text-muted);font-family:var(--f-mono);letter-spacing:0.3px;
}
.bm-flex-row{display:flex;gap:10px;align-items:center}
.bm-flex-col{display:flex;flex-direction:column;gap:5px}
.bm-mt-10{margin-top:10px}.bm-mt-20{margin-top:20px}
.bm-scroll-list{
  max-height:40vh;overflow-y:auto;border:1px solid var(--c-glass-border);
  border-radius:var(--r);padding:10px;scrollbar-width:thin;scrollbar-color:var(--c-neon-border) transparent;
}
.bm-scroll-list::-webkit-scrollbar{width:4px}
.bm-scroll-list::-webkit-scrollbar-thumb{background:var(--c-neon-border);border-radius:2px}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{transition-duration:0.01ms!important;animation-duration:0.01ms!important}
}
`;

    /* ═══════════════════════════════════
       Init
       ═══════════════════════════════════ */
    function init() {
        if (!document.getElementById('bm-host-css')) {
            document.head.append($('style', { id: 'bm-host-css', text: 'body.bm-overlay-open{overflow:hidden!important}' }));
        }

        const host = $('div', {
            id: 'bm-root',
            style: { position: 'fixed', zIndex: '2147483647', top: '0', left: '0', width: '0', height: '0', overflow: 'visible' }
        });
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        const ov = $('div', { id: 'bm-overlay' });
        const fab = $('div', { id: 'bm-fab', role: 'button', 'aria-label': '북마크' }, [document.createTextNode('🔖')]);
        shadow.append($('style', { text: GLASS_CSS }), ov, fab);

        fab.onclick = () => toggle(ov, fab);

        /* 키보드 단축키 */
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggle(ov, fab); }
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); showQuickAdd(); }
            if (e.key === 'Escape' && _isOpen && !shadow.querySelector('dialog[open]')) {
                e.preventDefault(); toggle(ov, fab);
            }
            if (e.key === '/' && _isOpen && !shadow.querySelector('dialog[open]')) {
                const s = shadow.querySelector('.bm-search');
                if (s && document.activeElement !== s) { e.preventDefault(); s.focus(); }
            }
        });

        /* [P3 fix] visibilitychange에서 불필요한 렌더링 방지 */
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                saveNow();
            } else if (_isOpen) {
                refreshDB(); rerender();
            } else {
                updateFab();
            }
        });
        window.addEventListener('pagehide', saveNow);
        window.addEventListener('beforeunload', saveNow);

        updateFab();
    }

    init();
})();
