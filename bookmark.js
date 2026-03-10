// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v10.0)
// @version      10.0
// @description  v9.1 기반 – 검증강화, 메모리누수방지, dialog모달, FAB드래그, 이벤트위임, 자동백업
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
    function el(tag, attrs = {}, children = []) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
            else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
            else e.setAttribute(k, v);
        }
        for (const c of children) e.append(typeof c === 'string' ? c : c);
        return e;
    }

    const esc = (s) => s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';

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
                for (const item of items) { if (!item.name || !item.url) return false; }
            }
        }
        return true;
    }

    /* ── DB 로드 (자동 백업 복구 포함) ── */
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

    /* ── 저장 (debounce + 즉시 + 자동 백업) ── */
    let _saveTimer = null;
    const saveData = () => {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => GM_setValue('bm_db_v2', db), 300);
    };
    const saveDataNow = () => {
        clearTimeout(_saveTimer);
        const lastBackup = GM_getValue('bm_last_backup_time', 0);
        if (Date.now() - lastBackup > 3600000) {
            GM_setValue('bm_db_v2_backup', structuredClone(db));
            GM_setValue('bm_last_backup_time', Date.now());
        }
        GM_setValue('bm_db_v2', db);
    };

    const getCurPage = () => db.pages[db.currentPage];
    let isSortMode = false;
    let originalOverflow = '';
    let activeSortable = null;

    /* ── 파비콘 ── */
    const fallbackIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";

    function fetchFaviconBase64(url) {
        return new Promise((resolve) => {
            try {
                const u = new URL(url);
                const iconUrl = `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
                GM_xmlhttpRequest({
                    method: "GET", url: iconUrl, responseType: "arraybuffer",
                    onload: (res) => {
                        if (res.status !== 200 || !res.response) { resolve(fallbackIcon); return; }
                        try {
                            const u8 = new Uint8Array(res.response);
                            let binary = '';
                            const chunk = 8192;
                            for (let i = 0; i < u8.length; i += chunk) {
                                binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
                            }
                            resolve(`data:image/png;base64,${window.btoa(binary)}`);
                        } catch { resolve(fallbackIcon); }
                    },
                    onerror: () => resolve(fallbackIcon)
                });
            } catch { resolve(fallbackIcon); }
        });
    }

    let shadow = null;

    /* ── 모달 (dialog 기반) ── */
    function createModal(id = '') {
        const dialog = document.createElement('dialog');
        if (id) dialog.id = id;
        dialog.className = 'bm-modal-bg';
        dialog.addEventListener('click', (e) => { if (e.target === dialog) { dialog.close(); } });
        dialog.addEventListener('close', () => dialog.remove());
        return dialog;
    }
    function showModal(modal) {
        shadow.appendChild(modal);
        modal.showModal();
        return modal;
    }

    /* ── 아이콘 전체 복구 (병렬 배치) ── */
    async function fixAllIcons() {
        if (!confirm("모든 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?")) return;
        const noti = el('div', { style: { position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(0,0,0,0.85)', color:'white', padding:'24px 32px', zIndex:'2147483647', borderRadius:'12px', fontWeight:'bold', textAlign:'center' } });
        setHtml(noti, "아이콘 업데이트 중...");
        shadow.appendChild(noti);

        const allItems = [];
        for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items) allItems.push(item);

        const BATCH = 5;
        for (let i = 0; i < allItems.length; i += BATCH) {
            await Promise.all(allItems.slice(i, i + BATCH).map(async item => { item.icon = await fetchFaviconBase64(item.url); }));
            setHtml(noti, `아이콘 업데이트 중...<br>${Math.min(i + BATCH, allItems.length)} / ${allItems.length}`);
        }
        saveDataNow(); noti.remove(); alert("복구 완료!"); renderDashboard();
    }

    /* ── 그룹 관리 아이템 행 생성 ── */
    function createItemRow({ name = '', url = 'https://', isNew = false } = {}) {
        const row = el('div', { class: 'e-r', style: { borderBottom:'1px solid var(--c-border)', padding:'10px 0', display:'flex', gap:'10px', alignItems:'center' } });
        const handle = el('span', { class: 'bm-drag-handle', text: '☰' });
        const body = el('div', { style: { flex: '1' } });
        const delRow = el('div', { style: { display:'flex', justifyContent:'flex-end' } });
        const delBtn = el('span', { text: '삭제', style: { color:'red', cursor:'pointer', fontSize:'11px' }, onclick: () => row.remove() });
        delRow.appendChild(delBtn);
        const nameInput = el('input', { type:'text', class:'r-n', value: name, placeholder: isNew ? '새 북마크 이름' : '이름', style: { marginBottom:'5px' } });
        const urlInput = el('input', { type:'text', class:'r-u', value: url, placeholder:'URL' });
        body.append(delRow, nameInput, urlInput);
        row.append(handle, body);
        return row;
    }

    /* ── 대시보드 렌더링 ── */
    function renderDashboard() {
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (!overlay) return;
        overlay.className = isSortMode ? 'sort-mode-active' : '';
        overlay.replaceChildren();

        // 상단 영역
        const topRow = el('div', { class: 'bm-top-row' });

        // 탭 바 (이벤트 위임)
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

        // 검색
        const searchInput = el('input', {
            type: 'text', placeholder: '검색...',
            style: { maxWidth:'150px', padding:'6px 10px', fontSize:'13px', display:'inline-block', margin:'0 auto 0 0', border:'1px solid var(--c-border)', background:'var(--c-surface)', color:'var(--c-text)', borderRadius:'6px' },
            oninput: (e) => {
                const q = e.target.value.toLowerCase();
                shadow.querySelectorAll('.bm-item-wrapper').forEach(w => {
                    const name = w.querySelector('span')?.textContent.toLowerCase() || '';
                    const url = (w.getAttribute('href') || '').toLowerCase();
                    w.style.display = (name.includes(q) || url.includes(q)) ? '' : 'none';
                });
            }
        });
        adminBar.appendChild(searchInput);

        const btns = [
            { id:'btn-sort', text: isSortMode ? '완료' : '정렬', cls:'bm-btn-blue' },
            { id:'btn-fix-icon', text:'아이콘 복구', cls:'bm-btn-orange' },
            { id:'btn-tab-mgr', text:'탭관리', cls:'' },
            { id:'btn-add-g', text:'그룹+', cls:'' },
            { id:'btn-exp', text:'백업', cls:'' },
            { id:'btn-imp', text:'복구', cls:'bm-btn-green' },
        ];
        btns.forEach(b => adminBar.appendChild(el('button', { id: b.id, class: `bm-util-btn ${b.cls}`, text: b.text })));

        topRow.append(adminBar, tabBar);
        overlay.appendChild(topRow);

        // 컨테이너 (이벤트 위임)
        const container = el('div', { class: 'bm-dashboard-container', onclick: (e) => {
            const btn = e.target.closest('.bm-manage-btn');
            if (!btn) return;
            const sec = btn.closest('.bm-bookmark-section');
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
                const img = el('img', { loading: 'lazy' });
                img.src = (item.icon?.startsWith('data:')) ? item.icon : fallbackIcon;
                div.append(img, el('span', { text: item.name }));
                wrapper.appendChild(div);
                grid.appendChild(wrapper);
            });

            section.appendChild(grid);
            container.appendChild(section);
        });
        overlay.appendChild(container);

        // Sortable (메모리 관리)
        if (activeSortable) { activeSortable.destroy(); activeSortable = null; }
        if (isSortMode) {
            activeSortable = new Sortable(container, { animation: 150, onEnd: () => {
                const newOrder = {};
                container.querySelectorAll('.bm-bookmark-section').forEach(sec => {
                    const id = sec.getAttribute('data-id');
                    newOrder[id] = getCurPage()[id];
                });
                db.pages[db.currentPage] = newOrder; saveData();
            }});
        }

        // 버튼 이벤트
        shadow.querySelector('#btn-sort').onclick = () => { isSortMode = !isSortMode; renderDashboard(); };
        shadow.querySelector('#btn-fix-icon').onclick = fixAllIcons;
        shadow.querySelector('#btn-tab-mgr').onclick = showTabManager;
        shadow.querySelector('#btn-add-g').onclick = () => { const n = prompt("새 그룹 이름:"); if(n){ getCurPage()[n]=[]; saveData(); renderDashboard(); }};
        shadow.querySelector('#btn-exp').onclick = () => {
            saveDataNow();
            const blob = new Blob([JSON.stringify(db, null, 2)], {type:"application/json"});
            const url = URL.createObjectURL(blob);
            const a = el('a', { href: url, download: 'bookmark_backup.json' }); a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        shadow.querySelector('#btn-imp').onclick = () => {
            const inp = el('input', { type: 'file' });
            inp.onchange = e => {
                const r = new FileReader();
                r.onload = re => {
                    try {
                        const parsed = JSON.parse(re.target.result);
                        if (!validateDB(parsed)) { alert('파일 구조가 올바르지 않습니다.'); return; }
                        db = structuredClone(parsed);
                        saveDataNow(); renderDashboard(); alert('복구 완료!');
                    } catch { alert('잘못된 파일입니다.'); }
                };
                r.readAsText(e.target.files[0]);
            };
            inp.click();
        };
    }

    /* ── 그룹 관리 모달 ── */
    function showGroupManager(gTitle) {
        const modalBg = createModal();
        const items = getCurPage()[gTitle];
        const content = el('div', { class: 'bm-modal-content' });

        content.appendChild(el('h3', { text: '🛠 그룹 관리', style: { marginTop: '0' } }));
        content.appendChild(el('label', { text: '그룹 이름' }));
        const gNameInput = el('input', { type:'text', id:'e-g-n', value: gTitle });
        content.appendChild(gNameInput);
        content.appendChild(el('div', { text: '☰ 핸들을 잡고 드래그하여 순서를 변경하세요.', style: { fontSize:'12px', marginTop:'10px', color:'#666' } }));

        const listEl = el('div', { id:'i-l', style: { maxHeight:'40vh', overflowY:'auto', border:'1px solid var(--c-border)', borderRadius:'8px', padding:'10px', marginTop:'5px' } });
        items.forEach(it => listEl.appendChild(createItemRow({ name: it.name, url: it.url })));
        content.appendChild(listEl);

        content.appendChild(el('button', { id:'g-add-new', class:'bm-util-btn bm-btn-blue', text:'+ 북마크 추가', style: { width:'100%', marginTop:'10px', padding:'10px' }, onclick: () => {
            const newRow = createItemRow({ isNew: true });
            listEl.appendChild(newRow);
            listEl.scrollTop = listEl.scrollHeight;
        }}));

        const btnRow = el('div', { style: { display:'flex', gap:'10px', marginTop:'20px' } });
        btnRow.appendChild(el('button', { id:'s-v', class:'bm-util-btn bm-btn-green', text:'저장', style: { flex:'2', padding:'12px' }, onclick: async () => {
            const newN = gNameInput.value.trim();
            const newL = [];
            listEl.querySelectorAll('.e-r').forEach(r => {
                const n = r.querySelector('.r-n').value.trim();
                const u = r.querySelector('.r-u').value.trim();
                if(n && u) newL.push({ name:n, url:u });
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
        }}));
        btnRow.appendChild(el('button', { class:'bm-util-btn', text:'닫기', style: { flex:'1', background:'#999', padding:'12px' }, onclick: () => modalBg.close() }));
        content.appendChild(btnRow);

        modalBg.appendChild(content);
        showModal(modalBg);
        new Sortable(listEl, { handle: '.bm-drag-handle', animation: 150 });
    }

    /* ── 탭 관리 모달 ── */
    function showTabManager() {
        const modalBg = createModal();
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '📂 탭 관리', style: { marginTop: '0' } }));

        const listContainer = el('div', { id:'tab-list-container', style: { maxHeight:'50vh', overflowY:'auto', border:'1px solid var(--c-border)', borderRadius:'8px' } });
        Object.keys(db.pages).forEach(tabName => {
            const row = el('div', { class: 'tab-manage-row' });
            row.appendChild(el('span', { text: tabName }));
            row.appendChild(el('button', { class:'bm-util-btn bm-btn-red', text:'삭제', style:{ padding:'4px 8px' }, onclick: () => {
                if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; }
                if (confirm('삭제?')) {
                    delete db.pages[tabName];
                    if (db.currentPage === tabName) db.currentPage = Object.keys(db.pages)[0];
                    saveData(); renderDashboard(); modalBg.close();
                }
            }}));
            listContainer.appendChild(row);
        });
        content.appendChild(listContainer);

        content.appendChild(el('button', { id:'add-new-tab', class:'bm-util-btn bm-btn-blue', text:'+ 새 탭 추가', style:{ width:'100%', marginTop:'15px', padding:'12px' }, onclick: () => {
            const n = prompt("새 탭 이름:");
            if (n && !db.pages[n]) { db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); modalBg.close(); }
            else if (db.pages[n]) alert("중복 이름");
        }}));
        content.appendChild(el('button', { class:'bm-util-btn', text:'닫기', style:{ width:'100%', marginTop:'10px', background:'#999', padding:'10px' }, onclick: () => modalBg.close() }));

        modalBg.appendChild(content);
        showModal(modalBg);
    }

    /* ── 빠른 추가 모달 ── */
    function showQuickAddModal() {
        if (shadow.querySelector('#bm-quick-modal')) return;
        const modalBg = createModal('bm-quick-modal');
        const content = el('div', { class: 'bm-modal-content' });
        content.appendChild(el('h3', { text: '🔖 북마크 저장', style: { marginTop:'0' } }));
        content.appendChild(el('label', { text: '이름' }));
        const nameInput = el('input', { type:'text', id:'bm-q-n', value: document.title.substring(0,30) });
        content.appendChild(nameInput);
        content.appendChild(el('label', { text: '주소 (URL)' }));
        const urlInput = el('input', { type:'text', id:'bm-q-u', value: window.location.href });
        content.appendChild(urlInput);

        const area = el('div', { id: 'q-area' });
        area.appendChild(el('p', { text: '탭 선택:', style: { fontSize:'12px', fontWeight:'bold', marginTop:'15px' } }));
        const tabBtns = el('div', { style: { display:'flex', flexWrap:'wrap', gap:'5px' } });
        Object.keys(db.pages).forEach(p => {
            tabBtns.appendChild(el('button', { class:'q-p bm-util-btn', text: p, style:{ background:'#eee', color:'#333' }, onclick: () => showGroupSelect(p) }));
        });
        area.appendChild(tabBtns);
        content.appendChild(area);

        content.appendChild(el('button', { id:'q-close', text:'취소', style:{ width:'100%', border:'0', background:'none', marginTop:'20px', color:'#999', cursor:'pointer' }, onclick: () => modalBg.close() }));

        function showGroupSelect(selP) {
            area.replaceChildren();
            area.appendChild(el('p', { text: `그룹 선택 (${selP}):`, style: { fontSize:'12px', fontWeight:'bold' } }));
            const col = el('div', { style: { display:'flex', flexDirection:'column', gap:'5px' } });
            Object.keys(db.pages[selP]).forEach(g => {
                col.appendChild(el('button', { class:'q-g bm-util-btn', text: `📁 ${g}`, 'data-group': g, style:{ background:'var(--c-bg)', color:'var(--c-text)', justifyContent:'flex-start', padding:'12px' }, onclick: async () => {
                    const icon = await fetchFaviconBase64(urlInput.value);
                    db.pages[selP][g].push({ name: nameInput.value, url: urlInput.value, icon });
                    saveData(); modalBg.close(); alert('저장됨');
                }}));
            });
            col.appendChild(el('button', { text:'+ 새 그룹 생성', class:'bm-util-btn', style:{ background:'var(--c-dark)', color:'#fff', padding:'12px' }, onclick: async () => {
                const n = prompt("새 그룹 이름:");
                if (n) {
                    const icon = await fetchFaviconBase64(urlInput.value);
                    if (!db.pages[selP][n]) db.pages[selP][n] = [];
                    db.pages[selP][n].push({ name: nameInput.value, url: urlInput.value, icon });
                    saveData(); modalBg.close(); alert('저장됨');
                }
            }}));
            area.appendChild(col);
        }

        modalBg.appendChild(content);
        showModal(modalBg);
    }

    /* ── FAB 현재 URL 표시 ── */
    function updateFabIndicator() {
        const fab = shadow?.querySelector('#bookmark-fab');
        if (!fab || shadow.querySelector('#bookmark-overlay')?.style.display === 'block') return;
        const cur = window.location.href;
        let found = false;
        outer: for (const page of Object.values(db.pages))
            for (const items of Object.values(page))
                for (const item of items) if (item.url === cur) { found = true; break outer; }
        fab.style.outline = found ? '3px solid var(--c-success)' : 'none';
        fab.style.outlineOffset = '2px';
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
                will-change:left,top; transition:left 0.2s ease, right 0.2s ease, top 0.2s ease;
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

        /* FAB 이벤트: 클릭/드래그/롱프레스 통합 */
        let pressTimer, isLongPress = false, isDragging = false;
        let startX, startY, fabOffsetX, fabOffsetY;

        fab.addEventListener('pointerdown', (e) => {
            fab.setPointerCapture(e.pointerId);
            startX = e.clientX; startY = e.clientY;
            const rect = fab.getBoundingClientRect();
            fabOffsetX = e.clientX - rect.left;
            fabOffsetY = e.clientY - rect.top;
            isLongPress = false; isDragging = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                if (e.pointerType === 'touch') try { navigator.vibrate?.(40); } catch{}
                showQuickAddModal();
            }, 600);
        });
        fab.addEventListener('pointermove', (e) => {
            const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
            if (dist > 10) {
                clearTimeout(pressTimer);
                isDragging = true;
                fab.style.transition = 'none';
                fab.style.left = Math.max(0, Math.min(window.innerWidth - 55, e.clientX - fabOffsetX)) + 'px';
                fab.style.top = Math.max(0, Math.min(window.innerHeight - 55, e.clientY - fabOffsetY)) + 'px';
                fab.style.right = 'auto'; fab.style.bottom = 'auto';
            }
        });
        fab.addEventListener('pointerup', (e) => {
            clearTimeout(pressTimer);
            fab.releasePointerCapture(e.pointerId);
            if (isDragging) {
                fab.style.transition = '';
                const rect = fab.getBoundingClientRect();
                const snapRight = rect.left + 27.5 > window.innerWidth / 2;
                fab.style.left = snapRight ? 'auto' : '15px';
                fab.style.right = snapRight ? '15px' : 'auto';
                return;
            }
            if (!isLongPress) {
                const isVisible = overlay.style.display === 'block';
                if (!isVisible) {
                    renderDashboard();
                    originalOverflow = document.body.style.overflow;
                    document.body.style.overflow = 'hidden';
                    overlay.style.display = 'block';
                    fab.innerText = '✕';
                } else {
                    document.body.style.overflow = originalOverflow;
                    overlay.style.display = 'none';
                    fab.innerText = '🔖';
                    updateFabIndicator();
                }
            }
        });
        fab.addEventListener('pointercancel', (e) => {
            clearTimeout(pressTimer);
            fab.releasePointerCapture(e.pointerId);
            isLongPress = false; isDragging = false;
        });
        fab.addEventListener('contextmenu', e => e.preventDefault());

        // 탭 이탈 시 즉시 저장
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') saveDataNow();
        });

        updateFabIndicator();
    }

    init();
})();
