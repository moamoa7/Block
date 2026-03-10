// ==UserScript==
// @name         북마크 (Shadow DOM 통합 v9.0)
// @version      9.0
// @description  오류 수정, 보안 강화(XSS 방지) 및 Pointer Events 통합 최적화
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

    let db = GM_getValue('bm_db_v2', { currentPage: "기본", pages: { "기본": { "북마크": [] } } });
    const saveData = () => GM_setValue('bm_db_v2', db);
    const getCurPage = () => db.pages[db.currentPage]; // 3-3. db.pages[db.currentPage] 축약 유틸
    let isSortMode = false;
    let originalOverflow = ''; // 1-1. overflow 원래 값 저장용 변수

    // 1-2. HTML Injection 취약점 이스케이프 유틸
    const esc = (s) => s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';

    // [구글 플레이 대응] Trusted Types 정책
    let ttPolicy = null;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            ttPolicy = window.trustedTypes.createPolicy('bm-safe-html', {
                createHTML: (string) => string
            });
        } catch (e) {
            console.warn('TrustedTypes policy creation failed', e);
        }
    }
    const setHtml = (element, htmlString) => {
        element.innerHTML = ttPolicy ? ttPolicy.createHTML(htmlString) : htmlString;
    };

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
                            // 2-1. ArrayBuffer -> Base64 변환 간소화
                            const u8 = new Uint8Array(res.response);
                            const base64 = window.btoa(String.fromCharCode(...u8));
                            resolve(`data:image/png;base64,${base64}`);
                        } catch (e) { resolve(fallbackIcon); }
                    },
                    onerror: () => resolve(fallbackIcon)
                });
            } catch (e) { resolve(fallbackIcon); }
        });
    }

    let shadow = null;

    // 3-1. 공통 모달 생성 유틸
    function createModal(id = '') {
        const bg = document.createElement('div');
        if (id) bg.id = id;
        bg.className = 'bm-modal-bg';
        bg.style.display = 'flex';
        return bg;
    }
    function showModal(modal) {
        shadow.appendChild(modal);
        return modal;
    }

    async function fixAllIcons() {
        if (!confirm("모든 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?")) return;
        const noti = document.createElement('div');
        noti.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:rgba(0,0,0,0.8); color:white; padding:20px; z-index:999999; border-radius:10px; font-weight:bold; text-align:center;";
        setHtml(noti, "아이콘 업데이트 중...");
        shadow.appendChild(noti);

        let count = 0;
        const pages = Object.keys(db.pages);
        for (const page of pages) {
            const groups = Object.keys(db.pages[page]);
            for (const group of groups) {
                const items = db.pages[page][group];
                for (const item of items) {
                    item.icon = await fetchFaviconBase64(item.url);
                    count++;
                    setHtml(noti, `아이콘 업데이트 중...<br>${count}개 완료`);
                }
            }
        }
        saveData(); noti.remove(); alert("복구 완료!"); renderDashboard();
    }

    function renderDashboard() {
        const overlay = shadow.querySelector('#bookmark-overlay');
        if (!overlay) return;
        overlay.className = isSortMode ? 'sort-mode-active' : '';
        setHtml(overlay, '');

        const topRow = document.createElement('div'); topRow.className = 'bm-top-row';

        const tabBar = document.createElement('div'); tabBar.className = 'bm-tab-bar';
        Object.keys(db.pages).forEach(p => {
            const tab = document.createElement('div'); tab.className = `bm-tab ${db.currentPage === p ? 'active' : ''}`;
            tab.innerText = p; // innerText는 안전함
            tab.onclick = () => { db.currentPage = p; isSortMode = false; renderDashboard(); };
            tabBar.appendChild(tab);
        });

        const adminBar = document.createElement('div'); adminBar.className = 'bm-admin-bar';
        setHtml(adminBar, `
            <button class="bm-util-btn bm-btn-blue" id="btn-sort">${isSortMode ? '완료' : '정렬'}</button>
            <button class="bm-util-btn bm-btn-orange" id="btn-fix-icon">아이콘 복구</button>
            <button class="bm-util-btn" id="btn-tab-mgr">탭관리</button>
            <button class="bm-util-btn" id="btn-add-g">그룹+</button>
            <button class="bm-util-btn" id="btn-exp">백업</button>
            <button class="bm-util-btn bm-btn-green" id="btn-imp">복구</button>
        `);

        topRow.appendChild(adminBar);
        topRow.appendChild(tabBar);
        overlay.appendChild(topRow);

        const container = document.createElement('div'); container.className = 'bm-dashboard-container';
        Object.entries(getCurPage()).forEach(([gTitle, items]) => {
            const section = document.createElement('div'); section.className = 'bm-bookmark-section'; section.setAttribute('data-id', gTitle);
            setHtml(section, `
                <div class="bm-section-header">
                    <span style="font-weight:bold; font-size:14px;">${isSortMode ? '≡ ' : '📁 '} ${esc(gTitle)}</span>
                    ${!isSortMode ? '<button class="bm-manage-btn">관리</button>' : ''}
                </div>
                <div class="bm-item-grid" data-group="${esc(gTitle)}"></div>
            `);
            if(!isSortMode) section.querySelector('.bm-manage-btn').onclick = () => showGroupManager(gTitle);

            const grid = section.querySelector('.bm-item-grid');
            items.forEach((item) => {
                const wrapper = document.createElement('a');
                wrapper.className = 'bm-item-wrapper'; wrapper.href = item.url; wrapper.target = '_blank';
                const iconSrc = (item.icon && item.icon.startsWith('data:')) ? item.icon : fallbackIcon;
                // 1-2. XSS 이스케이프 적용
                setHtml(wrapper, `<div class="bm-bookmark-item"><img src="${esc(iconSrc)}"><span>${esc(item.name)}</span></div>`);
                grid.appendChild(wrapper);
            });
            container.appendChild(section);
        });
        overlay.appendChild(container);

        if (isSortMode) {
            new Sortable(container, { animation: 150, onEnd: () => {
                const newOrder = {};
                container.querySelectorAll('.bm-bookmark-section').forEach(sec => { const id = sec.getAttribute('data-id'); newOrder[id] = getCurPage()[id]; });
                db.pages[db.currentPage] = newOrder; saveData();
            }});
        }

        shadow.querySelector('#btn-sort').onclick = () => { isSortMode = !isSortMode; renderDashboard(); };
        shadow.querySelector('#btn-fix-icon').onclick = () => fixAllIcons();
        shadow.querySelector('#btn-tab-mgr').onclick = () => showTabManager();
        shadow.querySelector('#btn-add-g').onclick = () => { const n = prompt("새 그룹 이름:"); if(n){ getCurPage()[n]=[]; saveData(); renderDashboard(); }};
        shadow.querySelector('#btn-exp').onclick = () => { 
            const blob = new Blob([JSON.stringify(db, null, 2)], {type:"application/json"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download="bookmark_backup.json"; a.click(); 
            // 2-2. ObjectURL 메모리 누수 방지
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        };
        shadow.querySelector('#btn-imp').onclick = () => {
            const i = document.createElement('input'); i.type = 'file';
            i.onchange = e => {
                const r = new FileReader();
                r.onload = re => { try { db = JSON.parse(re.target.result); saveData(); renderDashboard(); alert('복구 완료!'); } catch(e){ alert('잘못된 파일입니다.'); } };
                r.readAsText(e.target.files[0]);
            }; i.click();
        };
    }

    function showGroupManager(gTitle) {
        const modalBg = createModal(); // 3-1. 모달 유틸 적용
        let items = getCurPage()[gTitle];

        setHtml(modalBg, `
            <div class="bm-modal-content">
                <h3 style="margin-top:0;">🛠 그룹 관리</h3>
                <label>그룹 이름</label>
                <input type="text" id="e-g-n" value="${esc(gTitle)}">
                <div style="font-size:12px; margin-top:10px; color:#666;">☰ 핸들을 잡고 드래그하여 순서를 변경하세요.</div>

                <div id="i-l" style="max-height:40vh; overflow-y:auto; border:1px solid #eee; border-radius:8px; padding:10px; margin-top:5px;">
                    ${items.map((it, idx)=>`
                    <div class="e-r" style="border-bottom:1px solid #eee; padding:10px 0; display:flex; gap:10px; align-items:center;">
                        <span class="bm-drag-handle">☰</span>
                        <div style="flex:1;">
                            <div style="display:flex; justify-content:flex-end;">
                                <span style="color:red; cursor:pointer; font-size:11px;" class="bm-del-btn">삭제</span>
                            </div>
                            <input type="text" class="r-n" value="${esc(it.name)}" placeholder="이름" style="margin-bottom:5px;">
                            <input type="text" class="r-u" value="${esc(it.url)}" placeholder="URL">
                        </div>
                    </div>`).join('')}
                </div>

                <button id="g-add-new" class="bm-util-btn bm-btn-blue" style="width:100%; margin-top:10px; padding:10px;">+ 북마크 추가</button>

                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="s-v" class="bm-util-btn bm-btn-green" style="flex:2; padding:12px;">저장</button>
                    <button id="c-l" class="bm-util-btn" style="flex:1; background:#999;">닫기</button>
                </div>
            </div>
        `);
        showModal(modalBg); // 3-1. 모달 유틸 적용

        modalBg.querySelectorAll('.bm-del-btn').forEach(btn => btn.onclick = function() { this.closest('.e-r').remove(); });

        modalBg.querySelector('#g-add-new').onclick = () => {
            const row = document.createElement('div');
            row.className = 'e-r';
            row.style.cssText = "border-bottom:1px solid #eee; padding:10px 0; display:flex; gap:10px; align-items:center;";
            setHtml(row, `
                <span class="bm-drag-handle">☰</span>
                <div style="flex:1;">
                    <div style="display:flex; justify-content:flex-end;">
                        <span style="color:red; cursor:pointer; font-size:11px;" class="bm-del-btn">삭제</span>
                    </div>
                    <input type="text" class="r-n" placeholder="새 북마크 이름" style="margin-bottom:5px;">
                    <input type="text" class="r-u" placeholder="https://" value="https://">
                </div>
            `);
            row.querySelector('.bm-del-btn').onclick = function() { this.closest('.e-r').remove(); };
            modalBg.querySelector('#i-l').appendChild(row);
            const list = modalBg.querySelector('#i-l');
            list.scrollTop = list.scrollHeight;
        };

        new Sortable(modalBg.querySelector('#i-l'), { handle: '.bm-drag-handle', animation: 150 });
        modalBg.querySelector('#c-l').onclick = () => modalBg.remove();

        // 1-3. 그룹 관리 저장 시 아이콘 누락 버그 픽스 (async 로직 추가)
        modalBg.querySelector('#s-v').onclick = async () => {
            const newN = modalBg.querySelector('#e-g-n').value.trim();
            const newL = [];
            modalBg.querySelectorAll('.e-r').forEach(r=>{
                const n = r.querySelector('.r-n').value.trim();
                const u = r.querySelector('.r-u').value.trim();
                if(n && u) newL.push({name:n, url:u});
            });
            for (const newItem of newL) {
                const oldItem = items.find(o => o.url === newItem.url);
                if (oldItem && oldItem.icon) {
                    newItem.icon = oldItem.icon;
                } else if (!newItem.icon) {
                    newItem.icon = await fetchFaviconBase64(newItem.url);
                }
            }
            if(newN !== gTitle){ getCurPage()[newN]=newL; delete getCurPage()[gTitle]; }
            else getCurPage()[gTitle]=newL;
            saveData(); renderDashboard(); modalBg.remove();
        };
    }

    function showTabManager() {
        const modalBg = createModal();
        let tabsHTML = `<div class="bm-modal-content"><h3 style="margin-top:0;">📂 탭 관리</h3><div style="max-height:50vh; overflow-y:auto; border:1px solid #eee; border-radius:8px;">`;
        Object.keys(db.pages).forEach(tabName => {
            tabsHTML += `<div class="tab-manage-row"><span>${esc(tabName)}</span><button class="bm-util-btn bm-btn-red del-tab-btn" style="padding:4px 8px;" data-tab="${esc(tabName)}">삭제</button></div>`;
        });
        tabsHTML += `</div><button id="add-new-tab" class="bm-util-btn bm-btn-blue" style="width:100%; margin-top:15px; padding:12px;">+ 새 탭 추가</button><button id="close-tab-mgr" class="bm-util-btn" style="width:100%; margin-top:10px; background:#999; padding:10px;">닫기</button></div>`;
        setHtml(modalBg, tabsHTML); 
        showModal(modalBg);

        modalBg.querySelectorAll('.del-tab-btn').forEach(btn => {
            btn.onclick = () => {
                const name = btn.getAttribute('data-tab');
                if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; } 
                if (confirm('삭제?')) { 
                    delete db.pages[name]; 
                    if (db.currentPage === name) db.currentPage = Object.keys(db.pages)[0]; 
                    saveData(); renderDashboard(); modalBg.remove(); 
                }
            };
        });

        modalBg.querySelector('#add-new-tab').onclick = () => { const n = prompt("새 탭 이름:"); if (n && !db.pages[n]) { db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); modalBg.remove(); } else if (db.pages[n]) { alert("중복 이름"); } };
        modalBg.querySelector('#close-tab-mgr').onclick = () => modalBg.remove();
    }

    function showQuickAddModal() {
        if (shadow.querySelector('#bm-quick-modal')) return;
        const modalBg = createModal('bm-quick-modal');
        setHtml(modalBg, `<div class="bm-modal-content"><h3 style="margin-top:0;">🔖 북마크 저장</h3><label>이름</label><input type="text" id="bm-q-n" value="${esc(document.title.substring(0,30))}"><label>주소 (URL)</label><input type="text" id="bm-q-u" value="${esc(window.location.href)}"><div id="q-area"><p style="font-size:12px; font-weight:bold; margin-top:15px;">탭 선택:</p><div style="display:flex; flex-wrap:wrap; gap:5px;">${Object.keys(db.pages).map(p => `<button class="q-p bm-util-btn" style="background:#eee; color:#333;">${esc(p)}</button>`).join('')}</div></div><button id="q-close" style="width:100%; border:0; background:none; margin-top:20px; color:#999; cursor:pointer;">취소</button></div>`);
        showModal(modalBg);
        
        modalBg.querySelector('#q-close').onclick = () => modalBg.remove();
        modalBg.querySelectorAll('.q-p').forEach(btn => {
            btn.onclick = () => {
                const selP = btn.innerText;
                const groups = Object.keys(db.pages[selP]);
                setHtml(modalBg.querySelector('#q-area'), `<p style="font-size:12px; font-weight:bold;">그룹 선택 (${esc(selP)}):</p><div style="display:flex; flex-direction:column; gap:5px;">${groups.map(g => `<button class="q-g bm-util-btn" style="background:#f8f9fa; color:#333; justify-content:flex-start; padding:12px;">📁 ${esc(g)}</button>`).join('')}<button id="q-new-g" class="bm-util-btn" style="background:#333; color:#fff; padding:12px;">+ 새 그룹 생성</button></div>`);
                modalBg.querySelectorAll('.q-g').forEach(gBtn => { gBtn.onclick = async () => { const fName = modalBg.querySelector('#bm-q-n').value; const fUrl = modalBg.querySelector('#bm-q-u').value; const icon = await fetchFaviconBase64(fUrl); db.pages[selP][gBtn.innerText.replace('📁 ', '')].push({ name: fName, url: fUrl, icon: icon }); saveData(); modalBg.remove(); alert('저장됨'); }; });
                modalBg.querySelector('#q-new-g').onclick = async () => { const n = prompt("새 그룹 이름:"); if(n){ const fName = modalBg.querySelector('#bm-q-n').value; const fUrl = modalBg.querySelector('#bm-q-u').value; const icon = await fetchFaviconBase64(fUrl); if(!db.pages[selP][n]) db.pages[selP][n] = []; db.pages[selP][n].push({ name: fName, url: fUrl, icon: icon }); saveData(); modalBg.remove(); alert('저장됨'); } };
            };
        });
    }

    function init() {
        const host = document.createElement('div');
        host.id = 'bm-script-root';
        host.style.cssText = 'position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; overflow: visible;';
        document.body.appendChild(host);

        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        // 3-5. CSS 커스텀 속성 활용
        style.textContent = `
            :host {
                --c-primary: #007bff; --c-success: #28a745; --c-warning: #fd7e14; 
                --c-danger: #dc3545; --c-dark: #333; --c-bg: #f1f3f5; --radius: 8px;
            }
            * { box-sizing: border-box; font-family: sans-serif; }
            #bookmark-fab {
                position: fixed; bottom: 20px; right: 20px; width: 55px; height: 55px;
                background: var(--c-dark); color: white; border-radius: 50%;
                display: flex; align-items: center; justify-content: center;
                cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.4);
                font-size: 26px; user-select: none;
                touch-action: none; -webkit-tap-highlight-color: transparent; border: none;
            }
            #bookmark-overlay { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(255, 255, 255, 0.98); display: none; overflow-y: auto; padding: 15px; backdrop-filter: blur(5px); color: var(--c-dark); text-align: left; }

            .bm-modal-content, .bm-dashboard-container { color: var(--c-dark); text-align: left; }
            button { outline: none; border: none; font-family: sans-serif; }
            
            .bm-util-btn, .bm-manage-btn {
                text-indent: 0; font-size: 11px; line-height: normal;
                display: inline-flex; align-items: center; justify-content: center;
            }

            input { width: 100%; padding: 10px; margin: 5px 0; border: 1px solid #ccc; background-color: #fff; color: #000; border-radius: 6px; font-size: 14px; display: block; height: auto; -webkit-appearance: none; }
            label { display: block; font-size: 12px; font-weight: bold; color: #666; margin-top: 10px; }

            .bm-top-row { max-width: 1200px; margin: 0 auto 10px auto; display: flex; flex-direction: column; gap: 8px; }
            .bm-admin-bar { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; width: 100%; }
            .bm-tab-bar { display: flex; gap: 5px; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 5px; width: 100%; }

            .bm-tab { padding: 8px 14px; background: #eee; border-radius: var(--radius); cursor: pointer; font-size: 13px; font-weight: bold; color: #666; white-space: nowrap; flex-shrink: 0; }
            .bm-tab.active { background: var(--c-dark); color: #fff; }

            .bm-util-btn { padding: 7px 10px; color: #fff; background: var(--c-dark); border-radius: 6px; cursor: pointer; text-decoration: none; }
            .bm-btn-blue { background: var(--c-primary); }
            .bm-btn-green { background: var(--c-success); }
            .bm-btn-orange { background: var(--c-warning); }
            .bm-btn-red { background: var(--c-danger); color: white; }

            .bm-dashboard-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; max-width: 1200px; margin: 0 auto; }
            .bm-bookmark-section { background: white; border: 1px solid #ddd; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
            .bm-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--c-bg); border-bottom: 1px solid #ddd; }
            .bm-manage-btn { border: 1px solid #ccc; background: #fff; color: var(--c-dark); padding: 5px 10px; border-radius: 6px; font-weight: bold; cursor: pointer; }

            .bm-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); gap: 12px; padding: 15px; min-height: 60px; justify-items: center; }
            .bm-item-wrapper { display: flex; flex-direction: column; align-items: center; justify-content: center; text-decoration: none; color: inherit; width: 100%; max-width: 80px; }
            .bm-bookmark-item { display: flex; flex-direction: column; align-items: center; text-align: center; width: 100%; }
            .bm-bookmark-item img {
                width: 38px; height: 38px; min-width: 38px; min-height: 38px;
                margin-bottom: 6px; border-radius: var(--radius); background: #fff;
                object-fit: contain; pointer-events: none; display: block;
            }
            .bm-bookmark-item span { font-size: 11px; color: var(--c-dark); width: 100%; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; pointer-events: none; }

            .sort-mode-active .bm-item-grid { display: none; }
            .sort-mode-active .bm-bookmark-section { border: 2px dashed var(--c-primary); cursor: move; margin-bottom: 5px; }
            .sort-mode-active .bm-dashboard-container { grid-template-columns: 1fr; }
            
            .bm-modal-bg { position: fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:2147483647; display:none; align-items:center; justify-content:center; padding: 20px; }
            .bm-modal-content { background: white; padding: 25px; border-radius: 15px; width: 100%; max-width: 420px; max-height: 85vh; overflow-y: auto; color: var(--c-dark); }
            .tab-manage-row { display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid #eee; gap: 10px; }
            .bm-drag-handle { cursor: grab; font-size: 18px; margin-right: 10px; color: #888; touch-action: none; }
        `;

        const overlay = document.createElement('div'); overlay.id = 'bookmark-overlay';
        const fab = document.createElement('div'); fab.id = 'bookmark-fab'; fab.innerText = '🔖';

        shadow.appendChild(style);
        shadow.appendChild(overlay);
        shadow.appendChild(fab);

        let pressTimer, isLongPress = false, startX, startY;
        
        // 3-4. Pointer Events 통합 적용
        const handleStart = (e) => { 
            startX = e.clientX; startY = e.clientY; 
            isLongPress = false; 
            pressTimer = setTimeout(() => { 
                isLongPress = true; 
                // 2-3. vibrate 예외 처리 안전망 적용
                if (e.pointerType === 'touch') { try { window.navigator.vibrate?.(40); } catch(err){} }
                showQuickAddModal(); 
            }, 600); 
        };
        const handleEnd = (e) => { 
            clearTimeout(pressTimer); 
            if (!isLongPress) { 
                const dist = Math.hypot(e.clientX - startX, e.clientY - startY); 
                if (dist < 10) { 
                    const isVisible = overlay.style.display === 'block'; 
                    // 1-1. overflow 토글 논리 픽스 및 원래 값 복구 로직 적용
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
                    }
                } 
            } 
        };

        fab.addEventListener('pointerdown', handleStart); 
        fab.addEventListener('pointerup', handleEnd); 
        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    init();
})();
