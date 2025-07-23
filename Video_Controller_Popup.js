// ==UserScript==
// @name Video Controller Popup (V4.11.23: 클릭 필터링 제거)
// @namespace Violentmonkey Scripts
// @version 4.11.23_NoFilter
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider.
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

    const videoRateHandlers = new WeakMap();
    let checkVideoInterval = null;
    const originalPlayMethods = new WeakMap(); // 원본 play() 메서드를 저장

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 0.5초마다 비디오 상태 체크 (위치 갱신)

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
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused; // 오디오 태그이거나 재생 중이면 크기 무시
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || v.src; // 비디오 미디어 데이터가 있거나 오디오 태그인지, src가 있는지
            const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);

            // 특정 사이트 또는 요소 제외 로직 (예: YouTube Shorts)
            if (v.closest('ytd-reel-player-overlay-renderer')) {
                return false;
            }

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
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO' || currentVideo.src;

        const fsEl = document.fullscreenElement;
        if (fsEl) {
            if (!fsEl.contains(currentVideo)) {
                return false;
            }
        }
        if (currentVideo.closest('ytd-reel-player-overlay-renderer')) {
            return false;
        }

        return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
    }

    function selectAndControlVideo(videoToControl) {
        console.log('[VCP Debug] selectAndControlVideo called with:', videoToControl);
        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            console.log('[VCP Debug] No video to control. Hiding popup.');
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
            console.log('[VCP Debug] New currentVideo set:', currentVideo);
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
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647 !important;
            display: none; opacity: 0; transition: opacity 0.3s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: fit-content;
            min-width: 280px;
            overflow: hidden; text-align: center; pointer-events: auto !important;
            display: flex;
            flex-direction: column;
            align-items: stretch;
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            flex-grow: 1;
            text-align: center;
            cursor: grab;
            padding: 0 5px;
        `;
        header.appendChild(dragHandle);

        const closeButton = document.createElement('button');
        closeButton.textContent = 'X';
        closeButton.style.cssText = `
            background: none; border: none; color: #ccc; font-size: 1.2em;
            cursor: pointer; padding: 0 8px; line-height: 1;
            transition: color 0.2s;
        `;
        closeButton.onmouseover = () => closeButton.style.color = 'white';
        closeButton.onmouseout = () => closeButton.style.color = '#ccc';
        closeButton.addEventListener('click', (e) => {
            e.stopPropagation(); // 버튼 클릭 시 팝업 외부 클릭 이벤트 방지
            hidePopup();
            console.log('[VCP Debug] X button clicked. Hiding popup.');
        });
        header.appendChild(closeButton);
        popupElement.appendChild(header);


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
        console.log('[VCP Debug] Popup element created and appended to body.');
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
        console.log('[VCP Debug] Button clicked:', action);
        // 전체 화면에서는 타이머 리셋하지 않음 (팝업이 계속 떠 있도록)
        if (!document.fullscreenElement) {
             resetPopupHideTimer();
        }

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
            // 전체 화면에서는 타이머 리셋하지 않음
            if (!document.fullscreenElement) {
                resetPopupHideTimer();
            }
            const rate = parseFloat(speedInput.value);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2) + 'x';
            console.log('[VCP Debug] Speed slider input:', rate);
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            if (e.target !== dragHandle) return;
            // 전체 화면에서는 타이머 리셋하지 않음
            if (!document.fullscreenElement) {
                resetPopupHideTimer();
            }
            isPopupDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
            const rect = popupElement.getBoundingClientRect();
            popupDragOffsetX = clientX - rect.left;
            popupDragOffsetY = clientY - rect.top;
            if (!document.fullscreenElement) {
                popupElement.style.position = 'fixed';
            }
            popupElement.style.transform = 'none';
            document.body.style.userSelect = 'none';
            console.log('[VCP Debug] Popup drag started.');
        };

        const stopDrag = () => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                // 전체 화면에서는 타이머 리셋하지 않음
                if (!document.fullscreenElement) {
                    resetPopupHideTimer();
                }
                updatePopupPosition();
                console.log('[VCP Debug] Popup drag stopped.');
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;

            const fsEl = document.fullscreenElement;
            if (fsEl) {
                const fsRect = fsEl.getBoundingClientRect();
                popupElement.style.left = `${clientX - popupDragOffsetX - fsRect.left}px`;
                popupElement.style.top = `${clientY - popupDragOffsetY - fsRect.top}px`;
            } else {
                popupElement.style.left = `${clientX - popupDragOffsetX}px`;
                popupElement.style.top = `${clientY - popupDragOffsetY}px`;
            }
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
            const styles = {
                display: 'flex',
                opacity: '0.75',
                visibility: 'visible',
                pointerEvents: 'auto',
                zIndex: '2147483647 !important'
            };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
            isPopupVisible = true;
            console.log('[VCP Debug] Popup visibility set to TRUE.');
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            isPopupVisible = false;
            console.log('[VCP Debug] Popup visibility set to FALSE.');
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            console.log('[VCP Debug] showPopup: No currentVideo, hiding popup.');
            return;
        }

        setPopupVisibility(true);
        updatePopupPosition();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
        console.log('[VCP Debug] Popup would be shown now.');
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        // 전체 화면이 아닐 때만 팝업 자동 숨김 타이머를 설정합니다.
        // Fullscreen 모드에서는 사용자가 직접 닫기 전까지 팝업이 유지됩니다.
        if (!document.fullscreenElement && !isPopupDragging && isPopupVisible) {
            popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
            console.log(`[VCP Debug] Popup hide timer reset for ${POPUP_TIMEOUT_MS}ms.`);
        } else {
            console.log('[VCP Debug] Popup hide timer NOT reset (fullscreen or dragging or not visible).');
        }
    }

    function updatePopupPosition() {
        if (!currentVideo || !popupElement || isPopupDragging) {
            console.log('[VCP Debug] updatePopupPosition skipped (no video, no popup, or dragging).');
            return;
        }

        const fsEl = document.fullscreenElement;
        let videoToUseForPosition = currentVideo;

        if (fsEl) {
            console.log('[VCP Debug] Fullscreen element detected:', fsEl);
            if (!fsEl.contains(currentVideo)) {
                console.log('[VCP Debug] currentVideo not in fullscreen element. Searching for alternative.');
                const fsVideos = Array.from(fsEl.querySelectorAll('video, audio')).filter(v => {
                    const rect = v.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0 && fsEl.contains(v);
                });
                if (fsVideos.length > 0) {
                    videoToUseForPosition = fsVideos.sort((a, b) => {
                        const aRect = a.getBoundingClientRect();
                        const bRect = b.getBoundingClientRect();
                        return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                    })[0];
                    console.log('[VCP Debug] Found largest video in fullscreen:', videoToUseForPosition);
                    if (!videoToUseForPosition) {
                        hidePopup();
                        return;
                    }
                } else {
                    console.log('[VCP Debug] No video found in fullscreen element. Hiding popup.');
                    hidePopup();
                    return;
                }
            } else {
                console.log('[VCP Debug] currentVideo is in fullscreen element.');
            }

            const videoRect = videoToUseForPosition.getBoundingClientRect();
            popupElement.style.width = '280px';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'absolute'; // Fullscreen 요소 내부에 상대적 위치
            popupElement.style.transform = 'none';

            const popupRect = popupElement.getBoundingClientRect();
            const fsRect = fsEl.getBoundingClientRect();

            let targetX = (videoRect.left - fsRect.left) + (videoRect.width / 2);
            let targetY = (videoRect.top - fsRect.top) + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, fsRect.width - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, fsRect.height - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
            console.log(`[VCP Debug] Fullscreen popup position: left=${adjustedX}, top=${adjustedY}, videoRect:`, videoRect, "fsRect:", fsRect);

        } else {
            const videoRect = currentVideo.getBoundingClientRect();
            popupElement.style.width = 'fit-content';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'fixed';
            popupElement.style.transform = 'none';

            const popupRect = popupElement.getBoundingClientRect();

            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = Math.max(0, Math.min(targetY - (popupRect.height / 2), window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
            console.log(`[VCP Debug] Normal popup position: left=${adjustedX}, top=${adjustedY}, videoRect:`, videoRect);
        }

        const isVideoVisible = videoToUseForPosition.getBoundingClientRect().top < window.innerHeight && videoToUseForPosition.getBoundingClientRect().bottom > 0 && videoToUseForPosition.getBoundingClientRect().left < window.innerWidth && videoToUseForPosition.getBoundingClientRect().right > 0;
        if (!isVideoVisible) {
            hidePopup();
            console.log('[VCP Debug] Video is not visible, hiding popup.');
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
        console.log('[VCP Debug] selectVideoLogic triggered.');
        updateVideoList();

        let activeVideo = null;
        const fsEl = document.fullscreenElement;

        if (fsEl) {
            console.log('[VCP Debug] Fullscreen element found when selecting video:', fsEl);
            const fsVideos = Array.from(fsEl.querySelectorAll('video, audio')).filter(v => {
                const rect = v.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && fsEl.contains(v);
            });

            if (fsVideos.length > 0) {
                activeVideo = fsVideos.sort((a, b) => {
                    const aRect = a.getBoundingClientRect();
                    const bRect = b.getBoundingClientRect();
                    return (bRect.width * bRect.height) - (aRect.width * aRect.height);
                })[0];
                console.log('[VCP Debug] Largest video in fullscreen:', activeVideo);
            } else {
                console.log('[VCP Debug] No videos found within fullscreen element.');
            }
        }

        if (!activeVideo) {
            if (currentVideo && document.body.contains(currentVideo)) {
                activeVideo = currentVideo;
                console.log('[VCP Debug] Reusing currentVideo as activeVideo.');
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
                console.log('[VCP Debug] Selected activeVideo by score:', activeVideo);
            }
        }

        if (activeVideo) {
            if (currentVideo !== activeVideo) {
                if (currentVideo) currentVideo.pause();
                selectAndControlVideo(activeVideo);
            }

            if (e instanceof Event) {
                console.log('[VCP Debug] Event triggered showPopup.');
                showPopup();
                // 전체 화면이 아닐 때만 팝업 숨김 타이머를 리셋합니다.
                if (!document.fullscreenElement) {
                    resetPopupHideTimer();
                }
            }
        } else {
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            hidePopup();
            console.log('[VCP Debug] No active video, hiding popup.');
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            console.log('[VCP Debug] Scroll event handling.');
            updateVideoList();

            if (currentVideo && (!checkCurrentVideoVisibility() || !document.body.contains(currentVideo))) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
                console.log('[VCP Debug] Current video not visible/present after scroll, hiding popup.');
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
            console.log('[VCP Debug] Current video removed from DOM or not in playable list, hiding popup.');
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
                    if (mutation.attributeName === 'src' || mutation.attributeName === 'controls' || mutation.attributeName === 'style') {
                        foundMediaChange = true;
                        break;
                    }
                }
            }
            if (foundMediaChange) {
                console.log('[VCP Debug] DOM change detected. Updating video list and selecting.');
                updateVideoList();
                selectVideoLogic(null);
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
        document.body.style.setProperty('overflow', 'visible', 'important');
        const fsObserver = new MutationObserver((mutations) => {
            if (document.fullscreenElement) {
                document.fullscreenElement.style.setProperty('overflow', 'visible', 'important');
            }
        });
        fsObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    }

    function startCheckingVideoStatus() {
        if (checkVideoInterval) clearInterval(checkVideoInterval);
        checkVideoInterval = setInterval(() => {
            findAllVideosDeep().forEach(video => {
                if (video !== currentVideo) {
                    if (!video.paused) {
                        video.pause();
                    }
                    if (!video.muted || video.volume > 0) {
                        video.muted = true;
                        video.volume = 0;
                    }
                } else {
                    if (video.paused && !video.ended && !isManuallyPaused) {
                        video.play().catch(e => {
                            // console.warn("[VCP] Autoplay attempt failed in interval:", e.message);
                        });
                    }
                    if (video.playbackRate !== desiredPlaybackRate) {
                        desiredPlaybackRate = video.playbackRate;
                        updatePopupSliders();
                    }
                    if (video.muted !== (isManuallyMuted || desiredVolume === 0) || Math.abs(video.volume - desiredVolume) > 0.005) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                        updateMuteSpeakButtons();
                    }
                }
            });

            if (!currentVideo) {
                selectVideoLogic(null);
            }

            // 팝업이 이미 표시되어 있다면 위치 및 UI 업데이트만 수행
            if (popupElement && isPopupVisible && !isPopupDragging) {
                updatePopupPosition();
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders();
            }
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }

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
        console.log('[VCP Debug] Body click detected. Target:', e.target);
        if (!e) return;

        // 클릭된 요소가 팝업 자체 또는 팝업의 자식 요소인지 확인
        if (popupElement && popupElement.contains(e.target)) {
            console.log('[VCP Debug] Click inside popup. Preventing hide and other actions.');
            // 팝업 내부 클릭 시 타이머 리셋 (전체 화면이 아닐 때만)
            if (!document.fullscreenElement) {
                resetPopupHideTimer();
            }
            return; // 팝업 내부 클릭은 다른 동작을 방해하지 않음
        }

        if (touchMoved) {
            touchMoved = false;
            console.log('[VCP Debug] Touch moved, ignoring click.');
            return;
        }

        // 팝업이 보이고, 팝업 외부를 클릭했을 때 팝업을 숨김
        // (단, 팝업 내부 클릭은 위에서 이미 걸러졌고, 이제 다른 필터링은 없음)
        if (popupElement && isPopupVisible) {
            console.log('[VCP Debug] Popup visible and click outside popup. Hiding popup.');
            hidePopup();
            // 팝업을 숨긴 후에는 영상 선택 로직을 다시 실행하지 않음
            return;
        }

        // 팝업이 숨겨져 있거나, 팝업이 없는 상태에서 모든 클릭 시 팝업 표시 로직 실행
        console.log('[VCP Debug] Click outside popup (or popup hidden). Calling selectVideoLogic to show popup.');
        selectVideoLogic(e);
    }, true); // 이벤트 캡처링 단계에서 처리

    document.body.addEventListener('touchend', (e) => {
        console.log('[VCP Debug] Body touchend detected. Target:', e.target);
        if (!e) return;

        // 클릭된 요소가 팝업 자체 또는 팝업의 자식 요소인지 확인
        if (popupElement && popupElement.contains(e.target)) {
            console.log('[VCP Debug] Touchend inside popup. Preventing hide and other actions.');
            // 팝업 내부 클릭 시 타이머 리셋 (전체 화면이 아닐 때만)
            if (!document.fullscreenElement) {
                resetPopupHideTimer();
            }
            return; // 팝업 내부 클릭은 다른 동작을 방해하지 않음
        }

        if (touchMoved) {
            touchMoved = false;
            console.log('[VCP Debug] Touch moved, ignoring touchend.');
            return;
        }

        // 팝업이 보이고, 팝업 외부를 클릭했을 때 팝업을 숨김
        // (단, 팝업 내부 클릭은 위에서 이미 걸러졌고, 이제 다른 필터링은 없음)
        if (popupElement && isPopupVisible) {
            console.log('[VCP Debug] Popup visible and touchend outside popup. Hiding popup.');
            hidePopup();
            // 팝업을 숨긴 후에는 영상 선택 로직을 다시 실행하지 않음
            return;
        }

        // 팝업이 숨겨져 있거나, 팝업이 없는 상태에서 모든 터치 종료 시 팝업 표시 로직 실행
        console.log('[VCP Debug] Touchend outside popup (or popup hidden). Calling selectVideoLogic to show popup.');
        selectVideoLogic(e);
    }, true); // 이벤트 캡처링 단계에서 처리

    // CSS를 동적으로 추가하는 함수
    function addCustomStyles() {
        const style = document.createElement('style');
        style.type = 'text/css';
        style.id = 'vcp-custom-styles'; // 스크립트가 추가한 스타일임을 명시
        style.textContent = `
            /* HTML5 기본 비디오 컨트롤 숨김 */
            video::-webkit-media-controls {
                display: none !important;
            }
            video::-moz-media-controls {
                display: none !important;
            }
            video::--ms-media-controls { /* IE/Edge (벤더 프리픽스 주의) */
                display: none !important;
            }
            video::media-controls { /* 표준 (향후 적용될 수 있음) */
                display: none !important;
            }
        `;
        document.head.appendChild(style);
        console.log('[VCP Debug] Custom CSS added.');
    }

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.23_NoFilter');

        addCustomStyles(); // 커스텀 CSS 추가
        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            console.log('[VCP Debug] Fullscreen change event. Current fullscreen element:', fsEl);
            if (popupElement) {
                if (fsEl) {
                    // 전체 화면 진입 시
                    fsEl.appendChild(popupElement); // Fullscreen 요소 내부에 팝업 이동
                    popupElement.style.setProperty('z-index', '2147483647', 'important');
                    popupElement.style.setProperty('pointer-events', 'auto', 'important');

                    popupElement.style.width = '280px';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'absolute'; // Fullscreen 요소 내부에 상대적 위치
                    popupElement.style.transform = 'none';

                    updatePopupPosition();
                    showPopup(); // 전체 화면 진입 시 팝업 표시
                    console.log('[VCP Debug] Entered fullscreen, popup shown.');
                } else {
                    // 전체 화면 종료 시
                    document.body.appendChild(popupElement);
                    popupElement.style.setProperty('z-index', '2147483647', 'important');
                    popupElement.style.setProperty('pointer-events', 'auto', 'important');

                    popupElement.style.width = 'fit-content';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'fixed';
                    popupElement.style.transform = 'none';

                    updatePopupPosition();
                    hidePopup(); // 일반 화면으로 돌아오면 팝업 숨김
                    console.log('[VCP Debug] Exited fullscreen, popup hidden.');
                }
            }
        });

        window.addEventListener('resize', () => {
            console.log('[VCP Debug] Window resize event. Updating popup position.');
            updatePopupPosition();
        });

        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList();
        setupDOMObserver();
        setupSPADetection();
        fixOverflow();

        startCheckingVideoStatus();

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval);
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
