// ==UserScript==
// @name Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace Violentmonkey Scripts
// @version 4.09.9_Optimized_UI_Fixed_MultiVideo_TempPopup
// @description Optimized video controls including seeking, speed, volume amplification, and Shadow DOM compatibility. (Popup UI Restored and Drag Fixed, Temporary UI visibility added)
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let rateFixIntervalId = null;
    let videos = []; // List of all detected videos
    let currentVideo = null; // The video currently being controlled (determined by mouse hover or touch)
    let popupElement = null;
    let isSeeking = false;
    let desiredPlaybackRate = 1.0;
    let videoObserver = null;
    let isDragging = false; // Video seeking drag state
    let dragStartX = 0;
    let feedbackOverlay = null;
    let isPopupDragging = false; // Popup UI drag state
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;

    // New variables for temporary popup visibility
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000; // 2seconds to hide

    // --- Environment Flags & Configuration ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // Blacklists for specific functionality
    const lazySrcBlacklist = ['missav.ws', 'missav.live'];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));
    const AMPLIFICATION_BLACKLIST = ['avsee.ru'];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // --- Site-specific configuration for blocking initial popup display (MODIFICATION) ---
    // 초기 로드 시 팝업이 자동으로 뜨는 것을 막을 사이트 목록을 추가합니다.
    const SITE_POPUP_BLOCK_LIST = [
        'sooplive.co.kr',
        'twitch.tv',
        'kick.com'
    ];
    // 현재 사이트가 팝업 자동 표시 차단 목록에 있는지 확인합니다.
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));

    // --- Audio Context for Volume Amplification ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    // --- Utility Functions ---

    function findAllVideosDeep(root = document) {
        const found = [];
        // Find video/audio elements and potentially Shadow DOM descendants
        root.querySelectorAll('video, audio').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found.push(...findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();

        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        // Filter for visible and suitably sized videos/audios
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            // Check for display/visibility, and ensure it's not a tiny video (like ads or invisible players)
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (v.videoWidth > 0 || v.tagName === 'AUDIO' || v.tagName === 'VIDEO') &&
                (v.clientWidth > 50 || v.clientHeight > 50)
            );
        });

        // Update the global videos list
        videos = playableVideos;
        return playableVideos;
    }

    function fixPlaybackRate(video, rate) {
        if (!video) return;

        desiredPlaybackRate = rate;
        video.playbackRate = rate;

        // Clear existing interval if it belongs to a different video or is already running
        if (rateFixIntervalId) {
            clearInterval(rateFixIntervalId);
        }

        // Remove previous rate change listener
        if (video._rateChangeHandler) {
            video.removeEventListener('ratechange', video._rateChangeHandler);
            video._rateChangeHandler = null;
        }

        // Add a new listener to enforce rate changes
        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video.addEventListener('ratechange', rateChangeHandler);
        video._rateChangeHandler = rateChangeHandler;

        // Start interval check for rate consistency
        rateFixIntervalId = setInterval(() => {
            if (document.body.contains(video) && video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            } else if (!document.body.contains(video)) {
                // Stop interval if the video element is removed from the DOM
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
            // Disconnect previous nodes if they exist
            if (sourceNode) sourceNode.disconnect();
            if (gainNode) gainNode.disconnect();

            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (!video._audioSourceNode) {
                // Create a source node for the current video element
                video._audioSourceNode = audioCtx.createMediaElementSource(video);
            }

            sourceNode = video._audioSourceNode;
            gainNode = audioCtx.createGain();

            // Connect the video source -> gain node -> audio destination
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

        // Ensure volume doesn't exceed 1.0 on sites that block amplification
        if (isAmplificationBlocked && vol > 1) {
            video.volume = 1;
            if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
            return;
        }

        // Resume AudioContext if suspended (common on some browsers until user interaction)
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
        }

        if (vol <= 1) {
            // Standard volume control
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } else {
            // Amplification (Volume > 1)
            if (video.muted) {
                video.muted = false;
            }

            // Setup AudioContext if not already connected to this video
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    video.volume = 1; // Fallback to max standard volume if amplification fails
                    return;
                }
            }

            // Set video volume to 1 and adjust gain node for amplification
            if (gainNode) {
                video.volume = 1;
                gainNode.gain.value = vol;
            }
        }
    }

    // --- Seeking & Dragging Functions (Video dragging remains unchanged) ---

    function getFeedbackOverlay() {
        if (!feedbackOverlay) {
            feedbackOverlay = document.createElement('div');
            feedbackOverlay.id = 'video-drag-feedback';
            feedbackOverlay.style.cssText = `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background-color: rgba(0, 0, 0, 0.7); color: white; padding: 10px 20px; border-radius: 8px; font-size: 24px; font-weight: bold; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s ease-in-out;`;
        }

        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
        const targetParent = fullscreenElement || document.body;

        if (feedbackOverlay.parentNode !== targetParent) {
            if (feedbackOverlay.parentNode) {
                feedbackOverlay.parentNode.removeChild(feedbackOverlay);
            }
            targetParent.appendChild(feedbackOverlay);
        }

        return feedbackOverlay;
    }

    function updateFeedback(text) {
        const overlay = getFeedbackOverlay();
        overlay.textContent = text;
        overlay.style.opacity = 1;
    }

    function hideFeedback() {
        const overlay = getFeedbackOverlay();
        overlay.style.opacity = 0;
    }

    function handleVideoDragSeek(deltaX) {
        if (!currentVideo) return;

        const secondsPerPixel = currentVideo.clientWidth > 0 ? (currentVideo.duration / currentVideo.clientWidth) : 0.05;
        const seekSeconds = deltaX * secondsPerPixel;

        const newTime = Math.min(
            currentVideo.duration,
            Math.max(0, currentVideo.currentTime + seekSeconds)
        );

        currentVideo.currentTime = newTime;

        const duration = currentVideo.duration;
        const formatTime = (time) => {
            const h = Math.floor(time / 3600);
            const m = Math.floor((time % 3600) / 60);
            const s = Math.floor(time % 60);
            return [h, m, s]
                .filter((v, i) => i > 0 || v > 0)
                .map(v => v.toString().padStart(2, '0'))
                .join(':')
                .replace(/^0/, '');
        };

        const currentTimeFormatted = formatTime(newTime);
        const durationFormatted = formatTime(duration);
        const feedbackText = `${currentTimeFormatted} / ${durationFormatted}`;
        updateFeedback(feedbackText);
    }

    function setupVideoDragging(video) {

        if (!video || video._draggingSetup) return;

        const startEvent = isMobile ? 'touchstart' : 'mousedown';
        const moveEvent = isMobile ? 'touchmove' : 'mousemove';
        const endEvent = isMobile ? 'touchend' : 'mouseup';

        const getClientX = (e) => (isMobile ? e.touches[0]?.clientX : e.clientX);

        const handleStart = (e) => {
            if (isNetflix || isSeeking) return;

            // Only proceed if the event started on the video itself and it's a left click (desktop) or a touch (mobile)
            if (!isMobile && e.button !== 0) return;
            if (e.target !== video) return;

            isDragging = true;
            dragStartX = getClientX(e);

            // Prevent default behavior for desktop drag, but often necessary for mobile touchstart to ensure event handling
            if (!isMobile) {
                e.preventDefault();
            }
        };

        const handleMove = (e) => {
            if (!isDragging || !currentVideo) return;
            const currentX = getClientX(e);
            if (currentX === undefined) return;

            const deltaX = currentX - dragStartX;
            handleVideoDragSeek(deltaX);
        };

        const handleEnd = () => {
            if (isDragging) {
                isDragging = false;
                hideFeedback();
            }
        };

        // Attach events to the video element itself
        video.addEventListener(startEvent, handleStart, { capture: true });
        video.addEventListener('dragstart', (e) => e.preventDefault());

        // Attach move and end events to the document for robustness (allows dragging outside the video area)
        document.addEventListener(moveEvent, handleMove, { capture: true });
        document.addEventListener(endEvent, handleEnd, { capture: true });
        document.addEventListener('mouseleave', handleEnd);

        video._draggingSetup = true;
    }

    // --- Popup UI Functions (Restored and Modified for Drag Handle) ---

    function createPopupElement() {
        if (popupElement) return;

        // Styles for buttons and drag handle
        const buttonStyle = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap;`;
        const dragHandleStyle = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;

        // 1. Create the container element and apply base styles
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';

        // Set initial display to none (hidden)
        popupElement.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px; padding: 0; color: white; font-family: sans-serif; z-index: 2147483647; display: none; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); min-width: 200px; text-align: center;`;

        // 2. Add control buttons and the new drag handle
        popupElement.innerHTML = `
            <div id="vcp-drag-handle" style="${dragHandleStyle}">Video Controller</div>
            <div style="padding: 10px;">
                <div style="display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;">
                    <button data-action="seek-backward-10" style="${buttonStyle}">-10s</button>
                    <button data-action="play-pause" style="${buttonStyle}">Play/Pause</button>
                    <button data-action="seek-forward-10" style="${buttonStyle}">+10s</button>
                </div>
                <div style="margin-bottom: 10px;">
                    <label for="vcp-speed" style="display: block; margin-bottom: 5px;">Speed: <span id="vcp-speed-display">1.0</span>x</label>
                    <input type="range" id="vcp-speed" min="0.20" max="5.0" step="0.2" value="1.0" style="width: 100%; cursor: pointer;">
                </div>
                <div style="margin-bottom: 10px;">
                    <label for="vcp-volume" style="display: block; margin-bottom: 5px;">Volume: <span id="vcp-volume-display">100</span>%</label>
                    <input type="range" id="vcp-volume" min="0.0" max="5.0" step="0.05" value="1.0" style="width: 100%; cursor: pointer;">
                </div>
                <div style="margin-bottom: 10px;">
                <button data-action="pip" style="${buttonStyle}; margin-top: 5px;">PIP Mode</button>
                <button data-action="exit-fullscreen" style="${buttonStyle}; margin-top: 5px;">FULL EXIT</button>
                <div id="vcp-status" style="margin-top: 10px; font-size: 12px; color: #777;">Status: Ready</div>
            </div>
        `;

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    // 3. Set up event listeners for controls and drag handle
    function setupPopupEventListeners() {
        if (!popupElement) return;

        // Controls (speed, volume, buttons)
        popupElement.addEventListener('click', (e) => {
            resetPopupHideTimer(); // Reset timer on interaction with popup
            const target = e.target;
            const action = target.getAttribute('data-action');

            if (!currentVideo) {
                updateStatus('No video selected.');
                return;
            }

            switch (action) {
                case 'seek-backward-10':
                    currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 10);
                    updateStatus('-10s');
                    break;
                case 'seek-forward-10':
                    currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 10);
                    updateStatus('+10s');
                    break;
                case 'play-pause':
                    if (currentVideo.paused) {
                        currentVideo.play();
                        updateStatus('Playing');
                    } else {
                        currentVideo.pause();
                        updateStatus('Paused');
                    }
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

        // Speed control listener
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        speedInput.addEventListener('input', () => {
            resetPopupHideTimer(); // Reset timer on interaction
            const rate = parseFloat(speedInput.value);
            speedDisplay.textContent = rate.toFixed(2);
            if (currentVideo) {
                fixPlaybackRate(currentVideo, rate);
                updateStatus(`Speed: ${rate.toFixed(2)}x`);
            }
        });

        // Volume control listener
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        volumeInput.addEventListener('input', () => {
            resetPopupHideTimer(); // Reset timer on interaction
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
            // Prevent dragging if the target is NOT the drag handle
            if (e.target !== dragHandle) return;
            resetPopupHideTimer(); // Keep popup visible while dragging

            isPopupDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            const rect = popupElement.getBoundingClientRect();
            popupDragOffsetX = clientX - rect.left;
            popupDragOffsetY = clientY - rect.top;

            // Ensure the popup uses fixed positioning for dragging
            popupElement.style.position = 'fixed';
            popupElement.style.transform = 'none';
            // Prevent text selection during drag
            document.body.style.userSelect = 'none';
        };

        const stopDrag = () => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = ''; // Restore text selection
                resetPopupHideTimer(); // Restart timer after drag ends
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;

            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);

            if (clientX === undefined || clientY === undefined) return;

            // Calculate new position
            let newX = clientX - popupDragOffsetX;
            let newY = clientY - popupDragOffsetY;

            // Update popup position
            popupElement.style.left = `${newX}px`;
            popupElement.style.top = `${newY}px`;
        };

        // Attach drag events only to the handle
        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag);

        // Attach move and end events to the document for robust dragging
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
            popupElement.style.display = 'block';
        }
    }

    function hidePopup() {
        if (popupElement) {
            // Only hide if the user isn't currently dragging the popup
            if (!isPopupDragging) {
                popupElement.style.display = 'none';
            }
        }
    }

    // 6. Temporary visibility functions
    function resetPopupHideTimer() {
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
        }
        popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function showPopupTemporarily() {
        if (popupElement && currentVideo) {
            // 1) 일단 display: block 으로 바꿔서 크기를 계산해야 함
            popupElement.style.display = 'block';

            // 2) 바로 위치 갱신
            updatePopupPosition();

            // 3) 다시 display: block 보장 (이미 켜졌으므로 유지)
            popupElement.style.display = 'block';

            resetPopupHideTimer();
        }
    }

    // 7. Update popup position relative to the current video
    function updatePopupPosition() {
        // Only update position if we are NOT currently dragging the popup AND there is a current video
        if (!popupElement || !currentVideo || isPopupDragging) {
            if (!currentVideo) hidePopup();
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        // Check if the video is visible in the viewport
        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                               videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            // Calculate a centered position relative to the video
            const viewportX = videoRect.left + videoRect.width / 2 - (popupRect.width / 2);
            const viewportY = videoRect.top + videoRect.height / 2 - (popupRect.height / 2);

            // Set popup position
            popupElement.style.left = `${viewportX}px`;
            popupElement.style.top = `${viewportY}px`;
            popupElement.style.transform = 'none'; // Ensure transform is reset if used
            popupElement.style.position = 'fixed';

            // Note: We don't call showPopup() here, as it's handled by showPopupTemporarily() or drag interaction.
        } else {
            // If the video is not visible, hide the popup
            hidePopup();
        }
    }

    // --- Multiple Video Control (New/Updated logic) ---

    function setupVideoHover() {
        // Remove previous listeners if they exist (to prevent duplicates)
        videos.forEach(v => {
            if (v._vcpHoverListener) {
                v.removeEventListener('mouseenter', v._vcpHoverListener);
                v._vcpHoverListener = null;
            }
            if (v._vcpTouchListener) { // Cleanup for mobile touch listener
                v.removeEventListener('touchstart', v._vcpTouchListener);
                v._vcpTouchListener = null;
            }
        });

        videos.forEach(video => {
            const handleInteraction = () => {
                //if (currentVideo !== video) {
                    currentVideo = video;
                    setupVideoDragging(currentVideo);
                    updatePopupSliders();
                //}
                    showPopupTemporarily();
            };

            // 데스크탑: 마우스가 영상 위로 들어갈 때 이벤트 등록
            video.addEventListener('mouseenter', handleInteraction);
            video._vcpHoverListener = handleInteraction;

            // 모바일: 터치 시작 이벤트 등록
            if (isMobile) {
                video.addEventListener('touchstart', handleInteraction);
                video._vcpTouchListener = handleInteraction;
            }
        });
    }

    // Updates the UI sliders to reflect the properties of the currently selected video.
    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        // Update Speed UI
        const rate = currentVideo.playbackRate || 1.0;
        speedInput.value = rate.toFixed(2);
        speedDisplay.textContent = rate.toFixed(2);

        let volume = currentVideo.volume;
        if (gainNode && connectedVideo === currentVideo) {
            volume = gainNode.gain.value;
        }

        volumeInput.value = volume.toFixed(2);
        volumeDisplay.textContent = Math.round(volume * 100);
    }

    // --- Main Initialization ---

    function updateVideoList(shouldShowPopup = true) {
        // Scan for all playable videos and update the 'videos' array
        findPlayableVideos();

        if (videos.length > 0) {
            setupVideoHover();
        }

        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
            currentVideo = null;
            hidePopup();
        }

        if (!currentVideo && videos.length > 0) {
            currentVideo = videos[0];
            setupVideoDragging(currentVideo);
            updatePopupSliders();

            if (shouldShowPopup && !isInitialPopupBlocked) {
                //showPopupTemporarily();
            }
        }
    }

    function setupVideoObserver() {
        const observerConfig = { childList: true, subtree: true };

        const observerCallback = (mutationsList) => {
            let foundChanges = false;
            // Check if nodes were added or removed that might contain video/audio elements
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    const addedNodes = Array.from(mutation.addedNodes);
                    const removedNodes = Array.from(mutation.removedNodes);

                    // Check for video/audio elements or shadow roots within added/removed nodes
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

                updateVideoList(false);
            }
        };

        videoObserver = new MutationObserver(observerCallback);
        videoObserver.observe(document.body, observerConfig);
    }

    function fixOverflow() {
        // Specific site fixes (e.g., Twitch) to ensure video players don't clip the feedback overlay
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

    function onUserInteraction() {

        updateVideoList(true); // 'true' means we attempt to show the popup upon interaction
    }

    function initialize() {
        console.log('[VCP] Video Controller Popup script initialized.');

        createPopupElement();

        // ✅ 이 위치에 추가하세요!
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

        updateVideoList(true);

        setupVideoObserver();

        setInterval(() => updateVideoList(false), 5000); // Do not show popup automatically on interval check
        setInterval(updatePopupPosition, 100);

        fixOverflow();

        document.addEventListener('click', () => {
            updateVideoList();
            if (currentVideo) {
                showPopupTemporarily();
            }
          });
        document.addEventListener('touchstart', onUserInteraction);
    }

    // Initialize the script
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
