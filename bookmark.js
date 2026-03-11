// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v14.1)
// @version      14.1
// @description  v14.0 기반 – FAB badge 제거, 그룹 헤더에 북마크 개수 표시
// @author       User
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js
// @noframes
// ==/UserScript==

(function () {
    'use strict';
    if (window.self !== window.top) return;

    /* ═══════════════════════════════════
       유틸리티
       ═══════════════════════════════════ */
    const deepClone = typeof structuredClone === 'function'
        ? structuredClone
        : (obj) => JSON.parse(JSON.stringify(obj));

    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v);
        }
        const list = Array.isArray(children) ? children : [children];
        for (const c of list) { if (c != null) e.append(c); }
        return e;
    }

    const btn = (text, cls = '', onclick = null, style = {}) =>
        el('button', { class: `bm-util-btn ${cls}`.trim(), text, onclick, style });

    let ttPolicy = null;
    if (window.trustedTypes?.createPolicy) {
        try {
            ttPolicy = window.trustedTypes.createPolicy('bm-safe-html', {
                createHTML: (s) => s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '').replace(/\bon\w+\s*=/gi, 'data-blocked=')
            });
        } catch (e) { console.warn('TrustedTypes policy failed', e); }
    }

    function isValidUrl(str) {
        try { const u = new URL(str); return u.protocol === 'http:' || u.protocol === 'https:'; }
        catch { return false; }
    }

    /* ═══════════════════════════════════
       DB 무결성 검증
       ═══════════════════════════════════ */
    function validateDB(data) {
        if (!data || typeof data !== 'object') return false;
        if (!data.pages || typeof data.pages !== 'object') return false;
        if (!data.currentPage || !data.pages[data.currentPage]) return false;
        for (const groups of Object.values(data.pages)) {
            if (typeof groups !== 'object') return false;
            for (const items of Object.values(groups)) {
                if (!Array.isArray(items)) return false;
                for (const item of items) {
                    if (typeof item.name !== 'string' || typeof item.url !== 'string') return false;
                    if (!item.name.trim() || !item.url.trim()) return false;
                }
            }
        }
        return true;
    }

    /* ═══════════════════════════════════
       URL 중복 체크 (Set 캐시)
       ═══════════════════════════════════ */
    let _urlSet = null;

    function rebuildUrlSet() {
        _urlSet = new Set();
        for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items) _urlSet.add(item.url);
    }

    function isUrlDuplicate(url) {
        if (!_urlSet) rebuildUrlSet();
        return _urlSet.has(url);
    }

    function addToUrlSet(url) { if (_urlSet) _urlSet.add(url); }

    function findUrlLocations(url) {
        const locations = [];
        for (const [pageName, groups] of Object.entries(db.pages))
            for (const [groupName, items] of Object.entries(groups))
                for (const item of items)
                    if (item.url === url) locations.push(`${pageName} > ${groupName}`);
        return locations;
    }

    /* ═══════════════════════════════════
       DB 로드
       ═══════════════════════════════════ */
    let raw = GM_getValue('bm_db_v2', null);
    if (!raw || !validateDB(raw)) {
        const backup = GM_getValue('bm_db_v2_backup', null);
        if (backup && validateDB(backup)) {
            raw = deepClone(backup);
            console.warn('[북마크] 자동 백업에서 복구됨');
        } else {
            raw = { currentPage: "기본", pages: { "기본": { "북마크": [] } } };
            console.warn('[북마크] DB 초기화됨');
        }
    }
    let db = raw;

    /* ═══════════════════════════════════
       Undo 스택
       ═══════════════════════════════════ */
    const _undoStack = [];
    const UNDO_MAX = 10;

    function pushUndo() {
        _undoStack.push(deepClone(db));
        if (_undoStack.length > UNDO_MAX) _undoStack.shift();
    }

    function popUndo() {
        if (_undoStack.length === 0) return false;
        db = _undoStack.pop();
        _urlSet = null;
        saveData();
        renderDashboard();
        return true;
    }

    /* ═══════════════════════════════════
       저장
       ═══════════════════════════════════ */
    let _saveTimer = null;
    const BACKUP_INTERVAL = GM_getValue('bm_backup_interval', 3600000);

    const saveData = () => {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => GM_setValue('bm_db_v2', db), 300);
    };

    const saveDataNow = () => {
        clearTimeout(_saveTimer);
        const lastBackup = GM_getValue('bm_last_backup_time', 0);
        if (Date.now() - lastBackup > BACKUP_INTERVAL) {
            GM_setValue('bm_db_v2_backup', deepClone(db));
            GM_setValue('bm_last_backup_time', Date.now());
        }
        GM_setValue('bm_db_v2', db);
    };

    const getCurPage = () => db.pages[db.currentPage];
    let isSortMode = false;
    let originalOverflow = '';

    /* ═══════════════════════════════════
       그룹 접기/펼치기
       ═══════════════════════════════════ */
    const _collapsedGroups = new Set(
        JSON.parse(GM_getValue('bm_collapsed', '[]'))
    );

    function toggleCollapse(groupName) {
        if (_collapsedGroups.has(groupName)) _collapsedGroups.delete(groupName);
        else _collapsedGroups.add(groupName);
        GM_setValue('bm_collapsed', JSON.stringify([..._collapsedGroups]));
    }

    /* ═══════════════════════════════════
       최근 그룹 추천
       ═══════════════════════════════════ */
    const RECENT_GROUP_KEY = 'bm_recent_group';

    function setRecentGroup(page, group) {
        GM_setValue(RECENT_GROUP_KEY, JSON.stringify({ page, group, ts: Date.now() }));
    }

    function getRecentGroup() {
        try { return JSON.parse(GM_getValue(RECENT_GROUP_KEY, 'null')); } catch { return null; }
    }

    /* ═══════════════════════════════════
       파비콘 (async + LRU 캐시)
       ═══════════════════════════════════ */
    const fallbackIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";
    const _faviconCache = new Map();
    const FAVICON_CACHE_MAX = 200;

    function setFaviconCache(hostname, data) {
        if (_faviconCache.size >= FAVICON_CACHE_MAX) {
            const firstKey = _faviconCache.keys().next().value;
            _faviconCache.delete(firstKey);
        }
        _faviconCache.set(hostname, data);
    }

    function gmFetch(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'blob', timeout: 5000,
                onload: (res) => resolve(res.status === 200 && res.response?.size > 100 ? res.response : null),
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result || fallbackIcon);
            reader.onerror = () => resolve(fallbackIcon);
            reader.readAsDataURL(blob);
        });
    }

    async function fetchFaviconBase64(url) {
        try {
            const hostname = new URL(url).hostname;
            if (_faviconCache.has(hostname)) return _faviconCache.get(hostname);
            const blob =
                await gmFetch(`https://icon.horse/icon/${hostname}`) ||
                await gmFetch(`https://www.google.com/s2/favicons?domain=${hostname}&sz=128`);
            const result = blob ? await blobToBase64(blob) : fallbackIcon;
            setFaviconCache(hostname, result);
            return result;
        } catch {
            return fallbackIcon;
        }
    }

    /* ═══════════════════════════════════
       파비콘 IntersectionObserver (lazy)
       ═══════════════════════════════════ */
    let _faviconObserver = null;

    function createFaviconObserver(root) {
        return new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const realSrc = img.dataset.src;
                    if (realSrc) { img.src = realSrc; delete img.dataset.src; }
                    _faviconObserver.unobserve(img);
                }
            }
        }, { root, rootMargin: '200px' });
    }

    /* ═══════════════════════════════════
       데드링크 감지
       ═══════════════════════════════════ */
    const _deadLinkCache = new Map();

    function checkDeadLink(url) {
        return new Promise(resolve => {
            if (_deadLinkCache.has(url)) { resolve(_deadLinkCache.get(url)); return; }
            GM_xmlhttpRequest({
                method: 'HEAD',
                url,
                timeout: 8000,
                onload: () => {
                    _deadLinkCache.set(url, false);
                    resolve(false);
                },
                onerror: () => {
                    _deadLinkCache.set(url, true);
                    resolve(true);
                },
                ontimeout: () => {
                    _deadLinkCache.set(url, true);
                    resolve(true);
                }
            });
        });
    }

    let shadow = null;

    /* ═══════════════════════════════════
       모달
       ═══════════════════════════════════ */
    function createModal(id = '', { preventEscape = false, onClose = null } = {}) {
        const dialog = document.createElement('dialog');
        if (id) dialog.id = id;
        dialog.className = 'bm-modal-bg';
        dialog.addEventListener('click', (e) => {
            const rect = dialog.getBoundingClientRect();
            const outside = e.clientX < rect.left || e.clientX > rect.right
                || e.clientY < rect.top || e.clientY > rect.bottom;
            if (outside) dialog.close();
        });
        dialog.addEventListener('close', () => {
            onClose?.();
            if (dialog.isConnected) dialog.remove();
        });
        if (preventEscape) dialog.addEventListener('cancel', (e) => e.preventDefault());
        return dialog;
    }

    function showModal(modal) {
        shadow.appendChild(modal);
        if (typeof modal.showModal === 'function') {
            modal.showModal();
        } else {
            modal.setAttribute('open', '');
            modal.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;background:rgba(0,0,0,0.6);padding:0;border:none;';
        }
        return modal;
    }

    /* ═══════════════════════════════════
       아이콘 전체 복구
       ═══════════════════════════════════ */
    async function fixAllIcons() {
        const allItems = [];
        for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items) allItems.push(item);
        if (allItems.length === 0) { alert('저장된 북마크가 없습니다.'); return; }
        if (!confirm(`총 ${allItems.length}개 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?`)) return;

        const modalBg = createModal('', { preventEscape: true });
        const content = el('div', { class: 'bm-modal-content', style: { textAlign: 'center' } });
        const statusEl = el('div', { text: '아이콘 업데이트 중...' });
        content.appendChild(statusEl);
        modalBg.appendChild(content);
        showModal(modalBg);

        _faviconCache.clear();
        const BATCH = 5;
        for (let i = 0; i < allItems.length; i += BATCH) {
            await Promise.all(allItems.slice(i, i + BATCH).map(async item => {
                item.icon = await fetchFaviconBase64(item.url);
            }));
            statusEl.textContent = `아이콘 업데이트 중... ${Math.min(i + BATCH, allItems.length)} / ${allItems.length}`;
        }
        saveDataNow();
        modalBg.close();
        alert("복구 완료!");
        renderDashboard();
    }

    /* ═══════════════════════════════════
       백업 / 복구
       ═══════════════════════════════════ */
    function exportData() {
        saveDataNow();
        const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        el('a', { href: url, download: 'bookmark_backup.json' }).click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function importData() {
        const inp = el('input', { type: 'file', accept: '.json' });
        inp.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const r = new FileReader();
            r.onload = re => {
                try {
                    const parsed = JSON.parse(re.target.result);
                    if (!validateDB(parsed)) { alert('파일 구조가 올바르지 않습니다.'); return; }
                    db = deepClone(parsed);
                    _urlSet = null;
                    saveDataNow(); renderDashboard(); alert('복구 완료!');
                } catch { alert('잘못된 파일입니다.'); }
            };
            r.readAsText(file);
        };
        inp.click();
    }

    /* ═══════════════════════════════════
       아이템 행 (그룹 관리 모달용)
       ═══════════════════════════════════ */
    function createItemRow({ name = '', url = 'https://', isNew = false } = {}) {
        const row = el('div', {
            class: 'e-r',
            style: { borderBottom: '1px solid var(--c-border)', padding: '10px 0', display: 'flex', gap: '10px', alignItems: 'center' }
        });
        const handle = el('span', { class: 'bm-drag-handle', text: '☰' });
        const body = el('div', { style: { flex: '1' } });
        const delRow = el('div', { style: { display: 'flex', justifyContent: 'flex-end' } });
        delRow.appendChild(el('span', {
            text: '삭제',
            style: { color: 'red', cursor: 'pointer', fontSize: '11px' },
            onclick: () => row.remove()
        }));
        const nameInput = el('input', {
            type: 'text', class: 'r-n', value: name,
            placeholder: isNew ? '새 북마크 이름' : '이름',
            style: { marginBottom: '5px' }
        });
        const urlInput = el('input', { type: 'text', class: 'r-u', value: url, placeholder: 'URL' });
        urlInput.addEventListener('paste', () => {
            setTimeout(() => {
                const pastedUrl = urlInput.value.trim();
                if (nameInput.value.trim() || !isValidUrl(pastedUrl)) return;
                GM_xmlhttpRequest({
                    method: 'GET', url: pastedUrl, timeout: 5000,
                    headers: { 'Accept': 'text/html' },
                    onload: (res) => {
                        const match = res.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i);
                        if (match?.[1] && !nameInput.value.trim()) {
                            nameInput.value = match[1].trim().substring(0, 40);
                        }
                    }
                });
            }, 100);
        });
        body.append(delRow, nameInput, urlInput);
        row.append(handle, body);
        return row;
    }

    /* ═══════════════════════════════════
       모바일 롱프레스
       ═══════════════════════════════════ */
    function bindLongPress(element, callback) {
        let timer = 0;
        let moved = false;
        element.addEventListener('touchstart', (e) => {
            moved = false;
            timer = setTimeout(() => {
                if (!moved) {
                    e.preventDefault();
                    const touch = e.changedTouches[0];
                    callback({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
                }
            }, 600);
        }, { passive: false });
        element.addEventListener('touchmove', () => { moved = true; clearTimeout(timer); });
        element.addEventListener('touchend', () => clearTimeout(timer));
        element.addEventListener('touchcancel', () => clearTimeout(timer));
    }

    /* ═══════════════════════════════════
       컨텍스트 메뉴
       ═══════════════════════════════════ */
    function showItemContextMenu(e, item, groupName) {
        e.preventDefault();
        shadow.querySelector('.bm-context-menu')?.remove();

        const menu = el('div', { class: 'bm-context-menu', style: { position: 'fixed', zIndex: '999999' } });

        const actions = [
            { text: '✏️ 편집', action: () => { menu.remove(); showGroupManager(groupName); } },
            { text: '📋 URL 복사', action: () => { navigator.clipboard?.writeText(item.url); menu.remove(); } },
            {
                text: '🗑 삭제', cls: 'ctx-danger', action: () => {
                    if (confirm(`"${item.name}" 삭제?`)) {
                        pushUndo();
                        const items = getCurPage()[groupName];
                        const idx = items.findIndex(i => i.url === item.url && i.name === item.name);
                        if (idx !== -1) { items.splice(idx, 1); _urlSet = null; saveData(); renderDashboard(); }
                    }
                    menu.remove();
                }
            }
        ];

        actions.forEach(a => {
            menu.appendChild(el('div', { class: `bm-context-item ${a.cls || ''}`, text: a.text, onclick: a.action }));
        });

        shadow.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        const x = Math.min(e.clientX, innerWidth - rect.width - 8);
        const y = Math.min(e.clientY, innerHeight - rect.height - 8);
        menu.style.left = Math.max(0, x) + 'px';
        menu.style.top = Math.max(0, y) + 'px';

        const dismiss = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); shadow.removeEventListener('pointerdown', dismiss); } };
        setTimeout(() => shadow.addEventListener('pointerdown', dismiss), 0);
    }

    /* ═══════════════════════════════════
       Sortable 인스턴스 관리
       ═══════════════════════════════════ */
    let _activeSortables = [];
    function destroyAllSortables() { _activeSortables.forEach(s => s.destroy()); _activeSortables = []; }

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _searchTimer = null;
    let _currentContainer = null;

    function renderDashboard() {
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (!overlay) return;

        _faviconObserver?.disconnect();
        _faviconObserver = createFaviconObserver(overlay);

        overlay.className = isSortMode ? 'sort-mode-active' : '';
        overlay.replaceChildren();

        const frag = document.createDocumentFragment();

        const topRow = el('div', { class: 'bm-top-row' });
        const tabBar = el('div', {
            class: 'bm-tab-bar', onclick: (e) => {
                const tab = e.target.closest('.bm-tab');
                if (!tab) return;
                db.currentPage = tab.dataset.page;
                isSortMode = false;
                renderDashboard();
            }
        });
        Object.keys(db.pages).forEach(p => {
            const t = el('div', { class: `bm-tab ${db.currentPage === p ? 'active' : ''}`, text: p });
            t.dataset.page = p;
            tabBar.appendChild(t);
        });

        const adminBar = el('div', { class: 'bm-admin-bar' });
        const searchInput = el('input', {
            type: 'text', placeholder: '검색...', class: 'bm-search-input',
            oninput: () => {
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(() => {
                    const q = searchInput.value.toLowerCase();
                    (_currentContainer ?? shadow).querySelectorAll('.bm-item-wrapper').forEach(w => {
                        const name = w.querySelector('span')?.textContent.toLowerCase() || '';
                        const url = (w.getAttribute('href') || '').toLowerCase();
                        w.style.display = (name.includes(q) || url.includes(q)) ? '' : 'none';
                    });
                }, 150);
            }
        });

        adminBar.append(
            searchInput,
            btn(isSortMode ? '✅ 완료' : '↕ 정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDashboard(); }),
            btn('🔄 아이콘', 'bm-btn-orange', fixAllIcons),
            btn('📂 탭관리', '', showTabManager),
            btn('➕ 그룹', '', () => {
                const n = prompt("새 그룹 이름:");
                if (n) { getCurPage()[n] = []; saveData(); renderDashboard(); }
            }),
            btn('💾 백업', '', exportData),
            btn('📥 복구', 'bm-btn-green', importData),
        );

        topRow.append(adminBar, tabBar);
        frag.appendChild(topRow);

        const container = el('div', {
            class: 'bm-dashboard-container', onclick: (e) => {
                const mbtn = e.target.closest('.bm-manage-btn');
                if (mbtn) { const sec = mbtn.closest('.bm-bookmark-section'); if (sec) showGroupManager(sec.getAttribute('data-id')); }
            }
        });
        _currentContainer = container;

        Object.entries(getCurPage()).forEach(([gTitle, items]) => {
            const section = el('div', { class: 'bm-bookmark-section', 'data-id': gTitle });
            const isCollapsed = _collapsedGroups.has(gTitle);
            const header = el('div', { class: 'bm-section-header' });
            const titleSpan = el('span', {
                text: `${isSortMode ? '≡' : (isCollapsed ? '▶' : '📁')} ${gTitle} (${items.length})`,
                style: { fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' },
                onclick: () => {
                    if (isSortMode) return;
                    toggleCollapse(gTitle);
                    renderDashboard();
                }
            });
            header.appendChild(titleSpan);
            if (!isSortMode) header.appendChild(el('button', { class: 'bm-manage-btn', text: '관리' }));
            section.appendChild(header);

            const grid = el('div', {
                class: 'bm-item-grid',
                'data-group': gTitle,
                style: isCollapsed && !isSortMode ? { display: 'none' } : {}
            });
            items.forEach(item => {
                const wrapper = el('a', { class: 'bm-item-wrapper', href: item.url, target: '_blank' });
                wrapper.addEventListener('contextmenu', (e) => showItemContextMenu(e, item, gTitle));
                bindLongPress(wrapper, (e) => showItemContextMenu(e, item, gTitle));
                const div = el('div', { class: 'bm-bookmark-item' });
                const img = el('img', { decoding: 'async' });
                const realSrc = item.icon?.startsWith('data:') ? item.icon : fallbackIcon;
                img.src = fallbackIcon; img.dataset.src = realSrc;
                _faviconObserver.observe(img);
                div.append(img, el('span', { text: item.name }));
                wrapper.appendChild(div);
                grid.appendChild(wrapper);
            });
            section.appendChild(grid);
            container.appendChild(section);
        });

        frag.appendChild(container);
        overlay.appendChild(frag);

        destroyAllSortables();

        if (isSortMode) {
            _activeSortables.push(new Sortable(container, {
                animation: 150, handle: '.bm-section-header', draggable: '.bm-bookmark-section',
                onEnd: () => {
                    const curPage = getCurPage(); const newOrder = {};
                    container.querySelectorAll('.bm-bookmark-section').forEach(sec => {
                        const id = sec.getAttribute('data-id'); if (curPage[id]) newOrder[id] = curPage[id];
                    });
                    db.pages[db.currentPage] = newOrder; saveData();
                }
            }));
        } else {
            container.querySelectorAll('.bm-item-grid').forEach(grid => {
                _activeSortables.push(new Sortable(grid, {
                    group: 'bm-items', animation: 150, delay: 300, delayOnTouchOnly: true,
                    onEnd: (evt) => {
                        const page = getCurPage();
                        const rebuildGroup = (gridEl) => {
                            const groupName = gridEl.dataset.group;
                            page[groupName] = [...gridEl.querySelectorAll('.bm-item-wrapper')].map(w => {
                                const name = w.querySelector('span')?.textContent || '';
                                const url = w.getAttribute('href') || '';
                                const imgEl = w.querySelector('img');
                                const icon = imgEl?.dataset.src || imgEl?.src || fallbackIcon;
                                return { name, url, icon };
                            });
                        };
                        rebuildGroup(evt.from); if (evt.from !== evt.to) rebuildGroup(evt.to);
                        _urlSet = null;
                        saveData();
                    }
                }));
            });
        }

        const runDeadCheck = () => {
            const wrappers = [...container.querySelectorAll('.bm-item-wrapper')];
            let checked = 0;
            for (const w of wrappers) {
                const url = w.getAttribute('href'); if (!url) continue;
                if (_deadLinkCache.has(url)) { if (_deadLinkCache.get(url)) w.classList.add('bm-dead-link'); continue; }
                if (checked >= 20) break; checked++;
                checkDeadLink(url).then(dead => { if (dead && w.isConnected) w.classList.add('bm-dead-link'); });
            }
        };
        if (typeof requestIdleCallback === 'function') requestIdleCallback(runDeadCheck);
        else setTimeout(runDeadCheck, 500);
    }

    /* ═══════════════════════════════════
       그룹 관리 저장
       ═══════════════════════════════════ */
    async function saveGroupEdits(gTitle, gNameInput, listEl, items, modalBg) {
        const newName = gNameInput.value.trim();
        if (!newName) { alert('그룹 이름을 입력하세요.'); return; }

        const newItems = [];
        let hasInvalid = false;

        for (const row of listEl.querySelectorAll('.e-r')) {
            const name = row.querySelector('.r-n').value.trim();
            const url = row.querySelector('.r-u').value.trim();
            if (!name || !url) continue;
            if (!isValidUrl(url)) { hasInvalid = true; continue; }
            newItems.push({ name, url });
        }

        if (hasInvalid && !confirm('유효하지 않은 URL은 제외됩니다. 계속하시겠습니까?')) return;

        for (const item of newItems) {
            const existing = items.find(o => o.url === item.url);
            item.icon = existing?.icon || await fetchFaviconBase64(item.url);
        }

        const page = getCurPage();
        if (newName !== gTitle) {
            if (page[newName]) { alert('이미 존재하는 그룹 이름입니다.'); return; }
            const rebuilt = {};
            for (const key of Object.keys(page)) {
                rebuilt[key === gTitle ? newName : key] = key === gTitle ? newItems : page[key];
            }
            db.pages[db.currentPage] = rebuilt;
        } else {
            page[gTitle] = newItems;
        }

        _urlSet = null;
        saveData();
        renderDashboard();
        modalBg.close();
    }

    /* ═══════════════════════════════════
       그룹 관리 모달
       ═══════════════════════════════════ */
    function showGroupManager(gTitle) {
        const items = getCurPage()[gTitle]; if (!items) return;
        let sortableInstance = null;
        const modalBg = createModal('', { onClose: () => { if (sortableInstance) sortableInstance.destroy(); } });
        const content = el('div', { class: 'bm-modal-content' });
        content.append(el('h3', { text: '🛠 그룹 관리', style: { marginTop: '0' } }), el('label', { text: '그룹 이름' }));
        const gNameInput = el('input', { type: 'text', value: gTitle });
        const listEl = el('div', { style: { maxHeight: '40vh', overflowY: 'auto', border: '1px solid var(--c-border)', borderRadius: '8px', padding: '10px', marginTop: '10px' } });
        items.forEach(it => listEl.appendChild(createItemRow({ name: it.name, url: it.url })));
        content.append(gNameInput, listEl,
            btn('+ 북마크 추가', 'bm-btn-blue', () => { listEl.appendChild(createItemRow({ isNew: true })); listEl.scrollTop = listEl.scrollHeight; }, { width: '100%', marginTop: '10px', padding: '10px' }),
            btn('📌 현재 페이지 추가', 'bm-btn-green', () => { listEl.appendChild(createItemRow({ name: document.title.substring(0, 30), url: window.location.href })); listEl.scrollTop = listEl.scrollHeight; }, { width: '100%', marginTop: '5px', padding: '10px' })
        );
        const btnRow = el('div', { style: { display: 'flex', gap: '10px', marginTop: '20px' } });
        btnRow.append(
            btn('저장', 'bm-btn-green', () => saveGroupEdits(gTitle, gNameInput, listEl, items, modalBg), { flex: '2', padding: '12px' }),
            btn('닫기', '', () => modalBg.close(), { flex: '1', background: '#999', padding: '12px' })
        );
        content.append(btnRow, btn('🗑 그룹 삭제', 'bm-btn-red', () => {
            if (confirm(`"${gTitle}" 그룹을 삭제하시겠습니까?`)) {
                pushUndo();
                delete getCurPage()[gTitle];
                _urlSet = null;
                saveData(); renderDashboard(); modalBg.close();
            }
        }, { width: '100%', marginTop: '10px', padding: '10px' }));
        modalBg.appendChild(content); showModal(modalBg);
        sortableInstance = new Sortable(listEl, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ═══════════════════════════════════
       탭 관리
       ═══════════════════════════════════ */
    function showTabManager() {
        const modalBg = createModal(); const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '📂 탭 관리', style: { marginTop: '0' } }));
        const list = el('div', { style: { maxHeight: '50vh', overflowY: 'auto', border: '1px solid var(--c-border)', borderRadius: '8px' } });
        const renderList = () => {
            list.replaceChildren();
            Object.keys(db.pages).forEach(tn => {
                const row = el('div', { class: 'tab-manage-row' });
                row.append(el('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
                    el('div', { style: { display: 'flex', gap: '4px', flexShrink: '0' } }, [
                        btn('이름변경', 'bm-btn-blue', () => {
                            const nn = prompt('새 탭 이름:', tn); if (!nn || nn === tn) return;
                            if (nn.trim() === '') { alert('빈 이름은 사용할 수 없습니다.'); return; }
                            if (db.pages[nn]) { alert('이미 존재하는 탭 이름입니다.'); return; }
                            const nps = {}; for (const k of Object.keys(db.pages)) nps[k === tn ? nn : k] = db.pages[k];
                            db.pages = nps; if (db.currentPage === tn) db.currentPage = nn; saveData(); renderList(); renderDashboard();
                        }, { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => { if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; } if (confirm(`"${tn}" 탭을 삭제하시겠습니까?`)) { pushUndo(); delete db.pages[tn]; if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0]; _urlSet = null; saveData(); renderDashboard(); modalBg.close(); } }, { padding: '4px 8px' })
                    ])
                );
                list.appendChild(row);
            });
        };
        renderList();
        content.append(list, btn('+ 새 탭 추가', 'bm-btn-blue', () => { const n = prompt('새 탭 이름:'); if (!n || !n.trim()) return; if (db.pages[n]) { alert("중복 이름"); return; } db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); modalBg.close(); }, { width: '100%', marginTop: '15px', padding: '12px' }), btn('닫기', '', () => modalBg.close(), { width: '100%', marginTop: '10px', background: '#999', padding: '10px' }));
        modalBg.appendChild(content); showModal(modalBg);
    }

    /* ═══════════════════════════════════
       빠른 추가 공통 저장
       ═══════════════════════════════════ */
    async function saveBookmarkTo(page, group, name, url, modalBg) {
        if (!isValidUrl(url)) { alert('올바른 URL을 입력하세요.'); return; }
        const icon = await fetchFaviconBase64(url);
        if (!db.pages[page][group]) db.pages[page][group] = [];
        db.pages[page][group].push({ name, url, icon });
        addToUrlSet(url);
        setRecentGroup(page, group);
        saveData();
        modalBg.close();
        alert('저장됨');
    }

    /* ═══════════════════════════════════
       빠른 추가 모달
       ═══════════════════════════════════ */
    function showQuickAddModal() {
        if (shadow.querySelector('#bm-quick-modal')) return;
        const modalBg = createModal('bm-quick-modal'); const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '🔖 북마크 저장', style: { marginTop: '0' } }));
        if (isUrlDuplicate(window.location.href)) {
            const locs = findUrlLocations(window.location.href);
            content.appendChild(el('div', {
                text: `⚠ 이미 저장됨: ${locs.join(', ')}`,
                style: { color: 'var(--c-warning)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }
        content.append(el('label', { text: '이름' })); const ni = el('input', { type: 'text', value: document.title.substring(0, 30) });
        content.append(ni, el('label', { text: '주소 (URL)' })); const ui = el('input', { type: 'text', value: window.location.href });
        content.appendChild(ui);
        const area = el('div'); const recent = getRecentGroup();
        if (recent && db.pages[recent.page]?.[recent.group]) {
            area.append(el('p', { text: `최근 저장: ${recent.page} > ${recent.group}`, style: { fontSize: '11px', color: '#999', marginTop: '10px', marginBottom: '2px' } }),
                btn(`⚡ ${recent.page} > ${recent.group}에 바로 저장`, 'bm-btn-blue',
                    () => saveBookmarkTo(recent.page, recent.group, ni.value, ui.value, modalBg),
                    { width: '100%', marginTop: '2px', padding: '10px' }));
        }
        area.appendChild(el('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
        const tabBtns = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } });
        Object.keys(db.pages).forEach(p => {
            tabBtns.appendChild(btn(p, '', () => {
                area.replaceChildren(); area.appendChild(el('p', { text: `그룹 선택 (${p}):`, style: { fontSize: '12px', fontWeight: 'bold' } }));
                const col = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });
                Object.keys(db.pages[p]).forEach(g => {
                    col.appendChild(btn(`📁 ${g}`, '',
                        () => saveBookmarkTo(p, g, ni.value, ui.value, modalBg),
                        { background: 'var(--c-bg)', color: 'var(--c-text)', justifyContent: 'flex-start', padding: '12px' }));
                });
                col.appendChild(btn('+ 새 그룹 생성', '', async () => {
                    const n = prompt("새 그룹 이름:");
                    if (!n) return;
                    await saveBookmarkTo(p, n, ni.value, ui.value, modalBg);
                }, { background: 'var(--c-dark)', color: '#fff', padding: '12px' }));
                area.appendChild(col);
            }, { background: '#eee', color: '#333' }));
        });
        area.appendChild(tabBtns); content.appendChild(area);
        content.appendChild(el('button', { text: '취소', style: { width: '100%', border: '0', background: 'none', marginTop: '20px', color: '#999', cursor: 'pointer' }, onclick: () => modalBg.close() }));
        modalBg.appendChild(content); showModal(modalBg);
    }

    /* ═══════════════════════════════════
       FAB 인디케이터
       ═══════════════════════════════════ */
    function updateFabIndicator() {
        const fab = shadow?.querySelector('#bookmark-fab');
        if (!fab || shadow.querySelector('#bookmark-overlay')?.style.display === 'block') return;

        fab.style.outline = isUrlDuplicate(window.location.href) ? '3px solid var(--c-success)' : 'none';
        fab.style.outlineOffset = '2px';
    }

    /* ═══════════════════════════════════
       FAB 토글
       ═══════════════════════════════════ */
    function toggleOverlay(overlay, fab) {
        const isVisible = overlay.style.display === 'block';
        if (!isVisible) {
            renderDashboard();
            originalOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            overlay.style.display = 'block';
            fab.childNodes[0].textContent = '✕';
        } else {
            document.body.style.overflow = originalOverflow;
            overlay.style.display = 'none';
            fab.childNodes[0].textContent = '🔖';
            updateFabIndicator();
        }
    }

    /* ═══════════════════════════════════
       FAB 이벤트
       ═══════════════════════════════════ */
    function setupFab(fab, overlay) {
        const st = {
            timer: 0,
            dragReady: false,
            dragging: false,
            sx: 0, sy: 0, ox: 0, oy: 0
        };

        let lastTap = 0;
        fab.addEventListener('pointerup', (e) => {
            clearTimeout(st.timer);
            fab.releasePointerCapture(e.pointerId);

            if (st.dragging) {
                fab.style.transition = '';
                fab.style.bottom = 'auto';
                const snapRight = fab.getBoundingClientRect().left + (fab.offsetWidth / 2) > innerWidth / 2;
                fab.style.left = snapRight ? 'auto' : '15px';
                fab.style.right = snapRight ? '15px' : 'auto';
                st.dragging = false;
                st.dragReady = false;
                fab.style.cursor = 'pointer';
                fab.style.boxShadow = '';
                lastTap = 0;
                return;
            }

            if (st.dragReady) {
                st.dragReady = false;
                fab.style.cursor = 'pointer';
                fab.style.boxShadow = '';
                lastTap = 0;
                return;
            }

            const now = Date.now();
            if (now - lastTap < 350) {
                lastTap = 0;
                showQuickAddModal();
            } else {
                lastTap = now;
                setTimeout(() => {
                    if (lastTap !== 0 && Date.now() - lastTap >= 340) {
                        lastTap = 0;
                        toggleOverlay(overlay, fab);
                    }
                }, 350);
            }
        });

        fab.addEventListener('pointerdown', (e) => {
            fab.setPointerCapture(e.pointerId);
            st.sx = e.clientX; st.sy = e.clientY;
            const rect = fab.getBoundingClientRect();
            st.ox = e.clientX - rect.left; st.oy = e.clientY - rect.top;
            st.dragReady = false;
            st.dragging = false;

            st.timer = setTimeout(() => {
                st.dragReady = true;
                if (e.pointerType === 'touch') navigator.vibrate?.(40);
                fab.style.cursor = 'grabbing';
                fab.style.boxShadow = '0 6px 20px rgba(0,0,0,0.5)';
            }, 500);
        });

        fab.addEventListener('pointermove', (e) => {
            if (!st.dragReady) {
                if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) {
                    clearTimeout(st.timer);
                }
                return;
            }

            st.dragging = true;
            fab.style.transition = 'none';
            const fabSize = fab.offsetWidth || 46;
            fab.style.left = Math.max(0, Math.min(innerWidth - fabSize, e.clientX - st.ox)) + 'px';
            fab.style.top = Math.max(0, Math.min(innerHeight - fabSize, e.clientY - st.oy)) + 'px';
            fab.style.right = 'auto';
            fab.style.bottom = 'auto';
        });

        fab.addEventListener('pointercancel', (e) => {
            clearTimeout(st.timer);
            fab.releasePointerCapture(e.pointerId);
            st.dragReady = false;
            st.dragging = false;
            fab.style.cursor = 'pointer';
            fab.style.boxShadow = '';
        });

        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    /* ═══════════════════════════════════
       키보드 단축키
       ═══════════════════════════════════ */
    function setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') {
                e.preventDefault();
                const overlay = shadow.querySelector('#bookmark-overlay');
                const fab = shadow.querySelector('#bookmark-fab');
                if (overlay && fab) toggleOverlay(overlay, fab);
            }
            if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
                e.preventDefault();
                showQuickAddModal();
            }
            if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ') {
                const overlay = shadow.querySelector('#bookmark-overlay');
                if (overlay?.style.display === 'block') {
                    e.preventDefault();
                    if (!popUndo()) alert('되돌릴 내역이 없습니다.');
                }
            }
            if (e.key === 'Escape') {
                const openDialog = shadow.querySelector('dialog[open]');
                if (openDialog) return;
                const overlay = shadow.querySelector('#bookmark-overlay');
                const fab = shadow.querySelector('#bookmark-fab');
                if (overlay?.style.display === 'block') {
                    e.preventDefault();
                    toggleOverlay(overlay, fab);
                }
            }
        });
    }

    /* ═══════════════════════════════════
       스타일
       ═══════════════════════════════════ */
    function getStyles() {
        return `
            :host {
                --c-primary: #007bff;
                --c-success: #28a745;
                --c-warning: #fd7e14;
                --c-danger: #dc3545;
                --c-dark: #333;
                --c-bg: #f1f3f5;
                --c-surface: #fff;
                --c-text: #333;
                --c-border: #ddd;
                --radius: 8px;
                --fab-size: 46px;
                --fab-offset: 20px;
                --modal-max-w: 420px;
                --grid-min: 300px;
                --grid-max: 1200px;
                --item-min: 85px;
                --icon-size: 38px;
                color-scheme: light dark;
            }

            @media (max-width: 768px) {
                :host {
                    --fab-size: 40px;
                }
                #bookmark-fab {
                    font-size: 20px !important;
                }
            }

            @media (prefers-color-scheme: dark) {
                :host {
                    --c-dark: #e0e0e0;
                    --c-bg: #1e1e1e;
                    --c-surface: #2a2a2a;
                    --c-text: #e0e0e0;
                    --c-border: #444;
                }
                #bookmark-overlay {
                    background: rgba(30,30,30,0.98) !important;
                    color: var(--c-text) !important;
                }
                input {
                    background-color: #333 !important;
                    color: #eee !important;
                    border-color: #555 !important;
                }
                .bm-tab { background: #444 !important; color: #ccc !important; }
                .bm-tab.active { background: var(--c-primary) !important; color: #fff !important; }
                .bm-context-menu { background: #333; border-color: #555; }
                .bm-context-item:hover { background: #444; }
            }

            * { box-sizing: border-box; font-family: sans-serif; }

            /* ── FAB ── */
            #bookmark-fab {
                position: fixed;
                bottom: var(--fab-offset);
                right: var(--fab-offset);
                width: var(--fab-size);
                height: var(--fab-size);
                background: var(--c-dark);
                color: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 4px 15px rgba(0,0,0,0.4);
                font-size: 22px;
                user-select: none;
                touch-action: none;
                -webkit-tap-highlight-color: transparent;
                border: none;
                will-change: transform;
                transition: left 0.2s ease, right 0.2s ease, top 0.2s ease;
                overflow: visible;
            }

            /* ── 오버레이 ── */
            #bookmark-overlay {
                position: fixed;
                top: 0; left: 0;
                width: 100vw; height: 100vh;
                background: rgba(255,255,255,0.98);
                display: none;
                overflow-y: auto;
                padding: 15px;
                backdrop-filter: blur(5px);
                color: var(--c-text);
                text-align: left;
            }

            .bm-modal-content,
            .bm-dashboard-container {
                color: var(--c-text);
                text-align: left;
                background: var(--c-surface);
            }

            button { outline: none; border: none; font-family: sans-serif; }

            .bm-util-btn, .bm-manage-btn {
                text-indent: 0;
                font-size: 11px;
                line-height: normal;
                display: inline-flex;
                align-items: center;
                justify-content: center;
            }
            .bm-util-btn:hover { filter: brightness(1.15); }
            .bm-util-btn:active { filter: brightness(0.9); transform: scale(0.97); }
            .bm-btn-blue:hover  { background: #2989ff; background: color-mix(in srgb, white 15%, var(--c-primary)); }
            .bm-btn-green:hover { background: #34c759; background: color-mix(in srgb, white 15%, var(--c-success)); }
            .bm-btn-red:hover   { background: #e8485c; background: color-mix(in srgb, white 15%, var(--c-danger)); }

            input {
                width: 100%;
                padding: 10px;
                margin: 5px 0;
                border: 1px solid var(--c-border);
                background-color: var(--c-surface);
                color: var(--c-text);
                border-radius: 6px;
                font-size: 14px;
                display: block;
                height: auto;
                -webkit-appearance: none;
            }

            label {
                display: block;
                font-size: 12px;
                font-weight: bold;
                color: #666;
                margin-top: 10px;
            }

            /* ── 상단 영역 ── */
            .bm-top-row {
                max-width: var(--grid-max);
                margin: 0 auto 10px auto;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .bm-admin-bar {
                display: flex;
                gap: 4px;
                flex-wrap: wrap;
                justify-content: flex-end;
                width: 100%;
                align-items: center;
            }

            .bm-search-input {
                max-width: 150px;
                padding: 6px 10px !important;
                font-size: 13px !important;
                display: inline-block;
                margin: 0 auto 0 0 !important;
                border: 1px solid var(--c-border) !important;
                background: var(--c-surface) !important;
                color: var(--c-text) !important;
                border-radius: 6px !important;
            }

            .bm-tab-bar {
                display: flex;
                gap: 5px;
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                padding-bottom: 5px;
                width: 100%;
            }

            .bm-tab {
                padding: 8px 14px;
                background: #eee;
                border-radius: var(--radius);
                cursor: pointer;
                font-size: 13px;
                font-weight: bold;
                color: #666;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .bm-tab.active { background: var(--c-dark); color: #fff; }
            .bm-tab:hover:not(.active) { background: #d0e4f5; background: color-mix(in srgb, var(--c-primary) 20%, var(--c-bg)); }

            .bm-util-btn {
                padding: 7px 10px;
                color: #fff;
                background: var(--c-dark);
                border-radius: 6px;
                cursor: pointer;
                text-decoration: none;
            }
            .bm-btn-blue { background: var(--c-primary); }
            .bm-btn-green { background: var(--c-success); }
            .bm-btn-orange { background: var(--c-warning); }
            .bm-btn-red { background: var(--c-danger); color: white; }

            /* ── 대시보드 ── */
            .bm-dashboard-container {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(var(--grid-min), 1fr));
                gap: 15px;
                max-width: var(--grid-max);
                margin: 0 auto;
            }

            .bm-bookmark-section {
                background: var(--c-surface);
                border: 1px solid var(--c-border);
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
            }

            .bm-section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px;
                background: var(--c-bg);
                border-bottom: 1px solid var(--c-border);
            }

            .bm-section-header span { cursor: pointer; }
            .bm-section-header span:hover { opacity: 0.7; }

            .bm-manage-btn {
                border: 1px solid var(--c-border);
                background: var(--c-surface);
                color: var(--c-text);
                padding: 5px 10px;
                border-radius: 6px;
                font-weight: bold;
                cursor: pointer;
            }

            .bm-item-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(var(--item-min), 1fr));
                gap: 12px;
                padding: 15px;
                min-height: 60px;
                justify-items: center;
            }

            .bm-item-wrapper {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                text-decoration: none;
                color: inherit;
                width: 100%;
                max-width: 80px;
                position: relative;
            }

            .bm-bookmark-item {
                display: flex;
                flex-direction: column;
                align-items: center;
                text-align: center;
                width: 100%;
                transition: transform 0.15s ease;
            }
            .bm-bookmark-item:hover { transform: translateY(-2px); }

            .bm-bookmark-item img {
                width: var(--icon-size);
                height: var(--icon-size);
                min-width: var(--icon-size);
                min-height: var(--icon-size);
                margin-bottom: 6px;
                border-radius: var(--radius);
                background: #fff;
                object-fit: contain;
                pointer-events: none;
                display: block;
            }

            .bm-bookmark-item span {
                font-size: 11px;
                color: var(--c-text);
                width: 100%;
                text-align: center;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                display: block;
                pointer-events: none;
            }

            /* ── 정렬 모드 ── */
            .sort-mode-active .bm-item-grid { display: none; }
            .sort-mode-active .bm-bookmark-section {
                border: 2px dashed var(--c-primary);
                cursor: move;
                margin-bottom: 5px;
            }
            .sort-mode-active .bm-section-header { cursor: grab; }
            .sort-mode-active .bm-dashboard-container { grid-template-columns: 1fr; }

            /* ── Sortable 고스트 ── */
            .bm-item-grid .sortable-ghost {
                opacity: 0.4;
                background: color-mix(in srgb, var(--c-primary) 20%, transparent);
                border-radius: var(--radius);
            }

            /* ── 데드링크 ── */
            .bm-dead-link { opacity: 0.5; }
            .bm-dead-link::after {
                content: '⚠';
                position: absolute;
                top: 2px; right: 2px;
                font-size: 10px;
                background: var(--c-danger);
                color: white;
                border-radius: 50%;
                width: 16px; height: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: none;
            }

            /* ── 모달 (네이티브 backdrop) ── */
            dialog.bm-modal-bg {
                background: transparent;
                border: none;
                padding: 0;
                margin: auto;
                max-width: 100vw;
                max-height: 100vh;
                overflow: visible;
            }
            dialog.bm-modal-bg::backdrop {
                background: rgba(0,0,0,0.6);
            }

            .bm-modal-content {
                background: var(--c-surface);
                padding: 25px;
                border-radius: 15px;
                width: 100%;
                max-width: var(--modal-max-w);
                max-height: 85vh;
                overflow-y: auto;
                color: var(--c-text);
            }

            /* ── 컨텍스트 메뉴 ── */
            .bm-context-menu {
                background: var(--c-surface);
                border: 1px solid var(--c-border);
                border-radius: var(--radius);
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                min-width: 140px;
                overflow: hidden;
            }
            .bm-context-item {
                padding: 10px 14px;
                font-size: 13px;
                cursor: pointer;
                color: var(--c-text);
            }
            .bm-context-item:hover { background: var(--c-bg); }
            .bm-context-item.ctx-danger { color: var(--c-danger); }

            /* ── 탭 관리 ── */
            .tab-manage-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px;
                border-bottom: 1px solid var(--c-border);
                gap: 10px;
            }

            .bm-drag-handle {
                cursor: grab;
                font-size: 18px;
                margin-right: 10px;
                color: #888;
                touch-action: none;
            }
        `;
    }

    /* ═══════════════════════════════════
       초기화
       ═══════════════════════════════════ */
    function init() {
        const host = el('div', {
            id: 'bm-script-root',
            style: {
                position: 'fixed', zIndex: '2147483647',
                top: '0', left: '0', width: '0', height: '0', overflow: 'visible'
            }
        });
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = getStyles();

        const overlay = el('div', { id: 'bookmark-overlay' });
        const fab = el('div', { id: 'bookmark-fab' });
        fab.appendChild(document.createTextNode('🔖'));

        shadow.append(style, overlay, fab);
        setupFab(fab, overlay);
        setupKeyboard();

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveDataNow();
        });
        window.addEventListener('pagehide', saveDataNow);
        window.addEventListener('beforeunload', saveDataNow);

        updateFabIndicator();
    }

    init();
})();
