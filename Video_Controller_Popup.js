// ==UserScript==
// @name Video Controller Popup (V4.23.5: Popup Init Fix)
// @namespace Violentmonkey Scripts
// @version 4.23.5_PopupInitFix
// @description Optimized video controls with robust popup initialization on video selection, consistent state management during dragging, enhanced scroll handling, improved mobile click recognition, fixed ReferenceError, and increased max playback rate to 16x. Features a circular icon that acts as a permanent toggle for the main UI, always visible. Popup positioning refined to avoid overlap and appear to the left of the icon. Modified: Softened AbortError logging to debug level, assuming it's an expected interruption rather than a critical failure. Improved: Enhanced video detection for dynamic content and Shadow DOM. Fixed: Persistent playback rate and volume issues on YouTube. **Further refined: Stronger rate and volume enforcement, better click handling, initialize rate/volume when popup opens.**
// @match *://*/*
// @grant none
// @run-at document-start
// ==/UserScript==

(function() {
    'use strict';
    let videos = [],
        currentVideo = null,
        popupElement = null,
        circularIconElement = null,
        desiredPlaybackRate = 1.0, // Default to 1.0
        desiredVolume = 1.0,     // Default to 1.0 (100%)
        isPopupDragging = false,
        popupDragOffsetX = 0,
        popupDragOffsetY = 0,
        isInitialized = false;
    let isManuallyPaused = false;
    const videoRateHandlers = new WeakMap();
    const videoVolumeHandlers = new WeakMap(); // Added for volume enforcement

    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));

    let ignorePopupEvents = false;
    const IGNORE_EVENTS_DURATION = 100; // milliseconds

    let _videoUpdateTimeout = null;

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        const videoElements = new Set();

        // 1. Current document/root
        root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));

        // 2. Iterate through all elements to find Shadow DOMs
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
            if (el.shadowRoot) {
                findAllVideosDeep(el.shadowRoot).forEach(v => videoElements.add(v));
            }
        }

        // 3. Check for iframes (if they are same-origin and accessible)
        root.querySelectorAll('iframe').forEach(iframe => {
            try {
                if (iframe.contentDocument) {
                    findAllVideosDeep(iframe.contentDocument).forEach(v => videoElements.add(v));
                }
            } catch (e) {
                // console.warn("[VCP Debug] Could not access iframe content (likely CORS block):", e);
            }
        });

        return Array.from(videoElements);
    }


    function isWithinViewport(rect) {
        return (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
    }

    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight,
            viewportWidth = window.innerWidth;
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

    function calculateCenterDistanceScore(video, intersectionRatio) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const videoCenterY = rect.top + (rect.height / 2);
        const viewportCenterY = viewportHeight / 2;
        const distance = Math.abs(videoCenterY - viewportCenterY);
        const normalizedDistance = distance / viewportHeight;
        const score = intersectionRatio - normalizedDistance;
        return score;
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        if (isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                    console.log(`[VCP Debug] Lazily loaded src for video: ${v.dataset.src}`);
                }
            });
        }
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.01;
            const isReasonableSize = (rect.width >= 30 && rect.height >= 30) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia || v.src;
            const isAttachedToDOM = document.documentElement.contains(v);

            return isVisible && isReasonableSize && hasMedia && isAttachedToDOM;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const rect = currentVideo.getBoundingClientRect();
        const style = window.getComputedStyle(currentVideo);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.01;
        const isReasonableSize = (rect.width >= 30 && rect.height >= 30) || currentVideo.tagName === 'AUDIO' || !currentVideo.paused;
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO' || currentVideo.src;
        const isAttachedToDOM = document.documentElement.contains(currentVideo);
        return isVisible && isWithinViewport(rect) && isReasonableSize && hasMedia && isAttachedToDOM;
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            console.log('[VCP Debug] selectAndControlVideo: No video to control, pausing current and hiding popup.');
            if (currentVideo) { currentVideo.pause(); currentVideo = null; }
            hidePopupOnly();
            return;
        }

        if (currentVideo === videoToControl) {
            console.log(`[VCP Debug] selectAndControlVideo: Same video already selected. Ensuring popup visibility and updating sliders.`);
            updatePopupSliders();
            setPopupVisibility(true); // Ensure popup is visible and positioned
            return;
        }

        if (currentVideo) {
            currentVideo.pause();
            console.log(`[VCP Debug] Pausing previous video: ${currentVideo.src || currentVideo.tagName}`);
        }

        currentVideo = videoToControl;
        currentVideo.autoplay = true;
        currentVideo.playsInline = true;
        currentVideo.muted = false;

        // Apply desired rate and volume
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNativeVolume(currentVideo, desiredVolume);
        isManuallyPaused = false;

        currentVideo.play().catch(e => {
            if (e.name === "AbortError") {
                console.log("[VCP Debug] Play request was aborted, likely by a subsequent pause or user action.");
            } else {
                console.warn("[VCP] Autoplay/Play on select failed:", e);
            }
        });

        updatePopupSliders();
        showCircularIcon();
        setPopupVisibility(true);
        console.log(`[VCP Debug] Selected and controlling video: ${currentVideo.src || currentVideo.tagName}`);
    }

    // --- Rate control with stronger enforcement ---
    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') {
            console.warn('[VCP Debug] fixPlaybackRate: No video or playbackRate property missing.');
            return;
        }
        desiredPlaybackRate = rate;

        // Clear any previous enforcement interval
        const existingEnforcement = videoRateHandlers.get(video);
        if (existingEnforcement) {
            if (existingEnforcement.clearInterval) {
                clearInterval(existingEnforcement.clearInterval);
            }
            if (existingEnforcement.listener) {
                video.removeEventListener('ratechange', existingEnforcement.listener);
            }
        }

        // 1. Define the new ratechange handler
        const rateChangeHandler = () => {
            // Check if the rate changed to something other than our desired rate
            if (video.playbackRate !== desiredPlaybackRate) {
                console.log(`[VCP Debug] ratechange event detected. Correcting playbackRate from ${video.playbackRate} to ${desiredPlaybackRate}`);
                // Re-apply the desired rate with a slight delay to allow YouTube's player to settle
                setTimeout(() => {
                    if (video.playbackRate !== desiredPlaybackRate) { // Check again before applying
                        video.playbackRate = desiredPlaybackRate;
                        console.log(`[VCP Debug] Playback rate re-applied after delay: ${desiredPlaybackRate}`);
                    }
                }, 50); // Small delay to avoid immediate override conflicts
            }
        };

        // 2. Set the rate immediately
        video.playbackRate = rate;
        console.log(`[VCP Debug] Playback rate initially set for video ${video.src || video.tagName}: ${rate}`);

        // 3. Add the new handler
        video.addEventListener('ratechange', rateChangeHandler);

        // 4. Periodically re-apply the rate for a short duration
        let retryCount = 0;
        const maxRetries = 30; // Increased retries for persistence
        const retryInterval = 50; // More frequent

        const enforceRateInterval = setInterval(() => {
            if (!video || video.playbackRate === desiredPlaybackRate || retryCount >= maxRetries) {
                clearInterval(enforceRateInterval);
                if (retryCount >= maxRetries) {
                    console.log(`[VCP Debug] Playback rate enforcement stopped after ${maxRetries} retries.`);
                }
                return;
            }
            video.playbackRate = desiredPlaybackRate;
            console.log(`[VCP Debug] Playback rate enforced (retry ${retryCount + 1}): ${desiredPlaybackRate}`);
            retryCount++;
        }, retryInterval);

        // Store both the listener and the interval ID
        videoRateHandlers.set(video, { listener: rateChangeHandler, clearInterval: enforceRateInterval });
    }

    // --- Volume control with stronger enforcement ---
    function setNativeVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') {
            console.warn('[VCP Debug] setNativeVolume: No video or volume property missing.');
            return;
        }
        desiredVolume = vol;

        // Clear any previous enforcement interval
        const existingEnforcement = videoVolumeHandlers.get(video);
        if (existingEnforcement) {
            if (existingEnforcement.clearInterval) {
                clearInterval(existingEnforcement.clearInterval);
            }
            if (existingEnforcement.listener) {
                video.removeEventListener('volumechange', existingEnforcement.listener);
            }
        }

        // 1. Define the new volumechange handler
        const volumeChangeHandler = () => {
            if (video.volume !== desiredVolume) {
                console.log(`[VCP Debug] volumechange event detected. Correcting volume from ${video.volume} to ${desiredVolume}`);
                setTimeout(() => {
                    if (video.volume !== desiredVolume) {
                        video.volume = desiredVolume;
                        console.log(`[VCP Debug] Volume re-applied after delay: ${desiredVolume}`);
                    }
                }, 50);
            }
        };

        // 2. Set the volume immediately
        video.muted = false; // Ensure it's not muted
        video.volume = Math.min(Math.max(0, vol), 1.0);
        console.log(`[VCP Debug] Volume initially set for video ${video.src || video.tagName}: ${vol}`);

        // 3. Add the new handler
        video.addEventListener('volumechange', volumeChangeHandler);

        // 4. Periodically re-apply the volume for a short duration
        let retryCount = 0;
        const maxRetries = 30; // Increased retries for persistence
        const retryInterval = 50;

        const enforceVolumeInterval = setInterval(() => {
            if (!video || video.volume === desiredVolume || retryCount >= maxRetries) {
                clearInterval(enforceVolumeInterval);
                if (retryCount >= maxRetries) {
                    console.log(`[VCP Debug] Volume enforcement stopped after ${maxRetries} retries.`);
                }
                return;
            }
            video.muted = false; // Ensure it's not muted
            video.volume = desiredVolume;
            console.log(`[VCP Debug] Volume enforced (retry ${retryCount + 1}): ${desiredVolume}`);
            retryCount++;
        }, retryInterval);

        videoVolumeHandlers.set(video, { listener: volumeChangeHandler, clearInterval: enforceVolumeInterval });
    }


    function createCircularIconElement() {
        let existingIcon = document.getElementById('video-controller-circular-icon');
        if (existingIcon) {
            circularIconElement = existingIcon;
        } else {
            circularIconElement = document.createElement('div');
            circularIconElement.id = 'video-controller-circular-icon';
            circularIconElement.textContent = '▶';
            document.documentElement.appendChild(circularIconElement);

            circularIconElement.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log('[VCP Debug] Circular icon clicked.');
                if (!currentVideo) {
                    updateStatus('재생 가능한 비디오를 찾을 수 없습니다.');
                    console.warn('[VCP Debug] Circular icon click: No current video, cannot toggle popup.');
                    // If no video, but user clicked icon, try to find a video again.
                    findAndSelectBestVideo();
                    return;
                }
                togglePopupVisibility();
            }, true);
        }

        circularIconElement.setAttribute('style', `
            position:fixed !important;
            width:40px !important;
            height:40px !important;
            background:rgba(30,30,30,0.9) !important;
            border:1px solid #444 !important;
            border-radius:50% !important;
            display:flex !important;
            justify-content:center !important;
            align-items:center !important;
            color:white !important;
            font-size:20px !important;
            cursor:pointer !important;
            z-index:2147483647 !important;
            opacity:0.75 !important;
            transition:opacity 0.3s !important;
            box-shadow:0 2px 8px rgba(0,0,0,0.5) !important;
            user-select:none !important;

            top: calc(50vh - 20px) !important;
            right: 10px !important;
            bottom: auto !important;
            left: auto !important;
            transform: none !important;
        `);
    }

    function createPopupElement() {
        let existingPopup = document.getElementById('video-controller-popup');
        if (existingPopup) {
            popupElement = existingPopup;
        } else {
            popupElement = document.createElement('div');
            popupElement.id = 'video-controller-popup';
            document.documentElement.appendChild(popupElement);
        }

        popupElement.setAttribute('style', `
            position:fixed !important;
            background:rgba(30,30,30,0.9) !important;
            border:1px solid #444 !important;
            border-radius:8px !important;
            padding:0 !important;
            color:white !important;
            font-family:sans-serif !important;
            z-index:2147483647 !important;
            display:none !important;
            opacity:0 !important;
            transition:opacity 0.3s !important;
            box-shadow:0 4px 12px rgba(0,0,0,0.5) !important;
            width:230px !important;
            overflow:hidden !important;
            text-align:center !important;
            pointer-events:auto !important;
            user-select:none !important;
            top: auto !important;
            left: auto !important;
            max-width: calc(100vw - 20px) !important;
            max-height: calc(100vh - 20px) !important;
        `);

        if (!popupElement.querySelector('#vcp-drag-handle')) {
            const dragHandle = document.createElement('div');
            dragHandle.id = 'vcp-drag-handle';
            dragHandle.textContent = '비디오.오디오 컨트롤러';
            dragHandle.setAttribute('style', `font-weight:bold !important;margin-bottom:8px !important;color:#aaa !important;padding:5px !important;background-color:#2a2a2a !important;border-bottom:1px solid #444 !important;cursor:grab !important;border-radius:6px 6px 0 0 !important;user-select:none !important;`);
            popupElement.appendChild(dragHandle);

            const contentContainer = document.createElement('div');
            contentContainer.setAttribute('style', 'padding:10px !important;');

            const commonBtnStyle = `background-color:#333 !important;color:white !important;border:1px solid #555 !important;padding:5px 10px !important;border-radius:4px !important;cursor:pointer !important;transition:background-color 0.2s !important;white-space:nowrap !important;min-width:80px !important;text-align:center !important;user-select:none !important;`;

            const buttonSection = document.createElement('div');
            buttonSection.setAttribute('style', 'display:flex !important;gap:5px !important;justify-content:center !important;align-items:center !important;margin-bottom:10px !important;');

            const playPauseBtn = document.createElement('button');
            playPauseBtn.setAttribute('data-action', 'play-pause');
            playPauseBtn.textContent = '재생/멈춤';
            playPauseBtn.setAttribute('style', commonBtnStyle);

            const resetBtn = document.createElement('button');
            resetBtn.setAttribute('data-action', 'reset-speed-volume');
            resetBtn.textContent = '재설정';
            resetBtn.setAttribute('style', commonBtnStyle);

            buttonSection.appendChild(playPauseBtn);
            buttonSection.appendChild(resetBtn);
            contentContainer.appendChild(buttonSection);

            const speedSection = document.createElement('div');
            speedSection.className = 'vcp-section';
            speedSection.setAttribute('style', 'margin-bottom:10px !important;');
            const speedLabel = document.createElement('label');
            speedLabel.htmlFor = 'vcp-speed';
            speedLabel.setAttribute('style', 'display:block !important;margin-bottom:5px !important;color:white !important;');
            const speedDisplay = document.createElement('span');
            speedDisplay.id = 'vcp-speed-display';
            speedDisplay.textContent = '1.00';
            speedLabel.textContent = '배속 조절: ';
            speedLabel.appendChild(speedDisplay);
            speedLabel.appendChild(document.createTextNode('x'));
            const speedInput = document.createElement('input');
            speedInput.type = 'range';
            speedInput.id = 'vcp-speed';
            speedInput.min = '0.2';
            speedInput.max = '16.0';
            speedInput.step = '0.1';
            speedInput.value = '1.0';
            speedInput.setAttribute('style', 'width:100% !important;cursor:pointer !important;');
            speedSection.appendChild(speedLabel);
            speedSection.appendChild(speedInput);
            contentContainer.appendChild(speedSection);

            const volumeSection = document.createElement('div');
            volumeSection.className = 'vcp-section';
            volumeSection.setAttribute('style', 'margin-bottom:10px !important;');
            const volumeLabel = document.createElement('label');
            volumeLabel.htmlFor = 'vcp-volume';
            volumeLabel.setAttribute('style', 'display:block !important;margin-bottom:5px !important;color:white !important;');
            const volumeDisplay = document.createElement('span');
            volumeDisplay.id = 'vcp-volume-display';
            volumeDisplay.textContent = '100';
            volumeLabel.textContent = '소리 조절: ';
            volumeLabel.appendChild(volumeDisplay);
            volumeLabel.appendChild(document.createTextNode('%'));
            const volumeInput = document.createElement('input');
            volumeInput.type = 'range';
            volumeInput.id = 'vcp-volume';
            volumeInput.min = '0.0';
            volumeInput.max = '1.0';
            volumeInput.step = '0.1';
            volumeInput.value = '1.0';
            volumeInput.setAttribute('style', 'width:100% !important;cursor:pointer !important;');
            volumeSection.appendChild(volumeLabel);
            volumeSection.appendChild(volumeInput);
            contentContainer.appendChild(volumeSection);

            const modeSection = document.createElement('div');
            modeSection.className = 'vcp-section';
            modeSection.setAttribute('style', 'margin-bottom:10px !important;');
            const pipBtn = document.createElement('button');
            pipBtn.setAttribute('data-action', 'pip');
            pipBtn.textContent = 'PIP 모드';
            pipBtn.setAttribute('style', `${commonBtnStyle}margin-top:5px !important;`);
            const exitFullscreenBtn = document.createElement('button');
            exitFullscreenBtn.setAttribute('data-action', 'exit-fullscreen');
            exitFullscreenBtn.textContent = '전체 종료';
            exitFullscreenBtn.setAttribute('style', `${commonBtnStyle}margin-top:5px !important;`);
            modeSection.appendChild(pipBtn);
            modeSection.appendChild(exitFullscreenBtn);
            contentContainer.appendChild(modeSection);

            const statusElement = document.createElement('div');
            statusElement.id = 'vcp-status';
            statusElement.textContent = 'Status:Ready';
            statusElement.setAttribute('style', 'margin-top:10px !important;font-size:12px !important;color:#777 !important;');
            contentContainer.appendChild(statusElement);
            popupElement.appendChild(contentContainer);
        }
        console.log('[VCP Debug] Popup element created/ensured.');
    }

    function handleButtonClick(action) {
        if (!currentVideo) {
            updateStatus('재생 가능한 비디오가 없습니다.');
            console.warn(`[VCP Debug] Button click "${action}": No current video.`);
            return;
        }

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = false;
                    currentVideo.play().catch(e => console.error("[VCP] Play failed:", e));
                    updateStatus('재생 중');
                    console.log('[VCP Debug] Play/Pause: Playing video.');
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                    updateStatus('일시정지됨');
                    console.log('[VCP Debug] Play/Pause: Pausing video.');
                }
                break;
            case 'reset-speed-volume':
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0);
                desiredVolume = 1.0;
                setNativeVolume(currentVideo, 1.0);
                currentVideo.muted = false;
                updatePopupSliders();
                updateStatus('1.0x 배속 / 100% 소리');
                console.log('[VCP Debug] Reset Speed/Volume to 1.0x / 100%.');
                break;
            case 'pip':
                if (document.pictureInPictureEnabled && currentVideo.requestPictureInPicture) {
                    (document.pictureInPictureElement ? document.exitPictureInPicture() : currentVideo.requestPictureInPicture()).catch(e => console.error("[VCP] PIP failed:", e));
                    updateStatus(document.pictureInPictureElement ? 'PIP 종료' : 'PIP 시작');
                    console.log('[VCP Debug] PIP button clicked.');
                } else {
                    updateStatus('PIP를 지원하지 않습니다.');
                    console.warn('[VCP Debug] PIP not supported.');
                }
                break;
            case 'exit-fullscreen':
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
                    updateStatus('전체 화면 종료');
                    console.log('[VCP Debug] Exit Fullscreen button clicked.');
                }
                break;
        }
    }

    function setupPopupEventListeners() {
        if (!popupElement) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const dragHandle = popupElement.querySelector('#vcp-drag-handle');

        // Clean up previous listeners
        if (speedInput && speedInput.vcp_listener) {
            speedInput.removeEventListener('input', speedInput.vcp_listener);
            delete speedInput.vcp_listener;
        }
        if (volumeInput && volumeInput.vcp_listener) {
            volumeInput.removeEventListener('input', volumeInput.vcp_listener);
            delete volumeInput.vcp_listener;
        }
        if (dragHandle && dragHandle.vcp_mousedown_listener) {
            dragHandle.removeEventListener('mousedown', dragHandle.vcp_mousedown_listener, true);
            delete dragHandle.vcp_mousedown_listener;
        }
        if (dragHandle && dragHandle.vcp_touchstart_listener) {
            dragHandle.removeEventListener('touchstart', dragHandle.vcp_touchstart_listener, true);
            delete dragHandle.vcp_touchstart_listener;
        }

        popupElement.removeEventListener('click', handlePopupClickCapture, true);
        popupElement.addEventListener('click', handlePopupClickCapture, true);

        // Touchend is critical for mobile, ensure it doesn't interfere
        popupElement.removeEventListener('touchend', handlePopupTouchendCapture, true);
        popupElement.addEventListener('touchend', handlePopupTouchendCapture, true);


        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        if (speedInput && speedDisplay) {
            const speedListener = (e) => {
                e.stopPropagation();
                console.log('[VCP Debug] Speed slider input event detected.', { eventTarget: e.target, currentVideo: currentVideo });
                if (ignorePopupEvents) {
                    console.log('[VCP Debug] Speed slider event ignored due to ignorePopupEvents flag.');
                    return;
                }
                const rate = parseFloat(speedInput.value);
                desiredPlaybackRate = rate;
                speedDisplay.textContent = rate.toFixed(2);
                if (currentVideo) {
                    fixPlaybackRate(currentVideo, rate);
                    updateStatus(`배속: ${rate.toFixed(2)}x`);
                } else {
                    updateStatus('비디오를 찾을 수 없습니다.');
                    console.warn('[VCP Debug] Speed slider input: currentVideo is null.');
                }
            };
            speedInput.addEventListener('input', speedListener);
            speedInput.vcp_listener = speedListener;
        }

        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        if (volumeInput && volumeDisplay) {
            const volumeListener = (e) => {
                e.stopPropagation();
                console.log('[VCP Debug] Volume slider input event detected.', { eventTarget: e.target, currentVideo: currentVideo });
                if (ignorePopupEvents) {
                    console.log('[VCP Debug] Volume slider event ignored due to ignorePopupEvents flag.');
                    return;
                }

                volumeInput.max = '1.0';

                let vol = parseFloat(volumeInput.value);
                vol = Math.min(vol, parseFloat(volumeInput.max));

                desiredVolume = vol;
                volumeDisplay.textContent = Math.round(vol * 100);

                if (currentVideo) {
                    setNativeVolume(currentVideo, vol);
                    updateStatus(`소리: ${Math.round(vol * 100)}%`);
                } else {
                    updateStatus('비디오를 찾을 수 없습니다.');
                    console.warn('[VCP Debug] Volume slider input: currentVideo is null.');
                }
            };
            volumeInput.addEventListener('input', volumeListener);
            volumeInput.vcp_listener = volumeListener;
        }

        if (dragHandle) {
            const startDrag = e => {
                e.stopPropagation();
                e.preventDefault();
                console.log('[VCP Debug] Drag handle: Drag started.');
                if (ignorePopupEvents) { return; }
                if (e.target !== dragHandle) return;
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

                document.addEventListener('mousemove', dragPopup, true);
                document.addEventListener('touchmove', dragPopup, true);
                document.addEventListener('mouseup', stopDrag, true);
                document.addEventListener('touchend', stopDrag, true);
                document.addEventListener('mouseleave', stopDrag, true);
            };

            const stopDrag = () => {
                if (isPopupDragging) {
                    isPopupDragging = false;
                    dragHandle.style.cursor = 'grab';
                    document.body.style.userSelect = '';
                    console.log('[VCP Debug] Drag handle: Drag stopped.');
                    document.removeEventListener('mousemove', dragPopup, true);
                    document.removeEventListener('touchmove', dragPopup, true);
                    document.removeEventListener('mouseup', stopDrag, true);
                    document.removeEventListener('touchend', stopDrag, true);
                    document.removeEventListener('mouseleave', stopDrag, true);
                }
            };

            const dragPopup = e => {
                if (!isPopupDragging) return;
                e.preventDefault();
                const clientX = e.clientX || (e.touches && e.touches[0].clientX);
                const clientY = e.clientY || (e.touches && e.touches[0].clientY);
                if (clientX === undefined || clientY === undefined) return;

                let newLeft = clientX - popupDragOffsetX;
                let newTop = clientY - popupDragOffsetY;

                const popupRect = popupElement.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;

                if (newLeft < 0) newLeft = 0;
                if (newTop < 0) newTop = 0;
                if (newLeft + popupRect.width > viewportWidth) newLeft = viewportWidth - popupRect.width;
                if (newTop + popupRect.height > viewportHeight) newTop = viewportHeight - popupRect.height;


                popupElement.style.left = `${newLeft}px`;
                popupElement.style.top = `${newTop}px`;
            };
            dragHandle.addEventListener('mousedown', startDrag, true);
            dragHandle.addEventListener('touchstart', startDrag, true);
            dragHandle.vcp_mousedown_listener = startDrag;
            dragHandle.vcp_touchstart_listener = startDrag;
        }
        console.log('[VCP Debug] Popup event listeners re-attached.');
    }

    function handlePopupClickCapture(e) {
        if (ignorePopupEvents) { return; }
        const action = e.target.getAttribute('data-action');
        if (action) {
            e.preventDefault();
            e.stopPropagation();
            handleButtonClick(action);
        }
        console.log('[VCP Debug] Popup click event captured, action:', action || 'no-action');
    }

    function handlePopupTouchendCapture(e) {
        if (ignorePopupEvents) { return; }
        // For mobile, touchend might also trigger clicks. Ensure it's not double-counting or causing issues.
        // The preventDefault in handleButtonClick should generally cover this.
        console.log('[VCP Debug] Popup touchend event captured.');
        e.stopPropagation(); // Stop propagation for touch events too
    }

    function updateStatus(message) {
        const statusElement = popupElement.querySelector('#vcp-status');
        if (statusElement) {
            statusElement.textContent = `Status:${message}`;
            statusElement.style.opacity = 0.75;
            setTimeout(() => statusElement.style.opacity = 0, 2000);
        }
    }

    const originalSetPopupVisibility = function(isVisible) {
        if (!popupElement) {
            console.warn('[VCP Debug] originalSetPopupVisibility: popupElement is null.');
            return;
        }

        const originalTransition = popupElement.style.transition;
        popupElement.style.transition = 'none';

        if (isVisible) {
            // Apply initial rate/volume when popup becomes visible
            if (currentVideo) {
                fixPlaybackRate(currentVideo, desiredPlaybackRate); // Ensure it's 1.0 or user's last setting
                setNativeVolume(currentVideo, desiredVolume); // Ensure it's 1.0 or user's last setting
                updatePopupSliders(); // Update UI to reflect these settings
                console.log(`[VCP Debug] Popup opened: Forcing video rate to ${desiredPlaybackRate} and volume to ${desiredVolume}.`);
            }


            popupElement.style.display = 'block';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';

            if (circularIconElement) {
                const iconRect = circularIconElement.getBoundingClientRect();
                const popupWidth = popupElement.offsetWidth;
                const popupHeight = popupElement.offsetHeight;
                const iconWidth = circularIconElement.offsetWidth;
                const iconRight = window.innerWidth - iconRect.right;

                let targetRight = iconRight + iconWidth + 20;
                let targetTop = iconRect.top;

                if (window.innerWidth - targetRight - popupWidth < 10) {
                    targetRight = window.innerWidth - popupWidth - 10;
                }
                if (targetRight < 10) {
                    targetRight = 10;
                }

                if (targetTop < 10) {
                    targetTop = 10;
                }
                if (targetTop + popupHeight > window.innerHeight - 10) {
                    targetTop = window.innerHeight - popupHeight - 10;
                }

                popupElement.setAttribute('style', `
                    ${popupElement.getAttribute('style').replace(/(left|top|right|bottom|transform):[^;]*!important;/g, '')}
                    right:${targetRight}px !important;
                    top:${targetTop}px !important;
                    transform:none !important;
                `);
                console.log(`[VCP Debug] Popup positioned: right=${targetRight}px, top=${targetTop}px`);
            }

            popupElement.setAttribute('style', `
                ${popupElement.getAttribute('style').replace(/display:[^;]*|opacity:[^;]*|visibility:[^;]*|pointer-events:[^;]*/g, '')}
                display:block !important;
                opacity:0.9 !important;
                visibility:visible !important;
                pointer-events:auto !important;
            `);
            setupPopupEventListeners();
            console.log('[VCP Debug] Popup is now visible.');
            ignorePopupEvents = true;
            setTimeout(() => {
                ignorePopupEvents = false;
                console.log('[VCP Debug] ignorePopupEvents flag reset.');
            }, IGNORE_EVENTS_DURATION);
        } else {
            popupElement.setAttribute('style', `
                ${popupElement.getAttribute('style').replace(/display:[^;]*|opacity:[^;]*|visibility:[^;]*|pointer-events:[^;]*/g, '')}
                opacity:0 !important;
                visibility:hidden !important;
                display:none !important;
                pointer-events:none !important;
            `);
            console.log('[VCP Debug] Popup is now hidden.');
        }

        setTimeout(() => {
            popupElement.style.transition = originalTransition;
        }, 10);
    };

    let setPopupVisibility = (isVisible) => {
        if (!popupElement) {
            console.warn('[VCP Debug] setPopupVisibility: popupElement is null, cannot set visibility.');
            return;
        }
        popupElement.dataset.vcpDesiredVisibility = isVisible ? 'visible' : 'hidden';
        originalSetPopupVisibility(isVisible);
    };

    function setCircularIconVisibility() {
        if (!circularIconElement) {
            console.warn('[VCP Debug] setCircularIconVisibility: circularIconElement is null, cannot set visibility.');
            return;
        }
        circularIconElement.setAttribute('style', circularIconElement.getAttribute('style').replace(/display:[^;]*|opacity:[^;]*|visibility:[^;]*|pointer-events:[^;]*/g, '') +
            `display:flex !important;opacity:0.75 !important;visibility:visible !important;pointer-events:auto !important;`);
        console.log('[VCP Debug] Circular icon is now visible.');
    }

    function togglePopupVisibility() {
        if (!popupElement) {
            createPopupElement();
            if (!popupElement) {
                console.error('[VCP] Failed to create popup element for toggling.');
                return;
            }
        }

        const computedStyle = window.getComputedStyle(popupElement);
        const isPopupCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0);

        if (!currentVideo) {
            updateStatus('재생 가능한 비디오를 찾을 수 없습니다.');
            console.warn('[VCP Debug] Toggle popup: No current video selected, cannot show popup.');
            if (isPopupCurrentlyVisible) {
                setPopupVisibility(false);
            }
            return;
        }

        setPopupVisibility(!isPopupCurrentlyVisible);
        updatePopupSliders(); // This will be called by setPopupVisibility if it makes popup visible
        console.log(`[VCP Debug] Toggling popup visibility. Current state: ${isPopupCurrentlyVisible ? 'visible' : 'hidden'} -> ${!isPopupCurrentlyVisible ? 'visible' : 'hidden'}`);
    }

    function hidePopupOnly() {
        setPopupVisibility(false);
        console.log('[VCP Debug] Hiding popup directly.');
    }

    function showCircularIcon() {
        setCircularIconVisibility();
        circularIconElement.setAttribute('style', circularIconElement.getAttribute('style').replace(/right:[^;]*|top:[^;]*|transform:[^;]*|bottom:[^;]*|left:[^;]*/g, '') +
            `right:10px !important;top:calc(50vh - 20px) !important;transform:none !important;bottom:auto !important;left:auto !important;`);
        console.log('[VCP Debug] Circular icon position reset.');
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) {
            console.log('[VCP Debug] updatePopupSliders: Cannot update sliders, popup or currentVideo is null.');
            return;
        }

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (speedInput && speedDisplay) {
            const rate = currentVideo.playbackRate || desiredPlaybackRate;
            speedInput.value = rate.toFixed(2);
            speedDisplay.textContent = rate.toFixed(2);
            console.log(`[VCP Debug] Speed slider updated to: ${rate.toFixed(2)}`);
        }

        if (volumeInput && volumeDisplay) {
            volumeInput.max = '1.0';

            let vol = currentVideo.muted ? 0.0 : (currentVideo.volume || desiredVolume);
            vol = Math.min(vol, parseFloat(volumeInput.max));

            volumeInput.value = vol.toFixed(1);
            volumeDisplay.textContent = Math.round(vol * 100);
            console.log(`[VCP Debug] Volume slider updated to: ${Math.round(vol * 100)}%`);
        }
    }

    function findAndSelectBestVideo() {
        console.log('[VCP Debug] findAndSelectBestVideo called.');
        updateVideoList();
        let bestVideo = null;
        let maxScore = -Infinity;
        console.log(`[VCP Debug] Auto-selecting: Searching for best video among ${videos.length} candidates.`);

        videos.forEach(video => {
            if (typeof calculateIntersectionRatio !== 'function') {
                console.error('[VCP Error] calculateIntersectionRatio is NOT defined during findAndSelectBestVideo execution!');
                return;
            }
            const intersectionRatio = calculateIntersectionRatio(video);
            const score = calculateCenterDistanceScore(video, intersectionRatio);
            console.log(`[VCP Debug]   Candidate: ${video.src || video.tagName}, IntersectionRatio: ${intersectionRatio.toFixed(2)}, Score: ${score.toFixed(2)}`);

            if (intersectionRatio > 0.1 && score > maxScore) {
                maxScore = score;
                bestVideo = video;
            }
        });

        if (bestVideo && maxScore > -0.5) {
            if (currentVideo !== bestVideo) {
                console.log(`[VCP Debug] Auto-selecting: New best video found. Calling selectAndControlVideo.`);
                selectAndControlVideo(bestVideo);
            } else {
                console.log(`[VCP Debug] Auto-selecting: Current video is still the best. Updating popup (if visible).`);
                if (popupElement.dataset.vcpDesiredVisibility === 'visible') {
                     updatePopupSliders();
                     setPopupVisibility(true); // Re-trigger visibility logic to re-apply settings
                }
            }
        } else {
            console.log('[VCP Debug] Auto-selecting: No suitable best video found. Hiding popup if visible.');
            if (currentVideo) {
                currentVideo.pause();
                currentVideo = null;
            }
            if (!isPopupDragging) {
                hidePopupOnly();
            }
        }
    }

    function selectVideoOnDocumentClick(e) {
        console.log('[VCP Debug] Document click/touchend event detected on:', e.target);

        // Check if the click is within the popup or the circular icon itself.
        if ((popupElement && popupElement.contains(e.target)) || (circularIconElement && circularIconElement.contains(e.target))) {
            console.log('[VCP Debug] Click originated from within popup or icon. Skipping document-level selection logic.');
            return;
        }

        // If popup is currently visible AND click is outside, hide it.
        const computedStyle = window.getComputedStyle(popupElement);
        const isPopupCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0);
        if (isPopupCurrentlyVisible) {
            hidePopupOnly();
            console.log('[VCP Debug] Document click outside popup, hiding popup.');
        }

        // Try to select the clicked video directly if it's a video/audio element
        if (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO') {
            console.log('[VCP Debug] Direct click on video/audio element detected. Attempting to select it.');
            selectAndControlVideo(e.target);
            e.stopPropagation(); // Prevent default browser handling if we take over.
            e.preventDefault();
        } else {
            // If currentVideo exists but is no longer visible (e.g., scrolled off, element removed), deselect it.
            if (currentVideo && !checkCurrentVideoVisibility()) {
                console.log('[VCP Debug] Current video no longer visible on document click, pausing and hiding popup.');
                currentVideo.pause();
                currentVideo = null;
                hidePopupOnly();
            }
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            console.log('[VCP Debug] Scroll event handler triggered.');
            findAndSelectBestVideo();

            showCircularIcon();
            const computedStyle = window.getComputedStyle(popupElement);
            const isPopupCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0);
            if (isPopupCurrentlyVisible) {
                originalSetPopupVisibility(true);
                console.log('[VCP Debug] Popup was visible during scroll, re-positioning.');
            }
        }, 100);
    }

    function updateVideoList() {
        const currentPlayableVideos = findPlayableVideos();
        if (currentVideo && (!document.documentElement.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            console.log('[VCP Debug] Current video no longer valid or in DOM. Resetting currentVideo.');
            currentVideo = null;
        }
        console.log(`[VCP Debug] Video list updated. Found ${currentPlayableVideos.length} playable videos.`);
    }

    let popupStyleObserver = null;
    let iconStyleObserver = null;

    function setupPopupStyleObserver() {
        if (!popupElement) return;
        if (popupStyleObserver) popupStyleObserver.disconnect();
        popupStyleObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const computedStyle = window.getComputedStyle(popupElement);
                    const isCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0.01);
                    if (popupElement.dataset.vcpDesiredVisibility === 'visible' && !isCurrentlyVisible) {
                        console.warn('[VCP Debug] Popup style unexpectedly changed to hidden, forcing visible based on desired state.');
                        originalSetPopupVisibility(true);
                    }
                    else if (popupElement.dataset.vcpDesiredVisibility === 'hidden' && isCurrentlyVisible) {
                        console.warn('[VCP Debug] Popup style unexpectedly changed to visible, forcing hidden based on desired state.');
                        originalSetPopupVisibility(false);
                    }
                }
            });
        });
        popupStyleObserver.observe(popupElement, { attributes: true, attributeFilter: ['style'] });
        console.log('[VCP Debug] Popup style observer set up.');
    }

    function setupIconStyleObserver() {
        if (!circularIconElement) return;
        if (iconStyleObserver) iconStyleObserver.disconnect();
        iconStyleObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
                    const computedStyle = window.getComputedStyle(circularIconElement);
                    const isCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0.01);
                    if (!isCurrentlyVisible) {
                        console.warn('[VCP Debug] Icon style unexpectedly changed to hidden, forcing visible.');
                        setCircularIconVisibility();
                    }
                }
            });
        });
        circularIconElement.dataset.iconVisibilityDesired = 'visible';
        iconStyleObserver.observe(circularIconElement, { attributes: true, attributeFilter: ['style'] });
        console.log('[VCP Debug] Icon style observer set up.');
    }

    let mainDOMObserver = null;

    function setupDOMObserver() {
        const observerConfig = {
            childList: true,
            subtree: true,
            attributes: true, // Attributes are needed for style/class changes
            attributeFilter: ['style', 'class'] // Filter to relevant attributes for performance
        };
        const observerCallback = mutationsList => {
            let needsVideoListUpdate = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    // Check if popup/icon itself was removed
                    Array.from(mutation.removedNodes).forEach(node => {
                        if (popupElement && node.contains && node.contains(popupElement)) {
                             console.warn('[VCP] Popup element was removed from DOM. Re-inserting.');
                             document.documentElement.appendChild(popupElement);
                             setPopupVisibility(popupElement.dataset.vcpDesiredVisibility === 'visible');
                        } else if (circularIconElement && node.contains && node.contains(circularIconElement)) {
                             console.warn('[VCP] Circular icon element was removed from DOM. Re-inserting.');
                             document.documentElement.appendChild(circularIconElement);
                             showCircularIcon();
                        }
                    });

                    // Check for added/removed media elements or elements that might contain them
                    const addedOrRemovedMedia = Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) ||
                                                Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio'))));
                    if (addedOrRemovedMedia) {
                        needsVideoListUpdate = true;
                    }
                }
                // Also trigger update if style attributes change, as this might affect visibility.
                if (mutation.type === 'attributes' && (mutation.attributeName === 'style' || mutation.attributeName === 'class')) {
                    const targetElement = mutation.target;
                    if (targetElement.tagName === 'VIDEO' || targetElement.tagName === 'AUDIO' || targetElement.querySelector('video') || targetElement.querySelector('audio')) {
                        needsVideoListUpdate = true;
                    }
                }
            }
            if (needsVideoListUpdate) {
                if (_videoUpdateTimeout) clearTimeout(_videoUpdateTimeout);
                _videoUpdateTimeout = setTimeout(() => {
                    console.log('[VCP Debug] DOM changed (potential media update), re-evaluating videos.');
                    findAndSelectBestVideo();
                }, 200); // Debounce to avoid excessive calls
            }
        };

        if (mainDOMObserver) mainDOMObserver.disconnect();
        mainDOMObserver = new MutationObserver(observerCallback);
        mainDOMObserver.observe(document.documentElement, observerConfig);
        console.log('[VCP Debug] Main DOM observer set up.');
    }

    function setupSPADetection() {
        let lastUrl = location.href;
        const originalPushState = history.pushState;
        history.pushState = function() {
            originalPushState.apply(this, arguments);
            window.dispatchEvent(new Event('pushstate'));
            console.log('[VCP Debug] History pushState detected.');
        };
        const originalReplaceState = history.replaceState;
        history.replaceState = function() {
            originalReplaceState.apply(this, arguments);
            window.dispatchEvent(new Event('replacestate'));
            console.log('[VCP Debug] History replaceState detected.');
        };

        window.addEventListener('popstate', handleUrlChange);
        window.addEventListener('pushstate', handleUrlChange);
        window.addEventListener('replacestate', handleUrlChange);
        console.log('[VCP Debug] SPA detection set up.');

        function handleUrlChange() {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                console.log(`[VCP Debug] URL changed: ${currentUrl}, resetting and re-initializing.`);
                resetAndInitialize();
            }
        }
    }

    function resetAndInitialize() {
        isInitialized = false;
        if (popupStyleObserver) { popupStyleObserver.disconnect(); popupStyleObserver = null; }
        if (iconStyleObserver) { iconStyleObserver.disconnect(); iconStyleObserver = null; }
        if (mainDOMObserver) { mainDOMObserver.disconnect(); mainDOMObserver = null; }

        const existingIcon = document.getElementById('video-controller-circular-icon');
        if (existingIcon && existingIcon.parentNode) {
            existingIcon.parentNode.removeChild(existingIcon);
        }
        const existingPopup = document.getElementById('video-controller-popup');
        if (existingPopup && existingPopup.parentNode) {
            existingPopup.parentNode.removeChild(existingPopup);
        }
        circularIconElement = null;
        popupElement = null;
        currentVideo = null;
        videos = [];
        isPopupDragging = false;

        console.log('[VCP Debug] Script reset and re-initializing.');
        initialize();
    }

    function enforceVisibilityPeriodically() {
        if (!circularIconElement || !document.documentElement.contains(circularIconElement)) {
            createCircularIconElement();
            showCircularIcon();
            setupIconStyleObserver();
            console.log('[VCP Debug] Enforce: Circular icon re-created/re-displayed.');
        } else {
            const computedStyle = window.getComputedStyle(circularIconElement);
            const isCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0.01);
            if (!isCurrentlyVisible) {
                setCircularIconVisibility();
                showCircularIcon();
                console.log('[VCP Debug] Enforce: Circular icon forced visible.');
            }
        }

        if (!popupElement || !document.documentElement.contains(popupElement)) {
            createPopupElement();
            // setPopupVisibility(popupElement.dataset.vcpDesiredVisibility === 'visible'); // This will call originalSetPopupVisibility
            // Instead, directly control display/visibility to avoid loop, and let originalSetPopupVisibility handle content
            popupElement.style.display = (popupElement.dataset.vcpDesiredVisibility === 'visible') ? 'block' : 'none';
            popupElement.style.visibility = (popupElement.dataset.vcpDesiredVisibility === 'visible') ? 'visible' : 'hidden';
            popupElement.style.opacity = (popupElement.dataset.vcpDesiredVisibility === 'visible') ? '0.9' : '0';
            setupPopupStyleObserver();
            console.log('[VCP Debug] Enforce: Popup element re-created/re-displayed based on desired state.');
        } else {
            const computedStyle = window.getComputedStyle(popupElement);
            const isCurrentlyVisible = (computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden' && parseFloat(computedStyle.opacity) > 0.01);

            if (popupElement.dataset.vcpDesiredVisibility === 'visible' && !isCurrentlyVisible) {
                originalSetPopupVisibility(true);
                console.warn('[VCP Debug] Enforce: Popup forced to desired visible state.');
            } else if (popupElement.dataset.vcpDesiredVisibility === 'hidden' && isCurrentlyVisible) {
                originalSetPopupVisibility(false);
                console.warn('[VCP Debug] Enforce: Popup forced to desired hidden state.');
            }
        }
    }


    function initialize() {
        if (isInitialized) {
            console.log('[VCP Debug] Already initialized, skipping.');
            return;
        }
        isInitialized = true;
        console.log('[VCP Debug] Initialization started.');

        try {
            createPopupElement();
            createCircularIconElement();

            setPopupVisibility(false);
            showCircularIcon();

            setupPopupStyleObserver();
            setupIconStyleObserver();
            setupDOMObserver(); // DOM Observer is critical for dynamic content
            setupSPADetection();

            // Periodically check visibility and re-trigger video detection
            setInterval(() => {
                enforceVisibilityPeriodically();
                findAndSelectBestVideo(); // Re-evaluate best video more frequently
            }, 500);


            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            document.addEventListener('fullscreenchange', handleFullscreenChange);

            window.removeEventListener('resize', handleResize);
            window.addEventListener('resize', handleResize);

            // Scroll event already triggers findAndSelectBestVideo
            window.removeEventListener('scroll', handleScrollEvent);
            window.addEventListener('scroll', handleScrollEvent);

            document.removeEventListener('click', selectVideoOnDocumentClick, true);
            document.removeEventListener('touchend', selectVideoOnDocumentClick, true);
            document.addEventListener('click', selectVideoOnDocumentClick, true);
            document.addEventListener('touchend', selectVideoOnDocumentClick, true);

            window.removeEventListener('beforeunload', handleBeforeUnload);
            window.addEventListener('beforeunload', handleBeforeUnload);

            findAndSelectBestVideo(); // Initial detection
            console.log('[VCP Debug] Initialization complete.');

        } catch (e) {
            console.error('[VCP] Initialization failed fatally:', e);
            alert('Video Controller Popup script encountered a critical error during initialization. Please check your browser console for details.');
        }
    }

    function handleFullscreenChange() {
        const fsEl = document.fullscreenElement;
        if (!fsEl) {
            enforceVisibilityPeriodically();
            console.log('[VCP Debug] Fullscreen exited, enforcing visibility.');
        }
    }

    function handleResize() {
        setPopupVisibility(popupElement.dataset.vcpDesiredVisibility === 'visible');
        showCircularIcon();
        console.log('[VCP Debug] Window resized, re-positioning popup and icon.');
    }

    function handleBeforeUnload() {
        currentVideo = null;
        if (popupStyleObserver) popupStyleObserver.disconnect();
        if (iconStyleObserver) iconStyleObserver.disconnect();
        if (mainDOMObserver) mainDOMObserver.disconnect();

        document.removeEventListener('fullscreenchange', handleFullscreenChange);
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('scroll', handleScrollEvent);
        document.removeEventListener('click', selectVideoOnDocumentClick, true);
        document.removeEventListener('touchend', selectVideoOnDocumentClick, true);
        window.removeEventListener('beforeunload', handleBeforeUnload);

        isInitialized = false;
        console.log('[VCP Debug] Before unload: Script cleaned up.');
    }

    // Ensure initialization happens as early as possible or after DOM is ready
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }
})();
