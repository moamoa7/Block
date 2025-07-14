// ==UserScript==
// @name Video Controller Popup (V4.10.21: Stable Popup & AutoSwitch)
// @namespace Violentmonkey Scripts
// @version 4.10.21_StablePopup_AutoSwitch_ResetButton_FixedUI
// @description Optimized video controls with stable, click-activated popup. Automatically switches video selection on scroll.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let rateFixIntervalId = null;
    let videos = [];
    let currentVideo = null;
    let popupElement = null;
    let desiredPlaybackRate = 1.0;
    let videoObserver = null;
    let isPopupDragging = false;
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;
    let currentVideoContainer = null;

    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;

    // --- Environment Flags & Configuration ---
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // Sites where we aggressively block initial popup appearance (e.g., sooplive.co.kr)
    const SITE_POPUP_BLOCK_LIST = [
        'sooplive.co.kr',
        'twitch.tv',
        'kick.com'
    ];
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));

    // Blacklists for specific functionality
    const lazySrcBlacklist = ['missav.ws', 'missav.live'];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));
    const AMPLIFICATION_BLACKLIST = ['avsee.ru'];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // --- Audio Context for Volume Amplification ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    // --- Utility Functions ---

    // Function to recursively find video/audio elements, including those in Shadow DOMs.
    function findAllVideosDeep(root = document) {
        const found = [];
        root.querySelectorAll('video, audio').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found.push(...findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    }

    /**
     * Finds playable video elements based on visibility and size.
     */
    function findPlayableVideos() {
        const found = findAllVideosDeep();

        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();

            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (v.videoWidth > 0 || v.videoHeight > 0 || isMedia) &&
                (rect.width > 50 || rect.height > 50 || isMedia)
            );
        });

        videos = playableVideos;
        return playableVideos;
    }

    /**
     * Calculates the visibility score (intersection area) of a video within the viewport.
     */
    function getVideoVisibilityScore(video) {
        if (!video) return 0;
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        const intersectionTop = Math.max(0, rect.top);
        const intersectionBottom = Math.min(viewportHeight, rect.bottom);
        const intersectionLeft = Math.max(0, rect.left);
        const intersectionRight = Math.min(viewportWidth, rect.right);

        if (intersectionBottom <= intersectionTop || intersectionRight <= intersectionLeft) {
            return 0;
        }

        const intersectionArea = (intersectionBottom - intersectionTop) * (intersectionRight - intersectionLeft);
        const videoArea = rect.width * rect.height;

        return videoArea > 0 ? intersectionArea / videoArea : 0;
    }

    /**
     * Selects the most prominent video based on visibility.
     * This function is crucial for 'auto-switching' when scrolling.
     */
    function selectActiveVideo() {
        findPlayableVideos();
        let bestVideo = null;
        let maxScore = 0;

        videos.forEach(video => {
            const score = getVideoVisibilityScore(video);

            let currentScore = score;
            // Prioritize playing video
            if (!video.paused) {
                currentScore += 1;
            }

            if (currentScore > maxScore) {
                bestVideo = video;
                maxScore = currentScore;
            }
        });

        if (bestVideo && bestVideo !== currentVideo) {
            // Switch currentVideo only if a new, better video is found.
            currentVideo = bestVideo;

            // Initialize speed if not already done
            if (!currentVideo._vcpSpeedInitialized && typeof currentVideo.playbackRate !== 'undefined') {
                fixPlaybackRate(currentVideo, 1.0);
                currentVideo._vcpSpeedInitialized = true;
            } else if (typeof currentVideo.playbackRate !== 'undefined') {
                desiredPlaybackRate = currentVideo.playbackRate;
            }

            updatePopupSliders();
            console.log('[VCP] Automatically switched video selection based on visibility/playback.');

        } else if (!bestVideo && currentVideo) {
            // If the current video is no longer visible and no other videos are found, deselect.
            if (getVideoVisibilityScore(currentVideo) === 0) {
                currentVideo = null;
                // If a video is deselected, hide the popup.
                hidePopup();
            }
        }
    }

    function fixPlaybackRate(video, rate) {
        if (!video) return;

        desiredPlaybackRate = rate;
        video.playbackRate = rate;

        if (rateFixIntervalId) {
            clearInterval(rateFixIntervalId);
        }

        if (video._rateChangeHandler) {
            video.removeEventListener('ratechange', video._rateChangeHandler);
            video._rateChangeHandler = null;
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video.addEventListener('ratechange', rateChangeHandler);
        video._rateChangeHandler = rateChangeHandler;

        rateFixIntervalId = setInterval(() => {
            if (document.body.contains(video) && video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            } else if (!document.body.contains(video)) {
                clearInterval(rateFixIntervalId);
                rateFixIntervalId = null;
                if (video._rateChangeHandler) {
                    video.removeEventListener('ratechange', video._rateChangeHandler);
                    video._rateChangeHandler = null;
                }
            }
        }, 200);
    }

    function setupAudioContext(video) {
        if (isAmplificationBlocked || !video) {
            return false;
        }

        try {
            if (sourceNode) sourceNode.disconnect();
            if (gainNode) gainNode.disconnect();

            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (!video._audioSourceNode) {
                video._audioSourceNode = audioCtx.createMediaElementSource(video);
            }

            sourceNode = video._audioSourceNode;
            gainNode = audioCtx.createGain();

            sourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            connectedVideo = video;
            return true;
        } catch (e) {
            console.error("Failed to setup AudioContext for amplification:", e);
            audioCtx = gainNode = sourceNode = connectedVideo = null;
            return false;
        }
    }

    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        if (isAmplificationBlocked && vol > 1) {
            video.volume = 1;
            if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
            return;
        }

        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
        }

        if (vol <= 1) {
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;   // 사용자가 조정한 볼륨으로 맞춤
            video.muted = false;  // 무조건 무트 해제
        } else {
            if (video.muted) {
                video.muted = false;
            }

            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    video.volume = 1;
                    return;
                }
            }

            if (gainNode) {
                video.volume = 1;
                gainNode.gain.value = vol;
            }
        }
    }

    function setupVideoDragging(video) {
        if (!video || video._draggingSetup) return;
        video._draggingSetup = true;
    }

    // --- Popup UI Functions ---

    function createPopupElement() {
        if (popupElement) return;

        // 1. Create the container element and apply base styles
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        // VCP_MOD: Set a fixed width and overflow: hidden to prevent UI resizing on button click
        popupElement.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
            display: none !important; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: 230px; /* Fixed width for UI stability */
            overflow: hidden; /* Hide any overflow */
            text-align: center;
        `;
        // END VCP_MOD

        // 2. Create the internal structure using direct DOM manipulation
        const buttonStyle = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;
        const dragHandleStyle = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.style.cssText = dragHandleStyle;
        dragHandle.textContent = '비디오.오디오 컨트롤러';

        const controlsWrapper = document.createElement('div');
        controlsWrapper.style.cssText = 'padding: 10px;';

        const playPauseSection = document.createElement('div');
        playPauseSection.style.cssText = 'display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;';
        const playPauseButton = document.createElement('button');
        playPauseButton.setAttribute('data-action', 'play-pause');
        playPauseButton.style.cssText = buttonStyle;
        playPauseButton.textContent = '재생/멈춤';
        playPauseSection.appendChild(playPauseButton);

        // Add Reset Button
        const resetButton = document.createElement('button');
        resetButton.setAttribute('data-action', 'reset-speed-volume');
        resetButton.style.cssText = buttonStyle;
        resetButton.textContent = '재설정';
        playPauseSection.appendChild(resetButton);
        // END VCP_MOD

        const speedSection = document.createElement('div');
        speedSection.style.cssText = 'margin-bottom: 10px;';
        const speedLabel = document.createElement('label');
        speedLabel.htmlFor = 'vcp-speed';
        speedLabel.style.cssText = 'display: block; margin-bottom: 5px;';
        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.0';
        speedLabel.textContent = '배속 조절: ';
        speedLabel.appendChild(speedDisplay);
        speedLabel.appendChild(document.createTextNode('x'));
        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.20';
        speedInput.max = '5.0';
        speedInput.step = '0.2';
        speedInput.value = '1.0';
        speedInput.style.cssText = 'width: 100%; cursor: pointer;';
        speedSection.appendChild(speedLabel);
        speedSection.appendChild(speedInput);

        const volumeSection = document.createElement('div');
        volumeSection.style.cssText = 'margin-bottom: 10px;';
        const volumeLabel = document.createElement('label');
        volumeLabel.htmlFor = 'vcp-volume';
        volumeLabel.style.cssText = 'display: block; margin-bottom: 5px;';
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
        volumeInput.max = '5.0';
        volumeInput.step = '0.05';
        volumeInput.value = '1.0';
        volumeInput.style.cssText = 'width: 100%; cursor: pointer;';
        volumeSection.appendChild(volumeLabel);
        volumeSection.appendChild(volumeInput);

        const actionSection = document.createElement('div');
        actionSection.style.cssText = 'margin-bottom: 10px;';

        const pipButton = document.createElement('button');
        pipButton.setAttribute('data-action', 'pip');
        pipButton.style.cssText = buttonStyle + '; margin-top: 5px;';
        pipButton.textContent = 'PIP 모드';

        const exitFullscreenButton = document.createElement('button');
        exitFullscreenButton.setAttribute('data-action', 'exit-fullscreen');
        exitFullscreenButton.style.cssText = buttonStyle + '; margin-top: 5px;';
        exitFullscreenButton.textContent = '전체 종료';

        const statusDiv = document.createElement('div');
        statusDiv.id = 'vcp-status';
        statusDiv.style.cssText = 'margin-top: 10px; font-size: 12px; color: #777;';
        statusDiv.textContent = 'Status: Ready';

        actionSection.appendChild(pipButton);
        actionSection.appendChild(exitFullscreenButton);
        actionSection.appendChild(statusDiv);

        controlsWrapper.appendChild(playPauseSection);
        controlsWrapper.appendChild(speedSection);
        controlsWrapper.appendChild(volumeSection);
        controlsWrapper.appendChild(actionSection);

        popupElement.appendChild(dragHandle);
        popupElement.appendChild(controlsWrapper);

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    // 3. Set up event listeners for controls and drag handle
    function setupPopupEventListeners() {
        if (!popupElement) return;

        popupElement.addEventListener('click', (e) => {
            resetPopupHideTimer();
            const target = e.target;
            const action = target.getAttribute('data-action');

            if (!currentVideo) {
                updateStatus('No video selected.');
                return;
            }

            switch (action) {
                case 'play-pause':
                    if (currentVideo.paused) {
                        currentVideo.play();
                        updateStatus('Playing');
                    } else {
                        currentVideo.pause();
                        updateStatus('Paused');
                    }
                    break;
                case 'reset-speed-volume':
                    if (typeof currentVideo.playbackRate !== 'undefined') {
                        fixPlaybackRate(currentVideo, 1.0);
                    }
                    if (typeof currentVideo.volume !== 'undefined') {
                        setAmplifiedVolume(currentVideo, 1.0);
                    }
                    updatePopupSliders(); // Update UI sliders after resetting
                    updateStatus('1.0x Speed and 100% Volume');
                    break;
                case 'pip':
                    if (document.pictureInPictureElement) {
                        document.exitPictureInPicture().catch(e => console.error(e));
                        updateStatus('Exiting PIP');
                    } else if (document.pictureInPictureEnabled && currentVideo.requestPictureInPicture) {
                        currentVideo.requestPictureInPicture().catch(e => console.error(e));
                        updateStatus('Entering PIP');
                    }
                    break;
                case 'exit-fullscreen':
                    if (document.fullscreenElement) {
                        document.exitFullscreen();
                    } else if (document.webkitFullscreenElement) {
                        document.webkitExitFullscreen();
                    }
                    break;
            }
        });

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        speedInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            speedDisplay.textContent = rate.toFixed(2);
            if (currentVideo) {
                fixPlaybackRate(currentVideo, rate);
                updateStatus(`Speed: ${rate.toFixed(2)}x`);
            }
        });

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        volumeInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            volumeDisplay.textContent = Math.round(vol * 100);
            if (currentVideo) {
                setAmplifiedVolume(currentVideo, vol);
                updateStatus(`Volume: ${Math.round(vol * 100)}%`);
            }
        });

        // Popup dragging setup (Attached ONLY to the handle)
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
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;

            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);

            if (clientX === undefined || clientY === undefined) return;

            let newX = clientX - popupDragOffsetX;
            let newY = clientY - popupDragOffsetY;

            popupElement.style.left = `${newX}px`;
            popupElement.style.top = `${newY}px`;
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag);

        document.addEventListener('mousemove', dragPopup);
        document.addEventListener('touchmove', dragPopup);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    // 4. Status update helper
    function updateStatus(message) {
        const statusElement = popupElement.querySelector('#vcp-status');
        if (statusElement) {
            statusElement.textContent = `Status: ${message}`;
            statusElement.style.opacity = 1;
            setTimeout(() => statusElement.style.opacity = 0.7, 2000);
        }
    }

    // 5. Show/Hide popup logic
    function showPopup() {
        if (popupElement) {
            popupElement.style.removeProperty('display');
            popupElement.style.display = 'block';
        }
    }

    function hidePopup() {
        if (popupElement) {
            // Use !important for aggressive hiding on blocked sites, otherwise standard none.
            if (isInitialPopupBlocked && !isPopupDragging) {
                 popupElement.style.setProperty('display', 'none', 'important');
            } else {
                popupElement.style.display = 'none';
            }
        }
    }

    // 6. Temporary visibility functions
    function resetPopupHideTimer() {
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
        }
        // Only start timer if popup is not being dragged
        if (!isPopupDragging) {
             popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    /**
     * Shows the popup and resets the hide timer.
     * This function is only called when the user interacts (e.g., clicks the page or controls).
     */
    function showPopupTemporarily() {
        if (popupElement && currentVideo) {
            showPopup();
            updatePopupPosition();
            resetPopupHideTimer();
        }
    }

    // 7. Update popup position relative to the current video
    function updatePopupPosition() {
        if (!popupElement || !currentVideo || isPopupDragging) {
            // If dragging, don't update position based on video. If no video, hide popup if visible.
            if (!currentVideo && popupElement) hidePopup();
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                               videoRect.left < window.innerWidth && videoRect.right > 0;

        // VCP_FIX: Do not automatically show the popup here. Only update position if already visible.
        if (isVideoVisible) {
            const viewportX = videoRect.left + videoRect.width / 2 - (popupRect.width / 2);
            const viewportY = videoRect.top + videoRect.height / 2 - (popupRect.height / 2);

            popupElement.style.left = `${viewportX}px`;
            popupElement.style.top = `${viewportY}px`;
            popupElement.style.transform = 'none';
            popupElement.style.position = 'fixed';

            // If the popup is currently visible, ensure the timer is reset if the user interacts.
            // Note: We rely on the selectActiveVideo() interval to ensure currentVideo is correct during scroll.
        } else {
            // If the video is not visible, hide the popup.
            hidePopup();
        }
    }

    // --- Multiple Video Control (New/Updated logic) ---

    function setupVideoHover() {} // Empty function to prevent hover activation

    /**
     * VCP_MOD: Function to handle video selection when a click occurs (Click to Activate).
     */
    function selectVideoOnDocumentClick(e) {
        // If the click is inside the popup, ignore it
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        // Find the clicked element's closest video ancestor
        let targetVideo = null;
        let clickedElement = e.target;

        while (clickedElement && clickedElement !== document.body) {
            if (clickedElement.tagName === 'VIDEO' || clickedElement.tagName === 'AUDIO') {
                targetVideo = clickedElement;
                break;
            }
            clickedElement = clickedElement.parentElement || clickedElement.parentNode;
        }

        // 1. If a video was clicked, use that video.
        if (targetVideo && videos.includes(targetVideo)) {
            currentVideo = targetVideo;
            console.log('[VCP] Video selected via direct click.');
        } else {
            // 2. If the click was not directly on a video, select the most visible video on the page.
            // This is especially useful for sites like Sooplive where the main player might not be a 'video' tag.
            selectActiveVideo();
             if (!currentVideo) {
                 console.log('[VCP] Click activation failed: No playable videos found.');
                 hidePopup();
                 return;
             }
        }

        // 3. If we found a video, set it up and show the popup.
        if (currentVideo) {
            setupVideoDragging(currentVideo);

            if (typeof currentVideo.playbackRate !== 'undefined') {
                if (!currentVideo._vcpSpeedInitialized) {
                    fixPlaybackRate(currentVideo, 1.0);
                    currentVideo._vcpSpeedInitialized = true;
                } else {
                    desiredPlaybackRate = currentVideo.playbackRate;
                }
            }

            updatePopupSliders();
            showPopupTemporarily();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (typeof currentVideo.playbackRate !== 'undefined') {
            const rate = currentVideo.playbackRate || 1.0;
            if (speedInput) {
                speedInput.value = rate.toFixed(2);
            }
            if (speedDisplay) {
                speedDisplay.textContent = rate.toFixed(2);
            }
        }

        if (typeof currentVideo.volume !== 'undefined') {
            let volume = currentVideo.volume;
            if (gainNode && connectedVideo === currentVideo) {
                volume = gainNode.gain.value;
            }

            if (volumeInput) {
                volumeInput.value = volume.toFixed(2);
            }
            if (volumeDisplay) {
                volumeDisplay.textContent = Math.round(volume * 100);
            }
        }
    }

    // --- Main Initialization ---

    function updateVideoList(shouldSelect = false) {
        findPlayableVideos();

        // If shouldSelect is true (used for initial load or manual refresh), select the most active video.
        if (shouldSelect) {
            selectActiveVideo();
        } else {
            // Otherwise, check if the current video is still valid.
            if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
                currentVideo = null;
                hidePopup();
            }
        }
    }

    function setupVideoObserver() {
        const observerConfig = { childList: true, subtree: true };

        const observerCallback = (mutationsList) => {
            let foundChanges = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    const addedNodes = Array.from(mutation.addedNodes);
                    const removedNodes = Array.from(mutation.removedNodes);

                    const containsMedia = (nodes) => nodes.some(node =>
                        node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' ||
                        (node.nodeType === 1 && (node.querySelector('video') || node.querySelector('audio') || node.shadowRoot))
                    );

                    if (containsMedia(addedNodes) || containsMedia(removedNodes)) {
                        foundChanges = true;
                        break;
                    }
                }
            }

            if (foundChanges) {
                // When DOM changes, update list and select active video automatically.
                updateVideoList(true);
            }
        };

        videoObserver = new MutationObserver(observerCallback);
        videoObserver.observe(document.body, observerConfig);
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selector: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
        ];
        const overflowFixTargets = overflowFixSites.filter(site => location.hostname.includes(site.domain));

        overflowFixTargets.forEach(site => {
            site.selector.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.overflow = 'visible';
                });
            });
        });
    }

    function initialize() {
        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.21');

        createPopupElement();

        // Ensure popup is hidden initially, especially on blocked sites.
        hidePopup();

        // Attach fullscreen event handler
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                } else {
                    document.body.appendChild(popupElement);
                }
            }
        });

        // 1. Initial video list update (and selection of active video)
        updateVideoList(true);

        // 2. Setup observer for dynamic content changes
        setupVideoObserver();

        // 3. Setup periodic checks and visibility updates
        // Periodically select the active video (for auto-switching on scroll).
        setInterval(selectActiveVideo, 1000);
        // Periodically update popup position (if the popup is visible).
        setInterval(updatePopupPosition, 100);

        // 4. Apply overflow fixes for specific sites
        fixOverflow();

        // 5. Add the click listener to the document body for manual activation
        document.body.addEventListener('click', selectVideoOnDocumentClick, true);
    }

    // Initialize the script
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
