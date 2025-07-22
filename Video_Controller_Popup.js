// ==UserScript==
// @name Video Controller Popup (V4.10.61: 자동 소리 재생 + SPA 대응 강화 + 팝업 조건 강화)
// @namespace Violentmonkey Scripts
// @version 4.10.61_NoAutoMute_NoSiteSpecific_NoLazySrcBlocked_Updated_FixedMobileDrag_CompactUI_VerticalSlider_Ascending_FixedOrientation_FixedPreviewClickV10_PopupClickFix
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
    let isManuallySelected = false; // 사용자가 팝업을 클릭하여 비디오를 수동으로 선택했는지 여부
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

            // --- desiredVolume 및 isManuallyMuted 초기화 로직 (변경 없음) ---
            desiredVolume = 1.0; // 모든 경우에 100%를 목표 볼륨으로 설정
            isManuallyMuted = false; // 이제 자동 음소거가 없으므로 항상 false로 시작
            // --- 수정 끝 ---
        }

        // 배속 및 볼륨 적용 (desired 값으로 강제)
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume); // 이 시점에서는 위 설정에 따라 volume=1.0, muted 상태가 결정됨

        updatePopupSliders(); // 팝업 슬라이더 UI 업데이트 (속도만 남음)
        updatePlayPauseButton(); // 재생/멈춤 버튼 텍스트 업데이트
        updateMuteSpeakButtons(); // 무음/소리 버튼 텍스트 업데이트
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        // desiredPlaybackRate는 현재 비디오의 실제 재생 속도를 추적
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            // 외부에서 재생 속도가 변경될 경우 desiredPlaybackRate도 업데이트
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };

        // UI를 통해 설정하는 경우에만 비디오의 playbackRate를 변경
        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
        updatePopupSliders(); // 슬라이더와 디스플레이 업데이트
    }

    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        // desiredVolume은 현재 비디오의 실제 볼륨을 추적
        desiredVolume = vol;

        // UI를 통해 설정하는 경우에만 비디오의 볼륨과 뮤트 상태를 변경
        // 여기서 바로 video.volume을 desiredVolume으로 설정하여 일관성을 유지
        video.volume = Math.max(0, Math.min(1.0, desiredVolume));

        // 사용자가 수동으로 뮤트했거나, 볼륨이 0일 경우 뮤트 상태를 유지
        // isManuallyMuted는 '무음'/'소리' 버튼 클릭 시에만 변경됨
        video.muted = isManuallyMuted || (desiredVolume === 0);

        // 볼륨 슬라이더가 없으므로 관련 UI 업데이트는 제거
        // updatePopupSliders();
        updateMuteSpeakButtons(); // 무음/소리 버튼 텍스트 업데이트
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
            min-width: 180px;
            overflow: hidden; text-align: center; pointer-events: auto;
            max-width: 90vw;
            max-height: 90vh;

            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: center;
            gap: 6px;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            font-weight: bold; margin-bottom: 8px; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
            width: 100%;
            box-sizing: border-box;
        `;
        popupElement.appendChild(dragHandle);

        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = `
            display: flex;
            padding: 10px;
            align-items: center;
            gap: 10px;
            min-height: 120px;
            flex-grow: 1;
            box-sizing: border-box;
            width: 100%;
        `;

        // 배속 조절 섹션 (세로 슬라이더)
        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: space-between;
            height: 100%;
            gap: 5px;
            padding: 5px;
            border-right: 1px solid #444;
            box-sizing: border-box;
            margin-right: 10px;
        `;

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedDisplay.style.cssText = `
            color: #eee; font-size: 1.2em; font-weight: bold; width: 60px; text-align: center;
            min-height: 24px;
            line-height: 24px;
            display: inline-block;
            vertical-align: middle;
        `;

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            width: 20px;
            height: 100%;
            -webkit-appearance: slider-vertical;
            writing-mode: bt-lr;
            cursor: pointer;
            margin: 0;
            padding: 0;
        `;

        speedSection.appendChild(speedInput);
        speedSection.appendChild(speedDisplay);

        contentContainer.appendChild(speedSection);

        // 버튼 섹션 (2x2 그리드)
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr;
            grid-template-rows: 1fr 1fr;
            gap: 8px;
            flex-grow: 1;
            align-content: center;
            justify-items: stretch;
            min-width: 100px;
        `;

        const buttonBaseStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            text-align: center;
            font-size: 15px;
            width: 48px !important; /* 명시적 고정 크기 */
            height: 48px !important; /* 명시적 고정 크기 */
            flex: none !important; /* flex 컨테이너에서 완전히 벗어나 고정 크기 유지 */
            display: flex; /* 내부 텍스트 중앙 정렬 유지 */
            align-items: center;
            justify-content: center;
            white-space: normal; /* 텍스트 줄바꿈 허용 */
            overflow: hidden;
            word-break: break-all;
            line-height: 1.2;
            box-sizing: border-box;
        `;

        const playPauseBtn = document.createElement('button');
        playPauseBtn.setAttribute('data-action', 'play-pause');
        playPauseBtn.textContent = '재생/멈춤';
        playPauseBtn.className = 'vcp-button';
        playPauseBtn.style.cssText = buttonBaseStyle;

        const speedResetBtn = document.createElement('button');
        speedResetBtn.setAttribute('data-action', 'reset-speed');
        speedResetBtn.textContent = '배속1x';
        speedResetBtn.className = 'vcp-button';
        speedResetBtn.style.cssText = buttonBaseStyle;

        const muteBtn = document.createElement('button');
        muteBtn.setAttribute('data-action', 'mute');
        muteBtn.textContent = '무음';
        muteBtn.className = 'vcp-button';
        muteBtn.style.cssText = buttonBaseStyle;

        const speakBtn = document.createElement('button');
        speakBtn.setAttribute('data-action', 'speak');
        speakBtn.textContent = '소리';
        speakBtn.className = 'vcp-button';
        speakBtn.style.cssText = buttonBaseStyle;


        buttonSection.appendChild(playPauseBtn);
        buttonSection.appendChild(speedResetBtn);
        buttonSection.appendChild(muteBtn);
        buttonSection.appendChild(speakBtn);
        contentContainer.appendChild(buttonSection);

        popupElement.appendChild(contentContainer);
        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    // 재생/멈춤 버튼 텍스트 업데이트
    function updatePlayPauseButton() {
        const playPauseBtn = popupElement.querySelector('[data-action="play-pause"]');
        if (playPauseBtn && currentVideo) {
            playPauseBtn.textContent = currentVideo.paused ? '재생' : '멈춤';
        } else if (playPauseBtn) {
            playPauseBtn.textContent = '재생/멈춤';
        }
    }

    // 무음/소리 버튼 상태 업데이트
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

        // 팝업 내 버튼 클릭 이벤트
        popupElement.addEventListener('click', (e) => {
            const action = e.target.getAttribute('data-action');
            if (action) {
                handleButtonClick(action);
            }
            // ✅ 팝업 내부의 클릭 이벤트는 외부로 전파되지 않도록 중단
            e.stopPropagation();
        });

        // 팝업 내 슬라이더 입력 이벤트
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', (e) => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2);
            e.stopPropagation(); // 슬라이더 입력도 외부로 전파되지 않도록 중단
        });

        // 드래그 핸들 이벤트 (기존과 동일)
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
            e.stopPropagation();
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
            e.stopPropagation();
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag, { passive: false });
        document.addEventListener('mousemove', dragPopup);
        document.addEventListener('touchmove', dragPopup, { passive: false });
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isVisible) {
            const styles = {
                display: 'flex',
                opacity: '0.75',
                visibility: 'visible',
                pointerEvents: 'auto',
                zIndex: '2147483647',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
            };
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
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo) {
            hidePopup();
            return;
        }

        if (!popupElement || !currentVideo || isPopupDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, window.innerWidth - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
            popupElement.style.transform = 'none';
            popupElement.style.position = 'fixed';
        } else {
            hidePopup();
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

    function selectVideoOnDocumentClick(e) {
        // ✅ 팝업 내부를 클릭한 경우, 이 함수는 즉시 종료하고 팝업 자체의 이벤트 리스너가 처리하도록 합니다.
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer(); // 팝업 내부 상호작용 시 타이머 리셋
            return;
        }

        const clickedElement = e ? e.target : null;
        if (clickedElement) {
            const isInteractiveElement = clickedElement.tagName === 'A' ||
                                         clickedElement.tagName === 'BUTTON' ||
                                         clickedElement.tagName === 'INPUT' ||
                                         clickedElement.tagName === 'TEXTAREA' ||
                                         clickedElement.tagName === 'SELECT' ||
                                         clickedElement.closest('[onclick], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])');

            if (isInteractiveElement) {
                return;
            }
        }

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

            if (ratio >= 0.5) {
                if (!foundPlayingVideo) {
                    foundPlayingVideo = video;
                }
            }

            if (ratio > 0 && ratio > maxIntersectionRatio) {
                maxIntersectionRatio = ratio;
                bestVideo = video;
            }
        });

        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        } else if (bestVideo) {
            // Best intersection ratio video
        } else {
            // No suitable video found.
        }

        if (bestVideo && (maxIntersectionRatio > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo !== bestVideo) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                selectAndControlVideo(bestVideo);

                if (currentVideo && e instanceof Event) {
                    isManuallySelected = true;
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    isManuallySelected = false;
                    hidePopup();
                }

            } else {
                if (e) {
                    isManuallySelected = true;
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    if (popupElement && popupElement.style.display !== 'none') {
                       hidePopup();
                    }
                }
            }
        } else {
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            isManuallySelected = false;
            if (!isPopupDragging) {
                hidePopup();
            }
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
                if (!isPopupDragging) {
                    hidePopup();
                }
            }

            selectVideoOnDocumentClick(null);
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
                    foundMediaChange = true;
                    break;
                }
            }
            if (foundMediaChange) {
                updateVideoList();
                selectVideoOnDocumentClick(null);
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
                isManuallySelected = false;
                hidePopup();
                updateVideoList();
                selectVideoOnDocumentClick(null);
                updatePopupPosition();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
        ];
        overflowFixSites.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selectors.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.overflow = 'visible';
                    });
                });
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
                selectVideoOnDocumentClick(null);
            }

            if (popupElement && popupElement.style.display !== 'none' && !isPopupDragging) {
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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.61_NoAutoMute_NoSiteSpecific_NoLazySrcBlocked_Updated_FixedMobileDrag_CompactUI_VerticalSlider_Ascending_FixedOrientation_FixedPreviewClickV10_PopupClickFix');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                    // 전체화면 진입 시 팝업 및 버튼 스타일 재적용
                    // ✅ 팝업 자체의 핵심 레이아웃 속성을 다시 강하게 적용
                    popupElement.style.setProperty('position', 'fixed', 'important');
                    popupElement.style.setProperty('display', 'flex', 'important');
                    popupElement.style.setProperty('flex-direction', 'column', 'important');
                    popupElement.style.setProperty('align-items', 'center', 'important');
                    popupElement.style.setProperty('justify-content', 'center', 'important');
                    popupElement.style.setProperty('min-height', '150px', 'important');
                    popupElement.style.setProperty('width', 'fit-content', 'important');
                    popupElement.style.setProperty('max-width', 'initial', 'important');
                    popupElement.style.setProperty('max-height', 'initial', 'important');
                    popupElement.style.setProperty('flex-wrap', 'wrap', 'important');
                    popupElement.style.setProperty('gap', '6px', 'important');

                    // ✅ 버튼 스타일 재적용 (48px 고정)
                    popupElement.querySelectorAll('.vcp-button').forEach(btn => {
                        btn.style.setProperty('width', '48px', 'important');
                        btn.style.setProperty('height', '48px', 'important');
                        btn.style.setProperty('flex', 'none', 'important'); // flex 컨테이너에서 완전히 벗어나 고정 크기 유지
                    });

                    if (popupElement.querySelector('#vcp-speed')) {
                         popupElement.querySelector('#vcp-speed').style.height = 'calc(100% - 40px)';
                    }
                } else {
                    document.body.appendChild(popupElement);
                    // 전체 화면 종료 시 원래 스타일로 복원 (createPopupElement에서 설정된 기본값 사용)
                    popupElement.style.removeProperty('position'); // fixed는 그대로 유지
                    popupElement.style.removeProperty('display');
                    popupElement.style.removeProperty('flex-direction');
                    popupElement.style.removeProperty('align-items');
                    popupElement.style.removeProperty('justify-content');
                    popupElement.style.removeProperty('min-height');
                    popupElement.style.removeProperty('width');
                    popupElement.style.removeProperty('max-width');
                    popupElement.style.removeProperty('max-height');
                    popupElement.style.removeProperty('flex-wrap');
                    popupElement.style.removeProperty('gap');

                    // createPopupElement의 초기 스타일을 다시 적용하는 함수 호출
                    const initialStyles = `
                        background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
                        padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
                        display: none; opacity: 0; transition: opacity 0.3s;
                        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                        width: fit-content;
                        min-width: 180px;
                        overflow: hidden; text-align: center; pointer-events: auto;
                        max-width: 90vw;
                        max-height: 90vh;
                        display: flex;
                        flex-wrap: wrap;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                    `;
                    const tempDiv = document.createElement('div');
                    tempDiv.style.cssText = initialStyles;
                    for (const prop of Array.from(tempDiv.style)) {
                        if (prop !== 'position') { // position은 기존 값 유지 (fixed)
                            popupElement.style.setProperty(prop, tempDiv.style.getPropertyValue(prop), tempDiv.style.getPropertyPriority(prop));
                        }
                    }

                    // 버튼 초기 스타일도 다시 적용
                    popupElement.querySelectorAll('.vcp-button').forEach(btn => {
                        const baseStyle = `
                            background-color: #333; color: white; border: 1.5px solid #555;
                            padding: 8px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
                            text-align: center; font-size: 15px;
                            width: 48px !important; height: 48px !important; flex: none !important;
                            display: flex; align-items: center; justify-content: center;
                            white-space: normal; overflow: hidden; word-break: break-all;
                            line-height: 1.2; box-sizing: border-box;
                        `;
                        btn.style.cssText = baseStyle;
                    });


                    if (popupElement.querySelector('#vcp-speed')) {
                        popupElement.querySelector('#vcp-speed').style.height = '100%';
                    }
                }
                updatePopupPosition();
                resetPopupHideTimer();
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

        const handleInteraction = (e) => {
            // ✅ 팝업 내부 요소 클릭 시에는 이 전역 이벤트 리스너를 건너뛰고 팝업 자체 리스너가 처리하도록 함
            if (popupElement && e && popupElement.contains(e.target)) {
                if (popupElement.style.display !== 'none') {
                    // 팝업이 보이는 상태에서 팝업 내부를 클릭하면 드래그나 다른 동작에 영향을 주지 않도록
                    // 여기서 추가적인 처리를 하지 않고 바로 리턴합니다.
                    resetPopupHideTimer(); // 팝업 내부 클릭 시 타이머 리셋만 합니다.
                }
                return;
            }

            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoOnDocumentClick(e);
        };

        // 클릭 이벤트는 document.body에서 캡처링 단계에서 처리
        document.body.addEventListener('click', handleInteraction, true);
        document.body.addEventListener('touchend', handleInteraction, true);

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
