// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v20.1)
// @version      20.1
// @description  v20.0 기반 - yieldToMain 최적화 추가 및 코드 압축
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
       유틸리티 & 최적화
       ═══════════════════════════════════ */
    const yieldToMain = () => new Promise(r => 'scheduler' in window ? scheduler.postTask(r, { priority: 'user-visible' }) : setTimeout(r, 0));

    const $ = (tag, attrs = {}, children = []) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'cls') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        }
        for (const c of [children].flat()) if (c) e.append(c);
        return e;
    };

    const btn = (text, cls = '', onclick = null, style = {}) => $('button', { cls: `bm-btn ${cls}`.trim(), text, onclick, style });
    const iconBtn = (icon, title, cls, onclick) => $('button', { cls: `bm-icon-btn ${cls}`.trim(), text: icon, title, onclick });
    const isUrl = s => { try { return /^https?:/.test(new URL(s).protocol); } catch { return false; } };
    const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    const vName = (name, exist = []) => {
        const t = name?.trim();
        if (!t) return '이름을 입력하세요.';
        if (t.length > 30) return '이름은 30자 이하여야 합니다.';
        if (/[::\/\\<>"|?*]/.test(t)) return '사용할 수 없는 문자가 포함되어 있습니다.';
        if (exist.includes(t)) return '이미 존재하는 이름입니다.';
        return null;
    };

    const cleanUrl = s => {
        try {
            const u = new URL(s); let c = false;
            ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','mc_eid','_ga'].forEach(p => {
                if (u.searchParams.has(p)) { u.searchParams.delete(p); c = true; }
            });
            return c ? u.toString() : s;
        } catch { return s; }
    };

    const pathContains = (ev, el) => { try { return ev.composedPath().includes(el); } catch { return false; } };

    /* ═══════════════════════════════════
       DB & 동기화 관리
       ═══════════════════════════════════ */
    let _urls = null, db = null, _undo = [], _saveTimer = null, _lastBackup = GM_getValue('bm_last_backup', 0);

    const forEachItem = cb => {
        for (const [p, groups] of Object.entries(db.pages))
            for (const [g, items] of Object.entries(groups))
                for (const it of items) if (cb(it, p, g) === false) return;
    };

    const validateDB = d => d?.pages && typeof d.pages === 'object' && d.currentPage && d.pages[d.currentPage];
    const loadDB = () => {
        let raw = GM_getValue('bm_db_v2', null) || GM_getValue('bm_db_v2_backup', null);
        return validateDB(raw) ? structuredClone(raw) : { currentPage: "기본", pages: { "기본": { "북마크": [] } } };
    };
    db = loadDB();

    const refreshDB = () => {
        const fresh = GM_getValue('bm_db_v2', null);
        if (validateDB(fresh)) { db = fresh; _urls = null; return true; }
        return false;
    };

    const saveNow = () => {
        clearTimeout(_saveTimer);
        try {
            GM_setValue('bm_db_v2', db);
            if (Date.now() - _lastBackup > 3600000) {
                GM_setValue('bm_db_v2_backup', structuredClone(db));
                GM_setValue('bm_last_backup', _lastBackup = Date.now());
            }
        } catch (e) { console.error(e); toast('❌ 저장 실패!'); }
    };

    const pushUndo = () => { try { _undo.push(structuredClone(db)); if (_undo.length > 5) _undo.shift(); } catch { _undo.length = 0; } };
    const popUndo = () => { if (!_undo.length) return false; db = _undo.pop(); _urls = null; saveNow(); rerender(); toast('↩ 되돌리기 완료'); return true; };

    /* ── URL Cache ── */
    const isDup = u => { if (!_urls) { _urls = new Set(); forEachItem(it => _urls.add(it.url)); } return _urls.has(u); };
    const addUrl = u => _urls?.add(u);
    const delUrl = u => { if (!_urls) return; let f = false; forEachItem(it => { if (it.url === u) { f = true; return false; } }); if (!f) _urls.delete(u); };
    const findLocs = u => { const r = []; if (isDup(u)) forEachItem((it, p, g) => { if (it.url === u) r.push(`${p} > ${g}`); }); return r; };

    /* ═══════════════════════════════════
       UI 상태 & 파비콘
       ═══════════════════════════════════ */
    const curPage = () => db.pages[db.currentPage];
    let isSortMode = false, shadow = null;

    const _col = new Set(JSON.parse(GM_getValue('bm_collapsed', '[]') || '[]'));
    const colKey = g => `${db.currentPage}::${g}`;
    const toggleCol = g => { _col.has(colKey(g)) ? _col.delete(colKey(g)) : _col.add(colKey(g)); GM_setValue('bm_collapsed', JSON.stringify([..._col])); };

    const setRecent = (p, g) => GM_setValue('bm_recent', JSON.stringify({ page: p, group: g, ts: Date.now() }));
    const getRecent = () => JSON.parse(GM_getValue('bm_recent', 'null'));
    const suggestGroup = u => {
        try {
            const h = new URL(u).hostname, c = {};
            for (const [g, items] of Object.entries(curPage())) for (const it of items) try { if (new URL(it.url).hostname === h) c[g] = (c[g] || 0) + 1; } catch {}
            return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        } catch { return null; }
    };

    const FALLBACK = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";
    const _icnCache = new Map();
    const gmFetch = (url, timeout = 5000) => new Promise(r => GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout, onload: res => r(res.status === 200 && res.response?.size > 100 ? res.response : null), onerror: () => r(null), ontimeout: () => r(null) }));
    const toB64 = b => new Promise(r => { const f = new FileReader(); f.onloadend = () => r(f.result || FALLBACK); f.onerror = () => r(FALLBACK); f.readAsDataURL(b); });

    async function fetchIcon(url) {
        try {
            const h = new URL(url).hostname; if (_icnCache.has(h)) return _icnCache.get(h);
            const b = await gmFetch(`https://icon.horse/icon/${h}`, 3000) || await gmFetch(`https://www.google.com/s2/favicons?domain=${h}&sz=128`, 4000);
            const res = b ? await toB64(b) : FALLBACK;
            if (_icnCache.size > 200) _icnCache.delete(_icnCache.keys().next().value);
            _icnCache.set(h, res); return res;
        } catch { return FALLBACK; }
    }

    let _obs = null;
    const getObs = root => _obs || (_obs = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && e.target.dataset.src) { e.target.src = e.target.dataset.src; delete e.target.dataset.src; _obs.unobserve(e.target); } }), { root, rootMargin: '200px' }));

    /* ═══════════════════════════════════
       컴포넌트 (Toast, Modal, Context)
       ═══════════════════════════════════ */
    const toast = (msg, dur = 2000) => {
        shadow?.querySelector('.bm-toast')?.remove();
        const t = $('div', { cls: 'bm-toast', text: msg });
        shadow?.append(t); requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, dur);
    };

    const modal = (id = '', { prevent = false, onClose } = {}) => {
        const d = document.createElement('dialog'); if (id) d.id = id; d.className = 'bm-modal-bg';
        d.onclick = e => { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); };
        d.onclose = () => { onClose?.(); d.remove(); };
        if (prevent) d.oncancel = e => e.preventDefault();
        return shadow.appendChild(d) && d.showModal(), d;
    };

    const popupDismiss = (el, ac) => setTimeout(() => {
        const handler = e => { if (!pathContains(e, el)) { el.remove(); ac.abort(); } };
        shadow.addEventListener('pointerdown', handler, { signal: ac.signal });
        document.addEventListener('pointerdown', handler, { signal: ac.signal, capture: true });
    }, 0);

    let _ctxAC = null;
    const ctxMenu = (e, item, gName, idx) => {
        e.preventDefault(); _ctxAC?.abort(); shadow.querySelector('.bm-ctx')?.remove();
        _ctxAC = new AbortController(); const ac = _ctxAC;
        const m = $('div', { cls: 'bm-ctx', style: { position: 'fixed', zIndex: '999999' } }, [
            { t: '✏️ 편집', fn: () => showGroupMgr(gName) },
            { t: '📋 URL 복사', fn: () => { navigator.clipboard?.writeText(item.url); toast('📋 URL 복사됨'); } },
            { t: '🗑 삭제', c: 'ctx-danger', fn: () => {
                if (!confirm(`"${item.name}" 삭제?`)) return; pushUndo();
                const arr = curPage()[gName], i = arr[idx]?.url === item.url ? idx : arr.findIndex(x => x.url === item.url);
                if (i > -1) arr.splice(i, 1); delUrl(item.url); saveNow(); rerender();
            }}
        ].map(a => $('div', { cls: `bm-ctx-item ${a.c || ''}`, text: a.t, onclick: () => { m.remove(); ac.abort(); a.fn(); } })));
        shadow.append(m);
        const r = m.getBoundingClientRect();
        m.style.left = Math.max(0, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
        m.style.top = Math.max(0, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
        popupDismiss(m, ac);
    };

    const bindLP = (el, cb) => {
        let tid = 0, moved = false, fired = false;
        el.ontouchstart = e => { moved = fired = false; tid = setTimeout(() => { if (!moved) { fired = true; cb({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: () => {} }); } }, 500); };
        el.ontouchmove = () => { moved = true; clearTimeout(tid); };
        el.ontouchend = e => { clearTimeout(tid); if (fired) e.preventDefault(); };
        el.ontouchcancel = () => clearTimeout(tid);
    };

    /* ═══════════════════════════════════
       기능 (복구, 관리, 검색 등)
       ═══════════════════════════════════ */
    async function fixAllIcons() {
        const all = []; forEachItem(it => all.push(it));
        if (!all.length) return toast('저장된 북마크가 없습니다.');
        if (!confirm(`총 ${all.length}개 아이콘을 다시 다운로드합니다. 진행?`)) return;

        let cancel = false;
        const m = modal('', { prevent: true }), status = $('div', { text: '대기 중...' });
        m.append($('div', { cls: 'bm-modal-content', style: { textAlign: 'center' } }, [status, btn('취소', 'bm-btn-red', () => cancel = true, { width: '100%', marginTop: '15px', padding: '10px' })]));

        _icnCache.clear();
        for (let i = 0; i < all.length; i += 5) {
            if (cancel) break;
            await Promise.all(all.slice(i, i + 5).map(async it => { if (!cancel) it.icon = await fetchIcon(it.url); }));
            status.textContent = `업데이트 중... ${Math.min(i + 5, all.length)} / ${all.length}`;
            await yieldToMain(); // ⚡ UI 블로킹 방지 로직 복구
        }
        saveNow(); m.close(); toast(cancel ? '중단됨' : '✅ 복구 완료'); rerender();
    }

    const triggerDl = (blob, fn) => { const u = URL.createObjectURL(blob); $('a', { href: u, download: fn }).click(); setTimeout(() => URL.revokeObjectURL(u), 1000); };
    const exportJSON = () => { saveNow(); triggerDl(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }), 'bookmarks.json'); };
    const exportHTML = () => {
        let h = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
        for (const [p, gs] of Object.entries(db.pages)) {
            h += `  <DT><H3>${escHtml(p)}</H3>\n  <DL><p>\n`;
            for (const [g, is] of Object.entries(gs)) {
                h += `    <DT><H3>${escHtml(g)}</H3>\n    <DL><p>\n`;
                for (const it of is) h += `      <DT><A HREF="${escHtml(it.url)}">${escHtml(it.name)}</A>\n`;
                h += '    </DL><p>\n';
            } h += '  </DL><p>\n';
        }
        triggerDl(new Blob([h + '</DL><p>'], { type: 'text/html' }), 'bookmarks.html');
    };
    const importJSON = () => {
        const inp = $('input', { type: 'file', accept: '.json', onchange: e => {
            const r = new FileReader();
            r.onload = re => { try { const p = JSON.parse(re.target.result); if (!validateDB(p)) throw 1; db = p; _urls = null; saveNow(); rerender(); toast('✅ 복구 완료'); } catch { alert('잘못된 파일 구조입니다.'); } };
            if (e.target.files[0]) r.readAsText(e.target.files[0]);
        }}); inp.click();
    };

    let _sorts = []; const killSorts = () => { _sorts.forEach(s => s.destroy()); _sorts = []; };

    const filterItems = (q, c) => {
        const lq = q.toLowerCase();
        c.querySelectorAll('.bm-sec').forEach(sec => {
            const grid = sec.querySelector('.bm-grid'); if (!grid) return;
            let vis = false;
            grid.querySelectorAll('.bm-wrap').forEach(w => {
                const m = !lq || w.textContent.toLowerCase().includes(lq) || w.href.toLowerCase().includes(lq);
                w.style.display = m ? '' : 'none'; if (m) vis = true;
            });
            if (lq) { grid.style.display = sec.style.display = vis ? '' : 'none'; }
            else { sec.style.display = ''; grid.style.display = !isSortMode && _col.has(colKey(sec.dataset.id)) ? 'none' : ''; }
        });
    };

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _sTimer = null, _ctr = null;
    const rerender = () => shadow?.querySelector('#bm-overlay')?.style.display === 'block' && renderDash();

    function renderDash() {
        const ov = shadow.querySelector('#bm-overlay'); if (!ov) return;
        _ctxAC?.abort(); getObs(ov); ov.className = isSortMode ? 'sort-active' : ''; ov.replaceChildren();

        const p = curPage(), frag = document.createDocumentFragment();
        const tabs = $('div', { cls: 'bm-tabs' });
        Object.entries(db.pages).forEach(([pn, gs]) => {
            const t = $('div', { cls: `bm-tab ${db.currentPage === pn ? 'active' : ''}`, text: `${pn} (${Object.values(gs).flat().length})`, 'data-page': pn });
            let sx, sy, mvd;
            t.ontouchstart = e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; mvd = false; };
            t.ontouchmove = e => { if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) mvd = true; };
            t.ontouchend = e => { if (!mvd) { e.preventDefault(); db.currentPage = pn; isSortMode = false; saveNow(); renderDash(); } };
            t.onclick = () => { db.currentPage = pn; isSortMode = false; saveNow(); renderDash(); };
            tabs.append(t);
        });

        const bar = $('div', { cls: 'bm-bar' }, [
            $('input', { type: 'search', placeholder: '검색...', cls: 'bm-search', oninput: e => {
                clearTimeout(_sTimer); _sTimer = setTimeout(() => {
                    const q = e.target.value; filterItems(q, _ctr ?? shadow);
                    _ctr?.querySelector('.bm-gsr')?.remove();
                    if (q.trim().length >= 2 && _ctr) {
                        const res = []; forEachItem((it, pn, gn) => { if (it.name.toLowerCase().includes(q) || it.url.toLowerCase().includes(q)) res.push({...it, pn, gn}); });
                        if (res.length) _ctr.prepend($('div', { cls: 'bm-gsr', style: { gridColumn: '1/-1' } }, [
                            $('div', { text: `🔍 전체 검색 (${res.length}건)`, style: { fontWeight: 'bold', fontSize: '13px', padding: '10px', background: 'var(--c-bg)', borderRadius: '8px 8px 0 0' } }),
                            $('div', { cls: 'bm-grid' }, res.slice(0, 50).map(r => $('a', { cls: 'bm-wrap', href: r.url, target: '_blank', title: `${r.pn} > ${r.gn}` }, [$('div', { cls: 'bm-item' }, [$('img', { src: r.icon || FALLBACK }), $('span', { text: r.name })])])))
                        ]));
                    }
                }, 150);
            }}),
            $('span', { text: `${Object.values(p).flat().length}개`, style: { fontSize: '12px', color: '#999', marginRight: 'auto' } }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', showQuickAdd),
            iconBtn(isSortMode ? '✅' : '↕️', '정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDash(); }),
            iconBtn('➕', '새 그룹', '', () => { const n = prompt("새 그룹:"); const err = vName(n, Object.keys(p)); if (err) { if (n) alert(err); return; } p[n.trim()] = []; saveNow(); renderDash(); }),
            iconBtn('⋯', '더보기', '', e => {
                e.stopPropagation(); _ctxAC?.abort(); _ctxAC = new AbortController();
                const m = $('div', { cls: 'bm-admin-menu' }, [
                    { i: '🔄', t: '아이콘 복구', fn: fixAllIcons }, { i: '📂', t: '탭 관리', fn: showTabMgr },
                    { i: '🗂', t: '접기/펼치기', fn: () => { const ks = Object.keys(p).map(colKey), all = ks.every(k => _col.has(k)); ks.forEach(k => all ? _col.delete(k) : _col.add(k)); GM_setValue('bm_collapsed', JSON.stringify([..._col])); renderDash(); } },
                    { i: '💾', t: '백업 (JSON)', fn: exportJSON }, { i: '📄', t: '백업 (HTML)', fn: exportHTML }, { i: '📥', t: '복구', fn: importJSON }
                ].map(a => $('div', { cls: 'bm-admin-item', text: `${a.i} ${a.t}`, onclick: () => { m.remove(); _ctxAC.abort(); a.fn(); } })));
                const r = e.target.getBoundingClientRect();
                Object.assign(m.style, { position: 'fixed', top: (r.bottom + 4) + 'px', right: (innerWidth - r.right) + 'px', zIndex: '999999' });
                shadow.append(m); popupDismiss(m, _ctxAC);
            })
        ]);
        frag.append($('div', { cls: 'bm-top' }, [tabs, bar]));

        _ctr = $('div', { cls: 'bm-ctr', onclick: e => { const b = e.target.closest('.bm-mgr-btn'); if (b) showGroupMgr(b.closest('.bm-sec')?.dataset.id); } });
        _ctr.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; _ctr.style.outline = '2px dashed var(--c-primary)'; };
        _ctr.ondragleave = () => _ctr.style.outline = '';
        _ctr.ondrop = async e => {
            e.preventDefault(); _ctr.style.outline = ''; const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (!raw || !isUrl(raw.trim())) return; const u = cleanUrl(raw.trim()); if (isDup(u)) return toast('⚠ 이미 저장됨');
            const g = e.target.closest('.bm-grid')?.dataset.group || Object.keys(p)[0]; if (!g) return toast('⚠ 그룹 없음');
            let nm = u; try { const res = await gmFetch(u); nm = res?.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim().substring(0,30) || nm; } catch {}
            pushUndo(); p[g].push({ name: nm, url: u, icon: await fetchIcon(u), addedAt: Date.now() });
            addUrl(u); saveNow(); renderDash(); toast(`✅ "${g}" 추가됨`);
        };

        const maxN = Math.max(...Object.values(p).map(a => a.length), 1);
        for (const [gn, is] of Object.entries(p)) {
            const col = _col.has(colKey(gn)), gEl = $('div', { cls: 'bm-grid', 'data-group': gn, style: col && !isSortMode ? { display: 'none' } : {} });
            if (!is.length && !isSortMode) gEl.append($('div', { cls: 'bm-empty' }, [$('div', { text: '📎', style: { fontSize: '24px', opacity: '.5' } }), $('div', { text: '드래그하여 추가' })]));
            is.forEach((it, idx) => {
                const w = $('a', { cls: 'bm-wrap', href: it.url, target: '_blank', title: it.addedAt ? `추가: ${new Date(it.addedAt).toLocaleDateString()}` : '' });
                w.oncontextmenu = e => ctxMenu(e, it, gn, idx); bindLP(w, e => ctxMenu(e, it, gn, idx));
                const img = $('img', { decoding: 'async' }); const src = it.icon?.startsWith('data:') ? it.icon : FALLBACK;
                if (src === FALLBACK) img.src = FALLBACK; else { img.src = FALLBACK; img.dataset.src = src; _obs.observe(img); }
                w.append($('div', { cls: 'bm-item' }, [img, $('span', { text: it.name })])); gEl.append(w);
            });
            const hdr = $('div', { cls: 'bm-sec-hdr', style: { '--fill': `${(is.length / maxN) * 100}%` } }, [
                $('span', { style: { fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }, onclick: () => { if(isSortMode) return; toggleCol(gn); const now = _col.has(colKey(gn)); gEl.style.display = now ? 'none' : ''; hdr.firstChild.childNodes[0].textContent = `${now ? '▶' : '📁'} ${gn} `; } }, [
                    document.createTextNode(`${isSortMode ? '≡' : (col ? '▶' : '📁')} ${gn} `), $('span', { cls: 'bm-gcnt', text: `(${is.length})` }), ...(is.length >= 50 ? [$('span', { cls: 'bm-gwarn', text: '⚠' })] : [])
                ]),
                ...(!isSortMode ? [$('button', { cls: 'bm-qadd', text: '+', onclick: async e => { e.stopPropagation(); const u = cleanUrl(location.href); if (isDup(u)) return toast('⚠ 이미 저장됨'); pushUndo(); p[gn].push({ name: (document.title || u).substring(0,30), url: u, icon: await fetchIcon(u), addedAt: Date.now() }); addUrl(u); setRecent(db.currentPage, gn); saveNow(); renderDash(); toast(`✅ "${gn}" 추가됨`); } }), $('button', { cls: 'bm-mgr-btn', text: '관리' })] : [])
            ]);
            _ctr.append($('div', { cls: 'bm-sec', 'data-id': gn }, [hdr, gEl]));
        }

        frag.append(_ctr, $('div', { cls: 'bm-hint', text: 'Ctrl+Shift+B: 열기 | Ctrl+Shift+D: 빠른추가 | Ctrl+Z: 되돌리기' }));
        ov.append(frag); killSorts();

        if (Object.keys(db.pages).length > 1) _sorts.push(new Sortable(tabs, { animation: 150, direction: 'horizontal', draggable: '.bm-tab', delay: 300, delayOnTouchOnly: true, onEnd: () => { const o = {}; tabs.querySelectorAll('.bm-tab').forEach(t => { if (db.pages[t.dataset.page]) o[t.dataset.page] = db.pages[t.dataset.page]; }); db.pages = o; saveNow(); } }));
        if (isSortMode) _sorts.push(new Sortable(_ctr, { animation: 150, handle: '.bm-sec-hdr', draggable: '.bm-sec', onEnd: () => { pushUndo(); const o = {}; _ctr.querySelectorAll('.bm-sec').forEach(s => { if (p[s.dataset.id]) o[s.dataset.id] = p[s.dataset.id]; }); db.pages[db.currentPage] = o; saveNow(); } }));
        else _ctr.querySelectorAll('.bm-grid').forEach(g => { if (g.style.display !== 'none') _sorts.push(new Sortable(g, { group: 'bm-items', animation: 150, delay: 300, delayOnTouchOnly: true, onEnd: ev => { pushUndo(); const imap = new Map(); Object.values(p).forEach(a => a.forEach(i => imap.set(`${i.url}|${i.name}`, i.icon))); const rb = x => { p[x.dataset.group] = [...x.querySelectorAll('.bm-wrap')].map(w => ({ name: w.textContent, url: w.href, icon: imap.get(`${w.href}|${w.textContent}`) || FALLBACK, addedAt: Date.now() })); }; rb(ev.from); if (ev.from !== ev.to) rb(ev.to); _urls = null; saveNow(); } })); });
    }

    /* ═══════════════════════════════════
       모달 관리 (편집, 탭, 퀵추가)
       ═══════════════════════════════════ */
    const itemRow = ({ n = '', u = 'https://', isN = false } = {}) => {
        const row = $('div', { cls: 'e-r', style: { borderBottom: '1px solid var(--c-border)', padding: '10px 0', display: 'flex', gap: '10px', alignItems: 'center' } });
        const ni = $('input', { type: 'text', cls: 'r-n', value: n, placeholder: isN ? '새 이름' : '이름', style: { marginBottom: '5px' } });
        const ui = $('input', { type: 'text', cls: 'r-u', value: u, placeholder: 'URL' });
        ui.onpaste = () => setTimeout(() => { if (!isN || ni.value.trim() || !isUrl(ui.value.trim())) return; gmFetch(ui.value.trim()).then(r => { const m = r?.match(/<title[^>]*>([^<]+)<\/title>/i); if (m?.[1] && !ni.value.trim()) ni.value = m[1].trim().substring(0, 40); }); }, 100);
        return row.append($('span', { cls: 'bm-drag-handle', text: '☰' }), $('div', { style: { flex: '1' } }, [$('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [$('span', { text: '삭제', style: { color: 'red', cursor: 'pointer', fontSize: '11px' }, onclick: () => row.remove() })]), ni, ui])), row;
    };

    function showGroupMgr(gn) {
        const is = curPage()[gn]; if (!is) return;
        let sInst; const m = modal('', { onClose: () => sInst?.destroy() });
        const ni = $('input', { type: 'text', value: gn }), list = $('div', { cls: 'bm-scroll-list bm-mt-10' });
        if (!is.length) list.append($('div', { text: '북마크 없음', style: { color: '#999', fontSize: '13px', textAlign: 'center', padding: '20px' } }));
        is.forEach(it => list.append(itemRow({ n: it.name, u: it.url })));
        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🛠 그룹 관리', style: { marginTop: 0 } }), $('label', { text: '그룹 이름' }), ni, list,
            btn('+ 추가', 'bm-btn-blue', () => { list.append(itemRow({ isN: true })); list.scrollTop = list.scrollHeight; }, { width: '100%', marginTop: '10px', padding: '10px' }),
            btn('📌 현재 페이지', 'bm-btn-green', () => { list.append(itemRow({ n: document.title.substring(0,30), u: location.href })); list.scrollTop = list.scrollHeight; }, { width: '100%', marginTop: '5px', padding: '10px' }),
            $('div', { cls: 'bm-flex-row bm-mt-20' }, [
                btn('저장', 'bm-btn-green', async () => {
                    const nnm = ni.value.trim(); if (!nnm) return alert('이름을 입력하세요.');
                    const nIs = []; let bad = false;
                    for (const r of list.querySelectorAll('.e-r')) { const n = r.querySelector('.r-n').value.trim(), u = r.querySelector('.r-u').value.trim(); if (!n || !u) continue; if (!isUrl(u)) { bad = true; continue; } nIs.push({ name: n, url: u }); }
                    if (bad && !confirm('유효하지 않은 URL 제외?')) return;
                    pushUndo();
                    for (const it of nIs) { const o = is.find(x => x.url === it.url); it.icon = o?.icon || await fetchIcon(it.url); it.addedAt = o?.addedAt || Date.now(); }
                    const p = curPage();
                    if (nnm !== gn) {
                        if (p[nnm]) return alert('존재하는 이름입니다.');
                        const oK = colKey(gn), wC = _col.has(oK), rb = {};
                        for (const k of Object.keys(p)) rb[k === gn ? nnm : k] = k === gn ? nIs : p[k];
                        db.pages[db.currentPage] = rb; _col.delete(oK); if (wC) _col.add(colKey(nnm)); GM_setValue('bm_collapsed', JSON.stringify([..._col]));
                    } else p[gn] = nIs;
                    _urls = null; saveNow(); rerender(); m.close();
                }, { flex: '2', padding: '12px' }),
                btn('닫기', '', () => m.close(), { flex: '1', background: '#999', padding: '12px' })
            ]),
            btn('🗑 그룹 삭제', 'bm-btn-red', () => { if (is.length && !confirm(`"${gn}" 삭제?`)) return; pushUndo(); delete curPage()[gn]; _urls = null; saveNow(); rerender(); m.close(); }, { width: '100%', marginTop: '10px', padding: '10px' })
        ]));
        m.onkeydown = e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); m.querySelector('.bm-btn-green').click(); } };
        sInst = new Sortable(list, { handle: '.bm-drag-handle', animation: 150 });
    }

    function showTabMgr() {
        const m = modal(), list = $('div', { cls: 'bm-scroll-list' });
        const rnd = () => {
            list.replaceChildren();
            for (const tn of Object.keys(db.pages)) {
                list.append($('div', { cls: 'tab-row' }, [
                    $('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }),
                    $('div', { style: { display: 'flex', gap: '4px' } }, [
                        btn('변경', 'bm-btn-blue', () => {
                            const nn = prompt('새 이름:', tn); if (!nn || nn === tn) return;
                            if (vName(nn, Object.keys(db.pages))) return alert('오류');
                            const o = {}; for (const k of Object.keys(db.pages)) o[k === tn ? nn.trim() : k] = db.pages[k];
                            db.pages = o; if (db.currentPage === tn) db.currentPage = nn.trim(); saveNow(); rnd(); rerender();
                        }, { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => {
                            if (Object.keys(db.pages).length < 2) return alert('최소 1개');
                            if (!confirm(`"${tn}" 삭제?`)) return; pushUndo(); delete db.pages[tn];
                            if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0]; _urls = null; saveNow(); m.close(); rerender();
                        }, { padding: '4px 8px' })
                    ])
                ]));
            }
        }; rnd();
        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '📂 탭 관리', style: { marginTop: 0 } }), list,
            btn('+ 새 탭', 'bm-btn-blue', () => { const n = prompt('탭 이름:'); if (!n || vName(n, Object.keys(db.pages))) return; db.pages[n.trim()] = {}; db.currentPage = n.trim(); saveNow(); rerender(); m.close(); }, { width: '100%', marginTop: '15px', padding: '12px' }),
            btn('닫기', '', () => m.close(), { width: '100%', marginTop: '10px', background: '#999', padding: '10px' })
        ]));
    }

    async function showQuickAdd() {
        shadow.querySelector('#bm-quick')?.remove(); const m = modal('bm-quick'), cu = cleanUrl(location.href);
        const c = $('div', { cls: 'bm-modal-content' }, [$('h3', { text: '🔖 북마크 저장', style: { marginTop: 0 } })]);
        if (isDup(cu)) c.append($('div', { text: `⚠ 기저장: ${findLocs(cu).join(', ')}`, style: { color: 'var(--c-warning)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' } }));
        const ni = $('input', { type: 'text', value: document.title.substring(0, 30), oninput: () => ni.dataset.m = '1' });
        const ui = $('input', { type: 'text', value: cu, onchange: () => { if (isUrl(ui.value) && !ni.dataset.m) gmFetch(ui.value).then(r => { const m = r?.match(/<title[^>]*>([^<]+)<\/title>/i); if (m?.[1]) ni.value = m[1].trim().substring(0,30); }); }});
        c.append($('label', { text: '이름' }), ni, $('label', { text: 'URL' }), ui);

        const sTo = async (p, g) => {
            const nn = ni.value.trim(), uu = cleanUrl(ui.value.trim());
            if (!nn || !isUrl(uu)) return alert('올바른 값을 입력하세요.');
            pushUndo(); if (!db.pages[p][g]) db.pages[p][g] = [];
            db.pages[p][g].push({ name: nn, url: uu, icon: await fetchIcon(uu), addedAt: Date.now() });
            addUrl(uu); setRecent(p, g); saveNow(); m.close(); rerender(); updateFab(); toast('✅ 저장됨');
        };

        const rct = getRecent(), dSug = suggestGroup(cu), gArea = $('div');
        if (rct && db.pages[rct.page]?.[rct.group]) c.append($('p', { text: `최근: ${rct.page} > ${rct.group}`, style: { fontSize: '11px', color: '#999', margin: '10px 0 2px' } }), btn(`⚡ 바로 저장`, 'bm-btn-blue', () => sTo(rct.page, rct.group), { width: '100%', padding: '10px' }));
        if (dSug && dSug !== rct?.group) c.append($('p', { text: `💡 도메인 일치: ${dSug}`, style: { fontSize: '11px', color: 'var(--c-primary)', margin: '5px 0 2px' } }), btn(`📁 ${dSug}에 저장`, 'bm-btn-blue', () => sTo(db.currentPage, dSug), { width: '100%', padding: '10px' }));

        const rPicker = p => {
            gArea.replaceChildren($('p', { text: `그룹 선택 (${p}):`, style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
            const cEl = $('div', { cls: 'bm-flex-col' });
            Object.keys(db.pages[p]).forEach(g => cEl.append(btn(`📁 ${g}`, '', () => sTo(p, g), { background: 'var(--c-bg)', color: 'var(--c-text)', justifyContent: 'flex-start', padding: '12px' })));
            cEl.append(btn('+ 새 그룹', '', () => { const n = prompt("새 그룹:"); if (n && !vName(n, Object.keys(db.pages[p]))) sTo(p, n.trim()); }, { background: 'var(--c-dark)', color: '#fff', padding: '12px' }));
            gArea.append(cEl);
        };

        const ps = Object.keys(db.pages);
        if (ps.length === 1) rPicker(ps[0]);
        else { c.append($('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } })); const bs = $('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } }); ps.forEach(p => bs.append(btn(p, '', () => rPicker(p), { background: '#eee', color: '#333' }))); c.append(bs); }
        
        ni.onkeydown = ui.onkeydown = e => { if (e.key === 'Enter' && rct && db.pages[rct.page]?.[rct.group]) { e.preventDefault(); sTo(rct.page, rct.group); } };
        c.append(gArea, $('button', { text: '취소', style: { width: '100%', border: 0, background: 'none', marginTop: '20px', color: '#999', cursor: 'pointer' }, onclick: () => m.close() }));
        m.append(c); setTimeout(() => ni.focus(), 50);
    }

    /* ═══════════════════════════════════
       FAB & 메인
       ═══════════════════════════════════ */
    const updateFab = () => {
        const f = shadow?.querySelector('#bm-fab'); if (!f || shadow.querySelector('#bm-overlay')?.style.display === 'block') return;
        const c = findLocs(location.href).length; f.querySelector('.bm-badge')?.remove();
        if (c) { f.style.outline = '3px solid var(--c-success)'; f.style.outlineOffset = '2px'; f.append($('span', { cls: 'bm-badge', text: c > 9 ? '9+' : c })); }
        else f.style.outline = 'none';
    };

    const toggle = (o, f) => {
        if (o.style.display !== 'block') { refreshDB(); renderDash(); document.body.classList.add('bm-overlay-open'); o.style.display = 'block'; f.firstChild.textContent = '✕'; }
        else { document.body.classList.remove('bm-overlay-open'); o.style.display = 'none'; f.firstChild.textContent = '🔖'; killSorts(); _ctr = null; _obs?.disconnect(); _obs = null; updateFab(); }
    };

    function init() {
        if (!document.getElementById('bm-host-css')) document.head.append($('style', { id: 'bm-host-css', text: 'body.bm-overlay-open{overflow:hidden!important}' }));
        shadow = document.body.appendChild($('div', { id: 'bm-root', style: { position: 'fixed', zIndex: '2147483647', top: 0, left: 0, width: 0, height: 0, overflow: 'visible' } })).attachShadow({ mode: 'open' });
        
        const ov = $('div', { id: 'bm-overlay' }), fab = $('div', { id: 'bm-fab' }, [document.createTextNode('🔖')]);
        shadow.append($('style', { text: `
:host{--c-primary:#007bff;--c-success:#28a745;--c-warning:#fd7e14;--c-danger:#dc3545;--c-dark:#333;--c-bg:#f1f3f5;--c-surface:#fff;--c-text:#333;--c-border:#ddd;--c-overlay:rgba(255,255,255,.98);--r:8px;--fab:46px;--grid-min:300px;--grid-max:1200px;--item-min:80px;--icon:32px;color-scheme:light dark}
@media(min-width:769px){:host{--item-min:90px;--icon:40px}}
@media(max-width:768px){:host{--fab:40px}#bm-fab{font-size:20px!important}}
@media(prefers-color-scheme:dark){:host{--c-dark:#e0e0e0;--c-bg:#1e1e1e;--c-surface:#2a2a2a;--c-text:#e0e0e0;--c-border:#444;--c-overlay:rgba(30,30,30,.98)}}
*{box-sizing:border-box;font-family:sans-serif}
#bm-fab{position:fixed;bottom:20px;right:20px;width:var(--fab);height:var(--fab);background:var(--c-dark);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:22px;user-select:none;touch-action:none;transition:left .2s,right .2s,top .2s,box-shadow .2s;border:none;z-index:99}
#bm-fab:hover{box-shadow:0 4px 12px rgba(0,0,0,.4)}
.bm-badge{position:absolute;top:-4px;right:-4px;background:var(--c-danger);color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0 4px}
#bm-swipe{position:fixed;width:30px;height:30px;background:var(--c-primary);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;pointer-events:none;z-index:999999}
#bm-overlay{position:fixed;inset:0;background:var(--c-overlay);display:none;overflow-y:auto;padding:15px;backdrop-filter:blur(5px);color:var(--c-text);text-align:left}
.bm-modal-content,.bm-ctr{color:var(--c-text);text-align:left;background:var(--c-surface)}
button{outline:0;border:0;font-family:sans-serif}
.bm-btn,.bm-mgr-btn{font-size:11px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bm-btn:hover{filter:brightness(1.15)}.bm-btn:active{filter:brightness(.9);transform:scale(.97)}
.bm-btn-blue{background:var(--c-primary)}.bm-btn-green{background:var(--c-success)}.bm-btn-red{background:var(--c-danger);color:#fff}
.bm-icon-btn{width:34px;height:34px;font-size:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;background:var(--c-dark)}
.bm-icon-btn:hover{filter:brightness(1.15)}.bm-icon-btn:active{filter:brightness(.9)}
input{width:100%;padding:10px;margin:5px 0;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);border-radius:6px;font-size:14px}
label{display:block;font-size:12px;font-weight:700;color:#666;margin-top:10px}
.bm-top{max-width:var(--grid-max);margin:0 auto 10px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0;z-index:100;background:var(--c-surface);padding:10px 0 5px;border-bottom:1px solid var(--c-border)}
.bm-bar{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;width:100%;align-items:center}
.bm-search{max-width:150px;padding:6px 10px!important;font-size:13px!important;margin:0!important}
.bm-tabs{display:flex;gap:5px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:5px;width:100%}
.bm-tab{padding:8px 14px;background:#eee;border-radius:var(--r) var(--r) 0 0;cursor:pointer;font-size:13px;font-weight:700;color:#666;white-space:nowrap;flex-shrink:0;user-select:none}
.bm-tab.active{background:var(--c-surface);color:var(--c-primary);border-bottom:3px solid var(--c-primary)}
.bm-btn{padding:7px 10px;color:#fff;background:var(--c-dark);border-radius:6px}
.bm-ctr{display:grid;grid-template-columns:repeat(auto-fit,minmax(var(--grid-min),1fr));gap:15px;max-width:var(--grid-max);margin:0 auto}
.bm-sec{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.bm-sec-hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--c-bg);position:relative;gap:8px}
.bm-sec-hdr::after{content:'';position:absolute;bottom:0;left:0;height:2px;background:var(--c-primary);width:var(--fill,0%);transition:width .3s}
.bm-gcnt{font-weight:400;font-size:12px;color:#999}
.bm-sec-hdr:has(+.bm-grid[style*="display: none"]) .bm-gcnt{background:var(--c-primary);color:#fff;padding:1px 6px;border-radius:10px;font-size:11px}
.bm-mgr-btn{border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);padding:6px 12px;border-radius:6px;font-weight:700}
.bm-qadd{width:32px;height:32px;border-radius:50%;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-primary);font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:auto;margin-right:8px}
.bm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--item-min),1fr));gap:12px;padding:15px;min-height:60px;justify-items:center}
.bm-wrap{display:flex;flex-direction:column;align-items:center;text-decoration:none;color:inherit;width:100%;max-width:80px}
.bm-item{display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;transition:transform .15s}
.bm-item:hover{transform:translateY(-2px)}
.bm-item img{width:var(--icon);height:var(--icon);margin-bottom:6px;border-radius:var(--r);background:#fff;object-fit:contain}
.bm-item span{font-size:11px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bm-empty{grid-column:1/-1;text-align:center;color:#bbb;font-size:12px;padding:25px;border:2px dashed var(--c-border);border-radius:var(--r)}
.sort-active .bm-grid{display:none}
.sort-active .bm-sec{border:2px dashed var(--c-primary);cursor:move}
.bm-grid .sortable-ghost{opacity:.4;background:color-mix(in srgb,var(--c-primary) 20%,transparent)}
dialog.bm-modal-bg{background:transparent;border:0;padding:0;margin:auto;max-width:100vw;max-height:100vh}
dialog.bm-modal-bg::backdrop{background:rgba(0,0,0,.6)}
.bm-modal-content{background:var(--c-surface);padding:25px;border-radius:15px;width:100%;max-width:min(420px,calc(100vw - 32px));max-height:85vh;overflow-y:auto}
.bm-ctx,.bm-admin-menu{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r);box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:140px;overflow:hidden}
.bm-ctx-item,.bm-admin-item{padding:10px 14px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px}
.bm-ctx-item:hover,.bm-admin-item:hover{background:var(--c-bg)}
.ctx-danger{color:var(--c-danger)}
.bm-gsr{background:var(--c-surface);border:2px solid var(--c-primary);border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.tab-row{display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--c-border);gap:10px}
.bm-drag-handle{cursor:grab;font-size:18px;margin-right:10px;color:#888}
.bm-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(0,0,0,.85);color:#fff;padding:10px 24px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;z-index:999999}
.bm-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bm-hint{max-width:var(--grid-max);margin:20px auto 10px;text-align:center;font-size:11px;color:#999}
.bm-flex-row{display:flex;gap:10px;align-items:center}.bm-flex-col{display:flex;flex-direction:column;gap:5px}
.bm-mt-10{margin-top:10px}.bm-mt-20{margin-top:20px}
.bm-scroll-list{max-height:40vh;overflow-y:auto;border:1px solid var(--c-border);border-radius:8px;padding:10px}
        ` }), ov, fab);

        let st = { t: 0, r: false, d: false, sx: 0, sy: 0, ox: 0, oy: 0, lx: 0, ly: 0, tp: 0 };
        fab.onpointerdown = e => { fab.setPointerCapture(e.pointerId); st.sx = st.lx = e.clientX; st.sy = st.ly = e.clientY; const r = fab.getBoundingClientRect(); st.ox = e.clientX - r.left; st.oy = e.clientY - r.top; st.r = st.d = false; st.t = setTimeout(() => { st.r = true; fab.style.willChange = 'transform,left,top'; fab.style.cursor = 'grabbing'; fab.style.boxShadow = '0 6px 20px rgba(0,0,0,.5)'; }, 500); };
        fab.onpointermove = e => { st.lx = e.clientX; st.ly = e.clientY; if (!st.r) { if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) clearTimeout(st.t); const dy = st.sy - e.clientY; let h = shadow.querySelector('#bm-swipe'); if (dy > 20 && Math.abs(e.clientX - st.sx) < 40) { if (!h) shadow.append(h = $('div', { id: 'bm-swipe', text: '＋' })); const r = fab.getBoundingClientRect(); h.style.left = (r.left + r.width / 2 - 15) + 'px'; h.style.top = (r.top - 40) + 'px'; h.style.opacity = Math.min(1, (dy - 20) / 30); } else h?.remove(); return; } st.d = true; fab.style.transition = 'none'; fab.style.left = Math.max(0, Math.min(innerWidth - 46, e.clientX - st.ox)) + 'px'; fab.style.top = Math.max(0, Math.min(innerHeight - 46, e.clientY - st.oy)) + 'px'; fab.style.right = fab.style.bottom = 'auto'; };
        fab.onpointerup = e => { clearTimeout(st.t); try { fab.releasePointerCapture(e.pointerId); } catch {} shadow.querySelector('#bm-swipe')?.remove(); if (st.d) { fab.style.transition = ''; fab.style.bottom = 'auto'; fab.style.willChange = ''; const s = fab.getBoundingClientRect().left + 23 > innerWidth / 2; fab.style.left = s ? 'auto' : '15px'; fab.style.right = s ? '15px' : 'auto'; st.d = st.r = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = ''; st.tp = 0; return; } if (st.r) { st.r = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = fab.style.willChange = ''; st.tp = 0; return; } if (st.sy - st.ly > 50 && Math.abs(st.lx - st.sx) < 40) { st.tp = 0; showQuickAdd(); return; } const n = Date.now(); if (n - st.tp < 350) { st.tp = 0; showQuickAdd(); } else { st.tp = n; setTimeout(() => { if (st.tp && Date.now() - st.tp >= 340) { st.tp = 0; toggle(ov, fab); } }, 350); } };
        fab.oncontextmenu = e => e.preventDefault();

        document.onkeydown = e => { if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggle(ov, fab); } if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); showQuickAdd(); } if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ' && ov.style.display === 'block') { e.preventDefault(); popUndo() || toast('되돌릴 내역 없음'); } if (e.key === 'Escape' && ov.style.display === 'block' && !shadow.querySelector('dialog[open]')) { e.preventDefault(); toggle(ov, fab); } };

        document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); else { refreshDB(); updateFab(); rerender(); } });
        window.addEventListener('pagehide', saveNow); window.addEventListener('beforeunload', saveNow);
        if ('onfreeze' in document) document.addEventListener('freeze', saveNow);
        updateFab();
    }
    init();
})();
