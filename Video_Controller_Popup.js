// ==UserScript==
// @name Video Controller Popup (V4.11.24_EnhancedMediaDetection_FullscreenFix_DeepScan_RevertFS_FixRefError_RetryInit)
// @namespace Violentmonkey Scripts
// @version 4.11.24_NoForcedControl_NoPlayPauseBtn_HorizontalBtns_EnhancedSPADetection_PassiveScroll_NoAutoPopup_HideOnVideoChange_EnhancedScrollHide_OptimizedScrollMove_FullscreenOptimized_ClickTouchendIntegrated_RAF_Optimized_ThrottledDrag_SPAOptimized_VideoStatusOptimized_VisibilityControl_PopupInView_EnhancedMediaDetection_FullscreenFix_DeepScan_RevertFS_FixClickFS_FixRefError_RetryInit
// @description Core video controls with streamlined UI. NO FORCED AUTOPLAY, PAUSE, or MUTE. Popup shows ONLY on click. Features dynamic 1x speed reset, Mute, and Speak buttons on a single row. Enhanced SPA handling with History API interception. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Uses IntersectionObserver for efficient video visibility detection. Restores popup position after fullscreen exit. Includes passive scroll event listener for smoother performance. Enhanced: Popup hides on scroll/touch if currentVideo is out of view. Optimized: onUserScrollOrTouchMove performance. Optimized: Fullscreen transition handling. Optimized: Click/Touchend Integrated. Optimized: requestAnimationFrame loop for precise UI updates. Optimized: Throttled drag for smoother popup movement. Optimized: SPA handling for same URL/delayed video loads. Optimized: Video status update frequency. Optimized: Auto-pause/resume of RAF loop on tab visibility. Added: Auto-reposition popup if out of view. Enhanced: Detects hidden/background media using advanced techniques. Fixed: Popup visibility in fullscreen (Reverted to old method + CSS/Event Listener fix). Fixed: ReferenceError on setupGlobalEventListeners. Added: Retry initialization for delayed media.
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
    let rafId = null;
    let videoObserver = null;
    let observedVideosData = new Map();
    let lastPopupPosition = { left: -9999, top: -9999 };
    let lastUpdatedPlaybackRate = null;

    // 비디오 상태 캐시
    const videoStateCache = new WeakMap();
    const videoRateHandlers = new WeakMap();

    // Configuration
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300;
    const DETECT_HIDDEN_MEDIA = true;

    let domMutationObserverInstance = null;
    let spaDetectionObserverInstance = null;
    let manualVideoElements = new Set();

    // --- Utility Functions ---

    function throttle(func, delay) {
        let lastCall = 0;
        let timeoutId = null;

        return function(...args) {
            const now = Date.now();
            if (now - lastCall < delay) {
                if (!timeoutId) {
                    timeoutId = setTimeout(() => {
                        lastCall = Date.now();
                        timeoutId = null;
                        func.apply(this, args);
                    }, delay - (now - lastCall));
                }
                return;
            }

            lastCall = now;
            clearTimeout(timeoutId);
            timeoutId = null;
            func.apply(this, args);
        };
    }

    function hackAttachShadow() {
        if (window._hasHackAttachShadow_) return;
        try {
            window._shadowDomList_ = window._shadowDomList_ || [];
            if (window.Element && window.Element.prototype && window.Element.prototype.attachShadow) {
                 window.Element.prototype._originalAttachShadow = window.Element.prototype.attachShadow;

                window.Element.prototype.attachShadow = function() {
                    const arg = arguments;
                    if (arg[0] && arg[0].mode) {
                        arg[0].mode = 'open';
                    }
                    const shadowRoot = this._originalAttachShadow.apply(this, arg);
                    window._shadowDomList_.push(shadowRoot);

                    setTimeout(() => {
                         shadowRoot.querySelectorAll('video, audio').forEach(v => {
                             if (!manualVideoElements.has(v)) {
                                 manualVideoElements.add(v);
                                 console.log('[VCP] Discovered media in new ShadowRoot:', v);
                                 instrumentMediaElement(v);
                             }
                         });
                         // Shadow DOM 내부 비디오 추가 시에도 즉시 비디오 목록 업데이트 및 선택 시도
                         updateVideoList();
                         selectVideoLogic();
                    }, 0);

                    return shadowRoot;
                };
                window._hasHackAttachShadow_ = true;
                console.log('[VCP] Shadow DOM hack applied.');
            }
        } catch (e) {
            console.error('[VCP] hackAttachShadow error:', e);
        }
    }

    function instrumentMediaElement(mediaElement) {
        if (!mediaElement || mediaElement._vcp_instrumented) return;
        mediaElement._vcp_instrumented = true;

        const proto = HTMLMediaElement.prototype;

        ['playbackRate', 'volume', 'currentTime', 'src'].forEach(prop => {
            const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
            if (descriptor && (descriptor.get || descriptor.set)) {
                Object.defineProperty(mediaElement, prop, {
                    configurable: true,
                    enumerable: descriptor.enumerable,
                    get: function() {
                        const val = descriptor.get.apply(this, arguments);
                        if (!manualVideoElements.has(this) && (this.tagName === 'VIDEO' || this.tagName === 'AUDIO')) {
                            manualVideoElements.add(this);
                            console.log(`[VCP] Discovered media via ${prop} get:`, this);
                            updateVideoList(); // 발견 즉시 업데이트
                        }
                        return val;
                    },
                    set: function(value) {
                        if (!manualVideoElements.has(this) && (this.tagName === 'VIDEO' || this.tagName === 'AUDIO')) {
                             manualVideoElements.add(this);
                             console.log(`[VCP] Discovered media via ${prop} set:`, this);
                             updateVideoList(); // 발견 즉시 업데이트
                        }
                        return descriptor.set.apply(this, arguments);
                    }
                });
            }
        });

        ['play', 'pause', 'load'].forEach(methodName => {
            const originalMethod = mediaElement[methodName];
            if (typeof originalMethod === 'function') {
                mediaElement[methodName] = function() {
                    if (!manualVideoElements.has(this) && (this.tagName === 'VIDEO' || this.tagName === 'AUDIO')) {
                        manualVideoElements.add(this);
                        console.log(`[VCP] Discovered media via ${methodName} call:`, this);
                        updateVideoList(); // 발견 즉시 업데이트
                    }
                    return originalMethod.apply(this, arguments);
                };
            }
        });
        console.log('[VCP] Media element instrumented:', mediaElement);
    }

    function findAllVideosDeep(root = document) {
        let videos = Array.from(root.querySelectorAll('video, audio'));
        manualVideoElements.forEach(v => {
            if (!videos.includes(v) && document.body.contains(v)) {
                videos.push(v);
            }
        });
        if (window._shadowDomList_) {
            window._shadowDomList_.forEach(shadowRoot => {
                Array.from(shadowRoot.querySelectorAll('video, audio')).forEach(v => {
                    if (!videos.includes(v)) {
                        videos.push(v);
                        instrumentMediaElement(v);
                    }
                });
            });
        }
        return videos;
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const rect = v.getBoundingClientRect();
            const isMediaTag = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';

            const isReasonableSize = (v.tagName === 'AUDIO') ||
                                     ((rect.width >= 1 && rect.height >= 1) || (v.videoWidth > 0 || v.videoHeight > 0));

            const isVisuallyHiddenByCSS = style.display === 'none' || style.visibility === 'hidden' || style.opacity === 0;
            const isAudible = !v.muted && v.volume > 0 && !v.paused && v.src && v.duration > 0 && !isNaN(v.duration);

            let passesVisibilityCheck = !isVisuallyHiddenByCSS;

            if (DETECT_HIDDEN_MEDIA && isAudible) {
                passesVisibilityCheck = true;
            }

            let isWithinViewport = (rect.bottom > 0 && rect.top < window.innerHeight &&
                                    rect.right > 0 && rect.left < window.innerWidth);

            if (DETECT_HIDDEN_MEDIA && isAudible) {
                isWithinViewport = true;
            }

            const hasLoadedMediaData = v.videoWidth > 0 || v.videoHeight > 0 || v.currentSrc;

            return isMediaTag && hasLoadedMediaData && isReasonableSize && passesVisibilityCheck && isWithinViewport;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function isVisibleInViewport(video) {
        const rect = video.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight &&
               rect.right > 0 && rect.left < window.innerWidth &&
               rect.width > 0 && rect.height > 0;
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
            lastUpdatedPlaybackRate = null;
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
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647 !important;
            display: none; opacity: 0 !important; transition: opacity 0.3s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: fit-content;
            min-width: 280px;
            overflow: hidden; text-align: center; pointer-events: auto;
            display: flex;
            flex-direction: column;
            align-items: stretch;
            visibility: hidden !important;
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

        if (speedInput && speedDisplay) {
            const currentRate = desiredPlaybackRate.toFixed(2);
            const lastRate = lastUpdatedPlaybackRate !== null ? lastUpdatedPlaybackRate.toFixed(2) : null;

            if (currentRate !== lastRate) {
                speedInput.value = desiredPlaybackRate.toFixed(1);
                speedDisplay.textContent = desiredPlaybackRate.toFixed(2) + 'x';
                lastUpdatedPlaybackRate = desiredPlaybackRate;
            }
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

    const dragPopup = (e) => {
        if (!isPopupDragging) return;
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        if (clientX === undefined || clientY === undefined) return;

        const targetLeft = clientX - popupDragOffsetX;
        const targetTop = clientY - popupDragOffsetY;

        popupElement.style.left = `${targetLeft}px`;
        popupElement.style.top = `${targetTop}px`;

        lastPopupPosition.left = targetLeft;
        lastPopupPosition.top = targetTop;
    };

    const throttledDragPopupMouse = throttle(dragPopup, 16);
    const throttledDragPopupTouch = throttle(dragPopup, 30);

    function keepPopupInView() {
        if (!popupElement || popupElement.style.display === 'none') return;

        const rect = popupElement.getBoundingClientRect();
        const margin = 10;

        let needsReposition = false;
        let newLeft = rect.left;
        let newTop = rect.top;

        const targetElement = document.fullscreenElement || window;
        const targetWidth = targetElement === window ? window.innerWidth : targetElement.offsetWidth;
        const targetHeight = targetElement === window ? window.innerHeight : targetElement.offsetHeight;

        let currentParentRect = { left: 0, top: 0 };
        if (document.fullscreenElement && popupElement.offsetParent) {
             currentParentRect = popupElement.offsetParent.getBoundingClientRect();
        }

        const currentPopupLeftRelToParent = rect.left - currentParentRect.left;
        const currentPopupTopRelToParent = rect.top - currentParentRect.top;


        if (currentPopupLeftRelToParent < margin || currentPopupLeftRelToParent > targetWidth - rect.width - margin) {
            newLeft = margin;
            needsReposition = true;
        }
        if (currentPopupTopRelToParent < margin || currentPopupTopRelToParent > targetHeight - rect.height - margin) {
            newTop = margin;
            needsReposition = true;
        }

        if (needsReposition) {
            console.log('[VCP] Popup out of view, repositioning.');
            popupElement.style.left = `${newLeft}px`;
            popupElement.style.top = `${newTop}px`;

            lastPopupPosition = {
                left: newLeft + currentParentRect.left,
                top: newTop + currentParentRect.top
            };
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
            lastUpdatedPlaybackRate = rate;
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
            const parentRect = popupElement.offsetParent ? popupElement.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
            popupDragOffsetX = clientX - (rect.left - parentRect.left);
            popupDragOffsetY = clientY - (rect.top - parentRect.top);
            document.body.style.userSelect = 'none';
        };

        const stopDrag = (e) => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                resetPopupHideTimer();

                if (e) {
                    dragPopup(e);
                }
                keepPopupInView();
            }
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag, { passive: false });
        document.addEventListener('mousemove', throttledDragPopupMouse);
        document.addEventListener('touchmove', throttledDragPopupTouch, { passive: false });
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isVisible) {
            popupElement.style.setProperty('display', 'flex', 'important');
            popupElement.style.setProperty('opacity', '0.75', 'important');
            popupElement.style.setProperty('visibility', 'visible', 'important');
            popupElement.style.setProperty('pointer-events', 'auto', 'important');
            popupElement.style.setProperty('z-index', '2147483647', 'important');
            isPopupVisible = true;
            resetPopupHideTimer();
            startVideoStatusLoop();
            keepPopupInView();
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.setProperty('display', 'none', 'important');
            popupElement.style.setProperty('opacity', '0', 'important');
            popupElement.style.setProperty('visibility', 'hidden', 'important');
            isPopupVisible = false;
            stopVideoStatusLoop();
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            return;
        }

        const fsEl = document.fullscreenElement;
        if (fsEl) {
            if (popupElement.parentNode !== fsEl) {
                fsEl.appendChild(popupElement);
                console.log('[VCP] Popup moved to fullscreen element.');
            }
            popupElement.style.position = 'absolute';
        } else {
            if (popupElement.parentNode !== document.body) {
                document.body.appendChild(popupElement);
                console.log('[VCP] Popup moved to body.');
            }
            popupElement.style.position = 'fixed';
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
            threshold: [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0]
        };

        const observerCallback = (entries) => {
            let needsLogicRecalculation = false;
            entries.forEach(entry => {
                const video = entry.target;
                const oldRatio = observedVideosData.has(video) ? observedVideosData.get(video).intersectionRatio : 0;
                const newRatio = entry.intersectionRatio;

                if (newRatio > 0) {
                    observedVideosData.set(video, {
                        intersectionRatio: newRatio,
                        timestamp: Date.now()
                    });
                } else {
                    observedVideosData.delete(video);
                }

                if (Math.abs(newRatio - oldRatio) > 0.01) {
                    needsLogicRecalculation = true;
                }
            });
            if (needsLogicRecalculation || !currentVideo || !observedVideosData.has(currentVideo)) {
                 selectVideoLogic();
            }
        };

        videoObserver = new IntersectionObserver(observerCallback, observerOptions);
        updateVideoList();
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
            instrumentMediaElement(video);
        });

        if (currentVideo && (!document.body.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            currentVideo = null;
            hidePopup();
        }
    }

    function calculateVideoScore(video) {
        const rect = video.getBoundingClientRect();
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

        const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);
        const centerScore = 1 / Math.pow(1 + centerDist, 5);

        const isAudible = !video.muted && video.volume > 0 && !video.paused && video.src;

        let score;
        if (DETECT_HIDDEN_MEDIA && isAudible) {
            score = 1000 + (visibleArea * 0.1) + (centerScore * 100);
            if (video.tagName === 'AUDIO') score += 500;
        } else {
            score = visibleArea * 0.7 + centerScore * 5000 * 0.3;
        }

        return score;
    }

    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return 0;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
        const totalArea = rect.width * rect.height;

        return totalArea > 0 ? visibleArea / totalArea : 0;
    }

    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => {
                const isAudible = !video.muted && video.volume > 0 && !video.paused;
                return data.intersectionRatio > 0 || (DETECT_HIDDEN_MEDIA && isAudible);
            })
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
            if (currentVideo && (!document.body.contains(currentVideo) || (!isVisibleInViewport(currentVideo) && !(DETECT_HIDDEN_MEDIA && !currentVideo.muted && currentVideo.volume > 0)))) {
                console.log('[VCP] Current video is not in DOM or not visible/audible. Hiding popup.');
                currentVideo = null;
                hidePopup();
            } else if (!currentVideo) {
                hidePopup();
            }
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            if (currentVideo && (!document.body.contains(currentVideo) || (!observedVideosData.has(currentVideo) || observedVideosData.get(currentVideo).intersectionRatio === 0) && !(DETECT_HIDDEN_MEDIA && !currentVideo.muted && currentVideo.volume > 0 && !currentVideo.paused) || !isVisibleInViewport(currentVideo))) {
                currentVideo = null;
                hidePopup();
            }
            selectVideoLogic();
        }, 100);
    }

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
            const isAudibleHiddenMedia = DETECT_HIDDEN_MEDIA && !currentVideo.muted && currentVideo.volume > 0 && !currentVideo.paused;
            if (!isVisibleInViewport(currentVideo) && !isAudibleHiddenMedia) {
                hidePopup();
            }
        }, HIDE_DEBOUNCE_MS);
    }

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

    function setupSPADetection() {
        let lastUrl = location.href;

        const handleSpaUrlChange = (newUrl) => {
            if (currentVideo && newUrl === lastUrl) {
                console.log(`[VCP] SPA URL 변경 감지 (동일 URL, 재실행 방지): ${newUrl}`);
                return;
            }

            console.log(`[VCP] SPA URL 변경 감지 콜백: ${newUrl} - 비디오 상태 초기화`);
            currentVideo = null;
            hidePopup();
            manualVideoElements.clear();
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
        // Not used currently.
    }

    function videoStatusLoop() {
        if (!currentVideo || !document.body.contains(currentVideo)) {
            currentVideo = null;
            hidePopup();
            stopVideoStatusLoop();
            return;
        }

        const currentRect = currentVideo.getBoundingClientRect();
        const newState = {
            playbackRate: currentVideo.playbackRate,
            muted: currentVideo.muted,
            volume: currentVideo.volume,
            ended: currentVideo.ended,
            rect: {
                left: currentRect.left,
                top: currentRect.top,
                width: currentRect.width,
                height: currentRect.height
            }
        };

        const oldState = videoStateCache.get(currentVideo);
        const stateChanged = !oldState ||
                             newState.playbackRate !== oldState.playbackRate ||
                             newState.muted !== oldState.muted ||
                             newState.volume !== oldState.volume ||
                             newState.ended !== oldState.ended ||
                             newState.rect.left !== oldState.rect.left ||
                             newState.rect.top !== oldState.rect.top ||
                             newState.rect.width !== oldState.rect.width ||
                             newState.rect.height !== oldState.rect.height;

        if (stateChanged) {
            videoStateCache.set(currentVideo, newState);

            if (currentVideo.playbackRate !== desiredPlaybackRate) {
                currentVideo.playbackRate = desiredPlaybackRate;
            }
            if (currentVideo.muted !== isManuallyMuted) {
                currentVideo.muted = isManuallyMuted;
            }
            if (!currentVideo.muted && Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
                currentVideo.volume = desiredVolume;
            }

            if (isPopupVisible) {
                updateMuteSpeakButtons();
                updatePopupSliders();

                if (!isPopupDragging) {
                    const videoRect = currentVideo.getBoundingClientRect();
                    const popupWidth = popupElement.offsetWidth || 280;
                    const popupHeight = popupElement.offsetHeight || 150;

                    let targetX, targetY;
                    let parentRectOffset = { left: 0, top: 0 };

                    if (document.fullscreenElement) {
                        const fsElRect = document.fullscreenElement.getBoundingClientRect();
                        parentRectOffset = fsElRect;
                        targetX = (videoRect.left - fsElRect.left) + (videoRect.width / 2) - (popupWidth / 2);
                        targetY = (videoRect.top - fsElRect.top) + (videoRect.height / 2) - (popupHeight / 2);

                        targetX = Math.max(0, Math.min(targetX, fsElRect.width - popupWidth));
                        targetY = Math.max(0, Math.min(targetY, fsElRect.height - popupHeight));

                    } else {
                        targetX = videoRect.left + (videoRect.width / 2) - (popupWidth / 2);
                        targetY = videoRect.top + (videoRect.height / 2) - (popupHeight / 2);

                        targetX = Math.max(0, Math.min(targetX, window.innerWidth - popupWidth));
                        targetY = Math.max(0, Math.min(targetY, window.innerHeight - popupHeight));
                    }

                    const currentPopupOffsetLeft = popupElement.getBoundingClientRect().left - parentRectOffset.left;
                    const currentPopupOffsetTop = popupElement.getBoundingClientRect().top - parentRectOffset.top;

                    const delta = Math.abs(targetX - currentPopupOffsetLeft) + Math.abs(targetY - currentPopupOffsetTop);

                    if (delta > 1 || lastPopupPosition.left === -9999) {
                        lastPopupPosition.left = targetX + parentRectOffset.left;
                        lastPopupPosition.top = targetY + parentRectOffset.top;

                        popupElement.style.left = `${targetX}px`;
                        popupElement.style.top = `${targetY}px`;
                    }
                }
            }
        }

        const isAudibleHiddenMedia = DETECT_HIDDEN_MEDIA && !currentVideo.muted && currentVideo.volume > 0 && !currentVideo.paused;
        if (isPopupVisible && !isVisibleInViewport(currentVideo) && !isAudibleHiddenMedia) {
            hidePopup();
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
        document.addEventListener('touchmove', handleUserTouchMove, { passive: true });
        window.addEventListener('scroll', onUserScrollOrTouchMove, { passive: true });
        window.addEventListener('touchmove', onUserScrollOrTouchMove, { passive: true });
        window.addEventListener('scroll', handleScrollEvent, { passive: true });

        window.addEventListener('resize', () => {
            lastPopupPosition = { left: -9999, top: -9999 };
            keepPopupInView();
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopVideoStatusLoop();
                console.log('[VCP] Tab hidden, video status loop paused.');
            } else {
                startVideoStatusLoop();
                console.log('[VCP] Tab visible, video status loop resumed.');
            }
        });
    }


    let currentFullscreenTarget = null;
    function setupFullscreenHandling() {
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (currentFullscreenTarget) {
                    currentFullscreenTarget.removeEventListener('click', handleUserClickOrTouch, true);
                    currentFullscreenTarget.removeEventListener('touchend', handleUserClickOrTouch, true);
                    console.log('[VCP] Removed fullscreen click listeners from previous target.');
                }

                if (fsEl) {
                    console.log('[VCP] Fullscreen entered. Appending popup to fullscreen element.');
                    if (popupElement.parentNode !== fsEl) {
                        fsEl.appendChild(popupElement);
                    }
                    popupElement.style.position = 'absolute';
                    fsEl.addEventListener('click', handleUserClickOrTouch, true);
                    fsEl.addEventListener('touchend', handleUserClickOrTouch, true);
                    currentFullscreenTarget = fsEl;

                } else {
                    console.log('[VCP] Fullscreen exited. Appending popup back to body.');
                    if (popupElement.parentNode !== document.body) {
                        document.body.appendChild(popupElement);
                    }
                    popupElement.style.position = 'fixed';
                    currentFullscreenTarget = null;
                }

                lastPopupPosition = { left: -9999, top: -9999 };
                keepPopupInView();
                showPopup();
            }
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
            document.removeEventListener('mousemove', throttledDragPopupMouse);
            document.removeEventListener('touchmove', throttledDragPopupTouch, { passive: false });
             if (currentFullscreenTarget) {
                currentFullscreenTarget.removeEventListener('click', handleUserClickOrTouch, true);
                currentFullscreenTarget.removeEventListener('touchend', handleUserClickOrTouch, true);
            }
        });
    }

    // --- Main Initialization Function ---
    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.24_EnhancedMediaDetection_FullscreenFix_DeepScan_RevertFS_FixRefError_RetryInit.');

        hackAttachShadow();
        createPopupUI();
        setupPopupEventListeners();
        setupGlobalEventListeners();
        setupObservers();
        setupSPADetection();
        setupFullscreenHandling();
        cleanupOnUnload();

        hidePopup();
        // ⭐ 초기화 시 비디오 목록 업데이트 및 선택 로직 즉시 실행
        updateVideoList();
        selectVideoLogic();
        fixOverflow();
    }

    // DOMContentLoaded 이후 바로 초기화
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }

    // ⭐ 3초 후 재시도 로직 추가 (DOMContentLoaded 이후 동적으로 로드되는 미디어 대비)
    setTimeout(() => {
      if (!isInitialized || videos.length === 0) { // 초기화가 안되었거나 아직 비디오를 못 찾았다면
        console.log('[VCP] Retrying initialization: Delayed media or SPA content might be present.');
        // isInitialized를 다시 false로 설정하여 initialize()가 재실행되도록 함
        isInitialized = false;
        initialize();
      }
    }, 3000);
})();
