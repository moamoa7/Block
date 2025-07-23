// ==UserScript==
// @name Video Controller Popup (V4.11.13: 자동재생 개선 시도)
// @namespace Violentmonkey Scripts
// @version 4.11.13_AutoplayAttemptImprovement
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyPaused = false; // 사용자가 직접 정지했는지 여부
    let isManuallyMuted = false; // 사용자가 직접 음소거했는지 여부 (유저가 팝업/사이트 자체 UI로 뮤트했는지)
    let isPopupVisible = false; // 팝업 현재 표시 상태 추적

    const videoRateHandlers = new WeakMap();
    let checkVideoInterval = null;
    const originalPlayMethods = new WeakMap(); // 원본 play() 메서드를 저장

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 0.5초마다 비디오 상태 체크 (위치 갱신)

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

            return isVisible && isReasonableSize && hasMedia;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight, viewportWidth = window.innerWidth;

        const intersectionTop = Math.max(0, rect.top);
        const intersectionBottom = Math.min(viewportHeight, rect.bottom);
        const intersectionLeft = Math.max(0, rect.left);
        const intersectionRight = Math.min(viewportWidth, rect.right);

        const intersectionHeight = intersectionBottom - intersectionTop;
        const intersectionWidth = intersectionRight - intersectionLeft;

        const intersectionArea = Math.max(0, intersectionWidth) * Math.max(0, intersectionHeight);
        const videoArea = rect.width * rect.height;

        return videoArea > 0 ? intersectionArea / videoArea : 0;
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const rect = currentVideo.getBoundingClientRect();
        const style = window.getComputedStyle(currentVideo);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
        const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
        const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || currentVideo.tagName === 'AUDIO' || !currentVideo.paused;
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO';

        // 현재 풀스크린 상태를 고려하여 가시성 판단
        const fsEl = document.fullscreenElement;
        if (fsEl) {
            // 풀스크린 요소가 현재 비디오를 포함하고 있는지 확인
            if (!fsEl.contains(currentVideo)) {
                return false; // 풀스크린인데 현재 비디오가 그 안에 없으면 숨겨진 것으로 간주
            }
        }
        return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        // 기존 currentVideo가 있고, 새로운 videoToControl과 다를 경우 원래 play() 메서드 복원
        if (currentVideo && currentVideo !== videoToControl && originalPlayMethods.has(currentVideo)) {
            currentVideo.play = originalPlayMethods.get(currentVideo);
            originalPlayMethods.delete(currentVideo);
        }

        // 모든 감지된 비디오에 대해 처리
        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
                // 현재 비디오가 아닌 다른 비디오는 무조건 일시 정지, 음소거, 볼륨 0, 현재 시간 0으로 초기화
                if (originalPlayMethods.has(video) && video !== currentVideo) {
                    video.play = originalPlayMethods.get(video);
                    originalPlayMethods.delete(video);
                }
                if (!video.paused) {
                    video.pause();
                }
                video.muted = true;
                video.volume = 0;
                video.currentTime = 0;
            } else { // videoToControl (새로 선택된 비디오)
                // 현재 비디오가 아닌 경우에만 설정
                if (currentVideo !== videoToControl) {
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;

                    // --- 핵심 부분: 자동재생 개선 시도 (소리 있는 재생 먼저, 실패 시 음소거 재생 시도) ---
                    // 1. 소리 있는 재생 시도 (기본)
                    videoToControl.muted = false;
                    videoToControl.volume = 1.0;
                    isManuallyMuted = false; // 새로운 비디오 선택 시 수동 음소거 상태 초기화

                    videoToControl.play().catch(e => {
                        console.warn("[VCP] Autoplay with sound failed:", e.name, e.message, "Attempting muted autoplay.");
                        // 2. 소리 있는 재생이 실패하면, 음소거 상태로 다시 재생 시도
                        videoToControl.muted = true;
                        videoToControl.volume = 0; // 음소거 상태에서는 볼륨도 0으로 설정
                        isManuallyMuted = true; // 음소거 상태로 시작했음을 표시
                        videoToControl.play().catch(mutedError => {
                            console.error("[VCP] Muted autoplay also failed:", mutedError.name, mutedError.message);
                        });
                    });
                    // --- 수정 끝 ---
                }
            }
        });

        // 최종적으로 currentVideo 설정 및 팝업 슬라이더 업데이트 (이 함수는 팝업을 띄우지 않음)
        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false; // 새 비디오 선택 시 수동 정지 상태 초기화
            desiredPlaybackRate = currentVideo.playbackRate;

            desiredVolume = currentVideo.volume; // 현재 비디오의 실제 볼륨을 반영
            isManuallyMuted = currentVideo.muted; // 현재 비디오의 실제 뮤트 상태를 반영
        }

        // 배속 및 볼륨 적용 (desired 값으로 강제)
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume); // 이 함수 내에서 isManuallyMuted도 업데이트
        updatePopupSliders(); // 팝업 슬라이더 UI 업데이트 (속도만 남음)
        updatePlayPauseButton(); // 재생/멈춤 버튼 텍스트 업데이트
        updateMuteSpeakButtons(); // 무음/소리 버튼 텍스트 업데이트
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };

        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
        updatePopupSliders();
    }

    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        desiredVolume = vol;

        video.volume = Math.max(0, Math.min(1.0, desiredVolume));
        video.muted = isManuallyMuted || (desiredVolume === 0);

        updateMuteSpeakButtons();
    }

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
            min-width: 280px; /* 팝업 최소 너비 유지 */
            overflow: hidden; text-align: center; pointer-events: auto;
            display: flex; /* Flexbox로 내부 콘텐츠 정렬 */
            flex-direction: column; /* 세로 방향 정렬 */
            align-items: stretch; /* 자식 요소들이 너비를 꽉 채우도록 */
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

        // --- 배속 바 섹션 (상단) ---
        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section-speed';
        speedSection.style.cssText = `
            display: flex;
            flex-direction: column; /* 세로 정렬: 숫자 위에 슬라이더 */
            align-items: center;
            padding: 10px;
            gap: 5px; /* 숫자와 슬라이더 사이 간격 */
            border-bottom: 1px solid #444; /* 하단 구분선 */
        `;

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00x'; // x 추가
        speedDisplay.style.cssText = 'color: #eee; font-size: 1.2em; font-weight: bold; width: 100%; text-align: center;';

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            width: 90%; /* 가로 폭 채우기 */
            height: 10px; /* 높이 줄임 */
            -webkit-appearance: none;
            appearance: none;
            background: #555;
            outline: none;
            border-radius: 5px;
            cursor: pointer;
            margin: 0;
            padding: 0;
        `;
        // 슬라이더 썸 스타일 (커스텀)
        // CSS in JS로 직접 썸 스타일을 제어하기는 어려우므로, 간단한 배경/테두리만 적용
        // 더 복잡한 스타일은 별도 <style> 태그 삽입이 필요할 수 있습니다.

        speedSection.appendChild(speedDisplay); // 숫자 먼저
        speedSection.appendChild(speedInput);   // 슬라이더 나중
        popupElement.appendChild(speedSection);

        // --- 버튼 섹션 (하단) ---
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 10px; /* 버튼 간 간격 */
            padding: 10px; /* 상하좌우 패딩 */
            flex-grow: 1; /* 남은 공간을 채우도록 */
            align-content: stretch; /* 그리드 콘텐츠를 수직으로 늘림 */
            justify-items: stretch;
            min-height: 90px; /* 버튼 4개 공간 확보 */
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
        popupElement.appendChild(buttonSection); // 버튼 섹션을 팝업에 추가

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function updatePlayPauseButton() {
        const playPauseBtn = popupElement.querySelector('[data-action="play-pause"]');
        if (playPauseBtn && currentVideo) {
            playPauseBtn.textContent = currentVideo.paused ? '재생' : '멈춤';
        } else if (playPauseBtn) {
            playPauseBtn.textContent = '재생/멈춤';
        }
    }

    function updateMuteSpeakButtons() {
        const muteBtn = popupElement.querySelector('[data-action="mute"]');
        const speakBtn = popupElement.querySelector('[data-action="speak"]');
        if (muteBtn && speakBtn && currentVideo) {
            if (currentVideo.muted) {
                muteBtn.style.backgroundColor = '#555';
                speakBtn.style.backgroundColor = '#333';
            } else {
                muteBtn.style.backgroundColor = '#333';
                speakBtn.style.backgroundColor = '#555';
            }
        } else if (muteBtn && speakBtn) {
            muteBtn.style.backgroundColor = '#333';
            speakBtn.style.backgroundColor = '#333';
        }
    }

    function handleButtonClick(action) {
        if (!currentVideo) { return; }
        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = isManuallyMuted;
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                        currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                }
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders();
                break;
            case 'reset-speed':
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0);
                break;
            case 'mute':
                if (!currentVideo.muted) {
                    isManuallyMuted = true;
                    setNormalVolume(currentVideo, 0);
                }
                updateMuteSpeakButtons();
                break;
            case 'speak':
                isManuallyMuted = false;
                setNormalVolume(currentVideo, 1.0);
                updateMuteSpeakButtons();
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
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2) + 'x'; // x 추가
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            if (e.target !== dragHandle) return;
            resetPopupHideTimer();
            isPopupDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            const rect = popupElement.getBoundingClientRect();
            popupDragOffsetX = clientX - rect.left;
            popupDragOffsetY = clientY - rect.top;
            popupElement.style.position = 'fixed';
            popupElement.style.transform = 'none';
            document.body.style.userSelect = 'none';
        };

        const stopDrag = () => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                resetPopupHideTimer();
                updatePopupPosition();
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
            popupElement.style.left = `${clientX - popupDragOffsetX}px`;
            popupElement.style.top = `${clientY - popupDragOffsetY}px`;
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag, { passive: false });
        document.addEventListener('mousemove', dragPopup);
    	document.addEventListener('touchmove', dragPopup, { passive: false }); // 터치 이벤트 활성화
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isVisible) {
            const styles = { display: 'flex', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' }; // display: flex로 변경
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
            isPopupVisible = true;
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            isPopupVisible = false;
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            return;
        }

        setPopupVisibility(true);
        updatePopupPosition();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        // 팝업이 드래그 중이거나, 팝업 자체가 보이지 않는 상태에서는 타이머 설정 안 함
        if (!isPopupDragging && isPopupVisible) {
             popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    function updatePopupPosition() {
        if (!currentVideo || !popupElement || isPopupDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        let popupRect = popupElement.getBoundingClientRect(); // 위치 업데이트 전에 최신 크기 가져오기

        const fsEl = document.fullscreenElement;

        if (fsEl) {
            // 풀스크린 모드: 팝업 크기를 고정된 픽셀 값으로 강제
            popupElement.style.width = '280px';
            popupElement.style.minWidth = '280px';
            // 높이 조정: 배속바 상단 + 버튼 하단 구조를 고려하여 더 유동적으로
            popupElement.style.height = 'auto'; // auto로 두어 내부 콘텐츠에 맞게 조정
            popupElement.style.minHeight = '150px'; // 최소 높이도 줄임 (새로운 UI에 맞게)
            popupElement.style.position = 'absolute'; // Fullscreen 요소 내부에 상대적 위치
            popupElement.style.transform = 'none';

            // 크기 변경 후 다시 BoundingClientRect를 가져와 정확한 계산
            popupRect = popupElement.getBoundingClientRect();

            const fsRect = fsEl.getBoundingClientRect();

            // 비디오 중앙 기준으로 팝업 위치 계산
            let targetX = videoRect.left - fsRect.left + (videoRect.width / 2);
            let targetY = videoRect.top - fsRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            // fsEl 내부 경계에 맞추기
            adjustedX = Math.max(0, Math.min(adjustedX, fsRect.width - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, fsRect.height - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;

        } else {
            // 일반 모드: 팝업 크기를 원래대로 복원 (fit-content)
            popupElement.style.width = 'fit-content';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px'; // 일반 모드 최소 높이 조정 (새로운 UI에 맞게)
            popupElement.style.position = 'fixed'; // Viewport에 고정
            popupElement.style.transform = 'none';

            // 크기 변경 후 다시 BoundingClientRect를 가져와 정확한 계산
            popupRect = popupElement.getBoundingClientRect();

            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = Math.max(0, Math.min(targetY - (popupRect.height / 2), window.innerHeight - popupRect.height)); // 팝업이 뷰포트 하단을 벗어나지 않도록 조정

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
        }
        // --- 수정 끝 ---

        // 비디오가 화면에 보이는지 최종 확인
        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;
        if (!isVideoVisible) {
            hidePopup(); // 비디오가 화면에서 벗어나면 팝업 숨김
        }
    }


    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        if (speedInput && speedDisplay) {
            const rate = currentVideo.playbackRate;
            speedInput.value = rate.toFixed(1);
            speedDisplay.textContent = rate.toFixed(2) + 'x'; // x 추가
            desiredPlaybackRate = rate;
        }
    }

    // selectVideoLogic 함수는 e.preventDefault()나 e.stopPropagation()을 직접 호출하지 않음.
    // 이는 이벤트 핸들러에서 제어되어야 함.
    function selectVideoLogic(e) {
        // 이 함수 내부에서는 이벤트 전파/기본 동작 방지 로직을 두지 않고,
        // 오직 비디오를 선택하고 팝업을 표시할지 말지 결정하는 로직만 수행합니다.

        // 클릭 이벤트가 팝업 내부에서 발생한 경우
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer(); // 팝업 내부 클릭 시 타이머 리셋만
            return;
        }

        // 팝업이 이미 열려있었고, 클릭이 팝업 외부에서 발생했다면 팝업 숨김
        if (popupElement && isPopupVisible && e && !popupElement.contains(e.target)) {
            hidePopup();
            return;
        }

        // 팝업이 닫혀있거나, (e === null) 즉 자동 감지 호출인 경우에만 아래 로직 진행
        updateVideoList();

        const centerY = window.innerHeight / 2;
        const centerX = window.innerWidth / 2;

        const filteredVideos = videos;

        const sorted = filteredVideos
        .map(v => {
            const rect = v.getBoundingClientRect();
            const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
            const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
            const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
            const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);

            const centerScore = 1 / Math.pow(1 + centerDist, 5);

            const score = visibleArea * 0.7 + centerScore * 5000 * 0.3;

            return { video: v, score };
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);

        let bestVideo = sorted[0]?.video || null;

        let maxIntersectionRatio = 0;
        let foundPlayingVideo = null;

        videos.forEach(video => {
            const ratio = calculateIntersectionRatio(video);
            const isPlaying = !video.paused && video.duration > 0 && !video.ended;

            if (ratio >= 0.5 && isPlaying) { // 재생 중인 비디오 우선
                foundPlayingVideo = video;
            }

            if (ratio > 0 && ratio > maxIntersectionRatio) {
                maxIntersectionRatio = ratio;
                if (!foundPlayingVideo) { // 재생 중인 비디오가 없다면 가장 많이 보이는 비디오 선택
                    bestVideo = video;
                }
            }
        });

        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        } else if (bestVideo) {
            // Best intersection ratio video (already set)
        } else {
            // No suitable video found.
        }

        if (bestVideo && (maxIntersectionRatio > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo !== bestVideo) {
                // 비디오가 바뀌면 기존 비디오 일시정지 및 초기화
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                selectAndControlVideo(bestVideo); // 이 함수는 팝업을 띄우지 않음

                // 이 경우에만 팝업을 표시 (사용자 클릭 또는 터치에 의해 트리거된 경우)
                if (e instanceof Event) {
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    hidePopup(); // 자동 감지 시에는 팝업 숨김
                }
            } else { // 이미 선택된 비디오가 그대로 유지될 때
                if (e instanceof Event) { // 사용자 클릭/터치일 때만 팝업 표시
                    showPopup();
                    resetPopupHideTimer();
                }
            }
        } else { // 적합한 비디오가 없을 때
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            hidePopup();
        }
    }


    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();

            if (currentVideo && (!checkCurrentVideoVisibility())) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }

            selectVideoLogic(null); // 스크롤 시에도 비디오 선택 로직은 실행하되, 팝업은 자동으로 안 뜸
        }, 100);
    }

    function updateVideoList() {
        findPlayableVideos();
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            hidePopup();
        }
    }

    function setupDOMObserver() {
        const observerConfig = { childList: true, subtree: true, attributes: true };
        const observerCallback = (mutationsList) => {
            let foundMediaChange = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' && (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'))) {
                    foundMediaChange = true;
                    break;
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    // src, controls, display 스타일 등의 변경 감지
                    if (mutation.attributeName === 'src' || mutation.attributeName === 'controls' || mutation.attributeName === 'style') {
                        foundMediaChange = true;
                        break;
                    }
                }
            }
            if (foundMediaChange) {
                updateVideoList();
                selectVideoLogic(null); // DOM 변경 시 비디오 선택 로직은 실행하되, 팝업은 자동으로 안 뜸
            }
        };
        const mutationObserver = new MutationObserver(observerCallback);
        mutationObserver.observe(document.body, observerConfig);
    }

    function setupSPADetection() {
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting popup state.`);
                lastUrl = currentUrl;
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
                updateVideoList();
                selectVideoLogic(null);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [];
        overflowFixSites.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.overflow = 'visible';
                    });
                });
            }
            // Add specific CSS for full-screen elements if needed
            if (document.fullscreenElement) {
                if (location.hostname.includes(site.domain)) {
                    // Example: if a site's full-screen video container has 'overflow: hidden'
                    // document.fullscreenElement.style.overflow = 'visible';
                }
            }
        });
    }


    function startCheckingVideoStatus() {
        if (checkVideoInterval) clearInterval(checkVideoInterval);
        checkVideoInterval = setInterval(() => {
            findAllVideosDeep().forEach(video => {
                if (video !== currentVideo) {
                    if (!video.paused) {
                        video.pause();
                    }
                    if (!video.muted || video.volume > 0) {
                        video.muted = true;
                        video.volume = 0;
                    }
                } else {
                    // currentVideo는 외부 상호작용 (팝업 버튼 등)에 따라 재생/일시정지 상태가 변할 수 있으므로
                    // isManuallyPaused 상태를 우선적으로 존중합니다.
                    if (video.paused && !video.ended && !isManuallyPaused) {
                        // 사용자가 직접 정지하지 않았는데 비디오가 정지되어 있다면, 재생 시도
                        video.play().catch(e => {
                            // 자동 재생 시도가 실패하면, 음소거 상태로 재시도 (여기서는 console.warn만 남김)
                            // 실제 자동 재생 로직은 selectAndControlVideo에서 이미 처리됨
                            // console.warn("Auto-play attempt failed during check:", e);
                        });
                    }
                    if (video.playbackRate !== desiredPlaybackRate) {
                        // 비디오의 실제 재생 속도가 desiredPlaybackRate와 다르면 업데이트 (다른 스크립트 등 개입 대비)
                        desiredPlaybackRate = video.playbackRate;
                        updatePopupSliders();
                    }
                    // 비디오의 실제 뮤트/볼륨 상태가 원하는 상태와 다르면 동기화
                    if (video.muted !== (isManuallyMuted || desiredVolume === 0) || Math.abs(video.volume - desiredVolume) > 0.005) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                        updateMuteSpeakButtons(); // UI 업데이트
                    }
                }
            });

            if (!currentVideo) {
                selectVideoLogic(null);
            }

            if (popupElement && isPopupVisible && !isPopupDragging) { // 팝업이 보일 때만 업데이트
                updatePopupPosition();
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders();
            }
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.13_AutoplayAttemptImprovement');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
    const fsEl = document.fullscreenElement;
    if (!popupElement) return;

    if (fsEl) {
        fsEl.appendChild(popupElement);
        // 풀스크린 모드에서 팝업의 고정 크기
        popupElement.style.width = '280px';
        popupElement.style.minWidth = '280px';
        popupElement.style.height = 'auto';
        popupElement.style.minHeight = '150px';
        popupElement.style.position = 'absolute';
        popupElement.style.transform = 'none';

        updatePopupPosition();
        resetPopupHideTimer();

        // 👉 사용자가 클릭했을 때만 한 번 showPopup
        let clicked = false;
        const onClick = () => {
            if (!clicked) {
                clicked = true;
                showPopup();
                window.removeEventListener('click', onClick, true); // useCapture = true
            }
        };
        window.addEventListener('click', onClick, true);
    } else {
        document.body.appendChild(popupElement);
        // 일반 모드에서 팝업의 유동적인 크기
        popupElement.style.width = 'fit-content';
        popupElement.style.minWidth = '280px';
        popupElement.style.height = 'auto';
        popupElement.style.minHeight = '150px';
        popupElement.style.position = 'fixed';
        popupElement.style.transform = 'none';

        updatePopupPosition();
        hidePopup();
    }
});

        window.addEventListener('resize', () => {
            updatePopupPosition();
        });

        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList();
        setupDOMObserver();
        setupSPADetection();
        fixOverflow();

        // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 최종 픽스 로직 시작 ---
        let touchStartX = 0;
        let touchStartY = 0;
        let touchMoved = false;
        const TOUCH_MOVE_THRESHOLD = 10; // 10px 이상 움직이면 스크롤로 간주

        document.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchMoved = false; // 매 터치 시작 시 초기화
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const deltaX = Math.abs(e.touches[0].clientX - touchStartX);
            const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
            if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
                touchMoved = true;
            }
        }, { passive: true });

        // 'click' 이벤트 리스너: 캡처링 단계에서 먼저 처리
        document.body.addEventListener('click', (e) => {
            // 1. 팝업 내부 클릭인 경우
            if (popupElement && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return; // 팝업 내부의 클릭은 원래 동작 (버튼 클릭 등)을 허용하고 스크립트 로직 중단
            }

            // 2. 클릭된 요소가 링크(<a>)이거나 링크 역할을 하는 요소인지 확인
            // `closest('a')`는 클릭된 요소부터 부모 방향으로 올라가면서 가장 가까운 'a' 태그를 찾습니다.
            // 또는 `e.target`이 직접 버튼 태그이거나, 특정 클래스를 가진 이동 버튼인 경우를 추가할 수 있습니다.
            const clickedLink = e.target.closest('a');
            const isClickableButton = e.target.matches('button, input[type="button"], [role="button"]'); // 일반적인 버튼
            const isTargetedForNavigation = (clickedLink || isClickableButton); // 또는 다른 웹사이트의 페이지 이동 요소들을 여기에 추가

            if (isTargetedForNavigation) {
                // 클릭된 요소가 링크나 버튼이라면, 스크립트의 비디오 선택/팝업 표시 로직을 건너뜁니다.
                // 이렇게 하면 웹사이트의 원래 클릭 동작(페이지 이동, 버튼 기능 등)이 방해받지 않습니다.
                return;
            }

            // 3. 터치 움직임(스크롤/드래그)이 있었던 경우
            if (touchMoved) {
                // 터치 움직임이 있었으면 클릭 이벤트를 무시 (팝업이 뜨는 것을 막음)
                // 하지만 웹사이트의 기본 동작(예: 스크롤 후 놓았을 때 의도치 않은 클릭)도 막을 수 있음.
                // 여기서는 `e.stopPropagation()`과 `e.preventDefault()`를 사용하지 않음으로써,
                // 만약 웹사이트 자체에서 스크롤 중 발생한 클릭을 처리한다면 그게 작동하도록 둠.
                // 단지 우리의 `selectVideoLogic`만 실행하지 않음.
                touchMoved = false; // 플래그 초기화
                return;
            }

            // 4. 팝업이 열려있는데, 팝업 외부를 클릭한 경우 (링크나 터치 움직임이 아닌 경우)
            if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
                hidePopup(); // 팝업만 숨기고, 웹사이트의 기본 클릭 동작은 허용
                return;
            }

            // 5. 위 모든 조건에 해당하지 않는 경우: 비디오 선택 로직 실행 (팝업 표시 가능)
            selectVideoLogic(e);
        }, true); // `true`는 capturing phase에서 이벤트를 가로채겠다는 의미

        // `touchend` 이벤트 핸들러는 이제 `selectVideoLogic`을 직접 호출하지 않고,
        // `click` 이벤트에 모든 제어권을 넘겨주어 충돌을 피합니다.
        // `click` 이벤트가 항상 `touchend` 이후에 발생함을 이용.

        // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 최종 픽스 로직 끝 ---

        startCheckingVideoStatus();

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval);
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
