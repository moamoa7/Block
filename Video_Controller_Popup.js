// ==UserScript==
// @name Video Controller Popup (V4.10.36: TrustedHTML Patched, AutoplayFixed, ResponsiveUI, Minified)
// @namespace Violentmonkey Scripts
// @version 4.10.36_TrustedHTML_Patched_AutoplayFixed_ResponsiveUI_Minified
// @description Optimized video controls using IntersectionObserver, single video autoplay, and adjustable speed. Includes fixes for autoplay policies and responsive UI positioning.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0, videoObserver = null, isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    const intersectionEntries = new Map();
    let isManuallyPaused = false;
    const videoRateHandlers = new WeakMap();

    // --- Configuration & Audio Context ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const SITE_POPUP_BLOCK_LIST = ['sooplive.co.kr', 'twitch.tv', 'kick.com'];
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));
    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));
    const isAmplificationBlocked = ['avsee.ru'].some(site => location.hostname.includes(site));
    let audioCtx = null, gainNode = null, connectedVideo = null;

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        const videoElements = new Set();
        root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) findAllVideosDeep(el.shadowRoot).forEach(v => videoElements.add(v)); });
        return Array.from(videoElements);
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        if (!isLazySrcBlockedSite) found.forEach(v => { if (!v.src && v.dataset && v.dataset.src) v.src = v.dataset.src; });
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

    function setupIntersectionObserver() {
        if (videoObserver) videoObserver.disconnect();
        // Dynamic threshold: 0.1 for mobile (less than 768px), 0.5 for desktop
        const threshold = window.innerWidth < 768 ? 0.1 : 0.5;
        const options = { root: null, rootMargin: '0px', threshold: threshold };
        videoObserver = new IntersectionObserver(handleIntersection, options);
    }

    // New scoring function: favors higher visibility AND being closer to the center of the screen
    function calculateCenterDistanceScore(video, intersectionRatio) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight;

        // Calculate the vertical center of the video
        const videoCenterY = rect.top + (rect.height / 2);
        // Calculate the vertical center of the viewport
        const viewportCenterY = viewportHeight / 2;

        // Calculate the distance from the video center to the viewport center
        const distance = Math.abs(videoCenterY - viewportCenterY);

        // Normalize the distance (0 to 1, relative to viewport height)
        const normalizedDistance = distance / viewportHeight;

        // Calculate score: Intersection Ratio minus Normalized Distance
        // A lower normalized distance (closer to center) yields a higher score.
        const score = intersectionRatio - normalizedDistance;
        return score;
    }

    function handleIntersection(entries) {
        // Update the intersection ratio map first
        entries.forEach(entry => intersectionEntries.set(entry.target, entry.intersectionRatio));

        let bestVideo = null;
        let maxScore = -Infinity;
        let intersectingVideoCount = 0;

        // Iterate through all currently observed videos to find the one with the highest score
        intersectionEntries.forEach((ratio, video) => {
            // Only consider videos that are actually intersecting
            if (ratio > 0) {
                intersectingVideoCount++;
                const score = calculateCenterDistanceScore(video, ratio);

                if (score > maxScore) {
                    maxScore = score;
                    bestVideo = video;
                }
            }
        });

        // Condition relaxation: If there is exactly one intersecting video, play it regardless of score.
        if (intersectingVideoCount === 1 && bestVideo) {
             console.log('[VCP] Autoplay single intersecting video.');
            enforceSingleVisibleVideoPlayback(bestVideo);
            return;
        }

        // If multiple videos are intersecting, or if a single video has a score above the threshold
        if (bestVideo && maxScore > -0.5) {
            enforceSingleVisibleVideoPlayback(bestVideo);
        } else if (currentVideo) {
            currentVideo.pause();
            isManuallyPaused = true;
            currentVideo = null;
            hidePopup();
        }
    }

    // Function to handle video selection and playback specifically during scroll
    function handleScrollAndSelectVideo() {
        updateVideoList();
        // Create synthetic entries for handleIntersection based on current state
        const entries = Array.from(intersectionEntries.entries()).map(([target, ratio]) => ({ target, intersectionRatio: ratio }));
        handleIntersection(entries);
    }

    function observeVideos() {
        videos.forEach(video => {
            video.muted = false;
            if (!intersectionEntries.has(video)) {
                videoObserver.observe(video);
                intersectionEntries.set(video, 0);
            }
        });
        intersectionEntries.forEach((ratio, video) => {
            if (!videos.includes(video)) {
                videoObserver.unobserve(video);
                intersectionEntries.delete(video);
            }
        });
    }

    function enforceSingleVisibleVideoPlayback(visibleVideo) {
        if (!visibleVideo) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        videos.forEach(video => {
            if (video !== visibleVideo && !video.paused) video.pause();
        });

        if (visibleVideo !== currentVideo) {
            currentVideo = visibleVideo;

            // --- Autoplay properties forced for mobile/browser compatibility ---
            currentVideo.autoplay = true;
            currentVideo.muted = true;
            currentVideo.playsInline = true;
            // ------------------------------------------------------------------

            console.log('[VCP] Switched to most visible video. Resetting controls.');
            fixPlaybackRate(currentVideo, 1.0);
            setAmplifiedVolume(currentVideo, 1.0);
            isManuallyPaused = false;

            // Explicitly call play() after setting properties to trigger autoplay
            currentVideo.play().catch(e => console.error("Autoplay resume failed:", e));

        } else if (currentVideo.paused && !isManuallyPaused) {
            currentVideo.play().catch(e => console.error("Autoplay resume failed:", e));
        }

        updatePopupSliders();
        updatePopupPosition();
        showPopupTemporarily();
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;
        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) video.playbackRate = desiredPlaybackRate;
        };

        video.playbackRate = rate;
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
    }

    // --- Audio Context & Volume Amplification ---

    function setupAudioContext(video) {
        if (isAmplificationBlocked || !video) return false;
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));

            if (video._audioSourceNode) video._audioSourceNode.disconnect();
            if (gainNode) gainNode.disconnect();

            video._audioSourceNode = audioCtx.createMediaElementSource(video);
            gainNode = audioCtx.createGain();
            video._audioSourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);
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

    function setAmplifiedVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        desiredVolume = vol;
        video.muted = false;

        if (vol <= 1) {
            if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
            video.volume = vol;
        } else {
            if (isAmplificationBlocked) { video.volume = 1; if (gainNode && connectedVideo === video) gainNode.gain.value = 1; return; }
            if (!audioCtx || connectedVideo !== video) { if (!setupAudioContext(video)) { video.volume = 1; return; } }
            if (gainNode) { video.volume = 1; gainNode.gain.value = vol; }
        }
    }

    // --- Popup UI Functions ---

    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px; padding: 0; color: white; font-family: sans-serif; z-index: 2147483647; display: none; opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); width: 230px; overflow: hidden; text-align: center; pointer-events: auto;`;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;
        popupElement.appendChild(dragHandle);

        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = 'padding: 10px;';

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

        const statusElement = document.createElement('div');
        statusElement.id = 'vcp-status';
        statusElement.textContent = 'Status: Ready';
        statusElement.style.cssText = 'margin-top: 10px; font-size: 12px; color: #777;';
        contentContainer.appendChild(statusElement);

        popupElement.appendChild(contentContainer);
        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function handleButtonClick(action) {
        if (!currentVideo) { updateStatus('No video selected.'); return; }
        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false; currentVideo.muted = false;
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                    updateStatus('Playing');
                } else {
                    isManuallyPaused = true; currentVideo.pause();
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
                    (document.pictureInPictureElement ? document.exitPictureInPicture() : currentVideo.requestPictureInPicture()).catch(e => console.error(e));
                    updateStatus(document.pictureInPictureElement ? 'Exiting PIP' : 'Entering PIP');
                }
                break;
            case 'exit-fullscreen':
                if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
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
            desiredPlaybackRate = rate;
            speedDisplay.textContent = rate.toFixed(2);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); updateStatus(`Speed: ${rate.toFixed(2)}x`); }
        });

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', () => {
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            volumeDisplay.textContent = Math.round(vol * 100);
            if (currentVideo) { setAmplifiedVolume(currentVideo, vol); updateStatus(`Volume: ${Math.round(vol * 100)}%`); }
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

    function updateStatus(message) {
        const statusElement = popupElement.querySelector('#vcp-status');
        if (statusElement) {
            statusElement.textContent = `Status: ${message}`;
            statusElement.style.opacity = 0.75;
            setTimeout(() => statusElement.style.opacity = 0, 2000);
        }
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isVisible) {
            const styles = { display: 'block', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
        } else {
            if (isInitialPopupBlocked && !isPopupDragging) {
                popupElement.style.setProperty('display', 'none', 'important');
            } else {
                popupElement.style.display = 'none';
                popupElement.style.opacity = '0';
                popupElement.style.visibility = 'hidden';
            }
        }
    }

    function showPopup() { setPopupVisibility(true); }
    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function showPopupTemporarily() {
        if (popupElement && currentVideo) { showPopup(); updatePopupPosition(); resetPopupHideTimer(); }
    }

    function updatePopupPosition() {
        if (!popupElement || !currentVideo || isPopupDragging) { if (!currentVideo && popupElement) hidePopup(); return; }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();
        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
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

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (speedInput && speedDisplay) {
            const rate = desiredPlaybackRate;
            speedInput.value = rate.toFixed(2);
            speedDisplay.textContent = rate.toFixed(2);
        }

        if (volumeInput && volumeDisplay) {
            let volume = desiredVolume;
            if (gainNode && connectedVideo === currentVideo) volume = gainNode.gain.value;
            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
        }
    }

    // --- Video Control & Selection Logic ---

    function selectVideoOnDocumentClick(e) {
        if (popupElement && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }
        const targetVideo = e.target.closest('video, audio');

        if (targetVideo && videos.includes(targetVideo)) {
            if (targetVideo !== currentVideo) {
                if (currentVideo && !currentVideo.paused) currentVideo.pause();
                currentVideo = targetVideo;
            }

            console.log('[VCP] Video selected via direct click. Found:', targetVideo);
            fixPlaybackRate(currentVideo, 1.0);
            setAmplifiedVolume(currentVideo, 1.0);
            currentVideo.muted = false;
            isManuallyPaused = false;
            currentVideo.play().catch(e => console.error("Play failed on click:", e));

            updatePopupSliders();
            showPopupTemporarily();

        } else {
            if (!currentVideo) hidePopup();
            else showPopupTemporarily();
        }
    }

    // --- Main Initialization ---

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

    // Initial check using the new scoring logic
    function initialAutoPlayCheck() {
        const playableVideos = findPlayableVideos();

        // Condition relaxation: If only one playable video exists, autoplay it regardless of score.
        if (playableVideos.length === 1) {
            const video = playableVideos[0];
            console.log('[VCP] Initializing with single detected video.');
            video.muted = true;
            video.playsInline = true;
            enforceSingleVisibleVideoPlayback(video);
            return;
        }

        // Existing logic for multiple videos (competition based on score)
        let bestVideo = null;
        let maxScore = -Infinity;

        playableVideos.forEach(video => {
            const ratio = calculateIntersectionRatio(video);
            const score = calculateCenterDistanceScore(video, ratio);

            if (score > maxScore) {
                maxScore = score;
                bestVideo = video;
            }
        });

        // Autoplay based on scoring threshold if multiple videos exist.
        if (bestVideo && maxScore > 0 && calculateIntersectionRatio(bestVideo) > 0.1) {
            console.log('[VCP] Performing initial auto-play check on load. Selected video with score:', maxScore.toFixed(3));
            bestVideo.muted = true;
            bestVideo.playsInline = true;
            enforceSingleVisibleVideoPlayback(bestVideo);
        }
    }

    function updateVideoList() {
        findPlayableVideos();
        observeVideos();
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
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
            if (foundMediaChange) updateVideoList();
        };
        const mutationObserver = new MutationObserver(observerCallback);
        mutationObserver.observe(document.body, observerConfig);
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

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.36_TrustedHTML_Patched_AutoplayFixed_ResponsiveUI_Minified');

        createPopupElement();
        hidePopup();
        setupIntersectionObserver();

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

        // Add event listener to adjust popup position on window resize (including mobile orientation change)
        window.addEventListener('resize', () => {
            setupIntersectionObserver(); // Recalculate threshold on resize
            updatePopupPosition();
        });

        // Add scroll event listener to force video selection on scroll
        window.addEventListener('scroll', handleScrollAndSelectVideo, { passive: true });

        updateVideoList();
        setupDOMObserver();
        fixOverflow();
        document.body.addEventListener('click', selectVideoOnDocumentClick, true);
        initialAutoPlayCheck();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
