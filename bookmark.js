// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v19.4)
// @version      19.4
// @description  v19.3 기반 – 더보기/컨텍스트 메뉴 클릭 수정
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
    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        }
        for (const c of [children].flat()) {
            if (c != null) e.append(c);
        }
        return e;
    }

    const btn = (text, cls = '', onclick = null, style = {}) =>
        el('button', { class: `bm-util-btn ${cls}`.trim(), text, onclick, style });

    const iconBtn = (icon, title, cls, onclick) =>
        el('button', { class: `bm-icon-btn ${cls}`.trim(), text: icon, title, onclick });

    function isValidUrl(str) {
        try { return ['http:', 'https:'].includes(new URL(str).protocol); }
        catch { return false; }
    }

    const _htmlEscMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const escapeHTML = s => s.replace(/[&<>"]/g, c => _htmlEscMap[c]);

    /* ── 이름 유효성 검증 ── */
    const MAX_NAME_LEN = 30;
    const INVALID_CHARS = /[::\/\\<>"|?*]/;

    function validateName(name, existingNames = []) {
        if (!name || !name.trim()) return '이름을 입력하세요.';
        const t = name.trim();
        if (t.length > MAX_NAME_LEN) return `이름은 ${MAX_NAME_LEN}자 이하여야 합니다.`;
        if (INVALID_CHARS.test(t)) return '사용할 수 없는 문자가 포함되어 있습니다. (:: / \\ < > " | ? *)';
        if (existingNames.includes(t)) return '이미 존재하는 이름입니다.';
        return null;
    }

    /* ── URL 추적 파라미터 제거 ── */
    const TRACKING_PARAMS = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'fbclid', 'gclid', 'msclkid', 'mc_eid', '_ga'
    ];

    function cleanUrl(urlStr) {
        try {
            const url = new URL(urlStr);
            let changed = false;
            for (const param of TRACKING_PARAMS) {
                if (url.searchParams.has(param)) {
                    url.searchParams.delete(param);
                    changed = true;
                }
            }
            return changed ? url.toString() : urlStr;
        } catch {
            return urlStr;
        }
    }

    /* ── yieldToMain ── */
    function yieldToMain() {
        return new Promise(resolve => {
            if ('scheduler' in window && 'postTask' in scheduler) {
                scheduler.postTask(resolve, { priority: 'user-visible' });
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    /* ── composedPath 내 요소 포함 확인 ── */
    function composedPathContains(event, element) {
        try {
            return event.composedPath().includes(element);
        } catch {
            return false;
        }
    }

    /* ═══════════════════════════════════
       DB 전체 아이템 순회 헬퍼
       ═══════════════════════════════════ */
    function forEachItem(callback) {
        for (const [pageName, groups] of Object.entries(db.pages)) {
            for (const [groupName, items] of Object.entries(groups)) {
                for (const item of items) {
                    if (callback(item, pageName, groupName) === 'break') return;
                }
            }
        }
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
        forEachItem(item => _urlSet.add(item.url));
    }

    function isUrlDuplicate(url) {
        if (!_urlSet) rebuildUrlSet();
        return _urlSet.has(url);
    }

    function addToUrlSet(url) { if (_urlSet) _urlSet.add(url); }

    function removeFromUrlSet(url) {
        if (!_urlSet) return;
        let found = false;
        forEachItem(item => {
            if (item.url === url) { found = true; return 'break'; }
        });
        if (!found) _urlSet.delete(url);
    }

    function findUrlLocations(url) {
        if (!isUrlDuplicate(url)) return [];
        const locations = [];
        forEachItem((item, pageName, groupName) => {
            if (item.url === url) locations.push(`${pageName} > ${groupName}`);
        });
        return locations;
    }

    /* ═══════════════════════════════════
       DB 로드
       ═══════════════════════════════════ */
    let raw = GM_getValue('bm_db_v2', null);
    if (!raw || !validateDB(raw)) {
        const backup = GM_getValue('bm_db_v2_backup', null);
        if (backup && validateDB(backup)) {
            raw = structuredClone(backup);
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
    const UNDO_MAX = 5;

    function pushUndo() {
        try {
            _undoStack.push(structuredClone(db));
            if (_undoStack.length > UNDO_MAX) _undoStack.shift();
        } catch (e) {
            console.warn('[북마크] Undo 스냅샷 실패, 스택 초기화:', e);
            _undoStack.length = 0;
            showToast('⚠ 되돌리기 스냅샷 실패');
        }
    }

    function popUndo() {
        if (_undoStack.length === 0) return false;
        db = _undoStack.pop();
        _urlSet = null;
        saveData();
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (overlay?.style.display === 'block') renderDashboard();
        showToast('↩ 되돌리기 완료');
        return true;
    }

    /* ═══════════════════════════════════
       저장
       ═══════════════════════════════════ */
    let _saveTimer = null;
    const BACKUP_INTERVAL = 3600000;
    let _lastBackupTime = GM_getValue('bm_last_backup_time', 0);
    const DB_SIZE_WARNING = 4 * 1024 * 1024;
    let _lastSizeWarning = 0;

    function doBackupIfNeeded() {
        if (Date.now() - _lastBackupTime > BACKUP_INTERVAL) {
            GM_setValue('bm_db_v2_backup', structuredClone(db));
            _lastBackupTime = Date.now();
            GM_setValue('bm_last_backup_time', _lastBackupTime);
        }
    }

    const saveData = () => {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            GM_setValue('bm_db_v2', db);
            doBackupIfNeeded();
        }, 300);
    };

    const saveDataNow = () => {
        clearTimeout(_saveTimer);
        try {
            const json = JSON.stringify(db);
            if (json.length > DB_SIZE_WARNING && Date.now() - _lastSizeWarning > 86400000) {
                _lastSizeWarning = Date.now();
                console.warn(`[북마크] DB 크기 경고: ${(json.length / 1024 / 1024).toFixed(1)}MB`);
                showToast(`⚠ 데이터 크기 ${(json.length / 1024 / 1024).toFixed(1)}MB – 아이콘 정리 권장`);
            }
            GM_setValue('bm_db_v2', db);
            doBackupIfNeeded();
        } catch (e) {
            console.error('[북마크] 저장 실패:', e);
            showToast('❌ 저장 실패!');
        }
    };

    const getCurPage = () => db.pages[db.currentPage];
    let isSortMode = false;

    /* ═══════════════════════════════════
       그룹 접기/펼치기
       ═══════════════════════════════════ */
    let _parsedCollapsed = [];
    try {
        const rawCol = JSON.parse(GM_getValue('bm_collapsed', '[]'));
        if (Array.isArray(rawCol)) _parsedCollapsed = rawCol;
    } catch {}
    const _collapsedGroups = new Set(_parsedCollapsed);

    function collapseKey(groupName) {
        return `${db.currentPage}::${groupName}`;
    }

    function toggleCollapse(groupName) {
        const key = collapseKey(groupName);
        if (_collapsedGroups.has(key)) _collapsedGroups.delete(key);
        else _collapsedGroups.add(key);
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
       도메인 기반 그룹 추천
       ═══════════════════════════════════ */
    function suggestGroup(url) {
        try {
            const hostname = new URL(url).hostname;
            const counts = {};
            const page = getCurPage();
            for (const [groupName, items] of Object.entries(page)) {
                for (const item of items) {
                    try {
                        if (new URL(item.url).hostname === hostname) {
                            counts[groupName] = (counts[groupName] || 0) + 1;
                        }
                    } catch {}
                }
            }
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            return sorted.length > 0 ? sorted[0][0] : null;
        } catch {
            return null;
        }
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

    function gmFetch(url, timeout = 5000) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'GET', url, responseType: 'blob', timeout,
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
                await gmFetch(`https://icon.horse/icon/${hostname}`, 3000) ||
                await gmFetch(`https://www.google.com/s2/favicons?domain=${hostname}&sz=128`, 4000);
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

    function getOrCreateFaviconObserver(root) {
        if (_faviconObserver) return _faviconObserver;
        _faviconObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    const realSrc = img.dataset.src;
                    if (realSrc) { img.src = realSrc; delete img.dataset.src; }
                    _faviconObserver.unobserve(img);
                }
            }
        }, { root, rootMargin: '200px' });
        return _faviconObserver;
    }

    let shadow = null;

    /* ═══════════════════════════════════
       토스트 알림
       ═══════════════════════════════════ */
    function showToast(msg, duration = 2000) {
        if (!shadow) return;
        shadow.querySelector('.bm-toast')?.remove();
        const toast = el('div', { class: 'bm-toast', text: msg });
        shadow.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

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
        modal.showModal();
        return modal;
    }

    /* ═══════════════════════════════════
       아이콘 전체 복구
       ═══════════════════════════════════ */
    async function fixAllIcons() {
        const allItems = [];
        forEachItem(item => allItems.push(item));
        if (allItems.length === 0) { showToast('저장된 북마크가 없습니다.'); return; }
        if (!confirm(`총 ${allItems.length}개 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?`)) return;

        let cancelled = false;
        const modalBg = createModal('', { preventEscape: true });
        const content = el('div', { class: 'bm-modal-content', style: { textAlign: 'center' } });
        const statusEl = el('div', { text: '아이콘 업데이트 중...' });
        const cancelBtn = btn('취소', 'bm-btn-red', () => { cancelled = true; }, { width: '100%', marginTop: '15px', padding: '10px' });
        content.append(statusEl, cancelBtn);
        modalBg.appendChild(content);
        showModal(modalBg);

        _faviconCache.clear();
        const BATCH = 5;
        for (let i = 0; i < allItems.length; i += BATCH) {
            if (cancelled) break;
            await Promise.all(allItems.slice(i, i + BATCH).map(async item => {
                if (!cancelled) item.icon = await fetchFaviconBase64(item.url);
            }));
            statusEl.textContent = `아이콘 업데이트 중... ${Math.min(i + BATCH, allItems.length)} / ${allItems.length}`;
            await yieldToMain();
        }
        saveDataNow();
        modalBg.close();
        showToast(cancelled ? '중단됨 (일부 완료)' : '✅ 아이콘 복구 완료');
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

    function exportAsHTML() {
        let html = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
        for (const [pageName, groups] of Object.entries(db.pages)) {
            html += `  <DT><H3>${escapeHTML(pageName)}</H3>\n  <DL><p>\n`;
            for (const [groupName, items] of Object.entries(groups)) {
                html += `    <DT><H3>${escapeHTML(groupName)}</H3>\n    <DL><p>\n`;
                for (const item of items) {
                    html += `      <DT><A HREF="${escapeHTML(item.url)}">${escapeHTML(item.name)}</A>\n`;
                }
                html += `    </DL><p>\n`;
            }
            html += `  </DL><p>\n`;
        }
        html += '</DL><p>';
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        el('a', { href: url, download: 'bookmarks.html' }).click();
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
                    db = structuredClone(parsed);
                    _urlSet = null;
                    saveDataNow(); renderDashboard(); showToast('✅ 복구 완료');
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
                if (!isNew) return;
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
        let fired = false;

        element.addEventListener('touchstart', (e) => {
            moved = false;
            fired = false;
            timer = setTimeout(() => {
                if (!moved) {
                    fired = true;
                    const touch = e.changedTouches[0];
                    callback({ clientX: touch.clientX, clientY: touch.clientY, preventDefault: () => {} });
                }
            }, 500);
        }, { passive: true });

        element.addEventListener('touchmove', () => { moved = true; clearTimeout(timer); });
        element.addEventListener('touchend', (e) => {
            clearTimeout(timer);
            if (fired) e.preventDefault();
        }, { passive: false });
        element.addEventListener('touchcancel', () => { clearTimeout(timer); });
    }

    /* ═══════════════════════════════════
       팝업 메뉴 닫기 헬퍼
       ═══════════════════════════════════ */
    function setupPopupDismiss(menuEl, ac) {
        setTimeout(() => {
            shadow.addEventListener('pointerdown', (ev) => {
                if (!menuEl.contains(ev.target)) { menuEl.remove(); ac.abort(); }
            }, { signal: ac.signal });
            document.addEventListener('pointerdown', (ev) => {
                if (!composedPathContains(ev, menuEl)) { menuEl.remove(); ac.abort(); }
            }, { signal: ac.signal, capture: true });
        }, 0);
    }

    /* ═══════════════════════════════════
       컨텍스트 메뉴
       ═══════════════════════════════════ */
    let _ctxMenuAbort = null;

    function showItemContextMenu(e, item, groupName, itemIndex) {
        e.preventDefault();
        _ctxMenuAbort?.abort();
        shadow.querySelector('.bm-context-menu')?.remove();

        _ctxMenuAbort = new AbortController();
        const ac = _ctxMenuAbort;

        const menu = el('div', { class: 'bm-context-menu', style: { position: 'fixed', zIndex: '999999' } });

        const actions = [
            { text: '✏️ 편집', action: () => { menu.remove(); ac.abort(); showGroupManager(groupName); } },
            {
                text: '📋 URL 복사', action: () => {
                    navigator.clipboard?.writeText(item.url);
                    showToast('📋 URL 복사됨');
                    menu.remove(); ac.abort();
                }
            },
            {
                text: '🗑 삭제', cls: 'ctx-danger', action: () => {
                    if (confirm(`"${item.name}" 삭제?`)) {
                        pushUndo();
                        const items = getCurPage()[groupName];
                        if (typeof itemIndex === 'number' && itemIndex >= 0 && itemIndex < items.length && items[itemIndex].url === item.url) {
                            items.splice(itemIndex, 1);
                        } else {
                            const idx = items.findIndex(i => i.url === item.url && i.name === item.name);
                            if (idx !== -1) items.splice(idx, 1);
                        }
                        removeFromUrlSet(item.url);
                        saveData();
                        renderDashboard();
                    }
                    menu.remove(); ac.abort();
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

        setupPopupDismiss(menu, ac);
    }

    /* ═══════════════════════════════════
       Sortable 인스턴스 관리
       ═══════════════════════════════════ */
    let _activeSortables = [];
    function destroyAllSortables() { _activeSortables.forEach(s => s.destroy()); _activeSortables = []; }

    /* ═══════════════════════════════════
       검색 필터
       ═══════════════════════════════════ */
    function filterItems(query, container) {
        const q = query.toLowerCase();
        container.querySelectorAll('.bm-bookmark-section').forEach(sec => {
            const grid = sec.querySelector('.bm-item-grid');
            if (!grid) return;
            let hasVisible = false;
            grid.querySelectorAll('.bm-item-wrapper').forEach(w => {
                const name = w.querySelector('span')?.textContent.toLowerCase() || '';
                const url = (w.getAttribute('href') || '').toLowerCase();
                const match = !q || name.includes(q) || url.includes(q);
                w.style.display = match ? '' : 'none';
                if (match) hasVisible = true;
            });
            if (q) {
                grid.style.display = hasVisible ? '' : 'none';
                sec.style.display = hasVisible ? '' : 'none';
            } else {
                sec.style.display = '';
                const gTitle = sec.getAttribute('data-id');
                if (gTitle) {
                    grid.style.display = (!isSortMode && _collapsedGroups.has(collapseKey(gTitle))) ? 'none' : '';
                }
            }
        });
    }

    /* ═══════════════════════════════════
       전체 탭 검색
       ═══════════════════════════════════ */
    function globalSearch(query) {
        if (!query.trim()) return null;
        const q = query.toLowerCase();
        const results = [];
        forEachItem((item, pageName, groupName) => {
            if (item.name.toLowerCase().includes(q) || item.url.toLowerCase().includes(q)) {
                results.push({ ...item, pageName, groupName });
            }
        });
        return results;
    }

    function showGlobalSearchResults(results, container) {
        container.querySelector('.bm-global-search-results')?.remove();
        if (!results || results.length === 0) return;

        const section = el('div', { class: 'bm-global-search-results', style: { gridColumn: '1 / -1' } });
        section.appendChild(el('div', {
            text: `🔍 전체 검색 결과 (${results.length}건)`,
            style: { fontWeight: 'bold', fontSize: '13px', padding: '10px', background: 'var(--c-bg)', borderRadius: '8px 8px 0 0' }
        }));
        const grid = el('div', { class: 'bm-item-grid' });
        results.slice(0, 50).forEach(r => {
            const wrapper = el('a', { class: 'bm-item-wrapper', href: r.url, target: '_blank' });
            wrapper.title = `${r.pageName} > ${r.groupName}`;
            const div = el('div', { class: 'bm-bookmark-item' });
            const img = el('img', { src: r.icon || fallbackIcon, decoding: 'async' });
            div.append(img, el('span', { text: r.name }));
            wrapper.appendChild(div);
            grid.appendChild(wrapper);
        });
        section.appendChild(grid);
        container.prepend(section);
    }

    /* ═══════════════════════════════════
       그룹 섹션 렌더링
       ═══════════════════════════════════ */
    function renderGroupSection(gTitle, items, observer, maxItems) {
        const section = el('div', { class: 'bm-bookmark-section', 'data-id': gTitle });
        const isCollapsed = _collapsedGroups.has(collapseKey(gTitle));
        const header = el('div', { class: 'bm-section-header' });
        header.style.setProperty('--fill', `${(items.length / maxItems) * 100}%`);

        const titleSpan = el('span', {
            style: { fontWeight: 'bold', fontSize: '14px', cursor: 'pointer' }
        });
        titleSpan.append(
            document.createTextNode(`${isSortMode ? '≡' : (isCollapsed ? '▶' : '📁')} ${gTitle} `),
            el('span', { text: `(${items.length})`, class: 'bm-group-count' })
        );
        if (items.length >= 50) {
            titleSpan.appendChild(el('span', { text: '⚠', class: 'bm-group-warning', title: '아이템이 많아 성능에 영향을 줄 수 있습니다' }));
        }

        titleSpan.addEventListener('click', () => {
            if (isSortMode) return;
            toggleCollapse(gTitle);
            const grid = section.querySelector('.bm-item-grid');
            const isNowCollapsed = _collapsedGroups.has(collapseKey(gTitle));
            grid.style.display = isNowCollapsed ? 'none' : '';
            const textNode = titleSpan.childNodes[0];
            if (textNode) {
                textNode.textContent = `${isNowCollapsed ? '▶' : '📁'} ${gTitle} `;
            }
        });

        header.appendChild(titleSpan);

        if (!isSortMode) {
            const quickAddBtn = el('button', {
                class: 'bm-quick-group-add',
                text: '+',
                title: '현재 페이지를 이 그룹에 추가',
                onclick: async (e) => {
                    e.stopPropagation();
                    const url = cleanUrl(window.location.href);
                    if (isUrlDuplicate(url)) { showToast('⚠ 이미 저장된 URL'); return; }
                    const name = document.title.substring(0, 30) || url;
                    const icon = await fetchFaviconBase64(url);
                    pushUndo();
                    getCurPage()[gTitle].push({ name, url, icon, addedAt: Date.now() });
                    addToUrlSet(url);
                    setRecentGroup(db.currentPage, gTitle);
                    saveData();
                    renderDashboard();
                    showToast(`✅ "${gTitle}"에 추가됨`);
                }
            });
            header.appendChild(quickAddBtn);
            header.appendChild(el('button', { class: 'bm-manage-btn', text: '관리' }));
        }
        section.appendChild(header);

        const grid = el('div', {
            class: 'bm-item-grid',
            'data-group': gTitle,
            style: isCollapsed && !isSortMode ? { display: 'none' } : {}
        });

        if (items.length === 0 && !isSortMode) {
            grid.appendChild(el('div', { class: 'bm-empty-group' }, [
                el('div', { text: '📎', style: { fontSize: '24px', marginBottom: '8px', opacity: '0.5' } }),
                el('div', { text: '헤더의 + 버튼 또는 URL을 여기에 드래그하세요' })
            ]));
        }

        items.forEach((item, idx) => {
            const wrapper = el('a', { class: 'bm-item-wrapper', href: item.url, target: '_blank' });
            if (item.addedAt) {
                wrapper.title = `추가: ${new Date(item.addedAt).toLocaleDateString()}`;
            }
            wrapper.addEventListener('contextmenu', (e) => showItemContextMenu(e, item, gTitle, idx));
            bindLongPress(wrapper, (e) => showItemContextMenu(e, item, gTitle, idx));
            const div = el('div', { class: 'bm-bookmark-item' });
            const img = el('img', { decoding: 'async' });
            const realSrc = item.icon?.startsWith('data:') ? item.icon : fallbackIcon;
            if (realSrc === fallbackIcon) {
                img.src = fallbackIcon;
            } else {
                img.src = fallbackIcon;
                img.dataset.src = realSrc;
                observer.observe(img);
            }
            div.append(img, el('span', { text: item.name }));
            wrapper.appendChild(div);
            grid.appendChild(wrapper);
        });

        section.appendChild(grid);
        return section;
    }

    /* ═══════════════════════════════════
       관리 바 더보기 메뉴
       ═══════════════════════════════════ */
    let _adminMenuAbort = null;

    function showAdminMenu(anchor, currentPage) {
        _adminMenuAbort?.abort();
        shadow.querySelector('.bm-admin-menu')?.remove();

        _adminMenuAbort = new AbortController();
        const ac = _adminMenuAbort;

        const menu = el('div', { class: 'bm-admin-menu' });
        const actions = [
            { icon: '🔄', text: '아이콘 복구', action: fixAllIcons },
            { icon: '📂', text: '탭 관리', action: showTabManager },
            { icon: '🗂', text: '전체 접기/펼치기', action: () => {
                const allKeys = Object.keys(currentPage).map(g => collapseKey(g));
                const allCollapsed = allKeys.every(k => _collapsedGroups.has(k));
                allKeys.forEach(k => allCollapsed ? _collapsedGroups.delete(k) : _collapsedGroups.add(k));
                GM_setValue('bm_collapsed', JSON.stringify([..._collapsedGroups]));
                renderDashboard();
            }},
            { icon: '💾', text: '백업 (JSON)', action: exportData },
            { icon: '📄', text: '백업 (HTML)', action: exportAsHTML },
            { icon: '📥', text: '복구', action: importData },
        ];
        actions.forEach(a => {
            menu.appendChild(el('div', {
                class: 'bm-admin-menu-item',
                text: `${a.icon} ${a.text}`,
                onclick: () => { menu.remove(); ac.abort(); a.action(); }
            }));
        });
        shadow.appendChild(menu);

        const rect = anchor.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.right = (innerWidth - rect.right) + 'px';
        menu.style.zIndex = '999999';

        setupPopupDismiss(menu, ac);
    }

    /* ═══════════════════════════════════
       대시보드 렌더링
       ═══════════════════════════════════ */
    let _searchTimer = null;
    let _currentContainer = null;
    let _tabSwitching = false;

    function handleTabSwitch(page) {
        if (_tabSwitching || page === db.currentPage) return;
        _tabSwitching = true;
        saveDataNow();
        db.currentPage = page;
        isSortMode = false;
        renderDashboard();
        _tabSwitching = false;
    }

    function renderDashboard() {
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (!overlay) return;

        _ctxMenuAbort?.abort();
        _ctxMenuAbort = null;
        _adminMenuAbort?.abort();
        _adminMenuAbort = null;

        _faviconObserver = getOrCreateFaviconObserver(overlay);

        overlay.className = isSortMode ? 'sort-mode-active' : '';
        overlay.replaceChildren();

        const frag = document.createDocumentFragment();
        const currentPage = getCurPage();

        /* ── 상단 영역 ── */
        const topRow = el('div', { class: 'bm-top-row' });

        /* 탭 바 */
        const tabBar = el('div', { class: 'bm-tab-bar' });
        Object.keys(db.pages).forEach(p => {
            let tabTotal = 0;
            for (const items of Object.values(db.pages[p])) tabTotal += items.length;
            const t = el('div', {
                class: `bm-tab ${db.currentPage === p ? 'active' : ''}`,
                text: `${p} (${tabTotal})`
            });
            t.dataset.page = p;

            let _tabTouchStartX = 0;
            let _tabTouchStartY = 0;
            let _tabTouchMoved = false;

            t.addEventListener('touchstart', (e) => {
                const touch = e.touches[0];
                _tabTouchStartX = touch.clientX;
                _tabTouchStartY = touch.clientY;
                _tabTouchMoved = false;
            }, { passive: true });

            t.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                const dx = Math.abs(touch.clientX - _tabTouchStartX);
                const dy = Math.abs(touch.clientY - _tabTouchStartY);
                if (dx > 8 || dy > 8) _tabTouchMoved = true;
            }, { passive: true });

            t.addEventListener('touchend', (e) => {
                if (_tabTouchMoved) return;
                e.preventDefault();
                handleTabSwitch(p);
            }, { passive: false });

            t.addEventListener('click', () => {
                handleTabSwitch(p);
            });

            tabBar.appendChild(t);
        });

        /* 총 북마크 수 */
        let totalCount = 0;
        for (const items of Object.values(currentPage)) totalCount += items.length;

        /* 관리 바 */
        const adminBar = el('div', { class: 'bm-admin-bar' });
        const searchInput = el('input', {
            type: 'search', placeholder: '검색...', class: 'bm-search-input',
            oninput: () => {
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(() => {
                    const q = searchInput.value;
                    filterItems(q, _currentContainer ?? shadow);
                    if (q.trim().length >= 2) {
                        const results = globalSearch(q);
                        if (_currentContainer) showGlobalSearchResults(results, _currentContainer);
                    } else {
                        _currentContainer?.querySelector('.bm-global-search-results')?.remove();
                    }
                }, 150);
            }
        });

        adminBar.append(
            searchInput,
            el('span', { text: `${totalCount}개`, style: { fontSize: '12px', color: '#999', marginRight: 'auto' } }),
            iconBtn('📌', '북마크 추가', 'bm-btn-green', () => showQuickAddModal()),
            iconBtn(isSortMode ? '✅' : '↕️', isSortMode ? '정렬 완료' : '그룹 정렬', 'bm-btn-blue', () => {
                isSortMode = !isSortMode;
                const si = _currentContainer?.parentElement?.querySelector('.bm-search-input');
                if (si) si.value = '';
                renderDashboard();
            }),
            iconBtn('➕', '새 그룹', '', () => {
                const n = prompt("새 그룹 이름:");
                const err = validateName(n, Object.keys(currentPage));
                if (err) { if (n) alert(err); return; }
                currentPage[n.trim()] = [];
                saveData();
                renderDashboard();
            })
        );

        const moreBtn = iconBtn('⋯', '더보기', '', null);
        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showAdminMenu(moreBtn, currentPage);
        });
        adminBar.appendChild(moreBtn);

        topRow.append(tabBar, adminBar);
        frag.appendChild(topRow);

        /* ── 메인 컨테이너 ── */
        const container = el('div', {
            class: 'bm-dashboard-container', onclick: (e) => {
                const mbtn = e.target.closest('.bm-manage-btn');
                if (mbtn) { const sec = mbtn.closest('.bm-bookmark-section'); if (sec) showGroupManager(sec.getAttribute('data-id')); }
            }
        });
        _currentContainer = container;

        /* ── 드래그 앤 드롭 URL 추가 ── */
        container.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            container.style.outline = '2px dashed var(--c-primary)';
        });
        container.addEventListener('dragleave', () => { container.style.outline = ''; });
        container.addEventListener('drop', async (e) => {
            e.preventDefault();
            container.style.outline = '';
            const droppedUrl = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
            if (!droppedUrl || !isValidUrl(droppedUrl.trim())) return;
            const url = cleanUrl(droppedUrl.trim());
            if (isUrlDuplicate(url)) { showToast('⚠ 이미 저장된 URL'); return; }
            const targetGrid = e.target.closest('.bm-item-grid');
            const groupName = targetGrid?.dataset.group || Object.keys(getCurPage())[0];
            if (!groupName) { showToast('⚠ 그룹이 없습니다. 먼저 그룹을 추가하세요.'); return; }
            let name = url;
            try {
                const res = await new Promise((resolve) => {
                    GM_xmlhttpRequest({
                        method: 'GET', url, timeout: 5000,
                        headers: { 'Accept': 'text/html' },
                        onload: resolve, onerror: () => resolve(null)
                    });
                });
                const match = res?.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (match?.[1]) name = match[1].trim().substring(0, 30);
            } catch {}
            const icon = await fetchFaviconBase64(url);
            pushUndo();
            getCurPage()[groupName].push({ name, url, icon, addedAt: Date.now() });
            addToUrlSet(url);
            saveData();
            renderDashboard();
            showToast(`✅ "${groupName}"에 추가됨`);
        });

        /* ── 그룹 섹션 렌더링 ── */
        const maxItems = Math.max(...Object.values(currentPage).map(arr => arr.length), 1);
        Object.entries(currentPage).forEach(([gTitle, items]) => {
            container.appendChild(renderGroupSection(gTitle, items, _faviconObserver, maxItems));
        });

        frag.appendChild(container);
        overlay.appendChild(frag);

        /* ── 단축키 힌트 ── */
        overlay.appendChild(el('div', {
            class: 'bm-shortcut-hint',
            text: 'Ctrl+Shift+B: 대시보드 | Ctrl+Shift+D: 빠른추가 | Ctrl+Z: 되돌리기 | ESC: 닫기'
        }));

        destroyAllSortables();

        /* ── 탭 바 드래그 정렬 ── */
        if (Object.keys(db.pages).length > 1) {
            _activeSortables.push(new Sortable(tabBar, {
                animation: 150, direction: 'horizontal', draggable: '.bm-tab',
                delay: 300,
                delayOnTouchOnly: true,
                onEnd: () => {
                    const newOrder = {};
                    tabBar.querySelectorAll('.bm-tab').forEach(t => {
                        const p = t.dataset.page;
                        if (db.pages[p]) newOrder[p] = db.pages[p];
                    });
                    db.pages = newOrder;
                    saveData();
                }
            }));
        }

        if (isSortMode) {
            _activeSortables.push(new Sortable(container, {
                animation: 150, handle: '.bm-section-header', draggable: '.bm-bookmark-section',
                onEnd: () => {
                    pushUndo();
                    const curPage = getCurPage();
                    const newOrder = {};
                    container.querySelectorAll('.bm-bookmark-section').forEach(sec => {
                        const id = sec.getAttribute('data-id');
                        if (curPage[id]) newOrder[id] = curPage[id];
                    });
                    db.pages[db.currentPage] = newOrder;
                    saveData();
                }
            }));
        } else {
            container.querySelectorAll('.bm-item-grid').forEach(grid => {
                if (grid.style.display === 'none') return;
                _activeSortables.push(new Sortable(grid, {
                    group: 'bm-items', animation: 150, delay: 300, delayOnTouchOnly: true,
                    onEnd: (evt) => {
                        pushUndo();
                        const page = getCurPage();
                        const iconMap = new Map();
                        for (const items of Object.values(page))
                            for (const item of items) iconMap.set(`${item.url}|${item.name}`, item.icon);

                        const rebuildGroup = (gridEl) => {
                            const groupName = gridEl.dataset.group;
                            page[groupName] = [...gridEl.querySelectorAll('.bm-item-wrapper')].map(w => {
                                const name = w.querySelector('span')?.textContent || '';
                                const url = w.getAttribute('href') || '';
                                return {
                                    name, url,
                                    icon: iconMap.get(`${url}|${name}`) || fallbackIcon,
                                    addedAt: Date.now()
                                };
                            });
                        };
                        rebuildGroup(evt.from);
                        if (evt.from !== evt.to) rebuildGroup(evt.to);
                        _urlSet = null;
                        saveData();
                    }
                }));
            });
        }
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

        pushUndo();

        for (const item of newItems) {
            const existing = items.find(o => o.url === item.url);
            item.icon = existing?.icon || await fetchFaviconBase64(item.url);
            item.addedAt = existing?.addedAt || Date.now();
        }

        const page = getCurPage();
        if (newName !== gTitle) {
            if (page[newName]) { alert('이미 존재하는 그룹 이름입니다.'); return; }
            const oldKey = collapseKey(gTitle);
            const wasCollapsed = _collapsedGroups.has(oldKey);
            const rebuilt = {};
            for (const key of Object.keys(page)) {
                rebuilt[key === gTitle ? newName : key] = key === gTitle ? newItems : page[key];
            }
            db.pages[db.currentPage] = rebuilt;
            _collapsedGroups.delete(oldKey);
            if (wasCollapsed) _collapsedGroups.add(collapseKey(newName));
            GM_setValue('bm_collapsed', JSON.stringify([..._collapsedGroups]));
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
        const listEl = el('div', { class: 'bm-scroll-list bm-mt-10' });
        if (items.length === 0) {
            listEl.appendChild(el('div', {
                text: '북마크가 없습니다. 아래 버튼으로 추가하세요.',
                style: { color: '#999', fontSize: '13px', textAlign: 'center', padding: '20px' }
            }));
        }
        items.forEach(it => listEl.appendChild(createItemRow({ name: it.name, url: it.url })));
        content.append(gNameInput, listEl,
            btn('+ 북마크 추가', 'bm-btn-blue', () => { listEl.appendChild(createItemRow({ isNew: true })); listEl.scrollTop = listEl.scrollHeight; }, { width: '100%', marginTop: '10px', padding: '10px' }),
            btn('📌 현재 페이지 추가', 'bm-btn-green', () => { listEl.appendChild(createItemRow({ name: document.title.substring(0, 30), url: window.location.href })); listEl.scrollTop = listEl.scrollHeight; }, { width: '100%', marginTop: '5px', padding: '10px' })
        );
        const btnRow = el('div', { class: 'bm-flex-row bm-mt-20' });
        btnRow.append(
            btn('저장', 'bm-btn-green', () => saveGroupEdits(gTitle, gNameInput, listEl, items, modalBg), { flex: '2', padding: '12px' }),
            btn('닫기', '', () => modalBg.close(), { flex: '1', background: '#999', padding: '12px' })
        );
        content.append(btnRow, btn('🗑 그룹 삭제', 'bm-btn-red', () => {
            if (items.length > 0 && !confirm(`"${gTitle}" 그룹(${items.length}개 북마크 포함)을 삭제하시겠습니까?`)) return;
            pushUndo();
            delete getCurPage()[gTitle];
            _urlSet = null;
            saveData();
            renderDashboard();
            modalBg.close();
        }, { width: '100%', marginTop: '10px', padding: '10px' }));
        modalBg.appendChild(content);
        showModal(modalBg);

        modalBg.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'Enter') {
                e.preventDefault();
                saveGroupEdits(gTitle, gNameInput, listEl, items, modalBg);
            }
        });

        sortableInstance = new Sortable(listEl, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ═══════════════════════════════════
       탭 관리
       ═══════════════════════════════════ */
    function deleteTab(tn, modalBg) {
        if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; }
        if (!confirm(`"${tn}" 탭을 삭제하시겠습니까?`)) return;
        pushUndo();
        delete db.pages[tn];
        if (db.currentPage === tn) db.currentPage = Object.keys(db.pages)[0];
        _urlSet = null;
        saveData();
        modalBg.close();
        renderDashboard();
    }

    function renameTab(tn, renderList) {
        const nn = prompt('새 탭 이름:', tn);
        if (!nn || nn === tn) return;
        const err = validateName(nn, Object.keys(db.pages));
        if (err) { alert(err); return; }
        const nps = {};
        for (const k of Object.keys(db.pages)) nps[k === tn ? nn.trim() : k] = db.pages[k];
        db.pages = nps;
        if (db.currentPage === tn) db.currentPage = nn.trim();
        saveData();
        renderList();
        renderDashboard();
    }

    function showTabManager() {
        const modalBg = createModal();
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '📂 탭 관리', style: { marginTop: '0' } }));
        const list = el('div', { class: 'bm-scroll-list' });
        const renderList = () => {
            list.replaceChildren();
            Object.keys(db.pages).forEach(tn => {
                const row = el('div', { class: 'tab-manage-row' });
                row.append(
                    el('span', { text: tn, style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
                    el('div', { style: { display: 'flex', gap: '4px', flexShrink: '0' } }, [
                        btn('이름변경', 'bm-btn-blue', () => renameTab(tn, renderList), { padding: '4px 8px' }),
                        btn('삭제', 'bm-btn-red', () => deleteTab(tn, modalBg), { padding: '4px 8px' })
                    ])
                );
                list.appendChild(row);
            });
        };
        renderList();
        content.append(
            list,
            btn('+ 새 탭 추가', 'bm-btn-blue', () => {
                const n = prompt('새 탭 이름:');
                const err = validateName(n, Object.keys(db.pages));
                if (err) { if (n) alert(err); return; }
                db.pages[n.trim()] = {};
                db.currentPage = n.trim();
                saveData();
                renderDashboard();
                modalBg.close();
            }, { width: '100%', marginTop: '15px', padding: '12px' }),
            btn('닫기', '', () => modalBg.close(), { width: '100%', marginTop: '10px', background: '#999', padding: '10px' })
        );
        modalBg.appendChild(content);
        showModal(modalBg);
    }

    /* ═══════════════════════════════════
       빠른 추가 공통 저장
       ═══════════════════════════════════ */
    async function saveBookmarkTo(page, group, name, url, modalBg) {
        if (!name || !name.trim()) { alert('이름을 입력하세요.'); return; }
        const cleanedUrl = cleanUrl(url.trim());
        if (!isValidUrl(cleanedUrl)) { alert('올바른 URL을 입력하세요.'); return; }
        pushUndo();
        const icon = await fetchFaviconBase64(cleanedUrl);
        if (!db.pages[page][group]) db.pages[page][group] = [];
        db.pages[page][group].push({ name: name.trim(), url: cleanedUrl, icon, addedAt: Date.now() });
        addToUrlSet(cleanedUrl);
        setRecentGroup(page, group);
        saveData();
        modalBg.close();
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (overlay?.style.display === 'block') renderDashboard();
        updateFabIndicator();
        showToast('✅ 저장됨');
    }

    /* ═══════════════════════════════════
       그룹 선택 렌더러 (퀵 추가 모달용)
       ═══════════════════════════════════ */
    function renderGroupSelector(targetEl, page, nameGetter, urlGetter, modalBg) {
        targetEl.replaceChildren(
            el('p', { text: `그룹 선택 (${page}):`, style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } })
        );
        const col = el('div', { class: 'bm-flex-col' });
        Object.keys(db.pages[page]).forEach(g => {
            col.appendChild(btn(`📁 ${g}`, '',
                () => saveBookmarkTo(page, g, nameGetter(), urlGetter(), modalBg),
                { background: 'var(--c-bg)', color: 'var(--c-text)', justifyContent: 'flex-start', padding: '12px' }
            ));
        });
        col.appendChild(btn('+ 새 그룹 생성', '', async () => {
            const n = prompt("새 그룹 이름:");
            const err = validateName(n, Object.keys(db.pages[page]));
            if (err) { if (n) alert(err); return; }
            await saveBookmarkTo(page, n.trim(), nameGetter(), urlGetter(), modalBg);
        }, { background: 'var(--c-dark)', color: '#fff', padding: '12px' }));
        targetEl.appendChild(col);
    }

    /* ═══════════════════════════════════
       빠른 추가 모달
       ═══════════════════════════════════ */
    let _titleFetchAbort = null;

    function showQuickAddModal() {
        const existing = shadow.querySelector('#bm-quick-modal');
        if (existing) existing.remove();

        const modalBg = createModal('bm-quick-modal');
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '🔖 북마크 저장', style: { marginTop: '0' } }));

        const cleanedCurrentUrl = cleanUrl(window.location.href);

        if (isUrlDuplicate(cleanedCurrentUrl)) {
            const locs = findUrlLocations(cleanedCurrentUrl);
            content.appendChild(el('div', {
                text: `⚠ 이미 저장됨: ${locs.join(', ')}`,
                style: { color: 'var(--c-warning)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }
        content.append(el('label', { text: '이름' }));
        const ni = el('input', { type: 'text', value: document.title.substring(0, 30) });
        content.append(ni, el('label', { text: '주소 (URL)' }));
        const ui = el('input', { type: 'text', value: cleanedCurrentUrl });
        content.appendChild(ui);

        /* URL 변경 시 자동 제목 가져오기 */
        ui.addEventListener('change', () => {
            const newUrl = ui.value.trim();
            if (!isValidUrl(newUrl) || ni.dataset.manualEdit) return;

            const fetchId = Symbol();
            _titleFetchAbort = fetchId;

            GM_xmlhttpRequest({
                method: 'GET', url: newUrl, timeout: 5000,
                headers: { 'Accept': 'text/html' },
                onload: (res) => {
                    if (_titleFetchAbort !== fetchId) return;
                    const match = res.responseText?.match(/<title[^>]*>([^<]+)<\/title>/i);
                    if (match?.[1] && ni.value === document.title.substring(0, 30)) {
                        ni.value = match[1].trim().substring(0, 30);
                    }
                }
            });
        });
        ni.addEventListener('input', () => { ni.dataset.manualEdit = '1'; });

        const area = el('div');
        const groupArea = el('div');
        const recent = getRecentGroup();

        if (recent && db.pages[recent.page]?.[recent.group]) {
            area.append(
                el('p', { text: `최근 저장: ${recent.page} > ${recent.group}`, style: { fontSize: '11px', color: '#999', marginTop: '10px', marginBottom: '2px' } }),
                btn(`⚡ ${recent.page} > ${recent.group}에 바로 저장`, 'bm-btn-blue',
                    () => saveBookmarkTo(recent.page, recent.group, ni.value, ui.value, modalBg),
                    { width: '100%', marginTop: '2px', padding: '10px' })
            );
        }

        /* 도메인 기반 그룹 추천 */
        const domainSuggestion = suggestGroup(cleanedCurrentUrl);
        if (domainSuggestion && domainSuggestion !== recent?.group) {
            area.append(
                el('p', {
                    text: `💡 같은 도메인 북마크가 "${domainSuggestion}"에 있습니다`,
                    style: { fontSize: '11px', color: 'var(--c-primary)', marginTop: '5px' }
                }),
                btn(`📁 ${domainSuggestion}에 저장`, 'bm-btn-blue',
                    () => saveBookmarkTo(db.currentPage, domainSuggestion, ni.value, ui.value, modalBg),
                    { width: '100%', marginTop: '2px', padding: '10px' })
            );
        }

        const handleEnterSave = (e) => {
            if (e.key === 'Enter' && recent && db.pages[recent.page]?.[recent.group]) {
                e.preventDefault();
                saveBookmarkTo(recent.page, recent.group, ni.value, ui.value, modalBg);
            }
        };
        ni.addEventListener('keydown', handleEnterSave);
        ui.addEventListener('keydown', handleEnterSave);

        const pageKeys = Object.keys(db.pages);
        if (pageKeys.length === 1) {
            renderGroupSelector(groupArea, pageKeys[0], () => ni.value, () => ui.value, modalBg);
        } else {
            area.appendChild(el('p', { text: '탭 선택:', style: { fontSize: '12px', fontWeight: 'bold', marginTop: '15px' } }));
            const tabBtns = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px' } });
            pageKeys.forEach(p => {
                tabBtns.appendChild(btn(p, '', () => {
                    renderGroupSelector(groupArea, p, () => ni.value, () => ui.value, modalBg);
                }, { background: '#eee', color: '#333' }));
            });
            area.appendChild(tabBtns);
        }

        area.appendChild(groupArea);
        content.appendChild(area);
        content.appendChild(el('button', { text: '취소', style: { width: '100%', border: '0', background: 'none', marginTop: '20px', color: '#999', cursor: 'pointer' }, onclick: () => modalBg.close() }));
        modalBg.appendChild(content);
        showModal(modalBg);
        setTimeout(() => ni.focus(), 50);
    }

    /* ═══════════════════════════════════
       FAB 인디케이터 + 배지
       ═══════════════════════════════════ */
    function updateFabIndicator() {
        const fab = shadow?.querySelector('#bookmark-fab');
        if (!fab || shadow.querySelector('#bookmark-overlay')?.style.display === 'block') return;

        const url = window.location.href;
        const locs = findUrlLocations(url);
        const count = locs.length;

        fab.querySelector('.bm-fab-badge')?.remove();

        if (count > 0) {
            fab.style.outline = '3px solid var(--c-success)';
            fab.style.outlineOffset = '2px';
            fab.appendChild(el('span', {
                class: 'bm-fab-badge',
                text: count > 9 ? '9+' : String(count)
            }));
        } else {
            fab.style.outline = 'none';
        }
    }

    /* ═══════════════════════════════════
       FAB 토글
       ═══════════════════════════════════ */
    function toggleOverlay(overlay, fab) {
        const isVisible = overlay.style.display === 'block';
        if (!isVisible) {
            renderDashboard();
            document.body.classList.add('bm-overlay-open');
            overlay.style.display = 'block';
            fab.childNodes[0].textContent = '✕';
        } else {
            document.body.classList.remove('bm-overlay-open');
            overlay.style.display = 'none';
            fab.childNodes[0].textContent = '🔖';
            destroyAllSortables();
            _currentContainer = null;
            if (_faviconObserver) { _faviconObserver.disconnect(); _faviconObserver = null; }
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
            sx: 0, sy: 0, ox: 0, oy: 0,
            lastX: 0, lastY: 0,
            lastTap: 0
        };

        function endDrag() {
            fab.style.transition = '';
            fab.style.bottom = 'auto';
            fab.style.willChange = '';
            const snapRight = fab.getBoundingClientRect().left + (fab.offsetWidth / 2) > innerWidth / 2;
            fab.style.left = snapRight ? 'auto' : '15px';
            fab.style.right = snapRight ? '15px' : 'auto';
            st.dragging = false;
            st.dragReady = false;
            fab.style.cursor = 'pointer';
            fab.style.boxShadow = '';
            st.lastTap = 0;
        }

        function resetDragReady() {
            st.dragReady = false;
            fab.style.cursor = 'pointer';
            fab.style.boxShadow = '';
            fab.style.willChange = '';
            st.lastTap = 0;
        }

        function isSwipeUp() {
            const dy = st.sy - st.lastY;
            const dx = Math.abs(st.lastX - st.sx);
            return dy > 50 && dx < 40;
        }

        fab.addEventListener('pointerup', (e) => {
            clearTimeout(st.timer);
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe-hint')?.remove();

            if (st.dragging) { endDrag(); return; }
            if (st.dragReady) { resetDragReady(); return; }

            if (isSwipeUp()) {
                st.lastTap = 0;
                showQuickAddModal();
                return;
            }

            const now = Date.now();
            if (now - st.lastTap < 350) {
                st.lastTap = 0;
                showQuickAddModal();
            } else {
                st.lastTap = now;
                setTimeout(() => {
                    if (st.lastTap !== 0 && Date.now() - st.lastTap >= 340) {
                        st.lastTap = 0;
                        toggleOverlay(overlay, fab);
                    }
                }, 350);
            }
        });

        fab.addEventListener('pointerdown', (e) => {
            fab.setPointerCapture(e.pointerId);
            st.sx = e.clientX; st.sy = e.clientY;
            st.lastX = e.clientX; st.lastY = e.clientY;
            const rect = fab.getBoundingClientRect();
            st.ox = e.clientX - rect.left; st.oy = e.clientY - rect.top;
            st.dragReady = false;
            st.dragging = false;

            st.timer = setTimeout(() => {
                st.dragReady = true;
                fab.style.willChange = 'transform, left, top';
                if (e.pointerType === 'touch') navigator.vibrate?.(40);
                fab.style.cursor = 'grabbing';
                fab.style.boxShadow = '0 6px 20px rgba(0,0,0,0.5)';
            }, 500);
        });

        fab.addEventListener('pointermove', (e) => {
            st.lastX = e.clientX;
            st.lastY = e.clientY;

            if (!st.dragReady) {
                const dist = Math.hypot(e.clientX - st.sx, e.clientY - st.sy);
                if (dist > 10) clearTimeout(st.timer);

                const dy = st.sy - e.clientY;
                let hint = shadow.querySelector('#bm-swipe-hint');
                if (dy > 20 && Math.abs(e.clientX - st.sx) < 40) {
                    if (!hint) {
                        hint = el('div', { id: 'bm-swipe-hint', text: '＋' });
                        shadow.appendChild(hint);
                    }
                    const fabRect = fab.getBoundingClientRect();
                    hint.style.left = (fabRect.left + fabRect.width / 2 - 15) + 'px';
                    hint.style.top = (fabRect.top - 40) + 'px';
                    hint.style.opacity = Math.min(1, (dy - 20) / 30);
                } else {
                    hint?.remove();
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
            try { fab.releasePointerCapture(e.pointerId); } catch {}
            shadow.querySelector('#bm-swipe-hint')?.remove();
            st.dragReady = false;
            st.dragging = false;
            fab.style.cursor = 'pointer';
            fab.style.boxShadow = '';
            fab.style.willChange = '';
            st.lastTap = 0;
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
                    if (!popUndo()) showToast('되돌릴 내역이 없습니다.');
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
       호스트 페이지 스타일 주입
       ═══════════════════════════════════ */
    function injectHostStyle() {
        if (document.getElementById('bm-host-style')) return;
        const s = document.createElement('style');
        s.id = 'bm-host-style';
        s.textContent = 'body.bm-overlay-open { overflow: hidden !important; }';
        document.head.appendChild(s);
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
                --c-overlay-bg: rgba(255,255,255,0.98);
                --c-input-bg: var(--c-surface);
                --c-input-border: var(--c-border);
                --c-tab-bg: #eee;
                --c-tab-text: #666;
                --radius: 8px;
                --fab-size: 46px;
                --fab-offset: 20px;
                --modal-max-w: min(420px, calc(100vw - 32px));
                --grid-min: 300px;
                --grid-max: 1200px;
                --item-min: 80px;
                --icon-size: 32px;
                color-scheme: light dark;
            }

            @media (min-width: 769px) {
                :host {
                    --item-min: 90px;
                    --icon-size: 40px;
                }
            }

            @media (max-width: 768px) {
                :host { --fab-size: 40px; }
                #bookmark-fab { font-size: 20px !important; }
            }

            @media (prefers-color-scheme: dark) {
                :host {
                    --c-dark: #e0e0e0;
                    --c-bg: #1e1e1e;
                    --c-surface: #2a2a2a;
                    --c-text: #e0e0e0;
                    --c-border: #444;
                    --c-overlay-bg: rgba(30,30,30,0.98);
                    --c-input-bg: #333;
                    --c-input-border: #555;
                    --c-tab-bg: #444;
                    --c-tab-text: #ccc;
                }
            }

            * { box-sizing: border-box; font-family: sans-serif; }

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
                box-shadow: 0 2px 8px rgba(0,0,0,0.3), 0 6px 20px rgba(0,0,0,0.15);
                font-size: 22px;
                user-select: none;
                touch-action: none;
                -webkit-tap-highlight-color: transparent;
                border: none;
                transition: left 0.2s ease, right 0.2s ease, top 0.2s ease, box-shadow 0.2s;
                overflow: visible;
            }

            #bookmark-fab:hover {
                box-shadow: 0 4px 12px rgba(0,0,0,0.4), 0 8px 28px rgba(0,0,0,0.2);
            }

            .bm-fab-badge {
                position: absolute;
                top: -4px;
                right: -4px;
                background: var(--c-danger);
                color: white;
                font-size: 10px;
                font-weight: bold;
                min-width: 16px;
                height: 16px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 4px;
                line-height: 1;
                pointer-events: none;
            }

            #bm-swipe-hint {
                position: fixed;
                width: 30px;
                height: 30px;
                background: var(--c-primary);
                color: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                font-weight: bold;
                pointer-events: none;
                transition: opacity 0.1s;
                z-index: 2147483647;
            }

            #bookmark-overlay {
                position: fixed;
                top: 0; left: 0;
                width: 100vw; height: 100vh;
                background: var(--c-overlay-bg);
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
            .bm-btn-blue:hover  { background: color-mix(in srgb, white 15%, var(--c-primary)); }
            .bm-btn-green:hover { background: color-mix(in srgb, white 15%, var(--c-success)); }
            .bm-btn-red:hover   { background: color-mix(in srgb, white 15%, var(--c-danger)); }

            .bm-icon-btn {
                width: 34px;
                height: 34px;
                padding: 0;
                font-size: 16px;
                border-radius: 8px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                color: #fff;
                background: var(--c-dark);
                border: none;
            }
            .bm-icon-btn:hover { filter: brightness(1.15); }
            .bm-icon-btn:active { filter: brightness(0.9); transform: scale(0.97); }

            input {
                width: 100%;
                padding: 10px;
                margin: 5px 0;
                border: 1px solid var(--c-input-border);
                background-color: var(--c-input-bg);
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

            .bm-top-row {
                max-width: var(--grid-max);
                margin: 0 auto 10px auto;
                display: flex;
                flex-direction: column;
                gap: 8px;
                position: sticky;
                top: 0;
                z-index: 100;
                background: var(--c-surface);
                padding: 10px 0 5px;
                border-bottom: 1px solid var(--c-border);
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
                margin: 0 !important;
                border: 1px solid var(--c-border) !important;
                background: var(--c-surface) !important;
                color: var(--c-text) !important;
                border-radius: 6px !important;
            }

            .bm-search-input::-webkit-search-cancel-button {
                -webkit-appearance: searchfield-cancel-button;
                cursor: pointer;
            }

            .bm-tab-bar {
                display: flex;
                gap: 5px;
                overflow-x: auto;
                -webkit-overflow-scrolling: touch;
                padding-bottom: 5px;
                width: 100%;
                mask-image: linear-gradient(90deg, transparent, #000 8px, #000 calc(100% - 8px), transparent);
                -webkit-mask-image: linear-gradient(90deg, transparent, #000 8px, #000 calc(100% - 8px), transparent);
            }

            .bm-tab {
                padding: 8px 14px;
                background: var(--c-tab-bg);
                border-radius: var(--radius) var(--radius) 0 0;
                cursor: pointer;
                font-size: 13px;
                font-weight: bold;
                color: var(--c-tab-text);
                white-space: nowrap;
                flex-shrink: 0;
                border-bottom: 3px solid transparent;
                transition: border-color 0.2s, background 0.2s;
                -webkit-tap-highlight-color: transparent;
                touch-action: manipulation;
                user-select: none;
            }
            .bm-tab.active {
                background: var(--c-surface);
                color: var(--c-primary);
                border-bottom-color: var(--c-primary);
            }
            .bm-tab:hover:not(.active) {
                background: color-mix(in srgb, var(--c-primary) 10%, var(--c-bg));
                border-bottom-color: color-mix(in srgb, var(--c-primary) 30%, transparent);
            }

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
                content-visibility: auto;
                contain-intrinsic-size: auto 200px;
            }

            .bm-section-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 14px;
                background: var(--c-bg);
                position: relative;
                gap: 8px;
                min-height: 44px;
            }

            .bm-section-header::after {
                content: '';
                position: absolute;
                bottom: 0;
                left: 0;
                height: 2px;
                background: var(--c-primary);
                width: var(--fill, 0%);
                transition: width 0.3s;
            }

            .bm-section-header span { cursor: pointer; }
            .bm-section-header span:hover { opacity: 0.7; }

            .bm-group-count {
                font-weight: normal;
                font-size: 12px;
                color: #999;
            }

            .bm-section-header:has(+ .bm-item-grid[style*="display: none"]) .bm-group-count {
                background: var(--c-primary);
                color: white;
                padding: 1px 6px;
                border-radius: 10px;
                font-size: 11px;
            }

            .bm-group-warning {
                font-size: 10px;
                color: var(--c-warning);
                margin-left: 4px;
            }

            .bm-manage-btn {
                border: 1px solid var(--c-border);
                background: var(--c-surface);
                color: var(--c-text);
                padding: 6px 12px;
                border-radius: 6px;
                font-weight: bold;
                cursor: pointer;
                font-size: 12px;
                min-height: 32px;
                min-width: 44px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s;
            }

            .bm-manage-btn:active {
                background: var(--c-bg);
                transform: scale(0.96);
            }

            .bm-quick-group-add {
                width: 32px;
                height: 32px;
                min-width: 32px;
                border-radius: 50%;
                border: 1px solid var(--c-border);
                background: var(--c-surface);
                color: var(--c-primary);
                font-size: 16px;
                font-weight: bold;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-left: auto;
                margin-right: 8px;
                transition: background 0.15s;
                line-height: 1;
                padding: 0;
            }
            .bm-quick-group-add:hover {
                background: var(--c-primary);
                color: white;
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

            .bm-empty-group {
                grid-column: 1 / -1;
                text-align: center;
                color: #bbb;
                font-size: 12px;
                padding: 25px 15px;
                font-style: italic;
                border: 2px dashed var(--c-border);
                border-radius: var(--radius);
                margin: 5px;
            }

            .sort-mode-active .bm-item-grid { display: none; }
            .sort-mode-active .bm-bookmark-section {
                border: 2px dashed var(--c-primary);
                cursor: move;
                margin-bottom: 5px;
            }
            .sort-mode-active .bm-section-header { cursor: grab; }
            .sort-mode-active .bm-dashboard-container { grid-template-columns: 1fr; }

            .bm-item-grid .sortable-ghost {
                opacity: 0.4;
                background: color-mix(in srgb, var(--c-primary) 20%, transparent);
                border-radius: var(--radius);
            }

            dialog.bm-modal-bg {
                background: transparent;
                border: none;
                padding: 0;
                margin: auto;
                max-width: 100vw;
                max-height: 100vh;
                overflow: visible;
            }
            dialog.bm-modal-bg::backdrop { background: rgba(0,0,0,0.6); }

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

            .bm-admin-menu {
                background: var(--c-surface);
                border: 1px solid var(--c-border);
                border-radius: var(--radius);
                box-shadow: 0 4px 16px rgba(0,0,0,0.15);
                min-width: 180px;
                overflow: hidden;
            }
            .bm-admin-menu-item {
                padding: 12px 16px;
                font-size: 13px;
                cursor: pointer;
                color: var(--c-text);
                display: flex;
                align-items: center;
                gap: 8px;
                transition: background 0.1s;
            }
            .bm-admin-menu-item:hover { background: var(--c-bg); }
            .bm-admin-menu-item:active { background: color-mix(in srgb, var(--c-primary) 15%, var(--c-bg)); }

            .bm-global-search-results {
                background: var(--c-surface);
                border: 2px solid var(--c-primary);
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            }

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

            .bm-toast {
                position: fixed;
                bottom: 80px;
                left: 50%;
                transform: translateX(-50%) translateY(20px);
                background: rgba(0,0,0,0.85);
                color: #fff;
                padding: 10px 24px;
                border-radius: 20px;
                font-size: 13px;
                opacity: 0;
                transition: opacity 0.3s, transform 0.3s;
                pointer-events: none;
                z-index: 999999;
                white-space: nowrap;
                backdrop-filter: blur(8px);
            }
            .bm-toast.show {
                opacity: 1;
                transform: translateX(-50%) translateY(0);
            }

            .bm-shortcut-hint {
                max-width: var(--grid-max);
                margin: 20px auto 10px;
                text-align: center;
                font-size: 11px;
                color: #999;
                user-select: none;
            }

            @media (max-width: 768px) {
                .bm-shortcut-hint { display: none; }
            }

            @media (hover: none) and (pointer: coarse) {
                .bm-shortcut-hint { display: none; }
            }

            .bm-flex-row { display: flex; gap: 10px; align-items: center; }
            .bm-flex-col { display: flex; flex-direction: column; gap: 5px; }
            .bm-mt-10 { margin-top: 10px; }
            .bm-mt-20 { margin-top: 20px; }
            .bm-scroll-list {
                max-height: 40vh;
                overflow-y: auto;
                border: 1px solid var(--c-border);
                border-radius: 8px;
                padding: 10px;
            }
        `;
    }

    /* ═══════════════════════════════════
       초기화
       ═══════════════════════════════════ */
    function init() {
        injectHostStyle();

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
        if ('onfreeze' in document) {
            document.addEventListener('freeze', saveDataNow);
        }

        updateFabIndicator();
    }

    init();
})();
