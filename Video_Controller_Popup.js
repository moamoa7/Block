// ==UserScript==
// @name Video Controller Popup (V4.11.15: 자동재생 개선, 모바일 전체화면 클릭／위치 픽스, IntersectionObserver 최적화, 상태관리, UI방지, 위치／크기 리팩토링, 모바일 터치 개선, RangeError 픽스 V3, 버튼 작동 개선)
// @namespace Violentmonkey Scripts
// @version 4.11.15_AutoplayAttemptImprovement_MobileFullScreenClickFix_Debounce_FS_Pos_Restore_RAF_IO_Opt_StateManagement_UIPrevention_LayoutRefactor_MobileTouchFix_RangeErrorFixV3_ButtonFix
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Uses IntersectionObserver for efficient video visibility detection. Restores popup position after fullscreen exit. Enhanced state management and UI prevention in fullscreen. Refactored popup layout and improved mobile touch handling. Fixes "Maximum call stack size exceeded" error in volume control and improves button responsiveness.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    // 모든 전역 상태를 'state' 객체 안에 모아서 관리
    const state = {
        currentVideo: null,
        isPopupVisible: false,
        isManuallyMuted: false, // 사용자가 수동으로 음소거/음소거 해제했는지 여부
        isManuallyPaused: false, // 사용자가 수동으로 일시정지/재생했는지 여부
        isPopupDragging: false,
        popupDragOffsetX: 0,
        popupDragOffsetY: 0,
        desiredPlaybackRate: 1.0,
        desiredVolume: 1.0,
        lastPlayState: null, // 'playing', 'paused', null (초기 상태)
        isInitialized: false // 초기화 상태
    };

    let videos = []; // 이 변수는 상태 객체에 포함시키기에는 역할이 조금 다르므로 유지
    let popupElement = null; // DOM 요소는 상태 객체에 포함시키지 않는 것이 일반적
    let rafId = null;
    let videoObserver = null; // IntersectionObserver 인스턴스
    let observedVideosData = new Map(); // 각 비디오의 교차 비율, ID 등을 저장

    const videoRateHandlers = new WeakMap();
    const originalPlayMethods = new WeakMap();

    // Configuration
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300;

    // MutationObserver 인스턴스를 저장하여 나중에 disconnect 할 수 있도록 전역 변수 추가
    let domMutationObserverInstance = null;
    let spaDetectionObserverInstance = null;

    // 터치/클릭 중복 방지용 변수 추가 (이들은 상태 객체에 포함하기에 너무 휘발적이거나 단순 플래그임)
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    const TOUCH_MOVE_THRESHOLD = 10; // 픽셀 단위

    // 팝업 이전 위치 저장 (전역 상태에 가깝지만 DOM 조작과 밀접하여 분리)
    let popupPrevPosition = null;

    // --- State Setter Functions ---
    // 상태 변경은 이 함수들을 통해서만 이루어지도록 하여 일관성을 유지
    function setCurrentVideo(video) {
        if (state.currentVideo && state.currentVideo !== video) {
            // 기존 비디오의 play 메서드를 원본으로 되돌림 (선택 해제 시)
            if (originalPlayMethods.has(state.currentVideo)) {
                state.currentVideo.play = originalPlayMethods.get(state.currentVideo);
                originalPlayMethods.delete(state.currentVideo);
            }
        }
        state.currentVideo = video;
        // 새 비디오가 선택되면 관련 상태 초기화
        state.isManuallyPaused = false;
        state.desiredPlaybackRate = video ? video.playbackRate : 1.0;
        state.desiredVolume = video ? video.volume : 1.0;
        state.isManuallyMuted = video ? video.muted : false; // 비디오의 실제 뮤트 상태로 초기화
        state.lastPlayState = null;
    }

    function setIsPopupVisible(visible) {
        state.isPopupVisible = visible;
        setPopupVisibility(visible); // 실제 팝업 DOM 가시성 제어 함수 호출
    }

    function setIsManuallyMuted(muted) {
        state.isManuallyMuted = muted;
        if (state.currentVideo) {
            if (muted) {
                // 수동 음소거 시에는 볼륨을 0으로 설정
                setDesiredVolume(0); // 이 함수가 비디오 볼륨도 업데이트
            } else {
                // 수동 음소거 해제 시에는 볼륨을 1.0으로 설정
                setDesiredVolume(1.0); // 이 함수가 비디오 볼륨도 업데이트
            }
        }
        updateMuteSpeakButtons(); // UI 업데이트
    }

    function setIsManuallyPaused(paused) {
        state.isManuallyPaused = paused;
        if (state.currentVideo) {
            if (paused) {
                state.currentVideo.pause();
                setLastPlayState('paused');
            } else {
                state.currentVideo.play().catch(e => {
                     console.warn("[VCP] Play failed when unpausing:", e.name, e.message);
                });
                setLastPlayState('playing');
            }
        }
        updatePlayPauseButton(); // UI 업데이트
    }

    function setIsPopupDragging(dragging) {
        state.isPopupDragging = dragging;
    }

    function setPopupDragOffset(offsetX, offsetY) {
        state.popupDragOffsetX = offsetX;
        state.popupDragOffsetY = offsetY;
    }

    function setDesiredPlaybackRate(rate) {
        state.desiredPlaybackRate = rate; // 상태 업데이트
        if (state.currentVideo && state.currentVideo.playbackRate !== rate) {
            state.currentVideo.playbackRate = rate; // 비디오의 실제 배속 설정
        }
        updatePopupSliders(); // UI 업데이트는 여기서 직접 호출
    }

    function setDesiredVolume(volume) {
        state.desiredVolume = volume; // 상태 업데이트
        if (state.currentVideo) {
            // 직접 비디오 볼륨 설정
            state.currentVideo.volume = Math.max(0, Math.min(1.0, state.desiredVolume));
            // 음소거 상태는 수동 음소거 상태 또는 desiredVolume이 0일 때 적용
            state.currentVideo.muted = state.isManuallyMuted || (state.desiredVolume === 0);
        }
        // updateMuteSpeakButtons(); // 이 함수는 setIsManuallyMuted에서 이미 호출됩니다.
    }

    function setLastPlayState(playState) {
        state.lastPlayState = playState;
    }

    function setIsInitialized(initialized) {
        state.isInitialized = initialized;
    }

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        return Array.from(root.querySelectorAll('video, audio'));
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
            return isVisible && isReasonableSize && hasMedia && isWithinViewport;
        });
        videos = playableVideos; // 전역 'videos' 배열 업데이트
        return playableVideos;
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (state.currentVideo) { state.currentVideo.pause(); setCurrentVideo(null); setIsPopupVisible(false); }
            return;
        }

        // 새롭게 선택된 비디오가 아니면 기존 비디오 플레이어 초기화
        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
                if (originalPlayMethods.has(video) && video !== state.currentVideo) {
                    video.play = originalPlayMethods.get(video);
                    originalPlayMethods.delete(video);
                }
                if (!video.paused) {
                    video.pause();
                }
                video.muted = true;
                video.volume = 0;
                video.currentTime = 0;
            } else {
                if (state.currentVideo !== videoToControl) { // 현재 비디오가 아니었다면 자동 재생 시도
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;

                    // 새로운 비디오가 선택되면 수동 음소거/볼륨 상태를 기본으로 초기화
                    // setIsManuallyMuted(false)를 호출하면 내부적으로 setDesiredVolume(1.0)도 호출
                    setIsManuallyMuted(false); // 수동 음소거 해제 -> 볼륨 1.0으로 설정

                    videoToControl.play().catch(e => {
                        console.warn("[VCP] Autoplay with sound failed:", e.name, e.message, "Attempting muted autoplay.");
                        setIsManuallyMuted(true); // 음소거 자동 재생 시도 (이 함수가 setDesiredVolume을 통해 볼륨도 0으로 설정)
                        videoToControl.play().catch(mutedError => {
                            console.error("[VCP] Muted autoplay also failed:", mutedError.name, mutedError.message);
                        });
                    });
                }
            }
        });

        if (state.currentVideo !== videoToControl) {
            setCurrentVideo(videoToControl); // state.currentVideo 업데이트
        }

        // setDesiredPlaybackRate 함수가 비디오에 직접 적용하도록 변경되었으므로,
        // 여기서는 해당 함수를 호출하는 것만으로 충분합니다.
        setDesiredPlaybackRate(state.desiredPlaybackRate); // 현재 상태의 배속 적용

        updatePopupSliders();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
    }

    function fixPlaybackRate(video, rate) { // 'rate' here should be the 'desiredPlaybackRate'
        if (!video || typeof video.playbackRate === 'undefined') return;

        // 상태의 desiredPlaybackRate를 인자로 받은 rate로 업데이트.
        // setDesiredPlaybackRate 함수가 상태 업데이트와 비디오 적용을 담당하므로, 여기서는 직접 state를 업데이트합니다.
        if (state.desiredPlaybackRate !== rate) {
            state.desiredPlaybackRate = rate;
        }

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        // ratechange 이벤트 리스너: 비디오의 실제 재생 속도가 변경되면 state.desiredPlaybackRate도 업데이트
        const rateChangeHandler = () => {
            // 외부 요인에 의해 비디오의 실제 재생 속도가 변경되었고, 이것이 우리의 desiredRate와 다를 경우
            if (video.playbackRate !== state.desiredPlaybackRate) {
                state.desiredPlaybackRate = video.playbackRate; // 상태 업데이트
                updatePopupSliders(); // UI 업데이트
            }
        };

        // 비디오의 재생 속도가 현재 desiredRate와 다르면 설정
        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
        updatePopupSliders(); // UI 업데이트
    }

    // setNormalVolume 함수는 더 이상 필요 없으며 제거되었습니다.
    // 모든 볼륨 제어 로직은 setDesiredVolume에 통합됩니다.

    // --- Popup UI Functions ---
    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed;
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
            display: none; opacity: 0; transition: opacity 0.3s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: fit-content;
            min-width: 280px;
            overflow: hidden; text-align: center; pointer-events: auto;
            display: flex;
            flex-direction: column;
            align-items: stretch;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            font-weight: bold; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
        `;
        popupElement.appendChild(dragHandle);

        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section-speed';
        speedSection.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 10px;
            gap: 5px;
            border-bottom: 1px solid #444;
        `;

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00x';
        speedDisplay.style.cssText = 'color: #eee; font-size: 1.2em; font-weight: bold; width: 100%; text-align: center;';

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            width: 90%;
            height: 10px;
            -webkit-appearance: none;
            appearance: none;
            background: #555;
            outline: none;
            border-radius: 5px;
            cursor: pointer;
            margin: 0;
            padding: 0;
        `;

        speedSection.appendChild(speedDisplay);
        speedSection.appendChild(speedInput);
        popupElement.appendChild(speedSection);

        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 10px;
            padding: 10px;
            flex-grow: 1;
            align-content: stretch;
            justify-items: stretch;
            min-height: 90px;
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: normal;
            text-align: center; font-size: 14px;
            height: auto;
            min-height: 40px;
            width: 100%;
            min-width: 75px;
            display: flex;
            justify-content: center;
            align-items: center;
            box-sizing: border-box;
            line-height: 1.2;
        `;

        const playPauseBtn = document.createElement('button');
        playPauseBtn.setAttribute('data-action', 'play-pause');
        playPauseBtn.textContent = '재생/멈춤';
        playPauseBtn.style.cssText = buttonStyle;

        const speedResetBtn = document.createElement('button');
        speedResetBtn.setAttribute('data-action', 'reset-speed');
        speedResetBtn.textContent = '배속1x';
        speedResetBtn.style.cssText = buttonStyle;

        const muteBtn = document.createElement('button');
        muteBtn.setAttribute('data-action', 'mute');
        muteBtn.textContent = '무음';
        muteBtn.style.cssText = buttonStyle;

        const speakBtn = document.createElement('button');
        speakBtn.setAttribute('data-action', 'speak');
        speakBtn.textContent = '소리';
        speakBtn.style.cssText = buttonStyle;

        buttonSection.appendChild(playPauseBtn);
        buttonSection.appendChild(speedResetBtn);
        buttonSection.appendChild(muteBtn);
        buttonSection.appendChild(speakBtn);
        popupElement.appendChild(buttonSection);

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function updatePlayPauseButton() {
        const playPauseBtn = popupElement.querySelector('[data-action="play-pause"]');
        if (playPauseBtn && state.currentVideo) {
            playPauseBtn.textContent = state.currentVideo.paused ? '재생' : '멈춤';
        } else if (playPauseBtn) {
            playPauseBtn.textContent = '재생/멈춤';
        }
    }

    function updateMuteSpeakButtons() {
        const muteBtn = popupElement.querySelector('[data-action="mute"]');
        const speakBtn = popupElement.querySelector('[data-action="speak"]');
        if (muteBtn && speakBtn && state.currentVideo) {
            // 현재 비디오의 실제 muted 상태를 반영하여 버튼 색상 변경
            if (state.currentVideo.muted) {
                muteBtn.style.backgroundColor = '#555'; // 활성화 색상
                speakBtn.style.backgroundColor = '#333'; // 비활성화 색상
            } else {
                muteBtn.style.backgroundColor = '#333'; // 비활성화 색상
                speakBtn.style.backgroundColor = '#555'; // 활성화 색상
            }
        } else if (muteBtn && speakBtn) {
            // 비디오가 없을 때는 기본 색상
            muteBtn.style.backgroundColor = '#333';
            speakBtn.style.backgroundColor = '#333';
        }
    }

    function handleButtonClick(action) {
        if (!state.currentVideo) { return; }
        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                setIsManuallyPaused(!state.currentVideo.paused); // 현재 상태의 반대로 설정
                break;
            case 'reset-speed':
                setDesiredPlaybackRate(1.0); // 배속 1x로 설정
                break;
            case 'mute':
                setIsManuallyMuted(true); // 수동 음소거 상태로 설정 -> 이 함수가 setDesiredVolume(0) 호출
                break;
            case 'speak':
                setIsManuallyMuted(false); // 수동 음소거 해제 -> 이 함수가 setDesiredVolume(1.0) 호출
                break;
        }
    }

    function setupPopupEventListeners() {
        if (!popupElement) return;

        popupElement.addEventListener('click', (e) => {
            const action = e.target.getAttribute('data-action');
            if (action) handleButtonClick(action);
        });

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            setDesiredPlaybackRate(rate); // 상태 업데이트 및 비디오에 적용
            speedDisplay.textContent = rate.toFixed(2) + 'x';
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            // 터치 시작 시 드래그 여부 초기화
            touchMoved = false;

            if (e.target !== dragHandle) return;
            resetPopupHideTimer();
            setIsPopupDragging(true); // 상태 업데이트
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
            const rect = popupElement.getBoundingClientRect();
            setPopupDragOffset(clientX - rect.left, clientY - rect.top); // 상태 업데이트
            popupElement.style.position = 'fixed'; // 드래그 시 고정 위치 유지
            popupElement.style.transform = 'none';
            document.body.style.userSelect = 'none';
        };

        const stopDrag = () => {
            if (state.isPopupDragging) { // 상태 사용
                setIsPopupDragging(false); // 상태 업데이트
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                resetPopupHideTimer();
                updatePopupLayout(); // 드래그 종료 후 레이아웃 갱신
            }
        };

        const dragPopup = (e) => {
            if (!state.isPopupDragging) return; // 상태 사용
            // 터치 드래그 중임을 감지
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;

            // 터치 이동량으로 touchMoved 업데이트
            const deltaX = Math.abs(clientX - touchStartX);
            const deltaY = Math.abs(clientY - touchStartY);
            if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
                touchMoved = true;
            }

            popupElement.style.left = `${clientX - state.popupDragOffsetX}px`; // 상태 사용
            popupElement.style.top = `${clientY - state.popupDragOffsetY}px`; // 상태 사용
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag, { passive: false }); // 터치 드래그 방지를 위해 passive: false
        document.addEventListener('mousemove', dragPopup);
        document.addEventListener('touchmove', dragPopup, { passive: false }); // 터치 드래그 방지를 위해 passive: false
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) { // 실제 DOM 조작만 담당
        if (!popupElement) return;

        if (isVisible) {
            const styles = { display: 'flex', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
        }
    }

    function showPopup() {
        if (!popupElement) {
            createPopupElement(); // 팝업 엘리먼트가 없으면 생성
        }

        if (!state.currentVideo) { // 상태 사용
            setIsPopupVisible(false); // 상태 업데이트
            return;
        }

        setIsPopupVisible(true); // 상태 업데이트
        updatePopupLayout(); // 팝업 생성/표시 시 레이아웃 갱신
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
    }

    function hidePopup() { setIsPopupVisible(false); } // 상태 업데이트

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (!state.isPopupDragging && state.isPopupVisible) { // 상태 사용
            popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    // --- 팝업 위치/크기 계산 및 적용 리팩토링 시작 ---
    function isMobile() {
        return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    }

    function calculatePopupSize(mode) {
        // 기존 팝업의 최소 너비/높이 CSS를 고려하여 동적 크기 조절
        // 여기서는 예시 값으로 고정했지만, 실제 팝업 UI 내용에 따라 조절될 수 있도록 'fit-content' 유지
        // 혹은 특정 모드에서 고정 값을 강제할 수 있습니다.
        if (mode === 'fullscreen') {
            return { width: 280, height: 150 }; // 전체화면 모드에서 고정된 크기
        }
        return { width: 280, height: 150 }; // 일반 모드에서 고정된 크기 (fit-content를 사용하면 내부 콘텐츠에 따라 자동)
    }

    function calculatePopupPosition(mode) {
        const margin = 12; // 뷰포트 또는 전체화면 경계로부터의 여백
        const { width: popupWidth, height: popupHeight } = calculatePopupSize(mode);

        const currentVideoRect = state.currentVideo?.getBoundingClientRect();

        let targetRect; // 팝업을 위치시킬 기준 사각형 (비디오 또는 전체화면)
        if (mode === 'fullscreen') {
            const fsEl = document.fullscreenElement;
            targetRect = fsEl?.getBoundingClientRect() || { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
        } else {
            targetRect = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
        }

        let calculatedLeft, calculatedTop;

        // 비디오가 존재하고 화면에 보인다면 비디오 기준 중앙에 위치
        if (currentVideoRect && currentVideoRect.width > 0 && currentVideoRect.height > 0) {
            if (mode === 'fullscreen') {
                // 전체화면 모드에서는 전체화면 요소 기준 상대 위치로 계산
                calculatedLeft = currentVideoRect.left - targetRect.left + (currentVideoRect.width / 2) - (popupWidth / 2);
                calculatedTop = currentVideoRect.top - targetRect.top + (currentVideoRect.height / 2) - (popupHeight / 2);
            } else {
                // 일반 모드에서는 뷰포트 기준 절대 위치로 계산
                calculatedLeft = currentVideoRect.left + (currentVideoRect.width / 2) - (popupWidth / 2);
                calculatedTop = currentVideoRect.top + (currentVideoRect.height / 2) - (popupHeight / 2);
            }
        } else {
            // 비디오가 없거나 보이지 않으면 뷰포트 또는 전체화면 중앙에 위치
            calculatedLeft = (targetRect.width / 2) - (popupWidth / 2);
            calculatedTop = (targetRect.height / 2) - (popupHeight / 2);
        }

        // 팝업이 화면 밖으로 나가지 않도록 조정 (뷰포트 또는 전체화면 요소 경계 내로)
        calculatedLeft = Math.max(margin, Math.min(calculatedLeft, targetRect.width - popupWidth - margin));
        calculatedTop = Math.max(margin, Math.min(calculatedTop, targetRect.height - popupHeight - margin));

        return { left: calculatedLeft, top: calculatedTop };
    }


    function applyPopupStyle({ top, left, width, height, positionType = 'fixed', zIndex = '2147483647' }) {
        if (!popupElement) return;

        Object.assign(popupElement.style, {
            position: positionType,
            zIndex: zIndex,
            width: `${width}px`,
            height: `${height}px`,
            left: `${left}px`,
            top: `${top}px`,
            transform: 'none', // transform 속성은 드래그 시에만 조작되고, 레이아웃 계산 시 초기화
            boxSizing: 'border-box'
        });
    }

    function updatePopupLayout() {
        if (!popupElement || state.isPopupDragging) { // 드래그 중에는 레이아웃 자동 갱신 방지
            return;
        }

        const mode = document.fullscreenElement ? 'fullscreen' : 'normal';
        const size = calculatePopupSize(mode);
        const pos = calculatePopupPosition(mode);

        // 전체화면 진입 시 팝업을 전체화면 엘리먼트의 자식으로 이동
        if (mode === 'fullscreen' && document.fullscreenElement && popupElement.parentNode !== document.fullscreenElement) {
            // 팝업의 현재 뷰포트 기준 위치를 저장하여, 전체화면 종료 시 복원할 수 있도록 합니다.
            popupPrevPosition = {
                left: popupElement.style.left,
                top: popupElement.style.top,
            };
            document.fullscreenElement.appendChild(popupElement);
            applyPopupStyle({ ...pos, ...size, positionType: 'absolute' }); // 전체화면 내부이므로 position: absolute
        }
        // 전체화면 종료 시 팝업을 다시 body로 이동
        else if (mode === 'normal' && popupElement.parentNode !== document.body) {
            document.body.appendChild(popupElement);
            // 전체화면 종료 시 이전에 저장된 위치를 복원 시도
            if (popupPrevPosition) {
                applyPopupStyle({ ...pos, ...size, top: popupPrevPosition.top, left: popupPrevPosition.left, positionType: 'fixed' });
                popupPrevPosition = null; // 사용 후 초기화
            } else {
                applyPopupStyle({ ...pos, ...size, positionType: 'fixed' });
            }
        }
        else {
            // 그 외의 경우 (같은 모드 내에서 위치/크기 갱신)
            const positionType = mode === 'fullscreen' ? 'absolute' : 'fixed';
            applyPopupStyle({ ...pos, ...size, positionType: positionType });
        }

        const videoRect = state.currentVideo?.getBoundingClientRect();
        const isVideoVisible = videoRect && videoRect.width > 0 && videoRect.height > 0 &&
                               videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                               videoRect.left < window.innerWidth && videoRect.right > 0;
        if (state.currentVideo && !isVideoVisible) {
            setIsPopupVisible(false); // 비디오가 화면 밖으로 나가면 팝업 숨김
        }
    }
    // --- 팝업 위치/크기 계산 및 적용 리팩토링 끝 ---

    function updatePopupSliders() {
        if (!popupElement || !state.currentVideo) return; // 상태 사용

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        if (speedInput && speedDisplay) {
            const rate = state.currentVideo.playbackRate; // 비디오의 실제 재생 속도를 가져옴
            speedInput.value = rate.toFixed(1);
            speedDisplay.textContent = rate.toFixed(2) + 'x';
        }
    }

    // --- IntersectionObserver 관련 함수 ---
    function setupIntersectionObserver() {
        const observerOptions = {
            root: null, // 뷰포트 기준
            rootMargin: '0px',
            threshold: [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] // 5% 단위로 세분화
        };

        const observerCallback = (entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                if (entry.isIntersecting) {
                    observedVideosData.set(video, {
                        intersectionRatio: entry.intersectionRatio,
                        timestamp: Date.now() // 최신 정보임을 나타내기 위해 타임스탬프 추가
                    });
                } else {
                    observedVideosData.delete(video); // 화면에서 완전히 벗어나면 Map에서 제거
                }
            });

            selectVideoLogic(null); // 모든 교차 변화가 반영된 후 가장 적합한 비디오를 선택
        };

        videoObserver = new IntersectionObserver(observerCallback, observerOptions);
    }

    function updateVideoList() {
        const currentPlayableVideos = findPlayableVideos();

        // 기존에 관찰 중이던 비디오 중 현재 목록에 없는 것은 관찰 중단
        observedVideosData.forEach((value, video) => {
            if (!currentPlayableVideos.includes(video)) {
                if (videoObserver) {
                    videoObserver.unobserve(video);
                    observedVideosData.delete(video);
                }
            }
        });

        // 새로 찾은 비디오 중 아직 관찰하지 않는 비디오는 관찰 시작
        currentPlayableVideos.forEach(video => {
            if (videoObserver && !observedVideosData.has(video)) {
                videoObserver.observe(video);
                // 초기 상태를 반영하기 위해 0으로 시작 (콜백에서 업데이트됨)
                observedVideosData.set(video, { intersectionRatio: 0, timestamp: Date.now() });
            }
        });

        // currentVideo가 유효하지 않으면 초기화
        if (state.currentVideo && (!document.body.contains(state.currentVideo) || !currentPlayableVideos.includes(state.currentVideo))) { // 상태 사용
            if (state.currentVideo) state.currentVideo.pause(); // 상태 사용
            setCurrentVideo(null); // 상태 업데이트
            setIsPopupVisible(false); // 상태 업데이트
        }
    }

    // --- 비디오 우선순위 점수 계산 함수 ---
    function calculateVideoScore(video, data) {
        const rect = video.getBoundingClientRect();
        const centerDist = Math.hypot(
            rect.left + rect.width / 2 - window.innerWidth / 2,
            rect.top + rect.height / 2 - window.innerHeight / 2
        );

        // 중앙에 가까울수록 점수가 높아지도록 스케일링
        const centerScore = 1 / Math.pow(1 + centerDist, 5);
        // 비디오가 재생 중이면 매우 높은 가중치 부여
        const isPlayingScore = (!video.paused && video.duration > 0 && !video.ended) ? 10000 : 0;

        // 교차 비율, 중앙 근접도, 재생 상태를 종합한 복합 점수
        return data.intersectionRatio * 10000 + centerScore * 5000 + isPlayingScore;
    }

    // --- 개선된 selectVideoLogic 함수 ---
    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => data.intersectionRatio > 0) // 뷰포트에 보이는 비디오만 필터링
            .map(([video, data]) => ({
                video,
                // 분리된 calculateVideoScore 함수를 사용하여 점수 계산
                score: calculateVideoScore(video, data),
                intersectionRatio: data.intersectionRatio // IntersectionObserver 콜백 디버깅 또는 추가 로직을 위해 유지
            }))
            .sort((a, b) => b.score - a.score); // score 기준 1회만 정렬

        let activeVideo = null;

        // 현재 비디오가 여전히 유효하고 화면에 보이면 그대로 유지 (최우선)
        if (state.currentVideo && document.body.contains(state.currentVideo) && observedVideosData.has(state.currentVideo) && observedVideosData.get(state.currentVideo).intersectionRatio > 0) { // 상태 사용
            activeVideo = state.currentVideo; // 상태 사용
        } else if (candidateVideos.length > 0) {
            // 그 외의 경우, 가장 score가 높은 비디오를 선택
            activeVideo = candidateVideos[0].video;
        }

        if (activeVideo) {
            // 현재 제어 중인 비디오가 새로 선택된 비디오와 다르면 비디오 전환
            if (state.currentVideo !== activeVideo) { // 상태 사용
                if (state.currentVideo) state.currentVideo.pause(); // 상태 사용
                selectAndControlVideo(activeVideo); // 새 비디오 제어 시작
            }

            // 클릭 이벤트 등으로 호출된 경우에만 팝업 표시 및 타이머 재설정
            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
            // 제어할 비디오가 없으면 현재 비디오를 null로 설정하고 팝업 숨김
            if (state.currentVideo) { // 상태 사용
                state.currentVideo.pause(); // 상태 사용
            }
            setCurrentVideo(null); // 상태 업데이트
            setIsPopupVisible(false); // 상태 업데이트
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            if (state.currentVideo && (!document.body.contains(state.currentVideo) || !observedVideosData.has(state.currentVideo) || observedVideosData.get(state.currentVideo).intersectionRatio === 0)) { // 상태 사용
                if (state.currentVideo) state.currentVideo.pause(); // 상태 사용
                setCurrentVideo(null); // 상태 업데이트
                setIsPopupVisible(false); // 상태 업데이트
            }
        }, 100);
    }

    // --- DOM 변경 감지 및 데바운스 처리 함수 (함수화) ---
    function setupDebouncedDOMObserver(onChangeCallback, debounceMs = 300) {
        let debounceTimer = null;

        const observerCallback = (mutationsList) => {
            let mediaChanged = false;

            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    const addedHasMedia = Array.from(mutation.addedNodes).some(n =>
                        n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' ||
                        (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))
                    );
                    const removedHasMedia = Array.from(mutation.removedNodes).some(n =>
                        n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'
                    );
                    if (addedHasMedia || removedHasMedia) {
                        mediaChanged = true;
                        break;
                    }
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    if (['src', 'controls', 'style'].includes(mutation.attributeName)) {
                        mediaChanged = true;
                        break;
                    }
                }
            }

            if (mediaChanged) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    onChangeCallback();
                    debounceTimer = null;
                }, debounceMs);
            }
        };

        const observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });

        return observer;
    }

    // --- SPA URL 변경 탐지 함수 (함수화) ---
    function setupSPADetection(onUrlChangeCallback) {
        let lastUrl = location.href;

        const observer = new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                onUrlChangeCallback(currentUrl);
            }
        });

        // document 전체를 관찰하여 URL 변경을 감지 (URL 변경은 일반적으로 DOM 변경을 동반함)
        observer.observe(document, { subtree: true, childList: true });

        return observer;
    }

    function fixOverflow() {
        const overflowFixSites = []; // 필요한 경우 특정 사이트의 overflow 이슈를 처리합니다.
        overflowFixSites.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.setProperty('overflow', 'visible', 'important');
                    });
                });
            }
        });
    }

    // --- requestAnimationFrame 기반 비디오 상태 루프 ---
    function videoStatusLoop() {
        if (!state.currentVideo && !state.isPopupVisible) { // 상태 사용
            stopVideoStatusLoop();
            return;
        }

        if (state.currentVideo && !state.currentVideo.ended) { // 상태 사용
            const isPlayingNow = !state.currentVideo.paused; // 현재 비디오의 재생 상태

            // desiredPlaybackRate와 실제 playbackRate 동기화
            if (state.currentVideo.playbackRate !== state.desiredPlaybackRate) {
                state.currentVideo.playbackRate = state.desiredPlaybackRate;
            }
            // desiredVolume과 실제 volume 동기화
            // setDesiredVolume 함수가 이미 직접 비디오 볼륨을 설정하므로, 여기서는 간섭만 확인.
            // 만약 외부에서 비디오 볼륨이 변경되었다면, desiredVolume을 업데이트.
            if (Math.abs(state.currentVideo.volume - state.desiredVolume) > 0.005) {
                state.desiredVolume = state.currentVideo.volume; // 실제 볼륨을 상태에 반영
            }

            // isManuallyMuted와 실제 muted 상태 동기화
            // isManuallyMuted가 true면 강제로 muted, 아니면 desiredVolume이 0일 때만 muted
            const shouldBeMuted = state.isManuallyMuted || (state.desiredVolume === 0);
            if (state.currentVideo.muted !== shouldBeMuted) {
                state.currentVideo.muted = shouldBeMuted;
            }

            // 재생 강제 반복 방지: 상태 변화를 감지해서 play() 호출
            // 비디오가 현재 재생 중이 아니고 (일시 정지 상태), 수동으로 일시 정지한 상태가 아닐 때
            if (!isPlayingNow && !state.isManuallyPaused) { // 상태 사용
                // 이전에 'playing' 상태가 아니었다면 (즉, 'paused' 또는 null 이었다면) play()를 시도
                if (state.lastPlayState !== 'playing') { // 상태 사용
                    state.currentVideo.play().catch(e => { // 상태 사용
                        // play() 실패 시 (예: 사용자 제스처 필요) 콘솔에 경고만 표시
                        console.warn("[VCP] Autoplay attempt failed in loop:", e.name, e.message);
                    });
                    setLastPlayState('playing'); // 상태 업데이트
                }
            } else if (isPlayingNow) {
                // 비디오가 현재 재생 중이라면 상태를 'playing'으로 유지
                setLastPlayState('playing'); // 상태 업데이트
            } else {
                // 그 외의 경우 (예: 수동 일시 정지 상태), 상태를 'paused'로 유지
                setLastPlayState('paused'); // 상태 업데이트
            }
        }

        // currentVideo를 제외한 다른 모든 비디오는 일시 정지 및 음소거
        findAllVideosDeep().forEach(video => {
            if (video !== state.currentVideo) { // 상태 사용
                if (!video.paused) { video.pause(); }
                if (!video.muted || video.volume > 0) { video.muted = true; video.volume = 0; }
            }
        });

        // 팝업이 보이고 드래그 중이 아니면 팝업 UI 업데이트
        if (popupElement && state.isPopupVisible && !state.isPopupDragging) { // 상태 사용
            updatePopupLayout(); // 리팩토링된 레이아웃 갱신 함수 호출
            updatePlayPauseButton();
            updateMuteSpeakButtons();
            updatePopupSliders();
        }

        // 다음 애니메이션 프레임에 루프 다시 실행
        rafId = requestAnimationFrame(videoStatusLoop);
    }

    function startVideoStatusLoop() {
        if (!rafId) {
            rafId = requestAnimationFrame(videoStatusLoop);
            console.log('[VCP] Video status loop started with requestAnimationFrame.');
        }
    }

    function stopVideoStatusLoop() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
            setLastPlayState(null); // 상태 업데이트
            console.log('[VCP] Video status loop stopped.');
        }
    }
    // --- requestAnimationFrame 기반 비디오 상태 루프 끝 ---

    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 ---
    document.addEventListener('touchstart', (e) => {
        if (e.touches && e.touches.length > 0) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        } else { // Fallback for non-touch event (though touchstart implies touches)
            touchStartX = e.clientX;
            touchStartY = e.clientY;
        }
        touchMoved = false; // 터치 시작 시, 드래그 여부 초기화
    }, { passive: true }); // 스크롤 성능 향상을 위해 passive: true

    document.addEventListener('touchmove', (e) => {
        if (!e.touches || e.touches.length === 0) return;
        const touch = e.touches[0];
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
            touchMoved = true;  // 이동으로 간주 (드래그 발생)
        }
    }, { passive: true }); // 스크롤 성능 향상을 위해 passive: true

    // capture phase에서 이벤트를 가로채서 처리
    document.body.addEventListener('click', (e) => {
        // 팝업 내부를 클릭한 경우
        if (popupElement && state.isPopupVisible && popupElement.contains(e.target)) { // 상태 사용
            resetPopupHideTimer(); // 팝업 숨김 타이머만 리셋
            e.stopPropagation(); // 이벤트 전파 중단 (팝업 내부 클릭은 다른 요소에 영향을 주지 않음)
            return;
        }

        // touchMoved가 true면 터치 드래그/스크롤이 있었으므로 클릭 이벤트를 무시
        // 이는 touchend와 click이 중복 발생하는 것을 방지
        if (touchMoved) {
            touchMoved = false; // 플래그 초기화
            e.stopPropagation(); // 이벤트 전파 중단
            e.preventDefault(); // 일부 브라우저에서 드래그 후 발생하는 클릭 방지
            return;
        }

        // 링크나 버튼 등 기본 클릭 가능한 요소는 무시 (selectVideoLogic이 불필요)
        // [tabindex]:not([tabindex="-1"]) 추가: 키보드 포커스 가능한 요소도 포함
        if (e.target.closest('a, button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea')) {
            return;
        }

        // 팝업이 보이는 상태에서 팝업 외부를 클릭한 경우 팝업 숨김
        if (popupElement && state.isPopupVisible && !popupElement.contains(e.target)) { // 상태 사용
            setIsPopupVisible(false); // 상태 업데이트
        }

        // 비디오 선택 로직 실행 (이제 터치 이벤트와 중복되지 않음)
        selectVideoLogic(e);
    }, true); // capture phase에서 리스너 실행

    // capture phase에서 이벤트를 가로채서 처리
    document.body.addEventListener('touchend', (e) => {
        // 팝업 내부를 터치한 경우
        if (popupElement && state.isPopupVisible && popupElement.contains(e.target)) { // 상태 사용
            resetPopupHideTimer(); // 팝업 숨김 타이머만 리셋
            // e.stopPropagation(); // 팝업 내부 요소의 touchend는 전파 허용 (버튼 클릭 등)
            return;
        }

        // touchMoved가 true면 터치 드래그/스크롤이 있었으므로 touchend에서 비디오 선택 로직을 실행하지 않음
        // 이는 드래그를 클릭으로 오인하는 것을 방지
        if (touchMoved) {
            touchMoved = false; // 플래그 초기화
            e.stopPropagation(); // 이벤트 전파 중단
            e.preventDefault(); // 기본 스크롤 동작 후 클릭 방지
            return;
        }

        // 링크나 버튼 등 기본 클릭 가능한 요소는 무시 (selectVideoLogic이 불필요)
        // [tabindex]:not([tabindex="-1"]) 추가: 키보드 포커스 가능한 요소도 포함
        if (e.target.closest('a, button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea')) {
            return;
        }

        // 팝업이 보이는 상태에서 팝업 외부를 터치한 경우 팝업 숨김
        if (popupElement && state.isPopupVisible && !popupElement.contains(e.target)) { // 상태 사용
            setIsPopupVisible(false); // 상태 업데이트
        }

        // 비디오 선택 로직 실행
        selectVideoLogic(e);
    }, true); // capture phase에서 리스너 실행
    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 끝 ---

    // --- 팝업 반응형 이벤트 리스너 설정 ---
    function setupPopupResponsiveListeners() {
        window.addEventListener('resize', updatePopupLayout);
        document.addEventListener('fullscreenchange', updatePopupLayout);
        window.addEventListener('orientationchange', updatePopupLayout); // 모바일 기기 방향 전환 시
    }

    function initialize() {
        if (state.isInitialized) return; // 상태 사용
        setIsInitialized(true); // 상태 업데이트

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.15_RangeErrorFixV3_ButtonFix (Bugfix applied)');

        createPopupElement(); // 팝업 엘리먼트 초기 생성
        hidePopup(); // 초기 상태는 숨김

        setupIntersectionObserver();
        updateVideoList(); // 초기 비디오 목록 감지 시작

        // --- DOM 변경 감지 및 SPA URL 변경 감지 초기화 ---
        domMutationObserverInstance = setupDebouncedDOMObserver(() => {
            console.log('[VCP] DOM 변경 감지 (데바운스) - 비디오 목록 갱신');
            updateVideoList();
        }, DEBOUNCE_MUTATION_OBSERVER_MS);

        spaDetectionObserverInstance = setupSPADetection((newUrl) => {
            console.log(`[VCP] SPA URL 변경 감지: ${newUrl} - 비디오 상태 초기화`);
            if (state.currentVideo) state.currentVideo.pause(); // 상태 사용
            setCurrentVideo(null); // 상태 업데이트
            setIsPopupVisible(false); // 상태 업데이트
            updateVideoList();
        });
        // --- 초기화 끝 ---

        // 팝업 반응형 리스너 설정
        setupPopupResponsiveListeners();

        window.addEventListener('scroll', handleScrollEvent);

        fixOverflow();

        startVideoStatusLoop();

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and stopping loops.');
            setCurrentVideo(null); // 상태 업데이트
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            stopVideoStatusLoop();
            if (videoObserver) {
                videoObserver.disconnect();
                videoObserver = null;
                observedVideosData.clear();
            }
            // MutationObserver 인스턴스 해제
            if (domMutationObserverInstance) {
                domMutationObserverInstance.disconnect();
                domMutationObserverInstance = null;
            }
            if (spaDetectionObserverInstance) {
                spaDetectionObserverInstance.disconnect();
                spaDetectionObserverInstance = null;
            }
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
