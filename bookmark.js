// ==UserScript==
// @name         북마크 (아이콘 롱 프레스 저장 기능 통합 v7.0)
// @version      7.0
// @description  상단 레이아웃 2단 분리(버튼 위, 탭 아래)로 모바일 가림 현상 해결
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
    let isSortMode = false;

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

    // 선명한 파란색 채워진 지구본 아이콘
    const fallbackIcon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiIGZpbGw9IiMwMDdiZmYiLz48cGF0aCBkPSJNMiAxMmgyME0xMiAyYTE1LjMgMTUuMyAwIDAgMSA0IDEwIDE1LjMgMTUuMyAwIDAgMS00IDEwIDE1LjMgMTUuMyAwIDAgMS00LTEwIDE1LjMgMTUuMyAwIDAgMSA0LTEweiIgc3Ryb2tlPSIjZmZmIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9Im5vbmUiLz48L3N2Zz4=";

    // 1. 파비콘 다운로드 함수
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
                            let u8 = new Uint8Array(res.response);
                            let binary = '';
                            for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
                            const base64 = window.btoa(binary);
                            resolve(`data:image/png;base64,${base64}`);
                        } catch (e) { resolve(fallbackIcon); }
                    },
                    onerror: () => resolve(fallbackIcon)
                });
            } catch (e) { resolve(fallbackIcon); }
        });
    }

    // 2. 아이콘 강제 복구
    async function fixAllIcons() {
        if (!confirm("모든 아이콘을 다시 다운로드합니다.\n진행하시겠습니까?")) return;
        const noti = document.createElement('div');
        noti.style.cssText = "position:fixed; top:50%; left:50%; transform:translate(-50%, -50%); background:rgba(0,0,0,0.8); color:white; padding:20px; z-index:999999; border-radius:10px; font-weight:bold; text-align:center;";
        setHtml(noti, "아이콘 업데이트 중...");
        document.body.appendChild(noti);

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

    // 3. 스타일 설정 (레이아웃 2단 분리 적용)
    GM_addStyle(`
        #bookmark-fab {
            position: fixed; bottom: 20px; right: 20px; width: 55px; height: 55px;
            background: #333 !important; color: white !important; border-radius: 50% !important;
            display: flex !important; align-items: center !important; justify-content: center !important;
            cursor: pointer; z-index: 2147483647; box-shadow: 0 4px 15px rgba(0,0,0,0.4);
            font-size: 26px !important; user-select: none !important;
            touch-action: none !important; -webkit-tap-highlight-color: transparent; border: none !important;
        }
        #bookmark-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(255, 255, 255, 0.98) !important; z-index: 2147483646; display: none; overflow-y: auto; padding: 15px; backdrop-filter: blur(5px); box-sizing: border-box; color: #333 !important; font-family: sans-serif; text-align: left !important; }

        .bm-modal-content, .bm-dashboard-container { color: #333 !important; text-align: left !important; font-family: sans-serif !important; }

        /* 버튼 텍스트 강제 표시 */
        .bm-util-btn, .bm-manage-btn, #bookmark-overlay button, .bm-modal-content button {
            text-indent: 0 !important; font-size: 11px !important; line-height: normal !important;
            visibility: visible !important; opacity: 1 !important; font-family: sans-serif !important;
            display: inline-flex !important; align-items: center !important; justify-content: center !important;
            box-sizing: border-box !important;
        }

        .bm-modal-content input, #bookmark-overlay input { width: 100% !important; padding: 10px !important; margin: 5px 0 !important; border: 1px solid #ccc !important; background-color: #fff !important; color: #000 !important; border-radius: 6px !important; box-sizing: border-box !important; font-size: 14px !important; display: block !important; opacity: 1 !important; visibility: visible !important; height: auto !important; -webkit-appearance: none !important; }
        .bm-modal-content label { display: block !important; font-size: 12px !important; font-weight: bold !important; color: #666 !important; margin-top: 10px !important; }

        /* [핵심] 상단 레이아웃 분리 */
        .bm-top-row { max-width: 1200px; margin: 0 auto 10px auto; display: flex; flex-direction: column; gap: 8px; }

        /* 1단: 관리 버튼 (오른쪽 정렬) */
        .bm-admin-bar { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; width: 100%; }

        /* 2단: 탭 바 (전체 너비) */
        .bm-tab-bar { display: flex; gap: 5px; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 5px; width: 100%; }

        .bm-tab { padding: 8px 14px; background: #eee !important; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: bold; color: #666 !important; white-space: nowrap; border: 0 !important; flex-shrink: 0; }
        .bm-tab.active { background: #333 !important; color: #fff !important; }

        .bm-util-btn { padding: 7px 10px; color: #fff !important; background: #333 !important; border: 0 !important; border-radius: 6px; cursor: pointer; text-decoration: none !important; }
        .bm-btn-blue { background: #007bff !important; }
        .bm-btn-green { background: #28a745 !important; }
        .bm-btn-orange { background: #fd7e14 !important; }

        .bm-dashboard-container { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 15px; max-width: 1200px; margin: 0 auto; }
        .bm-bookmark-section { background: white !important; border: 1px solid #ddd !important; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
        .bm-section-header { display: flex; justify-content: space-between; align-items: center; padding: 12px; background: #f1f3f5 !important; border-bottom: 1px solid #ddd !important; }
        .bm-manage-btn { border: 1px solid #ccc !important; background: #fff !important; color: #333 !important; padding: 5px 10px !important; border-radius: 6px !important; font-weight: bold !important; }

        .bm-item-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); gap: 12px; padding: 15px; min-height: 60px; justify-items: center; }
        .bm-item-wrapper { display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; text-decoration: none !important; color: inherit !important; width: 100% !important; max-width: 80px; }
        .bm-bookmark-item { display: flex !important; flex-direction: column !important; align-items: center !important; text-align: center !important; width: 100% !important; }
        .bm-bookmark-item img {
            width: 38px !important; height: 38px !important; min-width: 38px !important; min-height: 38px !important;
            margin-bottom: 6px !important; border-radius: 8px !important; background: #fff !important;
            object-fit: contain !important; pointer-events: none; display: block !important;
            opacity: 1 !important; visibility: visible !important; filter: none !important;
        }
        .bm-bookmark-item span { font-size: 11px !important; color: #333 !important; width: 100% !important; text-align: center !important; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block !important; pointer-events: none; }

        .sort-mode-active .bm-item-grid { display: none !important; }
        .sort-mode-active .bm-bookmark-section { border: 2px dashed #007bff !important; cursor: move; margin-bottom: 5px; }
        .sort-mode-active .bm-dashboard-container { grid-template-columns: 1fr !important; }
        .bm-modal-bg { position: fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6) !important; z-index:2147483647; display:none; align-items:center; justify-content:center; padding: 20px; box-sizing: border-box; }
        .bm-modal-content { background: white !important; padding: 25px; border-radius: 15px; width: 100%; max-width: 420px; max-height: 85vh; overflow-y: auto; color: #333 !important; }
        .tab-manage-row { display: flex; align-items: center; justify-content: space-between; padding: 10px; border-bottom: 1px solid #eee; gap: 10px; }
        .bm-drag-handle { cursor: grab; font-size: 18px; margin-right: 10px; color: #888; touch-action: none; }
    `);

    // 4. 대시보드 렌더링
    function renderDashboard() {
        const overlay = document.getElementById('bookmark-overlay');
        if (!overlay) return;
        overlay.className = isSortMode ? 'sort-mode-active' : '';
        setHtml(overlay, '');

        const topRow = document.createElement('div'); topRow.className = 'bm-top-row';
        // bm-nav 제거하고 topRow에 직접 순서대로 배치

        const tabBar = document.createElement('div'); tabBar.className = 'bm-tab-bar';
        Object.keys(db.pages).forEach(p => {
            const tab = document.createElement('div'); tab.className = `bm-tab ${db.currentPage === p ? 'active' : ''}`;
            tab.innerText = p; tab.onclick = () => { db.currentPage = p; isSortMode = false; renderDashboard(); };
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

        // [순서 중요] 버튼바 먼저(위), 탭바 나중(아래)
        topRow.appendChild(adminBar);
        topRow.appendChild(tabBar);
        overlay.appendChild(topRow);

        const container = document.createElement('div'); container.className = 'bm-dashboard-container';
        Object.entries(db.pages[db.currentPage]).forEach(([gTitle, items]) => {
            const section = document.createElement('div'); section.className = 'bm-bookmark-section'; section.setAttribute('data-id', gTitle);
            setHtml(section, `
                <div class="bm-section-header">
                    <span style="font-weight:bold; font-size:14px;">${isSortMode ? '≡ ' : '📁 '} ${gTitle}</span>
                    ${!isSortMode ? '<button class="bm-manage-btn">관리</button>' : ''}
                </div>
                <div class="bm-item-grid" data-group="${gTitle}"></div>
            `);
            if(!isSortMode) section.querySelector('.bm-manage-btn').onclick = () => showGroupManager(gTitle);

            const grid = section.querySelector('.bm-item-grid');
            items.forEach((item) => {
                const wrapper = document.createElement('a');
                wrapper.className = 'bm-item-wrapper'; wrapper.href = item.url; wrapper.target = '_blank';
                const iconSrc = (item.icon && item.icon.startsWith('data:')) ? item.icon : fallbackIcon;
                setHtml(wrapper, `<div class="bm-bookmark-item"><img src="${iconSrc}"><span>${item.name}</span></div>`);
                grid.appendChild(wrapper);
            });
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

        document.getElementById('btn-sort').onclick = () => { isSortMode = !isSortMode; renderDashboard(); };
        document.getElementById('btn-fix-icon').onclick = () => fixAllIcons();
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

    // 5. 그룹 관리자 (추가 버튼 생성)
    function showGroupManager(gTitle) {
        const modalBg = document.createElement('div'); modalBg.className='bm-modal-bg'; modalBg.style.display='flex';
        let items = db.pages[db.currentPage][gTitle];

        setHtml(modalBg, `
            <div class="bm-modal-content">
                <h3 style="margin-top:0;">🛠 그룹 관리</h3>
                <label>그룹 이름</label>
                <input type="text" id="e-g-n" value="${gTitle}">
                <div style="font-size:12px; margin-top:10px; color:#666;">☰ 핸들을 잡고 드래그하여 순서를 변경하세요.</div>

                <div id="i-l" style="max-height:40vh; overflow-y:auto; border:1px solid #eee; border-radius:8px; padding:10px; margin-top:5px;">
                    ${items.map((it, idx)=>`
                    <div class="e-r" style="border-bottom:1px solid #eee; padding:10px 0; display:flex; gap:10px; align-items:center;">
                        <span class="bm-drag-handle">☰</span>
                        <div style="flex:1;">
                            <div style="display:flex; justify-content:flex-end;">
                                <span style="color:red; cursor:pointer; font-size:11px;" class="bm-del-btn">삭제</span>
                            </div>
                            <input type="text" class="r-n" value="${it.name}" placeholder="이름" style="margin-bottom:5px !important;">
                            <input type="text" class="r-u" value="${it.url}" placeholder="URL">
                        </div>
                    </div>`).join('')}
                </div>

                <button id="g-add-new" class="bm-util-btn bm-btn-blue" style="width:100%; margin-top:10px; padding:10px;">+ 북마크 추가</button>

                <div style="display:flex; gap:10px; margin-top:20px;">
                    <button id="s-v" class="bm-util-btn bm-btn-green" style="flex:2; padding:12px;">저장</button>
                    <button id="c-l" class="bm-util-btn" style="flex:1; background:#999 !important;">닫기</button>
                </div>
            </div>
        `);
        document.body.appendChild(modalBg);

        modalBg.querySelectorAll('.bm-del-btn').forEach(btn => btn.onclick = function() { this.closest('.e-r').remove(); });

        document.getElementById('g-add-new').onclick = () => {
            const row = document.createElement('div');
            row.className = 'e-r';
            row.style.cssText = "border-bottom:1px solid #eee; padding:10px 0; display:flex; gap:10px; align-items:center;";
            setHtml(row, `
                <span class="bm-drag-handle">☰</span>
                <div style="flex:1;">
                    <div style="display:flex; justify-content:flex-end;">
                        <span style="color:red; cursor:pointer; font-size:11px;" class="bm-del-btn">삭제</span>
                    </div>
                    <input type="text" class="r-n" placeholder="새 북마크 이름" style="margin-bottom:5px !important;">
                    <input type="text" class="r-u" placeholder="https://" value="https://">
                </div>
            `);
            row.querySelector('.bm-del-btn').onclick = function() { this.closest('.e-r').remove(); };
            document.getElementById('i-l').appendChild(row);
            const list = document.getElementById('i-l');
            list.scrollTop = list.scrollHeight;
        };

        new Sortable(document.getElementById('i-l'), { handle: '.bm-drag-handle', animation: 150 });
        document.getElementById('c-l').onclick = () => modalBg.remove();

        document.getElementById('s-v').onclick = () => {
            const newN = document.getElementById('e-g-n').value.trim();
            const newL = [];
            modalBg.querySelectorAll('.e-r').forEach(r=>{
                const n = r.querySelector('.r-n').value.trim();
                const u = r.querySelector('.r-u').value.trim();
                if(n && u) newL.push({name:n, url:u});
            });
            newL.forEach(newItem => {
                const oldItem = items.find(o => o.url === newItem.url);
                if(oldItem && oldItem.icon) newItem.icon = oldItem.icon;
            });
            if(newN !== gTitle){ db.pages[db.currentPage][newN]=newL; delete db.pages[db.currentPage][gTitle]; }
            else db.pages[db.currentPage][gTitle]=newL;
            saveData(); renderDashboard(); modalBg.remove();
        };
    }

    // 6. 탭 관리자 및 퀵저장
    function showTabManager() {
        const modalBg = document.createElement('div'); modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        let tabsHTML = `<div class="bm-modal-content"><h3 style="margin-top:0;">📂 탭 관리</h3><div style="max-height:50vh; overflow-y:auto; border:1px solid #eee; border-radius:8px;">`;
        Object.keys(db.pages).forEach(tabName => {
            tabsHTML += `<div class="tab-manage-row"><span>${tabName}</span><button class="bm-util-btn bm-btn-red" style="padding:4px 8px;" onclick="window._delTab('${tabName}')">삭제</button></div>`;
        });
        tabsHTML += `</div><button id="add-new-tab" class="bm-util-btn bm-btn-blue" style="width:100%; margin-top:15px; padding:12px;">+ 새 탭 추가</button><button id="close-tab-mgr" class="bm-util-btn" style="width:100%; margin-top:10px; background:#999 !important; padding:10px;">닫기</button></div>`;
        setHtml(modalBg, tabsHTML); document.body.appendChild(modalBg);
        window._delTab = (name) => { if (Object.keys(db.pages).length <= 1) { alert("최소 1개 탭 필수"); return; } if (confirm('삭제?')) { delete db.pages[name]; if (db.currentPage === name) db.currentPage = Object.keys(db.pages)[0]; saveData(); renderDashboard(); modalBg.remove(); } };
        document.getElementById('add-new-tab').onclick = () => { const n = prompt("새 탭 이름:"); if (n && !db.pages[n]) { db.pages[n] = {}; db.currentPage = n; saveData(); renderDashboard(); modalBg.remove(); } else if (db.pages[n]) { alert("중복 이름"); } };
        document.getElementById('close-tab-mgr').onclick = () => modalBg.remove();
    }

    function showQuickAddModal() {
        if (document.getElementById('bm-quick-modal')) return;
        const modalBg = document.createElement('div'); modalBg.id = 'bm-quick-modal'; modalBg.className = 'bm-modal-bg'; modalBg.style.display = 'flex';
        setHtml(modalBg, `<div class="bm-modal-content"><h3 style="margin-top:0;">🔖 북마크 저장</h3><label>이름</label><input type="text" id="bm-q-n" value="${document.title.substring(0,30)}"><label>주소 (URL)</label><input type="text" id="bm-q-u" value="${window.location.href}"><div id="q-area"><p style="font-size:12px; font-weight:bold; margin-top:15px;">탭 선택:</p><div style="display:flex; flex-wrap:wrap; gap:5px;">${Object.keys(db.pages).map(p => `<button class="q-p bm-util-btn" style="background:#eee !important; color:#333 !important;">${p}</button>`).join('')}</div></div><button id="q-close" style="width:100%; border:0; background:none; margin-top:20px; color:#999; cursor:pointer;">취소</button></div>`);
        document.body.appendChild(modalBg);
        document.getElementById('q-close').onclick = () => modalBg.remove();
        modalBg.querySelectorAll('.q-p').forEach(btn => {
            btn.onclick = () => {
                const selP = btn.innerText;
                const groups = Object.keys(db.pages[selP]);
                setHtml(modalBg.querySelector('#q-area'), `<p style="font-size:12px; font-weight:bold;">그룹 선택 (${selP}):</p><div style="display:flex; flex-direction:column; gap:5px;">${groups.map(g => `<button class="q-g bm-util-btn" style="background:#f8f9fa !important; color:#333 !important; justify-content:flex-start; padding:12px;">📁 ${g}</button>`).join('')}<button id="q-new-g" class="bm-util-btn" style="background:#333 !important; color:#fff !important; padding:12px;">+ 새 그룹 생성</button></div>`);
                modalBg.querySelectorAll('.q-g').forEach(gBtn => { gBtn.onclick = async () => { const fName = document.getElementById('bm-q-n').value; const fUrl = document.getElementById('bm-q-u').value; const icon = await fetchFaviconBase64(fUrl); db.pages[selP][gBtn.innerText.replace('📁 ', '')].push({ name: fName, url: fUrl, icon: icon }); saveData(); modalBg.remove(); alert('저장됨'); }; });
                document.getElementById('q-new-g').onclick = async () => { const n = prompt("새 그룹 이름:"); if(n){ const fName = document.getElementById('bm-q-n').value; const fUrl = document.getElementById('bm-q-u').value; const icon = await fetchFaviconBase64(fUrl); if(!db.pages[selP][n]) db.pages[selP][n] = []; db.pages[selP][n].push({ name: fName, url: fUrl, icon: icon }); saveData(); modalBg.remove(); alert('저장됨'); } };
            };
        });
    }

    // 7. 초기화
    function init() {
        const overlay = document.createElement('div'); overlay.id = 'bookmark-overlay'; document.body.appendChild(overlay);
        const fab = document.createElement('div'); fab.id = 'bookmark-fab'; fab.innerText = '🔖';
        document.body.appendChild(fab);
        let pressTimer, isLongPress = false, startX, startY;
        let isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        const handleStart = (e) => { const touch = e.touches ? e.touches[0] : e; startX = touch.clientX; startY = touch.clientY; isLongPress = false; pressTimer = setTimeout(() => { isLongPress = true; if (e.type === 'touchstart') window.navigator.vibrate?.(40); showQuickAddModal(); }, 600); };
        const handleEnd = (e) => { clearTimeout(pressTimer); if (!isLongPress) { const touch = e.changedTouches ? e.changedTouches[0] : e; const dist = Math.hypot(touch.clientX - startX, touch.clientY - startY); if (dist < 10) { const isVisible = overlay.style.display === 'block'; if (!isVisible) renderDashboard(); overlay.style.display = isVisible ? 'none' : 'block'; fab.innerText = isVisible ? '🔖' : '✕'; document.body.style.overflow = isVisible ? 'auto' : 'hidden'; } } };
        if (isTouchDevice) { fab.addEventListener('touchstart', handleStart, { passive: true }); fab.addEventListener('touchend', handleEnd, { passive: true }); } else { fab.addEventListener('mousedown', handleStart); fab.addEventListener('mouseup', handleEnd); }
        fab.addEventListener('contextmenu', e => e.preventDefault());
    }

    init();
})();
