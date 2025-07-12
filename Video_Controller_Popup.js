// ==UserScript==
// @name Video Controller Popup (Shadow DOM)
// @namespace Violentmonkey Scripts
// @version 4.09.9_Optimized_Whitelist_Modified (Dragging Fix + Fullscreen Container Check + Drag Feedback + Mobile Fixes)
// @description 여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let currentIntervalId = null;
    let videos = [];
    let currentVideo = null;
    let popupElement = null;
    let isSeeking = false;
    let desiredPlaybackRate = 1.0;
    let videoObserver = null;

    // Variables for video dragging
    let isDragging = false;
    let dragStartX = 0;
    let dragStartTime = 0;
    let videoDraggingActive = false;
    let feedbackOverlay = null; // Reference to the feedback overlay element

    // Dragging configuration
    const DRAG_SENSITIVITY_SECONDS = 30; // 100% video width drag = 30 seconds of seeking

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    // 팝업 투명도 설정: localStorage에 설정값이 없으면 '0.025' (투명)을 기본값으로 사용
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '0';

    // Lazy-src 예외 사이트 (Blacklist)
    const lazySrcBlacklist = [
        'missav.ws',
        'missav.live',
    ];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

    // 증폭 차단 사이트 (Blacklist)
    const AMPLIFICATION_BLACKLIST = [
        'avsee.ru',
    ];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // overflow visible fix 사이트 설정
    const overflowFixSites = [
        { domain: 'twitch.tv', selector: [
            'div.video-player__container',
            'div.video-player-theatre-mode__player',
            'div.player-theatre-mode'
        ]},
    ];
    const overflowFixTargets = overflowFixSites.filter(site =>
        location.hostname.includes(site.domain)
    );

    // --- Utility Functions ---

    /**
     * 특정 사이트의 overflow 속성을 'visible'로 설정하여 UI 잘림을 방지합니다.
     */
    function fixOverflow() {
        overflowFixTargets.forEach(site => {
            site.selector.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.overflow = 'visible';
                });
            });
        });
    }

    /**
     * DOM 전체 (Shadow DOM 포함)에서 모든 <video> 요소를 깊이 탐색하여 찾습니다.
     */
    function findAllVideosDeep(root = document) {
        const found = [];
        root.querySelectorAll('video').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found.push(...findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    }

    /**
     * 재생 가능한 비디오 요소를 찾아 반환합니다. (디버그 로그 포함)
     */
    function findPlayableVideos() {
        const found = findAllVideosDeep();

        // Debugging: Log the found video elements before filtering
        console.log('[DEBUG] Found videos (raw):', found.length, found);

        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        // 숨겨진 비디오, 오디오 트랙, 그리고 크기가 너무 작은 비디오를 제외합니다.
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                v.videoWidth > 0 &&
                v.videoHeight > 0 &&
                v.clientWidth > 50 &&
                v.clientHeight > 50
            );
        });

        console.log('[DEBUG] Found playable videos:', playableVideos.length, playableVideos);
        return playableVideos;
    }

    /**
     * 비디오의 재생 속도를 설정하고, 모든 사이트에서 이를 강제 유지합니다.
     * @param {HTMLVideoElement} video
     * @param {number} rate
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;

        // 1. Set the desired rate globally for the script
        desiredPlaybackRate = rate;

        // 2. Set the playback rate on the video element
        video.playbackRate = rate;

        // 3. Ensure persistent rate maintenance
        if (currentIntervalId) {
            clearInterval(currentIntervalId);
        }

        if (currentVideo && currentVideo._rateChangeHandler) {
            currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
            currentVideo._rateChangeHandler = null;
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video.addEventListener('ratechange', rateChangeHandler);
        video._rateChangeHandler = rateChangeHandler;

        currentIntervalId = setInterval(() => {
            if (document.body.contains(video) && video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            } else if (!document.body.contains(video)) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
                if (video._rateChangeHandler) {
                    video.removeEventListener('ratechange', video._rateChangeHandler);
                    video._rateChangeHandler = null;
                }
            }
        }, 200);
    }

    /**
     * 비디오의 재생 시간을 이동시킵니다. 넷플릭스 전용 로직 포함.
     */
    function seekVideo(seconds) {
        if (isSeeking) return;
        isSeeking = true;

        if (isNetflix) {
            try {
                // Netflix specific seeking logic
                // (Note: Requires netflix player API access, which might not always be available)
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Netflix seek error:', e);
            }
        } else if (currentVideo) {
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }

        setTimeout(() => { isSeeking = false; }, 100);
    }

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    /**
     * Web Audio Context를 설정하여 비디오의 오디오를 조작할 수 있도록 준비합니다.
     */
    function setupAudioContext(video) {
        if (isAmplificationBlocked) {
            return false;
        }

        try {
            if (!video) return false;

            if (sourceNode) {
                sourceNode.disconnect();
                sourceNode = null;
            }
            if (gainNode) {
                gainNode.disconnect();
                gainNode = null;
            }
            connectedVideo = null;

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
            console.error("Failed to setup AudioContext. Amplification might not work:", e);
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;
            return false;
        }
    }

    /**
     * 비디오의 볼륨을 설정합니다. 100% 초과 볼륨은 Web Audio API를 사용하여 증폭합니다.
     */
    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        if (isAmplificationBlocked && vol > 1) {
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = 1;
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

    // --- Video Dragging Implementation ---

    /**
     * 드래그 피드백 오버레이 요소를 생성하거나 가져옵니다.
     * 전체 화면 상태에 따라 부모 요소를 동적으로 관리합니다.
     */
    function getFeedbackOverlay() {
        if (!feedbackOverlay) {
            feedbackOverlay = document.createElement('div');
            feedbackOverlay.id = 'video-drag-feedback';
            feedbackOverlay.style.cssText = `
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background-color: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 24px;
                font-weight: bold;
                z-index: 2147483647;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
            `;
        }

        // Dynamically place the overlay based on fullscreen state
        // Use document.body if no specific fullscreen element is active.
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
        const targetParent = fullscreenElement || document.body;

        // Ensure the overlay is correctly placed within the target parent
        if (feedbackOverlay.parentNode !== targetParent) {
            if (feedbackOverlay.parentNode) {
                feedbackOverlay.parentNode.removeChild(feedbackOverlay);
            }
            // Append to the target parent (e.g., the fullscreen element or body)
            targetParent.appendChild(feedbackOverlay);
        }

        return feedbackOverlay;
    }

    // Function to update the feedback overlay text and show it
    function updateFeedback(text) {
        const overlay = getFeedbackOverlay();
        overlay.textContent = text;
        overlay.style.opacity = 1;
    }

    // Function to hide the feedback overlay
    function hideFeedback() {
        const overlay = getFeedbackOverlay();
        // Use a timeout to ensure the overlay fades out smoothly
        setTimeout(() => {
            overlay.style.opacity = 0;
        }, 500); // Wait 0.5s before fading out
    }

    /**
     * 비디오 드래그 이벤트를 설정합니다.
     * @param {HTMLVideoElement} video
     */
    function setupVideoDragging(video) {
        if (!video || video._draggingSetup) return;

        console.log('[Video Controller Popup] Setting up dragging events on video.');

        // Use 'mousedown'/'mousemove' for PC, 'touchstart'/'touchmove' for mobile
        const startEvent = isMobile ? 'touchstart' : 'mousedown';
        const moveEvent = isMobile ? 'touchmove' : 'mousemove';
        const endEvent = isMobile ? 'touchend' : 'mouseup';

        // Apply critical CSS properties for dragging stability:
        // 1. Ensure pointer events are 'auto' to allow interaction.
        // 2. Set 'touch-action: none' to prevent scrolling/zooming during drag (crucial for mobile).
        // 3. Set 'position: relative' if not already set, to ensure dragging feedback can position correctly.
        video.style.pointerEvents = 'auto';
        video.style.touchAction = 'none';
        if (window.getComputedStyle(video).position === 'static') {
            video.style.position = 'relative';
        }
        video.style.cursor = 'pointer'; // Ensure cursor is appropriate for PC

        const handleStart = (e) => {
            // Get the coordinates based on whether it's a mouse or touch event
            const clientX = isMobile ? e.touches[0]?.clientX : e.clientX;

            // Only allow dragging if the feature is active and a valid coordinate is available.
            if (!videoDraggingActive || clientX === undefined) {
                return;
            }

            // CRITICAL: Prevent default action for touch events to stop scrolling.
            if (isMobile) {
                e.preventDefault();
            }

            isDragging = true;
            dragStartX = clientX;
            dragStartTime = video.currentTime; // Record the starting time for time calculation

            // Change cursor for PC dragging feedback
            if (!isMobile) {
                 video.style.cursor = 'ew-resize';
            }

            // Ensure feedback overlay is present in the DOM
            getFeedbackOverlay();

            // Prevent default drag behavior for PC
            if (!isMobile) {
                e.stopPropagation();
            }
        };

        const handleMove = (e) => {
            if (!isDragging || !videoDraggingActive) return;

            // Get the coordinates based on whether it's a mouse or touch event
            const clientX = isMobile ? e.touches[0]?.clientX : e.clientX;

            if (clientX === undefined) return;

            const deltaX = clientX - dragStartX;
            const videoWidth = video.offsetWidth;
            const duration = video.duration;

            if (videoWidth === 0 || isNaN(duration)) return;

            // Calculate change in time: (deltaX / videoWidth) * sensitivity (e.g., 30s)
            const timeDelta = (deltaX / videoWidth) * DRAG_SENSITIVITY_SECONDS;

            // Calculate the new time based on the initial drag start time and the current delta
            let newTime = dragStartTime + timeDelta;
            newTime = Math.max(0, Math.min(newTime, duration));

            // Update video time
            video.currentTime = newTime;

            // --- Update Feedback Overlay ---
            // Calculate the actual change in time for display (new time - original time)
            const feedbackTimeChange = newTime - dragStartTime;

            // Format the feedback text (+ or -) and display it to 1 decimal place
            const formattedTime = (feedbackTimeChange >= 0 ? '+' : '-') + Math.abs(feedbackTimeChange).toFixed(1) + 's';
            updateFeedback(formattedTime);
        };

        const handleEnd = () => {
            if (isDragging) {
                isDragging = false;
                // Reset cursor for PC
                if (!isMobile) {
                    video.style.cursor = 'pointer';
                }
                hideFeedback(); // Hide the feedback overlay after drag ends
            }
        };

        // Store handlers on the video element for easy removal and reference
        video._dragHandlers = { handleStart, handleMove, handleEnd };

        // Add listeners to the video element itself
        video.addEventListener(startEvent, handleStart);
        video.addEventListener(moveEvent, handleMove);
        video.addEventListener(endEvent, handleEnd);

        // Add global end listener to ensure dragging stops even if mouse/touch leaves the video
        document.addEventListener(endEvent, handleEnd);

        video._draggingSetup = true;
    }

    /**
     * 비디오 드래그 이벤트를 제거합니다.
     * @param {HTMLVideoElement} video
     */
    function removeVideoDragging(video) {
        if (!video || !video._draggingSetup) return;

        const handlers = video._dragHandlers;
        if (handlers) {
            const startEvent = isMobile ? 'touchstart' : 'mousedown';
            const moveEvent = isMobile ? 'touchmove' : 'mousemove';
            const endEvent = isMobile ? 'touchend' : 'mouseup';

            video.removeEventListener(startEvent, handlers.handleStart);
            video.removeEventListener(moveEvent, handlers.handleMove);
            video.removeEventListener(endEvent, handlers.handleEnd);
            document.removeEventListener(endEvent, handlers.handleEnd);
        }

        // Reset styling changes
        video.style.cursor = '';
        video.style.pointerEvents = '';
        video.style.touchAction = '';

        // Reset position only if we explicitly set it to relative. This is complex and might revert site CSS, so we'll only reset what we changed if necessary.
        // For simplicity, we just reset the flags we set, as we set them again in setupVideoDragging.

        video._draggingSetup = false;
        videoDraggingActive = false;
    }

    /**
     * 현재 비디오의 전체 화면 상태에 따라 드래그 기능을 활성화/비활성화합니다.
     * 모바일에서는 전체 화면 여부와 관계없이 항상 활성화합니다.
     * @param {HTMLVideoElement} video
     */
    function updateVideoDraggingState(video) {
        // 1. If no video is selected, disable dragging and return immediately.
        if (!video) {
            videoDraggingActive = false;
            return;
        }

        if (isMobile) {
            // On mobile, assume dragging is always desired if a video is present and visible,
            // as browser fullscreen modes often don't register via standard API checks.
            videoDraggingActive = true;
        } else {
            // For PC, check if the video is in fullscreen mode.
            const fullscreenElement =
                document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement ||
                document.msFullscreenElement;

            const isAnyFullscreen = fullscreenElement !== null;

            // Check if the video is the fullscreen element OR a child of the fullscreen element.
            videoDraggingActive = isAnyFullscreen && (
                fullscreenElement === video ||
                (fullscreenElement && typeof fullscreenElement.contains === 'function' && fullscreenElement.contains(video))
            );
        }

        // 3. Update cursor and pointer-events based on dragging activity
        if (video === currentVideo) {
             // Ensure pointer-events and touch-action are set for the current video
             video.style.pointerEvents = videoDraggingActive ? 'auto' : '';
             video.style.touchAction = videoDraggingActive ? 'none' : '';

             if (!isDragging) {
                 video.style.cursor = videoDraggingActive ? 'pointer' : '';
             }
        }
    }


    // --- UI Update & Creation ---
    // 볼륨 드롭다운 옵션 정의
    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150% (Amplify)', value: 1.5 }, { label: '300% (Amplify)', value: 3.0 }, { label: '500% (Amplify)', value: 5.0 },
    ];

    /**
     * 팝업의 볼륨 드롭다운을 현재 비디오의 볼륨 상태에 맞춰 업데이트합니다.
     */
    function updateVolumeSelect() {
        const volumeSelect = popupElement?.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        let effectiveVolume = 1.0;

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) {
                gainNode.gain.value = 0;
            }
            return;
        } else {
            if (gainNode && connectedVideo === currentVideo) {
                effectiveVolume = gainNode.gain.value;
            } else {
                effectiveVolume = currentVideo.volume;
            }
        }

        const closest = volumeOptions.reduce((prev, curr) => {
            if (typeof curr.value !== 'number') return prev;
            return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
        }, { value: 1.0 });

        volumeSelect.value = closest.value;
    }

    /**
     * 팝업을 잠시 보이게 하고 일정 시간 후 다시 투명하게 만듭니다.
     */
    function showPopupTemporarily() {
        if (!popupElement) return;

        popupElement.style.opacity = '1';

        clearTimeout(popupElement.fadeTimeout);

        popupElement.fadeTimeout = setTimeout(() => {
            if (isMobile || !popupElement.matches(':hover')) {
                popupElement.style.opacity = idleOpacity;
            }
        }, 3000);
    }

    /**
     * 현재 비디오에 비디오 상호작용 이벤트 리스너를 추가합니다.
     */
    function addVideoInteractionListeners(video) {
        if (!video) return;

        const events = ['play', 'pause', 'click', 'touchstart', 'volumechange', 'emptied'];

        removeVideoInteractionListeners(video);

        events.forEach(event => {
            video.addEventListener(event, showPopupTemporarily);
        });

        video.addEventListener('volumechange', updateVolumeSelect);

        const playHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video._playHandler = playHandler;
        video.addEventListener('play', playHandler);
    }

    /**
     * 현재 비디오에서 비디오 상호작용 이벤트 리스너를 제거합니다.
     */
    function removeVideoInteractionListeners(video) {
        if (!video) return;

        const events = ['play', 'pause', 'click', 'touchstart', 'volumechange', 'emptied'];
        events.forEach(event => {
            video.removeEventListener(event, showPopupTemporarily);
        });
        video.removeEventListener('volumechange', updateVolumeSelect);

        if (video._playHandler) {
            video.removeEventListener('play', video._playHandler);
            video._playHandler = null;
        }
    }

    /**
     * 비디오 컨트롤 팝업 UI를 생성하거나 업데이트합니다.
     */
    function createPopup() {
        const hostRoot = document.body;

        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }

        // Clean up previous video's state and dragging setup before creating the new popup
        if (currentVideo) {
            removeVideoInteractionListeners(currentVideo);
            if (currentVideo._rateChangeHandler) {
                currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
                currentVideo._rateChangeHandler = null;
            }
            removeVideoDragging(currentVideo);
        }

        videos = findPlayableVideos();

        if (videos.length === 0) {
            console.log('[DEBUG] No playable videos found. Hiding/Preventing popup.');
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            // MutationObserver should remain active to detect videos later.
            return;
        }

        // Select the largest video if currentVideo is null or no longer valid
        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
            console.log('[DEBUG] Selecting new primary video:', currentVideo);
        }

        // 팝업 요소 생성 및 스타일 설정
        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 50px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.5);
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            z-index: 2147483647;
            pointer-events: auto;
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            align-items: center;
            box-shadow: 0 0 15px rgba(0,0,0,0.5);
            transition: opacity 0.3s ease;
            opacity: ${idleOpacity};
        `;
        popupElement = popup;

        // 버튼 및 셀렉트 공통 스타일 정의
        const controlStyles = `
            font-size: 16px;
            font-weight: bold;
            padding: 4px 10px;
            border: 1px solid #fff;
            border-radius: 4px;
            background-color: rgba(0,0,0,0.5);
            color: #fff;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            min-width: 70px;
            text-align: center;
            transition: background-color 0.2s;
        `;

        // 비디오 선택 드롭다운 생성
        const videoSelect = document.createElement('select');
        videoSelect.style.cssText = controlStyles + `
            max-width: 85px;
            text-overflow: ellipsis;
            background: #000;
            `;

        videos.forEach((video, i) => {
            const option = document.createElement('option');
            option.value = i;
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...';
            option.textContent = label;
            option.title = video.currentSrc;

            if (video === currentVideo) {
                option.selected = true;
            }
            videoSelect.appendChild(option);
        });

        videoSelect.onchange = () => {
            // Clean up old video's state and listeners
            if (currentVideo && currentVideo._rateChangeHandler) {
                currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
                currentVideo._rateChangeHandler = null;
            }
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }
            if (currentVideo) {
                removeVideoDragging(currentVideo);
                removeVideoInteractionListeners(currentVideo);
            }

            // Clean up audio nodes if the video source changes
            if (connectedVideo && connectedVideo !== currentVideo) {
                if (sourceNode) {
                    try {
                        sourceNode.disconnect();
                    } catch (e) {
                        console.warn("Error disconnecting audio nodes on video change:", e);
                    }
                }
                connectedVideo = null;
                sourceNode = null;
                gainNode = null;
            }

            // Set new current video and setup
            currentVideo = videos[videoSelect.value];

            if (currentVideo) {
                addVideoInteractionListeners(currentVideo);
                fixPlaybackRate(currentVideo, desiredPlaybackRate);
                setupVideoDragging(currentVideo);
                updateVideoDraggingState(currentVideo);
            }

            updateVolumeSelect();
        };
        popup.appendChild(videoSelect);

        // 버튼 생성 헬퍼 함수
        function createButton(id, text, onClick) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.style.cssText = controlStyles;

            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent the click event from propagating to the document body
                onClick();
                showPopupTemporarily();

                if (isMobile) {
                    btn.style.backgroundColor = 'rgba(125,125,125,0.8)';
                    setTimeout(() => { btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; }, 200);
                }
            });
            return btn;
        }

        // 재생 속도 및 PIP, 시간 이동 버튼 추가
        popup.appendChild(createButton('slow', '0.2x', () => fixPlaybackRate(currentVideo, 0.2)));
        popup.appendChild(createButton('normal', '1.0x', () => fixPlaybackRate(currentVideo, 1.0)));
        popup.appendChild(createButton('fast', '5.0x', () => fixPlaybackRate(currentVideo, 5.0)));
        popup.appendChild(createButton('pip', '📺 PIP', async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (currentVideo) {
                    await currentVideo.requestPictureInPicture();
                }
            } catch (e) {
                console.error('PIP Error:', e);
            }
        }));
        popup.appendChild(createButton('back15', '⏪1분', () => seekVideo(-60)));
        popup.appendChild(createButton('forward15', '1분⏩', () => seekVideo(60)));

        // 볼륨 선택 드롭다운 생성
        const volumeSelect = document.createElement('select');
        volumeSelect.id = 'volume-select';
        volumeSelect.style.cssText = controlStyles + `
            max-width: 85px;
            margin-left: 8px;
            background: #000;
        `;

        volumeOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;

            if (isAmplificationBlocked && parseFloat(opt.value) > 1) {
                option.disabled = true;
                option.title = "Amplification is blocked on this site.";
            }
            volumeSelect.appendChild(option);
        });

        volumeSelect.onchange = () => {
            if (!currentVideo) return;
            const value = volumeSelect.value;

            showPopupTemporarily();

            if (value === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) {
                    gainNode.gain.value = 0;
                }
            } else {
                currentVideo.muted = false;
                const vol = parseFloat(value);
                setAmplifiedVolume(currentVideo, vol);
            }
            updateVolumeSelect();
        };

        // Initial setup for the selected video
        if (currentVideo) {
            addVideoInteractionListeners(currentVideo);
            fixPlaybackRate(currentVideo, desiredPlaybackRate);
            setupVideoDragging(currentVideo);
            updateVideoDraggingState(currentVideo);
        }
        updateVolumeSelect();
        popup.appendChild(volumeSelect);

        if (!isMobile) {
            // Desktop behavior: show popup on hover, fade on mouse leave
            popup.addEventListener('mouseenter', () => {
                popup.style.opacity = '1';
            });
            popup.addEventListener('mouseleave', () => {
                popup.style.opacity = idleOpacity;
            });
        } else {
            // Mobile behavior: show popup briefly on touch
            popup.addEventListener('touchstart', () => {
                showPopupTemporarily();
            });
        }

        hostRoot.appendChild(popup);
    }

    // --- Main Execution ---
    /**
     * 스크립트의 주요 실행 로직을 시작합니다.
     */
    function run() {
        createPopup(); // Initial attempt to create popup

        // Set up MutationObserver to watch for dynamic changes in the DOM, including video elements
        videoObserver = new MutationObserver(() => {
            const newVideos = findPlayableVideos();
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                console.log('[Observer] Video list changed. Recreating popup.');
                createPopup();
            }
        });

        // Start observing the body for video additions/removals
        videoObserver.observe(document.body, { childList: true, subtree: true });

        // Periodically check for videos and update dragging state
        setInterval(() => {
            const newVideos = findPlayableVideos();

            // Check if video list has changed and trigger popup recreation if necessary
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                 console.log('[Interval] Video list mismatch detected. Recreating popup.');
                createPopup();
            }

            if (currentVideo) {
                updateVideoDraggingState(currentVideo);
                // Ensure the feedback overlay is correctly positioned if fullscreen state changes
                if (feedbackOverlay) {
                    getFeedbackOverlay();
                }
            }
        }, 2000);

        // 전체 화면 상태 변경 감지 및 오버레이 위치 조정
        const fullscreenChangeHandler = () => {
            if (currentVideo) {
                updateVideoDraggingState(currentVideo);
                // Update overlay parent when fullscreen state changes
                if (feedbackOverlay) {
                    getFeedbackOverlay();
                }

              // === 팝업 위치 변경 ===
        const fsEl = document.fullscreenElement;
            if (popupElement) {
              if (fsEl) {
                fsEl.appendChild(popupElement);
              } else {
                document.body.appendChild(popupElement);
              }
            }
          }
        };

        document.addEventListener('fullscreenchange', fullscreenChangeHandler);
        document.addEventListener('webkitfullscreenchange', fullscreenChangeHandler);
        document.addEventListener('mozfullscreenchange', fullscreenChangeHandler);
        document.addEventListener('MSFullscreenChange', fullscreenChangeHandler);

        // 오버플로우 픽스 대상 사이트가 있으면 주기적으로 실행
        if (overflowFixTargets.length > 0) {
            fixOverflow();
            setInterval(fixOverflow, 1000);
        }

        // Add global click/touchstart listener to show popup
        const globalInteractionHandler = (event) => {
            // Check if the click/touch target is outside the popup element
            if (popupElement && popupElement.contains(event.target)) {
                return;
            }

            // Only proceed if it's a primary mouse click (button 0) for mouse events
            if (event.type === 'click' && event.button !== 0) {
                return;
            }

            showPopupTemporarily();
        };

        document.addEventListener('click', globalInteractionHandler);
        // Using 'touchstart' for mobile interaction to ensure responsiveness
        document.addEventListener('touchstart', globalInteractionHandler);
    }

    // 스크립트 실행 시작
    run();
})();// ==UserScript==
// @name Video Controller Popup (Shadow DOM)
// @namespace Violentmonkey Scripts
// @version 4.09.9_Optimized_Whitelist_Modified (Dragging Fix + Fullscreen Container Check + Drag Feedback + Mobile Fixes)
// @description 여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let currentIntervalId = null;
    let videos = [];
    let currentVideo = null;
    let popupElement = null;
    let isSeeking = false;
    let desiredPlaybackRate = 1.0;
    let videoObserver = null;

    // Variables for video dragging
    let isDragging = false;
    let dragStartX = 0;
    let dragStartTime = 0;
    let videoDraggingActive = false;
    let feedbackOverlay = null; // Reference to the feedback overlay element

    // Dragging configuration
    const DRAG_SENSITIVITY_SECONDS = 30; // 100% video width drag = 30 seconds of seeking

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    // 팝업 투명도 설정: localStorage에 설정값이 없으면 '0.025' (투명)을 기본값으로 사용
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '0.025';

    // Lazy-src 예외 사이트 (Blacklist)
    const lazySrcBlacklist = [
        'missav.ws',
        'missav.live',
    ];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

    // 증폭 차단 사이트 (Blacklist)
    const AMPLIFICATION_BLACKLIST = [
        'avsee.ru',
    ];
    const isAmplificationBlocked = AMPLIFICATION_BLACKLIST.some(site => location.hostname.includes(site));

    // overflow visible fix 사이트 설정
    const overflowFixSites = [
        { domain: 'twitch.tv', selector: [
            'div.video-player__container',
            'div.video-player-theatre-mode__player',
            'div.player-theatre-mode'
        ]},
    ];
    const overflowFixTargets = overflowFixSites.filter(site =>
        location.hostname.includes(site.domain)
    );

    // --- Utility Functions ---

    /**
     * 특정 사이트의 overflow 속성을 'visible'로 설정하여 UI 잘림을 방지합니다.
     */
    function fixOverflow() {
        overflowFixTargets.forEach(site => {
            site.selector.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.overflow = 'visible';
                });
            });
        });
    }

    /**
     * DOM 전체 (Shadow DOM 포함)에서 모든 <video> 요소를 깊이 탐색하여 찾습니다.
     */
    function findAllVideosDeep(root = document) {
        const found = [];
        root.querySelectorAll('video').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found.push(...findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    }

    /**
     * 재생 가능한 비디오 요소를 찾아 반환합니다. (디버그 로그 포함)
     */
    function findPlayableVideos() {
        const found = findAllVideosDeep();

        // Debugging: Log the found video elements before filtering
        console.log('[DEBUG] Found videos (raw):', found.length, found);

        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        // 숨겨진 비디오, 오디오 트랙, 그리고 크기가 너무 작은 비디오를 제외합니다.
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                v.videoWidth > 0 &&
                v.videoHeight > 0 &&
                v.clientWidth > 50 &&
                v.clientHeight > 50
            );
        });

        console.log('[DEBUG] Found playable videos:', playableVideos.length, playableVideos);
        return playableVideos;
    }

    /**
     * 비디오의 재생 속도를 설정하고, 모든 사이트에서 이를 강제 유지합니다.
     * @param {HTMLVideoElement} video
     * @param {number} rate
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;

        // 1. Set the desired rate globally for the script
        desiredPlaybackRate = rate;

        // 2. Set the playback rate on the video element
        video.playbackRate = rate;

        // 3. Ensure persistent rate maintenance
        if (currentIntervalId) {
            clearInterval(currentIntervalId);
        }

        if (currentVideo && currentVideo._rateChangeHandler) {
            currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
            currentVideo._rateChangeHandler = null;
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video.addEventListener('ratechange', rateChangeHandler);
        video._rateChangeHandler = rateChangeHandler;

        currentIntervalId = setInterval(() => {
            if (document.body.contains(video) && video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            } else if (!document.body.contains(video)) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
                if (video._rateChangeHandler) {
                    video.removeEventListener('ratechange', video._rateChangeHandler);
                    video._rateChangeHandler = null;
                }
            }
        }, 200);
    }

    /**
     * 비디오의 재생 시간을 이동시킵니다. 넷플릭스 전용 로직 포함.
     */
    function seekVideo(seconds) {
        if (isSeeking) return;
        isSeeking = true;

        if (isNetflix) {
            try {
                // Netflix specific seeking logic
                // (Note: Requires netflix player API access, which might not always be available)
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Netflix seek error:', e);
            }
        } else if (currentVideo) {
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }

        setTimeout(() => { isSeeking = false; }, 100);
    }

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    /**
     * Web Audio Context를 설정하여 비디오의 오디오를 조작할 수 있도록 준비합니다.
     */
    function setupAudioContext(video) {
        if (isAmplificationBlocked) {
            return false;
        }

        try {
            if (!video) return false;

            if (sourceNode) {
                sourceNode.disconnect();
                sourceNode = null;
            }
            if (gainNode) {
                gainNode.disconnect();
                gainNode = null;
            }
            connectedVideo = null;

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
            console.error("Failed to setup AudioContext. Amplification might not work:", e);
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;
            return false;
        }
    }

    /**
     * 비디오의 볼륨을 설정합니다. 100% 초과 볼륨은 Web Audio API를 사용하여 증폭합니다.
     */
    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        if (isAmplificationBlocked && vol > 1) {
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = 1;
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

    // --- Video Dragging Implementation ---

    /**
     * 드래그 피드백 오버레이 요소를 생성하거나 가져옵니다.
     * 전체 화면 상태에 따라 부모 요소를 동적으로 관리합니다.
     */
    function getFeedbackOverlay() {
        if (!feedbackOverlay) {
            feedbackOverlay = document.createElement('div');
            feedbackOverlay.id = 'video-drag-feedback';
            feedbackOverlay.style.cssText = `
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background-color: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 10px 20px;
                border-radius: 8px;
                font-size: 24px;
                font-weight: bold;
                z-index: 2147483647;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.2s ease-in-out;
            `;
        }

        // Dynamically place the overlay based on fullscreen state
        // Use document.body if no specific fullscreen element is active.
        const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
        const targetParent = fullscreenElement || document.body;

        // Ensure the overlay is correctly placed within the target parent
        if (feedbackOverlay.parentNode !== targetParent) {
            if (feedbackOverlay.parentNode) {
                feedbackOverlay.parentNode.removeChild(feedbackOverlay);
            }
            // Append to the target parent (e.g., the fullscreen element or body)
            targetParent.appendChild(feedbackOverlay);
        }

        return feedbackOverlay;
    }

    // Function to update the feedback overlay text and show it
    function updateFeedback(text) {
        const overlay = getFeedbackOverlay();
        overlay.textContent = text;
        overlay.style.opacity = 1;
    }

    // Function to hide the feedback overlay
    function hideFeedback() {
        const overlay = getFeedbackOverlay();
        // Use a timeout to ensure the overlay fades out smoothly
        setTimeout(() => {
            overlay.style.opacity = 0;
        }, 500); // Wait 0.5s before fading out
    }

    /**
     * 비디오 드래그 이벤트를 설정합니다.
     * @param {HTMLVideoElement} video
     */
    function setupVideoDragging(video) {
        if (!video || video._draggingSetup) return;

        console.log('[Video Controller Popup] Setting up dragging events on video.');

        // Use 'mousedown'/'mousemove' for PC, 'touchstart'/'touchmove' for mobile
        const startEvent = isMobile ? 'touchstart' : 'mousedown';
        const moveEvent = isMobile ? 'touchmove' : 'mousemove';
        const endEvent = isMobile ? 'touchend' : 'mouseup';

        // Apply critical CSS properties for dragging stability:
        // 1. Ensure pointer events are 'auto' to allow interaction.
        // 2. Set 'touch-action: none' to prevent scrolling/zooming during drag (crucial for mobile).
        // 3. Set 'position: relative' if not already set, to ensure dragging feedback can position correctly.
        video.style.pointerEvents = 'auto';
        video.style.touchAction = 'none';
        if (window.getComputedStyle(video).position === 'static') {
            video.style.position = 'relative';
        }
        video.style.cursor = 'pointer'; // Ensure cursor is appropriate for PC

        const handleStart = (e) => {
            // Get the coordinates based on whether it's a mouse or touch event
            const clientX = isMobile ? e.touches[0]?.clientX : e.clientX;

            // Only allow dragging if the feature is active and a valid coordinate is available.
            if (!videoDraggingActive || clientX === undefined) {
                return;
            }

            // CRITICAL: Prevent default action for touch events to stop scrolling.
            if (isMobile) {
                e.preventDefault();
            }

            isDragging = true;
            dragStartX = clientX;
            dragStartTime = video.currentTime; // Record the starting time for time calculation

            // Change cursor for PC dragging feedback
            if (!isMobile) {
                 video.style.cursor = 'ew-resize';
            }

            // Ensure feedback overlay is present in the DOM
            getFeedbackOverlay();

            // Prevent default drag behavior for PC
            if (!isMobile) {
                e.stopPropagation();
            }
        };

        const handleMove = (e) => {
            if (!isDragging || !videoDraggingActive) return;

            // Get the coordinates based on whether it's a mouse or touch event
            const clientX = isMobile ? e.touches[0]?.clientX : e.clientX;

            if (clientX === undefined) return;

            const deltaX = clientX - dragStartX;
            const videoWidth = video.offsetWidth;
            const duration = video.duration;

            if (videoWidth === 0 || isNaN(duration)) return;

            // Calculate change in time: (deltaX / videoWidth) * sensitivity (e.g., 30s)
            const timeDelta = (deltaX / videoWidth) * DRAG_SENSITIVITY_SECONDS;

            // Calculate the new time based on the initial drag start time and the current delta
            let newTime = dragStartTime + timeDelta;
            newTime = Math.max(0, Math.min(newTime, duration));

            // Update video time
            video.currentTime = newTime;

            // --- Update Feedback Overlay ---
            // Calculate the actual change in time for display (new time - original time)
            const feedbackTimeChange = newTime - dragStartTime;

            // Format the feedback text (+ or -) and display it to 1 decimal place
            const formattedTime = (feedbackTimeChange >= 0 ? '+' : '-') + Math.abs(feedbackTimeChange).toFixed(1) + 's';
            updateFeedback(formattedTime);
        };

        const handleEnd = () => {
            if (isDragging) {
                isDragging = false;
                // Reset cursor for PC
                if (!isMobile) {
                    video.style.cursor = 'pointer';
                }
                hideFeedback(); // Hide the feedback overlay after drag ends
            }
        };

        // Store handlers on the video element for easy removal and reference
        video._dragHandlers = { handleStart, handleMove, handleEnd };

        // Add listeners to the video element itself
        video.addEventListener(startEvent, handleStart);
        video.addEventListener(moveEvent, handleMove);
        video.addEventListener(endEvent, handleEnd);

        // Add global end listener to ensure dragging stops even if mouse/touch leaves the video
        document.addEventListener(endEvent, handleEnd);

        video._draggingSetup = true;
    }

    /**
     * 비디오 드래그 이벤트를 제거합니다.
     * @param {HTMLVideoElement} video
     */
    function removeVideoDragging(video) {
        if (!video || !video._draggingSetup) return;

        const handlers = video._dragHandlers;
        if (handlers) {
            const startEvent = isMobile ? 'touchstart' : 'mousedown';
            const moveEvent = isMobile ? 'touchmove' : 'mousemove';
            const endEvent = isMobile ? 'touchend' : 'mouseup';

            video.removeEventListener(startEvent, handlers.handleStart);
            video.removeEventListener(moveEvent, handlers.handleMove);
            video.removeEventListener(endEvent, handlers.handleEnd);
            document.removeEventListener(endEvent, handlers.handleEnd);
        }

        // Reset styling changes
        video.style.cursor = '';
        video.style.pointerEvents = '';
        video.style.touchAction = '';

        // Reset position only if we explicitly set it to relative. This is complex and might revert site CSS, so we'll only reset what we changed if necessary.
        // For simplicity, we just reset the flags we set, as we set them again in setupVideoDragging.

        video._draggingSetup = false;
        videoDraggingActive = false;
    }

    /**
     * 현재 비디오의 전체 화면 상태에 따라 드래그 기능을 활성화/비활성화합니다.
     * 모바일에서는 전체 화면 여부와 관계없이 항상 활성화합니다.
     * @param {HTMLVideoElement} video
     */
    function updateVideoDraggingState(video) {
        // 1. If no video is selected, disable dragging and return immediately.
        if (!video) {
            videoDraggingActive = false;
            return;
        }

        if (isMobile) {
            // On mobile, assume dragging is always desired if a video is present and visible,
            // as browser fullscreen modes often don't register via standard API checks.
            videoDraggingActive = true;
        } else {
            // For PC, check if the video is in fullscreen mode.
            const fullscreenElement =
                document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement ||
                document.msFullscreenElement;

            const isAnyFullscreen = fullscreenElement !== null;

            // Check if the video is the fullscreen element OR a child of the fullscreen element.
            videoDraggingActive = isAnyFullscreen && (
                fullscreenElement === video ||
                (fullscreenElement && typeof fullscreenElement.contains === 'function' && fullscreenElement.contains(video))
            );
        }

        // 3. Update cursor and pointer-events based on dragging activity
        if (video === currentVideo) {
             // Ensure pointer-events and touch-action are set for the current video
             video.style.pointerEvents = videoDraggingActive ? 'auto' : '';
             video.style.touchAction = videoDraggingActive ? 'none' : '';

             if (!isDragging) {
                 video.style.cursor = videoDraggingActive ? 'pointer' : '';
             }
        }
    }


    // --- UI Update & Creation ---
    // 볼륨 드롭다운 옵션 정의
    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150% (Amplify)', value: 1.5 }, { label: '300% (Amplify)', value: 3.0 }, { label: '500% (Amplify)', value: 5.0 },
    ];

    /**
     * 팝업의 볼륨 드롭다운을 현재 비디오의 볼륨 상태에 맞춰 업데이트합니다.
     */
    function updateVolumeSelect() {
        const volumeSelect = popupElement?.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        let effectiveVolume = 1.0;

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) {
                gainNode.gain.value = 0;
            }
            return;
        } else {
            if (gainNode && connectedVideo === currentVideo) {
                effectiveVolume = gainNode.gain.value;
            } else {
                effectiveVolume = currentVideo.volume;
            }
        }

        const closest = volumeOptions.reduce((prev, curr) => {
            if (typeof curr.value !== 'number') return prev;
            return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
        }, { value: 1.0 });

        volumeSelect.value = closest.value;
    }

    /**
     * 팝업을 잠시 보이게 하고 일정 시간 후 다시 투명하게 만듭니다.
     */
    function showPopupTemporarily() {
        if (!popupElement) return;

        popupElement.style.opacity = '1';

        clearTimeout(popupElement.fadeTimeout);

        popupElement.fadeTimeout = setTimeout(() => {
            if (isMobile || !popupElement.matches(':hover')) {
                popupElement.style.opacity = idleOpacity;
            }
        }, 3000);
    }

    /**
     * 현재 비디오에 비디오 상호작용 이벤트 리스너를 추가합니다.
     */
    function addVideoInteractionListeners(video) {
        if (!video) return;

        const events = ['play', 'pause', 'click', 'touchstart', 'volumechange', 'emptied'];

        removeVideoInteractionListeners(video);

        events.forEach(event => {
            video.addEventListener(event, showPopupTemporarily);
        });

        video.addEventListener('volumechange', updateVolumeSelect);

        const playHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                video.playbackRate = desiredPlaybackRate;
            }
        };

        video._playHandler = playHandler;
        video.addEventListener('play', playHandler);
    }

    /**
     * 현재 비디오에서 비디오 상호작용 이벤트 리스너를 제거합니다.
     */
    function removeVideoInteractionListeners(video) {
        if (!video) return;

        const events = ['play', 'pause', 'click', 'touchstart', 'volumechange', 'emptied'];
        events.forEach(event => {
            video.removeEventListener(event, showPopupTemporarily);
        });
        video.removeEventListener('volumechange', updateVolumeSelect);

        if (video._playHandler) {
            video.removeEventListener('play', video._playHandler);
            video._playHandler = null;
        }
    }

    /**
     * 비디오 컨트롤 팝업 UI를 생성하거나 업데이트합니다.
     */
    function createPopup() {
        const hostRoot = document.body;

        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }

        // Clean up previous video's state and dragging setup before creating the new popup
        if (currentVideo) {
            removeVideoInteractionListeners(currentVideo);
            if (currentVideo._rateChangeHandler) {
                currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
                currentVideo._rateChangeHandler = null;
            }
            removeVideoDragging(currentVideo);
        }

        videos = findPlayableVideos();

        if (videos.length === 0) {
            console.log('[DEBUG] No playable videos found. Hiding/Preventing popup.');
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            // MutationObserver should remain active to detect videos later.
            return;
        }

        // Select the largest video if currentVideo is null or no longer valid
        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];
            console.log('[DEBUG] Selecting new primary video:', currentVideo);
        }

        // 팝업 요소 생성 및 스타일 설정
        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 0px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.5);
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            z-index: 2147483647;
            pointer-events: auto;
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            align-items: center;
            box-shadow: 0 0 15px rgba(0,0,0,0.5);
            transition: opacity 0.3s ease;
            opacity: ${idleOpacity};
        `;
        popupElement = popup;

        // 버튼 및 셀렉트 공통 스타일 정의
        const controlStyles = `
            font-size: 16px;
            font-weight: bold;
            padding: 4px 10px;
            border: 1px solid #fff;
            border-radius: 4px;
            background-color: rgba(0,0,0,0.5);
            color: #fff;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            min-width: 80px;
            text-align: center;
            transition: background-color 0.2s;
        `;

        // 비디오 선택 드롭다운 생성
        const videoSelect = document.createElement('select');
        videoSelect.style.cssText = controlStyles + `
            max-width: 85px;
            text-overflow: ellipsis;
            background: #000;
            `;

        videos.forEach((video, i) => {
            const option = document.createElement('option');
            option.value = i;
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...';
            option.textContent = label;
            option.title = video.currentSrc;

            if (video === currentVideo) {
                option.selected = true;
            }
            videoSelect.appendChild(option);
        });

        videoSelect.onchange = () => {
            // Clean up old video's state and listeners
            if (currentVideo && currentVideo._rateChangeHandler) {
                currentVideo.removeEventListener('ratechange', currentVideo._rateChangeHandler);
                currentVideo._rateChangeHandler = null;
            }
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }
            if (currentVideo) {
                removeVideoDragging(currentVideo);
                removeVideoInteractionListeners(currentVideo);
            }

            // Clean up audio nodes if the video source changes
            if (connectedVideo && connectedVideo !== currentVideo) {
                if (sourceNode) {
                    try {
                        sourceNode.disconnect();
                    } catch (e) {
                        console.warn("Error disconnecting audio nodes on video change:", e);
                    }
                }
                connectedVideo = null;
                sourceNode = null;
                gainNode = null;
            }

            // Set new current video and setup
            currentVideo = videos[videoSelect.value];

            if (currentVideo) {
                addVideoInteractionListeners(currentVideo);
                fixPlaybackRate(currentVideo, desiredPlaybackRate);
                setupVideoDragging(currentVideo);
                updateVideoDraggingState(currentVideo);
            }

            updateVolumeSelect();
        };
        popup.appendChild(videoSelect);

        // 버튼 생성 헬퍼 함수
        function createButton(id, text, onClick) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.style.cssText = controlStyles;

            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent the click event from propagating to the document body
                onClick();
                showPopupTemporarily();

                if (isMobile) {
                    btn.style.backgroundColor = 'rgba(125,125,125,0.8)';
                    setTimeout(() => { btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; }, 200);
                }
            });
            return btn;
        }

        // 재생 속도 및 PIP, 시간 이동 버튼 추가
        popup.appendChild(createButton('slow', '0.2x', () => fixPlaybackRate(currentVideo, 0.2)));
        popup.appendChild(createButton('normal', '1.0x', () => fixPlaybackRate(currentVideo, 1.0)));
        popup.appendChild(createButton('fast', '5.0x', () => fixPlaybackRate(currentVideo, 5.0)));
        popup.appendChild(createButton('pip', '📺 PIP', async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (currentVideo) {
                    await currentVideo.requestPictureInPicture();
                }
            } catch (e) {
                console.error('PIP Error:', e);
            }
        }));
        popup.appendChild(createButton('back15', '⏪1분', () => seekVideo(-60)));
        popup.appendChild(createButton('forward15', '1분⏩', () => seekVideo(60)));

        // 볼륨 선택 드롭다운 생성
        const volumeSelect = document.createElement('select');
        volumeSelect.id = 'volume-select';
        volumeSelect.style.cssText = controlStyles + `
            max-width: 85px;
            margin-left: 8px;
            background: #000;
        `;

        volumeOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;

            if (isAmplificationBlocked && parseFloat(opt.value) > 1) {
                option.disabled = true;
                option.title = "Amplification is blocked on this site.";
            }
            volumeSelect.appendChild(option);
        });

        volumeSelect.onchange = () => {
            if (!currentVideo) return;
            const value = volumeSelect.value;

            showPopupTemporarily();

            if (value === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) {
                    gainNode.gain.value = 0;
                }
            } else {
                currentVideo.muted = false;
                const vol = parseFloat(value);
                setAmplifiedVolume(currentVideo, vol);
            }
            updateVolumeSelect();
        };

        // Initial setup for the selected video
        if (currentVideo) {
            addVideoInteractionListeners(currentVideo);
            fixPlaybackRate(currentVideo, desiredPlaybackRate);
            setupVideoDragging(currentVideo);
            updateVideoDraggingState(currentVideo);
        }
        updateVolumeSelect();
        popup.appendChild(volumeSelect);

        if (!isMobile) {
            // Desktop behavior: show popup on hover, fade on mouse leave
            popup.addEventListener('mouseenter', () => {
                popup.style.opacity = '1';
            });
            popup.addEventListener('mouseleave', () => {
                popup.style.opacity = idleOpacity;
            });
        } else {
            // Mobile behavior: show popup briefly on touch
            popup.addEventListener('touchstart', () => {
                showPopupTemporarily();
            });
        }

        hostRoot.appendChild(popup);
    }

    // --- Main Execution ---
    /**
     * 스크립트의 주요 실행 로직을 시작합니다.
     */
    function run() {
        createPopup(); // Initial attempt to create popup

        // Set up MutationObserver to watch for dynamic changes in the DOM, including video elements
        videoObserver = new MutationObserver(() => {
            const newVideos = findPlayableVideos();
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                console.log('[Observer] Video list changed. Recreating popup.');
                createPopup();
            }
        });

        // Start observing the body for video additions/removals
        videoObserver.observe(document.body, { childList: true, subtree: true });

        // Periodically check for videos and update dragging state
        setInterval(() => {
            const newVideos = findPlayableVideos();

            // Check if video list has changed and trigger popup recreation if necessary
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                 console.log('[Interval] Video list mismatch detected. Recreating popup.');
                createPopup();
            }

            if (currentVideo) {
                updateVideoDraggingState(currentVideo);
                // Ensure the feedback overlay is correctly positioned if fullscreen state changes
                if (feedbackOverlay) {
                    getFeedbackOverlay();
                }
            }
        }, 2000);

        // 전체 화면 상태 변경 감지 및 오버레이 위치 조정
        const fullscreenChangeHandler = () => {
            if (currentVideo) {
                updateVideoDraggingState(currentVideo);
                // Update overlay parent when fullscreen state changes
                if (feedbackOverlay) {
                    getFeedbackOverlay();
                }

              // === 팝업 위치 변경 ===
        const fsEl = document.fullscreenElement;
            if (popupElement) {
              if (fsEl) {
                fsEl.appendChild(popupElement);
              } else {
                document.body.appendChild(popupElement);
              }
            }
          }
        };

        document.addEventListener('fullscreenchange', fullscreenChangeHandler);
        document.addEventListener('webkitfullscreenchange', fullscreenChangeHandler);
        document.addEventListener('mozfullscreenchange', fullscreenChangeHandler);
        document.addEventListener('MSFullscreenChange', fullscreenChangeHandler);

        // 오버플로우 픽스 대상 사이트가 있으면 주기적으로 실행
        if (overflowFixTargets.length > 0) {
            fixOverflow();
            setInterval(fixOverflow, 1000);
        }

        // Add global click/touchstart listener to show popup
        const globalInteractionHandler = (event) => {
            // Check if the click/touch target is outside the popup element
            if (popupElement && popupElement.contains(event.target)) {
                return;
            }

            // Only proceed if it's a primary mouse click (button 0) for mouse events
            if (event.type === 'click' && event.button !== 0) {
                return;
            }

            showPopupTemporarily();
        };

        document.addEventListener('click', globalInteractionHandler);
        // Using 'touchstart' for mobile interaction to ensure responsiveness
        document.addEventListener('touchstart', globalInteractionHandler);
    }

    // 스크립트 실행 시작
    run();
})();
