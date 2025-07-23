// ==UserScript==
// @name Video Controller Popup (V4.11.14: 자동재생 개선, 모바일 전체화면 클릭/위치 픽스, 성능 최적화)
// @namespace Violentmonkey Scripts
// @version 4.11.14_AutoplayAttemptImprovement_MobileFullScreenClickFix_Debounce_FS_Pos_Restore_RAF_Opt
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Restores popup position after fullscreen exit.
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
    let popupPrevPosition = null; // 전체 화면 진입 전 팝업의 위치를 저장
    let rafId = null; // requestAnimationFrame ID 저장 변수 (새로 추가)

    const videoRateHandlers = new WeakMap();
    const originalPlayMethods = new WeakMap(); // 원본 play() 메서드를 저장

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300; // MutationObserver 디바운스 시간 (300ms)

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

        const fsEl = document.fullscreenElement;
        if (fsEl) {
            if (!fsEl.contains(currentVideo)) {
                return false;
            }
        }
        return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
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

                    videoToControl.muted = false;
                    videoToControl.volume = 1.0;
                    isManuallyMuted = false;

                    videoToControl.play().catch(e => {
                        console.warn("[VCP] Autoplay with sound failed:", e.name, e.message, "Attempting muted autoplay.");
                        videoToControl.muted = true;
                        videoToControl.volume = 0;
                        isManuallyMuted = true;
                        videoToControl.play().catch(mutedError => {
                            console.error("[VCP] Muted autoplay also failed:", mutedError.name, mutedError.message);
                        });
                    });
                }
            }
        });

        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false;
            desiredPlaybackRate = currentVideo.playbackRate;

            desiredVolume = currentVideo.volume;
            isManuallyMuted = currentVideo.muted;
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
            speedDisplay.textContent = rate.toFixed(2) + 'x';
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            if (e.target !== dragHandle) return;
            resetPopupHideTimer();
            isPopupDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
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
            const styles = { display: 'flex', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
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
        if (!isPopupDragging && isPopupVisible) {
            popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    function updatePopupPosition() {
        if (!currentVideo || !popupElement || isPopupDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        let popupRect = popupElement.getBoundingClientRect();

        const fsEl = document.fullscreenElement;

        if (fsEl) {
            popupElement.style.width = '280px';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'absolute';
            popupElement.style.transform = 'none';

            popupRect = popupElement.getBoundingClientRect();

            const fsRect = fsEl.getBoundingClientRect();

            let targetX = videoRect.left - fsRect.left + (videoRect.width / 2);
            let targetY = videoRect.top - fsRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, fsRect.width - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, fsRect.height - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;

        } else {
            popupElement.style.width = 'fit-content';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'fixed';
            popupElement.style.transform = 'none';

            popupRect = popupElement.getBoundingClientRect();

            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = Math.max(0, Math.min(targetY - (popupRect.height / 2), window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
        }

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;
        if (!isVideoVisible) {
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
            speedDisplay.textContent = rate.toFixed(2) + 'x';
            desiredPlaybackRate = rate;
        }
    }

    function selectVideoLogic(e) {
        updateVideoList();

        let activeVideo = null;
        if (currentVideo && document.body.contains(currentVideo)) {
            activeVideo = currentVideo;
        } else {
            const centerY = window.innerHeight / 2;
            const centerX = window.innerWidth / 2;

            const sorted = videos
            .map(v => {
                const rect = v.getBoundingClientRect();
                const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
                const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
                const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
                const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);

                const centerScore = 1 / Math.pow(1 + centerDist, 5);

                const isPlayingScore = (!v.paused && v.duration > 0 && !v.ended) ? 10000 : 0;

                const score = visibleArea * 0.7 + centerScore * 5000 * 0.3 + isPlayingScore;

                return { video: v, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

            activeVideo = sorted[0]?.video || null;
        }

        if (activeVideo) {
            if (currentVideo !== activeVideo) {
                if (currentVideo) currentVideo.pause();
                selectAndControlVideo(activeVideo);
            }

            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
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

            if (currentVideo && (!checkCurrentVideoVisibility() || !document.body.contains(currentVideo))) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }

            selectVideoLogic(null);
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

    // --- MutationObserver Debounce 로직 적용 ---
    let domMutationTimer = null;
    function setupDOMObserver() {
        const observerConfig = { childList: true, subtree: true, attributes: true };
        const observerCallback = (mutationsList) => {
            let foundMediaChange = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList' && (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'))) {
                    foundMediaChange = true;
                    break;
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    if (mutation.attributeName === 'src' || mutation.attributeName === 'controls' || mutation.attributeName === 'style') {
                        foundMediaChange = true;
                        break;
                    }
                }
            }
            if (foundMediaChange) {
                if (domMutationTimer) clearTimeout(domMutationTimer);
                domMutationTimer = setTimeout(() => {
                    console.log('[VCP] DOM change detected and debounced. Re-scanning videos.');
                    updateVideoList();
                    selectVideoLogic(null);
                    domMutationTimer = null;
                }, DEBOUNCE_MUTATION_OBSERVER_MS);
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
                        el.style.setProperty('overflow', 'visible', 'important');
                    });
                });
            }
        });
    }

    // --- requestAnimationFrame 기반 비디오 상태 루프 (새로 변경) ---
    function videoStatusLoop() {
        // 현재 제어할 비디오가 없으면 루프를 일시 중지
        if (!currentVideo && !isPopupVisible) {
            stopVideoStatusLoop();
            return;
        }

        // 1. 현재 비디오 상태 점검 및 설정 유지
        if (currentVideo && !currentVideo.paused && !currentVideo.ended) {
            if (currentVideo.playbackRate !== desiredPlaybackRate) {
                currentVideo.playbackRate = desiredPlaybackRate;
            }
            // 부동 소수점 오차를 고려하여 볼륨 비교 (정확도를 높임)
            if (Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
                currentVideo.volume = desiredVolume;
            }
            if (currentVideo.muted !== isManuallyMuted) {
                currentVideo.muted = isManuallyMuted;
            }
        } else if (currentVideo && currentVideo.paused && !currentVideo.ended && !isManuallyPaused) {
            // 사용자가 직접 정지하지 않았는데 비디오가 정지되어 있다면, 재생 시도
            currentVideo.play().catch(e => {
                //console.warn("[VCP] Autoplay attempt failed in RAF loop (might be blocked by browser):", e.name);
            });
        }

        // 2. 다른 영상은 정지 및 음소거
        findAllVideosDeep().forEach(video => {
            if (video !== currentVideo) {
                if (!video.paused) {
                    video.pause();
                }
                if (!video.muted || video.volume > 0) { // 이미 음소거되어 있고 볼륨 0이면 불필요한 설정 방지
                    video.muted = true;
                    video.volume = 0;
                }
            }
        });

        // 3. 팝업이 보일 때만 팝업 관련 UI 업데이트 및 위치 조정
        if (popupElement && isPopupVisible && !isPopupDragging) {
            updatePopupPosition();
            updatePlayPauseButton();
            updateMuteSpeakButtons();
            updatePopupSliders();
        }

        // 다음 프레임 요청
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
            console.log('[VCP] Video status loop stopped.');
        }
    }
    // --- requestAnimationFrame 기반 비디오 상태 루프 끝 ---

    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 최종 픽스 로직 시작 ---
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    const TOUCH_MOVE_THRESHOLD = 10;

    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        const deltaX = Math.abs(e.touches[0].clientX - touchStartX);
        const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
        if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
            touchMoved = true;
        }
    }, { passive: true });

    document.body.addEventListener('click', (e) => {
        if (!e) return;

        if (popupElement && isPopupVisible && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        if (touchMoved) {
            touchMoved = false;
            return;
        }

        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) {
            return;
        }

        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }

        selectVideoLogic(e);
    }, true);

    document.body.addEventListener('touchend', (e) => {
        if (!e) return;

        if (popupElement && isPopupVisible && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        if (touchMoved) {
            touchMoved = false;
            return;
        }

        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) {
            return;
        }

        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }

        selectVideoLogic(e);
    }, true);
    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 최종 픽스 로직 끝 ---


    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.14_AutoplayAttemptImprovement_MobileFullScreenClickFix_Debounce_FS_Pos_Restore_RAF_Opt');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    // 전체화면 진입: 현재 팝업 위치를 기억
                    popupPrevPosition = {
                        left: popupElement.style.left,
                        top: popupElement.style.top,
                    };
                    fsEl.appendChild(popupElement);
                    // 풀스크린 모드에서 팝업의 고정 크기 및 위치 조정
                    popupElement.style.width = '280px';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'absolute';
                    popupElement.style.transform = 'none';

                    updatePopupPosition(); // 새 위치에 맞게 다시 계산
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    // 전체화면 종료: 다시 body로 옮기고 이전 위치 복원
                    document.body.appendChild(popupElement);
                    if (popupPrevPosition) {
                        popupElement.style.left = popupPrevPosition.left;
                        popupElement.style.top = popupPrevPosition.top;
                        console.log('[VCP] Restored popup position to:', popupPrevPosition.left, popupPrevPosition.top);
                    } else {
                        // 저장된 위치가 없으면 현재 뷰포트에 맞게 기본 중앙 위치로 업데이트
                        updatePopupPosition();
                    }
                    // 일반 모드에서 팝업의 유동적인 크기 (최소 너비만 유지)
                    popupElement.style.width = 'fit-content';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'fixed';
                    popupElement.style.transform = 'none';

                    hidePopup(); // 전체화면 종료 시에는 일단 팝업 숨김
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

        startVideoStatusLoop(); // requestAnimationFrame 기반 루프 시작

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            stopVideoStatusLoop(); // 페이지 종료 시 루프 중지
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
