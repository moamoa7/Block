
// ==UserScript==
// @name         📝 화면분할 메모장
// @namespace    http://tampermonkey.net/
// @version      0.0
// @description  웹페이지를 밀어내고 열리는 다기능 메모장 (마크다운 지원)
// @match        *://*/*
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    // 🌟 [중요 버그 수정] iframe(광고창, 삽입된 영상 등)에서 스크립트가 중복 실행되어 버튼이 여러개 생기는 것을 방지
    if (window.top !== window.self) return;

    // --- [1] 기본 설정 및 상태 관리 ---
    let notes = GM_getValue('smart_notes', [{ id: Date.now(), text: '' }]);
    let activeId = GM_getValue('smart_active_id', notes[0].id);
    let isOpen = false;
    let isPreviewMode = false;

    let currentWidth = GM_getValue('smart_width', 50);
    let isLeftPosition = GM_getValue('smart_position_left', false);

    // --- [2] UI 요소 생성 ---
    const container = document.createElement('div');
    container.id = 'smart-notepad-container';
    container.innerHTML = `
        <div id="sn-resizer"></div>
        <div id="sn-sidebar">
            <div id="sn-sidebar-header">
                <button id="sn-add-btn">+ 새 메모</button>
                <button id="sn-close-btn">닫기</button>
            </div>
            <div id="sn-list"></div>
        </div>
        <div id="sn-main">
            <div id="sn-editor-toolbar">
                <button id="sn-view-toggle-btn" title="마크다운/HTML 미리보기">👀 미리보기</button>
                <button id="sn-copy-btn" title="원본 텍스트 복사">📋 원본 복사</button>
                <button id="sn-position-btn" title="메모장 위치 좌/우 반전">↔️ 좌우 이동</button>
            </div>
            <textarea id="sn-editor" placeholder="메모를 입력하세요..."></textarea>
            <div id="sn-preview" style="display: none;" class="markdown-body"></div>
            <div id="sn-statusbar">
                <span id="sn-stats">글자수: 0 | 토큰(추정): 0</span>
                <span id="sn-selection-badge" style="display:none; color: #ff9800; font-size: 14px !important;">(선택됨)</span>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'sn-toggle-btn';
    toggleBtn.innerText = '📝';
    toggleBtn.title = '메모장 열기';
    document.body.appendChild(toggleBtn);

    // --- [3] CSS 스타일 ---
    GM_addStyle(`
        #sn-toggle-btn {
            position: fixed !important; bottom: 20px !important; right: 20px !important; z-index: 2147483646 !important;
            background: #333 !important; color: #fff !important; border: none !important;
            width: 50px !important; height: 50px !important; border-radius: 50% !important;
            display: flex !important; justify-content: center !important; align-items: center !important;
            cursor: pointer !important; font-size: 24px !important;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3) !important; transition: 0.2s !important; padding: 0 !important;
        }
        #sn-toggle-btn:hover { background: #555 !important; transform: scale(1.1) !important; }
        #smart-notepad-container {
            position: fixed !important; top: 0 !important; height: 100vh !important; width: ${currentWidth}vw !important;
            background: #252526 !important; color: #d4d4d4 !important; z-index: 2147483647 !important;
            display: flex !important; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif !important;
            box-shadow: 0 0 15px rgba(0,0,0,0.5) !important; transition: right 0.3s ease, left 0.3s ease, width 0.1s !important;
        }
        #sn-resizer { width: 5px !important; background: #1e1e1e !important; cursor: ew-resize !important; flex-shrink: 0 !important; transition: background 0.2s !important; }
        #sn-resizer:hover, #sn-resizer.resizing { background: #007acc !important; }
        #sn-sidebar {
            width: 180px !important; background: #1e1e1e !important; display: flex !important; flex-direction: column !important;
            border-right: 1px solid #333 !important; border-left: 1px solid #333 !important; flex-shrink: 0 !important;
        }
        #sn-sidebar-header { padding: 15px 10px !important; display: flex !important; gap: 8px !important; flex-direction: column !important;}
        #sn-sidebar-header button {
            background: #3c3c3c !important; color: #fff !important; border: none !important; padding: 10px !important;
            cursor: pointer !important; border-radius: 4px !important; font-size: 14px !important;
        }
        #sn-sidebar-header button:hover { background: #555 !important; }
        #sn-list { flex: 1 !important; overflow-y: auto !important; }
        .sn-list-item {
            padding: 15px 10px !important; cursor: pointer !important; border-bottom: 1px solid #333 !important;
            font-size: 15px !important; color: #aaa !important; display: flex !important; justify-content: space-between !important; align-items: center !important;
        }
        .sn-list-text { white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; flex: 1 !important; }
        .sn-delete-btn {
            background: none !important; border: none !important; color: #666 !important; font-size: 14px !important;
            cursor: pointer !important; padding: 2px 5px !important; margin-left: 5px !important; font-weight: bold !important; transition: 0.2s !important;
        }
        .sn-delete-btn:hover { color: #ff4d4d !important; }
        .sn-list-item:hover { background: #2a2d2e !important; }
        .sn-list-item.active { background: #37373d !important; color: #fff !important; border-left: 3px solid #007acc !important; font-weight: bold !important; }
        #sn-main { flex: 1 !important; display: flex !important; flex-direction: column !important; min-width: 0 !important; }
        #sn-editor-toolbar {
            display: flex !important; justify-content: flex-end !important; gap: 10px !important;
            background: #1e1e1e !important; padding: 8px 15px !important; border-bottom: 1px solid #333 !important;
        }
        #sn-editor-toolbar button {
            background: #333 !important; color: #fff !important; border: 1px solid #555 !important; padding: 6px 12px !important;
            border-radius: 4px !important; cursor: pointer !important; font-size: 13px !important; transition: all 0.2s !important;
            display: flex !important; align-items: center !important; gap: 5px !important;
        }
        #sn-editor-toolbar button:hover { background: #444 !important; border-color: #777 !important; }
        #sn-copy-btn { font-weight: bold !important; color: #4CAF50 !important; }
        #sn-editor {
            flex: 1 !important; background: #1e1e1e !important; color: #d4d4d4 !important; border: none !important; padding: 20px !important;
            font-size: 18px !important; font-family: 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif !important; resize: none !important; outline: none !important; line-height: 1.6 !important;
        }
        #sn-preview {
            flex: 1 !important; background: #1e1e1e !important; color: #d4d4d4 !important; padding: 20px 30px !important;
            font-size: 16px !important; line-height: 1.6 !important; overflow-y: auto !important; word-wrap: break-word !important;
        }
        #sn-preview h1, #sn-preview h2, #sn-preview h3 { color: #fff !important; font-weight: bold !important; }
        #sn-preview a { color: #3794ff !important; text-decoration: none !important; }
        #sn-statusbar {
            height: 36px !important; background: #007acc !important; color: white !important; display: flex !important; align-items: center !important;
            padding: 0 15px !important; font-size: 14px !important; justify-content: space-between !important; flex-shrink: 0 !important;
        }
        #smart-notepad-container ::-webkit-scrollbar { width: 8px !important; height: 8px !important; }
        #smart-notepad-container ::-webkit-scrollbar-track { background: #1e1e1e !important; }
        #smart-notepad-container ::-webkit-scrollbar-thumb { background: #424242 !important; border-radius: 4px !important; }
        #smart-notepad-container ::-webkit-scrollbar-thumb:hover { background: #4f4f4f !important; }
    `);

    // --- [4] DOM 요소 참조 ---
    const editor = document.getElementById('sn-editor');
    const previewArea = document.getElementById('sn-preview');
    const listContainer = document.getElementById('sn-list');
    const statsBar = document.getElementById('sn-stats');
    const selectionBadge = document.getElementById('sn-selection-badge');
    const resizer = document.getElementById('sn-resizer');

    const viewToggleBtn = document.getElementById('sn-view-toggle-btn');
    const copyBtn = document.getElementById('sn-copy-btn');
    const positionBtn = document.getElementById('sn-position-btn');

    // --- [5] 핵심 기능 구현 (좌우 이동 및 초기 셋업) ---
    function applyPositionStyles() {
        document.body.style.setProperty('transition', 'margin-right 0.3s ease, margin-left 0.3s ease, width 0.3s ease', 'important');
        container.style.setProperty('width', `${currentWidth}vw`, 'important');

        if (isLeftPosition) {
            container.style.setProperty('left', isOpen ? '0' : '-100%', 'important');
            container.style.setProperty('right', 'auto', 'important');
            resizer.style.setProperty('order', '3', 'important');

            if (isOpen) {
                document.body.style.setProperty('margin-left', `${currentWidth}vw`, 'important');
                document.body.style.setProperty('margin-right', '0', 'important');
                document.body.style.setProperty('width', `calc(100% - ${currentWidth}vw)`, 'important');
            } else {
                document.body.style.setProperty('margin-left', '0', 'important');
                document.body.style.setProperty('width', '100%', 'important');
            }
            toggleBtn.style.setProperty('left', '20px', 'important');
            toggleBtn.style.setProperty('right', 'auto', 'important');
        } else {
            container.style.setProperty('right', isOpen ? '0' : '-100%', 'important');
            container.style.setProperty('left', 'auto', 'important');
            resizer.style.setProperty('order', '-1', 'important');

            if (isOpen) {
                document.body.style.setProperty('margin-right', `${currentWidth}vw`, 'important');
                document.body.style.setProperty('margin-left', '0', 'important');
                document.body.style.setProperty('width', `calc(100% - ${currentWidth}vw)`, 'important');
            } else {
                document.body.style.setProperty('margin-right', '0', 'important');
                document.body.style.setProperty('width', '100%', 'important');
            }
            toggleBtn.style.setProperty('right', '20px', 'important');
            toggleBtn.style.setProperty('left', 'auto', 'important');
        }
    }

    applyPositionStyles();

    positionBtn.addEventListener('click', () => {
        isLeftPosition = !isLeftPosition;
        GM_setValue('smart_position_left', isLeftPosition);
        applyPositionStyles();
    });

    function toggleNotepad() {
        isOpen = !isOpen;
        applyPositionStyles();

        if (isOpen) {
            toggleBtn.style.setProperty('display', 'none', 'important');
            renderList();
            loadActiveNote();
        } else {
            toggleBtn.style.setProperty('display', 'flex', 'important');
        }
    }

    // --- 리사이징 로직 ---
    let isResizing = false;
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        resizer.classList.add('resizing');
        document.body.style.setProperty('user-select', 'none', 'important');
    });

    window.addEventListener('mousemove', (e) => {
        if (!isResizing) return;

        let newWidthPx = isLeftPosition ? e.clientX : (window.innerWidth - e.clientX);
        let newWidthVw = (newWidthPx / window.innerWidth) * 100;

        if (newWidthVw > 15 && newWidthVw < 80) {
            currentWidth = newWidthVw;
            GM_setValue('smart_width', currentWidth);

            container.style.setProperty('width', `${newWidthVw}vw`, 'important');

            if (isLeftPosition) {
                document.body.style.setProperty('margin-left', `${newWidthVw}vw`, 'important');
            } else {
                document.body.style.setProperty('margin-right', `${newWidthVw}vw`, 'important');
            }
            document.body.style.setProperty('width', `calc(100% - ${newWidthVw}vw)`, 'important');
        }
    });

    // 🌟 [버그 수정] 창 밖에서 마우스를 뗄 경우를 대비해 조금 더 견고하게 수정
    const stopResizing = () => {
        if (isResizing) {
            isResizing = false;
            resizer.classList.remove('resizing');
            document.body.style.removeProperty('user-select');
        }
    };
    window.addEventListener('mouseup', stopResizing);
    window.addEventListener('mouseleave', stopResizing);

    // --- [6] 데이터 저장 및 부가 기능 ---
    function saveData() {
        GM_setValue('smart_notes', notes);
        GM_setValue('smart_active_id', activeId);
    }

    function renderList() {
        listContainer.innerHTML = '';
        notes.forEach(note => {
            const div = document.createElement('div');
            div.className = `sn-list-item ${note.id === activeId ? 'active' : ''}`;

            const textSpan = document.createElement('span');
            textSpan.className = 'sn-list-text';
            let preview = note.text.replace(/[\r\n]+/g, ' ').trim();
            textSpan.innerText = preview.length > 0 ? preview.substring(0, 10) + (preview.length > 10 ? '...' : '') : '(빈 메모)';

            const delBtn = document.createElement('button');
            delBtn.className = 'sn-delete-btn';
            delBtn.innerText = 'X';
            delBtn.title = '메모 삭제';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                if (confirm('이 메모를 삭제하시겠습니까?')) deleteNote(note.id);
            };

            div.appendChild(textSpan);
            div.appendChild(delBtn);

            div.onclick = () => {
                activeId = note.id;
                saveData();
                renderList();
                loadActiveNote();
            };
            listContainer.appendChild(div);
        });
    }

    function deleteNote(id) {
        notes = notes.filter(n => n.id !== id);
        if (notes.length === 0) {
            const newNote = { id: Date.now(), text: '' };
            notes.push(newNote);
            activeId = newNote.id;
        } else if (activeId === id) {
            activeId = notes[0].id;
        }
        saveData();
        renderList();
        loadActiveNote();
    }

    function loadActiveNote() {
        const note = notes.find(n => n.id === activeId);
        if (note) {
            editor.value = note.text;
            updateStats();
            if (isPreviewMode) previewArea.innerHTML = marked.parse(editor.value, { breaks: true });
        }
    }

    function addNote() {
        const newNote = { id: Date.now(), text: '' };
        notes.unshift(newNote);
        activeId = newNote.id;
        if(isPreviewMode) toggleViewMode();
        saveData();
        renderList();
        loadActiveNote();
        editor.focus();
    }

    function updateStats() {
        let text = editor.value;
        let start = editor.selectionStart;
        let end = editor.selectionEnd;

        if (!isPreviewMode && start !== end) {
            text = text.substring(start, end);
            selectionBadge.style.setProperty('display', 'inline', 'important');
        } else {
            selectionBadge.style.setProperty('display', 'none', 'important');
        }

        statsBar.innerText = `글자수: ${text.length} | 토큰(추정): ${Math.ceil(text.length * 0.7)}`;
    }

    function toggleViewMode() {
        isPreviewMode = !isPreviewMode;
        if (isPreviewMode) {
            editor.style.setProperty('display', 'none', 'important');
            previewArea.style.setProperty('display', 'block', 'important');
            viewToggleBtn.innerText = '✏️ 편집하기';
            previewArea.innerHTML = marked.parse(editor.value, { breaks: true });
        } else {
            previewArea.style.setProperty('display', 'none', 'important');
            editor.style.setProperty('display', 'block', 'important');
            viewToggleBtn.innerText = '👀 미리보기';
            editor.focus();
        }
        updateStats();
    }

    function copyOriginalText() {
        GM_setClipboard(editor.value, 'text');
        const originalText = copyBtn.innerText;
        copyBtn.innerHTML = '✅ <b>복사 완료!</b>';
        copyBtn.style.setProperty('color', '#fff', 'important');
        copyBtn.style.setProperty('background', '#4CAF50', 'important');

        setTimeout(() => {
            copyBtn.innerText = originalText;
            copyBtn.style.removeProperty('color');
            copyBtn.style.removeProperty('background');
        }, 1500);
    }

    editor.addEventListener('input', () => {
        const note = notes.find(n => n.id === activeId);
        if (note) {
            note.text = editor.value;
            saveData();
            const activeItemText = document.querySelector('.sn-list-item.active .sn-list-text');
            if (activeItemText) {
                let preview = note.text.replace(/[\r\n]+/g, ' ').trim();
                activeItemText.innerText = preview.length > 0 ? preview.substring(0, 10) + (preview.length > 10 ? '...' : '') : '(빈 메모)';
            }
        }
        updateStats();
    });

    editor.addEventListener('mouseup', updateStats);
    editor.addEventListener('keyup', updateStats);

    viewToggleBtn.addEventListener('click', toggleViewMode);
    copyBtn.addEventListener('click', copyOriginalText);
    document.getElementById('sn-add-btn').addEventListener('click', addNote);
    document.getElementById('sn-close-btn').addEventListener('click', toggleNotepad);
    toggleBtn.addEventListener('click', toggleNotepad);

})();
