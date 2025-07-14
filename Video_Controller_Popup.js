// ==UserScript==
// @name Video Controller Popup (V4.10.36: TrustedHTML Patched, Volume Fixed, IntersectionObserver, Speed 0.0-5.0, AutoplaySound)
// @namespace Violentmonkey Scripts
// @version 4.10.36_TrustedHTML_VolumeFixed_v16_AutoplaySound
// @description Optimized video controls using IntersectionObserver for visibility detection, single video autoplay, and adjustable speed from 0.0x to 5.0x. Ensures videos play sound by default.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [];
    let currentVideo = null;
    let popupElement = null;
    let desiredPlaybackRate = 1.0;
    let desiredVolume = 1.0;
    let videoObserver = null;
    let isPopupDragging = false;
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;
    let isInitialized = false;

    // Stores visibility data for each video tracked by IntersectionObserver
    const intersectionEntries = new Map();

    // Flag to track if the user has manually paused the current video via the UI or site controls.
    let isManuallyPaused = false;

    // WeakMap to store ratechange handlers for video elements.
    const videoRateHandlers = new WeakMap();

    // --- Configuration Changes ---
    // Changed popup timeout from 3000ms to 2000ms (2 seconds)
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    // -----------------------------

    // --- Environment Flags & Configuration ---
    const SITE_POPUP_BLOCK_LIST = [
        'sooplive.co.kr',
        'twitch.tv',
        'kick.com'
    ];
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));

    const lazySrcBlacklist = ['missav.ws', 'missav.live'];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));
    const AMPLIFICATION_BLACKLIST = ['avsee.ru'];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // --- Audio Context for Volume Amplification ---
    let audioCtx = null;
    let gainNode = null;
    let connectedVideo = null; // Tracks which video is connected to the AudioContext

    // --- Utility Functions ---

    /**
     * Recursively finds video/audio elements, including those in Shadow DOMs.
     */
    function findAllVideosDeep(root = document) {
        const found = [];
        const videoElements = new Set();

        root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));

        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                findAllVideosDeep(el.shadowRoot).forEach(v => videoElements.add(v));
            }
        });

        return Array.from(videoElements);
    }

    /**
     * Finds playable video elements based on visibility, size, and readiness state, and handles lazy loading.
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

        // Filter criteria: Prioritize elements that are likely video players.
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();

            // Check for visibility and basic size.
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;

            // Check if the video element has a reasonable size or is actively playing.
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;

            // Ensure the video element is part of the document and has media capabilities
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;

            return isVisible && isReasonableSize && hasMedia;
        });

        videos = playableVideos;
        return playableVideos;
    }

    /**
     * Handles IntersectionObserver entries to determine the most visible video.
     */
    function handleIntersection(entries) {
        let bestVideo = null;
        let maxIntersectionRatio = 0;

        // Update the intersectionEntries map and find the video with the highest intersection ratio
        entries.forEach(entry => {
            const video = entry.target;
            intersectionEntries.set(video, entry.intersectionRatio);
        });

        // Find the best video from all currently observed videos (not just the ones that just changed)
        intersectionEntries.forEach((ratio, video) => {
            if (ratio > maxIntersectionRatio) {
                maxIntersectionRatio = ratio;
                bestVideo = video;
            }
        });

        // We only want to auto-play a video if it's visible by at least 10%
        if (maxIntersectionRatio > 0.1) {
            enforceSingleVisibleVideoPlayback(bestVideo);
        } else if (currentVideo) {
            // If the best video is no longer visible (or there's no best video), pause the current one.
            currentVideo.pause();
            isManuallyPaused = true; // Treat scrolling away as a "manual" pause until a new video is selected or the user clicks
            currentVideo = null;
            hidePopup();
        }
    }

    /**
     * Sets up the IntersectionObserver for all detected videos.
     */
    function setupIntersectionObserver() {
        // Disconnect existing observer if it exists
        if (videoObserver) {
            videoObserver.disconnect();
        }

        // Initialize IntersectionObserver.
        const options = {
            root: null, // relative to the viewport
            rootMargin: '0px',
            threshold: [0, 0.1, 0.5, 0.75, 1.0]
        };

        videoObserver = new IntersectionObserver(handleIntersection, options);
    }

    /**
     * Observes newly found playable videos.
     */
    function observeVideos() {
        videos.forEach(video => {
            // Ensure muted is false when observing the video to allow sound
            video.muted = false;

            // Check if the video is already observed before observing
            const isObserved = videoObserver.takeRecords().some(record => record.target === video);
            if (!isObserved) {
                videoObserver.observe(video);
                // Initialize intersection entry for new videos
                intersectionEntries.set(video, 0);
            }
        });

        // Remove intersection entries for videos that are no longer in the videos list (e.g., removed from DOM)
        intersectionEntries.forEach((ratio, video) => {
            if (!videos.includes(video)) {
                videoObserver.unobserve(video);
                intersectionEntries.delete(video);
            }
        });
    }

    /**
     * Plays the most visible video (if not manually paused) and pauses all others.
     */
    function enforceSingleVisibleVideoPlayback(visibleVideo) {
        if (!visibleVideo) {
            if (currentVideo) {
                currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }
            return;
        }

        // Pause all other videos
        videos.forEach(video => {
            if (video !== visibleVideo && !video.paused) {
                video.pause();
            }
        });

        // If the most visible video is different from the current video, or if we haven't selected one yet
        if (visibleVideo !== currentVideo) {
            currentVideo = visibleVideo;
            console.log('[VCP] Switched to most visible video. Resetting controls.');

            // Reset speed and volume for the newly selected video
            if (typeof currentVideo.playbackRate !== 'undefined') {
                fixPlaybackRate(currentVideo, 1.0);
            }
            if (typeof currentVideo.volume !== 'undefined') {
                setAmplifiedVolume(currentVideo, 1.0);
            }

            // Ensure sound is active for the current video
            currentVideo.muted = false;

            // Reset manual pause state when switching videos
            isManuallyPaused = false;

            // Initialize playback if not already playing and not manually paused
            if (currentVideo.paused) {
                currentVideo.play().catch(e => console.error("Autoplay failed:", e));
            }
        } else if (currentVideo && currentVideo.paused && !isManuallyPaused) {
            // If the current video is the same, but was somehow paused (e.g., by scrolling away briefly and back),
            // and the user didn't manually pause it, try to resume.
            currentVideo.play().catch(e => console.error("Autoplay resume failed:", e));
        }

        updatePopupSliders();
        updatePopupPosition();
        showPopupTemporarily();
    }


    /**
     * Ensures the video playback rate remains fixed at the desired speed using a 'ratechange' listener.
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;

        desiredPlaybackRate = rate;

        // 1. Remove existing listener if present using WeakMap
        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) {
            video.removeEventListener('ratechange', existingHandler);
        }

        // 2. Define the new ratechange handler
        const rateChangeHandler = () => {
            // If the playback rate is changed by the site, reset it to the desired rate.
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
                console.log(`[VCP] Fixed playback rate to ${desiredPlaybackRate}`);
            }
        };

        // 3. Apply the rate, add the listener, and store in WeakMap
        video.playbackRate = rate;
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
    }

    // --- Audio Context & Volume Amplification ---

    /**
     * Sets up the Web Audio API context and gain node for volume amplification.
     */
    function setupAudioContext(video) {
        if (isAmplificationBlocked || !video) {
            return false;
        }

        try {
            // Create AudioContext if it doesn't exist
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            // Ensure AudioContext is running (important for some browsers like Chrome)
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(e => console.error("AudioContext resume error in setup:", e));
            }

            // Disconnect previous connections if they exist and are related to this video
            if (video._audioSourceNode) {
                video._audioSourceNode.disconnect();
                video._audioSourceNode = null;
            }
            if (gainNode) gainNode.disconnect();

            // Create a MediaElementSource Node for the video element
            video._audioSourceNode = audioCtx.createMediaElementSource(video);

            // Create a Gain Node for volume control
            gainNode = audioCtx.createGain();

            // Connect the source to the gain node, and the gain node to the destination (speakers)
            video._audioSourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            // Set the video's own volume to 1.0 so that all volume control is handled by gainNode.
            video.volume = 1.0;
            video.muted = false; // Ensure it's unmuted when using AudioContext

            connectedVideo = video;
            return true;
        } catch (e) {
            console.error("Failed to setup AudioContext for amplification:", e);
            audioCtx = gainNode = connectedVideo = null;
            return false;
        }
    }

    /**
     * Controls video volume, utilizing amplification via AudioContext if volume > 1.
     */
    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        // Update desiredVolume to the current setting
        desiredVolume = vol;

        // Ensure the video is not muted regardless of volume level
        video.muted = false;

        if (isAmplificationBlocked && vol > 1) {
            video.volume = 1;
            if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
            return;
        }

        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
        }

        // Handle standard volume (0.0 to 1.0)
        if (vol <= 1) {
            if (gainNode && connectedVideo === video) {
                // If using amplification but volume is <= 1, set gain to 1 and control via video.volume.
                gainNode.gain.value = 1;
                video.volume = vol;
            } else {
                video.volume = vol;
            }
        } else {
            // Handle amplified volume (> 1.0)

            // Setup AudioContext if not already configured for this video
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    video.volume = 1;
                    return; // Cannot amplify, set to max standard volume.
                }
            }

            // When amplifying, set video.volume to 1.0 and control gain via gainNode.
            if (gainNode) {
                video.volume = 1;
                gainNode.gain.value = vol;
            }
        }
    }

    // --- Popup UI Functions ---

    /**
     * Creates the popup UI element using standard DOM methods (document.createElement) to avoid TrustedHTML errors.
     */
    function createPopupElement() {
        if (popupElement) return;

        // Define styles for reuse
        const buttonStyle = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;
        const dragHandleStyle = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;
        const sectionStyle = `margin-bottom: 10px;`;
        const inputStyle = `width: 100%; cursor: pointer;`;
        const labelStyle = `display: block; margin-bottom: 5px;`;
        const flexCenterStyle = `display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;`;

        // 1. Create the main container element
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif;
            z-index: 2147483647; /* Maximize z-index to ensure visibility */
            display: none; opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: 230px; overflow: hidden; text-align: center;
            pointer-events: auto;
        `;

        // 2. Create Drag Handle
        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = dragHandleStyle;
        dragHandle.style.cursor = 'grab'; // Ensure grab cursor is default
        popupElement.appendChild(dragHandle);

        // 3. Create Controls Container
        const controlsContainer = document.createElement('div');
        controlsContainer.style.padding = '10px';

        // --- Play/Pause & Reset Buttons ---
        const buttonGroup1 = document.createElement('div');
        buttonGroup1.style.cssText = flexCenterStyle;

        const btnPlayPause = document.createElement('button');
        btnPlayPause.textContent = '재생/멈춤';
        btnPlayPause.setAttribute('data-action', 'play-pause');
        btnPlayPause.style.cssText = buttonStyle;

        const btnReset = document.createElement('button');
        btnReset.textContent = '재설정';
        btnReset.setAttribute('data-action', 'reset-speed-volume');
        btnReset.style.cssText = buttonStyle;

        buttonGroup1.appendChild(btnPlayPause);
        buttonGroup1.appendChild(btnReset);
        controlsContainer.appendChild(buttonGroup1);

        // --- Speed Control Section ---
        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.cssText = sectionStyle;

        const speedLabel = document.createElement('label');
        speedLabel.htmlFor = 'vcp-speed';
        speedLabel.style.cssText = labelStyle;
        speedLabel.textContent = '배속 조절: ';

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedLabel.appendChild(speedDisplay);
        speedLabel.append('x');

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';

        // Speed range: 0.0 to 5.0 (0.2 step)
        speedInput.min = '0.0';
        speedInput.max = '5.0';
        speedInput.step = '0.2';
        speedInput.value = '1.0';

        speedInput.style.cssText = inputStyle;

        speedSection.appendChild(speedLabel);
        speedSection.appendChild(speedInput);
        controlsContainer.appendChild(speedSection);

        // --- Volume Control Section ---
        const volumeSection = document.createElement('div');
        volumeSection.className = 'vcp-section';
        volumeSection.style.cssText = sectionStyle;

        const volumeLabel = document.createElement('label');
        volumeLabel.htmlFor = 'vcp-volume';
        volumeLabel.style.cssText = labelStyle;
        volumeLabel.textContent = '소리 조절: ';

        const volumeDisplay = document.createElement('span');
        volumeDisplay.id = 'vcp-volume-display';
        volumeDisplay.textContent = '100';
        volumeLabel.appendChild(volumeDisplay);
        volumeLabel.append('%');

        const volumeInput = document.createElement('input');
        volumeInput.type = 'range';
        volumeInput.id = 'vcp-volume';
        volumeInput.min = '0.0';
        volumeInput.max = '5.0';
        volumeInput.step = '0.1';
        volumeInput.value = '1.0';
        volumeInput.style.cssText = inputStyle;

        volumeSection.appendChild(volumeLabel);
        volumeSection.appendChild(volumeInput);
        controlsContainer.appendChild(volumeSection);

        // --- PIP & Fullscreen Buttons ---
        const buttonGroup2 = document.createElement('div');
        buttonGroup2.className = 'vcp-section';
        buttonGroup2.style.cssText = sectionStyle;

        const btnPip = document.createElement('button');
        btnPip.textContent = 'PIP 모드';
        btnPip.setAttribute('data-action', 'pip');
        btnPip.style.cssText = `${buttonStyle} margin-top: 5px;`;

        const btnExitFullscreen = document.createElement('button');
        btnExitFullscreen.textContent = '전체 종료';
        btnExitFullscreen.setAttribute('data-action', 'exit-fullscreen');
        btnExitFullscreen.style.cssText = `${buttonStyle} margin-top: 5px;`;

        buttonGroup2.appendChild(btnPip);
        buttonGroup2.appendChild(btnExitFullscreen);
        controlsContainer.appendChild(buttonGroup2);

        // --- Status Display ---
        const statusDiv = document.createElement('div');
        statusDiv.id = 'vcp-status';
        statusDiv.textContent = 'Status: Ready';
        statusDiv.style.cssText = 'margin-top: 10px; font-size: 12px; color: #777;';
        controlsContainer.appendChild(statusDiv);

        popupElement.appendChild(controlsContainer);
        document.body.appendChild(popupElement);

        setupPopupEventListeners();
    }

    /**
     * Handles clicks on the popup buttons (Play/Pause, Reset, PIP, Fullscreen Exit).
     */
    function handleButtonClick(action) {
        if (!currentVideo) {
            updateStatus('No video selected.');
            return;
        }

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    // If playing, set manual pause flag to false and play
                    isManuallyPaused = false;
                    currentVideo.muted = false; // Ensure sound is enabled on play
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                    updateStatus('Playing');
                } else {
                    // If pausing, set manual pause flag to true
                    isManuallyPaused = true;
                    currentVideo.pause();
                    updateStatus('Paused');
                }
                break;
            case 'reset-speed-volume':
                // Reset speed and volume to default 1.0 (100%)
                desiredPlaybackRate = 1.0;
                if (typeof currentVideo.playbackRate !== 'undefined') {
                    fixPlaybackRate(currentVideo, 1.0);
                }
                if (typeof currentVideo.volume !== 'undefined') {
                    setAmplifiedVolume(currentVideo, 1.0);
                }
                // Ensure the video is unmuted when resetting volume
                currentVideo.muted = false;
                updatePopupSliders();
                updateStatus('1.0x Speed / 100% Volume');
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
    }

    /**
     * Sets up event listeners for the popup controls and dragging functionality.
     */
    function setupPopupEventListeners() {
        if (!popupElement) return;

        // Button clicks
        popupElement.addEventListener('click', (e) => {
            resetPopupHideTimer();
            const action = e.target.getAttribute('data-action');
            if (action) {
                handleButtonClick(action);
            }
        });

        // Speed slider
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            // 슬라이더 조작 시 desiredPlaybackRate 업데이트
            desiredPlaybackRate = rate;
            speedDisplay.textContent = rate.toFixed(2);
            if (currentVideo) {
                fixPlaybackRate(currentVideo, rate);
                updateStatus(`Speed: ${rate.toFixed(2)}x`);
            }
        });

        // Volume slider
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

        // Popup dragging setup
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
                // Drag가 끝난 후 타이머를 리셋하여 팝업이 즉시 숨겨지는 것을 방지합니다.
                resetPopupHideTimer();
            }
            // If dragging stops, ensure the UI is visible for the duration of the timer
            showPopupTemporarily();
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

    /**
     * Updates the status message on the popup.
     */
    function updateStatus(message) {
        const statusElement = popupElement.querySelector('#vcp-status');
        if (statusElement) {
            statusElement.textContent = `Status: ${message}`;
            statusElement.style.opacity = 1;
            setTimeout(() => statusElement.style.opacity = 0.7, 2000);
        }
    }

    // --- Popup Visibility Logic ---

    function showPopup() {
        if (popupElement) {
            // Apply aggressive visibility styles
            popupElement.style.setProperty('display', 'block', 'important');
            popupElement.style.setProperty('opacity', '1', 'important');
            popupElement.style.setProperty('visibility', 'visible', 'important');
            popupElement.style.setProperty('pointer-events', 'auto', 'important');
            popupElement.style.setProperty('z-index', '2147483647', 'important');
        }
    }

    function hidePopup() {
        if (popupElement) {
            // Use !important for aggressive hiding only on blocked sites (like Twitch/Kick), otherwise standard none.
            if (isInitialPopupBlocked && !isPopupDragging) {
                popupElement.style.setProperty('display', 'none', 'important');
            } else {
                popupElement.style.display = 'none';
                popupElement.style.opacity = '0';
                popupElement.style.visibility = 'hidden';
            }
        }
    }

    function resetPopupHideTimer() {
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
        }
        // Drag 중에는 타이머를 설정하지 않습니다.
        if (!isPopupDragging) {
            // Use the updated POPUP_TIMEOUT_MS (2000ms)
            popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    function showPopupTemporarily() {
        if (popupElement && currentVideo) {
            showPopup();
            updatePopupPosition();
            resetPopupHideTimer();
        }
    }

    /**
     * Updates popup position relative to the current video.
     */
    function updatePopupPosition() {
        // Drag 중이면 위치 강제 이동을 방지합니다.
        if (!popupElement || !currentVideo || isPopupDragging) {
            if (!currentVideo && popupElement) hidePopup();
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                             videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            // Calculate X position: center of video element minus half the popup width.
            const viewportX = videoRect.left + (videoRect.width / 2) - (popupRect.width / 2);

            // Calculate Y position: center of video element minus half the popup height.
            const viewportY = videoRect.top + (videoRect.height / 2) - (popupRect.height / 2);

            // Ensure the popup stays within the viewport horizontally
            const safeX = Math.max(0, Math.min(viewportX, window.innerWidth - popupRect.width));

            popupElement.style.left = `${safeX}px`;
            popupElement.style.top = `${viewportY}px`;
            popupElement.style.transform = 'none'; // Ensure transform is reset if used by initial centering logic
            popupElement.style.position = 'fixed';
        } else {
            // If the video is not visible, hide the popup.
            hidePopup();
        }
    }

    /**
     * Updates the popup sliders and displays based on the current video's state.
     */
    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        // Update Speed UI based on desiredPlaybackRate
        if (speedInput && speedDisplay) {
            const rate = desiredPlaybackRate;
            speedInput.value = rate.toFixed(2);
            speedDisplay.textContent = rate.toFixed(2);
        }

        // Update Volume UI based on desiredVolume
        if (volumeInput && volumeDisplay) {
            let volume = desiredVolume;

            // If using amplification, update volume display based on gain value if it was set explicitly.
            if (gainNode && connectedVideo === currentVideo) {
                 volume = gainNode.gain.value;
            }

            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
        }
    }

    // --- Video Control & Selection Logic ---

    /**
     * Selects a video based on a click event, prioritizing the clicked video or the most visible one.
     */
    function selectVideoOnDocumentClick(e) {
        // If the click is inside the popup, ignore it
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        // Find the clicked element's closest video/audio ancestor
        let targetVideo = e.target.closest('video, audio');

        // Check if the clicked video is valid and included in our list.
        if (targetVideo && videos.includes(targetVideo)) {
            // If a different video is clicked, pause the current one and switch
            if (targetVideo !== currentVideo) {
                if (currentVideo && !currentVideo.paused) {
                    currentVideo.pause();
                }
                currentVideo = targetVideo;
            }

            console.log('[VCP] Video selected via direct click. Found:', targetVideo);

            // Reset speed/volume and attempt to play the clicked video.
            if (typeof currentVideo.playbackRate !== 'undefined') {
                fixPlaybackRate(currentVideo, 1.0);
            }
            if (typeof currentVideo.volume !== 'undefined') {
                setAmplifiedVolume(currentVideo, 1.0);
            }

            // Ensure sound is enabled for the clicked video
            currentVideo.muted = false;

            // If the user clicks on a video, we assume they want to play it. Reset the manual pause flag.
            isManuallyPaused = false;
            currentVideo.play().catch(e => console.error("Play failed on click:", e));

            updatePopupSliders();
            showPopupTemporarily();

        } else {
            // If click wasn't on a valid video, and we don't have a current video, hide the popup.
            if (!currentVideo) {
                console.log('[VCP] Click activation failed: No playable videos found.');
                hidePopup();
            } else {
                // If a video is already playing, show the popup for it.
                showPopupTemporarily();
            }
        }
    }

    // --- Main Initialization ---

    /**
     * Updates the list of videos and observes them using IntersectionObserver.
     */
    function updateVideoList() {
        findPlayableVideos();
        observeVideos();

        // Check if the current video is still valid.
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
            currentVideo = null;
            hidePopup();
        }
    }

    /**
     * Sets up a MutationObserver to detect when videos are dynamically added or removed.
     */
    function setupDOMObserver() {
        // We observe childList (add/remove nodes) and subtree (deep changes).
        const observerConfig = { childList: true, subtree: true, attributes: true };

        const observerCallback = (mutationsList) => {
            let foundMediaChange = false;
            for (const mutation of mutationsList) {
                // Check if nodes related to video/audio were added/removed or relevant attributes changed
                if (mutation.type === 'childList') {
                    const containsMedia = (nodes) => Array.from(nodes).some(node =>
                        node.nodeName === 'VIDEO' || node.nodeName === 'AUDIO' ||
                        (node.nodeType === 1 && (node.querySelector('video') || node.querySelector('audio') || node.shadowRoot))
                    );

                    if (containsMedia(mutation.addedNodes) || containsMedia(mutation.removedNodes)) {
                        foundMediaChange = true;
                        break;
                    }
                }
                else if (mutation.type === 'attributes') {
                    if (mutation.target.matches('video, audio')) {
                         foundMediaChange = true;
                         break;
                    }
                }
            }

            if (foundMediaChange) {
                // When DOM changes that might affect videos, update list and observe new videos.
                updateVideoList();
            }
        };

        const mutationObserver = new MutationObserver(observerCallback);
        // We observe the body for changes.
        mutationObserver.observe(document.body, observerConfig);
    }

    /**
     * Fixes overflow issues on specific sites (like Twitch) to ensure controls are visible.
     */
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

    /**
     * Initializes the script.
     */
    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.36 (IntersectionObserver)');

        createPopupElement();
        hidePopup();
        setupIntersectionObserver();

        // Attach fullscreen event handler
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    // When entering fullscreen, append the popup to the fullscreen element for visibility.
                    fsEl.appendChild(popupElement);
                    showPopup();
                } else {
                    // When exiting fullscreen, move the popup back to the body.
                    document.body.appendChild(popupElement);
                }
            }
        });

        // 1. Initial video list update and observation
        updateVideoList();

        // 2. Setup DOM observer for dynamic content changes
        setupDOMObserver();

        // 3. Apply overflow fixes for specific sites
        fixOverflow();

        // 4. Add the click listener to the document body for manual activation
        // We use 'true' for the useCapture parameter to ensure our handler runs first.
        document.body.addEventListener('click', selectVideoOnDocumentClick, true);
    }

    // Initialize the script when the DOM is ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
