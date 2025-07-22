// ==UserScript==
// @name Video Controller Popup (V4.11.8: UI 레이아웃 및 전체화면 세로 여백 최종 개선)
// @namespace Violentmonkey Scripts
// @version 4.11.8_FixedFullscreenPopup_FixedClickHide_FixedUILayout_VerticalSpacing_FinalFix
// @description Core video controls with streamlined UI. All videos auto-play with sound. Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with vertical speed slider (ascending).
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

                    // --- 핵심 부분: 모든 사이트에서 소리를 허용합니다. ---
                    videoToControl.muted = false; // 무조건 음소거 해제
                    videoToControl.volume = 1.0; // 볼륨 100%
                    console.log('[VCP] Video selected. Initiating autoplay with sound (100%).');
                    // --- 수정 끝 ---

                    videoToControl.play().catch(e => {
                        // console.warn("Autoplay/Play on select failed:", e);
                    });
                }
            }
        });

        // 최종적으로 currentVideo 설정 및 팝업 슬라이더 업데이트 (이 함수는 팝업을 띄우지 않음)
        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false; // 새 비디오 선택 시 수동 정지 상태 초기화
            desiredPlaybackRate = currentVideo.playbackRate;

            desiredVolume = 1.0; // 모든 경우에 100%를 목표 볼륨으로 설정
            isManuallyMuted = false; // 이제 자동 음소거가 없으므로 항상 false로 시작
        }

        // 배속 및 볼륨 적용 (desired 값으로 강제)
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume);

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
            min-width: 280px;
            overflow: hidden; text-align: center; pointer-events: auto;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            font-weight: bold; margin-bottom: 8px; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
        `;
        popupElement.appendChild(dragHandle);

        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = `
            display: flex;
            padding: 10px;
            align-items: center;
            gap: 10px;
            min-height: 170px; /* 최소 높이 더 증가: 버튼 여백과 배속 숫자 확보 */
            box-sizing: border-box;
        `;

        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: space-around; /* 슬라이더와 숫자 사이 간격 조정 (start -> around) */
            height: 100%; /* 부모(contentContainer)의 높이를 따름 */
            gap: 15px; /* 슬라이더와 숫자 사이 간격 유지 */
            padding: 5px 0; /* 상하 패딩 유지 */
            border-right: 1px solid #444;
            box-sizing: border-box;
            margin-right: 10px;
            min-width: 60px;
        `;

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedDisplay.style.cssText = 'color: #eee; font-size: 1.2em; font-weight: bold; width: 60px; text-align: center;';

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            width: 20px;
            height: 100px;
            -webkit-appearance: slider-vertical;
            writing-mode: bt-lr;
            cursor: pointer;
            margin: 0;
            padding: 0;
        `;

        speedSection.appendChild(speedInput);
        speedSection.appendChild(speedDisplay);

        contentContainer.appendChild(speedSection);

        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: repeat(2, minmax(40px, 1fr)); /* 최소 높이 40px, 남는 공간 균등 배분 */
            gap: 10px; /* 버튼 간 간격 조정 (8px -> 10px) */
            flex-grow: 1;
            align-content: stretch; /* 그리드 콘텐츠를 수직으로 늘림 */
            justify-items: stretch;
            min-width: 180px;
            padding-bottom: 5px; /* 버튼 섹션 하단에 추가 패딩 */
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
        contentContainer.appendChild(buttonSection);

        popupElement.appendChild(contentContainer);
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
            speedDisplay.textContent = rate.toFixed(2);
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
            const styles = { display: 'block', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
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
            popupElement.style.height = '210px'; /* 풀스크린 모드 높이 추가 증가 */
            popupElement.style.minHeight = '210px'; /* 풀스크린 모드 최소 높이 추가 증가 */
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
            popupElement.style.minHeight = '170px'; /* 일반 모드 최소 높이 증가 */
            popupElement.style.position = 'fixed'; // Viewport에 고정
            popupElement.style.transform = 'none';

            // 크기 변경 후 다시 BoundingClientRect를 가져와 정확한 계산
            popupRect = popupElement.getBoundingClientRect();

            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, window.innerWidth - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, window.innerHeight - popupRect.height));

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
            speedDisplay.textContent = rate.toFixed(2);
            desiredPlaybackRate = rate;
        }
    }

    function selectVideoLogic(e) {
        // 클릭 이벤트가 팝업 내부에서 발생한 경우
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer(); // 팝업 내부 클릭 시 타이머 리셋만
            return;
        }

        // 클릭 이벤트가 팝업 외부에서 발생했고, 팝업이 이미 열려있었다면 팝업 숨김
        if (popupElement && isPopupVisible && e && !popupElement.contains(e.target)) {
            hidePopup();
            return; // 팝업을 숨겼으면 더 이상 비디오 선택 로직을 진행하지 않음
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

                if (e instanceof Event) { // 사용자 클릭일 때만 팝업 표시
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    hidePopup(); // 자동 감지 시에는 팝업 숨김
                }
            } else { // 이미 선택된 비디오가 그대로 유지될 때
                if (e instanceof Event) { // 사용자 클릭일 때만 팝업 표시
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
                    if (video.paused && !video.ended && !isManuallyPaused) {
                        video.play().catch(e => { /* console.warn("Auto-play attempt failed:", e); */ });
                    }
                    if (video.playbackRate !== desiredPlaybackRate) {
                        desiredPlaybackRate = video.playbackRate;
                    }
                    if (Math.abs(video.volume - desiredVolume) > 0.005 || video.muted !== (isManuallyMuted || desiredVolume === 0)) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.8_FixedFullscreenPopup_FixedClickHide_FixedUILayout_VerticalSpacing_FinalFix');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                    // 풀스크린 모드에서 팝업의 고정 크기
                    popupElement.style.width = '280px';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = '210px'; // 풀스크린 모드 높이 추가 증가
                    popupElement.style.minHeight = '210px'; // 풀스크린 모드 최소 높이 추가 증가
                    popupElement.style.position = 'absolute';
                    popupElement.style.transform = 'none';

                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    document.body.appendChild(popupElement);
                    // 일반 모드에서 팝업의 유동적인 크기 (최소 너비만 유지)
                    popupElement.style.width = 'fit-content';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '170px'; // 일반 모드 최소 높이 증가
                    popupElement.style.position = 'fixed';
                    popupElement.style.transform = 'none';

                    updatePopupPosition();
                    hidePopup();
                }
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

        let touchStartY = 0;
        let touchMoved = false;

        document.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            touchMoved = false;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
            if (deltaY > 10) {
                touchMoved = true;
            }
        }, { passive: true });

        document.body.addEventListener('click', (e) => {
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoLogic(e);
        }, true);

        document.body.addEventListener('touchend', (e) => {
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoLogic(e);
        }, true);


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
