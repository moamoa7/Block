// ==UserScript==
// @name         북마크 (Glassmorphism v27.1)
// @version      27.1
// @description  v27 기반 — 파비콘 없는 URL에 호스트명 첫 글자 + 해시 컬러 플레이스홀더 SVG 생성
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
       structuredClone 폴리필
       ═══════════════════════════════════ */
    const deepClone = typeof structuredClone === 'function'
        ? structuredClone
        : obj => JSON.parse(JSON.stringify(obj));

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
                for (const c of children) if (c) e.append(c);
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

    const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const escHtml = s => s.replace(/[&<>"]/g, c => _escMap[c]);

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

    /* URL 추적 파라미터 제거 */
    const _utmParams = new Set([
        'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
        'fbclid','gclid','msclkid','mc_eid','_ga',
        'dclid','twclid','li_fat_id','igshid','s_kwcid',
        'ttclid','wbraid','gbraid','_gl','yclid',
        'ref','ref_src','ref_url','source','campaign_id',
        'ad_id','adset_id','scid','click_id','zanpid'
    ]);
    const cleanUrl = s => {
        try {
            const u = new URL(s);
            const toDelete = [];
            for (const key of u.searchParams.keys()) {
                if (_utmParams.has(key)) toDelete.push(key);
            }
            let changed = false;
            for (const key of toDelete) { u.searchParams.delete(key); changed = true; }
            if (u.hash === '#') { u.hash = ''; changed = true; }
            return changed ? u.toString() : s;
        } catch { return s; }
    };

    /* ═══════════════════════════════════
       파비콘 (CSP 우회 + 플레이스홀더)
       ═══════════════════════════════════ */
    const FALLBACK_ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    /* 호스트명 기반 컬러 플레이스홀더 SVG */
    const _placeholderCache = new Map();
    const _phColors = [
        '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7',
        '#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9',
        '#F0B27A','#82E0AA','#F1948A','#AED6F1','#D7BDE2',
        '#A3E4D7','#FAD7A0','#A9CCE3','#D5DBDB','#EDBB99'
    ];
    const genPlaceholder = url => {
        let host = '';
        try { host = new URL(url).hostname; } catch { host = 'x'; }
        if (_placeholderCache.has(host)) return _placeholderCache.get(host);

        /* 첫 의미있는 글자 추출 */
        const cleaned = host.replace(/^www\./, '');
        const letter = (cleaned[0] || '?').toUpperCase();

        /* 해시로 색상 결정 */
        let hash = 0;
        for (let i = 0; i < host.length; i++) hash = ((hash << 5) - hash + host.charCodeAt(i)) | 0;
        const color = _phColors[Math.abs(hash) % _phColors.length];

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
            `<rect width="64" height="64" rx="14" fill="${color}"/>` +
            `<text x="32" y="32" dy=".35em" text-anchor="middle" ` +
            `font-family="-apple-system,BlinkMacSystemFont,sans-serif" ` +
            `font-size="30" font-weight="700" fill="#fff">${letter}</text></svg>`;
        const dataUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
        _placeholderCache.set(host, dataUrl);
        return dataUrl;
    };

    /* 파비콘 캐시 */
    const _favMemCache = new Map();
    const _favInflight = new Map();
    let _favDisk = null;
    const _FAV_DISK_KEY = 'bm_fav_cache_v1';
    const _FAV_MAX = 800;

    /* Google 기본 지구본 아이콘 감지용 — 크기가 매우 작으면 파비콘 없는 사이트 */
    const _GFAV_MIN_SIZE = 200;

    const loadFavDisk = () => {
        if (_favDisk) return _favDisk;
        try { _favDisk = JSON.parse(GM_getValue(_FAV_DISK_KEY, '{}')); } catch { _favDisk = {}; }
        return _favDisk;
    };

    const saveFavDisk = () => {
        try {
            const keys = Object.keys(_favDisk);
            if (keys.length > _FAV_MAX) {
                const cut = keys.slice(0, keys.length - _FAV_MAX);
                for (const k of cut) delete _favDisk[k];
            }
            GM_setValue(_FAV_DISK_KEY, JSON.stringify(_favDisk));
        } catch {}
    };

    let _favSaveTimer = 0;
    const saveFavDiskLazy = () => {
        clearTimeout(_favSaveTimer);
        _favSaveTimer = setTimeout(saveFavDisk, 2000);
    };

    const fetchFaviconDataUrl = (host, url) => {
        if (_favInflight.has(host)) return _favInflight.get(host);
        const placeholder = genPlaceholder(url);
        const p = new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
                responseType: 'blob',
                timeout: 6000,
                onload: res => {
                    _favInflight.delete(host);
                    if (res.status >= 200 && res.status < 400 && res.response && res.response.size > _GFAV_MIN_SIZE) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const dataUrl = reader.result;
                            _favMemCache.set(host, dataUrl);
                            loadFavDisk()[host] = dataUrl;
                            saveFavDiskLazy();
                            resolve(dataUrl);
                        };
                        reader.onerror = () => resolve(placeholder);
                        reader.readAsDataURL(res.response);
                    } else {
                        /* 파비콘 없음 → 플레이스홀더를 캐시하여 재요청 방지 */
                        _favMemCache.set(host, placeholder);
                        loadFavDisk()[host] = placeholder;
                        saveFavDiskLazy();
                        resolve(placeholder);
                    }
                },
                onerror: () => { _favInflight.delete(host); resolve(placeholder); },
                ontimeout: () => { _favInflight.delete(host); resolve(placeholder); }
            });
        });
        _favInflight.set(host, p);
        return p;
    };

    const setFavicon = (imgEl, url) => {
        const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
        if (!host) { imgEl.src = genPlaceholder(url); return; }

        if (_favMemCache.has(host)) { imgEl.src = _favMemCache.get(host); return; }

        const disk = loadFavDisk();
        if (disk[host]) { _favMemCache.set(host, disk[host]); imgEl.src = disk[host]; return; }

        imgEl.src = genPlaceholder(url);
        fetchFaviconDataUrl(host, url).then(src => { if (imgEl.isConnected) imgEl.src = src; });
    };

    /* ═══════════════════════════════════
       네트워크
       ═══════════════════════════════════ */
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
       한국어 초성 검색
       ═══════════════════════════════════ */
    const KoreanSearch = (() => {
        const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
        const BASE = 0xAC00;
        const choSet = new Set(CHO);
        const getChosung = str => {
            let r = '';
            for (let i = 0, l = str.length; i < l; i++) {
                const c = str.charCodeAt(i);
                r += (c >= BASE && c <= 0xD7A3) ? CHO[Math.floor((c - BASE) / 588)] : str[i];
            }
            return r;
        };
        const hasChosung = str => { for (let i = 0; i < str.length; i++) if (choSet.has(str[i])) return true; return false; };
        const match = (text, query) => {
            const lt = text.toLowerCase(), lq = query.toLowerCase();
            if (lt.includes(lq)) return true;
            if (hasChosung(lq)) return getChosung(lt).includes(lq);
            return false;
        };
        return { match, getChosung, hasChosung };
    })();

    /* ═══════════════════════════════════
       DB
       ═══════════════════════════════════ */
    let db = null, shadow = null, isSortMode = false, _isOpen = false,
        _dirty = false, _saveTimer = null, _urlSet = null, _urlLocs = null,
        _undo = [], _searchIndex = null;

    const forEachItem = cb => {
        for (const p in db.pages) {
            const groups = db.pages[p];
            for (const g in groups) {
                const items = groups[g];
                for (let i = 0, len = items.length; i < len; i++) {
                    if (cb(items[i], p, g, i) === false) return;
                }
            }
        }
    };

    const validateDB = d =>
        d?.pages && typeof d.pages === 'object' && d.currentPage && d.pages[d.currentPage];

    const loadDB = () => {
        const raw = GM_getValue('bm_db_v2', null);
        if (validateDB(raw)) return raw;
        return { currentPage: "기본", pages: { "기본": { "북마크": [] } } };
    };

    db = loadDB();

    const curPage = () => db.pages[db.currentPage];

    const saveNow = () => {
        clearTimeout(_saveTimer);
        if (!_dirty) return;
        _dirty = false;
        _urlSet = null;
        _urlLocs = null;
        _searchIndex = null;
        try {
            GM_setValue('bm_db_v2', db);
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

    const save = () => {
        _dirty = true;
        saveNow();
    };

    const refreshDB = () => {
        if (_dirty) saveNow();
        const fresh = GM_getValue('bm_db_v2', null);
        if (validateDB(fresh)) { db = fresh; _dirty = false; _urlSet = null; _urlLocs = null; _searchIndex = null; return true; }
        return false;
    };

    /* Undo */
    const pushUndo = () => {
        try {
            _undo.push(deepClone(db));
            if (_undo.length > 5) _undo.shift();
        } catch { _undo.length = 0; }
    };
    const popUndo = () => {
        if (!_undo.length) return false;
        db = _undo.pop(); _urlSet = null; _urlLocs = null; _searchIndex = null; save(); rerender();
        toast('↩ 되돌리기 완료');
        return true;
    };

    /* URL 중복 체크 + 위치 정보 */
    const buildUrlSet = () => {
        _urlSet = new Map();
        _urlLocs = new Map();
        forEachItem((it, p, g) => {
            _urlSet.set(it.url, (_urlSet.get(it.url) || 0) + 1);
            if (!_urlLocs.has(it.url)) _urlLocs.set(it.url, []);
            _urlLocs.get(it.url).push(`${p} > ${g}`);
        });
    };
    const isDup = u => { if (!_urlSet) buildUrlSet(); return (_urlSet.get(u) || 0) > 0; };
    const addUrl = u => {
        if (!_urlSet) buildUrlSet();
        _urlSet.set(u, (_urlSet.get(u) || 0) + 1);
        _urlLocs = null;
    };
    const delUrl = u => {
        if (!_urlSet) return;
        const c = _urlSet.get(u) || 0;
        if (c <= 1) _urlSet.delete(u); else _urlSet.set(u, c - 1);
        _urlLocs = null;
    };
    const findLocs = u => {
        if (!_urlLocs) buildUrlSet();
        return _urlLocs.get(u) || [];
    };

    /* 검색 인덱스 */
    const buildSearchIndex = () => {
        _searchIndex = [];
        forEachItem((it, pn, gn) => {
            _searchIndex.push({
                name: it.name,
                nameLower: it.name.toLowerCase(),
                chosung: KoreanSearch.getChosung(it.name.toLowerCase()),
                url: it.url,
                urlLower: it.url.toLowerCase(),
                pn, gn, item: it
            });
        });
    };
    const searchAll = (query, limit = 50) => {
        if (!_searchIndex) buildSearchIndex();
        const lq = query.toLowerCase();
        const isC = KoreanSearch.hasChosung(lq);
        const results = [];
        for (let i = 0, l = _searchIndex.length; i < l && results.length < limit; i++) {
            const e = _searchIndex[i];
            if (e.nameLower.includes(lq) || e.urlLower.includes(lq) || (isC && e.chosung.includes(lq))) {
                results.push(e);
            }
        }
        return results;
    };

    /* 접기 상태 */
    const _col = new Set(JSON.parse(GM_getValue('bm_collapsed', '[]') || '[]'));
    const colKey = g => `${db.currentPage}::${g}`;
    const saveCol = () => GM_setValue('bm_collapsed', JSON.stringify([..._col]));
    const toggleCol = g => {
        const k = colKey(g);
        _col.has(k) ? _col.delete(k) : _col.add(k);
        saveCol();
    };

    const cleanCol = () => {
        let changed = false;
        for (const k of _col) {
            const [pn, gn] = k.split('::');
            if (!db.pages[pn] || !db.pages[pn][gn]) {
                _col.delete(k);
                changed = true;
            }
        }
        if (changed) saveCol();
    };

    /* 최근 저장 */
    const setRecent = (p, g) => GM_setValue('bm_recent', JSON.stringify({ page: p, group: g, ts: Date.now() }));
    const getRecent = () => { try { return JSON.parse(GM_getValue('bm_recent', 'null')); } catch { return null; } };

    /* 도메인 기반 그룹 추천 */
    const suggestGroup = u => {
        try {
            const h = new URL(u).hostname;
            const c = {};
            const page = curPage();
            for (const g in page) {
                const items = page[g];
                for (let i = 0; i < items.length; i++) {
                    try { if (new URL(items[i].url).hostname === h) c[g] = (c[g] || 0) + 1; } catch {}
                }
            }
            let best = null, bestN = 0;
            for (const g in c) if (c[g] > bestN) { best = g; bestN = c[g]; }
            return best;
        } catch { return null; }
    };

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
        if (opts.id) d.id = opts.id;
        d.className = 'bm-modal-bg';
        d.onclick = e => {
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        };
        d.onclose = () => { opts.onClose?.(); d.remove(); };
        if (opts.prevent) d.oncancel = e => e.preventDefault();
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
                pushUndo();
                const arr = curPage()[gName];
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
    const triggerDl = (blob, fn) => {
        const u = URL.createObjectURL(blob);
        const a = $('a', { href: u, download: fn });
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    };

    const exportJSON = () => {
        if (_dirty) saveNow();
        triggerDl(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }), 'bookmarks.json');
    };

    const exportHTML = () => {
        if (_dirty) saveNow();
        const parts = [
            '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n'
        ];
        for (const [p, gs] of Object.entries(db.pages)) {
            parts.push(`  <DT><H3>${escHtml(p)}</H3>\n  <DL><p>\n`);
            for (const [g, is] of Object.entries(gs)) {
                parts.push(`    <DT><H3>${escHtml(g)}</H3>\n    <DL><p>\n`);
                for (const it of is) parts.push(`      <DT><A HREF="${escHtml(it.url)}">${escHtml(it.name)}</A>\n`);
                parts.push('    </DL><p>\n');
            }
            parts.push('  </DL><p>\n');
        }
        parts.push('</DL><p>');
        triggerDl(new Blob([parts.join('')], { type: 'text/html' }), 'bookmarks.html');
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
       건강 체크
       ═══════════════════════════════════ */
    async function showHealthCheck() {
        const all = [];
        forEachItem((it, pn, gn) => all.push({ ...it, pn, gn }));
        if (!all.length) return toast('북마크가 없습니다.');

        let cancel = false;
        const m = modal({ prevent: true });
        const status = $('div', { text: '검사 준비 중...' });
        const resultList = $('div', { cls: 'bm-scroll-list', style: { marginTop: '10px', maxHeight: '50vh' } });

        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🏥 북마크 건강 체크', style: { marginTop: 0 } }),
            status, resultList,
            $('div', { cls: 'bm-flex-row bm-mt-10' }, [
                btn('취소', 'bm-btn-red', () => { cancel = true; }, { flex: '1', padding: '10px' }),
                btn('닫기', '', () => m.close(), { flex: '1', padding: '10px', background: 'var(--c-text-muted)' })
            ])
        ]));

        const dead = [];
        const duplicates = new Map();
        for (const it of all) {
            if (!duplicates.has(it.url)) duplicates.set(it.url, []);
            duplicates.get(it.url).push(it);
        }
        const dups = [...duplicates.entries()].filter(([, v]) => v.length > 1);

        if (dups.length) {
            resultList.append($('div', {
                text: `⚠️ 중복 ${dups.length}개 발견`,
                style: { color: 'var(--c-amber)', fontWeight: 'bold', padding: '8px', fontSize: '12px' }
            }));
            for (const [url, items] of dups.slice(0, 20)) {
                const locs = items.map(i => `${i.pn}>${i.gn}`).join(', ');
                resultList.append($('div', {
                    text: `🔗 ${items[0].name} → ${locs}`, title: url,
                    style: { fontSize: '11px', padding: '4px 8px', color: 'var(--c-text-dim)', borderBottom: '1px solid var(--c-glass-border)' }
                }));
            }
        }

        for (let i = 0; i < all.length; i += 8) {
            if (cancel) break;
            status.textContent = `검사 중... ${Math.min(i + 8, all.length)} / ${all.length}`;
            await Promise.allSettled(
                all.slice(i, i + 8).map(async it => {
                    if (cancel) return;
                    try {
                        const ok = await new Promise(r =>
                            GM_xmlhttpRequest({
                                method: 'HEAD', url: it.url, timeout: 5000,
                                onload: res => r(res.status < 400 || res.status === 405),
                                onerror: () => r(false), ontimeout: () => r(false)
                            })
                        );
                        if (!ok) {
                            dead.push(it);
                            resultList.append($('div', {
                                text: `❌ ${it.name} (${it.pn}>${it.gn})`, title: it.url,
                                style: { fontSize: '11px', padding: '4px 8px', color: 'var(--c-red)', borderBottom: '1px solid var(--c-glass-border)', cursor: 'pointer' },
                                onclick: () => { navigator.clipboard?.writeText(it.url); toast('URL 복사됨'); }
                            }));
                        }
                    } catch {}
                })
            );
        }

        status.textContent = cancel
            ? `중단됨 — 죽은 링크 ${dead.length}개, 중복 ${dups.length}개`
            : `✅ 완료 — 죽은 링크 ${dead.length}개, 중복 ${dups.length}개`;

        if (dups.length) {
            resultList.append(btn('🧹 중복 자동 정리', 'bm-btn-blue', () => {
                if (!confirm(`${dups.length}개 중복 그룹에서 첫 번째만 남기고 제거합니다.`)) return;
                pushUndo();
                for (const [url, items] of dups) {
                    for (let k = 1; k < items.length; k++) {
                        const it = items[k];
                        const arr = db.pages[it.pn]?.[it.gn];
                        if (!arr) continue;
                        const idx = arr.findIndex(x => x.url === url && x.name === it.name);
                        if (idx > -1) arr.splice(idx, 1);
                    }
                }
                _urlSet = null; _urlLocs = null; save(); rerender();
                toast(`✅ ${dups.length}개 중복 정리됨`);
                m.close();
            }, { width: '100%', marginTop: '10px', padding: '10px' }));
        }

        if (dead.length) {
            resultList.append(btn('🗑 죽은 링크 일괄 삭제', 'bm-btn-red', () => {
                if (!confirm(`${dead.length}개 죽은 링크를 삭제합니다.`)) return;
                pushUndo();
                for (const it of dead) {
                    const arr = db.pages[it.pn]?.[it.gn];
                    if (!arr) continue;
                    const idx = arr.findIndex(x => x.url === it.url);
                    if (idx > -1) arr.splice(idx, 1);
                }
                _urlSet = null; _urlLocs = null; save(); rerender();
                toast(`✅ ${dead.length}개 삭제됨`);
                m.close();
            }, { width: '100%', marginTop: '5px', padding: '10px' }));
        }
    }

    /* ═══════════════════════════════════
       Sortable 관리
       ═══════════════════════════════════ */
    let _sorts = [];
    const killSorts = () => { _sorts.forEach(s => s.destroy()); _sorts.length = 0; };

    const rebuildGroupFromDOM = (gridEl, ...sourceArrays) => {
        const itemMap = new Map();
        for (const arr of sourceArrays) {
            for (let i = 0; i < arr.length; i++) {
                const it = arr[i];
                if (!itemMap.has(it.url)) itemMap.set(it.url, []);
                itemMap.get(it.url).push(it);
            }
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
       필터 (초성 지원)
       ═══════════════════════════════════ */
    let _filterRaf = 0;
    const filterItems = (q, container) => {
        cancelAnimationFrame(_filterRaf);
        _filterRaf = requestAnimationFrame(() => {
            for (const sec of container.querySelectorAll('.bm-sec')) {
                const grid = sec.querySelector('.bm-grid');
                if (!grid) continue;
                const gn = sec.dataset.id;
                let vis = false;
                for (const wrap of grid.querySelectorAll('.bm-wrap')) {
                    const match = !q
                        || KoreanSearch.match(wrap.textContent, q)
                        || (wrap.href || '').toLowerCase().includes(q.toLowerCase());
                    wrap.style.display = match ? '' : 'none';
                    if (match) vis = true;
                }
                if (q) {
                    grid.style.display = vis ? '' : 'none';
                    sec.style.display = vis ? '' : 'none';
                } else {
                    sec.style.display = '';
                    grid.style.display = !isSortMode && _col.has(colKey(gn)) ? 'none' : '';
                }
            }
        });
    };

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _sTimer = null, _ctr = null;

    let _renderRaf = 0;
    const rerender = () => {
        if (!_isOpen) return;
        cancelAnimationFrame(_renderRaf);
        _renderRaf = requestAnimationFrame(renderDash);
    };

    /* 파비콘 img 헬퍼 */
    const mkFavImg = url => {
        const img = $('img', { loading: 'lazy' });
        setFavicon(img, url);
        img.onerror = () => {
            img.onerror = null;
            img.src = genPlaceholder(url);
        };
        return img;
    };

    function renderDash() {
        const ov = shadow.querySelector('#bm-overlay');
        if (!ov) return;
        _ctxAC?.abort();
        ov.className = isSortMode ? 'sort-active' : '';
        ov.replaceChildren();

        const p = curPage(), frag = document.createDocumentFragment();

        /* 전체 카운트 */
        let totalCount = 0, maxN = 1;
        for (const items of Object.values(p)) {
            totalCount += items.length;
            if (items.length > maxN) maxN = items.length;
        }

        /* ── 탭 바 ── */
        const tabs = $('div', { cls: 'bm-tabs' });
        const pageKeys = Object.keys(db.pages);
        for (const pn of pageKeys) {
            const gs = db.pages[pn];
            const count = Object.values(gs).reduce((s, a) => s + a.length, 0);
            const t = $('div', {
                cls: `bm-tab ${db.currentPage === pn ? 'active' : ''}`,
                text: `${pn} (${count})`,
                'data-page': pn
            });
            let sx, sy, mvd;
            t.ontouchstart = e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; mvd = false; };
            t.ontouchmove = e => {
                if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) mvd = true;
            };
            t.ontouchend = e => {
                if (!mvd) { e.preventDefault(); db.currentPage = pn; isSortMode = false; save(); renderDash(); }
            };
            t.onclick = () => { db.currentPage = pn; isSortMode = false; save(); renderDash(); };
            tabs.append(t);
        }

        /* ── 상단 바 ── */
        const bar = $('div', { cls: 'bm-bar' }, [
            $('input', { type: 'search', placeholder: '🔍 검색 (초성 지원)...', cls: 'bm-search', oninput: e => {
                clearTimeout(_sTimer);
                _sTimer = setTimeout(() => {
                    const q = e.target.value.trim();
                    filterItems(q, _ctr ?? shadow);
                    _ctr?.querySelector('.bm-gsr')?.remove();
                    if (q.length >= 1 && _ctr) {
                        _searchIndex = null;
                        const res = searchAll(q, 50);
                        if (res.length) _ctr.prepend($('div', { cls: 'bm-gsr', style: { gridColumn: '1/-1' } }, [
                            $('div', {
                                text: `🔍 전체 검색 (${res.length}건)`,
                                style: { fontWeight: 'bold', fontSize: '13px', padding: '10px', background: 'var(--c-glass)', borderRadius: '12px 12px 0 0' }
                            }),
                            $('div', { cls: 'bm-grid' },
                                res.map(r => {
                                    const img = mkFavImg(r.url);
                                    return $('a', {
                                        cls: 'bm-wrap', href: r.url,
                                        title: `${r.pn} > ${r.gn}`,
                                        onclick: e => {
                                            if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                                e.preventDefault();
                                                window.open(r.url, '_blank');
                                            }
                                        }
                                    }, [$('div', { cls: 'bm-item' }, [img, $('span', { text: r.name })])]);
                                })
                            )
                        ]));
                    }
                }, 120);
            }}),
            $('span', {
                text: `${totalCount}개`,
                style: { fontSize: '11px', color: 'var(--c-text-dim)', marginRight: 'auto', fontFamily: 'var(--f-mono)' }
            }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', showQuickAdd),
            iconBtn(isSortMode ? '✅' : '↕️', '정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDash(); }),
            iconBtn('➕', '새 그룹', '', () => {
                const n = prompt("새 그룹:");
                const err = vName(n, Object.keys(p));
                if (err) { if (n) alert(err); return; }
                p[n.trim()] = [];
                save(); renderDash();
            }),
            iconBtn('⋯', '더보기', '', e => {
                e.stopPropagation();
                _ctxAC?.abort();
                _ctxAC = new AbortController();
                const menuItems = [
                    { i: '🏥', t: '건강 체크', fn: showHealthCheck },
                    { i: '📂', t: '탭 관리', fn: showTabMgr },
                    { i: '🗂', t: '접기/펼치기', fn: () => {
                        const ks = Object.keys(p).map(colKey);
                        const all = ks.every(k => _col.has(k));
                        ks.forEach(k => all ? _col.delete(k) : _col.add(k));
                        saveCol();
                        renderDash();
                    }},
                    { i: '🗑', t: '파비콘 캐시 초기화', fn: () => {
                        _favMemCache.clear();
                        _favDisk = {};
                        _placeholderCache.clear();
                        saveFavDisk();
                        toast('🗑 파비콘 캐시 초기화됨');
                        renderDash();
                    }},
                    { i: '💾', t: '백업 (JSON)', fn: exportJSON },
                    { i: '📄', t: '백업 (HTML)', fn: exportHTML },
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

        frag.append($('div', { cls: 'bm-top' }, [tabs, bar]));

        /* ── 그룹들 ── */
        _ctr = $('div', { cls: 'bm-ctr', onclick: e => {
            const b = e.target.closest('.bm-mgr-btn');
            if (b) showGroupMgr(b.closest('.bm-sec')?.dataset.id);
        }});

        /* D&D 임포트 */
        _ctr.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; _ctr.style.outline = '2px dashed var(--c-neon)'; };
        _ctr.ondragleave = () => _ctr.style.outline = '';
        _ctr.ondrop = async e => {
            e.preventDefault();
            _ctr.style.outline = '';
            const file = [...(e.dataTransfer.files || [])].find(f =>
                f.name.endsWith('.html') || f.name.endsWith('.htm')
            );
            if (file) {
                const text = await file.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, 'text/html');
                const links = doc.querySelectorAll('a[href]');
                if (!links.length) return toast('⚠ 북마크를 찾을 수 없습니다.');
                if (!confirm(`${links.length}개 북마크를 현재 페이지에 임포트?`)) return;
                pushUndo();
                const targetGroup = Object.keys(p)[0] || '가져오기';
                if (!p[targetGroup]) p[targetGroup] = [];
                let added = 0;
                for (const a of links) {
                    const url = a.href;
                    if (!isUrl(url) || isDup(url)) continue;
                    p[targetGroup].push({
                        name: (a.textContent || url).trim().substring(0, 30),
                        url: cleanUrl(url), addedAt: Date.now()
                    });
                    addUrl(url); added++;
                }
                save(); renderDash();
                toast(`✅ ${added}개 임포트 완료`);
                return;
            }
            const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (!raw || !isUrl(raw.trim())) return;
            const u = cleanUrl(raw.trim());
            if (isDup(u)) return toast('⚠ 이미 저장됨');
            const g = e.target.closest('.bm-grid')?.dataset.group || Object.keys(p)[0];
            if (!g) return toast('⚠ 그룹 없음');
            let nm = u;
            try { const html = await gmFetchText(u, 5000); nm = extractTitle(html) || u; } catch {}
            pushUndo();
            p[g].push({ name: nm, url: u, addedAt: Date.now() });
            addUrl(u); save(); renderDash();
            toast(`✅ "${g}" 추가됨`);
        };

        let secIdx = 0;
        for (const [gn, items] of Object.entries(p)) {
            const col = _col.has(colKey(gn));
            const gEl = $('div', { cls: 'bm-grid', 'data-group': gn });
            if (col && !isSortMode) gEl.style.display = 'none';

            if (!items.length && !isSortMode) {
                gEl.append($('div', { cls: 'bm-empty' }, [
                    $('div', { text: '📎', style: { fontSize: '24px', opacity: '.5' } }),
                    $('div', { text: '드래그하여 추가' })
                ]));
            }

            for (let idx = 0; idx < items.length; idx++) {
                const it = items[idx];
                const w = $('a', {
                    cls: 'bm-wrap', href: it.url,
                    title: it.addedAt ? `추가: ${new Date(it.addedAt).toLocaleDateString()}` : '',
                    onclick: e => {
                        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                            e.preventDefault();
                            window.open(it.url, '_blank');
                        }
                    }
                });
                w.oncontextmenu = e => ctxMenu(e, it, gn, idx);
                bindLP(w, e => ctxMenu(e, it, gn, idx));

                const img = mkFavImg(it.url);
                w.append($('div', { cls: 'bm-item' }, [img, $('span', { text: it.name })]));
                gEl.append(w);
            }

            const hdr = $('div', { cls: 'bm-sec-hdr', style: { '--fill': `${(items.length / maxN) * 100}%` } }, [
                $('span', {
                    style: { fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
                    onclick: () => {
                        if (isSortMode) return;
                        toggleCol(gn);
                        const now = _col.has(colKey(gn));
                        gEl.style.display = now ? 'none' : '';
                        hdr.firstChild.childNodes[0].textContent = `${now ? '▶' : '📁'} ${gn} `;
                    }
                }, [
                    document.createTextNode(`${isSortMode ? '≡' : (col ? '▶' : '📁')} ${gn} `),
                    $('span', { cls: 'bm-gcnt', text: `${items.length}` }),
                    ...(items.length >= 50 ? [$('span', { cls: 'bm-gwarn', text: '⚠' })] : [])
                ]),
                ...(!isSortMode ? [
                    $('button', { cls: 'bm-qadd', text: '+', onclick: e => {
                        e.stopPropagation();
                        const u = cleanUrl(location.href);
                        if (isDup(u)) return toast('⚠ 이미 저장됨');
                        pushUndo();
                        p[gn].push({
                            name: (document.title || u).substring(0, 30),
                            url: u, addedAt: Date.now()
                        });
                        addUrl(u); setRecent(db.currentPage, gn);
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
            $('div', { cls: 'bm-hint', text: 'Ctrl+Shift+B: 열기 | Ctrl+Shift+D: 빠른추가 | Ctrl+Z: 되돌리기 | /: 검색' })
        );
        ov.append(frag);
        killSorts();

        /* 탭 드래그 정렬 */
        if (pageKeys.length > 1) {
            _sorts.push(new Sortable(tabs, {
                animation: 150, direction: 'horizontal', draggable: '.bm-tab',
                delay: 300, delayOnTouchOnly: true,
                onEnd: () => {
                    const o = {};
                    tabs.querySelectorAll('.bm-tab').forEach(t => {
                        const pg = t.dataset.page;
                        if (db.pages[pg]) o[pg] = db.pages[pg];
                    });
                    db.pages = o; save();
                }
            }));
        }

        if (isSortMode) {
            _sorts.push(new Sortable(_ctr, {
                animation: 150, handle: '.bm-sec-hdr', draggable: '.bm-sec',
                onEnd: () => {
                    pushUndo();
                    const o = {};
                    _ctr.querySelectorAll('.bm-sec').forEach(s => {
                        if (p[s.dataset.id]) o[s.dataset.id] = p[s.dataset.id];
                    });
                    db.pages[db.currentPage] = o;
                    saveLazy();
                }
            }));
        } else {
            _ctr.querySelectorAll('.bm-grid').forEach(g => {
                if (g.style.display !== 'none') {
                    _sorts.push(new Sortable(g, {
                        group: 'bm-items', animation: 150,
                        delay: 600, delayOnTouchOnly: true,
                        onEnd: ev => {
                            pushUndo();
                            const page = curPage();
                            const fromGroup = ev.from.dataset.group;
                            const toGroup = ev.to.dataset.group;
                            const fromItems = page[fromGroup] || [];
                            const toItems = fromGroup !== toGroup ? (page[toGroup] || []) : fromItems;
                            page[fromGroup] = rebuildGroupFromDOM(ev.from, fromItems, toItems);
                            if (fromGroup !== toGroup) {
                                page[toGroup] = rebuildGroupFromDOM(ev.to, fromItems, toItems);
                            }
                            _urlSet = null;
                            _urlLocs = null;
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
        const items = curPage()[gn];
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
                    pushUndo();
                    const pg = curPage();
                    if (nnm !== gn) {
                        if (pg[nnm]) return alert('존재하는 이름입니다.');
                        const oK = colKey(gn), wC = _col.has(oK), rebuilt = {};
                        for (const k of Object.keys(pg))
                            rebuilt[k === gn ? nnm : k] = k === gn ? nItems : pg[k];
                        db.pages[db.currentPage] = rebuilt;
                        _col.delete(oK);
                        if (wC) _col.add(colKey(nnm));
                        saveCol();
                    } else {
                        pg[gn] = nItems;
                    }
                    _urlSet = null; _urlLocs = null; save(); rerender(); m.close();
                }, { flex: '2', padding: '12px' }),
                btn('닫기', '', () => m.close(), { flex: '1', background: 'var(--c-text-muted)', padding: '12px' })
            ]),
            btn('🗑 그룹 삭제', 'bm-btn-red', () => {
                if (items.length && !confirm(`"${gn}" 삭제?`)) return;
                pushUndo(); delete curPage()[gn];
                _col.delete(colKey(gn)); saveCol();
                _urlSet = null; _urlLocs = null; save(); rerender(); m.close();
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
       탭 관리 모달
       ═══════════════════════════════════ */
    function showTabMgr() {
        const m = modal();
        const list = $('div', { cls: 'bm-scroll-list' });
        const rnd = () => {
            list.replaceChildren();
            for (const tn of Object.keys(db.pages)) {
                list.append($('div', { cls: 'tab-row' }, [
                    $('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }),
                    $('div', { style: { display: 'flex', gap: '4px' } }, [
                        btn('변경', 'bm-btn-blue', () => {
                            const nn = prompt('새 이름:', tn);
                            if (!nn || nn === tn) return;
                            if (vName(nn, Object.keys(db.pages))) return alert('오류');
                            const o = {};
                            for (const k of Object.keys(db.pages))
                                o[k === tn ? nn.trim() : k] = db.pages[k];
                            db.pages = o;
                            if (db.currentPage === tn) db.currentPage = nn.trim();
                            save(); rnd(); rerender();
                        }, { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => {
                            if (Object.keys(db.pages).length < 2) return alert('최소 1개');
                            if (!confirm(`"${tn}" 삭제?`)) return;
                            pushUndo();
                            for (const g of Object.keys(db.pages[tn] || {})) _col.delete(`${tn}::${g}`);
                            saveCol();
                            delete db.pages[tn];
                            if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0];
                            _urlSet = null; _urlLocs = null; save(); m.close(); rerender();
                        }, { padding: '4px 8px' })
                    ])
                ]));
            }
        };
        rnd();
        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '📂 탭 관리', style: { marginTop: 0 } }), list,
            btn('+ 새 탭', 'bm-btn-blue', () => {
                const n = prompt('탭 이름:');
                if (!n || vName(n, Object.keys(db.pages))) return;
                db.pages[n.trim()] = {};
                db.currentPage = n.trim();
                save(); rerender(); m.close();
            }, { width: '100%', marginTop: '15px', padding: '12px' }),
            btn('닫기', '', () => m.close(), { width: '100%', marginTop: '10px', background: 'var(--c-text-muted)', padding: '10px' })
        ]));
    }

    /* ═══════════════════════════════════
       빠른 추가
       ═══════════════════════════════════ */
    function showQuickAdd() {
        shadow.querySelector('#bm-quick')?.remove();
        const m = modal({ id: 'bm-quick' });
        const cu = cleanUrl(location.href);
        const c = $('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🔖 북마크 저장', style: { marginTop: 0 } })
        ]);

        const dup = isDup(cu);
        if (dup) {
            c.append($('div', {
                text: `⚠ 기저장: ${findLocs(cu).join(', ')}`,
                style: { color: 'var(--c-amber)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }

        const ni = $('input', { type: 'text', value: document.title.substring(0, 30), oninput: () => ni.dataset.m = '1' });
        const ui = $('input', { type: 'text', value: cu, onchange: async () => {
            if (isUrl(ui.value) && !ni.dataset.m) {
                const html = await gmFetchText(ui.value, 5000);
                const title = extractTitle(html);
                if (title) ni.value = title;
            }
        }});
        c.append($('label', { text: '이름' }), ni, $('label', { text: 'URL' }), ui);

        const saveTo = (p, g) => {
            const nn = ni.value.trim(), uu = cleanUrl(ui.value.trim());
            if (!nn || !isUrl(uu)) return alert('올바른 값을 입력하세요.');
            if (isDup(uu)) return toast('⚠ 이미 저장된 URL입니다');
            pushUndo();
            if (!db.pages[p][g]) db.pages[p][g] = [];
            db.pages[p][g].push({ name: nn, url: uu, addedAt: Date.now() });
            addUrl(uu); setRecent(p, g);
            save(); m.close(); rerender(); updateFab();
            toast('✅ 저장됨');
        };

        /* 최근 그룹 바로저장 */
        const rct = getRecent();
        const dSug = suggestGroup(cu);

        if (rct && db.pages[rct.page]?.[rct.group]) {
            c.append(
                $('p', { text: `최근: ${rct.page} > ${rct.group}`, style: { fontSize: '11px', color: 'var(--c-text-dim)', margin: '10px 0 2px' } }),
                btn('⚡ 바로 저장', 'bm-btn-blue', () => saveTo(rct.page, rct.group), { width: '100%', padding: '10px' })
            );
        }

        if (dSug && dSug !== rct?.group) {
            c.append(
                $('p', { text: `💡 도메인 일치: ${dSug}`, style: { fontSize: '11px', color: 'var(--c-neon)', margin: '5px 0 2px' } }),
                btn(`📁 ${dSug}에 저장`, 'bm-btn-blue', () => saveTo(db.currentPage, dSug), { width: '100%', padding: '10px' })
            );
        }

        /* 그룹 선택 영역 */
        const gArea = $('div');
        const rPicker = pName => {
            gArea.replaceChildren(
                $('p', { text: `그룹 선택 (${pName}):`, style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } })
            );
            const cEl = $('div', { cls: 'bm-flex-col' });
            Object.keys(db.pages[pName]).forEach(g =>
                cEl.append(btn(`📁 ${g}`, '', () => saveTo(pName, g), {
                    background: 'var(--c-glass)', color: 'var(--c-text)',
                    justifyContent: 'flex-start', padding: '12px'
                }))
            );
            cEl.append(btn('+ 새 그룹', '', () => {
                const n = prompt("새 그룹:");
                if (n && !vName(n, Object.keys(db.pages[pName]))) saveTo(pName, n.trim());
            }, { background: 'var(--c-surface)', color: 'var(--c-neon)', padding: '12px', border: '1px dashed var(--c-neon-border)' }));
            gArea.append(cEl);
        };

        const ps = Object.keys(db.pages);
        if (ps.length === 1) {
            rPicker(ps[0]);
        } else {
            c.append($('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
            const bs = $('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } });
            ps.forEach(pn => bs.append(btn(pn, '', () => rPicker(pn), { background: 'var(--c-glass)', color: 'var(--c-text)' })));
            c.append(bs);
        }

        ni.onkeydown = ui.onkeydown = e => {
            if (e.key === 'Enter' && rct && db.pages[rct.page]?.[rct.group]) {
                e.preventDefault();
                saveTo(rct.page, rct.group);
            }
        };

        c.append(gArea, $('button', {
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
        const c = findLocs(location.href).length;
        if (c) {
            f.style.outline = '3px solid var(--c-neon)';
            f.style.outlineOffset = '2px';
            f.append($('span', { cls: 'bm-badge', text: c > 9 ? '9+' : String(c) }));
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
            if (_dirty) saveNow();
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
  font-size:22px;user-select:none;touch-action:none;border:1px solid var(--c-glass-border);
  backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  box-shadow:0 6px 24px rgba(0,0,0,0.4),var(--c-neon-glow);
  transition:all .3s var(--ease);z-index:99;
}
#bm-fab:hover{
  box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.3);
  border-color:var(--c-neon-border);transform:scale(1.06);
}
.bm-badge{
  position:absolute;top:-5px;right:-5px;background:var(--c-red);color:#fff;
  font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;
  display:flex;align-items:center;justify-content:center;padding:0 4px;
  box-shadow:0 0 8px rgba(255,77,106,0.5);
}
#bm-overlay{
  position:fixed;inset:0;background:var(--c-overlay);display:none;overflow-y:auto;
  padding:15px;backdrop-filter:blur(12px) saturate(180%);-webkit-backdrop-filter:blur(12px) saturate(180%);
  color:var(--c-text);text-align:left;
}
.bm-top{
  max-width:var(--grid-max);margin:0 auto 12px;display:flex;flex-direction:column;gap:8px;
  position:sticky;top:0;z-index:100;
  background:var(--c-glass);backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);
  padding:12px 16px 8px;border-radius:16px;border:1px solid var(--c-glass-border);
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
.bm-tabs{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;width:100%}
.bm-tab{
  padding:8px 16px;background:rgba(255,255,255,0.04);border-radius:var(--r);
  cursor:pointer;font-size:12px;font-weight:600;color:var(--c-text-dim);
  white-space:nowrap;flex-shrink:0;user-select:none;border:1px solid transparent;
  transition:all .2s var(--ease);letter-spacing:0.3px;
}
.bm-tab:hover{background:rgba(255,255,255,0.08);color:var(--c-text)}
.bm-tab.active{
  background:var(--c-neon-dim);color:var(--c-neon);border-color:var(--c-neon-border);
  box-shadow:0 0 10px rgba(0,229,255,0.1);
}
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
.bm-gwarn{color:var(--c-amber);font-size:12px}
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
  grid-column:1/-1;text-align:center;color:var(--c-text-muted);font-size:12px;
  padding:30px;border:2px dashed var(--c-glass-border);border-radius:var(--r);
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
.bm-gsr{
  background:var(--c-glass);border:1px solid var(--c-neon-border);border-radius:14px;
  box-shadow:0 4px 20px rgba(0,229,255,0.1);overflow:hidden;
}
.e-r{
  border-bottom:1px solid var(--c-glass-border);padding:10px 0;
  display:flex;gap:10px;align-items:center;animation:bm-sec-in .25s var(--ease) both;
}
.tab-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px;border-bottom:1px solid var(--c-glass-border);gap:10px;
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
#bm-swipe{
  position:fixed;width:32px;height:32px;background:var(--c-glass);border:1px solid var(--c-neon-border);
  color:var(--c-neon);border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:18px;font-weight:700;pointer-events:none;z-index:999999;
  backdrop-filter:blur(12px);box-shadow:var(--c-neon-glow);
}
.bm-wrap.kb-focus .bm-item{
  background:var(--c-neon-soft);outline:2px solid var(--c-neon-border);outline-offset:-2px;
}
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

        cleanCol();

        /* ── FAB 제스처 ── */
        const st = { t: 0, r: false, d: false, sx: 0, sy: 0, ox: 0, oy: 0, lx: 0, ly: 0, tp: 0 };

        fab.onpointerdown = e => {
            fab.setPointerCapture(e.pointerId);
            st.sx = st.lx = e.clientX;
            st.sy = st.ly = e.clientY;
            const r = fab.getBoundingClientRect();
            st.ox = e.clientX - r.left;
            st.oy = e.clientY - r.top;
            st.r = st.d = false;
            st.t = setTimeout(() => {
                st.r = true;
                fab.style.willChange = 'transform,left,top';
                fab.style.cursor = 'grabbing';
                fab.style.boxShadow = '0 6px 20px rgba(0,0,0,.5)';
            }, 500);
        };

        fab.onpointermove = e => {
            st.lx = e.clientX;
            st.ly = e.clientY;
            if (!st.r) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) clearTimeout(st.t);
                const dy = st.sy - e.clientY;
                let h = shadow.querySelector('#bm-swipe');
                if (dy > 20 && Math.abs(e.clientX - st.sx) < 40) {
                    if (!h) shadow.append(h = $('div', { id: 'bm-swipe', text: '＋' }));
                    const r = fab.getBoundingClientRect();
                    h.style.left = (r.left + r.width / 2 - 16) + 'px';
                    h.style.top = (r.top - 42) + 'px';
                    h.style.opacity = String(Math.min(1, (dy - 20) / 30));
                } else {
                    h?.remove();
                }
                return;
            }
            st.d = true;
            fab.style.transition = 'none';
            fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - st.ox)) + 'px';
            fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - st.oy)) + 'px';
            fab.style.right = fab.style.bottom = 'auto';
        };

        fab.onpointerup = e => {
            clearTimeout(st.t);
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe')?.remove();

            if (st.d) {
                fab.style.transition = '';
                fab.style.bottom = 'auto';
                fab.style.willChange = '';
                const s = fab.getBoundingClientRect().left + 24 > innerWidth / 2;
                fab.style.left = s ? 'auto' : '15px';
                fab.style.right = s ? '15px' : 'auto';
                st.d = st.r = false;
                fab.style.cursor = 'pointer';
                fab.style.boxShadow = '';
                st.tp = 0;
                return;
            }
            if (st.r) {
                st.r = false;
                fab.style.cursor = 'pointer';
                fab.style.boxShadow = fab.style.willChange = '';
                st.tp = 0;
                return;
            }
            if (st.sy - st.ly > 50 && Math.abs(st.lx - st.sx) < 40) {
                st.tp = 0;
                showQuickAdd();
                return;
            }
            const n = Date.now();
            if (n - st.tp < 350) {
                st.tp = 0;
                showQuickAdd();
            } else {
                st.tp = n;
                setTimeout(() => {
                    if (st.tp && Date.now() - st.tp >= 340) {
                        st.tp = 0;
                        toggle(ov, fab);
                    }
                }, 350);
            }
        };

        fab.oncontextmenu = e => e.preventDefault();

        /* ── 키보드 단축키 ── */
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggle(ov, fab); }
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); showQuickAdd(); }
            if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ' && _isOpen && !shadow.querySelector('dialog[open]')) {
                e.preventDefault(); popUndo() || toast('되돌릴 내역 없음');
            }
            if (e.key === 'Escape' && _isOpen && !shadow.querySelector('dialog[open]')) {
                e.preventDefault(); toggle(ov, fab);
            }
            if (e.key === '/' && _isOpen && !shadow.querySelector('dialog[open]')) {
                const s = shadow.querySelector('.bm-search');
                if (s && document.activeElement !== s) { e.preventDefault(); s.focus(); }
            }
        });

        /* 오버레이 키보드 탐색 */
        ov.onkeydown = e => {
            if (e.key === '/' && !shadow.querySelector('.bm-search:focus')) {
                e.preventDefault();
                shadow.querySelector('.bm-search')?.focus();
                return;
            }
            const gsr = shadow.querySelector('.bm-gsr');
            if (!gsr) return;
            const items = gsr.querySelectorAll('.bm-wrap');
            if (!items.length) return;
            let curr = gsr.querySelector('.bm-wrap.kb-focus');
            let idx = curr ? [...items].indexOf(curr) : -1;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                curr?.classList.remove('kb-focus');
                idx = Math.min(idx + 1, items.length - 1);
                items[idx].classList.add('kb-focus');
                items[idx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                curr?.classList.remove('kb-focus');
                idx = Math.max(idx - 1, 0);
                items[idx].classList.add('kb-focus');
                items[idx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && curr) {
                e.preventDefault();
                window.open(curr.href, '_blank');
            }
        };

        /* ── 라이프사이클 ── */
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
===
이 스크립트에서 수정한게
// ==UserScript==
// @name         북마크 (Glassmorphism v27.2)
// @version      27.2
// @description  v27.1 기반 — 탭 전환 시 파비콘 미표시 수정 (isConnected 제거, data-host 일괄갱신)
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

    const deepClone = typeof structuredClone === 'function'
        ? structuredClone
        : obj => JSON.parse(JSON.stringify(obj));

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
                for (const c of children) if (c) e.append(c);
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

    const _escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const escHtml = s => s.replace(/[&<>"]/g, c => _escMap[c]);

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

    const _utmParams = new Set([
        'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
        'fbclid','gclid','msclkid','mc_eid','_ga',
        'dclid','twclid','li_fat_id','igshid','s_kwcid',
        'ttclid','wbraid','gbraid','_gl','yclid',
        'ref','ref_src','ref_url','source','campaign_id',
        'ad_id','adset_id','scid','click_id','zanpid'
    ]);
    const cleanUrl = s => {
        try {
            const u = new URL(s);
            const toDelete = [];
            for (const key of u.searchParams.keys()) {
                if (_utmParams.has(key)) toDelete.push(key);
            }
            let changed = false;
            for (const key of toDelete) { u.searchParams.delete(key); changed = true; }
            if (u.hash === '#') { u.hash = ''; changed = true; }
            return changed ? u.toString() : s;
        } catch { return s; }
    };

    /* ═══════════════════════════════════
       파비콘 (CSP 우회 + 플레이스홀더 + 일괄갱신)
       ═══════════════════════════════════ */
    const FALLBACK_ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

    const _placeholderCache = new Map();
    const _phColors = [
        '#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7',
        '#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9',
        '#F0B27A','#82E0AA','#F1948A','#AED6F1','#D7BDE2',
        '#A3E4D7','#FAD7A0','#A9CCE3','#D5DBDB','#EDBB99'
    ];
    const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };

    const genPlaceholder = host => {
        if (!host) return FALLBACK_ICON;
        if (_placeholderCache.has(host)) return _placeholderCache.get(host);
        const cleaned = host.replace(/^www\./, '');
        const letter = (cleaned[0] || '?').toUpperCase();
        let hash = 0;
        for (let i = 0; i < host.length; i++) hash = ((hash << 5) - hash + host.charCodeAt(i)) | 0;
        const color = _phColors[Math.abs(hash) % _phColors.length];
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
            `<rect width="64" height="64" rx="14" fill="${color}"/>` +
            `<text x="32" y="32" dy=".35em" text-anchor="middle" ` +
            `font-family="-apple-system,BlinkMacSystemFont,sans-serif" ` +
            `font-size="30" font-weight="700" fill="#fff">${letter}</text></svg>`;
        const dataUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
        _placeholderCache.set(host, dataUrl);
        return dataUrl;
    };

    const _favMemCache = new Map();
    const _favInflight = new Map();
    let _favDisk = null;
    const _FAV_DISK_KEY = 'bm_fav_cache_v1';
    const _FAV_MAX = 800;
    const _GFAV_MIN_SIZE = 200;

    const loadFavDisk = () => {
        if (_favDisk) return _favDisk;
        try { _favDisk = JSON.parse(GM_getValue(_FAV_DISK_KEY, '{}')); } catch { _favDisk = {}; }
        return _favDisk;
    };

    const saveFavDisk = () => {
        try {
            const keys = Object.keys(_favDisk);
            if (keys.length > _FAV_MAX) {
                const cut = keys.slice(0, keys.length - _FAV_MAX);
                for (const k of cut) delete _favDisk[k];
            }
            GM_setValue(_FAV_DISK_KEY, JSON.stringify(_favDisk));
        } catch {}
    };

    let _favSaveTimer = 0;
    const saveFavDiskLazy = () => {
        clearTimeout(_favSaveTimer);
        _favSaveTimer = setTimeout(saveFavDisk, 2000);
    };

    /* [v27.2] fetch 완료 시 shadow 내 동일 호스트 img 일괄 갱신 */
    const updateHostImgs = (host, src) => {
        if (!shadow) return;
        const imgs = shadow.querySelectorAll(`img[data-host="${host}"]`);
        for (let i = 0; i < imgs.length; i++) imgs[i].src = src;
    };

    const fetchFaviconDataUrl = host => {
        if (_favInflight.has(host)) return _favInflight.get(host);
        const placeholder = genPlaceholder(host);
        const p = new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://www.google.com/s2/favicons?domain=${host}&sz=64`,
                responseType: 'blob',
                timeout: 6000,
                onload: res => {
                    _favInflight.delete(host);
                    if (res.status >= 200 && res.status < 400 && res.response && res.response.size > _GFAV_MIN_SIZE) {
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const dataUrl = reader.result;
                            _favMemCache.set(host, dataUrl);
                            loadFavDisk()[host] = dataUrl;
                            saveFavDiskLazy();
                            updateHostImgs(host, dataUrl);
                            resolve(dataUrl);
                        };
                        reader.onerror = () => resolve(placeholder);
                        reader.readAsDataURL(res.response);
                    } else {
                        _favMemCache.set(host, placeholder);
                        loadFavDisk()[host] = placeholder;
                        saveFavDiskLazy();
                        resolve(placeholder);
                    }
                },
                onerror: () => { _favInflight.delete(host); resolve(placeholder); },
                ontimeout: () => { _favInflight.delete(host); resolve(placeholder); }
            });
        });
        _favInflight.set(host, p);
        return p;
    };

    const setFavicon = (imgEl, url) => {
        const host = hostOf(url);
        if (!host) { imgEl.src = genPlaceholder(''); return; }
        imgEl.dataset.host = host;

        if (_favMemCache.has(host)) { imgEl.src = _favMemCache.get(host); return; }
        const disk = loadFavDisk();
        if (disk[host]) { _favMemCache.set(host, disk[host]); imgEl.src = disk[host]; return; }

        imgEl.src = genPlaceholder(host);
        fetchFaviconDataUrl(host);
    };

    /* ═══════════════════════════════════
       네트워크
       ═══════════════════════════════════ */
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
       한국어 초성 검색
       ═══════════════════════════════════ */
    const KoreanSearch = (() => {
        const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
        const BASE = 0xAC00;
        const choSet = new Set(CHO);
        const getChosung = str => {
            let r = '';
            for (let i = 0, l = str.length; i < l; i++) {
                const c = str.charCodeAt(i);
                r += (c >= BASE && c <= 0xD7A3) ? CHO[Math.floor((c - BASE) / 588)] : str[i];
            }
            return r;
        };
        const hasChosung = str => { for (let i = 0; i < str.length; i++) if (choSet.has(str[i])) return true; return false; };
        const match = (text, query) => {
            const lt = text.toLowerCase(), lq = query.toLowerCase();
            if (lt.includes(lq)) return true;
            if (hasChosung(lq)) return getChosung(lt).includes(lq);
            return false;
        };
        return { match, getChosung, hasChosung };
    })();

    /* ═══════════════════════════════════
       DB
       ═══════════════════════════════════ */
    let db = null, shadow = null, isSortMode = false, _isOpen = false,
        _dirty = false, _saveTimer = null, _urlSet = null, _urlLocs = null,
        _undo = [], _searchIndex = null;

    const forEachItem = cb => {
        for (const p in db.pages) {
            const groups = db.pages[p];
            for (const g in groups) {
                const items = groups[g];
                for (let i = 0, len = items.length; i < len; i++) {
                    if (cb(items[i], p, g, i) === false) return;
                }
            }
        }
    };

    const validateDB = d =>
        d?.pages && typeof d.pages === 'object' && d.currentPage && d.pages[d.currentPage];

    const loadDB = () => {
        const raw = GM_getValue('bm_db_v2', null);
        if (validateDB(raw)) return raw;
        return { currentPage: "기본", pages: { "기본": { "북마크": [] } } };
    };

    db = loadDB();

    const curPage = () => db.pages[db.currentPage];

    const saveNow = () => {
        clearTimeout(_saveTimer);
        if (!_dirty) return;
        _dirty = false;
        _urlSet = null; _urlLocs = null; _searchIndex = null;
        try { GM_setValue('bm_db_v2', db); }
        catch (e) { console.error(e); alert('❌ 저장 실패!'); }
    };

    const saveLazy = () => {
        _dirty = true;
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(saveNow, 300);
    };

    const save = () => { _dirty = true; saveNow(); };

    const refreshDB = () => {
        if (_dirty) saveNow();
        const fresh = GM_getValue('bm_db_v2', null);
        if (validateDB(fresh)) { db = fresh; _dirty = false; _urlSet = null; _urlLocs = null; _searchIndex = null; return true; }
        return false;
    };

    const pushUndo = () => {
        try { _undo.push(deepClone(db)); if (_undo.length > 5) _undo.shift(); }
        catch { _undo.length = 0; }
    };
    const popUndo = () => {
        if (!_undo.length) return false;
        db = _undo.pop(); _urlSet = null; _urlLocs = null; _searchIndex = null; save(); rerender();
        toast('↩ 되돌리기 완료');
        return true;
    };

    const buildUrlSet = () => {
        _urlSet = new Map(); _urlLocs = new Map();
        forEachItem((it, p, g) => {
            _urlSet.set(it.url, (_urlSet.get(it.url) || 0) + 1);
            if (!_urlLocs.has(it.url)) _urlLocs.set(it.url, []);
            _urlLocs.get(it.url).push(`${p} > ${g}`);
        });
    };
    const isDup = u => { if (!_urlSet) buildUrlSet(); return (_urlSet.get(u) || 0) > 0; };
    const addUrl = u => {
        if (!_urlSet) buildUrlSet();
        _urlSet.set(u, (_urlSet.get(u) || 0) + 1); _urlLocs = null;
    };
    const delUrl = u => {
        if (!_urlSet) return;
        const c = _urlSet.get(u) || 0;
        if (c <= 1) _urlSet.delete(u); else _urlSet.set(u, c - 1); _urlLocs = null;
    };
    const findLocs = u => { if (!_urlLocs) buildUrlSet(); return _urlLocs.get(u) || []; };

    const buildSearchIndex = () => {
        _searchIndex = [];
        forEachItem((it, pn, gn) => {
            _searchIndex.push({
                name: it.name, nameLower: it.name.toLowerCase(),
                chosung: KoreanSearch.getChosung(it.name.toLowerCase()),
                url: it.url, urlLower: it.url.toLowerCase(), pn, gn, item: it
            });
        });
    };
    const searchAll = (query, limit = 50) => {
        if (!_searchIndex) buildSearchIndex();
        const lq = query.toLowerCase();
        const isC = KoreanSearch.hasChosung(lq);
        const results = [];
        for (let i = 0, l = _searchIndex.length; i < l && results.length < limit; i++) {
            const e = _searchIndex[i];
            if (e.nameLower.includes(lq) || e.urlLower.includes(lq) || (isC && e.chosung.includes(lq)))
                results.push(e);
        }
        return results;
    };

    const _col = new Set(JSON.parse(GM_getValue('bm_collapsed', '[]') || '[]'));
    const colKey = g => `${db.currentPage}::${g}`;
    const saveCol = () => GM_setValue('bm_collapsed', JSON.stringify([..._col]));
    const toggleCol = g => { const k = colKey(g); _col.has(k) ? _col.delete(k) : _col.add(k); saveCol(); };

    const cleanCol = () => {
        let changed = false;
        for (const k of _col) {
            const [pn, gn] = k.split('::');
            if (!db.pages[pn] || !db.pages[pn][gn]) { _col.delete(k); changed = true; }
        }
        if (changed) saveCol();
    };

    const setRecent = (p, g) => GM_setValue('bm_recent', JSON.stringify({ page: p, group: g, ts: Date.now() }));
    const getRecent = () => { try { return JSON.parse(GM_getValue('bm_recent', 'null')); } catch { return null; } };

    const suggestGroup = u => {
        try {
            const h = new URL(u).hostname;
            const c = {};
            const page = curPage();
            for (const g in page) {
                for (let i = 0; i < page[g].length; i++) {
                    try { if (new URL(page[g][i].url).hostname === h) c[g] = (c[g] || 0) + 1; } catch {}
                }
            }
            let best = null, bestN = 0;
            for (const g in c) if (c[g] > bestN) { best = g; bestN = c[g]; }
            return best;
        } catch { return null; }
    };

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
        _toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, dur);
    };

    const modal = (opts = {}) => {
        const d = document.createElement('dialog');
        if (opts.id) d.id = opts.id;
        d.className = 'bm-modal-bg';
        d.onclick = e => {
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        };
        d.onclose = () => { opts.onClose?.(); d.remove(); };
        if (opts.prevent) d.oncancel = e => e.preventDefault();
        shadow.appendChild(d); d.showModal();
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
                pushUndo();
                const arr = curPage()[gName];
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
    const triggerDl = (blob, fn) => {
        const u = URL.createObjectURL(blob);
        const a = $('a', { href: u, download: fn }); a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    };

    const exportJSON = () => {
        if (_dirty) saveNow();
        triggerDl(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }), 'bookmarks.json');
    };

    const exportHTML = () => {
        if (_dirty) saveNow();
        const parts = [
            '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n'
        ];
        for (const [p, gs] of Object.entries(db.pages)) {
            parts.push(`  <DT><H3>${escHtml(p)}</H3>\n  <DL><p>\n`);
            for (const [g, is] of Object.entries(gs)) {
                parts.push(`    <DT><H3>${escHtml(g)}</H3>\n    <DL><p>\n`);
                for (const it of is) parts.push(`      <DT><A HREF="${escHtml(it.url)}">${escHtml(it.name)}</A>\n`);
                parts.push('    </DL><p>\n');
            }
            parts.push('  </DL><p>\n');
        }
        parts.push('</DL><p>');
        triggerDl(new Blob([parts.join('')], { type: 'text/html' }), 'bookmarks.html');
    };

    const importJSON = () => {
        const inp = $('input', { type: 'file', accept: '.json', onchange: e => {
            const r = new FileReader();
            r.onload = re => {
                try {
                    const p = JSON.parse(re.target.result);
                    if (!validateDB(p)) throw 1;
                    db = p; save(); rerender(); toast('✅ 복구 완료');
                } catch { alert('잘못된 파일 구조입니다.'); }
            };
            if (e.target.files[0]) r.readAsText(e.target.files[0]);
        }});
        inp.click();
    };

    /* ═══════════════════════════════════
       건강 체크
       ═══════════════════════════════════ */
    async function showHealthCheck() {
        const all = [];
        forEachItem((it, pn, gn) => all.push({ ...it, pn, gn }));
        if (!all.length) return toast('북마크가 없습니다.');

        let cancel = false;
        const m = modal({ prevent: true });
        const status = $('div', { text: '검사 준비 중...' });
        const resultList = $('div', { cls: 'bm-scroll-list', style: { marginTop: '10px', maxHeight: '50vh' } });

        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🏥 북마크 건강 체크', style: { marginTop: 0 } }),
            status, resultList,
            $('div', { cls: 'bm-flex-row bm-mt-10' }, [
                btn('취소', 'bm-btn-red', () => { cancel = true; }, { flex: '1', padding: '10px' }),
                btn('닫기', '', () => m.close(), { flex: '1', padding: '10px', background: 'var(--c-text-muted)' })
            ])
        ]));

        const dead = [];
        const duplicates = new Map();
        for (const it of all) {
            if (!duplicates.has(it.url)) duplicates.set(it.url, []);
            duplicates.get(it.url).push(it);
        }
        const dups = [...duplicates.entries()].filter(([, v]) => v.length > 1);

        if (dups.length) {
            resultList.append($('div', {
                text: `⚠️ 중복 ${dups.length}개 발견`,
                style: { color: 'var(--c-amber)', fontWeight: 'bold', padding: '8px', fontSize: '12px' }
            }));
            for (const [url, items] of dups.slice(0, 20)) {
                const locs = items.map(i => `${i.pn}>${i.gn}`).join(', ');
                resultList.append($('div', {
                    text: `🔗 ${items[0].name} → ${locs}`, title: url,
                    style: { fontSize: '11px', padding: '4px 8px', color: 'var(--c-text-dim)', borderBottom: '1px solid var(--c-glass-border)' }
                }));
            }
        }

        for (let i = 0; i < all.length; i += 8) {
            if (cancel) break;
            status.textContent = `검사 중... ${Math.min(i + 8, all.length)} / ${all.length}`;
            await Promise.allSettled(
                all.slice(i, i + 8).map(async it => {
                    if (cancel) return;
                    try {
                        const ok = await new Promise(r =>
                            GM_xmlhttpRequest({
                                method: 'HEAD', url: it.url, timeout: 5000,
                                onload: res => r(res.status < 400 || res.status === 405),
                                onerror: () => r(false), ontimeout: () => r(false)
                            })
                        );
                        if (!ok) {
                            dead.push(it);
                            resultList.append($('div', {
                                text: `❌ ${it.name} (${it.pn}>${it.gn})`, title: it.url,
                                style: { fontSize: '11px', padding: '4px 8px', color: 'var(--c-red)', borderBottom: '1px solid var(--c-glass-border)', cursor: 'pointer' },
                                onclick: () => { navigator.clipboard?.writeText(it.url); toast('URL 복사됨'); }
                            }));
                        }
                    } catch {}
                })
            );
        }

        status.textContent = cancel
            ? `중단됨 — 죽은 링크 ${dead.length}개, 중복 ${dups.length}개`
            : `✅ 완료 — 죽은 링크 ${dead.length}개, 중복 ${dups.length}개`;

        if (dups.length) {
            resultList.append(btn('🧹 중복 자동 정리', 'bm-btn-blue', () => {
                if (!confirm(`${dups.length}개 중복 그룹에서 첫 번째만 남기고 제거합니다.`)) return;
                pushUndo();
                for (const [url, items] of dups) {
                    for (let k = 1; k < items.length; k++) {
                        const it = items[k];
                        const arr = db.pages[it.pn]?.[it.gn]; if (!arr) continue;
                        const idx = arr.findIndex(x => x.url === url && x.name === it.name);
                        if (idx > -1) arr.splice(idx, 1);
                    }
                }
                _urlSet = null; _urlLocs = null; save(); rerender();
                toast(`✅ ${dups.length}개 중복 정리됨`); m.close();
            }, { width: '100%', marginTop: '10px', padding: '10px' }));
        }

        if (dead.length) {
            resultList.append(btn('🗑 죽은 링크 일괄 삭제', 'bm-btn-red', () => {
                if (!confirm(`${dead.length}개 죽은 링크를 삭제합니다.`)) return;
                pushUndo();
                for (const it of dead) {
                    const arr = db.pages[it.pn]?.[it.gn]; if (!arr) continue;
                    const idx = arr.findIndex(x => x.url === it.url);
                    if (idx > -1) arr.splice(idx, 1);
                }
                _urlSet = null; _urlLocs = null; save(); rerender();
                toast(`✅ ${dead.length}개 삭제됨`); m.close();
            }, { width: '100%', marginTop: '5px', padding: '10px' }));
        }
    }

    /* ═══════════════════════════════════
       Sortable 관리
       ═══════════════════════════════════ */
    let _sorts = [];
    const killSorts = () => { _sorts.forEach(s => s.destroy()); _sorts.length = 0; };

    const rebuildGroupFromDOM = (gridEl, ...sourceArrays) => {
        const itemMap = new Map();
        for (const arr of sourceArrays) {
            for (let i = 0; i < arr.length; i++) {
                const it = arr[i];
                if (!itemMap.has(it.url)) itemMap.set(it.url, []);
                itemMap.get(it.url).push(it);
            }
        }
        const result = [];
        for (const w of gridEl.querySelectorAll('.bm-wrap')) {
            const url = w.href, name = w.querySelector('span')?.textContent || '';
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
    const filterItems = (q, container) => {
        cancelAnimationFrame(_filterRaf);
        _filterRaf = requestAnimationFrame(() => {
            for (const sec of container.querySelectorAll('.bm-sec')) {
                const grid = sec.querySelector('.bm-grid');
                if (!grid) continue;
                const gn = sec.dataset.id;
                let vis = false;
                for (const wrap of grid.querySelectorAll('.bm-wrap')) {
                    const match = !q
                        || KoreanSearch.match(wrap.textContent, q)
                        || (wrap.href || '').toLowerCase().includes(q.toLowerCase());
                    wrap.style.display = match ? '' : 'none';
                    if (match) vis = true;
                }
                if (q) {
                    grid.style.display = vis ? '' : 'none';
                    sec.style.display = vis ? '' : 'none';
                } else {
                    sec.style.display = '';
                    grid.style.display = !isSortMode && _col.has(colKey(gn)) ? 'none' : '';
                }
            }
        });
    };

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _sTimer = null, _ctr = null;

    let _renderRaf = 0;
    const rerender = () => {
        if (!_isOpen) return;
        cancelAnimationFrame(_renderRaf);
        _renderRaf = requestAnimationFrame(renderDash);
    };

    const mkFavImg = url => {
        const img = $('img', { loading: 'lazy' });
        setFavicon(img, url);
        img.onerror = () => { img.onerror = null; img.src = genPlaceholder(hostOf(url)); };
        return img;
    };

    function renderDash() {
        const ov = shadow.querySelector('#bm-overlay');
        if (!ov) return;
        _ctxAC?.abort();
        ov.className = isSortMode ? 'sort-active' : '';
        ov.replaceChildren();

        const p = curPage(), frag = document.createDocumentFragment();

        let totalCount = 0, maxN = 1;
        for (const items of Object.values(p)) {
            totalCount += items.length;
            if (items.length > maxN) maxN = items.length;
        }

        /* ── 탭 바 ── */
        const tabs = $('div', { cls: 'bm-tabs' });
        const pageKeys = Object.keys(db.pages);
        for (const pn of pageKeys) {
            const gs = db.pages[pn];
            const count = Object.values(gs).reduce((s, a) => s + a.length, 0);
            const t = $('div', {
                cls: `bm-tab ${db.currentPage === pn ? 'active' : ''}`,
                text: `${pn} (${count})`, 'data-page': pn
            });
            let sx, sy, mvd;
            t.ontouchstart = e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; mvd = false; };
            t.ontouchmove = e => {
                if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) mvd = true;
            };
            t.ontouchend = e => {
                if (!mvd) { e.preventDefault(); db.currentPage = pn; isSortMode = false; save(); renderDash(); }
            };
            t.onclick = () => { db.currentPage = pn; isSortMode = false; save(); renderDash(); };
            tabs.append(t);
        }

        /* ── 상단 바 ── */
        const bar = $('div', { cls: 'bm-bar' }, [
            $('input', { type: 'search', placeholder: '🔍 검색 (초성 지원)...', cls: 'bm-search', oninput: e => {
                clearTimeout(_sTimer);
                _sTimer = setTimeout(() => {
                    const q = e.target.value.trim();
                    filterItems(q, _ctr ?? shadow);
                    _ctr?.querySelector('.bm-gsr')?.remove();
                    if (q.length >= 1 && _ctr) {
                        _searchIndex = null;
                        const res = searchAll(q, 50);
                        if (res.length) _ctr.prepend($('div', { cls: 'bm-gsr', style: { gridColumn: '1/-1' } }, [
                            $('div', {
                                text: `🔍 전체 검색 (${res.length}건)`,
                                style: { fontWeight: 'bold', fontSize: '13px', padding: '10px', background: 'var(--c-glass)', borderRadius: '12px 12px 0 0' }
                            }),
                            $('div', { cls: 'bm-grid' },
                                res.map(r => {
                                    const img = mkFavImg(r.url);
                                    return $('a', {
                                        cls: 'bm-wrap', href: r.url, title: `${r.pn} > ${r.gn}`,
                                        onclick: e => {
                                            if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                                                e.preventDefault(); window.open(r.url, '_blank');
                                            }
                                        }
                                    }, [$('div', { cls: 'bm-item' }, [img, $('span', { text: r.name })])]);
                                })
                            )
                        ]));
                    }
                }, 120);
            }}),
            $('span', {
                text: `${totalCount}개`,
                style: { fontSize: '11px', color: 'var(--c-text-dim)', marginRight: 'auto', fontFamily: 'var(--f-mono)' }
            }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', showQuickAdd),
            iconBtn(isSortMode ? '✅' : '↕️', '정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDash(); }),
            iconBtn('➕', '새 그룹', '', () => {
                const n = prompt("새 그룹:");
                const err = vName(n, Object.keys(p));
                if (err) { if (n) alert(err); return; }
                p[n.trim()] = []; save(); renderDash();
            }),
            iconBtn('⋯', '더보기', '', e => {
                e.stopPropagation();
                _ctxAC?.abort();
                _ctxAC = new AbortController();
                const menuItems = [
                    { i: '🏥', t: '건강 체크', fn: showHealthCheck },
                    { i: '📂', t: '탭 관리', fn: showTabMgr },
                    { i: '🗂', t: '접기/펼치기', fn: () => {
                        const ks = Object.keys(p).map(colKey);
                        const all = ks.every(k => _col.has(k));
                        ks.forEach(k => all ? _col.delete(k) : _col.add(k));
                        saveCol(); renderDash();
                    }},
                    { i: '🗑', t: '파비콘 캐시 초기화', fn: () => {
                        _favMemCache.clear(); _favDisk = {}; _placeholderCache.clear();
                        saveFavDisk(); toast('🗑 파비콘 캐시 초기화됨'); renderDash();
                    }},
                    { i: '💾', t: '백업 (JSON)', fn: exportJSON },
                    { i: '📄', t: '백업 (HTML)', fn: exportHTML },
                    { i: '📥', t: '복구', fn: importJSON }
                ];
                const m = $('div', { cls: 'bm-admin-menu' },
                    menuItems.map(a => $('div', {
                        cls: 'bm-admin-item', text: `${a.i} ${a.t}`,
                        onclick: () => { m.remove(); _ctxAC.abort(); a.fn(); }
                    }))
                );
                const r = e.target.getBoundingClientRect();
                Object.assign(m.style, {
                    position: 'fixed', top: (r.bottom + 4) + 'px',
                    right: (innerWidth - r.right) + 'px', zIndex: '999999'
                });
                shadow.append(m); popupDismiss(m, _ctxAC);
            })
        ]);

        frag.append($('div', { cls: 'bm-top' }, [tabs, bar]));

        /* ── 그룹들 ── */
        _ctr = $('div', { cls: 'bm-ctr', onclick: e => {
            const b = e.target.closest('.bm-mgr-btn');
            if (b) showGroupMgr(b.closest('.bm-sec')?.dataset.id);
        }});

        _ctr.ondragover = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; _ctr.style.outline = '2px dashed var(--c-neon)'; };
        _ctr.ondragleave = () => _ctr.style.outline = '';
        _ctr.ondrop = async e => {
            e.preventDefault(); _ctr.style.outline = '';
            const file = [...(e.dataTransfer.files || [])].find(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
            if (file) {
                const text = await file.text();
                const doc = new DOMParser().parseFromString(text, 'text/html');
                const links = doc.querySelectorAll('a[href]');
                if (!links.length) return toast('⚠ 북마크를 찾을 수 없습니다.');
                if (!confirm(`${links.length}개 북마크를 현재 페이지에 임포트?`)) return;
                pushUndo();
                const targetGroup = Object.keys(p)[0] || '가져오기';
                if (!p[targetGroup]) p[targetGroup] = [];
                let added = 0;
                for (const a of links) {
                    const url = a.href;
                    if (!isUrl(url) || isDup(url)) continue;
                    p[targetGroup].push({ name: (a.textContent || url).trim().substring(0, 30), url: cleanUrl(url), addedAt: Date.now() });
                    addUrl(url); added++;
                }
                save(); renderDash(); toast(`✅ ${added}개 임포트 완료`); return;
            }
            const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (!raw || !isUrl(raw.trim())) return;
            const u = cleanUrl(raw.trim());
            if (isDup(u)) return toast('⚠ 이미 저장됨');
            const g = e.target.closest('.bm-grid')?.dataset.group || Object.keys(p)[0];
            if (!g) return toast('⚠ 그룹 없음');
            let nm = u;
            try { const html = await gmFetchText(u, 5000); nm = extractTitle(html) || u; } catch {}
            pushUndo();
            p[g].push({ name: nm, url: u, addedAt: Date.now() });
            addUrl(u); save(); renderDash(); toast(`✅ "${g}" 추가됨`);
        };

        let secIdx = 0;
        for (const [gn, items] of Object.entries(p)) {
            const col = _col.has(colKey(gn));
            const gEl = $('div', { cls: 'bm-grid', 'data-group': gn });
            if (col && !isSortMode) gEl.style.display = 'none';

            if (!items.length && !isSortMode) {
                gEl.append($('div', { cls: 'bm-empty' }, [
                    $('div', { text: '📎', style: { fontSize: '24px', opacity: '.5' } }),
                    $('div', { text: '드래그하여 추가' })
                ]));
            }

            for (let idx = 0; idx < items.length; idx++) {
                const it = items[idx];
                const w = $('a', {
                    cls: 'bm-wrap', href: it.url,
                    title: it.addedAt ? `추가: ${new Date(it.addedAt).toLocaleDateString()}` : '',
                    onclick: e => {
                        if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                            e.preventDefault(); window.open(it.url, '_blank');
                        }
                    }
                });
                w.oncontextmenu = e => ctxMenu(e, it, gn, idx);
                bindLP(w, e => ctxMenu(e, it, gn, idx));
                w.append($('div', { cls: 'bm-item' }, [mkFavImg(it.url), $('span', { text: it.name })]));
                gEl.append(w);
            }

            const hdr = $('div', { cls: 'bm-sec-hdr', style: { '--fill': `${(items.length / maxN) * 100}%` } }, [
                $('span', {
                    style: { fontWeight: '700', fontSize: '13px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' },
                    onclick: () => {
                        if (isSortMode) return;
                        toggleCol(gn);
                        const now = _col.has(colKey(gn));
                        gEl.style.display = now ? 'none' : '';
                        hdr.firstChild.childNodes[0].textContent = `${now ? '▶' : '📁'} ${gn} `;
                    }
                }, [
                    document.createTextNode(`${isSortMode ? '≡' : (col ? '▶' : '📁')} ${gn} `),
                    $('span', { cls: 'bm-gcnt', text: `${items.length}` }),
                    ...(items.length >= 50 ? [$('span', { cls: 'bm-gwarn', text: '⚠' })] : [])
                ]),
                ...(!isSortMode ? [
                    $('button', { cls: 'bm-qadd', text: '+', onclick: e => {
                        e.stopPropagation();
                        const u = cleanUrl(location.href);
                        if (isDup(u)) return toast('⚠ 이미 저장됨');
                        pushUndo();
                        p[gn].push({ name: (document.title || u).substring(0, 30), url: u, addedAt: Date.now() });
                        addUrl(u); setRecent(db.currentPage, gn);
                        save(); renderDash(); toast(`✅ "${gn}" 추가됨`);
                    }}),
                    $('button', { cls: 'bm-mgr-btn', text: '관리' })
                ] : [])
            ]);

            const sec = $('div', { cls: 'bm-sec', 'data-id': gn, style: { '--sec-delay': `${secIdx * 0.04}s` } });
            sec.append(hdr, gEl); _ctr.append(sec); secIdx++;
        }

        frag.append(
            _ctr,
            $('div', { cls: 'bm-hint', text: 'Ctrl+Shift+B: 열기 | Ctrl+Shift+D: 빠른추가 | Ctrl+Z: 되돌리기 | /: 검색' })
        );
        ov.append(frag);
        killSorts();

        if (pageKeys.length > 1) {
            _sorts.push(new Sortable(tabs, {
                animation: 150, direction: 'horizontal', draggable: '.bm-tab',
                delay: 300, delayOnTouchOnly: true,
                onEnd: () => {
                    const o = {};
                    tabs.querySelectorAll('.bm-tab').forEach(t => {
                        const pg = t.dataset.page; if (db.pages[pg]) o[pg] = db.pages[pg];
                    });
                    db.pages = o; save();
                }
            }));
        }

        if (isSortMode) {
            _sorts.push(new Sortable(_ctr, {
                animation: 150, handle: '.bm-sec-hdr', draggable: '.bm-sec',
                onEnd: () => {
                    pushUndo();
                    const o = {};
                    _ctr.querySelectorAll('.bm-sec').forEach(s => { if (p[s.dataset.id]) o[s.dataset.id] = p[s.dataset.id]; });
                    db.pages[db.currentPage] = o; saveLazy();
                }
            }));
        } else {
            _ctr.querySelectorAll('.bm-grid').forEach(g => {
                if (g.style.display !== 'none') {
                    _sorts.push(new Sortable(g, {
                        group: 'bm-items', animation: 150,
                        delay: 600, delayOnTouchOnly: true,
                        onEnd: ev => {
                            pushUndo();
                            const page = curPage();
                            const fromGroup = ev.from.dataset.group, toGroup = ev.to.dataset.group;
                            const fromItems = page[fromGroup] || [];
                            const toItems = fromGroup !== toGroup ? (page[toGroup] || []) : fromItems;
                            page[fromGroup] = rebuildGroupFromDOM(ev.from, fromItems, toItems);
                            if (fromGroup !== toGroup) page[toGroup] = rebuildGroupFromDOM(ev.to, fromItems, toItems);
                            _urlSet = null; _urlLocs = null; saveLazy();
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
                    $('span', { text: '삭제', style: { color: 'var(--c-red)', cursor: 'pointer', fontSize: '11px' }, onclick: () => row.remove() })
                ]),
                ni, ui
            ])
        );
        return row;
    };

    function showGroupMgr(gn) {
        const items = curPage()[gn];
        if (!items) return;
        let sInst;
        const m = modal({ onClose: () => sInst?.destroy() });
        const ni = $('input', { type: 'text', value: gn });
        const list = $('div', { cls: 'bm-scroll-list bm-mt-10' });

        if (!items.length) {
            list.append($('div', { text: '북마크 없음', style: { color: 'var(--c-text-dim)', fontSize: '13px', textAlign: 'center', padding: '20px' } }));
        }
        items.forEach(it => list.append(itemRow({ n: it.name, u: it.url })));

        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🛠 그룹 관리', style: { marginTop: 0 } }),
            $('label', { text: '그룹 이름' }), ni, list,
            btn('+ 추가', 'bm-btn-blue', () => {
                list.append(itemRow({ isN: true })); list.scrollTop = list.scrollHeight;
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
                    pushUndo();
                    const pg = curPage();
                    if (nnm !== gn) {
                        if (pg[nnm]) return alert('존재하는 이름입니다.');
                        const oK = colKey(gn), wC = _col.has(oK), rebuilt = {};
                        for (const k of Object.keys(pg))
                            rebuilt[k === gn ? nnm : k] = k === gn ? nItems : pg[k];
                        db.pages[db.currentPage] = rebuilt;
                        _col.delete(oK); if (wC) _col.add(colKey(nnm)); saveCol();
                    } else { pg[gn] = nItems; }
                    _urlSet = null; _urlLocs = null; save(); rerender(); m.close();
                }, { flex: '2', padding: '12px' }),
                btn('닫기', '', () => m.close(), { flex: '1', background: 'var(--c-text-muted)', padding: '12px' })
            ]),
            btn('🗑 그룹 삭제', 'bm-btn-red', () => {
                if (items.length && !confirm(`"${gn}" 삭제?`)) return;
                pushUndo(); delete curPage()[gn];
                _col.delete(colKey(gn)); saveCol();
                _urlSet = null; _urlLocs = null; save(); rerender(); m.close();
            }, { width: '100%', marginTop: '10px', padding: '10px' })
        ]));

        m.onkeydown = e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); m.querySelector('.bm-btn-green').click(); } };
        sInst = new Sortable(list, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ═══════════════════════════════════
       탭 관리 모달
       ═══════════════════════════════════ */
    function showTabMgr() {
        const m = modal();
        const list = $('div', { cls: 'bm-scroll-list' });
        const rnd = () => {
            list.replaceChildren();
            for (const tn of Object.keys(db.pages)) {
                list.append($('div', { cls: 'tab-row' }, [
                    $('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis' } }),
                    $('div', { style: { display: 'flex', gap: '4px' } }, [
                        btn('변경', 'bm-btn-blue', () => {
                            const nn = prompt('새 이름:', tn);
                            if (!nn || nn === tn) return;
                            if (vName(nn, Object.keys(db.pages))) return alert('오류');
                            const o = {};
                            for (const k of Object.keys(db.pages)) o[k === tn ? nn.trim() : k] = db.pages[k];
                            db.pages = o;
                            if (db.currentPage === tn) db.currentPage = nn.trim();
                            save(); rnd(); rerender();
                        }, { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => {
                            if (Object.keys(db.pages).length < 2) return alert('최소 1개');
                            if (!confirm(`"${tn}" 삭제?`)) return;
                            pushUndo();
                            for (const g of Object.keys(db.pages[tn] || {})) _col.delete(`${tn}::${g}`);
                            saveCol(); delete db.pages[tn];
                            if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0];
                            _urlSet = null; _urlLocs = null; save(); m.close(); rerender();
                        }, { padding: '4px 8px' })
                    ])
                ]));
            }
        };
        rnd();
        m.append($('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '📂 탭 관리', style: { marginTop: 0 } }), list,
            btn('+ 새 탭', 'bm-btn-blue', () => {
                const n = prompt('탭 이름:');
                if (!n || vName(n, Object.keys(db.pages))) return;
                db.pages[n.trim()] = {}; db.currentPage = n.trim();
                save(); rerender(); m.close();
            }, { width: '100%', marginTop: '15px', padding: '12px' }),
            btn('닫기', '', () => m.close(), { width: '100%', marginTop: '10px', background: 'var(--c-text-muted)', padding: '10px' })
        ]));
    }

    /* ═══════════════════════════════════
       빠른 추가
       ═══════════════════════════════════ */
    function showQuickAdd() {
        shadow.querySelector('#bm-quick')?.remove();
        const m = modal({ id: 'bm-quick' });
        const cu = cleanUrl(location.href);
        const c = $('div', { cls: 'bm-modal-content' }, [
            $('h3', { text: '🔖 북마크 저장', style: { marginTop: 0 } })
        ]);

        const dup = isDup(cu);
        if (dup) {
            c.append($('div', {
                text: `⚠ 기저장: ${findLocs(cu).join(', ')}`,
                style: { color: 'var(--c-amber)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }

        const ni = $('input', { type: 'text', value: document.title.substring(0, 30), oninput: () => ni.dataset.m = '1' });
        const ui = $('input', { type: 'text', value: cu, onchange: async () => {
            if (isUrl(ui.value) && !ni.dataset.m) {
                const html = await gmFetchText(ui.value, 5000);
                const title = extractTitle(html);
                if (title) ni.value = title;
            }
        }});
        c.append($('label', { text: '이름' }), ni, $('label', { text: 'URL' }), ui);

        const saveTo = (p, g) => {
            const nn = ni.value.trim(), uu = cleanUrl(ui.value.trim());
            if (!nn || !isUrl(uu)) return alert('올바른 값을 입력하세요.');
            if (isDup(uu)) return toast('⚠ 이미 저장된 URL입니다');
            pushUndo();
            if (!db.pages[p][g]) db.pages[p][g] = [];
            db.pages[p][g].push({ name: nn, url: uu, addedAt: Date.now() });
            addUrl(uu); setRecent(p, g);
            save(); m.close(); rerender(); updateFab(); toast('✅ 저장됨');
        };

        const rct = getRecent();
        const dSug = suggestGroup(cu);

        if (rct && db.pages[rct.page]?.[rct.group]) {
            c.append(
                $('p', { text: `최근: ${rct.page} > ${rct.group}`, style: { fontSize: '11px', color: 'var(--c-text-dim)', margin: '10px 0 2px' } }),
                btn('⚡ 바로 저장', 'bm-btn-blue', () => saveTo(rct.page, rct.group), { width: '100%', padding: '10px' })
            );
        }

        if (dSug && dSug !== rct?.group) {
            c.append(
                $('p', { text: `💡 도메인 일치: ${dSug}`, style: { fontSize: '11px', color: 'var(--c-neon)', margin: '5px 0 2px' } }),
                btn(`📁 ${dSug}에 저장`, 'bm-btn-blue', () => saveTo(db.currentPage, dSug), { width: '100%', padding: '10px' })
            );
        }

        const gArea = $('div');
        const rPicker = pName => {
            gArea.replaceChildren(
                $('p', { text: `그룹 선택 (${pName}):`, style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } })
            );
            const cEl = $('div', { cls: 'bm-flex-col' });
            Object.keys(db.pages[pName]).forEach(g =>
                cEl.append(btn(`📁 ${g}`, '', () => saveTo(pName, g), {
                    background: 'var(--c-glass)', color: 'var(--c-text)',
                    justifyContent: 'flex-start', padding: '12px'
                }))
            );
            cEl.append(btn('+ 새 그룹', '', () => {
                const n = prompt("새 그룹:");
                if (n && !vName(n, Object.keys(db.pages[pName]))) saveTo(pName, n.trim());
            }, { background: 'var(--c-surface)', color: 'var(--c-neon)', padding: '12px', border: '1px dashed var(--c-neon-border)' }));
            gArea.append(cEl);
        };

        const ps = Object.keys(db.pages);
        if (ps.length === 1) {
            rPicker(ps[0]);
        } else {
            c.append($('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
            const bs = $('div', { style: { display: 'flex', gap: '5px', flexWrap: 'wrap' } });
            ps.forEach(pn => bs.append(btn(pn, '', () => rPicker(pn), { background: 'var(--c-glass)', color: 'var(--c-text)' })));
            c.append(bs);
        }

        ni.onkeydown = ui.onkeydown = e => {
            if (e.key === 'Enter' && rct && db.pages[rct.page]?.[rct.group]) {
                e.preventDefault(); saveTo(rct.page, rct.group);
            }
        };

        c.append(gArea, $('button', {
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
        const c = findLocs(location.href).length;
        if (c) {
            f.style.outline = '3px solid var(--c-neon)';
            f.style.outlineOffset = '2px';
            f.append($('span', { cls: 'bm-badge', text: c > 9 ? '9+' : String(c) }));
        } else { f.style.outline = 'none'; }
    };

    const toggle = (ov, fab) => {
        if (!_isOpen) {
            refreshDB(); renderDash();
            document.body.classList.add('bm-overlay-open');
            ov.style.display = 'block';
            fab.firstChild.textContent = '✕';
            _isOpen = true;
        } else {
            if (_dirty) saveNow();
            document.body.classList.remove('bm-overlay-open');
            ov.style.display = 'none';
            fab.firstChild.textContent = '🔖';
            _isOpen = false;
            killSorts(); _ctr = null; updateFab();
        }
    };

    /* ═══════════════════════════════════
       CSS
       ═══════════════════════════════════ */
    const GLASS_CSS = `
:host{--c-glass:rgba(16,18,27,.72);--c-glass-hover:rgba(30,33,48,.78);--c-glass-blur:blur(24px) saturate(200%);--c-glass-border:rgba(255,255,255,.06);--c-glass-border-hover:rgba(255,255,255,.12);--c-neon:#00e5ff;--c-neon-glow:0 0 12px rgba(0,229,255,.35);--c-neon-soft:rgba(0,229,255,.12);--c-neon-border:rgba(0,229,255,.25);--c-neon-dim:rgba(0,229,255,.06);--c-success:#4cff8d;--c-amber:#ffbe46;--c-red:#ff4d6a;--c-purple:#b47aff;--c-surface:rgba(22,24,35,.90);--c-bg:rgba(12,14,22,.95);--c-text:rgba(255,255,255,.92);--c-text-dim:rgba(255,255,255,.45);--c-text-muted:rgba(255,255,255,.25);--c-border:rgba(255,255,255,.06);--c-overlay:rgba(8,10,18,.92);--f:'SF Pro Display',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--f-mono:'SF Mono','Fira Code','JetBrains Mono',monospace;--r:10px;--fab:48px;--grid-min:300px;--grid-max:1200px;--item-min:80px;--icon:34px;--ease:cubic-bezier(.16,1,.3,1);--ease-spring:cubic-bezier(.34,1.56,.64,1);color-scheme:dark}
@media(min-width:769px){:host{--item-min:90px;--icon:40px}}
@media(max-width:768px){:host{--fab:42px}#bm-fab{font-size:20px!important}}
@media(prefers-color-scheme:light){:host{--c-glass:rgba(245,247,252,.82);--c-glass-hover:rgba(235,238,248,.88);--c-surface:rgba(255,255,255,.92);--c-bg:rgba(240,242,248,.95);--c-text:rgba(20,22,36,.92);--c-text-dim:rgba(20,22,36,.45);--c-text-muted:rgba(20,22,36,.25);--c-border:rgba(0,0,0,.06);--c-overlay:rgba(240,242,248,.95);--c-neon:#0088cc;--c-neon-glow:0 0 12px rgba(0,136,204,.25);--c-neon-soft:rgba(0,136,204,.10);--c-neon-border:rgba(0,136,204,.20);--c-glass-border:rgba(0,0,0,.06);--c-glass-border-hover:rgba(0,0,0,.10);--c-red:#dc3545;--c-success:#28a745;color-scheme:light}}
*{box-sizing:border-box;font-family:var(--f)}
#bm-fab{position:fixed;top:85%;right:10px;width:var(--fab);height:var(--fab);background:var(--c-glass);color:var(--c-text);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:22px;user-select:none;touch-action:none;border:1px solid var(--c-glass-border);backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);box-shadow:0 6px 24px rgba(0,0,0,.4),var(--c-neon-glow);transition:all .3s var(--ease);z-index:99}
#bm-fab:hover{box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 20px rgba(0,229,255,.3);border-color:var(--c-neon-border);transform:scale(1.06)}
.bm-badge{position:absolute;top:-5px;right:-5px;background:var(--c-red);color:#fff;font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 0 8px rgba(255,77,106,.5)}
#bm-overlay{position:fixed;inset:0;background:var(--c-overlay);display:none;overflow-y:auto;padding:15px;backdrop-filter:blur(12px) saturate(180%);-webkit-backdrop-filter:blur(12px) saturate(180%);color:var(--c-text);text-align:left}
.bm-top{max-width:var(--grid-max);margin:0 auto 12px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0;z-index:100;background:var(--c-glass);backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);padding:12px 16px 8px;border-radius:16px;border:1px solid var(--c-glass-border);box-shadow:0 8px 32px rgba(0,0,0,.2)}
.bm-bar{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;width:100%;align-items:center}
.bm-search{max-width:180px;padding:8px 14px!important;font-size:13px!important;margin:0!important;background:rgba(255,255,255,.04)!important;border:1px solid var(--c-glass-border)!important;border-radius:var(--r)!important;color:var(--c-text)!important;transition:all .2s var(--ease)!important}
.bm-search:focus{border-color:var(--c-neon-border)!important;box-shadow:0 0 12px rgba(0,229,255,.15)!important;background:rgba(255,255,255,.06)!important}
.bm-search::placeholder{color:var(--c-text-muted)!important}
.bm-tabs{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;width:100%}
.bm-tab{padding:8px 16px;background:rgba(255,255,255,.04);border-radius:var(--r);cursor:pointer;font-size:12px;font-weight:600;color:var(--c-text-dim);white-space:nowrap;flex-shrink:0;user-select:none;border:1px solid transparent;transition:all .2s var(--ease);letter-spacing:.3px}
.bm-tab:hover{background:rgba(255,255,255,.08);color:var(--c-text)}
.bm-tab.active{background:var(--c-neon-dim);color:var(--c-neon);border-color:var(--c-neon-border);box-shadow:0 0 10px rgba(0,229,255,.1)}
button{outline:0;border:0;font-family:var(--f)}
.bm-btn,.bm-mgr-btn{font-size:11px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.bm-btn{padding:8px 12px;color:#fff;background:var(--c-surface);border-radius:var(--r);border:1px solid var(--c-glass-border);transition:all .15s var(--ease);font-weight:500}
.bm-btn:hover{background:var(--c-glass-hover);border-color:var(--c-glass-border-hover);transform:translateY(-1px)}
.bm-btn:active{transform:scale(.97)}
.bm-btn-blue{background:rgba(0,229,255,.15);border-color:var(--c-neon-border);color:var(--c-neon)}
.bm-btn-blue:hover{background:rgba(0,229,255,.25);box-shadow:var(--c-neon-glow)}
.bm-btn-green{background:rgba(76,255,141,.12);border-color:rgba(76,255,141,.25);color:var(--c-success)}
.bm-btn-green:hover{background:rgba(76,255,141,.22);box-shadow:0 0 12px rgba(76,255,141,.2)}
.bm-btn-red{background:rgba(255,77,106,.12);border-color:rgba(255,77,106,.25);color:var(--c-red)}
.bm-btn-red:hover{background:rgba(255,77,106,.22)}
.bm-icon-btn{width:36px;height:36px;font-size:16px;border-radius:var(--r);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;background:rgba(255,255,255,.04);border:1px solid var(--c-glass-border);color:var(--c-text);transition:all .2s var(--ease);backdrop-filter:blur(8px)}
.bm-icon-btn:hover{background:rgba(255,255,255,.10);border-color:var(--c-glass-border-hover);transform:scale(1.08)}
.bm-icon-btn:active{transform:scale(.95)}
input{width:100%;padding:10px 14px;margin:5px 0;border:1px solid var(--c-glass-border);background:rgba(255,255,255,.04);color:var(--c-text);border-radius:var(--r);font-size:14px;transition:all .2s var(--ease)}
input:focus{border-color:var(--c-neon-border);box-shadow:0 0 12px rgba(0,229,255,.12);outline:none;background:rgba(255,255,255,.06)}
label{display:block;font-size:11px;font-weight:600;color:var(--c-text-dim);margin-top:10px;letter-spacing:.5px;text-transform:uppercase}
.bm-ctr{display:grid;grid-template-columns:repeat(auto-fit,minmax(var(--grid-min),1fr));gap:16px;max-width:var(--grid-max);margin:0 auto}
.bm-sec{background:var(--c-glass);border:1px solid var(--c-glass-border);border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.15);transition:all .3s var(--ease);animation:bm-sec-in .4s var(--ease) both;animation-delay:var(--sec-delay,0s)}
@keyframes bm-sec-in{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
.bm-sec:hover{border-color:var(--c-glass-border-hover);box-shadow:0 8px 32px rgba(0,0,0,.2)}
.bm-sec-hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:rgba(255,255,255,.02);position:relative;gap:8px;border-bottom:1px solid var(--c-glass-border)}
.bm-sec-hdr::after{content:'';position:absolute;bottom:0;left:0;height:2px;background:linear-gradient(90deg,var(--c-neon),transparent);width:var(--fill,0%);transition:width .5s var(--ease);opacity:.7}
.bm-gcnt{font-weight:400;font-size:11px;color:var(--c-text-dim);background:rgba(255,255,255,.05);padding:2px 8px;border-radius:20px;font-family:var(--f-mono)}
.bm-gwarn{color:var(--c-amber);font-size:12px}
.bm-mgr-btn{border:1px solid var(--c-glass-border);background:rgba(255,255,255,.04);color:var(--c-text-dim);padding:5px 12px;border-radius:var(--r);font-weight:600;font-size:11px;transition:all .15s var(--ease)}
.bm-mgr-btn:hover{background:rgba(255,255,255,.08);color:var(--c-text);border-color:var(--c-glass-border-hover)}
.bm-qadd{width:30px;height:30px;border-radius:50%;border:1px dashed var(--c-neon-border);background:transparent;color:var(--c-neon);font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:auto;margin-right:8px;transition:all .2s var(--ease)}
.bm-qadd:hover{background:var(--c-neon-dim);box-shadow:var(--c-neon-glow);transform:scale(1.1)}
.bm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--item-min),1fr));gap:14px;padding:16px;min-height:60px;justify-items:center}
.bm-wrap{display:flex;flex-direction:column;align-items:center;text-decoration:none;color:inherit;width:100%;max-width:80px}
.bm-item{display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;padding:8px 4px;border-radius:var(--r);transition:all .2s var(--ease)}
.bm-item:hover{background:rgba(255,255,255,.06);transform:translateY(-3px) scale(1.02);box-shadow:0 4px 16px rgba(0,0,0,.15)}
.bm-item img{width:var(--icon);height:var(--icon);margin-bottom:6px;border-radius:var(--r);background:rgba(255,255,255,.05);object-fit:contain;transition:transform .2s var(--ease-spring)}
.bm-item:hover img{transform:scale(1.1)}
.bm-item span{font-size:11px;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--c-text-dim);transition:color .2s}
.bm-item:hover span{color:var(--c-text)}
.bm-empty{grid-column:1/-1;text-align:center;color:var(--c-text-muted);font-size:12px;padding:30px;border:2px dashed var(--c-glass-border);border-radius:var(--r)}
.sort-active .bm-grid{opacity:.4;pointer-events:none;filter:grayscale(50%)}
.sort-active .bm-sec{border:2px dashed var(--c-neon);cursor:move}
.bm-grid .sortable-ghost{opacity:.3;background:var(--c-neon-dim);border-radius:var(--r)}
dialog.bm-modal-bg{background:transparent;border:0;padding:0;margin:auto;max-width:100vw;max-height:100vh}
dialog.bm-modal-bg::backdrop{background:rgba(0,0,0,.55);backdrop-filter:blur(8px)}
.bm-modal-content{background:var(--c-surface);padding:25px;border-radius:18px;width:100%;max-width:min(420px,calc(100vw - 32px));max-height:85vh;overflow-y:auto;border:1px solid var(--c-glass-border);box-shadow:0 20px 60px rgba(0,0,0,.4),0 0 0 1px rgba(255,255,255,.03) inset;backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);animation:bm-modal-in .35s var(--ease-spring)}
@keyframes bm-modal-in{from{opacity:0;transform:scale(.9) translateY(20px)}to{opacity:1;transform:none}}
.bm-modal-content h3{font-size:16px;font-weight:700;background:linear-gradient(135deg,var(--c-neon),var(--c-purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.bm-ctx,.bm-admin-menu{background:var(--c-glass);border:1px solid var(--c-glass-border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.3);min-width:150px;overflow:hidden;backdrop-filter:var(--c-glass-blur);-webkit-backdrop-filter:var(--c-glass-blur);animation:bm-ctx-in .2s var(--ease)}
@keyframes bm-ctx-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:none}}
.bm-ctx-item,.bm-admin-item{padding:11px 16px;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px;transition:background .15s;color:var(--c-text)}
.bm-ctx-item:hover,.bm-admin-item:hover{background:rgba(255,255,255,.06)}
.ctx-danger{color:var(--c-red)}
.bm-gsr{background:var(--c-glass);border:1px solid var(--c-neon-border);border-radius:14px;box-shadow:0 4px 20px rgba(0,229,255,.1);overflow:hidden}
.e-r{border-bottom:1px solid var(--c-glass-border);padding:10px 0;display:flex;gap:10px;align-items:center;animation:bm-sec-in .25s var(--ease) both}
.tab-row{display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--c-glass-border);gap:10px}
.bm-drag-handle{cursor:grab;font-size:18px;margin-right:10px;color:var(--c-text-muted);transition:color .2s}
.bm-drag-handle:hover{color:var(--c-neon)}
.bm-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(16px);background:var(--c-glass);color:var(--c-text);padding:12px 28px;border-radius:var(--r);font-size:13px;font-weight:500;opacity:0;transition:all .3s var(--ease-spring);pointer-events:none;z-index:999999;border:1px solid var(--c-glass-border);backdrop-filter:blur(20px) saturate(200%);-webkit-backdrop-filter:blur(20px) saturate(200%);box-shadow:0 8px 32px rgba(0,0,0,.3)}
.bm-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bm-hint{max-width:var(--grid-max);margin:24px auto 12px;text-align:center;font-size:11px;color:var(--c-text-muted);font-family:var(--f-mono);letter-spacing:.3px}
.bm-flex-row{display:flex;gap:10px;align-items:center}
.bm-flex-col{display:flex;flex-direction:column;gap:5px}
.bm-mt-10{margin-top:10px}.bm-mt-20{margin-top:20px}
.bm-scroll-list{max-height:40vh;overflow-y:auto;border:1px solid var(--c-glass-border);border-radius:var(--r);padding:10px;scrollbar-width:thin;scrollbar-color:var(--c-neon-border) transparent}
.bm-scroll-list::-webkit-scrollbar{width:4px}
.bm-scroll-list::-webkit-scrollbar-thumb{background:var(--c-neon-border);border-radius:2px}
#bm-swipe{position:fixed;width:32px;height:32px;background:var(--c-glass);border:1px solid var(--c-neon-border);color:var(--c-neon);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;pointer-events:none;z-index:999999;backdrop-filter:blur(12px);box-shadow:var(--c-neon-glow)}
.bm-wrap.kb-focus .bm-item{background:var(--c-neon-soft);outline:2px solid var(--c-neon-border);outline-offset:-2px}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation-duration:.01ms!important}}
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

        cleanCol();

        const st = { t: 0, r: false, d: false, sx: 0, sy: 0, ox: 0, oy: 0, lx: 0, ly: 0, tp: 0 };

        fab.onpointerdown = e => {
            fab.setPointerCapture(e.pointerId);
            st.sx = st.lx = e.clientX; st.sy = st.ly = e.clientY;
            const r = fab.getBoundingClientRect();
            st.ox = e.clientX - r.left; st.oy = e.clientY - r.top;
            st.r = st.d = false;
            st.t = setTimeout(() => {
                st.r = true; fab.style.willChange = 'transform,left,top';
                fab.style.cursor = 'grabbing'; fab.style.boxShadow = '0 6px 20px rgba(0,0,0,.5)';
            }, 500);
        };

        fab.onpointermove = e => {
            st.lx = e.clientX; st.ly = e.clientY;
            if (!st.r) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) clearTimeout(st.t);
                const dy = st.sy - e.clientY;
                let h = shadow.querySelector('#bm-swipe');
                if (dy > 20 && Math.abs(e.clientX - st.sx) < 40) {
                    if (!h) shadow.append(h = $('div', { id: 'bm-swipe', text: '＋' }));
                    const r = fab.getBoundingClientRect();
                    h.style.left = (r.left + r.width / 2 - 16) + 'px';
                    h.style.top = (r.top - 42) + 'px';
                    h.style.opacity = String(Math.min(1, (dy - 20) / 30));
                } else { h?.remove(); }
                return;
            }
            st.d = true; fab.style.transition = 'none';
            fab.style.left = Math.max(0, Math.min(innerWidth - 48, e.clientX - st.ox)) + 'px';
            fab.style.top = Math.max(0, Math.min(innerHeight - 48, e.clientY - st.oy)) + 'px';
            fab.style.right = fab.style.bottom = 'auto';
        };

        fab.onpointerup = e => {
            clearTimeout(st.t);
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe')?.remove();
            if (st.d) {
                fab.style.transition = ''; fab.style.bottom = 'auto'; fab.style.willChange = '';
                const s = fab.getBoundingClientRect().left + 24 > innerWidth / 2;
                fab.style.left = s ? 'auto' : '15px'; fab.style.right = s ? '15px' : 'auto';
                st.d = st.r = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = ''; st.tp = 0; return;
            }
            if (st.r) { st.r = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = fab.style.willChange = ''; st.tp = 0; return; }
            if (st.sy - st.ly > 50 && Math.abs(st.lx - st.sx) < 40) { st.tp = 0; showQuickAdd(); return; }
            const n = Date.now();
            if (n - st.tp < 350) { st.tp = 0; showQuickAdd(); }
            else { st.tp = n; setTimeout(() => { if (st.tp && Date.now() - st.tp >= 340) { st.tp = 0; toggle(ov, fab); } }, 350); }
        };

        fab.oncontextmenu = e => e.preventDefault();

        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') { e.preventDefault(); toggle(ov, fab); }
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); showQuickAdd(); }
            if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ' && _isOpen && !shadow.querySelector('dialog[open]')) {
                e.preventDefault(); popUndo() || toast('되돌릴 내역 없음');
            }
            if (e.key === 'Escape' && _isOpen && !shadow.querySelector('dialog[open]')) { e.preventDefault(); toggle(ov, fab); }
            if (e.key === '/' && _isOpen && !shadow.querySelector('dialog[open]')) {
                const s = shadow.querySelector('.bm-search');
                if (s && document.activeElement !== s) { e.preventDefault(); s.focus(); }
            }
        });

        ov.onkeydown = e => {
            if (e.key === '/' && !shadow.querySelector('.bm-search:focus')) {
                e.preventDefault(); shadow.querySelector('.bm-search')?.focus(); return;
            }
            const gsr = shadow.querySelector('.bm-gsr'); if (!gsr) return;
            const items = gsr.querySelectorAll('.bm-wrap'); if (!items.length) return;
            let curr = gsr.querySelector('.bm-wrap.kb-focus');
            let idx = curr ? [...items].indexOf(curr) : -1;
            if (e.key === 'ArrowDown') {
                e.preventDefault(); curr?.classList.remove('kb-focus');
                idx = Math.min(idx + 1, items.length - 1);
                items[idx].classList.add('kb-focus'); items[idx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'ArrowUp') {
                e.preventDefault(); curr?.classList.remove('kb-focus');
                idx = Math.max(idx - 1, 0);
                items[idx].classList.add('kb-focus'); items[idx].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter' && curr) {
                e.preventDefault(); window.open(curr.href, '_blank');
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) saveNow();
            else if (_isOpen) { refreshDB(); rerender(); }
            else updateFab();
        });
        window.addEventListener('pagehide', saveNow);
        window.addEventListener('beforeunload', saveNow);

        updateFab();
    }

    init();
})();

===
이거 맞어? 왜 이리 짧아졌지?
