// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v11.0)
// @version      11.0
// @description  v10.0 기반 – 버그수정, 파비콘캐시, dialog개선, FAB리팩, 중복감지, 메모리누수수정
// @author       User
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js
// @noframes
// ==/UserScript==

(function() {
    'use strict';
    if (window.self !== window.top) return;

    /* ── 유틸리티 ── */
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
        for (const c of children) e.append(c);
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
    const setHtml = (element, html) => { element.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html; };

    /* ── DB 무결성 검증 ── */
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

    /* ── URL 중복 체크 ── */
    function isUrlDuplicate(url) {
        for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items)
                    if (item.url === url) return true;
        return false;
    }

    /* ── DB 로드 ── */
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

    /* ── 저장 ── */
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
    let activeSortable = null;

    /* ── 파비콘 (캐시 + blob 방식) ── */
    const fallbackIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";
    const _faviconCache = new Map();

    function fetchFaviconBase64(url) {
        return new Promise((resolve) => {
            try {
                const hostname = new URL(url).hostname;
                if (_faviconCache.has(hostname)) { resolve(_faviconCache.get(hostname)); return; }
                const iconUrl = `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;
                GM_xmlhttpRequest({
                    method: "GET", url: iconUrl, responseType: "blob",
                    onload: (res) => {
                        if (res.status !== 200 || !res.response) { resolve(fallbackIcon); return; }
                        const reader = new FileReader();
                        reader.onloadend = () => {
                            const result = reader.result || fallbackIcon;
                            _faviconCache.set(hostname, result);
                            resolve(result);
                        };
                        reader.onerror = () => resolve(fallbackIcon);
                        reader.readAsDataURL(res.response);
                    },
                    onerror: () => resolve(fallbackIcon)
                });
            } catch { resolve(fallbackIcon); }
        });
    }

    let shadow = null;

    /* ── 모달 ── */
    function createModal(id = '', { preventEscape = false } = {}) {
        const dialog = document.createElement('dialog');
        if (id) dialog.id = id;
        dialog.className = 'bm-modal-bg';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
        dialog.addEventListener('close', () => dialog.remove());
        if (preventEscape) dialog.addEventListener('cancel', (e) => e.preventDefault());
        return dialog;
    }
    function showModal(modal) {
        shadow.appendChild(modal);
        modal.showModal();
        return modal;
    }

    /* ── 아이콘 전체 복구 ── */
    async function fixAllIcons() {
        if (!confirm("모든 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?")) return;
        const modalBg = createModal('', { preventEscape: true });
        const content = el('div', { class: 'bm-modal-content', style: { textAlign:'center' } });
        const statusEl = el('div', { text: '아이콘 업데이트 중...' });
        content.appendChild(statusEl);
        modalBg.appendChild(content);
        showModal(modalBg);

        _faviconCache.clear();
        const allItems = [];
        for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items) allItems.push(item);

        const BATCH = 5;
        for (let i = 0; i < allItems.length; i += BATCH) {
            await Promise.all(allItems.slice(i, i + BATCH).map(async item => { item.icon = await fetchFaviconBase64(item.url); }));
            statusEl.textContent = `아이콘 업데이트 중... ${Math.min(i + BATCH, allItems.length)} / ${allItems.length}`;
        }
        saveDataNow(); modalBg.close(); alert("복구 완료!"); renderDashboard();
    }

    /* ── 백업/복구 ── */
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
                    saveDataNow(); renderDashboard(); alert('복구 완료!');
                } catch { alert('잘못된 파일입니다.'); }
            };
            r.readAsText(file);
        };
        inp.click();
    }

    /* ── 아이템 행 ── */
    function createItemRow({ name = '', url = 'https://', isNew = false } = {}) {
        const row = el('div', { class: 'e-r', style: { borderBottom:'1px solid var(--c-border)', padding:'10px 0', display:'flex', gap:'10px', alignItems:'center' } });
        const handle = el('span', { class: 'bm-drag-handle', text: '☰' });
        const body = el('div', { style: { flex: '1' } });
        const delRow = el('div', { style: { display:'flex', justifyContent:'flex-end' } });
        delRow.appendChild(el('span', { text: '삭제', style: { color:'red', cursor:'pointer', fontSize:'11px' }, onclick: () => row.remove() }));
        const nameInput = el('input', { type:'text', class:'r-n', value: name, placeholder: isNew ? '새 북마크 이름' : '이름', style: { marginBottom:'5px' } });
        const urlInput = el('input', { type:'text', class:'r-u', value: url, placeholder:'URL' });
        body.append(delRow, nameInput, urlInput);
        row.append(handle, body);
        return row;
    }

    /* ── 대시보드 렌더링 ── */
    let _searchTimer = null;

    function renderDashboard() {
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (!overlay) return;
        overlay.className = isSortMode ? 'sort-mode-active' : '';
        overlay.replaceChildren();

        const topRow = el('div', { class: 'bm-top-row' });

        // 탭 바
        const tabBar = el('div', { class: 'bm-tab-bar', onclick: (e) => {
            const tab = e.target.closest('.bm-tab');
            if (!tab) return;
            db.currentPage = tab.textContent;
            isSortMode = false;
            renderDashboard();
        }});
        Object.keys(db.pages).forEach(p => {
            tabBar.appendChild(el('div', { class: `bm-tab ${db.currentPage === p ? 'active' : ''}`, text: p }));
        });

        // 관리 바
        const adminBar = el('div', { class: 'bm-admin-bar' });
        const searchInput = el('input', {
            type: 'text', placeholder: '검색...',
            style: { maxWidth:'150px', padding:'6px 10px', fontSize:'13px', display:'inline-block', margin:'0 auto 0 0', border:'1px solid var(--c-border)', background:'var(--c-surface)', color:'var(--c-text)', borderRadius:'6px' },
            oninput: () => {
                clearTimeout(_searchTimer);
                _searchTimer = setTimeout(() => {
                    const q = searchInput.value.toLowerCase();
                    shadow.querySelectorAll('.bm-item-wrapper').forEach(w => {
                        const name = w.querySelector('span')?.textContent.toLowerCase() || '';
                        const url = (w.getAttribute('href') || '').toLowerCase();
                        w.style.display = (name.includes(q) || url.includes(q)) ? '' : 'none';
                    });
                }, 150);
            }
        });

        adminBar.append(
            searchInput,
            btn(isSortMode ? '완료' : '정렬', 'bm-btn-blue', () => { isSortMode = !isSortMode; renderDashboard(); }),
            btn('아이콘 복구', 'bm-btn-orange', fixAllIcons),
            btn('탭관리', '', showTabManager),
            btn('그룹+', '', () => { const n = prompt("새 그룹 이름:"); if(n){ getCurPage()[n]=[]; saveData(); renderDashboard(); }}),
            btn('백업', '', exportData),
            btn('복구', 'bm-btn-green', importData),
        );

        topRow.append(adminBar, tabBar);
        overlay.appendChild(topRow);

        // 컨테이너
        const container = el('div', { class: 'bm-dashboard-container', onclick: (e) => {
            const mbtn = e.target.closest('.bm-manage-btn');
            if (!mbtn) return;
            const sec = mbtn.closest('.bm-bookmark-section');
            if (sec) showGroupManager(sec.getAttribute('data-id'));
        }});

        Object.entries(getCurPage()).forEach(([gTitle, items]) => {
            const section = el('div', { class: 'bm-bookmark-section', 'data-id': gTitle });
            const header = el('div', { class: 'bm-section-header' });
            header.appendChild(el('span', { text: `${isSortMode ? '≡' : '📁'} ${gTitle}`, style: { fontWeight:'bold', fontSize:'14px' } }));
            if (!isSortMode) header.appendChild(el('button', { class: 'bm-manage-btn', text: '관리' }));
            section.appendChild(header);

            const grid = el('div', { class: 'bm-item-grid', 'data-group': gTitle });
            items.forEach(item => {
                const wrapper = el('a', { class: 'bm-item-wrapper', href: item.url, target: '_blank' });
                const div = el('div', { class: 'bm-bookmark-item' });
                const img = el('img', { loading: 'lazy', decoding: 'async' });
                img.src = item.icon?.startsWith('data:') ? item.icon : fallbackIcon;
                div.append(img, el('span', { text: item.name }));
                wrapper.appendChild(div);
                grid.appendChild(wrapper);
            });

            section.appendChild(grid);
            container.appendChild(section);
        });
        overlay.appendChild(container);

        // Sortable
        if (activeSortable) { activeSortable.destroy(); activeSortable = null; }
        if (isSortMode) {
            activeSortable = new Sortable(container, { animation: 150, onEnd: () => {
                const curPage = getCurPage();
                const newOrder = {};
                container.querySelectorAll('.bm-bookmark-section').forEach(sec => {
                    const id = sec.getAttribute('data-id');
                    if (curPage[id]) newOrder[id] = curPage[id];
                });
                db.pages[db.currentPage] = newOrder; saveData();
            }});
        }
    }

    /* ── 그룹 관리 모달 ── */
    function showGroupManager(gTitle) {
        const modalBg = createModal();
        const items = getCurPage()[gTitle];
        const content = el('div', { class: 'bm-modal-content' });

        content.appendChild(el('h3', { text: '🛠 그룹 관리', style: { marginTop: '0' } }));
        content.appendChild(el('label', { text: '그룹 이름' }));
        const gNameInput = el('input', { type:'text', value: gTitle });
        content.appendChild(gNameInput);
        content.appendChild(el('div', { text: '☰ 핸들을 잡고 드래그하여 순서를 변경하세요.', style: { fontSize:'12px', marginTop:'10px', color:'#666' } }));

        const listEl = el('div', { style: { maxHeight:'40vh', overflowY:'auto', border:'1px solid var(--c-border)', borderRadius:'8px', padding:'10px', marginTop:'5px' } });
        items.forEach(it => listEl.appendChild(createItemRow({ name: it.name, url: it.url })));
        content.appendChild(listEl);

        content.appendChild(btn('+ 북마크 추가', 'bm-btn-blue', () => {
            listEl.appendChild(createItemRow({ isNew: true }));
            listEl.scrollTop = listEl.scrollHeight;
        }, { width:'100%', marginTop:'10px', padding:'10px' }));

        content.appendChild(btn('📌 현재 페이지 추가', 'bm-btn-green', () => {
            listEl.appendChild(createItemRow({ name: document.title.substring(0, 30), url: window.location.href }));
            listEl.scrollTop = listEl.scrollHeight;
        }, { width:'100%', marginTop:'5px', padding:'10px' }));

        const btnRow = el('div', { style: { display:'flex', gap:'10px', marginTop:'20px' } });
        btnRow.appendChild(btn('저장', 'bm-btn-green', async () => {
            const newN = gNameInput.value.trim();
            if (!newN) { alert('그룹 이름을 입력하세요.'); return; }
            const newL = [];
            listEl.querySelectorAll('.e-r').forEach(r => {
                const n = r.querySelector('.r-n').value.trim();
                const u = r.querySelector('.r-u').value.trim();
                if (n && u) newL.push({ name: n, url: u });
            });
            for (const newItem of newL) {
                const oldItem = items.find(o => o.url === newItem.url);
                if (oldItem?.icon) newItem.icon = oldItem.icon;
                else newItem.icon = await fetchFaviconBase64(newItem.url);
            }
            if (newN !== gTitle) {
                const page = getCurPage();
                const rebuilt = {};
                for (const key of Object.keys(page)) {
                    rebuilt[key === gTitle ? newN : key] = key === gTitle ? newL : page[key];
                }
                db.pages[db.currentPage] = rebuilt;
            } else {
                getCurPage()[gTitle] = newL;
            }
            saveData(); renderDashboard(); modalBg.close();
        }, { flex:'2', padding:'12px' }));
        btnRow.appendChild(btn('닫기', '', () => modalBg.close(), { flex:'1', background:'#999', padding:'12px' }));
        content.appendChild(btnRow);

        // 그룹 삭제 버튼
        content.appendChild(btn('🗑 그룹 삭제', 'bm-btn-red', () => {
            if (!confirm(`"${gTitle}" 그룹을 삭제하시겠습니까?`)) return;
            delete getCurPage()[gTitle];
            saveData(); renderDashboard(); modalBg.close();
        }, { width:'100%', marginTop:'10px', padding:'10px' }));

        modalBg.appendChild(content);
        showModal(modalBg);
        const sortableInstance = new Sortable(listEl, { handle: '.bm-drag-handle', animation: 150 });
        modalBg.addEventListener('close', () => sortableInstance.destroy());
    }

    /* ── 탭 관리 모달 ── */
    function showTabManager() {
        const modalBg = createModal();
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '📂 탭 관리', style: { marginTop: '0' } }));

        const listContainer = el('div', { style: { maxHeight:'50vh', overflowY:'auto', border:'1px solid var(--c-border)', borderRadius:'8px' } });
        Object.keys(db.pages).forEach(tabName => {
            const row = el('div', { class: 'tab-manage-row' });
            row.appendChild(el('span', { text: tabName }));
            row.appendChild(btn('삭제', 'bm-btn-red', () => {
                if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; }
                if (confirm('삭제?')) {
                    delete db.pages[tabName];
                    if (db.currentPage === tabName) db.currentPage = Object.keys(db.pages)[0];
                    saveData(); renderDashboard(); modalBg.close();
                }
            }, { padding:'4px 8px' }));
            listContainer.appendChild(row);
        });
        content.appendChild(listContainer);

        content.appendChild(btn('+ 새 탭 추가', 'bm-btn-blue', () => {
            const n = prompt("새 탭 이름:");
            if (n && !db.pages[n]) { db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); modalBg.close(); }
            else if (db.pages[n]) alert("중복 이름");
        }, { width:'100%', marginTop:'15px', padding:'12px' }));
        content.appendChild(btn('닫기', '', () => modalBg.close(), { width:'100%', marginTop:'10px', background:'#999', padding:'10px' }));

        modalBg.appendChild(content);
        showModal(modalBg);
    }

    /* ── 빠른 추가 모달 ── */
    function showQuickAddModal() {
        if (shadow.querySelector('#bm-quick-modal')) return;
        const modalBg = createModal('bm-quick-modal');
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '🔖 북마크 저장', style: { marginTop:'0' } }));

        if (isUrlDuplicate(window.location.href)) {
            content.appendChild(el('div', {
                text: '⚠ 이미 저장된 URL입니다',
                style: { color: 'var(--c-warning)', fontSize: '12px', marginBottom: '8px', fontWeight: 'bold' }
            }));
        }

        content.appendChild(el('label', { text: '이름' }));
        const nameInput = el('input', { type:'text', value: document.title.substring(0, 30) });
        content.appendChild(nameInput);
        content.appendChild(el('label', { text: '주소 (URL)' }));
        const urlInput = el('input', { type:'text', value: window.location.href });
        content.appendChild(urlInput);

        const area = el('div');
        area.appendChild(el('p', { text: '탭 선택:', style: { fontSize:'12px', fontWeight:'bold', marginTop:'15px' } }));
        const tabBtns = el('div', { style: { display:'flex', flexWrap:'wrap', gap:'5px' } });
        Object.keys(db.pages).forEach(p => {
            tabBtns.appendChild(btn(p, '', () => showGroupSelect(p), { background:'#eee', color:'#333' }));
        });
        area.appendChild(tabBtns);
        content.appendChild(area);

        content.appendChild(el('button', { text:'취소', style:{ width:'100%', border:'0', background:'none', marginTop:'20px', color:'#999', cursor:'pointer' }, onclick: () => modalBg.close() }));

        function showGroupSelect(selP) {
            area.replaceChildren();
            area.appendChild(el('p', { text: `그룹 선택 (${selP}):`, style: { fontSize:'12px', fontWeight:'bold' } }));
            const col = el('div', { style: { display:'flex', flexDirection:'column', gap:'5px' } });
            Object.keys(db.pages[selP]).forEach(g => {
                col.appendChild(btn(`📁 ${g}`, '', async () => {
                    const icon = await fetchFaviconBase64(urlInput.value);
                    db.pages[selP][g].push({ name: nameInput.value, url: urlInput.value, icon });
                    saveData(); modalBg.close(); alert('저장됨');
                }, { background:'var(--c-bg)', color:'var(--c-text)', justifyContent:'flex-start', padding:'12px' }));
            });
            col.appendChild(btn('+ 새 그룹 생성', '', async () => {
                const n = prompt("새 그룹 이름:");
                if (n) {
                    const icon = await fetchFaviconBase64(urlInput.value);
                    if (!db.pages[selP][n]) db.pages[selP][n] = [];
                    db.pages[selP][n].push({ name: nameInput.value, url: urlInput.value, icon });
                    saveData(); modalBg.close(); alert('저장됨');
                }
            }, { background:'var(--c-dark)', color:'#fff', padding:'12px' }));
            area.appendChild(col);
        }

        modalBg.appendChild(content);
        showModal(modalBg);
    }

    /* ── FAB 인디케이터 ── */
    function updateFabIndicator() {
        const fab = shadow?.querySelector('#bookmark-fab');
        if (!fab || shadow.querySelector('#bookmark-overlay')?.style.display === 'block') return;
        const found = isUrlDuplicate(window.location.href);
        fab.style.outline = found ? '3px solid var(--c-success)' : 'none';
        fab.style.outlineOffset = '2px';
    }

    /* ── FAB 토글 ── */
    function toggleOverlay(overlay, fab) {
        const isVisible = overlay.style.display === 'block';
        if (!isVisible) {
            renderDashboard();
            originalOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            overlay.style.display = 'block';
            fab.textContent = '✕';
        } else {
            document.body.style.overflow = originalOverflow;
            overlay.style.display = 'none';
            fab.textContent = '🔖';
            updateFabIndicator();
        }
    }

    /* ── FAB 이벤트 설정 ── */
    function setupFab(fab, overlay) {
        const st = { timer: 0, longPress: false, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 };

        fab.addEventListener('pointerdown', (e) => {
            fab.setPointerCapture(e.pointerId);
            st.sx = e.clientX; st.sy = e.clientY;
            const rect = fab.getBoundingClientRect();
            st.ox = e.clientX - rect.left; st.oy = e.clientY - rect.top;
            st.longPress = false; st.dragging = false;
            st.timer = setTimeout(() => {
                st.longPress = true;
                if (e.pointerType === 'touch') navigator.vibrate?.(40);
                showQuickAddModal();
            }, 600);
        });

        fab.addEventListener('pointermove', (e) => {
            if (Math.hypot(e.clientX - st.sx, e.clientY - st.sy) > 10) {
                clearTimeout(st.timer);
                st.dragging = true;
                fab.style.transition = 'none';
                fab.style.left = Math.max(0, Math.min(innerWidth - 55, e.clientX - st.ox)) + 'px';
                fab.style.top = Math.max(0, Math.min(innerHeight - 55, e.clientY - st.oy)) + 'px';
                fab.style.right = 'auto'; fab.style.bottom = 'auto';
            }
        });

        fab.addEventListener('pointerup', (e) => {
            clearTimeout(st.timer);
            fab.releasePointerCapture(e.pointerId);
            if (st.dragging) {
                fab.style.transition = '';
                fab.style.bottom = 'auto';
                const snapRight = fab.getBoundingClientRect().left + 27.5 > innerWidth / 2;
                fab.style.left = snapRight ? 'auto' : '15px';
                fab.style.right = snapRight ? '15px' : 'auto';
                return;
            }
            if (!st.longPress) toggleOverlay(overlay, fab);
        });

        fab.addEventListener('pointercancel', (e) => {
            clearTimeout(st.timer);
            fab.releasePointerCapture(e.pointerId);
            st.longPress = false; st.dragging = false;
        });

        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    /* ── 초기화 ── */
    function init() {
        const host = el('div', { id:'bm-script-root', style:{ position:'fixed', zIndex:'2147483647', top:'0', left:'0', width:'0', height:'0', overflow:'visible' } });
        document.body.appendChild(host);
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            :host {
                --c-primary:#007bff; --c-success:#28a745; --c-warning:#fd7e14;
                --c-danger:#dc3545; --c-dark:#333; --c-bg:#f1f3f5;
                --c-surface:#fff; --c-text:#333; --c-border:#ddd; --radius:8px;
                color-scheme: light dark;
            }
            @media (prefers-color-scheme:dark) {
                :host { --c-dark:#e0e0e0; --c-bg:#1e1e1e; --c-surface:#2a2a2a; --c-text:#e0e0e0; --c-border:#444; }
                #bookmark-overlay { background:rgba(30,30,30,0.98)!important; color:var(--c-text)!important; }
                input { background-color:#333!important; color:#eee!important; border-color:#555!important; }
                .bm-tab { background:#444!important; color:#ccc!important; }
                .bm-tab.active { background:var(--c-primary)!important; color:#fff!important; }
            }
            * { box-sizing:border-box; font-family:sans-serif; }
            #bookmark-fab {
                position:fixed; bottom:20px; right:20px; width:55px; height:55px;
                background:var(--c-dark); color:white; border-radius:50%;
                display:flex; align-items:center; justify-content:center;
                cursor:pointer; box-shadow:0 4px 15px rgba(0,0,0,0.4);
                font-size:26px; user-select:none; touch-action:none;
                -webkit-tap-highlight-color:transparent; border:none;
                will-change:transform; transition:left 0.2s ease, right 0.2s ease, top 0.2s ease;
            }
            #bookmark-overlay { position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(255,255,255,0.98); display:none; overflow-y:auto; padding:15px; backdrop-filter:blur(5px); color:var(--c-text); text-align:left; }
            .bm-modal-content,.bm-dashboard-container { color:var(--c-text); text-align:left; background:var(--c-surface); }
            button { outline:none; border:none; font-family:sans-serif; }
            .bm-util-btn,.bm-manage-btn { text-indent:0; font-size:11px; line-height:normal; display:inline-flex; align-items:center; justify-content:center; }
            .bm-util-btn:hover { filter:brightness(1.15); }
            .bm-util-btn:active { filter:brightness(0.9); transform:scale(0.97); }
            input { width:100%; padding:10px; margin:5px 0; border:1px solid var(--c-border); background-color:var(--c-surface); color:var(--c-text); border-radius:6px; font-size:14px; display:block; height:auto; -webkit-appearance:none; }
            label { display:block; font-size:12px; font-weight:bold; color:#666; margin-top:10px; }
            .bm-top-row { max-width:1200px; margin:0 auto 10px auto; display:flex; flex-direction:column; gap:8px; }
            .bm-admin-bar { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; width:100%; align-items:center; }
            .bm-tab-bar { display:flex; gap:5px; overflow-x:auto; -webkit-overflow-scrolling:touch; padding-bottom:5px; width:100%; }
            .bm-tab { padding:8px 14px; background:#eee; border-radius:var(--radius); cursor:pointer; font-size:13px; font-weight:bold; color:#666; white-space:nowrap; flex-shrink:0; }
            .bm-tab.active { background:var(--c-dark); color:#fff; }
            .bm-tab:hover:not(.active) { background:color-mix(in srgb, var(--c-primary) 20%, var(--c-bg)); }
            .bm-util-btn { padding:7px 10px; color:#fff; background:var(--c-dark); border-radius:6px; cursor:pointer; text-decoration:none; }
            .bm-btn-blue { background:var(--c-primary); }
            .bm-btn-green { background:var(--c-success); }
            .bm-btn-orange { background:var(--c-warning); }
            .bm-btn-red { background:var(--c-danger); color:white; }
            .bm-dashboard-container { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:15px; max-width:1200px; margin:0 auto; }
            .bm-bookmark-section { background:var(--c-surface); border:1px solid var(--c-border); border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.05); }
            .bm-section-header { display:flex; justify-content:space-between; align-items:center; padding:12px; background:var(--c-bg); border-bottom:1px solid var(--c-border); }
            .bm-manage-btn { border:1px solid var(--c-border); background:var(--c-surface); color:var(--c-text); padding:5px 10px; border-radius:6px; font-weight:bold; cursor:pointer; }
            .bm-item-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(85px,1fr)); gap:12px; padding:15px; min-height:60px; justify-items:center; }
            .bm-item-wrapper { display:flex; flex-direction:column; align-items:center; justify-content:center; text-decoration:none; color:inherit; width:100%; max-width:80px; }
            .bm-bookmark-item { display:flex; flex-direction:column; align-items:center; text-align:center; width:100%; transition:transform 0.15s ease; }
            .bm-bookmark-item:hover { transform:translateY(-2px); }
            .bm-bookmark-item img { width:38px; height:38px; min-width:38px; min-height:38px; margin-bottom:6px; border-radius:var(--radius); background:#fff; object-fit:contain; pointer-events:none; display:block; }
            .bm-bookmark-item span { font-size:11px; color:var(--c-text); width:100%; text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; pointer-events:none; }
            .sort-mode-active .bm-item-grid { display:none; }
            .sort-mode-active .bm-bookmark-section { border:2px dashed var(--c-primary); cursor:move; margin-bottom:5px; }
            .sort-mode-active .bm-dashboard-container { grid-template-columns:1fr; }
            dialog.bm-modal-bg { position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); border:none; padding:20px; display:flex; align-items:center; justify-content:center; max-width:100vw; max-height:100vh; }
            dialog.bm-modal-bg::backdrop { display:none; }
            dialog.bm-modal-bg[open] { display:flex; }
            .bm-modal-content { background:var(--c-surface); padding:25px; border-radius:15px; width:100%; max-width:420px; max-height:85vh; overflow-y:auto; color:var(--c-text); }
            .tab-manage-row { display:flex; align-items:center; justify-content:space-between; padding:10px; border-bottom:1px solid var(--c-border); gap:10px; }
            .bm-drag-handle { cursor:grab; font-size:18px; margin-right:10px; color:#888; touch-action:none; }
        `;

        const overlay = el('div', { id: 'bookmark-overlay' });
        const fab = el('div', { id: 'bookmark-fab', text: '🔖' });

        shadow.append(style, overlay, fab);
        setupFab(fab, overlay);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveDataNow();
        });
        window.addEventListener('pagehide', saveDataNow);

        updateFabIndicator();
    }

    init();
})();
