// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v20.0)
// @version      20.0
// @description  v19.4 기반 – 동기화 수정, 코드 최적화
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
       유틸
       ═══════════════════════════════════ */
    const $ = (tag, attrs = {}, children = []) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'cls') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k[0] === 'o' && k[1] === 'n' && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        }
        for (const c of [children].flat()) if (c != null) e.append(c);
        return e;
    };

    const btn = (text, cls = '', onclick = null, style = {}) =>
        $('button', { cls: `bm-btn ${cls}`.trim(), text, onclick, style });

    const iconBtn = (icon, title, cls, onclick) =>
        $('button', { cls: `bm-icon-btn ${cls}`.trim(), text: icon, title, onclick });

    const isUrl = s => { try { return /^https?:/.test(new URL(s).protocol); } catch { return false; } };

    const escHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

    const MAX_NAME = 30;
    const BAD_CHARS = /[::\/\\<>"|?*]/;

    function vName(name, existing = []) {
        if (!name?.trim()) return '이름을 입력하세요.';
        const t = name.trim();
        if (t.length > MAX_NAME) return `이름은 ${MAX_NAME}자 이하여야 합니다.`;
        if (BAD_CHARS.test(t)) return '사용할 수 없는 문자가 포함되어 있습니다.';
        if (existing.includes(t)) return '이미 존재하는 이름입니다.';
        return null;
    }

    const TRACK_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','mc_eid','_ga'];
    function cleanUrl(s) {
        try {
            const u = new URL(s);
            let c = false;
            for (const p of TRACK_PARAMS) if (u.searchParams.has(p)) { u.searchParams.delete(p); c = true; }
            return c ? u.toString() : s;
        } catch { return s; }
    }

    function pathContains(ev, el) { try { return ev.composedPath().includes(el); } catch { return false; } }

    /* ═══════════════════════════════════
       DB 헬퍼
       ═══════════════════════════════════ */
    function forEachItem(cb) {
        for (const [p, groups] of Object.entries(db.pages))
            for (const [g, items] of Object.entries(groups))
                for (const item of items) if (cb(item, p, g) === false) return;
    }

    function validateDB(d) {
        if (!d?.pages || typeof d.pages !== 'object' || !d.currentPage || !d.pages[d.currentPage]) return false;
        for (const groups of Object.values(d.pages)) {
            if (typeof groups !== 'object') return false;
            for (const items of Object.values(groups)) {
                if (!Array.isArray(items)) return false;
                for (const it of items) if (typeof it.name !== 'string' || typeof it.url !== 'string') return false;
            }
        }
        return true;
    }

    /* ── URL 중복 Set ── */
    let _urls = null;
    const rebuildUrls = () => { _urls = new Set(); forEachItem(it => _urls.add(it.url)); };
    const isDup = url => { if (!_urls) rebuildUrls(); return _urls.has(url); };
    const addUrl = url => _urls?.add(url);
    const delUrl = url => {
        if (!_urls) return;
        let found = false;
        forEachItem(it => { if (it.url === url) { found = true; return false; } });
        if (!found) _urls.delete(url);
    };
    function findLocs(url) {
        if (!isDup(url)) return [];
        const r = [];
        forEachItem((it, p, g) => { if (it.url === url) r.push(`${p} > ${g}`); });
        return r;
    }

    /* ═══════════════════════════════════
       DB 로드 — ★ 핵심 수정: refreshDB 함수 추가
       ═══════════════════════════════════ */
    function loadDB() {
        let raw = GM_getValue('bm_db_v2', null);
        if (!raw || !validateDB(raw)) {
            const bak = GM_getValue('bm_db_v2_backup', null);
            if (bak && validateDB(bak)) { raw = structuredClone(bak); console.warn('[북마크] 백업 복구'); }
            else { raw = { currentPage: "기본", pages: { "기본": { "북마크": [] } } }; console.warn('[북마크] DB 초기화'); }
        }
        return raw;
    }

    let db = loadDB();

    /** ★ 수정 1: 다른 탭에서 변경된 데이터를 다시 읽어옴 */
    function refreshDB() {
        const fresh = GM_getValue('bm_db_v2', null);
        if (fresh && validateDB(fresh)) {
            db = fresh;
            _urls = null;
            return true;
        }
        return false;
    }

    /* ═══════════════════════════════════
       Undo
       ═══════════════════════════════════ */
    const _undo = [];
    function pushUndo() {
        try { _undo.push(structuredClone(db)); if (_undo.length > 5) _undo.shift(); }
        catch { _undo.length = 0; toast('⚠ 스냅샷 실패'); }
    }
    function popUndo() {
        if (!_undo.length) return false;
        db = _undo.pop(); _urls = null;
        saveNow(); rerender(); toast('↩ 되돌리기 완료');
        return true;
    }

    /* ═══════════════════════════════════
       저장 — ★ 핵심 수정: 즉시 저장 + 안전 디바운스
       ═══════════════════════════════════ */
    let _saveTimer = null;
    let _lastBackup = GM_getValue('bm_last_backup_time', 0);
    const BACKUP_INTERVAL = 3600000;

    function doBackup() {
        if (Date.now() - _lastBackup > BACKUP_INTERVAL) {
            GM_setValue('bm_db_v2_backup', structuredClone(db));
            _lastBackup = Date.now();
            GM_setValue('bm_last_backup_time', _lastBackup);
        }
    }

    /** ★ 수정 2: 모든 변경에서 즉시 저장 */
    function saveNow() {
        clearTimeout(_saveTimer);
        try { GM_setValue('bm_db_v2', db); doBackup(); }
        catch (e) { console.error('[북마크] 저장 실패:', e); toast('❌ 저장 실패!'); }
    }

    /** 디바운스 저장은 빈번한 자동 호출에만 사용 (Sortable 드래그 중 등) */
    function saveLazy() {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(saveNow, 200);
    }

    const curPage = () => db.pages[db.currentPage];
    let isSortMode = false;

    /* ═══════════════════════════════════
       접기/펼치기
       ═══════════════════════════════════ */
    let _collapsed;
    try { const r = JSON.parse(GM_getValue('bm_collapsed', '[]')); _collapsed = new Set(Array.isArray(r) ? r : []); }
    catch { _collapsed = new Set(); }
    const colKey = g => `${db.currentPage}::${g}`;
    function toggleCol(g) {
        const k = colKey(g);
        _collapsed.has(k) ? _collapsed.delete(k) : _collapsed.add(k);
        GM_setValue('bm_collapsed', [..._collapsed]);
    }

    /* ═══════════════════════════════════
       최근 그룹 / 도메인 추천
       ═══════════════════════════════════ */
    const setRecent = (p, g) => GM_setValue('bm_recent', JSON.stringify({ page: p, group: g, ts: Date.now() }));
    const getRecent = () => { try { return JSON.parse(GM_getValue('bm_recent', 'null')); } catch { return null; } };

    function suggestGroup(url) {
        try {
            const h = new URL(url).hostname, counts = {};
            for (const [g, items] of Object.entries(curPage()))
                for (const it of items) try { if (new URL(it.url).hostname === h) counts[g] = (counts[g] || 0) + 1; } catch {}
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            return top[0]?.[0] ?? null;
        } catch { return null; }
    }

    /* ═══════════════════════════════════
       파비콘
       ═══════════════════════════════════ */
    const FALLBACK_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";
    const _iconCache = new Map();

    function gmFetch(url, timeout = 5000) {
        return new Promise(r => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'blob', timeout,
                onload: res => r(res.status === 200 && res.response?.size > 100 ? res.response : null),
                onerror: () => r(null), ontimeout: () => r(null)
            });
        });
    }

    function toB64(blob) {
        return new Promise(r => {
            const fr = new FileReader();
            fr.onloadend = () => r(fr.result || FALLBACK_ICON);
            fr.onerror = () => r(FALLBACK_ICON);
            fr.readAsDataURL(blob);
        });
    }

    async function fetchIcon(url) {
        try {
            const h = new URL(url).hostname;
            if (_iconCache.has(h)) return _iconCache.get(h);
            const blob = await gmFetch(`https://icon.horse/icon/${h}`, 3000) || await gmFetch(`https://www.google.com/s2/favicons?domain=${h}&sz=128`, 4000);
            const result = blob ? await toB64(blob) : FALLBACK_ICON;
            if (_iconCache.size >= 200) _iconCache.delete(_iconCache.keys().next().value);
            _iconCache.set(h, result);
            return result;
        } catch { return FALLBACK_ICON; }
    }

    /* ── lazy load observer ── */
    let _iconObs = null;
    function getIconObs(root) {
        if (_iconObs) return _iconObs;
        _iconObs = new IntersectionObserver(entries => {
            for (const e of entries) if (e.isIntersecting) {
                const img = e.target;
                if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
                _iconObs.unobserve(img);
            }
        }, { root, rootMargin: '200px' });
        return _iconObs;
    }

    /* ═══════════════════════════════════
       Shadow DOM / 토스트 / 모달
       ═══════════════════════════════════ */
    let shadow = null;

    function toast(msg, dur = 2000) {
        if (!shadow) return;
        shadow.querySelector('.bm-toast')?.remove();
        const t = $('div', { cls: 'bm-toast', text: msg });
        shadow.appendChild(t);
        requestAnimationFrame(() => t.classList.add('show'));
        setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, dur);
    }

    function modal(id = '', { preventEscape = false, onClose = null } = {}) {
        const d = document.createElement('dialog');
        if (id) d.id = id;
        d.className = 'bm-modal-bg';
        d.addEventListener('click', e => {
            const r = d.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        });
        d.addEventListener('close', () => { onClose?.(); d.isConnected && d.remove(); });
        if (preventEscape) d.addEventListener('cancel', e => e.preventDefault());
        return d;
    }

    function showModal(m) { shadow.appendChild(m); m.showModal(); return m; }

    /* ═══════════════════════════════════
       팝업 닫기 헬퍼
       ═══════════════════════════════════ */
    function popupDismiss(menuEl, ac) {
        setTimeout(() => {
            const handler = ev => { if (!menuEl.contains(ev.target) && !pathContains(ev, menuEl)) { menuEl.remove(); ac.abort(); } };
            shadow.addEventListener('pointerdown', handler, { signal: ac.signal });
            document.addEventListener('pointerdown', ev => {
                if (!pathContains(ev, menuEl)) { menuEl.remove(); ac.abort(); }
            }, { signal: ac.signal, capture: true });
        }, 0);
    }

    /* ═══════════════════════════════════
       아이콘 전체 복구
       ═══════════════════════════════════ */
    async function fixAllIcons() {
        const all = [];
        forEachItem(it => all.push(it));
        if (!all.length) { toast('저장된 북마크가 없습니다.'); return; }
        if (!confirm(`총 ${all.length}개 아이콘을 다시 다운로드합니다. 진행?`)) return;
        let cancelled = false;
        const m = modal('', { preventEscape: true });
        const status = $('div', { text: '아이콘 업데이트 중...' });
        m.appendChild($('div', { cls: 'bm-modal-content', style: { textAlign: 'center' } }, [
            status,
            btn('취소', 'bm-btn-red', () => { cancelled = true; }, { width: '100%', marginTop: '15px', padding: '10px' })
        ]));
        showModal(m);
        _iconCache.clear();
        for (let i = 0; i < all.length; i += 5) {
            if (cancelled) break;
            await Promise.all(all.slice(i, i + 5).map(async it => { if (!cancelled) it.icon = await fetchIcon(it.url); }));
            status.textContent = `아이콘 업데이트 중... ${Math.min(i + 5, all.length)} / ${all.length}`;
        }
        saveNow(); m.close();
        toast(cancelled ? '중단됨 (일부 완료)' : '✅ 아이콘 복구 완료');
        rerender();
    }

    /* ═══════════════════════════════════
       백업 / 복구
       ═══════════════════════════════════ */
    function exportJSON() {
        saveNow();
        const u = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
        $('a', { href: u, download: 'bookmark_backup.json' }).click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    }

    function exportHTML() {
        let h = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
        for (const [pn, groups] of Object.entries(db.pages)) {
            h += `  <DT><H3>${escHtml(pn)}</H3>\n  <DL><p>\n`;
            for (const [gn, items] of Object.entries(groups)) {
                h += `    <DT><H3>${escHtml(gn)}</H3>\n    <DL><p>\n`;
                for (const it of items) h += `      <DT><A HREF="${escHtml(it.url)}">${escHtml(it.name)}</A>\n`;
                h += '    </DL><p>\n';
            }
            h += '  </DL><p>\n';
        }
        h += '</DL><p>';
        const u = URL.createObjectURL(new Blob([h], { type: 'text/html' }));
        $('a', { href: u, download: 'bookmarks.html' }).click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
    }

    function importJSON() {
        const inp = $('input', { type: 'file', accept: '.json' });
        inp.onchange = e => {
            const f = e.target.files[0]; if (!f) return;
            const r = new FileReader();
            r.onload = re => {
                try {
                    const p = JSON.parse(re.target.result);
                    if (!validateDB(p)) { alert('파일 구조 오류'); return; }
                    db = structuredClone(p); _urls = null;
                    saveNow(); rerender(); toast('✅ 복구 완료');
                } catch { alert('잘못된 파일'); }
            };
            r.readAsText(f);
        };
        inp.click();
    }

    /* ═══════════════════════════════════
       아이템 편집 행
       ═══════════════════════════════════ */
    function itemRow({ name = '', url = 'https://', isNew = false } = {}) {
        const row = $('div', { cls: 'e-r', style: { borderBottom: '1px solid var(--c-border)', padding: '10px 0', display: 'flex', gap: '10px', alignItems: 'center' } });
        const ni = $('input', { type: 'text', cls: 'r-n', value: name, placeholder: isNew ? '새 북마크 이름' : '이름', style: { marginBottom: '5px' } });
        const ui = $('input', { type: 'text', cls: 'r-u', value: url, placeholder: 'URL' });
        ui.addEventListener('paste', () => {
            setTimeout(() => {
                if (!isNew || ni.value.trim()) return;
                const u = ui.value.trim();
                if (!isUrl(u)) return;
                GM_xmlhttpRequest({
                    method: 'GET', url: u, timeout: 5000, headers: { Accept: 'text/html' },
                    onload: r => { const m = r.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i); if (m?.[1] && !ni.value.trim()) ni.value = m[1].trim().substring(0, 40); }
                });
            }, 100);
        });
        const body = $('div', { style: { flex: '1' } }, [
            $('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, [
                $('span', { text: '삭제', style: { color: 'red', cursor: 'pointer', fontSize: '11px' }, onclick: () => row.remove() })
            ]),
            ni, ui
        ]);
        row.append($('span', { cls: 'bm-drag-handle', text: '☰' }), body);
        return row;
    }

    /* ═══════════════════════════════════
       롱프레스 / 컨텍스트 메뉴
       ═══════════════════════════════════ */
    function bindLongPress(el, cb) {
        let tid = 0, moved = false, fired = false;
        el.addEventListener('touchstart', e => {
            moved = fired = false;
            tid = setTimeout(() => { if (!moved) { fired = true; const t = e.changedTouches[0]; cb({ clientX: t.clientX, clientY: t.clientY, preventDefault() {} }); } }, 500);
        }, { passive: true });
        el.addEventListener('touchmove', () => { moved = true; clearTimeout(tid); });
        el.addEventListener('touchend', e => { clearTimeout(tid); if (fired) e.preventDefault(); }, { passive: false });
        el.addEventListener('touchcancel', () => clearTimeout(tid));
    }

    let _ctxAC = null;
    function ctxMenu(e, item, gName, idx) {
        e.preventDefault();
        _ctxAC?.abort();
        shadow.querySelector('.bm-ctx')?.remove();
        _ctxAC = new AbortController();
        const ac = _ctxAC;
        const menu = $('div', { cls: 'bm-ctx', style: { position: 'fixed', zIndex: '999999' } });
        const acts = [
            { t: '✏️ 편집', fn: () => showGroupMgr(gName) },
            { t: '📋 URL 복사', fn: () => { navigator.clipboard?.writeText(item.url); toast('📋 URL 복사됨'); } },
            { t: '🗑 삭제', c: 'ctx-danger', fn: () => {
                if (!confirm(`"${item.name}" 삭제?`)) return;
                pushUndo();
                const arr = curPage()[gName];
                const i = (typeof idx === 'number' && arr[idx]?.url === item.url) ? idx : arr.findIndex(x => x.url === item.url && x.name === item.name);
                if (i !== -1) arr.splice(i, 1);
                delUrl(item.url); saveNow(); rerender();
            }}
        ];
        acts.forEach(a => menu.appendChild($('div', { cls: `bm-ctx-item ${a.c || ''}`, text: a.t, onclick: () => { menu.remove(); ac.abort(); a.fn(); } })));
        shadow.appendChild(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
        menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
        popupDismiss(menu, ac);
    }

    /* ═══════════════════════════════════
       Sortable 관리
       ═══════════════════════════════════ */
    let _sortables = [];
    const killSortables = () => { _sortables.forEach(s => s.destroy()); _sortables = []; };

    /* ═══════════════════════════════════
       검색
       ═══════════════════════════════════ */
    function filterItems(q, container) {
        const lq = q.toLowerCase();
        container.querySelectorAll('.bm-sec').forEach(sec => {
            const grid = sec.querySelector('.bm-grid');
            if (!grid) return;
            let vis = false;
            grid.querySelectorAll('.bm-wrap').forEach(w => {
                const match = !lq || (w.querySelector('span')?.textContent.toLowerCase().includes(lq)) || (w.getAttribute('href') || '').toLowerCase().includes(lq);
                w.style.display = match ? '' : 'none';
                if (match) vis = true;
            });
            if (lq) { grid.style.display = vis ? '' : 'none'; sec.style.display = vis ? '' : 'none'; }
            else {
                sec.style.display = '';
                const id = sec.dataset.id;
                if (id) grid.style.display = (!isSortMode && _collapsed.has(colKey(id))) ? 'none' : '';
            }
        });
    }

    function globalSearch(q) {
        if (!q.trim()) return null;
        const lq = q.toLowerCase(), r = [];
        forEachItem((it, p, g) => { if (it.name.toLowerCase().includes(lq) || it.url.toLowerCase().includes(lq)) r.push({ ...it, pn: p, gn: g }); });
        return r;
    }

    function showGlobalResults(results, container) {
        container.querySelector('.bm-gsr')?.remove();
        if (!results?.length) return;
        const sec = $('div', { cls: 'bm-gsr', style: { gridColumn: '1 / -1' } });
        sec.appendChild($('div', { text: `🔍 전체 검색 결과 (${results.length}건)`, style: { fontWeight: 'bold', fontSize: '13px', padding: '10px', background: 'var(--c-bg)', borderRadius: '8px 8px 0 0' } }));
        const grid = $('div', { cls: 'bm-grid' });
        results.slice(0, 50).forEach(r => {
            const w = $('a', { cls: 'bm-wrap', href: r.url, target: '_blank', title: `${r.pn} > ${r.gn}` });
            const d = $('div', { cls: 'bm-item' });
            d.append($('img', { src: r.icon || FALLBACK_ICON, decoding: 'async' }), $('span', { text: r.name }));
            w.appendChild(d); grid.appendChild(w);
        });
        sec.appendChild(grid); container.prepend(sec);
    }

    /* ═══════════════════════════════════
       그룹 섹션 렌더
       ═══════════════════════════════════ */
    function renderSection(gTitle, items, obs, maxN) {
        const sec = $('div', { cls: 'bm-sec', 'data-id': gTitle });
        const collapsed = _collapsed.has(colKey(gTitle));
        const hdr = $('div', { cls: 'bm-sec-hdr' });
        hdr.style.setProperty('--fill', `${(items.length / maxN) * 100}%`);

        const title = $('span', { style: { fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' } });
        title.append(
            document.createTextNode(`${isSortMode ? '≡' : (collapsed ? '▶' : '📁')} ${gTitle} `),
            $('span', { text: `(${items.length})`, cls: 'bm-gcnt' })
        );
        if (items.length >= 50) title.appendChild($('span', { text: '⚠', cls: 'bm-gwarn', title: '아이템이 많아 성능에 영향을 줄 수 있습니다' }));

        title.addEventListener('click', () => {
            if (isSortMode) return;
            toggleCol(gTitle);
            const grid = sec.querySelector('.bm-grid');
            const now = _collapsed.has(colKey(gTitle));
            grid.style.display = now ? 'none' : '';
            title.childNodes[0].textContent = `${now ? '▶' : '📁'} ${gTitle} `;
        });
        hdr.appendChild(title);

        if (!isSortMode) {
            hdr.appendChild($('button', {
                cls: 'bm-qadd', text: '+', title: '현재 페이지를 이 그룹에 추가',
                onclick: async e => {
                    e.stopPropagation();
                    const url = cleanUrl(location.href);
                    if (isDup(url)) { toast('⚠ 이미 저장된 URL'); return; }
                    pushUndo();
                    const icon = await fetchIcon(url);
                    curPage()[gTitle].push({ name: (document.title || url).substring(0, 30), url, icon, addedAt: Date.now() });
                    addUrl(url); setRecent(db.currentPage, gTitle);
                    saveNow(); rerender(); toast(`✅ "${gTitle}"에 추가됨`);
                }
            }));
            hdr.appendChild($('button', { cls: 'bm-mgr-btn', text: '관리' }));
        }
        sec.appendChild(hdr);

        const grid = $('div', { cls: 'bm-grid', 'data-group': gTitle, style: collapsed && !isSortMode ? { display: 'none' } : {} });
        if (!items.length && !isSortMode) {
            grid.appendChild($('div', { cls: 'bm-empty' }, [
                $('div', { text: '📎', style: { fontSize: '24px', marginBottom: '8px', opacity: '0.5' } }),
                $('div', { text: '헤더의 + 버튼 또는 URL을 여기에 드래그하세요' })
            ]));
        }

        items.forEach((item, idx) => {
            const w = $('a', { cls: 'bm-wrap', href: item.url, target: '_blank' });
            if (item.addedAt) w.title = `추가: ${new Date(item.addedAt).toLocaleDateString()}`;
            w.addEventListener('contextmenu', e => ctxMenu(e, item, gTitle, idx));
            bindLongPress(w, e => ctxMenu(e, item, gTitle, idx));
            const d = $('div', { cls: 'bm-item' });
            const img = $('img', { decoding: 'async' });
            const src = item.icon?.startsWith('data:') ? item.icon : FALLBACK_ICON;
            if (src === FALLBACK_ICON) { img.src = FALLBACK_ICON; }
            else { img.src = FALLBACK_ICON; img.dataset.src = src; obs.observe(img); }
            d.append(img, $('span', { text: item.name }));
            w.appendChild(d); grid.appendChild(w);
        });
        sec.appendChild(grid);
        return sec;
    }

    /* ═══════════════════════════════════
       더보기 메뉴
       ═══════════════════════════════════ */
    let _adminAC = null;
    function showAdminMenu(anchor, page) {
        _adminAC?.abort();
        shadow.querySelector('.bm-admin-menu')?.remove();
        _adminAC = new AbortController();
        const ac = _adminAC;
        const menu = $('div', { cls: 'bm-admin-menu' });
        const items = [
            { i: '🔄', t: '아이콘 복구', fn: fixAllIcons },
            { i: '📂', t: '탭 관리', fn: showTabMgr },
            { i: '🗂', t: '전체 접기/펼치기', fn: () => {
                const keys = Object.keys(page).map(colKey);
                const allCol = keys.every(k => _collapsed.has(k));
                keys.forEach(k => allCol ? _collapsed.delete(k) : _collapsed.add(k));
                GM_setValue('bm_collapsed', [..._collapsed]); rerender();
            }},
            { i: '💾', t: '백업 (JSON)', fn: exportJSON },
            { i: '📄', t: '백업 (HTML)', fn: exportHTML },
            { i: '📥', t: '복구', fn: importJSON },
        ];
        items.forEach(a => menu.appendChild($('div', {
            cls: 'bm-admin-item', text: `${a.i} ${a.t}`,
            onclick: () => { menu.remove(); ac.abort(); a.fn(); }
        })));
        shadow.appendChild(menu);
        const r = anchor.getBoundingClientRect();
        Object.assign(menu.style, { position: 'fixed', top: (r.bottom + 4) + 'px', right: (innerWidth - r.right) + 'px', zIndex: '999999' });
        popupDismiss(menu, ac);
    }

    /* ═══════════════════════════════════
       대시보드
       ═══════════════════════════════════ */
    let _searchTimer = null, _container = null, _switching = false;

    function rerender() {
        const overlay = shadow?.querySelector('#bm-overlay');
        if (overlay?.style.display === 'block') renderDash();
    }

    function switchTab(p) {
        if (_switching || p === db.currentPage) return;
        _switching = true;
        saveNow(); db.currentPage = p; isSortMode = false;
        renderDash(); _switching = false;
    }

    function renderDash() {
        const overlay = shadow.querySelector('#bm-overlay');
        if (!overlay) return;
        _ctxAC?.abort(); _ctxAC = null;
        _adminAC?.abort(); _adminAC = null;
        _iconObs = getIconObs(overlay);
        overlay.className = isSortMode ? 'sort-active' : '';
        overlay.replaceChildren();

        const page = curPage();
        const frag = document.createDocumentFragment();

        /* 상단 */
        const top = $('div', { cls: 'bm-top' });

        /* 탭 */
        const tabs = $('div', { cls: 'bm-tabs' });
        for (const p of Object.keys(db.pages)) {
            let n = 0;
            for (const arr of Object.values(db.pages[p])) n += arr.length;
            const t = $('div', { cls: `bm-tab ${db.currentPage === p ? 'active' : ''}`, text: `${p} (${n})`, 'data-page': p });
            let sx = 0, sy = 0, moved = false;
            t.addEventListener('touchstart', e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; moved = false; }, { passive: true });
            t.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientX - sx) > 8 || Math.abs(e.touches[0].clientY - sy) > 8) moved = true; }, { passive: true });
            t.addEventListener('touchend', e => { if (!moved) { e.preventDefault(); switchTab(p); } }, { passive: false });
            t.addEventListener('click', () => switchTab(p));
            tabs.appendChild(t);
        }

        let total = 0;
        for (const arr of Object.values(page)) total += arr.length;

        /* 관리 바 */
        const bar = $('div', { cls: 'bm-bar' });
        const si = $('input', {
            type: 'search', placeholder: '검색...', cls: 'bm-search',
            oninput: () => {
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(() => {
                    const q = si.value;
                    filterItems(q, _container ?? shadow);
                    if (q.trim().length >= 2 && _container) showGlobalResults(globalSearch(q), _container);
                    else _container?.querySelector('.bm-gsr')?.remove();
                }, 150);
            }
        });

        const moreBtn = iconBtn('⋯', '더보기', '', null);
        moreBtn.addEventListener('click', e => { e.stopPropagation(); showAdminMenu(moreBtn, page); });

        bar.append(
            si,
            $('span', { text: `${total}개`, style: { fontSize: '12px', color: '#999', marginRight: 'auto' } }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', () => showQuickAdd()),
            iconBtn(isSortMode ? '✅' : '↕️', isSortMode ? '정렬 완료' : '그룹 정렬', 'bm-btn-blue', () => {
                isSortMode = !isSortMode;
                const s = _container?.parentElement?.querySelector('.bm-search');
                if (s) s.value = '';
                renderDash();
            }),
            iconBtn('➕', '새 그룹', '', () => {
                const n = prompt("새 그룹 이름:");
                const err = vName(n, Object.keys(page));
                if (err) { if (n) alert(err); return; }
                page[n.trim()] = []; saveNow(); renderDash();
            }),
            moreBtn
        );

        top.append(tabs, bar);
        frag.appendChild(top);

        /* 컨테이너 */
        const ctr = $('div', {
            cls: 'bm-ctr',
            onclick: e => { const b = e.target.closest('.bm-mgr-btn'); if (b) { const s = b.closest('.bm-sec'); if (s) showGroupMgr(s.dataset.id); } }
        });
        _container = ctr;

        /* 드래그 앤 드롭 */
        ctr.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; ctr.style.outline = '2px dashed var(--c-primary)'; });
        ctr.addEventListener('dragleave', () => { ctr.style.outline = ''; });
        ctr.addEventListener('drop', async e => {
            e.preventDefault(); ctr.style.outline = '';
            const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (!raw || !isUrl(raw.trim())) return;
            const url = cleanUrl(raw.trim());
            if (isDup(url)) { toast('⚠ 이미 저장된 URL'); return; }
            const gName = e.target.closest('.bm-grid')?.dataset.group || Object.keys(curPage())[0];
            if (!gName) { toast('⚠ 그룹이 없습니다'); return; }
            let name = url;
            try {
                const res = await new Promise(r => GM_xmlhttpRequest({ method: 'GET', url, timeout: 5000, headers: { Accept: 'text/html' }, onload: r, onerror: () => r(null) }));
                const m = res?.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (m?.[1]) name = m[1].trim().substring(0, 30);
            } catch {}
            const icon = await fetchIcon(url);
            pushUndo();
            curPage()[gName].push({ name, url, icon, addedAt: Date.now() });
            addUrl(url); saveNow(); renderDash(); toast(`✅ "${gName}"에 추가됨`);
        });

        const maxN = Math.max(...Object.values(page).map(a => a.length), 1);
        for (const [g, items] of Object.entries(page)) ctr.appendChild(renderSection(g, items, _iconObs, maxN));

        frag.appendChild(ctr);
        overlay.appendChild(frag);

        overlay.appendChild($('div', { cls: 'bm-hint', text: 'Ctrl+Shift+B: 대시보드 | Ctrl+Shift+D: 빠른추가 | Ctrl+Z: 되돌리기 | ESC: 닫기' }));

        killSortables();

        /* 탭 정렬 */
        if (Object.keys(db.pages).length > 1) {
            _sortables.push(new Sortable(tabs, {
                animation: 150, direction: 'horizontal', draggable: '.bm-tab', delay: 300, delayOnTouchOnly: true,
                onEnd: () => {
                    const o = {};
                    tabs.querySelectorAll('.bm-tab').forEach(t => { const p = t.dataset.page; if (db.pages[p]) o[p] = db.pages[p]; });
                    db.pages = o; saveNow();
                }
            }));
        }

        if (isSortMode) {
            _sortables.push(new Sortable(ctr, {
                animation: 150, handle: '.bm-sec-hdr', draggable: '.bm-sec',
                onEnd: () => {
                    pushUndo();
                    const o = {};
                    ctr.querySelectorAll('.bm-sec').forEach(s => { const id = s.dataset.id; if (page[id]) o[id] = page[id]; });
                    db.pages[db.currentPage] = o; saveNow();
                }
            }));
        } else {
            ctr.querySelectorAll('.bm-grid').forEach(grid => {
                if (grid.style.display === 'none') return;
                _sortables.push(new Sortable(grid, {
                    group: 'bm-items', animation: 150, delay: 300, delayOnTouchOnly: true,
                    onEnd: evt => {
                        pushUndo();
                        const p = curPage(), iconMap = new Map();
                        for (const arr of Object.values(p)) for (const it of arr) iconMap.set(`${it.url}|${it.name}`, it.icon);
                        const rebuild = g => {
                            p[g.dataset.group] = [...g.querySelectorAll('.bm-wrap')].map(w => ({
                                name: w.querySelector('span')?.textContent || '',
                                url: w.getAttribute('href') || '',
                                icon: iconMap.get(`${w.getAttribute('href') || ''}|${w.querySelector('span')?.textContent || ''}`) || FALLBACK_ICON,
                                addedAt: Date.now()
                            }));
                        };
                        rebuild(evt.from);
                        if (evt.from !== evt.to) rebuild(evt.to);
                        _urls = null; saveNow();
                    }
                }));
            });
        }
    }

    /* ═══════════════════════════════════
       그룹 관리
       ═══════════════════════════════════ */
    async function saveGroupEdits(gTitle, nameInput, listEl, oldItems, m) {
        const nn = nameInput.value.trim();
        if (!nn) { alert('그룹 이름을 입력하세요.'); return; }
        const items = [];
        let bad = false;
        for (const row of listEl.querySelectorAll('.e-r')) {
            const n = row.querySelector('.r-n').value.trim(), u = row.querySelector('.r-u').value.trim();
            if (!n || !u) continue;
            if (!isUrl(u)) { bad = true; continue; }
            items.push({ name: n, url: u });
        }
        if (bad && !confirm('유효하지 않은 URL은 제외됩니다. 계속?')) return;
        pushUndo();
        for (const it of items) {
            const old = oldItems.find(o => o.url === it.url);
            it.icon = old?.icon || await fetchIcon(it.url);
            it.addedAt = old?.addedAt || Date.now();
        }
        const page = curPage();
        if (nn !== gTitle) {
            if (page[nn]) { alert('이미 존재하는 그룹 이름입니다.'); return; }
            const oldK = colKey(gTitle), wasCol = _collapsed.has(oldK);
            const rebuilt = {};
            for (const k of Object.keys(page)) rebuilt[k === gTitle ? nn : k] = k === gTitle ? items : page[k];
            db.pages[db.currentPage] = rebuilt;
            _collapsed.delete(oldK);
            if (wasCol) _collapsed.add(colKey(nn));
            GM_setValue('bm_collapsed', [..._collapsed]);
        } else {
            page[gTitle] = items;
        }
        _urls = null; saveNow(); rerender(); m.close();
    }

    function showGroupMgr(gTitle) {
        const items = curPage()[gTitle]; if (!items) return;
        let sortInst = null;
        const m = modal('', { onClose: () => sortInst?.destroy() });
        const c = $('div', { cls: 'bm-modal-content' });
        c.append($('h3', { text: '🛠 그룹 관리', style: { marginTop: '0' } }), $('label', { text: '그룹 이름' }));
        const ni = $('input', { type: 'text', value: gTitle });
        const list = $('div', { cls: 'bm-scroll-list bm-mt-10' });
        if (!items.length) list.appendChild($('div', { text: '북마크가 없습니다.', style: { color: '#999', fontSize: '13px', textAlign: 'center', padding: '20px' } }));
        items.forEach(it => list.appendChild(itemRow({ name: it.name, url: it.url })));
        c.append(ni, list,
            btn('+ 북마크 추가', 'bm-btn-blue', () => { list.appendChild(itemRow({ isNew: true })); list.scrollTop = list.scrollHeight; }, { width: '100%', marginTop: '10px', padding: '10px' }),
            btn('📌 현재 페이지 추가', 'bm-btn-green', () => { list.appendChild(itemRow({ name: document.title.substring(0, 30), url: location.href })); list.scrollTop = list.scrollHeight; }, { width: '100%', marginTop: '5px', padding: '10px' })
        );
        const btns = $('div', { cls: 'bm-flex-row bm-mt-20' });
        btns.append(
            btn('저장', 'bm-btn-green', () => saveGroupEdits(gTitle, ni, list, items, m), { flex: '2', padding: '12px' }),
            btn('닫기', '', () => m.close(), { flex: '1', background: '#999', padding: '12px' })
        );
        c.append(btns, btn('🗑 그룹 삭제', 'bm-btn-red', () => {
            if (items.length && !confirm(`"${gTitle}" 삭제? (${items.length}개 포함)`)) return;
            pushUndo(); delete curPage()[gTitle]; _urls = null; saveNow(); rerender(); m.close();
        }, { width: '100%', marginTop: '10px', padding: '10px' }));
        m.appendChild(c); showModal(m);
        m.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); saveGroupEdits(gTitle, ni, list, items, m); } });
        sortInst = new Sortable(list, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ═══════════════════════════════════
       탭 관리
       ═══════════════════════════════════ */
    function showTabMgr() {
        const m = modal();
        const c = $('div', { cls: 'bm-modal-content' });
        c.appendChild($('h3', { text: '📂 탭 관리', style: { marginTop: '0' } }));
        const list = $('div', { cls: 'bm-scroll-list' });
        const render = () => {
            list.replaceChildren();
            for (const tn of Object.keys(db.pages)) {
                list.appendChild($('div', { cls: 'tab-row' }, [
                    $('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
                    $('div', { style: { display: 'flex', gap: '4px', flexShrink: '0' } }, [
                        btn('이름변경', 'bm-btn-blue', () => {
                            const nn = prompt('새 탭 이름:', tn);
                            if (!nn || nn === tn) return;
                            const err = vName(nn, Object.keys(db.pages));
                            if (err) { alert(err); return; }
                            const o = {};
                            for (const k of Object.keys(db.pages)) o[k === tn ? nn.trim() : k] = db.pages[k];
                            db.pages = o;
                            if (db.currentPage === tn) db.currentPage = nn.trim();
                            saveNow(); render(); rerender();
                        }, { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => {
                            if (Object.keys(db.pages).length <= 1) { alert('최소 1개 탭 필수'); return; }
                            if (!confirm(`"${tn}" 삭제?`)) return;
                            pushUndo(); delete db.pages[tn];
                            if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0];
                            _urls = null; saveNow(); m.close(); rerender();
                        }, { padding: '4px 8px' })
                    ])
                ]));
            }
        };
        render();
        c.append(
            list,
            btn('+ 새 탭 추가', 'bm-btn-blue', () => {
                const n = prompt('새 탭 이름:');
                const err = vName(n, Object.keys(db.pages));
                if (err) { if (n) alert(err); return; }
                db.pages[n.trim()] = {}; db.currentPage = n.trim();
                saveNow(); rerender(); m.close();
            }, { width: '100%', marginTop: '15px', padding: '12px' }),
            btn('닫기', '', () => m.close(), { width: '100%', marginTop: '10px', background: '#999', padding: '10px' })
        );
        m.appendChild(c); showModal(m);
    }

    /* ═══════════════════════════════════
       빠른 추가
       ═══════════════════════════════════ */
    async function saveTo(page, group, name, url, m) {
        if (!name?.trim()) { alert('이름을 입력하세요.'); return; }
        const cu = cleanUrl(url.trim());
        if (!isUrl(cu)) { alert('올바른 URL을 입력하세요.'); return; }
        pushUndo();
        const icon = await fetchIcon(cu);
        if (!db.pages[page][group]) db.pages[page][group] = [];
        db.pages[page][group].push({ name: name.trim(), url: cu, icon, addedAt: Date.now() });
        addUrl(cu); setRecent(page, group);
        saveNow(); m.close(); rerender(); updateFab(); toast('✅ 저장됨');
    }

    function renderGroupPicker(target, page, getName, getUrl, m) {
        target.replaceChildren($('p', { text: `그룹 선택 (${page}):`, style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
        const col = $('div', { cls: 'bm-flex-col' });
        for (const g of Object.keys(db.pages[page]))
            col.appendChild(btn(`📁 ${g}`, '', () => saveTo(page, g, getName(), getUrl(), m), { background: 'var(--c-bg)', color: 'var(--c-text)', justifyContent: 'flex-start', padding: '12px' }));
        col.appendChild(btn('+ 새 그룹 생성', '', async () => {
            const n = prompt("새 그룹 이름:");
            const err = vName(n, Object.keys(db.pages[page]));
            if (err) { if (n) alert(err); return; }
            await saveTo(page, n.trim(), getName(), getUrl(), m);
        }, { background: 'var(--c-dark)', color: '#fff', padding: '12px' }));
        target.appendChild(col);
    }

    let _titleFetchId = null;

    function showQuickAdd() {
        shadow.querySelector('#bm-quick')?.remove();
        const m = modal('bm-quick');
        const c = $('div', { cls: 'bm-modal-content' });
        c.appendChild($('h3', { text: '🔖 북마크 저장', style: { marginTop: '0' } }));
        const cu = cleanUrl(location.href);
        if (isDup(cu)) c.appendChild($('div', { text: `⚠ 이미 저장됨: ${findLocs(cu).join(', ')}`, style: { color: 'var(--c-warning)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' } }));
        c.appendChild($('label', { text: '이름' }));
        const ni = $('input', { type: 'text', value: document.title.substring(0, 30) });
        c.append(ni, $('label', { text: '주소 (URL)' }));
        const ui = $('input', { type: 'text', value: cu });
        c.appendChild(ui);
        ui.addEventListener('change', () => {
            const u = ui.value.trim();
            if (!isUrl(u) || ni.dataset.manual) return;
            const id = _titleFetchId = Symbol();
            GM_xmlhttpRequest({
                method: 'GET', url: u, timeout: 5000, headers: { Accept: 'text/html' },
                onload: r => { if (_titleFetchId !== id) return; const m = r.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i); if (m?.[1] && ni.value === document.title.substring(0, 30)) ni.value = m[1].trim().substring(0, 30); }
            });
        });
        ni.addEventListener('input', () => { ni.dataset.manual = '1'; });

        const area = $('div');
        const gArea = $('div');
        const recent = getRecent();

        if (recent && db.pages[recent.page]?.[recent.group]) {
            area.append(
                $('p', { text: `최근 저장: ${recent.page} > ${recent.group}`, style: { fontSize: '11px', color: '#999', marginTop: '10px', marginBottom: '2px' } }),
                btn(`⚡ ${recent.page} > ${recent.group}에 바로 저장`, 'bm-btn-blue', () => saveTo(recent.page, recent.group, ni.value, ui.value, m), { width: '100%', marginTop: '2px', padding: '10px' })
            );
        }
        const domSug = suggestGroup(cu);
        if (domSug && domSug !== recent?.group) {
            area.append(
                $('p', { text: `💡 같은 도메인 → "${domSug}"`, style: { fontSize: '11px', color: 'var(--c-primary)', marginTop: '5px' } }),
                btn(`📁 ${domSug}에 저장`, 'bm-btn-blue', () => saveTo(db.currentPage, domSug, ni.value, ui.value, m), { width: '100%', marginTop: '2px', padding: '10px' })
            );
        }
        const enterSave = e => { if (e.key === 'Enter' && recent && db.pages[recent.page]?.[recent.group]) { e.preventDefault(); saveTo(recent.page, recent.group, ni.value, ui.value, m); } };
        ni.addEventListener('keydown', enterSave);
        ui.addEventListener('keydown', enterSave);

        const pages = Object.keys(db.pages);
        if (pages.length === 1) renderGroupPicker(gArea, pages[0], () => ni.value, () => ui.value, m);
        else {
            area.appendChild($('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
            const btns = $('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } });
            pages.forEach(p => btns.appendChild(btn(p, '', () => renderGroupPicker(gArea, p, () => ni.value, () => ui.value, m), { background: '#eee', color: '#333' })));
            area.appendChild(btns);
        }
        area.appendChild(gArea); c.appendChild(area);
        c.appendChild($('button', { text: '취소', style: { width: '100%', border: '0', background: 'none', marginTop: '20px', color: '#999', cursor: 'pointer' }, onclick: () => m.close() }));
        m.appendChild(c); showModal(m);
        setTimeout(() => ni.focus(), 50);
    }

    /* ═══════════════════════════════════
       FAB
       ═══════════════════════════════════ */
    function updateFab() {
        const fab = shadow?.querySelector('#bm-fab');
        if (!fab || shadow.querySelector('#bm-overlay')?.style.display === 'block') return;
        const locs = findLocs(location.href);
        fab.querySelector('.bm-badge')?.remove();
        if (locs.length) {
            fab.style.outline = '3px solid var(--c-success)';
            fab.style.outlineOffset = '2px';
            fab.appendChild($('span', { cls: 'bm-badge', text: locs.length > 9 ? '9+' : String(locs.length) }));
        } else { fab.style.outline = 'none'; }
    }

    function toggle(overlay, fab) {
        const vis = overlay.style.display === 'block';
        if (!vis) {
            refreshDB();  // ★ 수정 3: 열 때마다 최신 데이터 로드
            renderDash();
            document.body.classList.add('bm-overlay-open');
            overlay.style.display = 'block';
            fab.childNodes[0].textContent = '✕';
        } else {
            document.body.classList.remove('bm-overlay-open');
            overlay.style.display = 'none';
            fab.childNodes[0].textContent = '🔖';
            killSortables(); _container = null;
            if (_iconObs) { _iconObs.disconnect(); _iconObs = null; }
            updateFab();
        }
    }

    function setupFab(fab, overlay) {
        const st = { timer: 0, ready: false, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0, lx: 0, ly: 0, tap: 0 };
        const endDrag = () => {
            fab.style.transition = ''; fab.style.bottom = 'auto'; fab.style.willChange = '';
            const snap = fab.getBoundingClientRect().left + fab.offsetWidth / 2 > innerWidth / 2;
            fab.style.left = snap ? 'auto' : '15px'; fab.style.right = snap ? '15px' : 'auto';
            st.dragging = st.ready = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = ''; st.tap = 0;
        };
        const resetReady = () => { st.ready = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = ''; fab.style.willChange = ''; st.tap = 0; };
        const isSwipeUp = () => (st.sy - st.ly > 50 && Math.abs(st.lx - st.sx) < 40);

        fab.addEventListener('pointerup', e => {
            clearTimeout(st.timer);
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe')?.remove();
            if (st.dragging) { endDrag(); return; }
            if (st.ready) { resetReady(); return; }
            if (isSwipeUp()) { st.tap = 0; showQuickAdd(); return; }
            const now = Date.now();
            if (now - st.tap < 350) { st.tap = 0; showQuickAdd(); }
            else { st.tap = now; setTimeout(() => { if (st.tap && Date.now() - st.tap >= 340) { st.tap = 0; toggle(overlay, fab); } }, 350); }
        });

        fab.addEventListener('pointerdown', e => {
            fab.setPointerCapture(e.pointerId);
            st.sx = e.clientX; st.sy = e.clientY; st.lx = e.clientX; st.ly = e.clientY;
            const r = fab.getBoundingClientRect();
            st.ox = e.clientX - r.left; st.oy = e.clientY - r.top;
            st.ready = st.dragging = false;
            st.timer = setTimeout(() => {
                st.ready = true; fab.style.willChange = 'transform, left, top';
                if (e.pointerType === 'touch') navigator.vibrate?.(40);
                fab.style.cursor = 'grabbing'; fab.style.boxShadow = '0 6px 20px rgba(0,0,0,0.5)';
            }, 500);
        });

        fab.addEventListener('pointermove', e => {
            st.lx = e.clientX; st.ly = e.clientY;
            if (!st.ready) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) clearTimeout(st.timer);
                const dy = st.sy - e.clientY;
                let h = shadow.querySelector('#bm-swipe');
                if (dy > 20 && Math.abs(e.clientX - st.sx) < 40) {
                    if (!h) { h = $('div', { id: 'bm-swipe', text: '＋' }); shadow.appendChild(h); }
                    const r = fab.getBoundingClientRect();
                    h.style.left = (r.left + r.width / 2 - 15) + 'px';
                    h.style.top = (r.top - 40) + 'px';
                    h.style.opacity = Math.min(1, (dy - 20) / 30);
                } else h?.remove();
                return;
            }
            st.dragging = true; fab.style.transition = 'none';
            const sz = fab.offsetWidth || 46;
            fab.style.left = Math.max(0, Math.min(innerWidth - sz, e.clientX - st.ox)) + 'px';
            fab.style.top = Math.max(0, Math.min(innerHeight - sz, e.clientY - st.oy)) + 'px';
            fab.style.right = fab.style.bottom = 'auto';
        });

        fab.addEventListener('pointercancel', e => {
            clearTimeout(st.timer);
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe')?.remove();
            st.ready = st.dragging = false; fab.style.cursor = 'pointer'; fab.style.boxShadow = ''; fab.style.willChange = ''; st.tap = 0;
        });

        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    /* ═══════════════════════════════════
       키보드
       ═══════════════════════════════════ */
    function setupKeys() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') {
                e.preventDefault();
                const o = shadow.querySelector('#bm-overlay'), f = shadow.querySelector('#bm-fab');
                if (o && f) toggle(o, f);
            }
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); showQuickAdd(); }
            if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ') {
                const o = shadow.querySelector('#bm-overlay');
                if (o?.style.display === 'block') { e.preventDefault(); if (!popUndo()) toast('되돌릴 내역 없음'); }
            }
            if (e.key === 'Escape') {
                if (shadow.querySelector('dialog[open]')) return;
                const o = shadow.querySelector('#bm-overlay'), f = shadow.querySelector('#bm-fab');
                if (o?.style.display === 'block') { e.preventDefault(); toggle(o, f); }
            }
        });
    }

    /* ═══════════════════════════════════
       CSS (변수명 & 클래스명 간소화)
       ═══════════════════════════════════ */
    function getCSS() {
        return `
:host{--c-primary:#007bff;--c-success:#28a745;--c-warning:#fd7e14;--c-danger:#dc3545;--c-dark:#333;--c-bg:#f1f3f5;--c-surface:#fff;--c-text:#333;--c-border:#ddd;--c-overlay:rgba(255,255,255,.98);--c-input-bg:var(--c-surface);--c-input-bd:var(--c-border);--c-tab-bg:#eee;--c-tab-txt:#666;--r:8px;--fab:46px;--fab-off:20px;--modal-w:min(420px,calc(100vw - 32px));--grid-min:300px;--grid-max:1200px;--item-min:80px;--icon:32px;color-scheme:light dark}
@media(min-width:769px){:host{--item-min:90px;--icon:40px}}
@media(max-width:768px){:host{--fab:40px}#bm-fab{font-size:20px!important}}
@media(prefers-color-scheme:dark){:host{--c-dark:#e0e0e0;--c-bg:#1e1e1e;--c-surface:#2a2a2a;--c-text:#e0e0e0;--c-border:#444;--c-overlay:rgba(30,30,30,.98);--c-input-bg:#333;--c-input-bd:#555;--c-tab-bg:#444;--c-tab-txt:#ccc}}
*{box-sizing:border-box;font-family:sans-serif}
#bm-fab{position:fixed;bottom:var(--fab-off);right:var(--fab-off);width:var(--fab);height:var(--fab);background:var(--c-dark);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.15);font-size:22px;user-select:none;touch-action:none;-webkit-tap-highlight-color:transparent;border:none;transition:left .2s,right .2s,top .2s,box-shadow .2s;overflow:visible}
#bm-fab:hover{box-shadow:0 4px 12px rgba(0,0,0,.4),0 8px 28px rgba(0,0,0,.2)}
.bm-badge{position:absolute;top:-4px;right:-4px;background:var(--c-danger);color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none}
#bm-swipe{position:fixed;width:30px;height:30px;background:var(--c-primary);color:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;pointer-events:none;transition:opacity .1s;z-index:2147483647}
#bm-overlay{position:fixed;top:0;left:0;width:100vw;height:100vh;background:var(--c-overlay);display:none;overflow-y:auto;padding:15px;backdrop-filter:blur(5px);color:var(--c-text);text-align:left}
.bm-modal-content,.bm-ctr{color:var(--c-text);text-align:left;background:var(--c-surface)}
button{outline:none;border:none;font-family:sans-serif}
.bm-btn,.bm-mgr-btn{text-indent:0;font-size:11px;line-height:normal;display:inline-flex;align-items:center;justify-content:center}
.bm-btn:hover{filter:brightness(1.15)}.bm-btn:active{filter:brightness(.9);transform:scale(.97)}
.bm-btn-blue:hover{background:color-mix(in srgb,white 15%,var(--c-primary))}
.bm-btn-green:hover{background:color-mix(in srgb,white 15%,var(--c-success))}
.bm-btn-red:hover{background:color-mix(in srgb,white 15%,var(--c-danger))}
.bm-icon-btn{width:34px;height:34px;padding:0;font-size:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;background:var(--c-dark);border:none}
.bm-icon-btn:hover{filter:brightness(1.15)}.bm-icon-btn:active{filter:brightness(.9);transform:scale(.97)}
input{width:100%;padding:10px;margin:5px 0;border:1px solid var(--c-input-bd);background:var(--c-input-bg);color:var(--c-text);border-radius:6px;font-size:14px;display:block;height:auto;-webkit-appearance:none}
label{display:block;font-size:12px;font-weight:700;color:#666;margin-top:10px}
.bm-top{max-width:var(--grid-max);margin:0 auto 10px;display:flex;flex-direction:column;gap:8px;position:sticky;top:0;z-index:100;background:var(--c-surface);padding:10px 0 5px;border-bottom:1px solid var(--c-border)}
.bm-bar{display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end;width:100%;align-items:center}
.bm-search{max-width:150px;padding:6px 10px!important;font-size:13px!important;display:inline-block;margin:0!important;border:1px solid var(--c-border)!important;background:var(--c-surface)!important;color:var(--c-text)!important;border-radius:6px!important}
.bm-search::-webkit-search-cancel-button{-webkit-appearance:searchfield-cancel-button;cursor:pointer}
.bm-tabs{display:flex;gap:5px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:5px;width:100%;mask-image:linear-gradient(90deg,transparent,#000 8px,#000 calc(100% - 8px),transparent);-webkit-mask-image:linear-gradient(90deg,transparent,#000 8px,#000 calc(100% - 8px),transparent)}
.bm-tab{padding:8px 14px;background:var(--c-tab-bg);border-radius:var(--r) var(--r) 0 0;cursor:pointer;font-size:13px;font-weight:700;color:var(--c-tab-txt);white-space:nowrap;flex-shrink:0;border-bottom:3px solid transparent;transition:border-color .2s,background .2s;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}
.bm-tab.active{background:var(--c-surface);color:var(--c-primary);border-bottom-color:var(--c-primary)}
.bm-tab:hover:not(.active){background:color-mix(in srgb,var(--c-primary) 10%,var(--c-bg));border-bottom-color:color-mix(in srgb,var(--c-primary) 30%,transparent)}
.bm-btn{padding:7px 10px;color:#fff;background:var(--c-dark);border-radius:6px;cursor:pointer}
.bm-btn-blue{background:var(--c-primary)}.bm-btn-green{background:var(--c-success)}.bm-btn-red{background:var(--c-danger);color:#fff}
.bm-ctr{display:grid;grid-template-columns:repeat(auto-fit,minmax(var(--grid-min),1fr));gap:15px;max-width:var(--grid-max);margin:0 auto}
.bm-sec{background:var(--c-surface);border:1px solid var(--c-border);border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.05);content-visibility:auto;contain-intrinsic-size:auto 200px}
.bm-sec-hdr{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--c-bg);position:relative;gap:8px;min-height:44px}
.bm-sec-hdr::after{content:'';position:absolute;bottom:0;left:0;height:2px;background:var(--c-primary);width:var(--fill,0%);transition:width .3s}
.bm-sec-hdr span{cursor:pointer}.bm-sec-hdr span:hover{opacity:.7}
.bm-gcnt{font-weight:400;font-size:12px;color:#999}
.bm-sec-hdr:has(+.bm-grid[style*="display: none"]) .bm-gcnt{background:var(--c-primary);color:#fff;padding:1px 6px;border-radius:10px;font-size:11px}
.bm-gwarn{font-size:10px;color:var(--c-warning);margin-left:4px}
.bm-mgr-btn{border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-text);padding:6px 12px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;min-height:32px;min-width:44px;display:inline-flex;align-items:center;justify-content:center;transition:background .15s}
.bm-mgr-btn:active{background:var(--c-bg);transform:scale(.96)}
.bm-qadd{width:32px;height:32px;min-width:32px;border-radius:50%;border:1px solid var(--c-border);background:var(--c-surface);color:var(--c-primary);font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;margin-left:auto;margin-right:8px;transition:background .15s;line-height:1;padding:0}
.bm-qadd:hover{background:var(--c-primary);color:#fff}
.bm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--item-min),1fr));gap:12px;padding:15px;min-height:60px;justify-items:center}
.bm-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;text-decoration:none;color:inherit;width:100%;max-width:80px;position:relative}
.bm-item{display:flex;flex-direction:column;align-items:center;text-align:center;width:100%;transition:transform .15s}
.bm-item:hover{transform:translateY(-2px)}
.bm-item img{width:var(--icon);height:var(--icon);min-width:var(--icon);min-height:var(--icon);margin-bottom:6px;border-radius:var(--r);background:#fff;object-fit:contain;pointer-events:none;display:block}
.bm-item span{font-size:11px;color:var(--c-text);width:100%;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;pointer-events:none}
.bm-empty{grid-column:1/-1;text-align:center;color:#bbb;font-size:12px;padding:25px 15px;font-style:italic;border:2px dashed var(--c-border);border-radius:var(--r);margin:5px}
.sort-active .bm-grid{display:none}
.sort-active .bm-sec{border:2px dashed var(--c-primary);cursor:move;margin-bottom:5px}
.sort-active .bm-sec-hdr{cursor:grab}
.sort-active .bm-ctr{grid-template-columns:1fr}
.bm-grid .sortable-ghost{opacity:.4;background:color-mix(in srgb,var(--c-primary) 20%,transparent);border-radius:var(--r)}
dialog.bm-modal-bg{background:transparent;border:none;padding:0;margin:auto;max-width:100vw;max-height:100vh;overflow:visible}
dialog.bm-modal-bg::backdrop{background:rgba(0,0,0,.6)}
.bm-modal-content{background:var(--c-surface);padding:25px;border-radius:15px;width:100%;max-width:var(--modal-w);max-height:85vh;overflow-y:auto;color:var(--c-text)}
.bm-ctx{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r);box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:140px;overflow:hidden}
.bm-ctx-item{padding:10px 14px;font-size:13px;cursor:pointer;color:var(--c-text)}
.bm-ctx-item:hover{background:var(--c-bg)}
.bm-ctx-item.ctx-danger{color:var(--c-danger)}
.bm-admin-menu{background:var(--c-surface);border:1px solid var(--c-border);border-radius:var(--r);box-shadow:0 4px 16px rgba(0,0,0,.15);min-width:180px;overflow:hidden}
.bm-admin-item{padding:12px 16px;font-size:13px;cursor:pointer;color:var(--c-text);display:flex;align-items:center;gap:8px;transition:background .1s}
.bm-admin-item:hover{background:var(--c-bg)}
.bm-admin-item:active{background:color-mix(in srgb,var(--c-primary) 15%,var(--c-bg))}
.bm-gsr{background:var(--c-surface);border:2px solid var(--c-primary);border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.tab-row{display:flex;align-items:center;justify-content:space-between;padding:10px;border-bottom:1px solid var(--c-border);gap:10px}
.bm-drag-handle{cursor:grab;font-size:18px;margin-right:10px;color:#888;touch-action:none}
.bm-toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(0,0,0,.85);color:#fff;padding:10px 24px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .3s,transform .3s;pointer-events:none;z-index:999999;white-space:nowrap;backdrop-filter:blur(8px)}
.bm-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.bm-hint{max-width:var(--grid-max);margin:20px auto 10px;text-align:center;font-size:11px;color:#999;user-select:none}
@media(max-width:768px){.bm-hint{display:none}}
@media(hover:none)and (pointer:coarse){.bm-hint{display:none}}
.bm-flex-row{display:flex;gap:10px;align-items:center}
.bm-flex-col{display:flex;flex-direction:column;gap:5px}
.bm-mt-10{margin-top:10px}.bm-mt-20{margin-top:20px}
.bm-scroll-list{max-height:40vh;overflow-y:auto;border:1px solid var(--c-border);border-radius:8px;padding:10px}`;
    }

    /* ═══════════════════════════════════
       초기화
       ═══════════════════════════════════ */
    function init() {
        /* 호스트 스타일 */
        if (!document.getElementById('bm-host-css')) {
            const s = document.createElement('style');
            s.id = 'bm-host-css';
            s.textContent = 'body.bm-overlay-open{overflow:hidden!important}';
            document.head.appendChild(s);
        }

        const host = $('div', { id: 'bm-root', style: { position: 'fixed', zIndex: '2147483647', top: '0', left: '0', width: '0', height: '0', overflow: 'visible' } });
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = getCSS();
        const overlay = $('div', { id: 'bm-overlay' });
        const fab = $('div', { id: 'bm-fab' });
        fab.appendChild(document.createTextNode('🔖'));
        shadow.append(style, overlay, fab);

        setupFab(fab, overlay);
        setupKeys();

        /* ★ 수정 4: visibility 복귀 시 최신 데이터 리프레시 */
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                saveNow();
            } else {
                /* 탭이 다시 보이면 → 다른 탭에서의 변경 반영 */
                refreshDB();
                updateFab();
                if (overlay.style.display === 'block') renderDash();
            }
        });

        window.addEventListener('pagehide', saveNow);
        window.addEventListener('beforeunload', saveNow);
        if ('onfreeze' in document) document.addEventListener('freeze', saveNow);

        updateFab();
    }

    init();
})();
