// ==UserScript==
// @name         북마크 (아이콘 롱 프레스 저장 기능 통합 v5.7)
// @version      5.7
// @description  탭 관리 모달 통합, 복구 버튼 복구, 버튼 배치 최적화
// @author       User
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js
// @noframes
// ==/UserScript==

(function() {
    'use strict';
    if (window.self !== window.top) return;

    let db = GM_getValue('bm_db_v2', { currentPage: "기본", pages: { "기본": { "북마크": [] } } });
    const saveData = () => GM_setValue('bm_db_v2', db);
    let isSortMode = false;

    // 1. 스타일 설정
    GM_addStyle(`
        #bookmark-fab { position: fixed; bottom: 20px; right: 20px; width: 55px; height: 55px; background: #333 !important; color: white !important; border-radius: 50% !important; display: flex !important; align-items: center !important; justify-content: center !important; cursor: pointer; z-index: 2147483647; box-shadow: 0 4px 15px rgba(0,0,0,0.4); font-size: 26px !important; user-select: none !important; touch-action: none !important; -webkit-tap-highlight-color: transparent; border: none !important; }
        #bookmark-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.98) !important; z-index: 2147483646; display: none; overflow-y: auto; padding: 15px; backdrop-filter: blur(5px); box-sizing: border-box; color: #333 !important; font-family: sans-serif; }
        
        .bm-top-row { max-width: 1200px; margin: 0 auto 10px auto; display: flex; flex-direction: column; gap: 8px; }
        .bm-nav { display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px; }
        .bm-tab-bar { display: flex; gap: 5px; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 5px; flex: 1; }
        .bm-tab { padding: 8px 14px; background: #eee !important; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: bold; color: #666 !important; white-space: nowrap; border: 0 !important; }
        .bm-tab.active { background: #333 !important; color: #fff !important; }

        .bm-admin-bar { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
        .bm-util-btn { padding: 7px 10px; font-size: 11px; color: #fff !important; background: #333 !important; border: 0 !important; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
        .bm-btn-blue { background: #007bff !important; }
        .bm-btn-green { background: #28a745 !important; }

        .bm-dashboard-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; max-width: 1200px; margin: 0 auto; }
        .bm-bookmark-section { background: white !important; border: 1px solid #ddd !important; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .bm-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f1f3f5 !important; border-bottom: 1px solid #ddd !important; }
        
        .bm-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); gap: 12px; padding: 15px; min-height: 60px; justify-items: center; }
        .bm-item-wrapper { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; text-decoration: none !important; color: inherit !important; width: 100% !important; max-width: 80px; }
        .bm-bookmark-item { display: flex !important; flex-direction: column !important; align-items: center !important; text-align: center !important; width: 100% !important; }
        .bm-bookmark-item img { width: 38px !important; height: 38px !important; margin-bottom: 6px !important; border-radius: 8px !important; background: #fff !important; object-fit: contain !important; pointer-events: none; }
        .bm-bookmark-item span { font-size: 11px !important; color: #333 !important; width: 100% !important; text-align: center !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block !important; pointer-events: none; }

        .sort-mode-active .bm-item-grid { display: none !important; }
        .sort-mode-active .bm-bookmark-section { border: 2px dashed #007bff !important; cursor: move; margin-bottom: 5px; }
        .sort-mode-active .bm-dashboard-container { grid-template-columns: 1fr !important; }

        .bm-modal-bg { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6) !important; z-index:2147483647; display:none; align-items:center; justify-content:center; padding: 20px; box-sizing: border-box; }
        .bm-modal-content { background: white !important; padding: 25px; border-radius: 15px; width: 100%; max-width: 420px; max-height: 85vh; overflow-y: auto; color: #333 !important; }
        .bm-modal-content input { width: 100% !important; padding: 10px !important; margin: 5px 0 10px 0 !important; border: 1px solid #ddd !important; border-radius: 6px !important; box-sizing: border-box !important; }
        
        /* 탭 관리 행 스타일 */
        .tab-manage-row { display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid #eee; gap: 10px; }
        .tab-manage-row span { font-size: 14px; font-weight: bold; flex: 1; }
    `);

    // 2. 대시보드 렌더링
    function renderDashboard() {
        const overlay = document.getElementById('bookmark-overlay');
        if (!overlay) return;
        overlay.className = isSortMode ? 'sort-mode-active' : '';
        overlay.innerHTML = '';
        
        const topRow = document.createElement('div'); topRow.className = 'bm-top-row';
        const nav = document.createElement('div'); nav.className = 'bm-nav';
        
        const tabBar = document.createElement('div'); tabBar.className = 'bm-tab-bar';
        Object.keys(db.pages).forEach(p => {
            const tab = document.createElement('div'); tab.className = `bm-tab ${db.currentPage === p ? 'active' : ''}`;
            tab.innerText = p; tab.onclick = () => { db.currentPage = p; isSortMode = false; renderDashboard(); };
            tabBar.appendChild(tab);
        });

        const adminBar = document.createElement('div'); adminBar.className = 'bm-admin-bar';
        adminBar.innerHTML = `
            <button class="bm-util-btn bm-btn-blue" id="btn-sort">${isSortMode ? '완료' : '정렬'}</button>
            <button class="bm-util-btn" id="btn-tab-mgr">탭관리</button>
            <button class="bm-util-btn" id="btn-add-g">그룹+</button>
            <button class="bm-util-btn" id="btn-exp">백업</button>
            <button class="bm-util-btn bm-btn-green" id="btn-imp">복구</button>
        `;
        
        nav.appendChild(tabBar); nav.appendChild(adminBar); topRow.appendChild(nav); overlay.appendChild(topRow);

        const container = document.createElement('div'); container.className = 'bm-dashboard-container';
        Object.entries(db.pages[db.currentPage]).forEach(([gTitle, items]) => {
            const section = document.createElement('div'); section.className = 'bm-bookmark-section'; section.setAttribute('data-id', gTitle);
            section.innerHTML = `
                <div class="bm-section-header">
                    <span style="font-weight:bold; font-size:14px;">${isSortMode ? '≡ ' : '📁 '} ${gTitle}</span>
                    ${!isSortMode ? '<button class="bm-manage-btn" style="border:0; background:#eee; padding:5px 10px; border-radius:6px; font-size:11px; cursor:pointer;">관리</button>' : ''}
                </div>
                <div class="bm-item-grid" data-group="${gTitle}"></div>
            `;
            if(!isSortMode) section.querySelector('.bm-manage-btn').onclick = () => showGroupManager(gTitle);
            
            const grid = section.querySelector('.bm-item-grid');
            items.forEach((item) => {
                let host = ''; try { host = new URL(item.url).hostname; } catch(e) {}
                const wrapper = document.createElement('a');
                wrapper.className = 'bm-item-wrapper'; wrapper.href = item.url; wrapper.target = '_blank';
                wrapper.innerHTML = `<div class="bm-bookmark-item"><img src="https://www.google.com/s2/favicons?domain=${host}&sz=64" onerror="this.src='https://www.google.com/s2/favicons?domain=example.com';"><span>${item.name}</span></div>`;
                grid.appendChild(wrapper);
            });

            new Sortable(grid, { group: 'items', animation: 150, delay: 200, delayOnTouchOnly: true, onEnd: (evt) => {
                const fG = evt.from.getAttribute('data-group'); const tG = evt.to.getAttribute('data-group');
                const moveItem = db.pages[db.currentPage][fG].splice(evt.oldIndex, 1)[0];
                db.pages[db.currentPage][tG].splice(evt.newIndex, 0, moveItem);
                saveData();
            }});
            container.appendChild(section);
        });
        overlay.appendChild(container);

        if (isSortMode) {
            new Sortable(container, { animation: 150, onEnd: () => {
                const newOrder = {};
                container.querySelectorAll('.bm-bookmark-section').forEach(sec => { const id = sec.getAttribute('data-id'); newOrder[id] = db.pages[db.currentPage][id]; });
                db.pages[db.currentPage] = newOrder; saveData();
            }});
        }

        // 버튼 이벤트 바인딩
        document.getElementById('btn-sort').onclick = () => { isSortMode = !isSortMode; renderDashboard(); };
        document.getElementById('btn-tab-mgr').onclick = () => showTabManager();
        document.getElementById('btn-add-g').onclick = () => { const n = prompt("새 그룹 이름:"); if(n){ db.pages[db.currentPage][n]=[]; saveData(); renderDashboard(); }};
        document.getElementById('btn-exp').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(db)], {type:"application/json"})); a.download="bookmark_backup.json"; a.click(); };
        document.getElementById('btn-imp').onclick = () => { 
            const i = document.createElement('input'); i.type = 'file'; 
            i.onchange = e => { 
                const r = new FileReader(); 
                r.onload = re => { try { db = JSON.parse(re.target.result); saveData(); renderDashboard(); alert('복구 완료!'); } catch(e){ alert('잘못된 파일입니다.'); } }; 
                r.readAsText(e.target.files[0]); 
            }; i.click(); 
        };
    }

    // 3. 탭 관리자 모달 (신규 추가)
    function showTabManager() {
        const modalBg = document.createElement('div'); modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        let tabsHTML = `<div class="bm-modal-content">
            <h3 style="margin-top:0;">📂 탭 관리</h3>
            <div style="max-height:50vh; overflow-y:auto; border:1px solid #eee; border-radius:8px;">`;
        
        Object.keys(db.pages).forEach(tabName => {
            tabsHTML += `
                <div class="tab-manage-row">
                    <span>${tabName}</span>
                    <button class="bm-util-btn bm-btn-red" style="padding:4px 8px;" onclick="window._delTab('${tabName}')">삭제</button>
                </div>`;
        });

        tabsHTML += `</div>
            <button id="add-new-tab" class="bm-util-btn bm-btn-blue" style="width:100%; margin-top:15px; padding:12px;">+ 새 탭 추가</button>
            <button id="close-tab-mgr" class="bm-util-btn" style="width:100%; margin-top:10px; background:#999 !important; padding:10px;">닫기</button>
        </div>`;
        
        modalBg.innerHTML = tabsHTML;
        document.body.appendChild(modalBg);

        window._delTab = (name) => {
            if (Object.keys(db.pages).length <= 1) { alert("최소 한 개의 탭은 있어야 합니다."); return; }
            if (confirm(`'${name}' 탭을 삭제하시겠습니까?`)) {
                delete db.pages[name];
                if (db.currentPage === name) db.currentPage = Object.keys(db.pages)[0];
                saveData(); renderDashboard(); modalBg.remove();
            }
        };

        document.getElementById('add-new-tab').onclick = () => {
            const n = prompt("새 탭 이름:");
            if (n && !db.pages[n]) {
                db.pages[n] = {};
                db.currentPage = n;
                saveData(); renderDashboard(); modalBg.remove();
            } else if (db.pages[n]) { alert("이미 존재하는 이름입니다."); }
        };
        document.getElementById('close-tab-mgr').onclick = () => modalBg.remove();
    }

    // 4. 그룹 편집 및 퀵 저장 (이전 로직 동일)
    function showGroupManager(gTitle) {
        const modalBg = document.createElement('div'); modalBg.className='bm-modal-bg'; modalBg.style.display='flex';
        let items = db.pages[db.currentPage][gTitle];
        modalBg.innerHTML = `
            <div class="bm-modal-content">
                <h3 style="margin-top:0;">🛠 그룹 관리</h3>
                <input type="text" id="e-g-n" value="${gTitle}">
                <div id="i-l" style="max-height:40vh; overflow-y:auto; border:1px solid #eee; border-radius:8px; padding:10px;">
                    ${items.map((it, idx)=>`
                    <div class="e-r" style="border-bottom:1px solid #eee; padding:10px 0; display:flex; flex-direction:column; gap:5px;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="font-size:11px; font-weight:bold;">북마크 #${idx+1}</span>
                            <span style="color:red; cursor:pointer; font-size:11px;" onclick="this.parentElement.parentElement.remove()">삭제</span>
                        </div>
                        <input type="text" class="r-n" value="${it.name}" placeholder="이름" style="margin:0 !important; font-size:12px;">
                        <input type="text" class="r-u" value="${it.url}" placeholder="URL" style="margin:0 !important; font-size:11px; color:#666;">
                    </div>`).join('')}
                </div>
                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="s-v" class="bm-util-btn bm-btn-green" style="flex:2; padding:12px;">저장</button>
                    <button id="c-l" class="bm-util-btn" style="flex:1; background:#999 !important;">닫기</button>
                </div>
            </div>`;
        document.body.appendChild(modalBg);
        document.getElementById('c-l').onclick = () => modalBg.remove();
        document.getElementById('s-v').onclick = () => {
            const newN = document.getElementById('e-g-n').value.trim();
            const newL = []; 
            modalBg.querySelectorAll('.e-r').forEach(r=>{ 
                const n = r.querySelector('.r-n').value.trim();
                const u = r.querySelector('.r-u').value.trim();
                if(n && u) newL.push({name:n, url:u}); 
            });
            if(newN !== gTitle){ db.pages[db.currentPage][newN]=newL; delete db.pages[db.currentPage][gTitle]; }
            else db.pages[db.currentPage][gTitle]=newL;
            saveData(); renderDashboard(); modalBg.remove();
        };
    }

    function showQuickAddModal() {
        if (document.getElementById('bm-quick-modal')) return;
        const modalBg = document.createElement('div'); modalBg.id = 'bm-quick-modal'; modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        modalBg.innerHTML = `
            <div class="bm-modal-content">
                <h3 style="margin-top:0;">🔖 북마크 저장</h3>
                <input type="text" id="bm-q-n" value="${document.title.substring(0,30)}">
                <div id="q-area">
                    <p style="font-size:12px; font-weight:bold;">탭 선택:</p>
                    <div style="display:flex; flex-wrap:wrap; gap:5px;">
                        ${Object.keys(db.pages).map(p => `<button class="q-p bm-util-btn" style="background:#eee !important; color:#333 !important;">${p}</button>`).join('')}
                    </div>
                </div>
                <button id="q-close" style="width:100%; border:0; background:none; margin-top:20px; color:#999; cursor:pointer;">취소</button>
            </div>`;
        document.body.appendChild(modalBg);
        document.getElementById('q-close').onclick = () => modalBg.remove();
        modalBg.querySelectorAll('.q-p').forEach(btn => {
            btn.onclick = () => {
                const selP = btn.innerText;
                const groups = Object.keys(db.pages[selP]);
                modalBg.querySelector('#q-area').innerHTML = `
                    <p style="font-size:12px; font-weight:bold;">그룹 선택 (${selP}):</p>
                    <div style="display:flex; flex-direction:column; gap:5px;">
                        ${groups.map(g => `<button class="q-g bm-util-btn" style="background:#f8f9fa !important; color:#333 !important; justify-content:flex-start; padding:12px;">📁 ${g}</button>`).join('')}
                        <button id="q-new-g" class="bm-util-btn" style="background:#333 !important; color:#fff !important; padding:12px;">+ 새 그룹 생성</button>
                    </div>`;
                modalBg.querySelectorAll('.q-g').forEach(gBtn => {
                    gBtn.onclick = () => {
                        db.pages[selP][gBtn.innerText.replace('📁 ', '')].push({ name: document.getElementById('bm-q-n').value, url: window.location.href });
                        saveData(); modalBg.remove(); alert('저장되었습니다.');
                    };
                });
                document.getElementById('q-new-g').onclick = () => {
                    const n = prompt("새 그룹 이름:");
                    if(n){
                        if(!db.pages[selP][n]) db.pages[selP][n] = [];
                        db.pages[selP][n].push({ name: document.getElementById('bm-q-n').value, url: window.location.href });
                        saveData(); modalBg.remove(); alert('저장되었습니다.');
                    }
                };
            };
        });
    }

    // 5. FAB 초기화 및 터치 이벤트
    function init() {
        const overlay = document.createElement('div'); overlay.id = 'bookmark-overlay'; document.body.appendChild(overlay);
        const fab = document.createElement('div'); fab.id = 'bookmark-fab'; fab.innerText = '🔖';
        document.body.appendChild(fab);

        let pressTimer;
        let isLongPress = false;
        let startX, startY;

        const handleStart = (e) => {
            const touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX; startY = touch.clientY;
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                if (e.type === 'touchstart') window.navigator.vibrate?.(40);
                showQuickAddModal();
            }, 600);
        };

        const handleEnd = (e) => {
            clearTimeout(pressTimer);
            if (!isLongPress) {
                const touch = e.changedTouches ? e.changedTouches[0] : e;
                const dist = Math.sqrt(Math.pow(touch.clientX - startX, 2) + Math.pow(touch.clientY - startY, 2));
                if (dist < 10) {
                    const isVisible = overlay.style.display === 'block';
                    if (!isVisible) renderDashboard();
                    overlay.style.display = isVisible ? 'none' : 'block';
                    fab.innerText = isVisible ? '🔖' : '✕';
                    document.body.style.overflow = isVisible ? 'auto' : 'hidden';
                }
            }
        };

        fab.addEventListener('touchstart', handleStart, { passive: true });
        fab.addEventListener('touchend', handleEnd, { passive: true });
        fab.addEventListener('mousedown', handleStart);
        fab.addEventListener('mouseup', handleEnd);
        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    init();
})();
