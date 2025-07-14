// ==UserScript==
// @name Video Controller Popup (V4.10.36: TrustedHTML Patched, Volume Fixed, IntersectionObserver, Speed 0.0-5.0, AutoplaySound, Optimized)
// @namespace Violentmonkey Scripts
// @version 4.10.36_TrustedHTML_Patched_InitialCheck_OpacityFixed
// @description Optimized video controls using IntersectionObserver for visibility detection, single video autoplay, and adjustable speed from 0.0x to 5.0x. Includes patch for TrustedHTML errors on sites like YouTube.
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

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000; // UI display time: 2 seconds
    
    // Sites where popup visibility needs to be aggressively managed
    const SITE_POPUP_BLOCK_LIST = ['sooplive.co.kr', 'twitch.tv', 'kick.com'];
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));
    
    // Sites where lazy loading of src is problematic
    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));
    
    // Sites where volume amplification is blocked
    const isAmplificationBlocked = ['avsee.ru'].some(site => location.hostname.includes(site));

    // --- Audio Context for Volume Amplification ---
    let audioCtx = null;
    let gainNode = null;
    let connectedVideo = null; 

    // --- Utility Functions ---

    /**
     * Recursively finds video/audio elements, including those in Shadow DOMs.
     */
    function findAllVideosDeep(root = document) {
        const videoElements = new Set();
        
        // Find all video/audio elements in the current root
        root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));

        // Recursively check Shadow DOMs
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

        // Handle lazy loading for non-blocked sites
        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        // Filter criteria: Visible and reasonably sized media elements
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

    /**
     * Sets up the IntersectionObserver for all detected videos.
     */
    function setupIntersectionObserver() {
        if (videoObserver) {
            videoObserver.disconnect();
        }

        const options = {
            root: null, 
            rootMargin: '0px',
            threshold: 0.5 
        };

        videoObserver = new IntersectionObserver(handleIntersection, options);
    }
    
    /**
     * Handles IntersectionObserver entries to determine the most visible video and enforce single playback.
     */
    function handleIntersection(entries) {
        let bestVideo = null;
        let maxIntersectionRatio = 0;

        // Update entries and find the most visible video
        entries.forEach(entry => {
            intersectionEntries.set(entry.target, entry.intersectionRatio);
        });

        intersectionEntries.forEach((ratio, video) => {
            if (ratio > maxIntersectionRatio) {
                maxIntersectionRatio = ratio;
                bestVideo = video;
            }
        });

        // Auto-play the best video if it's visible by at least 10%
        if (maxIntersectionRatio > 0.1) {
            enforceSingleVisibleVideoPlayback(bestVideo);
        } else if (currentVideo) {
            // Pause current video if it's no longer sufficiently visible
            currentVideo.pause();
            isManuallyPaused = true; 
            currentVideo = null;
            hidePopup();
        }
    }

    /**
     * Observes newly found playable videos and ensures they are unmuted.
     */
    function observeVideos() {
        videos.forEach(video => {
            // Ensure muted is false when observing the video to allow sound
            video.muted = false;

            // Check if the video is already observed before observing
            if (!intersectionEntries.has(video)) {
                videoObserver.observe(video);
                intersectionEntries.set(video, 0); 
            }
        });

        // Clean up unobserved videos
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

        // Handle video selection and playback
        if (visibleVideo !== currentVideo) {
            currentVideo = visibleVideo;
            console.log('[VCP] Switched to most visible video. Resetting controls.');
            
            // Reset speed and volume for the newly selected video
            fixPlaybackRate(currentVideo, 1.0);
            setAmplifiedVolume(currentVideo, 1.0);
            isManuallyPaused = false; 

        } else if (currentVideo.paused && !isManuallyPaused) {
            // Resume if not manually paused
            currentVideo.play().catch(e => console.error("Autoplay resume failed:", e));
        }

        updatePopupSliders();
        updatePopupPosition();
        showPopupTemporarily();
    }


    /**
     * Ensures the video playback rate remains fixed at the desired speed.
     */
    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;

        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) {
            video.removeEventListener('ratechange', existingHandler);
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
                console.log(`[VCP] Fixed playback rate to ${desiredPlaybackRate}`);
            }
        };

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
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
            }

            // Disconnect existing nodes if connected
            if (video._audioSourceNode) video._audioSourceNode.disconnect();
            if (gainNode) gainNode.disconnect();

            // Create new nodes and connect them
            video._audioSourceNode = audioCtx.createMediaElementSource(video);
            gainNode = audioCtx.createGain();
            video._audioSourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            // Ensure video volume is 1.0 and unmuted when using AudioContext
            video.volume = 1.0;
            video.muted = false; 

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
        if (!video || typeof video.volume === 'undefined') return;

        desiredVolume = vol;
        
        // Ensure the video is never muted when controlling volume
        video.muted = false;

        // Standard volume control (0.0 to 1.0)
        if (vol <= 1) {
            if (gainNode && connectedVideo === video) {
                // If amplification setup exists for this video, set gain to 1 and control via video.volume
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } 
        // Amplified volume control (> 1.0)
        else {
            if (isAmplificationBlocked) {
                video.volume = 1;
                if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
                return;
            }

            // Setup or reuse AudioContext for amplification
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    video.volume = 1; // Fallback if amplification fails
                    return;
                }
            }

            // Control gain via gainNode
            if (gainNode) {
                video.volume = 1; // Ensure native volume is maxed
                gainNode.gain.value = vol;
            }
        }
    }

    // --- Popup UI Functions ---

    /**
     * Creates the popup UI element.
     * Patched to avoid 'TrustedHTML' errors by using DOM methods (createElement, appendChild, setAttribute)
     * instead of innerHTML for complex structures.
     */
    function createPopupElement() {
        if (popupElement) return;

        // 1. Create main container
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; 
            z-index: 2147483647; 
            display: none; opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: 230px; overflow: hidden; text-align: center;
            pointer-events: auto;
        `;

        // 2. Create Drag Handle
        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;
        popupElement.appendChild(dragHandle);

        // 3. Create Controls Container (main-content)
        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = 'padding: 10px;';

        // 4. Create Buttons Section (Play/Pause, Reset)
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = 'display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;';
        
        const playPauseBtn = document.createElement('button');
        playPauseBtn.setAttribute('data-action', 'play-pause');
        playPauseBtn.textContent = '재생/멈춤';
        playPauseBtn.style.cssText = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;
        
        const resetBtn = document.createElement('button');
        resetBtn.setAttribute('data-action', 'reset-speed-volume');
        resetBtn.textContent = '재설정';
        resetBtn.style.cssText = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;

        buttonSection.appendChild(playPauseBtn);
        buttonSection.appendChild(resetBtn);
        contentContainer.appendChild(buttonSection);

        // 5. Create Speed Section
        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.marginBottom = '10px';

        const speedLabel = document.createElement('label');
        speedLabel.htmlFor = 'vcp-speed';
        speedLabel.style.cssText = 'display: block; margin-bottom: 5px;';
        
        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedLabel.textContent = '배속 조절: ';
        speedLabel.appendChild(speedDisplay);
        speedLabel.appendChild(document.createTextNode('x'));
        
        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.0';
        speedInput.max = '5.0';
        speedInput.step = '0.2';
        speedInput.value = '1.0';
        speedInput.style.cssText = 'width: 100%; cursor: pointer;';

        speedSection.appendChild(speedLabel);
        speedSection.appendChild(speedInput);
        contentContainer.appendChild(speedSection);

        // 6. Create Volume Section
        const volumeSection = document.createElement('div');
        volumeSection.className = 'vcp-section';
        volumeSection.style.marginBottom = '10px';

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
        volumeInput.step = '0.1';
        volumeInput.value = '1.0';
        volumeInput.style.cssText = 'width: 100%; cursor: pointer;';

        volumeSection.appendChild(volumeLabel);
        volumeSection.appendChild(volumeInput);
        contentContainer.appendChild(volumeSection);

        // 7. Create PIP/Fullscreen Exit Section
        const modeSection = document.createElement('div');
        modeSection.className = 'vcp-section';
        modeSection.style.marginBottom = '10px';

        const pipBtn = document.createElement('button');
        pipBtn.setAttribute('data-action', 'pip');
        pipBtn.textContent = 'PIP 모드';
        pipBtn.style.cssText = `${playPauseBtn.style.cssText} margin-top: 5px;`;
        
        const exitFullscreenBtn = document.createElement('button');
        exitFullscreenBtn.setAttribute('data-action', 'exit-fullscreen');
        exitFullscreenBtn.textContent = '전체 종료';
        exitFullscreenBtn.style.cssText = `${playPauseBtn.style.cssText} margin-top: 5px;`;

        modeSection.appendChild(pipBtn);
        modeSection.appendChild(exitFullscreenBtn);
        contentContainer.appendChild(modeSection);

        // 8. Create Status Section
        const statusElement = document.createElement('div');
        statusElement.id = 'vcp-status';
        statusElement.textContent = 'Status: Ready';
        statusElement.style.cssText = 'margin-top: 10px; font-size: 12px; color: #777;';
        contentContainer.appendChild(statusElement);

        popupElement.appendChild(contentContainer);

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }


    /**
     * Handles clicks on the popup buttons.
     */
    function handleButtonClick(action) {
        if (!currentVideo) {
            updateStatus('No video selected.');
            return;
        }

        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false; 
                    currentVideo.muted = false; 
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                    updateStatus('Playing');
                } else {
                    isManuallyPaused = true; 
                    currentVideo.pause();
                    updateStatus('Paused');
                }
                break;
            case 'reset-speed-volume':
                desiredPlaybackRate = 1.0; 
                fixPlaybackRate(currentVideo, 1.0);
                setAmplifiedVolume(currentVideo, 1.0);
                currentVideo.muted = false; 
                updatePopupSliders();
                updateStatus('1.0x Speed / 100% Volume');
                break;
            case 'pip':
                if (document.pictureInPictureEnabled && currentVideo.requestPictureInPicture) {
                    (document.pictureInPictureElement ? document.exitPictureInPicture() : currentVideo.requestPictureInPicture())
                        .catch(e => console.error(e));
                    updateStatus(document.pictureInPictureElement ? 'Exiting PIP' : 'Entering PIP');
                }
                break;
            case 'exit-fullscreen':
                if (document.fullscreenElement || document.webkitFullscreenElement) {
                    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
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
            const action = e.target.getAttribute('data-action');
            if (action) handleButtonClick(action);
        });

        // Speed slider
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
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
                resetPopupHideTimer(); 
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
            // --- MODIFIED: Changed opacity logic for status element ---
            statusElement.style.opacity = 0.75; // Set initial opacity to 0.75
            setTimeout(() => statusElement.style.opacity = 0, 2000); // Fade out completely after 2 seconds
            // --- END MODIFICATION ---
        }
    }

    // --- Popup Visibility Logic ---

    /**
     * Sets the visibility of the popup element.
     */
    function setPopupVisibility(isVisible) {
        if (!popupElement) return;
        
        if (isVisible) {
            // Apply aggressive visibility styles when visible
            const styles = { 
                display: 'block', 
                opacity: '0.75', // MODIFIED: Changed base opacity to 0.75
                visibility: 'visible', 
                pointerEvents: 'auto', 
                zIndex: '2147483647' 
            };
            for (const key in styles) {
                popupElement.style.setProperty(key, styles[key], 'important');
            }
        } else {
            // Hiding logic
            if (isInitialPopupBlocked && !isPopupDragging) {
                popupElement.style.setProperty('display', 'none', 'important');
            } else {
                popupElement.style.display = 'none';
                popupElement.style.opacity = '0';
                popupElement.style.visibility = 'hidden';
            }
        }
    }

    function showPopup() {
        setPopupVisibility(true);
    }

    function hidePopup() {
        setPopupVisibility(false);
    }

    function resetPopupHideTimer() {
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
        }
        if (!isPopupDragging) {
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
        if (!popupElement || !currentVideo || isPopupDragging) {
            if (!currentVideo && popupElement) hidePopup();
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                             videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            // Calculate center position and ensure it stays within the viewport
            const viewportX = videoRect.left + (videoRect.width / 2) - (popupRect.width / 2);
            const viewportY = videoRect.top + (videoRect.height / 2) - (popupRect.height / 2);
            const safeX = Math.max(0, Math.min(viewportX, window.innerWidth - popupRect.width));
            
            popupElement.style.left = `${safeX}px`;
            popupElement.style.top = `${viewportY}px`;
            popupElement.style.transform = 'none'; 
            popupElement.style.position = 'fixed';
        } else {
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

        // Update Speed UI
        if (speedInput && speedDisplay) {
            const rate = desiredPlaybackRate;
            speedInput.value = rate.toFixed(2);
            speedDisplay.textContent = rate.toFixed(2);
        }

        // Update Volume UI (based on desiredVolume or gain value if amplified)
        if (volumeInput && volumeDisplay) {
            let volume = desiredVolume;
            if (gainNode && connectedVideo === currentVideo) {
                 volume = gainNode.gain.value;
            }
            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
        }
    }

    // --- Video Control & Selection Logic ---

    /**
     * Selects a video based on a click event.
     */
    function selectVideoOnDocumentClick(e) {
        // Ignore clicks inside the popup
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        const targetVideo = e.target.closest('video, audio');

        // Check if the clicked video is valid and included in our list.
        if (targetVideo && videos.includes(targetVideo)) {
            if (targetVideo !== currentVideo) {
                if (currentVideo && !currentVideo.paused) {
                    currentVideo.pause();
                }
                currentVideo = targetVideo;
            }

            console.log('[VCP] Video selected via direct click. Found:', targetVideo);

            // Reset controls and play the video.
            fixPlaybackRate(currentVideo, 1.0);
            setAmplifiedVolume(currentVideo, 1.0);
            currentVideo.muted = false; // Ensure sound is enabled
            isManuallyPaused = false;
            currentVideo.play().catch(e => console.error("Play failed on click:", e));
            
            updatePopupSliders();
            showPopupTemporarily();

        } else {
            // Hide popup if no video is selected and click is outside valid video area
            if (!currentVideo) {
                hidePopup();
            } else {
                showPopupTemporarily();
            }
        }
    }

    // --- Main Initialization ---

    /**
     * Calculates the intersection ratio for a video element using getBoundingClientRect().
     */
    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        
        // Calculate the area of the video visible in the viewport
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

    /**
     * Checks initial visibility on load and triggers auto-play for the most visible video.
     */
    function initialAutoPlayCheck() {
        const playableVideos = findPlayableVideos();
        let bestVideo = null;
        let maxRatio = 0;

        playableVideos.forEach(video => {
            const ratio = calculateIntersectionRatio(video);
            if (ratio > maxRatio) {
                maxRatio = ratio;
                bestVideo = video;
            }
        });

        // Only auto-play if at least 50% of the best video is visible on load.
        if (maxRatio >= 0.5 && bestVideo) {
            console.log('[VCP] Performing initial auto-play check on load.');
            enforceSingleVisibleVideoPlayback(bestVideo);
        }
    }

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
        const observerConfig = { childList: true, subtree: true, attributes: true };

        const observerCallback = (mutationsList) => {
            let foundMediaChange = false;
            for (const mutation of mutationsList) {
                // Simplified check for media-related changes
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
            }
        };

        const mutationObserver = new MutationObserver(observerCallback);
        mutationObserver.observe(document.body, observerConfig);
    }

    /**
     * Fixes overflow issues on specific sites (like Twitch) to ensure controls are visible.
     */
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

    /**
     * Initializes the script.
     */
    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.36_TrustedHTML_Patched_InitialCheck_OpacityFixed');

        createPopupElement();
        hidePopup();
        setupIntersectionObserver();

        // Handle fullscreen popup positioning
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                    showPopup(); 
                } else {
                    document.body.appendChild(popupElement);
                }
            }
        });

        // Setup observers and listeners
        updateVideoList();
        setupDOMObserver();
        fixOverflow();
        document.body.addEventListener('click', selectVideoOnDocumentClick, true);

        // --- NEW: Perform initial auto-play check on load ---
        initialAutoPlayCheck();
        // --- END NEW ---
    }

    // Initialize the script when the DOM is ready
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
