// ==UserScript==
// @name         Video Controller Popup Refactored
// @namespace    http://tampermonkey.net/
// @version      4.10.68_Refactored
// @description  Plays, mutes, adjusts speed/volume of HTML5 videos/audios on scroll, click, or DOM changes. Popup appears on click, can be globally blocked for certain sites, or blocked only on click for specific players.
// @author       YourName (or original author)
// @match        *://*/*
// @exclude      *://chzzk.naver.com/*
// @exclude      *://m.chzzk.naver.com/*
// @exclude      *://www.youtube.com/shorts/*
// @exclude      *://m.youtube.com/shorts/*
// @exclude      *://youtube.com/shorts/*
// @exclude      *://www.youtube.com/live_chat*
// @exclude      *://m.youtube.com/live_chat*
// @exclude      *://music.youtube.com/*
// @exclude      *://www.twitch.tv/popout/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ====== 전역 변수 및 설정 ======
    let popupElement = null;
    let currentVideo = null;
    let videos = [];
    let checkVideoInterval = null;
    let popupHideTimer = null;
    let isPopupDragging = false;
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;
    let isManuallyPaused = false; // 사용자가 직접 정지했는지 여부
    let isManuallyMuted = false; // 사용자가 직접 음소거했는지 여부
    let desiredPlaybackRate = 1.0; // 사용자가 설정한 배속 (초기값 1.0)
    let desiredVolume = 1.0; // 사용자가 설정한 볼륨 (초기값 1.0)
    let isInitialized = false;

    // 팝업이 자동으로 숨겨지기까지의 시간 (밀리초)
    const POPUP_TIMEOUT_MS = 2000;
    // 비디오 상태를 주기적으로 체크하는 간격 (밀리초)
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500;

    // 새로운 리스트: 이 리스트에 있는 사이트는 '영상 클릭' 시 팝업이 나타나지 않음
    // **중요: 이제 이 리스트는 "영상 요소 자체 또는 영상 요소를 포함하는 부모 요소"를 클릭했을 때만 팝업을 차단합니다.**
    // **페이지의 빈 공간이나 다른 비(非)영상 요소를 클릭했을 때는 팝업이 나타납니다.**
    const PLAYER_POPUP_BLOCK_LIST = [
        { domain: 'missav.ws', pathIncludes: '' }, // 치지직 전체 페이지에서 영상 클릭 시 팝업 차단
        { domain: 'youtube.com', pathIncludes: '' }, // 유튜브 전체 페이지에서 영상 클릭 시 팝업 차단
        { domain: 'twitch.tv', pathIncludes: '' } // 트위치 전체 페이지에서 영상 클릭 시 팝업 차단
        // 예시: 특정 경로에서만 차단하려면 { domain: 'example.com', pathIncludes: '/video/' }
    ];

    // 자동 소리 재생을 허용할 사이트 목록
    // 이 목록에 있는 사이트에서는 비디오가 선택될 때 자동으로 소리가 재생됩니다.
    // 이 외의 사이트에서는 초기에는 음소거 상태로 자동 재생을 시도합니다.
    const AUTO_UNMUTE_SITES = [
        { domain: 'youtube.com', pathIncludes: '' },
        { domain: 'chzzk.naver.com', pathIncludes: '' },
        { domain: 'twitch.tv', pathIncludes: '' }
    ];

    // 현재 사이트가 AUTO_UNMUTE_SITES에 포함되는지 확인하는 헬퍼 함수
    function isCurrentSiteAutoUnmute() {
        return AUTO_UNMUTE_SITES.some(site => {
            const isDomainMatch = location.hostname.includes(site.domain);
            if (!isDomainMatch) return false;
            if (site.pathIncludes) {
                return location.pathname.includes(site.pathIncludes);
            }
            return true;
        });
    }

    // 새로운 헬퍼 함수: 현재 사이트가 PLAYER_POPUP_BLOCK_LIST에 포함되는지 확인
    function isPlayerPopupBlockedSite() {
        return PLAYER_POPUP_BLOCK_LIST.some(site => {
            const isDomainMatch = location.hostname.includes(site.domain);
            if (!isDomainMatch) return false;
            if (site.pathIncludes) {
                return location.pathname.includes(site.pathIncludes);
            }
            return true;
        });
    }

    // 특정 사이트 (치지직 미리보기, 유튜브 쇼츠) 영상 제외를 위한 플래그
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');
    const isYouTubeSite = location.hostname.includes('youtube.com');

    // ====== 헬퍼 함수 ======
    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        // 비디오와 뷰포트의 교차 영역 계산
        const intersectionTop = Math.max(0, rect.top);
        const intersectionBottom = Math.min(viewportHeight, rect.bottom);
        const intersectionLeft = Math.max(0, rect.left);
        const intersectionRight = Math.min(viewportWidth, rect.right);

        const intersectionWidth = intersectionRight - intersectionLeft;
        const intersectionHeight = intersectionBottom - intersectionTop;

        if (intersectionWidth <= 0 || intersectionHeight <= 0) {
            return 0; // 교차 영역 없음
        }

        const intersectionArea = intersectionWidth * intersectionHeight;
        const videoArea = rect.width * rect.height;

        return videoArea > 0 ? intersectionArea / videoArea : 0;
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const ratio = calculateIntersectionRatio(currentVideo);
        return ratio > 0; // 0보다 크면 보인다고 판단
    }

    function findPlayableVideos() {
        videos = Array.from(document.querySelectorAll('video, audio'))
            .filter(media => {
                // 가로 또는 세로 길이가 10px 미만인 비디오 제외
                const rect = media.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) return false;

                // 이미 제거된 노드 제외
                if (!document.body.contains(media)) return false;

                // YouTube Shorts / Chzzk 미리보기 영상 제외
                if (isChzzkSite && media.closest('.live_thumbnail_list_item')) return false;
                if (isYouTubeSite && (media.closest('ytd-reel-video-renderer') || media.closest('ytm-reel-player-renderer'))) return false;

                return true;
            });
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            return;
        }

        if (currentVideo === videoToControl) {
            // 이미 선택된 비디오라면 아무것도 하지 않음 (성능 최적화)
            return;
        }

        // 이전 비디오가 있으면 일시 정지 및 초기화
        if (currentVideo) {
            currentVideo.pause();
            currentVideo.muted = true;
            currentVideo.volume = 0;
        }

        currentVideo = videoToControl;
        isManuallyPaused = false; // 새 비디오 선택 시 수동 정지 상태 초기화

        // 새 비디오에 자동 재생 설정 시도
        currentVideo.autoplay = true;
        currentVideo.playsInline = true; // 인라인 재생 활성화

        // 사이트별 자동 소리/무음 설정
        if (isCurrentSiteAutoUnmute()) {
            isManuallyMuted = false;
            desiredVolume = 1.0;
            currentVideo.muted = false;
            currentVideo.volume = 1.0;
            console.log('[VCP] Video selected. Initiating autoplay with sound (100%).');
        } else {
            isManuallyMuted = true; // 음소거 상태로 시작
            desiredVolume = 0;
            currentVideo.muted = true;
            currentVideo.volume = 0;
            console.log('[VCP] Video selected. Initiating muted autoplay.');
        }

        // 비디오 재생 시도
        currentVideo.play().catch(e => {
            // console.warn("Autoplay/Play on select failed:", e);
            // 자동 재생 실패 시에도 상태는 설정해야 함
            if (isCurrentSiteAutoUnmute()) {
                isManuallyMuted = false;
                desiredVolume = 1.0;
                currentVideo.muted = false;
                currentVideo.volume = 1.0;
            } else {
                isManuallyMuted = true;
                desiredVolume = 0;
                currentVideo.muted = true;
                currentVideo.volume = 0;
            }
        });

        // 재생 속도 초기화 (이전 비디오에서 설정된 값이 남아있을 수 있으므로)
        desiredPlaybackRate = 1.0;
        currentVideo.playbackRate = 1.0;

        // 비디오 이벤트 리스너 (선택된 비디오에만 적용)
        currentVideo.onplay = () => updatePlayPauseButton();
        currentVideo.onpause = () => updatePlayPauseButton();
        currentVideo.onvolumechange = () => updateMuteSpeakButtons();
    }

    function fixPlaybackRate(video, rate) {
        if (video) {
            video.playbackRate = rate;
            desiredPlaybackRate = rate; // 사용자가 설정한 배속 업데이트
        }
    }

    function setNormalVolume(video, vol) {
        if (video) {
            video.volume = vol;
            isManuallyMuted = (vol === 0); // 볼륨 0이면 수동 음소거로 간주
            desiredVolume = vol; // 사용자가 설정한 볼륨 업데이트
            video.muted = isManuallyMuted; // 실제 muted 속성도 업데이트
        }
    }

    // ====== 팝업 UI 생성 및 조작 ======
    function createPopupElement() {
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            all: initial; /* 모든 CSS 속성 초기화 */
            position: fixed;
            background: rgba(0, 0, 0, 0.8);
            border-radius: 8px;
            padding: 10px;
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            text-align: center;
            z-index: 2147483647 !important; /* 최상위 z-index */
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            display: none; /* 초기에는 숨김 */
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s ease-in-out;
            box-sizing: border-box; /* 패딩, 보더가 너비에 포함되도록 */
            min-width: 250px; /* 최소 너비 설정 */
            pointer-events: none !important; /* 초기에는 클릭 불가능하도록 */
        `;

        popupElement.innerHTML = `
            <div id="vcp-drag-handle" style="cursor: grab; padding: 5px; margin: -5px -5px 5px -5px; background: rgba(255, 255, 255, 0.1); border-radius: 5px; user-select: none;">
                <span>▶ Video Controller</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <button data-action="play-pause" style="flex-grow: 1; padding: 8px 12px; margin-right: 5px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s;">재생/일시정지</button>
                <button data-action="reset-speed" style="padding: 8px 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s;">배속1x</button>
            </div>
            <div style="margin-bottom: 10px;">
                <label for="vcp-speed" style="display: block; margin-bottom: 5px;">배속: <span id="vcp-speed-display">1.00</span></label>
                <input type="range" id="vcp-speed" min="0.25" max="4" step="0.05" value="1" style="width: 100%; cursor: grab;">
            </div>
            <div style="margin-bottom: 10px;">
                <label for="vcp-volume" style="display: block; margin-bottom: 5px;">볼륨: <span id="vcp-volume-display">100</span></label>
                <input type="range" id="vcp-volume" min="0" max="1" step="0.01" value="1" style="width: 100%; cursor: grab;">
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <button data-action="mute" style="flex-grow: 1; padding: 8px 12px; margin-right: 5px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s;">무음</button>
                <button data-action="speak" style="flex-grow: 1; padding: 8px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; transition: background 0.2s;">소리</button>
            </div>
        `;

        document.body.appendChild(popupElement);
    }

    function handleButtonClick(action) {
        if (!currentVideo) return; // 현재 선택된 비디오가 없으면 아무것도 하지 않음
        resetPopupHideTimer(); // 버튼 클릭 시 팝업 숨김 타이머 리셋

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    currentVideo.play().catch(e => console.warn("Play failed:", e));
                    isManuallyPaused = false;
                } else {
                    currentVideo.pause();
                    isManuallyPaused = true;
                }
                break;
            case 'reset-speed':
                fixPlaybackRate(currentVideo, 1.0);
                updatePopupSliders(); // 슬라이더 및 표시값 업데이트
                break;
            case 'mute':
                isManuallyMuted = true;
                currentVideo.muted = true;
                currentVideo.volume = 0;
                desiredVolume = 0;
                updatePopupSliders(); // 슬라이더 및 표시값 업데이트
                break;
            case 'speak':
                isManuallyMuted = false;
                // 이전 볼륨이 0이었거나 잊어버린 경우를 대비하여 기본 볼륨으로 설정
                const targetVolume = (currentVideo.volume === 0 || desiredVolume === 0) ? 1.0 : desiredVolume;
                setNormalVolume(currentVideo, targetVolume);
                currentVideo.muted = false;
                updatePopupSliders(); // 슬라이더 및 표시값 업데이트
                break;
        }
        updatePlayPauseButton();
        updateMuteSpeakButtons();
    }

    function updatePlayPauseButton() {
        if (!popupElement || !currentVideo) return;
        const playPauseButton = popupElement.querySelector('[data-action="play-pause"]');
        if (playPauseButton) {
            playPauseButton.textContent = currentVideo.paused ? '재생' : '일시정지';
            playPauseButton.style.background = currentVideo.paused ? '#007bff' : '#ffc107'; // 색상 변경
        }
    }

    function updateMuteSpeakButtons() {
        if (!popupElement || !currentVideo) return;
        const muteButton = popupElement.querySelector('[data-action="mute"]');
        const speakButton = popupElement.querySelector('[data-action="speak"]');

        if (muteButton && speakButton) {
            if (currentVideo.muted || currentVideo.volume === 0) {
                muteButton.style.background = '#dc3545'; // 활성화 색상
                speakButton.style.background = '#28a745'; // 비활성화 색상 (원래 색)
                muteButton.textContent = '무음 (활성)';
                speakButton.textContent = '소리';
            } else {
                muteButton.style.background = '#28a745'; // 비활성화 색상 (원래 색)
                speakButton.style.background = '#dc3545'; // 활성화 색상
                muteButton.textContent = '무음';
                speakButton.textContent = '소리 (활성)';
            }
        }
    }


    function setupPopupEventListeners() {
        if (!popupElement) return;

        popupElement.addEventListener('click', (e) => {
            const action = e.target.getAttribute('data-action');
            if (action) handleButtonClick(action);
            e.stopImmediatePropagation(); // 팝업 내부 클릭 시 이벤트 전파 중단
        });

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', (e) => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2);
            e.stopImmediatePropagation(); // 슬라이더 조작 시 이벤트 전파 중단
        });

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', (e) => {
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            // 슬라이더 조작은 사용자의 의도이므로 isManuallyMuted를 vol === 0 에 따라 변경
            isManuallyMuted = (vol === 0);
            if (currentVideo) { setNormalVolume(currentVideo, vol); }
            volumeDisplay.textContent = Math.round(vol * 100);
            updateMuteSpeakButtons(); // 볼륨 조작 시 무음/소리 버튼 상태도 업데이트
            e.stopImmediatePropagation(); // 슬라이더 조작 시 이벤트 전파 중단
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
            e.stopImmediatePropagation(); // 드래그 시작 시 이벤트 전파 중단
        };

        const stopDrag = (e) => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.cursor = 'grab';
                document.body.style.userSelect = '';
                resetPopupHideTimer();
                updatePopupPosition();
            }
            // e.stopImmediatePropagation(); // 드래그 종료 시 이벤트 전파 중단 (필요 시)
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
            popupElement.style.left = `${clientX - popupDragOffsetX}px`;
            popupElement.style.top = `${clientY - popupDragOffsetY}px`;
            e.stopImmediatePropagation(); // 드래그 중 이벤트 전파 중단
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
                display: 'block',
                opacity: '0.75',
                visibility: 'visible',
                pointerEvents: 'auto !important', // 항상 클릭 가능하도록
                zIndex: '2147483647 !important' // 항상 최상단에 있도록
            };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            popupElement.style.setProperty('pointer-events', 'none', 'important'); // 숨김 시 클릭 불가능
        }
    }

    function showPopup() {
        // 팝업이 나타나기 전에 currentVideo 유효성 및 특정 사이트 제외 조건을 한 번 더 확인
        if (!currentVideo || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer')))) {
            hidePopup();
            return;
        }

        setPopupVisibility(true);
        updatePopupPosition();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        // 팝업 드래그 중이 아니며, 팝업이 표시되어 있을 때만 위치 업데이트
        if (!popupElement || isPopupDragging || popupElement.style.display === 'none') {
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

            // 화면 경계 내에 팝업이 위치하도록 조정
            adjustedX = Math.max(0, Math.min(adjustedX, window.innerWidth - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
            popupElement.style.transform = 'none';
            popupElement.style.position = 'fixed'; // 전체화면에서도 fixed 유지 (부모가 바뀌므로)
        } else {
            // 비디오가 화면을 벗어나면 팝업 숨김
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo || popupElement.style.display === 'none') return; // 팝업이 숨겨져 있으면 업데이트하지 않음

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (speedInput && speedDisplay) {
            const rate = currentVideo.playbackRate;
            speedInput.value = rate.toFixed(1);
            speedDisplay.textContent = rate.toFixed(2);
            desiredPlaybackRate = rate;
        }

        if (volumeInput && volumeDisplay) {
            const volume = currentVideo.volume;
            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
            isManuallyMuted = currentVideo.muted;
        }
    }


    // ====== 이벤트 핸들러 및 스크립트 라이프사이클 ======

    // 페이지 내에서 가장 적합한 비디오를 찾아 반환하는 순수 함수로 분리
    function findBestVideoOnPage() {
        updateVideoList(); // 최신 비디오 목록으로 업데이트

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

                const score = visibleArea * 0.7 + (1 / Math.pow(1 + centerDist, 5)) * 5000 * 0.3; // 가중치 조정

                return { video: v, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

        let bestVideo = sorted[0]?.video || null;
        let foundPlayingVideo = null;

        // 추가 로직: 재생 중인 비디오가 있다면 우선적으로 선택
        videos.forEach(video => {
            if (!video.paused && video.duration > 0 && !video.ended) {
                // 재생 중인 비디오가 제외 대상인지 다시 확인
                if (!(isChzzkSite && video.closest('.live_thumbnail_list_item')) &&
                    !(isYouTubeSite && (video.closest('ytd-reel-video-renderer') || video.closest('ytm-reel-player-renderer')))) {
                    foundPlayingVideo = video;
                    return; // 찾으면 바로 종료
                }
            }
        });

        // 재생 중인 비디오가 있다면 최우선
        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        }

        return bestVideo;
    }


    // 문서 클릭 이벤트 핸들러 (팝업 표시를 위한 명시적 클릭)
    let touchStartY = 0;
    let touchMoved = false; // 터치 이동 여부를 확인하는 플래그

    document.addEventListener('touchstart', (e) => {
        // 팝업 내부 터치는 무시 (팝업이 닫히거나 동작하지 않게 방지)
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        // 팝업 내부 터치 이동은 무시
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
        if (deltaY > 10) { // 일정 픽셀 이상 움직이면 스크롤로 간주
            touchMoved = true;
        }
    }, { passive: true });

    // 캡처링 단계에서 이벤트를 가로채고, 필요 시 전파를 중지합니다.
    document.addEventListener('click', (e) => {
        // 팝업 내부 클릭 또는 드래그 중에는 무시하고 타이머 리셋
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            if (popupElement.style.display !== 'none') {
                e.stopImmediatePropagation(); // 팝업이 이미 열려있으면 클릭 처리 안함
                return;
            }
        }

        // 터치 드래그 후 발생하는 클릭 이벤트 무시 (스크롤을 한 경우)
        if (touchMoved) {
            touchMoved = false; // 플래그 초기화
            e.stopImmediatePropagation(); // 클릭 이벤트 전파 중단
            return;
        }

        const newBestVideo = findBestVideoOnPage();
        // 클릭된 요소가 video 또는 audio 태그 자체이거나, 그 조상 중에 video/audio 태그가 있는지 확인
        const clickedIsMediaRelated = (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO' || e.target.closest('video, audio'));

        if (newBestVideo) {
            // 현재 선택된 비디오가 없거나 다른 비디오가 선택되었을 때만 selectAndControlVideo 호출
            if (currentVideo !== newBestVideo) {
                selectAndControlVideo(newBestVideo);
            }

            // PLAYER_POPUP_BLOCK_LIST에 있는 사이트이면서, 클릭된 타겟이 '영상 요소 관련'일 경우 팝업 차단
            // 그 외의 경우 (차단 리스트에 없거나, 차단 리스트에 있더라도 클릭된 타겟이 영상 요소 관련이 아닐 때) 팝업 표시
            if (isPlayerPopupBlockedSite() && clickedIsMediaRelated) {
                hidePopup(); // 영상 요소 관련 클릭이므로 팝업 숨김 (의도된 동작)
            } else {
                showPopup(); // 영상이 아닌 곳을 클릭했거나, 차단 리스트에 없는 사이트이므로 팝업 표시
                resetPopupHideTimer();
            }
        } else {
            // 적합한 비디오가 없을 때
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            hidePopup();
        }
        // 이 스크립트의 클릭 처리가 완료되면 다른 클릭 이벤트가 영향을 받지 않도록 전파 중단
        e.stopImmediatePropagation();
    }, true); // 캡처링 단계에서 이벤트 감지 (클릭이 먼저 감지되도록)

    document.body.addEventListener('touchend', (e) => {
        // 팝업 내부 터치 종료 시 타이머 리셋
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            e.stopImmediatePropagation();
            return;
        }
        // 터치 드래그 후 발생하는 클릭 이벤트 무시 (touchend도 유사하게 처리)
        // touchMoved가 true이면 (스크롤 있었다면) 클릭 이벤트가 발생해도 무시하기 위함
        // body click 이벤트가 touchend 이후에 발생하므로, touchend에서는 중복 호출 방지
        if (touchMoved) {
            e.stopImmediatePropagation(); // touchend 이벤트 전파도 중단
        }
    }, true);


    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            const newBestVideo = findBestVideoOnPage();

            if (currentVideo && (!checkCurrentVideoVisibility() ||
                (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) ||
                (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
                // 현재 비디오가 더 이상 안 보이거나 제외 대상이 되면, 초기화
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup(); // 스크롤 시 팝업 자동 숨김
            }

            // 새로운 최적 비디오가 있고, 현재 선택된 비디오와 다르면 업데이트
            if (newBestVideo && currentVideo !== newBestVideo) {
                selectAndControlVideo(newBestVideo);
                hidePopup(); // 스크롤 시 자동 선택된 경우 팝업은 숨김
            } else if (!newBestVideo && currentVideo) {
                // 최적 비디오가 없는데 currentVideo가 있으면 초기화 (위에 이미 처리됨)
                // currentVideo.pause();
                // currentVideo = null;
                // hidePopup();
            }

            // 팝업이 드래그 중이 아니면 스크롤 시 팝업 숨김 (클릭으로 열린 팝업이 스크롤 시 사라지도록)
            if (!isPopupDragging) {
                hidePopup();
            }

        }, 100); // 스크롤 디바운스
    }

    function updateVideoList() {
        findPlayableVideos();
        // 현재 currentVideo가 DOM에서 사라졌거나, 목록에서 제외되었는지 확인
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo) ||
            (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) ||
            (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
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
                // 노드가 추가/제거되거나, 비디오/오디오의 속성이 변경된 경우
                if (mutation.type === 'childList' && (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))))) {
                    foundMediaChange = true;
                    break;
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    foundMediaChange = true;
                    break;
                }
            }
            if (foundMediaChange) {
                const newBestVideo = findBestVideoOnPage();
                if (newBestVideo && currentVideo !== newBestVideo) {
                    selectAndControlVideo(newBestVideo);
                } else if (!newBestVideo && currentVideo) {
                    // 새 비디오가 없는데 현재 비디오가 있다면 초기화
                    if (currentVideo) currentVideo.pause();
                    currentVideo = null;
                }
                hidePopup(); // DOM 변경 시 팝업 자동 숨김
            }
        };
        const mutationObserver = new MutationObserver(observerCallback);
        mutationObserver.observe(document.body, observerConfig);
    }

    function setupSPADetection() {
        let lastUrl = location.href;
        // URL 변화를 감지하는 MutationObserver (단일 페이지 애플리케이션용)
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting state.`);
                lastUrl = currentUrl;
                if (currentVideo) currentVideo.pause();
                currentVideo = null; // SPA 이동 시 현재 비디오 초기화
                isManuallyPaused = false; // 수동 정지 상태 초기화
                hidePopup(); // 팝업 숨김

                const newBestVideo = findBestVideoOnPage(); // 새 페이지에서 비디오 찾기
                if (newBestVideo) {
                    selectAndControlVideo(newBestVideo); // 비디오 선택 및 제어
                }
                // SPA 이동 시 팝업은 자동으로 띄우지 않음. 클릭해야 나옴.
                updatePopupPosition(); // 위치 업데이트는 필요
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
            { domain: 'chzzk.naver.com', selectors: ['.app_content', '.paged_list_area', '.live_thumbnail_list_item div[class*="video_area"]'] },
            { domain: 'youtube.com', selectors: ['ytd-app', 'html', 'body'] },
            { domain: 'music.youtube.com', selectors: ['ytmusic-app', 'html', 'body'] }
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

    // findAllVideosDeep 함수 (현재는 findPlayableVideos와 유사하게 동작)
    // 이 함수는 주기적인 상태 체크 루틴에서 모든 미디어 요소를 다시 찾는 용도로 사용됩니다.
    function findAllVideosDeep() {
        return Array.from(document.querySelectorAll('video, audio'))
            .filter(media => {
                const rect = media.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) return false;
                if (!document.body.contains(media)) return false;
                // 특정 사이트 미리보기/쇼츠 영상도 이 함수에서는 제외
                if (isChzzkSite && media.closest('.live_thumbnail_list_item')) return false;
                if (isYouTubeSite && (media.closest('ytd-reel-video-renderer') || media.closest('ytm-reel-player-renderer'))) return false;
                return true;
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
                    if (video.playbackRate !== desiredPlaybackRate) {
                        video.playbackRate = desiredPlaybackRate;
                    }
                    // 현재 비디오의 실제 볼륨/뮤트 상태가 desiredVolume/isManuallyMuted와 다르면 강제 설정
                    if (Math.abs(video.volume - desiredVolume) > 0.005 || video.muted !== (isManuallyMuted || desiredVolume === 0)) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                    }
                }
            });

            // 팝업이 열려있다면 위치만 업데이트하고 버튼 텍스트 및 슬라이더 업데이트
            // 팝업이 드래그 중이 아닐 때만 위치 업데이트
            if (popupElement && popupElement.style.display !== 'none' && !isPopupDragging) {
                updatePopupPosition();
                updatePlayPauseButton();
                updateMuteSpeakButtons();
                updatePopupSliders();
            }
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }


    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.68_Refactored');

        createPopupElement();
        hidePopup(); // 초기에는 무조건 숨김

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    // 전체 화면 요소가 존재하면 팝업을 해당 요소의 자식으로 추가
                    fsEl.appendChild(popupElement);
                    console.log('[VCP] Moved popup to fullscreen element.');
                    // 전체 화면 진입 시 팝업을 보여주고 타이머 리셋
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    // 전체 화면 종료 시 팝업을 다시 body로 이동
                    document.body.appendChild(popupElement);
                    console.log('[VCP] Moved popup back to body.');
                    // 전체 화면 종료 시 팝업을 숨김
                    hidePopup();
                }
                updatePopupPosition(); // 위치 업데이트 (필수)
            }
        });

        window.addEventListener('resize', () => {
            // 창 크기 변경 시에도 팝업이 열려있다면 위치만 업데이트
            if (popupElement && popupElement.style.display !== 'none') {
                updatePopupPosition();
            }
        });

        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList(); // 초기 비디오 목록 업데이트
        setupDOMObserver(); // DOM 변화 감지 설정
        setupSPADetection(); // SPA 감지 설정
        fixOverflow(); // 오버플로우 픽스

        setupPopupEventListeners(); // 팝업 자체의 이벤트 리스너 설정

        startCheckingVideoStatus(); // 비디오 상태 주기적 확인 시작

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
Element = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval);
        });
    }

    // 스크립트 로드 시 초기화
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
