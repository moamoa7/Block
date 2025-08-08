// ==UserScript==
// @name            VideoSpeed_Control
// @namespace       https.com/
// @version         1.0.0
// @description     🎞️ 비디오 속도 조절 UI (슬라이더, 드래그 제스처)
// @match           *://*/*
// @grant           none
// @run-at          document-start
// ==/UserScript==

(function () {
    'use strict';

    // 스크립트 초기화 방지
    if (window.hasOwnProperty('__VideoSpeed_Control_Initialized') && window.__VideoSpeed_Control_Initialized) {
        return;
    }
    Object.defineProperty(window, '__VideoSpeed_Control_Initialized', { value: true, writable: false, configurable: true });

    // 전역 설정
    const DRAG_CONFIG = {
        PIXELS_PER_SECOND: 2
    };

    // 전역 상태
    const VIDEO_STATE = new WeakMap();
    let videoUIReady = false;

    // --- 유틸리티 함수 ---
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    // --- 비디오 탐색 모듈 ---
    const videoFinder = {
        findInDoc: (doc) => {
            const videos = [];
            if (!doc || !doc.body) return videos;
            doc.querySelectorAll('video').forEach(v => videos.push(v));
            return videos;
        },
        findAll: () => {
            let videos = videoFinder.findInDoc(document);
            document.querySelectorAll('iframe').forEach(iframe => {
                try {
                    const iframeDocument = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDocument) videos.push(...videoFinder.findInDoc(iframeDocument));
                } catch (e) {}
            });
            return videos;
        }
    };

    // --- 비디오 UI 모듈 (슬라이더) ---
    const speedSlider = (() => {
        let speedSliderContainer;
        let playbackUpdateTimer;
        let isMinimized = JSON.parse(localStorage.getItem('speedSliderMinimized') || 'true');
        let isInitialized = false;

        const createSliderElements = () => {
            if (document.getElementById('vm-speed-slider-style')) return;
            const style = document.createElement('style');
            style.id = 'vm-speed-slider-style';
            style.textContent = `
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: rgba(0, 0, 0, 0.0); padding: 10px 8px; border-radius: 8px; z-index: 2147483647 !important; display: none; flex-direction: column; align-items: center; width: 50px; height: auto; font-family: sans-serif; pointer-events: auto; opacity: 0.3; transition: all 0.3s ease; user-select: none; box-shadow: 0 0 8px rgba(0,0,0,0.0); will-change: transform, opacity, width; }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-reset-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 14px; padding: 4px 6px; cursor: pointer; margin-bottom: 8px; width: 40px; height: 30px; font-weight: bold; }
                #vm-speed-reset-btn:hover { background: #666; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 30px; height: 150px; margin: 0 0 10px 0; cursor: pointer; background: #555; border-radius: 5px; }
                #vm-speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: #f44336; border-radius: 50%; cursor: pointer; border: 1px solid #ddd; }
                #vm-speed-value { color: red; font-size: 18px; font-weight: bold; text-shadow: 1px 1px 2px rgba(0,0,0,0.7); }
                #vm-toggle-btn { background: #444; border: none; border-radius: 4px; color: white; font-size: 12px; padding: 4px 6px; cursor: pointer; font-weight: bold; width: 40px; height: 30px; margin-top: 8px; transition: transform 0.2s ease-in-out; }
            `;
            (document.head || document.body).appendChild(style);
        };

        const updateSpeed = (speed) => {
            const validSpeed = parseFloat(speed);
            if (isNaN(validSpeed)) return;
            const videos = videoFinder.findAll();
            videos.forEach(video => { video.playbackRate = validSpeed; });
        };

        const onSliderChange = (val) => {
            const speed = parseFloat(val);
            if (isNaN(speed)) return;
            const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
            if (valueDisplay) valueDisplay.textContent = `x${speed.toFixed(1)}`;
            if (playbackUpdateTimer) clearTimeout(playbackUpdateTimer);
            playbackUpdateTimer = setTimeout(() => updateSpeed(speed), 100);
        };

        const toggleMinimize = () => {
            const container = speedSliderContainer;
            if (!container) return;
            const slider = container.querySelector('#vm-speed-slider');
            const valueDisplay = container.querySelector('#vm-speed-value');
            const resetBtn = container.querySelector('#vm-speed-reset-btn');
            const toggleBtn = container.querySelector('#vm-toggle-btn');
            isMinimized = !isMinimized;
            localStorage.setItem('speedSliderMinimized', isMinimized);
            if (isMinimized) {
                container.style.width = '30px';
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
                if (toggleBtn) toggleBtn.textContent = '▼';
                dragBar.hide();
            } else {
                container.style.width = '50px';
                if (slider) slider.style.display = 'block';
                if (valueDisplay) valueDisplay.style.display = 'block';
                if (resetBtn) resetBtn.style.display = 'block';
                if (toggleBtn) toggleBtn.textContent = '▲';
                speedSlider.updatePositionAndSize();
                const isVideoPlaying = videoFinder.findAll().some(v => !v.paused);
                if (isVideoPlaying) dragBar.show();
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            createSliderElements();
            if (!document.body) return;
            speedSliderContainer = document.getElementById('vm-speed-slider-container');
            if (!speedSliderContainer) {
                speedSliderContainer = document.createElement('div');
                speedSliderContainer.id = 'vm-speed-slider-container';
                const slider = document.createElement('input');
                slider.type = 'range'; slider.min = '0.2'; slider.max = '4.0';
                slider.step = '0.2'; slider.value = '1.0'; slider.id = 'vm-speed-slider';
                slider.addEventListener('input', e => onSliderChange(e.target.value), true);
                slider.addEventListener('change', e => updateSpeed(parseFloat(e.target.value)), true);
                const resetBtn = document.createElement('button');
                resetBtn.id = 'vm-speed-reset-btn'; resetBtn.textContent = '1x';
                resetBtn.addEventListener('click', e => { slider.value = '1.0'; onSliderChange('1.0'); });
                const valueDisplay = document.createElement('div');
                valueDisplay.id = 'vm-speed-value'; valueDisplay.textContent = 'x1.0';
                const toggleBtn = document.createElement('button');
                toggleBtn.id = 'vm-toggle-btn'; toggleBtn.textContent = isMinimized ? '▼' : '▲';
                toggleBtn.addEventListener('click', toggleMinimize);
                speedSliderContainer.append(resetBtn, slider, valueDisplay, toggleBtn);
                document.body.appendChild(speedSliderContainer);
            }
            if (isMinimized) {
                speedSliderContainer.style.width = '30px';
                const slider = speedSliderContainer.querySelector('#vm-speed-slider');
                const valueDisplay = speedSliderContainer.querySelector('#vm-speed-value');
                const resetBtn = speedSliderContainer.querySelector('#vm-speed-reset-btn');
                if (slider) slider.style.display = 'none';
                if (valueDisplay) valueDisplay.style.display = 'none';
                if (resetBtn) resetBtn.style.display = 'none';
            }
        };

        const show = () => {
            if (!speedSliderContainer) init();
            if (!speedSliderContainer) return;
            document.body.appendChild(speedSliderContainer);
            speedSliderContainer.style.display = 'flex';
            updatePositionAndSize();
            const slider = speedSliderContainer.querySelector('#vm-speed-slider');
            if (slider) updateSpeed(slider.value);
        };
        const hide = () => {
            if (speedSliderContainer) speedSliderContainer.style.display = 'none';
        };

        const updatePositionAndSize = () => {
            const sliderContainer = speedSliderContainer;
            if (!sliderContainer) return;
            const videos = videoFinder.findAll();
            const video = videos.find(v => v.clientWidth > 0 && v.clientHeight > 0);
            const slider = sliderContainer.querySelector('#vm-speed-slider');
            const newHeight = video ? Math.max(100, video.getBoundingClientRect().height * 0.3) : 100;
            if (slider) slider.style.height = `${newHeight}px`;
            const targetParent = document.fullscreenElement || document.body;
            if (sliderContainer.parentNode !== targetParent) {
                targetParent.appendChild(sliderContainer);
            }
        };

        return { init, show, hide, updatePositionAndSize, isMinimized: () => isMinimized };
    })();

    // --- 비디오 UI 모듈 (드래그 바) ---
    const dragBar = (() => {
        let dragBarTimeDisplay;
        const dragState = {
            isDragging: false, isHorizontalDrag: false,
            startX: 0, startY: 0, lastUpdateX: 0,
            currentDragDistanceX: 0, totalTimeChange: 0,
            recoveryTimer: null, throttleTimer: null, lastDragTimestamp: 0
        };
        let isInitialized = false;

        const formatTime = (seconds) => {
            const absSeconds = Math.abs(seconds);
            const sign = seconds < 0 ? '-' : '+';
            const minutes = Math.floor(absSeconds / 60);
            const remainingSeconds = Math.floor(absSeconds % 60);
            const paddedMinutes = String(minutes).padStart(2, '0');
            const paddedSeconds = String(remainingSeconds).padStart(2, '0');
            return `${sign}${paddedMinutes}분${paddedSeconds}초`;
        };

        const updateTimeDisplay = (totalTimeChange) => {
            if (!dragBarTimeDisplay) return;
            if (totalTimeChange !== 0) {
                dragBarTimeDisplay.textContent = formatTime(totalTimeChange);
                dragBarTimeDisplay.style.display = 'block';
                dragBarTimeDisplay.style.opacity = '1';
            } else {
                dragBarTimeDisplay.style.opacity = '0';
                if (dragBarTimeDisplay.timer) clearTimeout(dragBarTimeDisplay.timer);
                dragBarTimeDisplay.timer = setTimeout(() => {
                    if (dragBarTimeDisplay.style.opacity === '0') {
                        dragBarTimeDisplay.style.display = 'none';
                    }
                    dragBarTimeDisplay.timer = null;
                }, 300);
            }
        };

        const applyTimeChange = () => {
            const videos = videoFinder.findAll();
            const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
            const timeToApply = Math.round(dragState.totalTimeChange / pixelsPerSecond);
            if (timeToApply !== 0) {
                videos.forEach(video => {
                    if (video && video.duration && isFinite(video.duration)) {
                        const newTime = Math.min(video.duration, Math.max(0, video.currentTime + timeToApply));
                        video.currentTime = newTime;
                    }
                });
            }
        };

        const cancelDrag = () => {
            if (!dragState.isDragging) return;
            try {
                if (dragState.recoveryTimer) {
                    clearTimeout(dragState.recoveryTimer);
                    dragState.recoveryTimer = null;
                }
                updateTimeDisplay(0);
                dragState.isDragging = false;
                dragState.currentDragDistanceX = 0;
                dragState.totalTimeChange = 0;
                dragState.isHorizontalDrag = false;
                if(document.body) document.body.style.userSelect = '';
                if(document.body) document.body.style.touchAction = '';
                document.removeEventListener('mousemove', handleMove, true);
                document.removeEventListener('mouseup', handleEnd, true);
                document.removeEventListener('touchmove', handleMove, true);
                document.removeEventListener('touchend', handleEnd, true);
            } catch(e) { }
        };

        const getPosition = (e) => e.touches && e.touches.length > 0 ? e.touches[0] : e;
        const handleStart = (e) => {
            if (speedSlider.isMinimized() || dragState.isDragging || e.button === 2) return;
            if (e.target && e.target.closest('#vm-speed-slider-container, #vm-time-display')) return;
            const videos = videoFinder.findAll();
            if (videos.length === 0) return;
            e.stopPropagation();
            dragState.isDragging = true;
            const pos = getPosition(e);
            dragState.startX = pos.clientX;
            dragState.startY = pos.clientY;
            dragState.lastUpdateX = pos.clientX;
            dragState.currentDragDistanceX = 0;
            dragState.totalTimeChange = 0;
            dragState.lastMoveTime = Date.now();
            updateTimeDisplay(dragState.totalTimeChange);
            if (dragState.recoveryTimer) clearTimeout(dragState.recoveryTimer);
            dragState.recoveryTimer = setTimeout(cancelDrag, 5000);
            document.addEventListener('mousemove', handleMove, { passive: false, capture: true });
            document.addEventListener('mouseup', handleEnd, { passive: false, capture: true });
            document.addEventListener('touchmove', handleMove, { passive: false, capture: true });
            document.addEventListener('touchend', handleEnd, { passive: false, capture: true });
        };

        const handleMove = (e) => {
            if (!dragState.isDragging) return;
            try {
                if ((e.touches && e.touches.length > 1) || (e.pointerType === 'touch' && e.pointerId > 1)) return cancelDrag();
                const videos = videoFinder.findAll();
                if (videos.length === 0) return cancelDrag();
                const pos = getPosition(e);
                const currentX = pos.clientX;
                const dx = Math.abs(currentX - dragState.startX);
                if (!dragState.isHorizontalDrag) {
                    const dy = Math.abs(pos.clientY - dragState.startY);
                    if (dx > 10 && dy < dx * 1.5) {
                        dragState.isHorizontalDrag = true;
                        e.preventDefault(); e.stopImmediatePropagation();
                        if(document.body) document.body.style.userSelect = 'none';
                        if(document.body) document.body.style.touchAction = 'none';
                    } else if (dy > 10) {
                        return cancelDrag();
                    }
                }
                if (dragState.isHorizontalDrag) {
                    e.preventDefault(); e.stopImmediatePropagation();
                    const deltaX = currentX - dragState.lastUpdateX;
                    dragState.currentDragDistanceX += deltaX;
                    const pixelsPerSecond = DRAG_CONFIG?.PIXELS_PER_SECOND || 2;
                    dragState.totalTimeChange = Math.round(dragState.currentDragDistanceX / pixelsPerSecond);
                    updateTimeDisplay(dragState.totalTimeChange);
                    dragState.lastUpdateX = currentX;
                }
            } catch(e) {
                 cancelDrag();
            }
        };

        const handleEnd = () => {
            if (!dragState.isDragging) return;
            try {
                applyTimeChange();
                cancelDrag();
            } catch(e) {
                 cancelDrag();
            }
        };

        const init = () => {
            if (isInitialized) return;
            isInitialized = true;
            if (!document.body) return;
            dragBarTimeDisplay = document.getElementById('vm-time-display');
            if (!dragBarTimeDisplay) {
                dragBarTimeDisplay = document.createElement('div');
                dragBarTimeDisplay.id = 'vm-time-display';
                Object.assign(dragBarTimeDisplay.style, {
                    position: 'fixed', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)', background: 'rgba(0, 0, 0, 0.7)',
                    color: 'white', padding: '10px 20px', borderRadius: '5px',
                    fontSize: '1.5rem', zIndex: '2147483647',
                    display: 'none', pointerEvents: 'none', transition: 'opacity 0.3s ease-out',
                    opacity: '1', textAlign: 'center', whiteSpace: 'nowrap'
                });
                document.body.appendChild(dragBarTimeDisplay);
            }
            document.addEventListener('mousedown', handleStart, { passive: false, capture: true });
            document.addEventListener('touchstart', handleStart, { passive: false, capture: true });
            document.addEventListener('mouseout', (e) => { if (e.relatedTarget === null) handleEnd(); }, true);
            document.addEventListener('touchcancel', handleEnd, { passive: false, capture: true });
        };

        const show = () => {
            if (!dragBarTimeDisplay) init();
            if (!dragBarTimeDisplay) return;
            const targetParent = document.fullscreenElement || document.body;
            if (targetParent && dragBarTimeDisplay.parentNode !== targetParent) {
                targetParent.appendChild(dragBarTimeDisplay);
            }
            dragBarTimeDisplay.style.display = 'block';
        };

        const hide = () => {
            if (dragBarTimeDisplay) dragBarTimeDisplay.style.display = 'none';
            if (dragState.isDragging) cancelDrag();
        };
        return { init, show, hide };
    })();

    // --- 비디오 UI 감시자 ---
    const videoUIWatcher = (() => {
        let isUIActive = false;
        const checkVideos = () => {
            const videos = videoFinder.findAll();
            const isAnyVideoAvailable = videos.some(v => v.readyState >= 1 || (v.clientWidth > 0 && v.clientHeight > 0));
            if (isAnyVideoAvailable) {
                if (!isUIActive) {
                    speedSlider.show();
                    if (!speedSlider.isMinimized()) dragBar.show();
                    isUIActive = true;
                }
            } else {
                if (isUIActive) {
                    speedSlider.hide();
                    dragBar.hide();
                    isUIActive = false;
                }
            }
        };

        const init = () => {
            setInterval(throttle(checkVideos, 1000), 1500);
            document.addEventListener('fullscreenchange', () => {
                speedSlider.updatePositionAndSize();
                if (!speedSlider.isMinimized()) dragBar.show();
                else dragBar.hide();
            });
        };
        return { init };
    })();

    // --- 통신 모듈 (다른 스크립트와 상호작용) ---
    const communicator = (() => {
        const handleMessage = (event) => {
            // 메시지 출처 확인
            if (event.source !== window || !event.data || event.data.source !== 'VideoURL_Logger') {
                return;
            }

            const { type, payload } = event.data;

            if (type === 'VIDEO_URL_DETECTED' && payload.url) {
                // 비디오 URL이 감지되면 UI 활성화 로직을 실행
                const video = document.querySelector(`video[src="${payload.url}"]`);
                if (video) {
                     videoUIWatcher.init();
                }
            }
        };

        const init = () => {
            window.addEventListener('message', handleMessage, false);
        };
        return { init };
    })();

    // --- 초기 진입점 ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            speedSlider.init();
            dragBar.init();
            videoUIWatcher.init();
        });
    } else {
        speedSlider.init();
        dragBar.init();
        videoUIWatcher.init();
    }
})();
