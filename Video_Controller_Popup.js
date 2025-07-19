// ==UserScript==
// @name         Video Controller Popup (팝업 일부 사이트 영상 클릭 해제)
// @namespace    http://tampermonkey.net/
// @version      4.10.61_SiteSpecificVolume_Updated_FixedMobileDrag_MissavPopupFix
// @description  Controls video playback speed and volume with a draggable popup.
// @author       Your Name
// @match        *://*/*
// @exclude      *://*.google.com/*
// @exclude      *://*.facebook.com/*
// @exclude      *://*.youtube.com/embed/*
// @exclude      *://player.twitch.tv/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Constants
    const POPUP_TIMEOUT_MS = 3000; // 팝업 자동 숨김 시간 (3초)
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 비디오 상태 자동 체크 간격 (0.5초)
    const DRAG_THRESHOLD = 5; // 드래그 시작으로 간주할 픽셀 이동 임계값

    // Global Variables
    let popupElement = null;
    let currentVideo = null;
    let popupHideTimer = null;
    let isDragging = false;
    let dragOffsetX, dragOffsetY;
    let isInitialized = false;
    let checkVideoInterval = null;
    let videos = []; // 현재 페이지의 모든 비디오 엘리먼트를 저장할 배열
    let desiredPlaybackRate = 1.0; // 사용자가 설정한 최종 배속
    let desiredVolume = 1.0; // 사용자가 설정한 최종 볼륨
    let isManuallyPaused = false; // 사용자가 직접 일시정지했는지 여부
    let isManuallyMuted = false; // 사용자가 직접 음소거했는지 여부 (볼륨 0과 구분)
    let isManuallySelected = false; // 사용자가 비디오를 직접 클릭하여 선택했는지 여부

    // Site-specific configurations
    const NO_POPUP_ON_CLICK_SITES = ['missav.ws', 'missav.live'];
    const DEFAULT_AUDIO_SITES = [
        'youtube.com', 'twitch.tv', 'chzzk.naver.com', 'afreecatv.com', 'v.daum.net',
        'tv.naver.com', 'kakao.com', 'netflix.com', 'wavve.com', 'tving.com', 'disneyplus.com',
        'serieson.naver.com', 'coupangplay.com', 'primevideo.com'
    ]; // 자동 재생 시 소리가 기본으로 켜지는 사이트
    const isYouTubeSite = location.hostname.includes('youtube.com') || location.hostname.includes('youtube-nocookie.com');
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');
    const isMissavSite = NO_POPUP_ON_CLICK_SITES.some(domain => location.hostname.includes(domain));

    // Global block for certain conditions (e.g., extensions like "Video Speed Controller")
    let isPopupGloballyBlocked = false;

    // --- Helper Functions ---

    function setPopupVisibility(visible) {
        if (popupElement) {
            popupElement.style.display = visible ? 'block' : 'none';
        }
    }

    function showPopup() {
        if (!isPopupGloballyBlocked && currentVideo) {
            setPopupVisibility(true);
            updatePopupPosition(); // 팝업이 나타날 때 항상 위치를 업데이트
        }
    }

    function hidePopup() {
        setPopupVisibility(false);
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
            popupHideTimer = null;
        }
    }

    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed;
            background-color: rgba(30, 30, 30, 0.8);
            border: 1px solid #555;
            border-radius: 8px;
            padding: 10px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
            z-index: 2147483647; /* Highest possible z-index */
            display: none;
            flex-direction: column;
            gap: 8px;
            color: white;
            font-family: Arial, sans-serif;
            font-size: 14px;
            min-width: 180px;
            touch-action: none; /* Prevent browser default touch actions */
            user-select: none; /* Prevent text selection during drag */
        `;

        popupElement.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; cursor: grab;" id="vcp-header">
                <span id="vcp-title" style="font-weight: bold;">Video Controls</span>
                <button id="vcp-close" style="background: none; border: none; color: white; font-size: 18px; cursor: pointer;">&times;</button>
            </div>
            <div style="display: flex; align-items: center; gap: 5px;">
                <span>Speed:</span>
                <input type="range" id="vcp-speed" min="0.1" max="4.0" step="0.1" value="1.0" style="flex-grow: 1;">
                <span id="vcp-speed-display" style="width: 30px; text-align: right;">1.00</span>
            </div>
            <div style="display: flex; align-items: center; gap: 5px;">
                <span>Volume:</span>
                <input type="range" id="vcp-volume" min="0.0" max="1.0" step="0.01" value="1.0" style="flex-grow: 1;">
                <span id="vcp-volume-display" style="width: 30px; text-align: right;">100</span>
            </div>
            <div style="display: flex; justify-content: space-around; gap: 5px;">
                <button id="vcp-play-pause" style="padding: 8px 12px; background-color: #007bff; border: none; border-radius: 4px; color: white; cursor: pointer; flex-grow: 1;">Pause</button>
                <button id="vcp-mute-speak" style="padding: 8px 12px; background-color: #6c757d; border: none; border-radius: 4px; color: white; cursor: pointer; flex-grow: 1;">Mute</button>
            </div>
        `;
        document.body.appendChild(popupElement);

        // Event Listeners for Popup Controls
        popupElement.querySelector('#vcp-close').addEventListener('click', hidePopup);

        popupElement.querySelector('#vcp-play-pause').addEventListener('click', () => {
            if (currentVideo) {
                if (currentVideo.paused) {
                    currentVideo.play().catch(e => console.warn("Play attempt failed:", e));
                    isManuallyPaused = false;
                } else {
                    currentVideo.pause();
                    isManuallyPaused = true;
                }
                updatePlayPauseButton();
                resetPopupHideTimer();
            }
        });

        popupElement.querySelector('#vcp-mute-speak').addEventListener('click', () => {
            if (currentVideo) {
                isManuallyMuted = !currentVideo.muted; // 사용자가 직접 뮤트 상태 변경
                currentVideo.muted = isManuallyMuted;

                if (!currentVideo.muted && currentVideo.volume === 0) {
                    currentVideo.volume = desiredVolume > 0 ? desiredVolume : 0.5; // 음소거 해제 시 볼륨이 0이면 기본값 설정
                    desiredVolume = currentVideo.volume;
                }
                updateMuteSpeakButtons();
                updatePopupSliders(); // 슬라이더 값 업데이트
                resetPopupHideTimer();
            }
        });

        popupElement.querySelector('#vcp-speed').addEventListener('input', (e) => {
            if (currentVideo) {
                desiredPlaybackRate = parseFloat(e.target.value);
                currentVideo.playbackRate = desiredPlaybackRate;
                popupElement.querySelector('#vcp-speed-display').textContent = desiredPlaybackRate.toFixed(2);
                resetPopupHideTimer();
            }
        });

        popupElement.querySelector('#vcp-volume').addEventListener('input', (e) => {
            if (currentVideo) {
                desiredVolume = parseFloat(e.target.value);
                currentVideo.volume = desiredVolume;
                isManuallyMuted = desiredVolume === 0; // 볼륨이 0이면 뮤트 상태로 간주
                currentVideo.muted = isManuallyMuted;

                popupElement.querySelector('#vcp-volume-display').textContent = Math.round(desiredVolume * 100);
                updateMuteSpeakButtons(); // 뮤트/스피커 버튼 업데이트
                resetPopupHideTimer();
            }
        });

        // Drag functionality
        const header = popupElement.querySelector('#vcp-header');
        let startX, startY;
        let initialPopupX, initialPopupY;
        let isTouchDrag = false;

        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left-click
            isDragging = true;
            isTouchDrag = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = popupElement.getBoundingClientRect();
            initialPopupX = rect.left;
            initialPopupY = rect.top;

            popupElement.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none'; // Prevent text selection during drag
        });

        header.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                isDragging = false; // Reset for touch
                isTouchDrag = true;
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                const rect = popupElement.getBoundingClientRect();
                initialPopupX = rect.left;
                initialPopupY = rect.top;

                popupElement.style.cursor = 'grabbing';
                // No user-select change needed for touch as it's typically handled by passive listeners
            }
        }, { passive: true }); // Use passive for better scroll performance


        document.addEventListener('mousemove', (e) => {
            if (!isDragging || isTouchDrag) return;

            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            // Check if movement exceeds threshold to start dragging
            if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                isDragging = true;
            }

            if (isDragging) {
                let newX = initialPopupX + dx;
                let newY = initialPopupY + dy;

                // Clamp to window boundaries
                newX = Math.max(0, Math.min(newX, window.innerWidth - popupElement.offsetWidth));
                newY = Math.max(0, Math.min(newY, window.innerHeight - popupElement.offsetHeight));

                popupElement.style.left = `${newX}px`;
                popupElement.style.top = `${newY}px`;
                popupElement.style.transform = 'none';
                popupElement.style.position = 'fixed';
                resetPopupHideTimer();
            }
        });

        document.addEventListener('touchmove', (e) => {
            if (!isTouchDrag || e.touches.length !== 1) return;

            const dx = e.touches[0].clientX - startX;
            const dy = e.touches[0].clientY - startY;

            // Start dragging only if movement exceeds threshold
            if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                isDragging = true;
            }

            if (isDragging) {
                let newX = initialPopupX + dx;
                let newY = initialPopupY + dy;

                // Clamp to window boundaries
                newX = Math.max(0, Math.min(newX, window.innerWidth - popupElement.offsetWidth));
                newY = Math.max(0, Math.min(newY, window.innerHeight - popupElement.offsetHeight));

                popupElement.style.left = `${newX}px`;
                popupElement.style.top = `${newY}px`;
                popupElement.style.transform = 'none';
                popupElement.style.position = 'fixed';
                resetPopupHideTimer();
                e.preventDefault(); // Prevent scrolling while dragging
            }
        }, { passive: false }); // Use passive: false to allow preventDefault

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                popupElement.style.cursor = 'grab';
                document.body.style.userSelect = ''; // Re-enable text selection
                resetPopupHideTimer();
            }
        });

        document.addEventListener('touchend', () => {
            if (isTouchDrag) {
                isDragging = false;
                isTouchDrag = false;
                popupElement.style.cursor = 'grab';
                resetPopupHideTimer();
            }
        });

        document.addEventListener('mouseleave', () => {
            // If mouse leaves the document while dragging, stop dragging
            if (isDragging && !isTouchDrag) {
                isDragging = false;
                popupElement.style.cursor = 'grab';
                document.body.style.userSelect = '';
            }
        });

        // Prevent popup from hiding when mouse is over it
        popupElement.addEventListener('mouseenter', () => clearTimeout(popupHideTimer));
        popupElement.addEventListener('mouseleave', () => {
            if (popupElement.style.display !== 'none' && !isDragging) {
                resetPopupHideTimer();
            }
        });
    }

    function updatePlayPauseButton() {
        const playPauseButton = popupElement.querySelector('#vcp-play-pause');
        if (currentVideo && playPauseButton) {
            playPauseButton.textContent = currentVideo.paused ? 'Play' : 'Pause';
            playPauseButton.style.backgroundColor = currentVideo.paused ? '#28a745' : '#dc3545';
        }
    }

    function updateMuteSpeakButtons() {
        const muteSpeakButton = popupElement.querySelector('#vcp-mute-speak');
        if (currentVideo && muteSpeakButton) {
            muteSpeakButton.textContent = currentVideo.muted ? 'Speak' : 'Mute';
            muteSpeakButton.style.backgroundColor = currentVideo.muted ? '#ffc107' : '#6c757d';
        }
    }

    function calculateIntersectionRatio(video) {
        const videoRect = video.getBoundingClientRect();
        const viewport = {
            top: 0,
            left: 0,
            bottom: window.innerHeight,
            right: window.innerWidth
        };

        const intersection = {
            top: Math.max(videoRect.top, viewport.top),
            left: Math.max(videoRect.left, viewport.left),
            bottom: Math.min(videoRect.bottom, viewport.bottom),
            right: Math.min(videoRect.right, viewport.right)
        };

        const intersectionWidth = intersection.right - intersection.left;
        const intersectionHeight = intersection.bottom - intersection.top;

        if (intersectionWidth <= 0 || intersectionHeight <= 0) {
            return 0;
        }

        const intersectionArea = intersectionWidth * intersectionHeight;
        const videoArea = videoRect.width * videoRect.height;

        return videoArea > 0 ? intersectionArea / videoArea : 0;
    }

    function findPlayableVideos() {
        videos = Array.from(document.querySelectorAll('video, audio'))
            .filter(media => {
                // 비디오/오디오 엘리먼트가 아닌 경우 (예: canvas로 그린 비디오) 필터링
                if (!(media instanceof HTMLVideoElement || media instanceof HTMLAudioElement)) {
                    return false;
                }
                // HTML5 비디오/오디오가 아니거나, src가 없거나, duration이 NaN인 경우 제외
                if (!media.src && !media.currentSrc) {
                    return false;
                }
                if (isNaN(media.duration) && !media.hasAttribute('autoplay') && !media.hasAttribute('loop')) { // live streams might have NaN duration
                    // Some live streams or dynamically loaded videos might have duration as NaN initially
                    // We'll allow them if they have autoplay or loop attributes, or if they're currently playing
                    if (media.paused && !media.hasAttribute('autoplay') && !media.hasAttribute('loop')) {
                        return false;
                    }
                }
                // 너비나 높이가 0인 비디오 제외
                if (media.offsetWidth === 0 || media.offsetHeight === 0) {
                    return false;
                }
                // YouTube Shorts/Reels 및 Chzzk 썸네일 리스트 비디오 제외
                if (isYouTubeSite && (media.closest('ytd-reel-video-renderer') || media.closest('ytm-reel-player-renderer'))) {
                    return false;
                }
                if (isChzzkSite && media.closest('.live_thumbnail_list_item')) {
                    return false;
                }
                // 너비나 높이가 너무 작은 비디오 제외 (예: 추적 픽셀 또는 광고)
                if (media.videoWidth < 50 && media.videoHeight < 50 && media.tagName === 'VIDEO') {
                    return false;
                }
                // 부모 엘리먼트가 display: none 이거나 visibility: hidden 인 경우 제외 (실제 화면에 없는 경우)
                let parent = media;
                while (parent && parent !== document.body) {
                    const style = window.getComputedStyle(parent);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                        return false;
                    }
                    parent = parent.parentElement;
                }
                return true;
            });

            // If a video is in fullscreen, prioritize it
            const fullscreenVideo = Array.from(document.querySelectorAll('video')).find(v => document.fullscreenElement === v);
            if (fullscreenVideo && videos.includes(fullscreenVideo)) {
                videos = [fullscreenVideo, ...videos.filter(v => v !== fullscreenVideo)];
            }
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const ratio = calculateIntersectionRatio(currentVideo);
        return ratio > 0;
    }

    function selectAndControlVideo(video) {
        if (!video || currentVideo === video) {
            // 이미 선택된 비디오이거나 유효하지 않은 경우
            updatePlayPauseButton();
            updateMuteSpeakButtons();
            updatePopupSliders();
            return;
        }

        // 기존 비디오 일시정지 및 음소거
        if (currentVideo) {
            currentVideo.pause();
            currentVideo.muted = true;
            currentVideo.volume = 0;
        }

        currentVideo = video;
        isManuallyPaused = currentVideo.paused; // 새로 선택된 비디오의 현재 상태 반영

        // 사이트별 기본 볼륨 설정 로직
        const shouldHaveAudio = DEFAULT_AUDIO_SITES.some(domain => location.hostname.includes(domain));
        if (shouldHaveAudio) {
            if (currentVideo.muted && currentVideo.volume === 0) {
                 // 비디오가 원래 음소거 상태였으면 그대로 유지하거나, 기본 볼륨으로 재설정
                 // 사용자가 직접 음소거를 해제할 때를 위해 desiredVolume은 0이 아닌 값으로 설정
                isManuallyMuted = true; // 스크립트가 초기 뮤트 설정한 것으로 간주
                desiredVolume = 0.5; // 기본 볼륨 50%
                currentVideo.volume = 0; // 초기 로드 시에는 일단 0으로 설정
                currentVideo.muted = true;
            } else {
                // 음소거 상태가 아니면 현재 볼륨 유지
                desiredVolume = currentVideo.volume;
                isManuallyMuted = currentVideo.muted;
            }
        } else {
            // 소리 허용 사이트가 아니면 무조건 음소거
            isManuallyMuted = true;
            desiredVolume = 0;
            currentVideo.muted = true;
            currentVideo.volume = 0;
        }


        currentVideo.playbackRate = desiredPlaybackRate; // 저장된 배속 적용

        // 비디오 재생 시도 (사용자 제스처 필요할 수 있음)
        if (!isManuallyPaused) {
             currentVideo.play().catch(e => { /* console.warn("Auto-play blocked:", e); */ });
        }


        // 비디오 이벤트 리스너 추가 (이전에 추가되지 않은 경우에만)
        currentVideo.removeEventListener('play', updatePlayPauseButton);
        currentVideo.removeEventListener('pause', updatePlayPauseButton);
        currentVideo.removeEventListener('volumechange', updateMuteSpeakButtons); // 볼륨 변경 시 뮤트/스피커 버튼 업데이트
        currentVideo.removeEventListener('volumechange', updatePopupSliders); // 볼륨 변경 시 슬라이더 업데이트

        currentVideo.addEventListener('play', updatePlayPauseButton);
        currentVideo.addEventListener('pause', updatePlayPauseButton);
        currentVideo.addEventListener('volumechange', updateMuteSpeakButtons);
        currentVideo.addEventListener('volumechange', updatePopupSliders);

        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders(); // 슬라이더 값 업데이트
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (isPopupGloballyBlocked) return;
        if (!isDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        if (isPopupGloballyBlocked) {
            hidePopup();
            return;
        }
        if (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) {
            hidePopup();
            return;
        }

        if (!popupElement || !currentVideo || isDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, window.innerWidth - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
            popupElement.style.transform = 'none';
            popupElement.style.position = 'fixed';
        } else {
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;
        if (isPopupGloballyBlocked) {
            return;
        }
        if (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) {
            return;
        }

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (speedInput && speedDisplay) {
            // 슬라이더 값을 비디오의 실제 값으로 동기화
            const rate = currentVideo.playbackRate;
            speedInput.value = rate.toFixed(1); // range input은 step에 맞춰 값 설정 (0.1 단위)
            speedDisplay.textContent = rate.toFixed(2);
            desiredPlaybackRate = rate; // desired 값도 실제 값으로 동기화
        }

        if (volumeInput && volumeDisplay) {
            // 슬라이더 값을 비디오의 실제 값으로 동기화
            const volume = currentVideo.volume;
            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
            isManuallyMuted = currentVideo.muted; // 현재 뮤트 상태도 동기화
        }
    }

    function selectVideoOnDocumentClick(e) {
        if (isPopupGloballyBlocked) {
            if (currentVideo) {
                currentVideo.pause();
                currentVideo = null;
            }
            hidePopup();
            return;
        }

        // 팝업 내부 클릭 또는 드래그 중에는 무시
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            if (popupElement.style.display !== 'none') {
                return;
            }
        }

        updateVideoList();

        const centerY = window.innerHeight / 2;
        const centerX = window.innerWidth / 2;

        const filteredVideos = videos.filter(video => {
          if (isChzzkSite && video.closest('.live_thumbnail_list_item')) return false;
          if (isYouTubeSite && (video.closest('ytd-reel-video-renderer') || video.closest('ytm-reel-player-renderer'))) return false;
          return true;
        });

        const sorted = filteredVideos
            .map(v => {
                const rect = v.getBoundingClientRect();
                const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
                const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
                const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
                const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);

                const centerScore = 1 / Math.pow(1 + centerDist, 5);

                // 가중치: 면적 70%, 중앙 점수 30% (예시)
                const score = visibleArea * 0.7 + centerScore * 5000 * 0.3;

                return { video: v, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

        let bestVideo = sorted[0]?.video || null;

        let maxIntersectionRatio = 0;
        let foundPlayingVideo = null;

        videos.forEach(video => {
            if (isChzzkSite && video.closest('.live_thumbnail_list_item')) {
                return;
            }
            if (isYouTubeSite && (video.closest('ytd-reel-video-renderer') || video.closest('ytm-reel-player-renderer'))) {
                return;
            }

            const ratio = calculateIntersectionRatio(video);
            const isPlaying = !video.paused && video.duration > 0 && !video.ended;

            if (ratio >= 0.5) {
                if (!foundPlayingVideo) {
                    foundPlayingVideo = video;
                }
            }

            if (ratio > 0 && ratio > maxIntersectionRatio) {
                maxIntersectionRatio = ratio;
                bestVideo = video;
            }
        });

        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        } else if (bestVideo) {
            // Best intersection ratio video
        } else {
            // No suitable video found.
        }

        // 팝업 표시 로직 변경:
        // isMissavSite가 true일 경우, e가 존재하면 (즉, 사용자 클릭 시) 팝업을 띄우지 않고,
        // 전체화면 (document.fullscreenElement) 일 때만 팝업을 띄웁니다.
        // 다른 사이트에서는 e가 존재할 때 팝업을 띄웁니다.
        if (bestVideo && (maxIntersectionRatio > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo !== bestVideo) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                selectAndControlVideo(bestVideo);

                // 팝업을 띄울지 말지 결정하는 부분
                if (currentVideo && e instanceof Event && !isMissavSite) { // Missav 사이트가 아닐 때만 클릭 시 팝업 표시
                    isManuallySelected = true; // 수동 선택
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else if (document.fullscreenElement === currentVideo && !isPopupGloballyBlocked) { // 전체화면일 경우 항상 팝업 표시
                    isManuallySelected = true; // 수동 선택 (간주)
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    isManuallySelected = false; // 자동 감지
                    hidePopup();
                }

            } else { // 이미 선택된 비디오가 그대로 유지될 때
                if (e && !isMissavSite) { // Missav 사이트가 아닐 때만 클릭 시 팝업 표시
                    isManuallySelected = true; // 수동 선택으로 플래그 설정
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else if (document.fullscreenElement === currentVideo && !isPopupGloballyBlocked) { // 전체화면일 경우 항상 팝업 표시
                    isManuallySelected = true; // 수동 선택 (간주)
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                }
                else { // 클릭이 아닌 자동 감지 시에는 팝업 숨김 (만약 이미 열려있다면)
                    if (popupElement && popupElement.style.display !== 'none') {
                       hidePopup(); // 자동으로 뜬 팝업은 숨김
                    }
                }
            }
        } else { // 적합한 비디오가 없을 때
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            isManuallySelected = false; // 선택된 비디오 없으니 초기화
            if (!isDragging) {
                hidePopup();
            }
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (isPopupGloballyBlocked) {
            if (currentVideo) {
                currentVideo.pause();
                currentVideo = null;
            }
            hidePopup();
            return;
        }

        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();

            if (currentVideo && (!checkCurrentVideoVisibility() || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                if (!isDragging) {
                    hidePopup();
                }
            }

            selectVideoOnDocumentClick(null); // 스크롤 시에도 비디오 선택 로직은 실행하되, 팝업은 자동으로 안 뜸
        }, 100);
    }

    function updateVideoList() {
        findPlayableVideos();
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo) || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
            if (currentVideo) currentVideo.pause();
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
            if (foundMediaChange) {
                updateVideoList();
                selectVideoOnDocumentClick(null); // DOM 변경 시 비디오 선택 로직은 실행하되, 팝업은 자동으로 안 뜸
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
                isManuallySelected = false; // SPA 이동 시 수동 선택 상태 초기화
                hidePopup();
                updateVideoList();
                // --- 핵심 변경: URL 변경 시에도 사이트별 자동 소리 재생 로직 적용 ---
                // 새 URL에 맞춰 비디오를 다시 선택하고, 해당 사이트가 소리 허용 사이트면 자동 재생 (소리 포함)
                // 만약 currentVideo가 다시 선택되면 selectAndControlVideo 내에서 isManuallyMuted와 desiredVolume이 재설정됩니다.
                selectVideoOnDocumentClick(null); // 팝업은 자동으로 안 뜸
                updatePopupPosition(); // ← 이걸 즉시! 추추가
                // --- 핵심 변경 끝 ---
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
            { domain: 'chzzk.naver.com', selectors: ['.app_content', '.paged_list_area', '.live_thumbnail_list_item div[class*="video_area"]'] },
            { domain: 'youtube.com', selectors: ['ytd-app', 'html', 'body'] }, // 유튜브 전체 페이지 오버플로우
            { domain: 'music.youtube.com', selectors: ['ytmusic-app', 'html', 'body'] } // 유튜브 뮤직 전체 페이지 오버플로우
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

    function startCheckingVideoStatus() {
        if (checkVideoInterval) clearInterval(checkVideoInterval);
        checkVideoInterval = setInterval(() => {
            findAllVideosDeep().forEach(video => {
                // 현재 선택된 비디오가 아니면 무조건 일시정지, 무음, 볼륨 0
                if (video !== currentVideo) {
                    if (!video.paused) {
                        video.pause();
                    }
                    if (!video.muted || video.volume > 0) {
                             video.muted = true;
                             video.volume = 0;
                    }
                } else { // 현재 선택된 비디오
                    // 사용자가 수동으로 정지하지 않았다면 재생 시도
                    if (video.paused && !video.ended && !isManuallyPaused) {
                        video.play().catch(e => { /* console.warn("Auto-play attempt failed:", e); */ });
                    }
                    // 배속/볼륨 동기화 및 유지
                    // desired 값과 실제 비디오 값이 다르면, 실제 비디오 값을 desired에 반영
                    if (video.playbackRate !== desiredPlaybackRate) {
                        desiredPlaybackRate = video.playbackRate;
                    }
                    // **** 변경된 로직: 현재 비디오의 실제 볼륨이 desiredVolume과 다르면 강제로 desiredVolume으로 설정 ****
                    // isManuallyMuted 상태를 고려하여 muted 속성도 조절
                    // isManuallyMuted = true (스크립트 초기 뮤트), desiredVolume = 1.0 상태에서
                    // 사용자가 '소리' 버튼을 누르면 isManuallyMuted = false, desiredVolume = 1.0 이 됨
                    if (Math.abs(video.volume - desiredVolume) > 0.005 || video.muted !== (isManuallyMuted || desiredVolume === 0)) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                    }
                }
            });

            // 현재 비디오가 유효하지 않거나 특정 사이트의 제외 대상일 경우, 비디오 선택 로직만 다시 실행 (팝업은 자동으로 안 뜸)
            if (!currentVideo || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer')))) {
                selectVideoOnDocumentClick(null);
            }

            // 팝업이 열려있다면 위치만 업데이트하고 버튼 텍스트 및 슬라이더 업데이트
            if (popupElement && popupElement.style.display !== 'none' && !isDragging) {
                updatePopupPosition();
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders(); // 슬라이더 값도 계속 동기화
            }
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.61_SiteSpecificVolume_Updated_FixedMobileDrag_MissavPopupFix');

        createPopupElement();
        if (isPopupGloballyBlocked) {
            setPopupVisibility(false);
        } else {
            hidePopup();
        }

        document.addEventListener('fullscreenchange', () => {
            if (isPopupGloballyBlocked) {
                if (popupElement && popupElement.parentNode) {
                    popupElement.parentNode.removeChild(popupElement);
                }
                return;
            }
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    fsEl.appendChild(popupElement);
                    updatePopupPosition();
                    resetPopupHideTimer();
                    // 전체화면 진입 시 selectVideoOnDocumentClick(null) 호출하여 팝업을 띄우도록 함
                    selectVideoOnDocumentClick(null);
                } else {
                    document.body.appendChild(popupElement);
                    updatePopupPosition();
                    resetPopupHideTimer();
                    // 전체화면 종료 시 팝업을 숨길지 결정
                    if (!isManuallySelected) { // 수동 선택이 아니었다면 숨김
                        hidePopup();
                    }
                }
            }
        });

        window.addEventListener('resize', () => {
            if (isPopupGloballyBlocked) {
                hidePopup();
                return;
            }
            updatePopupPosition();
        });

        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList();
        setupDOMObserver();
        setupSPADetection();
        fixOverflow(); // 오버플로우 픽스 함수도 유튜브, 유튜브 뮤직에 추가

        let touchStartY = 0;
        let touchMoved = false;

        document.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            touchMoved = false;
        }, { passive: true }); // 스크롤 성능 향상을 위해 passive 옵션 추가

        document.addEventListener('touchmove', (e) => {
            const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
            if (deltaY > 10) { // 10px 이상 이동하면 드래그로 간주
                touchMoved = true;
            }
        }, { passive: true }); // 스크롤 성능 향상을 위해 passive 옵션 추가

        document.body.addEventListener('click', (e) => {
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }
            if (touchMoved) {
                touchMoved = false; // 플래그 초기화
                return; // 드래그 후 터치클릭 무시
            }

            // missav 사이트가 아니고, 현재 전체화면이 아닐 때만 클릭 이벤트를 selectVideoOnDocumentClick으로 전달
            // 이렇게 하면 일반 클릭시 Missav에서는 팝업이 안뜨고, 전체화면에서는 팝업이 뜨게 됩니다.
            // 또한, 페이지 아무곳이나 클릭할 때 팝업이 뜨도록 하기 위해 e를 전달합니다.
            if (!isMissavSite || document.fullscreenElement) {
                 selectVideoOnDocumentClick(e);
            } else {
                // missav 사이트이고 전체화면이 아닐 때는 비디오 선택 로직만 실행하고 팝업은 안 띄웁니다.
                selectVideoOnDocumentClick(null);
            }
        }, true); // Use capture phase to ensure this runs before other click handlers

        document.body.addEventListener('touchend', (e) => {
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }
            if (touchMoved) {
                touchMoved = false; // 플래그 초기화
                return; // 드래그 후 터치클릭 무시
            }
            // 터치도 클릭과 동일하게 처리
            if (!isMissavSite || document.fullscreenElement) {
                selectVideoOnDocumentClick(e);
            } else {
                selectVideoOnDocumentClick(null);
            }
        }, true); // Use capture phase

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

    // Helper to find all playable videos, including those in shadow DOM
    function findAllVideosDeep() {
        const allMedia = new Set();

        function findInNode(node) {
            if (!node) return;

            // Add direct video/audio elements
            node.querySelectorAll('video, audio').forEach(el => allMedia.add(el));

            // Check for shadow DOM
            if (node.shadowRoot) {
                findInNode(node.shadowRoot);
            }

            // Recurse into iframes
            node.querySelectorAll('iframe').forEach(iframe => {
                try {
                    if (iframe.contentDocument) {
                        findInNode(iframe.contentDocument);
                    }
                } catch (e) {
                    // console.warn("Could not access iframe content:", e);
                }
            });
        }

        findInNode(document.body);
        return Array.from(allMedia);
    }

})();
