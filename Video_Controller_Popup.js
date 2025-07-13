// ==UserScript==
// @name Video Controller Popup (Modified: No Time/Netflix Features)
// @namespace Violentmonkey Scripts
// @version 4.09.9_Stripped_TrustedHTML_Fix_DOM_Create
// @description Optimized video controls including speed, volume amplification, and Shadow DOM compatibility. (Seeking and Netflix-specific features removed)
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
    let desiredPlaybackRate = 1.0;
    let videoObserver = null;
    let isPopupDragging = false; // Popup UI drag state
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;

    // New variables for temporary popup visibility
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000; // 2seconds to hide

    // --- Environment Flags & Configuration ---
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // Blacklists for specific functionality
    const lazySrcBlacklist = ['missav.ws', 'missav.live'];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));
    const AMPLIFICATION_BLACKLIST = ['avsee.ru'];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // --- Site-specific configuration for blocking initial popup display (MODIFICATION) ---
    const SITE_POPUP_BLOCK_LIST = [
        'sooplive.co.kr',
        'twitch.tv',
        'kick.com'
    ];
    const isInitialPopupBlocked = SITE_POPUP_BLOCK_LIST.some(site => location.hostname.includes(site));

    // --- Audio Context for Volume Amplification ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    // --- Utility Functions ---

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
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                (v.videoWidth > 0 || v.tagName === 'AUDIO' || v.tagName === 'VIDEO') &&
                (v.clientWidth > 50 || v.clientHeight > 50)
            );
        });

        videos = playableVideos;
        return playableVideos;
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
            video.volume = vol;
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

    // --- Popup UI Functions (Modified for TrustedHTML by creating elements directly) ---

    function createPopupElement() {
        if (popupElement) return;

        // 1. Create the container element and apply base styles
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px; padding: 0; color: white; font-family: sans-serif; z-index: 2147483647; display: none; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); min-width: 200px; text-align: center;`;

        // 2. Create the internal structure using direct DOM manipulation

        // Styles for elements
        const buttonStyle = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;
        const dragHandleStyle = `font-weight: bold; margin-bottom: 8px; color: #aaa; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;

        // Drag Handle
        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.style.cssText = dragHandleStyle;
        dragHandle.textContent = '비디오.오디오 컨트롤러';

        // Controls Wrapper
        const controlsWrapper = document.createElement('div');
        controlsWrapper.style.cssText = 'padding: 10px;';

        // Play/Pause Section
        const playPauseSection = document.createElement('div');
        playPauseSection.style.cssText = 'display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;';

        const playPauseButton = document.createElement('button');
        playPauseButton.setAttribute('data-action', 'play-pause');
        playPauseButton.style.cssText = buttonStyle;
        playPauseButton.textContent = '재생/멈춤';
        playPauseSection.appendChild(playPauseButton);

        // Speed Section
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

        // Volume Section
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

        // PIP, Fullscreen, and Status Section
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

        // Assemble the popup structure
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
            popupElement.style.display = 'block';
            updatePopupPosition();
            popupElement.style.display = 'block';
            resetPopupHideTimer();
        }
    }

    // 7. Update popup position relative to the current video
    function updatePopupPosition() {
        if (!popupElement || !currentVideo || isPopupDragging) {
            if (!currentVideo) hidePopup();
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 &&
                               videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            const viewportX = videoRect.left + videoRect.width / 2 - (popupRect.width / 2);
            const viewportY = videoRect.top + videoRect.height / 2 - (popupRect.height / 2);

            popupElement.style.left = `${viewportX}px`;
            popupElement.style.top = `${viewportY}px`;
            popupElement.style.transform = 'none';
            popupElement.style.position = 'fixed';
        } else {
            hidePopup();
        }
    }

    // --- Multiple Video Control (New/Updated logic) ---

    function setupVideoHover() {
        videos.forEach(v => {
            if (v._vcpHoverListener) {
                v.removeEventListener('mouseenter', v._vcpHoverListener);
                v._vcpHoverListener = null;
            }
            if (v._vcpTouchListener) {
                v.removeEventListener('touchstart', v._vcpTouchListener);
                v._vcpTouchListener = null;
            }
        });

        videos.forEach(video => {
            const handleInteraction = () => {
                currentVideo = video;
                setupVideoDragging(currentVideo);
                updatePopupSliders();
                showPopupTemporarily();
            };

            video.addEventListener('mouseenter', handleInteraction);
            video._vcpHoverListener = handleInteraction;

            if (isMobile) {
                video.addEventListener('touchstart', handleInteraction);
                video._vcpTouchListener = handleInteraction;
            }
        });
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        const rate = currentVideo.playbackRate || 1.0;
        if (speedInput) {
            speedInput.value = rate.toFixed(2);
        }
        if (speedDisplay) {
            speedDisplay.textContent = rate.toFixed(2);
        }

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

    // --- Main Initialization ---

    function updateVideoList(shouldShowPopup = true) {
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
                updateVideoList(false);
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

    function onUserInteraction() {
        updateVideoList(true);
    }

    function initialize() {
        console.log('[VCP] Video Controller Popup script initialized.');

        createPopupElement();

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

        setInterval(() => updateVideoList(false), 5000);
        setInterval(updatePopupPosition, 100);

        fixOverflow();

        // 미리보기 영상 클릭 시 팝업 차단
    const previewVideoSelector = '.preview-video-selector'; // 미리보기 영상의 실제 셀렉터로 수정

    document.addEventListener('click', (event) => {
        const clickedElement = event.target;

        // 클릭한 요소가 미리보기 영상인 경우
        if (clickedElement.closest(previewVideoSelector)) {
            console.log("미리보기 영상 클릭됨, 팝업 차단.");
            return; // 팝업을 띄우지 않음
        }

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
