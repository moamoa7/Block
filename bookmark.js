// ==UserScript==
// @name         북마크 (아이콘 롱 프레스 저장 기능 통합 v5.1)
// @version      5.1
// @description  아이콘 클릭 시 대시보드, 0.6초 롱 프레스 시 저장 창 실행. 모든 편집 및 이동 기능 포함.
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

    // 1. 보안 정책 및 데이터 로드
    let ttPolicy;
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        ttPolicy = window.trustedTypes.createPolicy('bmSafePolicy', { createHTML: (s) => s });
    }
    const safe = (h) => ttPolicy ? ttPolicy.createHTML(h) : h;

    let db = GM_getValue('bm_db_v2', { currentPage: "기본", pages: { "기본": { "북마크": [] } } });
    const saveData = () => GM_setValue('bm_db_v2', db);

    // 2. 스타일 설정 (기존 v5.0 레이아웃 유지)
    GM_addStyle(`
        #bookmark-fab { position: fixed; bottom: 20px; right: 20px; width: 55px; height: 55px; background: #333 !important; color: white !important; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 2147483647; box-shadow: 0 4px 15px rgba(0,0,0,0.4); font-size: 26px; user-select: none; transition: transform 0.1s; }
        #bookmark-fab:active { transform: scale(0.9); }
        #bookmark-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.98) !important; z-index: 2147483646; display: none; overflow-y: auto; padding: 20px; backdrop-filter: blur(5px); box-sizing: border-box; color: #333 !important; font-family: sans-serif; }

        .bm-top-row { max-width: 1200px; margin: 0 auto 10px auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        .bm-tab-bar { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 5px; }
        .bm-tab { padding: 8px 15px; background: #eee !important; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: bold; color: #666 !important; border: 0 !important; }
        .bm-tab.active { background: #333 !important; color: #fff !important; }

        .bm-admin-bar { display: flex; gap: 6px; }
        .bm-util-btn { padding: 8px 12px; font-size: 12px; color: #fff !important; background: #333 !important; border: 0 !important; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; }
        .bm-btn-red { background: #dc3545 !important; }

        .bm-dashboard-container { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; max-width: 1200px; margin: 0 auto; }
        .bm-bookmark-section { background: white !important; border: 1px solid #ddd !important; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05); overflow: hidden; margin-bottom: 5px; }
        .bm-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f1f3f5 !important; border-bottom: 1px solid #ddd !important; cursor: grab; }

        .bm-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(80px, 1fr)); gap: 10px; padding: 15px; min-height: 50px; }
        .bm-item-wrapper { position: relative; display: flex !important; flex-direction: column !important; align-items: center !important; padding: 10px 5px !important; border-radius: 8px; cursor: grab; }
        .bm-item-wrapper:hover { background: #f0f0f0 !important; }
        .bm-bookmark-item img { width: 36px !important; height: 36px !important; margin-bottom: 8px !important; pointer-events: none; border: 0 !important; }
        .bm-bookmark-item span { font-size: 11px !important; color: #444 !important; width: 100% !important; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; display: block !important; }

        .bm-modal-bg { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6) !important; z-index:2147483647; display:none; align-items:center; justify-content:center; }
        .bm-modal-content { background: white !important; padding: 25px; border-radius: 15px; width: 90%; max-width: 450px; box-shadow: 0 15px 50px rgba(0,0,0,0.5); color: #333 !important; }
        .bm-modal-content input { width: 100% !important; padding: 10px !important; margin: 5px 0 !important; border: 1px solid #ccc !important; border-radius: 6px !important; background: #fff !important; color: #000 !important; box-sizing: border-box !important; }
        .bm-select-btn { display: flex !important; width: 100% !important; padding: 12px !important; margin: 5px 0 !important; background: #fff !important; color: #333 !important; border: 2px solid #eee !important; border-radius: 8px !important; cursor: pointer !important; align-items: center; justify-content: space-between; font-weight: bold !important; font-size: 14px !important; }
        .bm-select-btn.selected { background: #eef2ff !important; border-color: #6366f1 !important; color: #4338ca !important; }
    `);

    // 3. 그룹 관리자 모달
    function showGroupManager(gTitle) {
        const modalBg = document.createElement('div');
        modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        let items = db.pages[db.currentPage][gTitle];
        let listHTML = `<div class="bm-modal-content">
            <h3 style="margin-top:0;">🛠 그룹 관리</h3>
            <input type="text" id="edit-g-name" value="${gTitle}">
            <div id="item-list" style="max-height:40vh; overflow-y:auto; border:1px solid #eee; border-radius:8px; margin:15px 0;">`;
        items.forEach((item, idx) => {
            listHTML += `<div class="bm-edit-row" style="padding:10px; border-bottom:1px solid #eee; position:relative;">
                <span style="position:absolute; top:5px; right:5px; color:red; cursor:pointer; font-size:11px;" onclick="this.parentElement.remove()">삭제</span>
                <input type="text" class="row-n" value="${item.name}" style="font-size:12px;">
                <input type="text" class="row-u" value="${item.url}" style="font-size:11px; color:#666;">
            </div>`;
        });
        listHTML += `</div>
            <div style="display:flex; flex-direction:column; gap:8px;">
                <button id="bm-save-all" class="bm-util-btn" style="background:#28a745 !important; justify-content:center;">저장</button>
                <div style="display:flex; gap:8px;">
                    <button id="bm-del-group" class="bm-util-btn bm-btn-red" style="flex:1; justify-content:center;">삭제</button>
                    <button id="bm-close" class="bm-util-btn" style="flex:1; background:#999 !important; justify-content:center;">닫기</button>
                </div>
            </div>
        </div>`;
        modalBg.innerHTML = safe(listHTML);
        document.body.appendChild(modalBg);
        document.getElementById('bm-save-all').onclick = () => {
            const newName = document.getElementById('edit-g-name').value.trim();
            const newList = [];
            modalBg.querySelectorAll('.bm-edit-row').forEach(row => {
                const n = row.querySelector('.row-n').value.trim();
                const u = row.querySelector('.row-u').value.trim();
                if (n && u) newList.push({ name: n, url: u });
            });
            if (newName !== gTitle) { db.pages[db.currentPage][newName] = newList; delete db.pages[db.currentPage][gTitle]; }
            else { db.pages[db.currentPage][gTitle] = newList; }
            saveData(); renderDashboard(); modalBg.remove();
        };
        document.getElementById('bm-del-group').onclick = () => { if (confirm('그룹 삭제?')) { delete db.pages[db.currentPage][gTitle]; saveData(); renderDashboard(); modalBg.remove(); } };
        document.getElementById('bm-close').onclick = () => modalBg.remove();
    }

    // 4. 대시보드 렌더링
    function renderDashboard() {
        const overlay = document.getElementById('bookmark-overlay');
        if (!overlay) return;
        overlay.innerHTML = safe('');
        const topRow = document.createElement('div'); topRow.className = 'bm-top-row';
        const tabBar = document.createElement('div'); tabBar.className = 'bm-tab-bar';
        Object.keys(db.pages).forEach(p => {
            const tab = document.createElement('div'); tab.className = `bm-tab ${db.currentPage === p ? 'active' : ''}`;
            tab.innerText = p; tab.onclick = () => { db.currentPage = p; saveData(); renderDashboard(); };
            tabBar.appendChild(tab);
        });
        const adminBar = document.createElement('div'); adminBar.className = 'bm-admin-bar';
        adminBar.innerHTML = safe(`<button class="bm-util-btn" id="btn-add-tab">탭+</button><button class="bm-util-btn bm-btn-red" id="btn-del-tab">탭-</button><button class="bm-util-btn" id="btn-add-group">그룹+</button><button class="bm-util-btn" id="btn-export">백업</button><button class="bm-util-btn" id="btn-import">복구</button>`);
        topRow.appendChild(tabBar); topRow.appendChild(adminBar); overlay.appendChild(topRow);
        const container = document.createElement('div'); container.className = 'bm-dashboard-container';
        Object.entries(db.pages[db.currentPage]).forEach(([gTitle, items]) => {
            const section = document.createElement('div'); section.className = 'bm-bookmark-section'; section.setAttribute('data-id', gTitle);
            section.innerHTML = safe(`<div class="bm-section-header"><span style="font-weight:bold; font-size:13px;">📖 ${gTitle}</span><button class="bm-util-btn bm-manage-btn" style="padding:4px 8px; font-size:11px;">관리</button></div><div class="bm-item-grid" data-group="${gTitle}"></div>`);
            section.querySelector('.bm-manage-btn').onclick = () => showGroupManager(gTitle);
            const grid = section.querySelector('.bm-item-grid');
            items.forEach((item) => {
                let host = ''; try { host = new URL(item.url).hostname; } catch(e) {}
                const wrapper = document.createElement('div'); wrapper.className = 'bm-item-wrapper';
                wrapper.innerHTML = safe(`<div class="bm-bookmark-item"><img src="https://www.google.com/s2/favicons?domain=${host}&sz=64"><span>${item.name}</span></div>`);
                wrapper.onclick = () => window.open(item.url, '_blank');
                grid.appendChild(wrapper);
            });
            new Sortable(grid, { group: 'items', animation: 150, onEnd: (evt) => {
                const fG = evt.from.getAttribute('data-group'); const tG = evt.to.getAttribute('data-group');
                const moveItem = db.pages[db.currentPage][fG].splice(evt.oldIndex, 1)[0];
                db.pages[db.currentPage][tG].splice(evt.newIndex, 0, moveItem);
                saveData();
            }});
            container.appendChild(section);
        });
        overlay.appendChild(container);
        new Sortable(container, { animation: 150, handle: '.bm-section-header', onEnd: () => {
            const newOrder = {};
            container.querySelectorAll('.bm-bookmark-section').forEach(sec => { const id = sec.getAttribute('data-id'); newOrder[id] = db.pages[db.currentPage][id]; });
            db.pages[db.currentPage] = newOrder; saveData();
        }});
        document.getElementById('btn-add-tab').onclick = () => { const n = prompt("새 탭:"); if(n) { db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); }};
        document.getElementById('btn-del-tab').onclick = () => { if (Object.keys(db.pages).length <= 1) return; if (confirm('탭 삭제?')) { delete db.pages[db.currentPage]; db.currentPage = Object.keys(db.pages)[0]; saveData(); renderDashboard(); } };
        document.getElementById('btn-add-group').onclick = () => { const n = prompt("새 그룹:"); if(n) { db.pages[db.currentPage][n] = []; saveData(); renderDashboard(); } };
        document.getElementById('btn-export').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 4)], { type: "application/json" })); a.download = "backup.json"; a.click(); };
        document.getElementById('btn-import').onclick = () => { const i = document.createElement('input'); i.type = 'file'; i.onchange = e => { const r = new FileReader(); r.onload = re => { db = JSON.parse(re.target.result); saveData(); renderDashboard(); }; r.readAsText(e.target.files[0]); }; i.click(); };
    }

    // 5. 퀵 저장 모달
    function showQuickAddModal() {
        const modalBg = document.createElement('div'); modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        modalBg.innerHTML = safe(`<div class="bm-modal-content"><h3>🔖 저장</h3><input type="text" id="bm-q-n" value="${document.title.substring(0,30)}"><input type="text" id="bm-q-u" value="${window.location.href}"><div id="q-area"><p style="font-size:12px; margin-top:15px; font-weight:bold;">페이지 선택:</p><div id="q-page-container">${Object.keys(db.pages).map(p => `<button class="bm-select-btn q-p ${db.currentPage === p ? 'selected' : ''}" data-p="${p}"><span>${p}</span>${db.currentPage === p ? '<span>✔</span>' : ''}</button>`).join('')}</div></div><button id="q-cls" style="width:100%; border:0; background:none; margin-top:20px; color:#999; cursor:pointer;">닫기</button></div>`);
        document.body.appendChild(modalBg);
        document.getElementById('q-cls').onclick = () => modalBg.remove();
        modalBg.querySelectorAll('.q-p').forEach(btn => {
            btn.onclick = () => {
                const selP = btn.getAttribute('data-p');
                modalBg.querySelector('#q-area').innerHTML = safe(`<p style="font-size:12px; margin-top:10px;">그룹 선택:</p>${Object.keys(db.pages[selP]).map(g => `<button class="bm-select-btn q-g" data-g="${g}">📁 ${g}</button>`).join('')}<button class="bm-select-btn" id="q-new" style="background:#6366f1 !important; color:white !important; text-align:center; justify-content:center;">➕ 새 그룹 생성</button><button id="q-back" style="width:100%; border:none; background:none; color:#007bff; margin-top:10px; cursor:pointer; font-size:12px;">⬅ 뒤로</button>`);
                modalBg.querySelectorAll('.q-g').forEach(gBtn => { gBtn.onclick = () => { db.pages[selP][gBtn.getAttribute('data-g')].push({ name: document.getElementById('bm-q-n').value, url: document.getElementById('bm-q-u').value }); saveData(); modalBg.remove(); alert('저장됨'); }; });
                document.getElementById('q-new').onclick = () => { const n = prompt("새 그룹:"); if (n) { if (!db.pages[selP][n]) db.pages[selP][n] = []; db.pages[selP][n].push({ name: document.getElementById('bm-q-n').value, url: document.getElementById('bm-q-u').value }); saveData(); modalBg.remove(); alert('저장됨'); } };
                document.getElementById('q-back').onclick = () => { modalBg.remove(); showQuickAddModal(); };
            };
        });
    }

    // 6. [핵심] 아이콘 전용 이벤트 바인딩
    function init() {
        const overlay = document.createElement('div'); overlay.id = 'bookmark-overlay'; document.body.appendChild(overlay);
        const fab = document.createElement('div'); fab.id = 'bookmark-fab'; fab.innerHTML = safe('🔖');
        document.body.appendChild(fab);

        let pressTimer;
        let isLongPress = false;

        // 아이콘을 누르기 시작할 때
        const startPress = (e) => {
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                showQuickAddModal();
            }, 600); // 0.6초 롱 프레스
        };

        // 아이콘에서 손을 뗄 때
        const endPress = (e) => {
            clearTimeout(pressTimer);
            if (!isLongPress) {
                // 짧은 클릭일 때만 대시보드 토글
                const v = overlay.style.display === 'block';
                if (!v) renderDashboard();
                overlay.style.display = v ? 'none' : 'block';
                fab.innerHTML = safe(v ? '🔖' : '✖');
                document.body.style.overflow = v ? 'auto' : 'hidden';
            }
        };

        // 롱 프레스 취소 조건
        const cancelPress = () => clearTimeout(pressTimer);

        fab.addEventListener('mousedown', startPress);
        fab.addEventListener('touchstart', startPress, {passive: true});
        fab.addEventListener('mouseup', endPress);
        fab.addEventListener('touchend', endPress, {passive: true});
        fab.addEventListener('touchmove', cancelPress, {passive: true});
        fab.addEventListener('mousemove', cancelPress);

        // 기존 Alt+Shift+A 단축키는 보조 수단으로 유지
        window.addEventListener('keydown', (e) => { if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); showQuickAddModal(); } }, true);
    }

    init();
})();
