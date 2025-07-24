// ==UserScript==
// @name Video Controller Popup (V4.11.24: Click／Touchend 통합)
// @namespace Violentmonkey Scripts
// @version 4.11.24_NoForcedControl_NoPlayPauseBtn_HorizontalBtns_EnhancedSPADetection_PassiveScroll_NoAutoPopup_HideOnVideoChange_EnhancedScrollHide_OptimizedScrollMove_FullscreenOptimized_ClickTouchendIntegrated
// @description Core video controls with streamlined UI. NO FORCED AUTOPLAY, PAUSE, or MUTE. Popup shows ONLY on click. Features dynamic 1x speed reset, Mute, and Speak buttons on a single row. Enhanced SPA handling with History API interception. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Uses IntersectionObserver for efficient video visibility detection. Restores popup position after fullscreen exit. Includes passive scroll event listener for smoother performance. Enhanced: Popup hides on scroll/touch if currentVideo is out of view. Optimized: onUserScrollOrTouchMove performance. Optimized: Fullscreen transition handling. Optimized: Click/Touchend event handling.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyMuted = false;
    let isPopupVisible = false;
    let popupPrevPosition = null;
    let rafId = null;
    let videoObserver = null;
    let observedVideosData = new Map();
    let lastPopupPosition = { left: -9999, top: -9999 };

    const videoRateHandlers = new WeakMap();

    // Configuration
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300;

    let domMutationObserverInstance = null;
    let spaDetectionObserverInstance = null;

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        let videos = Array.from(root.querySelectorAll('video, audio'));
        return videos;
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 250 && rect.height >= 250);
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
            return isVisible && isReasonableSize && hasMedia && isWithinViewport;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) {
                hidePopup();
            }
            currentVideo = null;
            return;
        }

        if (currentVideo !== videoToControl) {
            hidePopup();
            currentVideo = videoToControl;

            isManuallyMuted = currentVideo.muted;
            desiredPlaybackRate = currentVideo.playbackRate;
            desiredVolume = currentVideo.volume;
        }

        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume);

        updatePopupSliders();
        updateMuteSpeakButtons();
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };
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
    function createPopupUI() {
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
            display: flex;
            flex-direction: row;
            justify-content: space-around;
            align-items: center;
            gap: 10px;
            padding: 10px;
            flex-grow: 1;
            min-height: 50px;
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: normal;
            text-align: center; font-size: 14px;
            height: auto;
            min-height: 40px;
            flex-basis: 0;
            flex-grow: 1;
            max-width: 100px;
            display: flex;
            justify-content: center;
            align-items: center;
            box-sizing: border-box;
            line-height: 1.2;
        `;

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

        buttonSection.appendChild(speedResetBtn);
        buttonSection.appendChild(muteBtn);
        buttonSection.appendChild(speakBtn);
        popupElement.appendChild(buttonSection);

        document.body.appendChild(popupElement);
        // setupPopupEventListeners()는 이제 별도의 함수로 분리됨.
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

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        if (speedInput) {
            speedInput.value = desiredPlaybackRate.toFixed(1);
        }
        if (speedDisplay) {
            speedDisplay.textContent = desiredPlaybackRate.toFixed(2) + 'x';
        }
    }

    function handleButtonClick(action) {
        if (!currentVideo) { return; }
        resetPopupHideTimer();

        switch (action) {
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
            document.body.style.userSelect = 'none';
        };

        const stopDrag = () => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                resetPopupHideTimer();
                lastPopupPosition = { left: -9999, top: -9999 };
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;

            const isFullscreen = document.fullscreenElement !== null;
            let targetLeft, targetTop;

            if (isFullscreen) {
                const fsRect = document.fullscreenElement.getBoundingClientRect();
                targetLeft = (clientX - popupDragOffsetX) - fsRect.left;
                targetTop = (clientY - popupDragOffsetY) - fsRect.top;
            } else {
                targetLeft = clientX - popupDragOffsetX;
                targetTop = clientY - popupDragOffsetY;
            }

            popupElement.style.left = `${targetLeft}px`;
            popupElement.style.top = `${targetTop}px`;

            lastPopupPosition.left = targetLeft;
            lastPopupPosition.top = targetTop;
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
            resetPopupHideTimer();
            startVideoStatusLoop();
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            isPopupVisible = false;
            stopVideoStatusLoop();
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            return;
        }

        setPopupVisibility(true);
        lastPopupPosition = { left: -9999, top: -9999 };
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

    // --- IntersectionObserver 관련 함수 ---
    function setupIntersectionObserver() {
        const observerOptions = {
            root: null,
            rootMargin: '0px',
            threshold: [0.3, 0.5, 0.7, 1.0]
        };

        const observerCallback = (entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                if (entry.isIntersecting) {
                    observedVideosData.set(video, {
                        intersectionRatio: entry.intersectionRatio,
                        timestamp: Date.now()
                    });
                } else {
                    observedVideosData.delete(video);
                }
            });
            selectVideoLogic();
        };

        videoObserver = new IntersectionObserver(observerCallback, observerOptions);
        updateVideoList(); // Initial video scan
    }

    function updateVideoList() {
        const currentPlayableVideos = findPlayableVideos();

        observedVideosData.forEach((value, video) => {
            if (!currentPlayableVideos.includes(video)) {
                if (videoObserver) {
                    videoObserver.unobserve(video);
                    observedVideosData.delete(video);
                }
            }
        });

        currentPlayableVideos.forEach(video => {
            if (videoObserver && !observedVideosData.has(video)) {
                videoObserver.observe(video);
                observedVideosData.set(video, { intersectionRatio: 0, timestamp: Date.now() });
            }
        });

        if (currentVideo && (!document.body.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            currentVideo = null;
            hidePopup();
        }
    }

    // --- 비디오 우선순위 점수 계산 함수 (새로운 로직 적용) ---
    function calculateVideoScore(video) {
        const rect = video.getBoundingClientRect();
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

        const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);
        const centerScore = 1 / Math.pow(1 + centerDist, 5);

        const score = visibleArea * 0.7 + centerScore * 5000 * 0.3;

        return score;
    }

    // --- 교차 비율을 계산하는 별도 함수 (기존 intersectionRatio와는 다르게, 전체 면적 대비 가시 면적 비율) ---
    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return 0;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
        const totalArea = rect.width * rect.height;

        return totalArea > 0 ? visibleArea / totalArea : 0;
    }

    // --- 개선된 selectVideoLogic 함수 ---
    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => data.intersectionRatio > 0)
            .map(([video, data]) => ({
                video,
                score: calculateVideoScore(video),
                intersectionRatio: calculateIntersectionRatio(video)
            }))
            .sort((a, b) => b.score - a.score);

        let activeVideo = null;

        if (candidateVideos.length > 0) {
            activeVideo = candidateVideos[0].video;
        }

        if (activeVideo) {
            selectAndControlVideo(activeVideo);

            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
            currentVideo = null;
            hidePopup();
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            if (currentVideo && (!document.body.contains(currentVideo) || !observedVideosData.has(currentVideo) || observedVideosData.get(currentVideo).intersectionRatio === 0)) {
                currentVideo = null;
                hidePopup();
            }
            selectVideoLogic();
        }, 100);
    }

    // --- onUserScrollOrTouchMove() 최적화 적용 ---
    let hideCheckTimer = null;
    let lastHideCheckTime = 0;
    const HIDE_DEBOUNCE_MS = 200;

    function onUserScrollOrTouchMove() {
        if (!isPopupVisible || isPopupDragging) return;

        const now = Date.now();
        if (now - lastHideCheckTime < HIDE_DEBOUNCE_MS) {
            return;
        }
        lastHideCheckTime = now;

        if (hideCheckTimer) clearTimeout(hideCheckTimer);
        hideCheckTimer = setTimeout(() => {
            if (!currentVideo) {
                hidePopup();
                return;
            }
            const rect = currentVideo.getBoundingClientRect();
            const isVisible = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;

            if (!isVisible) {
                hidePopup();
            }
        }, HIDE_DEBOUNCE_MS);
    }
    // --- onUserScrollOrTouchMove() 최적화 적용 끝 ---

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

    // --- SPA URL 변경 탐지 함수 (MutationObserver 방식) ---
    function setupSPADetection() {
        let lastUrl = location.href;

        const handleSpaUrlChange = (newUrl) => {
            console.log(`[VCP] SPA URL 변경 감지 콜백: ${newUrl} - 비디오 상태 초기화`);
            currentVideo = null;
            hidePopup();
            updateVideoList();
            selectVideoLogic();
        };

        spaDetectionObserverInstance = new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP][SPA-MO] URL 변경 감지: ${lastUrl} -> ${currentUrl}`);
                lastUrl = currentUrl;
                handleSpaUrlChange(currentUrl);
            }
        });

        spaDetectionObserverInstance.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });

        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            checkUrlChangeForHistoryAPI();
        };

        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            checkUrlChangeForHistoryAPI();
        };

        const checkUrlChangeForHistoryAPI = () => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP][SPA-History] URL 변경 감지: ${lastUrl} -> ${currentUrl}`);
                lastUrl = currentUrl;
                handleSpaUrlChange(currentUrl);
            }
        };

        window.addEventListener('popstate', checkUrlChangeForHistoryAPI);
    }

    function fixOverflow() {
        // This function currently does not enforce any style changes.
    }

    // --- requestAnimationFrame 기반 비디오 상태 루프 (최적화 적용) ---
    function videoStatusLoop() {
        if (!currentVideo || !document.body.contains(currentVideo)) {
            currentVideo = null;
            hidePopup();
            stopVideoStatusLoop();
            return;
        }

        if (currentVideo.playbackRate !== desiredPlaybackRate) {
            currentVideo.playbackRate = desiredPlaybackRate;
        }
        if (currentVideo.muted !== isManuallyMuted) {
            currentVideo.muted = isManuallyMuted;
        }
        if (!currentVideo.muted && Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
            currentVideo.volume = desiredVolume;
        }

        if (popupElement && isPopupVisible && !isPopupDragging) {
            updateMuteSpeakButtons();
            updatePopupSliders();

            const videoRect = currentVideo.getBoundingClientRect();
            const popupWidth = popupElement.offsetWidth || 280;
            const popupHeight = popupElement.offsetHeight || 150;

            let targetX = videoRect.left + (videoRect.width / 2) - (popupWidth / 2);
            let targetY = videoRect.top + (videoRect.height / 2) - (popupHeight / 2);

            targetX = Math.max(0, Math.min(targetX, window.innerWidth - popupWidth));
            targetY = Math.max(0, Math.min(targetY, window.innerHeight - popupHeight));

            const isFullscreen = document.fullscreenElement !== null;
            let actualTargetLeft, actualTargetTop;

            if (isFullscreen) {
                const fsRect = document.fullscreenElement.getBoundingClientRect();
                actualTargetLeft = targetX - fsRect.left;
                actualTargetTop = targetY - fsRect.top;
            } else {
                actualTargetLeft = targetX;
                actualTargetTop = targetY;
            }

            const delta = Math.abs(actualTargetLeft - lastPopupPosition.left) + Math.abs(actualTargetTop - lastPopupPosition.top);
            if (delta > 1 || lastPopupPosition.left === -9999) {
                lastPopupPosition.left = actualTargetLeft;
                lastPopupPosition.top = actualTargetTop;

                popupElement.style.left = `${actualTargetLeft}px`;
                popupElement.style.top = `${actualTargetTop}px`;
            }

            const isVideoVisibleInViewport = videoRect.bottom > 0 && videoRect.top < window.innerHeight && videoRect.right > 0 && videoRect.left < window.innerWidth;
            if (!isVideoVisibleInViewport) {
                hidePopup();
            }
        }

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

    // --- Fullscreen 스타일 관리 함수 ---
    function setPopupFullscreenStyles(isFullscreen) {
        if (!popupElement) return;
        if (isFullscreen) {
            popupElement.style.cssText = `
                width: 280px;
                min-width: 280px;
                height: auto;
                min-height: 150px;
                position: absolute;
                transform: none;
                background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
                padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                overflow: hidden; text-align: center; pointer-events: auto;
                display: flex;
                flex-direction: column;
                align-items: stretch;
            `;
        } else {
            popupElement.style.cssText = `
                width: fit-content;
                min-width: 280px;
                height: auto;
                min-height: 150px;
                position: fixed;
                transform: none;
                background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
                padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
                overflow: hidden; text-align: center; pointer-events: auto;
                display: flex;
                flex-direction: column;
                align-items: stretch;
            `;
        }
    }

    // --- Global Event Listener Functions ---
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    const TOUCH_MOVE_THRESHOLD = 10;

    function handleUserTouchStart(e) {
        touchStartX = e.touches ? e.touches.item(0).clientX : e.clientX;
        touchStartY = e.touches ? e.touches.item(0).clientY : e.clientY;
        touchMoved = false;
    }

    function handleUserTouchMove(e) {
        if (!e.touches) return;
        const touch = e.touches.item(0);
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
            touchMoved = true;
            onUserScrollOrTouchMove();
        }
    }

    function handleUserClickOrTouch(e) {
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
        const isClickable = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickable) return;

        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }

        selectVideoLogic(e);
    }

    function setupGlobalEventListeners() {
        document.body.addEventListener('click', handleUserClickOrTouch, true);
        document.body.addEventListener('touchend', handleUserClickOrTouch, true);
        document.addEventListener('touchstart', handleUserTouchStart, { passive: true });
        document.addEventListener('touchmove', handleUserTouchMove, { passive: true }); // passive true로 변경
        window.addEventListener('scroll', onUserScrollOrTouchMove, { passive: true });
        window.addEventListener('touchmove', onUserScrollOrTouchMove, { passive: true });
        window.addEventListener('scroll', handleScrollEvent, { passive: true });
        window.addEventListener('resize', () => {
            lastPopupPosition = { left: -9999, top: -9999 };
        });
    }

    function setupObservers() {
        domMutationObserverInstance = setupDebouncedDOMObserver(() => {
            console.log('[VCP] DOM 변경 감지 (데바운스) - 비디오 목록 갱신');
            updateVideoList();
            selectVideoLogic();
        }, DEBOUNCE_MUTATION_OBSERVER_MS);
        setupIntersectionObserver();
    }

    function setupFullscreenHandling() {
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    popupPrevPosition = {
                        left: popupElement.style.left,
                        top: popupElement.style.top,
                    };
                    fsEl.appendChild(popupElement);
                    setPopupFullscreenStyles(true);

                    lastPopupPosition = { left: -9999, top: -9999 };
                    showPopup();
                    console.log('[VCP] Fullscreen entered. Popup moved to fullscreen element.');
                } else {
                    document.body.appendChild(popupElement);
                    if (popupPrevPosition) {
                        popupElement.style.left = popupPrevPosition.left;
                        popupElement.style.top = popupPrevPosition.top;
                        console.log('[VCP] Restored popup position to:', popupPrevPosition.left, popupPrevPosition.top);
                    } else {
                        lastPopupPosition = { left: -9999, top: -9999 };
                    }
                    setPopupFullscreenStyles(false);

                    hidePopup();
                    console.log('[VCP] Fullscreen exited. Popup hidden immediately and restored to body.');
                }
            }
        });
    }

    function cleanupOnUnload() {
        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and stopping loops.');
            currentVideo = null;
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

    // --- Main Initialization Function ---
    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.24_Refactored.');

        createPopupUI();
        setupPopupEventListeners(); // 팝업 내부 UI 이벤트 리스너
        setupGlobalEventListeners(); // 전역 이벤트 리스너 (클릭, 스크롤, 리사이즈 등)
        setupObservers(); // DOM, Intersection Observer
        setupSPADetection(); // SPA URL 변경 감지
        setupFullscreenHandling(); // 전체 화면 이벤트
        cleanupOnUnload(); // 언로드 시 정리

        // 초기 상태 설정 및 팝업 숨기기
        hidePopup();
        selectVideoLogic(); // 초기 비디오 선택
        fixOverflow(); // 필요하다면 overflow 처리
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
