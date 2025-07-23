// ==UserScript==
// @name Video Controller Popup (V4.11.15_FinalFix_UserUI: 사용자 요청 UI 적용, 전체화면 iframe 팝업 최종 복구)
// @namespace Violentmonkey Scripts
// @version 4.11.15_FinalFix_UserUI_FullscreenIframeFix_AutoplayAttemptImprovement
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider at top.
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
        const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || currentVideo.tagName === 'AUDIO' || !currentVideo.paused;
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO';

        // 현재 풀스크린 상태를 고려하여 가시성
        const isFullScreenAndInView = document.fullscreenElement && (
            document.fullscreenElement === currentVideo ||
            document.fullscreenElement.contains(currentVideo)
        );

        const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);

        return isVisible && isReasonableSize && hasMedia && document.body.contains(currentVideo) && (isWithinViewport || isFullScreenAndInView);
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        if (currentVideo && currentVideo !== videoToControl && originalPlayMethods.has(currentVideo)) {
            currentVideo.play = originalPlayMethods.get(currentVideo);
            originalPlayMethods.delete(currentVideo);
        }

        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
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
            } else {
                if (currentVideo !== videoToControl) {
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;
                    videoToControl.muted = false; // 무조건 음소거 해제
                    videoToControl.volume = 1.0; // 볼륨 100%
                    console.log('[VCP] Video selected. Initiating autoplay with sound (100%).');

                    videoToControl.play().catch(e => {
                        // console.warn("Autoplay/Play on select failed:", e);
                    });
                }
            }
        });

        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false;
            desiredPlaybackRate = currentVideo.playbackRate;
            desiredVolume = 1.0;
            isManuallyMuted = false;
        }

        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume);

        updatePopupSliders();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
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

    // --- Popup UI Functions (사용자 요청 UI - 가로형 속도바, 하단 4버튼) ---
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
            width: 250px; /* 고정된 너비로 설정하여 가로 슬라이더 공간 확보 */
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
            flex-direction: column; /* 세로로 정렬: 슬라이더 위, 버튼 아래 */
            padding: 10px;
            gap: 10px; /* 슬라이더와 버튼 사이 간격 */
        `;

        // 속도 조절 섹션 (가로 슬라이더)
        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.cssText = `
            display: flex;
            align-items: center; /* 세로 중앙 정렬 */
            justify-content: space-between; /* 슬라이더와 숫자 분리 */
            width: 100%; /* 부모 너비에 맞춤 */
            gap: 8px;
            box-sizing: border-box;
        `;

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            flex-grow: 1; /* 남은 공간을 차지하여 길게 늘어남 */
            height: 10px; /* 슬라이더 높이 */
            -webkit-appearance: none; /* 기본 스타일 제거 */
            appearance: none;
            background: #555;
            outline: none;
            border-radius: 5px;
            cursor: pointer;
        `;
        // 슬라이더 썸 스타일 (크롬, 엣지)
        speedInput.style.setProperty('::-webkit-slider-thumb', `
            -webkit-appearance: none;
            appearance: none;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #007bff;
            cursor: grab;
            border: 2px solid #fff;
        `);
        // 슬라이더 썸 스타일 (파이어폭스)
        speedInput.style.setProperty('::-moz-range-thumb', `
            width: 18px;
            height: 18px;
            border-radius: 50%;
            background: #007bff;
            cursor: grab;
            border: 2px solid #fff;
        `);

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedDisplay.style.cssText = 'color: #eee; font-size: 1em; font-weight: bold; width: 45px; text-align: right;'; // 숫자 표시

        speedSection.appendChild(speedInput);
        speedSection.appendChild(speedDisplay);
        contentContainer.appendChild(speedSection);

        // 버튼 섹션 (2x2 그리드)
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr; /* 2열 */
            grid-template-rows: 1fr 1fr; /* 2행 */
            gap: 8px; /* 버튼 간격 조정 */
            width: 100%; /* 부모 너비에 맞춤 */
            box-sizing: border-box;
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: nowrap;
            text-align: center; font-size: 15px;
            height: 45px; /* 버튼 높이 고정 */
            display: flex; align-items: center; justify-content: center; /* 텍스트 중앙 정렬 */
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
        document.addEventListener('touchmove', dragPopup, { passive: false });
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isVisible) {
            const styles = { display: 'block', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
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

        if (isVideoVisible || document.fullscreenElement) {
            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            if (document.fullscreenElement) {
                const fsRect = document.fullscreenElement.getBoundingClientRect();
                adjustedX = Math.max(fsRect.left, Math.min(adjustedX, fsRect.right - popupRect.width));
                adjustedY = Math.max(fsRect.top, Math.min(adjustedY, fsRect.bottom - popupRect.height));
            } else {
                adjustedX = Math.max(0, Math.min(adjustedX, window.innerWidth - popupRect.width));
                adjustedY = Math.max(0, Math.min(adjustedY, window.innerHeight - popupRect.height));
            }

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
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            if (popupElement.style.display !== 'none') {
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
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    hidePopup();
                }

            } else {
                if (e) {
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
                hidePopup();
                updateVideoList();
                selectVideoOnDocumentClick(null);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.15_FinalFix_UserUI_FullscreenIframeFix_AutoplayAttemptImprovement');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                    updatePopupPosition();
                    resetPopupHideTimer();
                } else {
                    document.body.appendChild(popupElement);
                    updatePopupPosition();
                    resetPopupHideTimer();
                }
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders();
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
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoOnDocumentClick(e);
        }, true);

        document.body.addEventListener('touchend', (e) => {
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoOnDocumentClick(e);
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
