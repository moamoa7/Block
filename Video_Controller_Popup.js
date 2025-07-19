// ==UserScript==
// @name         Video Controller Popup (VCP) - Modified for tvwiki22.com Pause (TrustedHTML Fix)
// @namespace    http://tampermonkey.net/
// @version      4.10.68
// @description  Plays/pauses video with a floating popup, manages multiple videos, and fixes overflow issues. Modified to ensure video pauses on tvwiki22.com when popup appears. Now with TrustedHTML fix.
// @author       Your Name (or original author)
// @match        *://*/*
// @exclude      *://*.google.com/*
// @exclude      *://*.youtube.com/embed/*
// @exclude      *://*.youtube-nocookie.com/embed/*
// @exclude      *://*.twitch.tv/embed/*
// @exclude      *://player.twitch.tv/*
// @exclude      *://chzzk.naver.com/live/*
// @exclude      *://chzzk.naver.com/video/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 전역 변수
    let popupElement = null;
    let currentVideo = null;
    let videos = [];
    let checkVideoInterval = null;
    let popupHideTimer = null;
    let isPopupDragging = false;
    let popupDragOffsetX = 0;
    let popupDragOffsetY = 0;
    let isInitialized = false;

    // 비디오 상태 저장 및 복원 관련 변수
    let savedCurrentTime = 0;
    let wasPausedBeforeFullscreen = true; // 전체 화면 진입 전 일시 정지 상태였는지
    let fullscreenRestoreAttempts = 0;
    let fullscreenRestoreTimeout = null;

    // 수동 제어 상태 플래그
    let isManuallyPaused = false;
    let isManuallyMuted = false;
    let isManuallySelected = false; // 사용자가 팝업을 수동으로 선택했는지 여부

    // 재생/일시 정지 메서드 오버라이딩 방지를 위한 원본 저장
    let originalPlayMethod = HTMLMediaElement.prototype.play;
    let originalPauseMethod = HTMLMediaElement.prototype.pause;
    const overwrittenPlayMethods = new WeakSet();
    const overwrittenPauseMethods = new WeakSet();

    // 설정 값 (필요에 따라 조정)
    const POPUP_TIMEOUT_MS = 3000; // 팝업 자동 숨김 시간 (3초)
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 비디오 상태 체크 주기 (0.5초)
    const FULLSCREEN_RESTORE_MAX_ATTEMPTS = 5; // 전체 화면 종료 후 상태 복원 재시도 횟수
    const FULLSCREEN_RESTORE_INTERVAL_MS = 300; // 전체 화면 종료 후 상태 복원 재시도 간격
    const FULLSCREEN_RESTORE_INITIAL_DELAY_MS = 100; // 첫 복원 시도 전 초기 지연

    // 도메인별 설정
    // 이 사이트들은 팝업을 아예 표시하지 않습니다.
    const isPopupGloballyBlocked = location.hostname.includes('example.com'); // 여기에 팝업을 막을 사이트를 추가하세요

    // 이 사이트들은 전체 화면일 때만 팝업을 표시합니다. (예: missav.ws, missav.live)
    // tvwiki22.com은 이 목록에 포함시키지 않습니다. (팝업이 일반 화면에서도 뜨고, 정지를 목표로 하므로)
    const isFullscreenPopupOnlySite = location.hostname.includes('missav.ws') ||
                                      location.hostname.includes('missav.live');

    // YouTube, Chzzk, Naver TV와 같은 특정 사이트의 특수 처리 (비디오 선택 제외 등)
    const isYouTubeSite = location.hostname.includes('youtube.com') || location.hostname.includes('m.youtube.com');
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');

    // 특정 사이트에서 자동 음소거 해제 비활성화 (예: 네이버 스포츠 하이라이트 등)
    const AUTO_UNMUTE_SITES = ['sports.naver.com', 'm.sports.naver.com'];
    let wasClickedBeforeFullscreen = false; // 전체 화면 진입 전 사용자 클릭이 있었는지 여부

    // 비디오 재생 속도 및 볼륨
    let desiredPlaybackRate = 1.0;
    let desiredVolume = 1.0; // 0.0 ~ 1.0

    // ==================== 유틸리티 함수 ====================

    function debounce(func, delay) {
        let timeout;
        return function(...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), delay);
        };
    }

    function findAllVideosDeep() {
         // 현재 문서와 모든 쉐도우 DOM 내부의 비디오 요소를 찾습니다.
         const videosInMainDocument = Array.from(document.querySelectorAll('video, audio'));
         const videosInShadowDOMs = [];

         function findVideosInShadow(node) {
             if (node.shadowRoot) {
                 Array.from(node.shadowRoot.querySelectorAll('video, audio')).forEach(v => videosInShadowDOMs.push(v));
                 Array.from(node.shadowRoot.querySelectorAll('*')).forEach(findVideosInShadow);
             }
             Array.from(node.children).forEach(findVideosInShadow);
         }
         findVideosInShadow(document.body);

         return [...new Set([...videosInMainDocument, ...videosInShadowDOMs])];
    }


    function findPlayableVideos() {
        videos = findAllVideosDeep().filter(media => {
            // 특정 조건에 따라 필터링 (광고, 너무 작은 영상 등)
            // 1. YouTube Shorts, Chzzk 썸네일 영상, 숨겨진 영상 제외
            if (isYouTubeSite && (media.closest('ytd-reel-video-renderer') || media.closest('ytm-reel-player-renderer'))) return false;
            if (isChzzkSite && media.closest('.live_thumbnail_list_item')) return false;
            if (media.offsetParent === null && getComputedStyle(media).display === 'none') return false; // display: none 요소 제외
            if (media.clientWidth < 50 || media.clientHeight < 50) return false; // 너무 작은 비디오 제외 (광고 등)
            if (media.hasAttribute('aria-hidden') && media.getAttribute('aria-hidden') === 'true') return false; // aria-hidden=true 제외
            // 2. 컨트롤러가 없는 영상 중 자동재생/뮤트 상태이고, 소스 없는 영상 제외 (백그라운드 영상 등)
            if (!media.controls && media.muted && media.autoplay && !media.src && !media.querySelector('source[src]')) return false;
            // 3. 라이브 스트림 (duration이 Infinity)은 일단 포함
            // 4. src가 없거나 빈 문자열인 경우 제외 (일부러 늦게 로드되는 영상은 포함)
            if (!media.src && !media.currentSrc && media.readyState === 0) return false;

            // 5. 비디오가 로드되지 않았거나 에러 상태인 경우 제외
            if (media.readyState === 0 || media.error) return false;

            return true;
        });
    }

    function calculateIntersectionRatio(element) {
        const rect = element.getBoundingClientRect();
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        const intersectionTop = Math.max(0, rect.top);
        const intersectionBottom = Math.min(viewportHeight, rect.bottom);
        const intersectionLeft = Math.max(0, rect.left);
        const intersectionRight = Math.min(viewportWidth, rect.right);

        const intersectionArea = Math.max(0, intersectionRight - intersectionLeft) * Math.max(0, intersectionBottom - intersectionTop);
        const elementArea = rect.width * rect.height;

        return elementArea > 0 ? intersectionArea / elementArea : 0;
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const ratio = calculateIntersectionRatio(currentVideo);
        return ratio > 0.5; // 절반 이상 보이면 가시적이라고 판단
    }

    // ==================== 비디오 제어 함수 ====================

    function fixPlaybackRate(video, rate) {
        if (!video) return;
        video.playbackRate = rate;
        desiredPlaybackRate = rate; // desired 값 업데이트
    }

    function setNormalVolume(video, vol) {
        if (!video) return;
        video.volume = vol;
        desiredVolume = vol; // desired 값 업데이트
        video.muted = (vol === 0); // 볼륨이 0이면 음소거
    }

    // `selectAndControlVideo` 함수는 비디오를 선택하고 필요한 초기 제어를 수행합니다.
    function selectAndControlVideo(video) {
        if (currentVideo === video) return; // 이미 선택된 비디오면 아무것도 하지 않음

        if (currentVideo) {
            currentVideo.pause(); // 이전 비디오 일시 정지
            // console.log(`[VCP] Paused previous video.`);
        }

        currentVideo = video;
        // console.log(`[VCP] Selected new video:`, currentVideo);

        // 현재 선택된 비디오에 대한 초기 속성 설정
        // 수동으로 정지 상태가 아니라면 재생 시도
        if (!isManuallyPaused) {
            currentVideo.muted = isManuallyMuted; // 수동 음소거 상태로 설정
            if (!isManuallyMuted && currentVideo.volume === 0) {
                // 사용자가 음소거하지 않았는데 볼륨이 0이면 기본 볼륨으로 설정
                // 또는 desiredVolume이 0보다 크면 그 값으로 설정
                currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
            }
            // `desiredPlaybackRate`가 0.0이 아닌 경우에만 설정 (0.0은 무한 루프 가능성)
            if (desiredPlaybackRate > 0) {
                 currentVideo.playbackRate = desiredPlaybackRate;
            } else {
                 currentVideo.playbackRate = 1.0; // 기본값으로 복구
                 desiredPlaybackRate = 1.0;
            }

            // `autoplay` 속성이 true인 비디오는 `canplay` 이벤트에서 강제 재생을 시도하도록 설정
            // 이 시점에서는 즉시 재생 시도보다는 사용자 상호작용을 기다리는 것이 좋습니다.
            currentVideo.play().catch(e => {
                // console.warn("[VCP] Initial auto-play failed (user interaction may be required).", e);
                isManuallyPaused = true; // 자동 재생 실패 시 강제 일시 정지 상태로
                currentVideo.pause();
                updatePlayPauseButton(); // UI 업데이트
            });
        } else {
            currentVideo.pause();
            currentVideo.muted = isManuallyMuted;
            if (!isManuallyMuted && currentVideo.volume === 0) {
                currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
            }
             if (desiredPlaybackRate > 0) {
                 currentVideo.playbackRate = desiredPlaybackRate;
            } else {
                 currentVideo.playbackRate = 1.0; // 기본값으로 복구
                 desiredPlaybackRate = 1.0;
            }
        }

        // 비디오 속성 변경 시 팝업 UI 업데이트
        currentVideo.onplay = () => { updatePlayPauseButton(); resetPopupHideTimer(); };
        currentVideo.onpause = () => { updatePlayPauseButton(); resetPopupHideTimer(); };
        currentVideo.onvolumechange = () => { updateMuteSpeakButtons(); updatePopupSliders(); resetPopupHideTimer(); };
        currentVideo.onratechange = () => { updatePopupSliders(); resetPopupHideTimer(); };

        // 처음 선택된 비디오의 현재 상태를 desired 값으로 동기화
        desiredPlaybackRate = currentVideo.playbackRate;
        desiredVolume = currentVideo.volume;
        isManuallyMuted = currentVideo.muted;
        isManuallyPaused = currentVideo.paused; // 초기 상태 동기화
    }


    // ==================== 팝업 UI 생성 및 제어 ====================

    function createPopupElement() {
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.75);
            color: white;
            padding: 10px;
            border-radius: 8px;
            font-family: sans-serif;
            font-size: 14px;
            z-index: 2147483647; /* 최상위 z-index */
            display: none; /* 초기 숨김 */
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s ease-in-out;
            user-select: none;
            cursor: default;
            pointer-events: auto; /* 기본적으로 이벤트를 받도록 설정 */
            min-width: 220px;
            text-align: center;
        `;

        // TrustedHTML 오류를 피하기 위해 innerHTML 대신 createElement 및 appendChild 사용
        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.style.cssText = 'cursor: grab; padding: 5px; margin: -10px -10px 5px -10px; background: rgba(255, 255, 255, 0.1); border-radius: 8px 8px 0 0;';
        const versionSpan = document.createElement('span');
        versionSpan.style.fontSize = '10px';
        versionSpan.textContent = 'VCP 4.10.68';
        dragHandle.appendChild(versionSpan);
        popupElement.appendChild(dragHandle);

        const controlDiv = document.createElement('div');
        controlDiv.style.cssText = 'display: flex; justify-content: space-around; margin-bottom: 10px;';
        const createButton = (action, text) => {
            const btn = document.createElement('button');
            btn.setAttribute('data-action', action);
            btn.textContent = text;
            btn.style.cssText = `
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.2);
                color: white;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
                font-size: 13px;
                flex-grow: 1;
                margin: 0 5px;
            `;
            btn.onmouseover = () => btn.style.background = 'rgba(255, 255, 255, 0.2)';
            btn.onmouseout = () => btn.style.background = 'rgba(255, 255, 255, 0.1)';
            btn.onmousedown = () => btn.style.background = 'rgba(255, 255, 255, 0.3)';
            btn.onmouseup = () => btn.style.background = 'rgba(255, 255, 255, 0.2)';
            return btn;
        };

        const backwardBtn = createButton('backward', '« 10');
        const playPauseBtn = createButton('play-pause', 'Play/Pause');
        playPauseBtn.id = 'vcp-play-pause-button';
        const forwardBtn = createButton('forward', '10 »');

        controlDiv.appendChild(backwardBtn);
        controlDiv.appendChild(playPauseBtn);
        controlDiv.appendChild(forwardBtn);
        popupElement.appendChild(controlDiv);

        const sliderDiv = document.createElement('div');
        sliderDiv.style.cssText = 'display: flex; flex-direction: column; align-items: center; margin-bottom: 10px;';

        const createSlider = (id, labelText, min, max, step, value, displaySuffix) => {
            const label = document.createElement('label');
            label.htmlFor = id;
            label.style.cssText = 'width: 100%; display: flex; justify-content: space-between; align-items: center;' + (id === 'vcp-volume' ? 'margin-top: 5px;' : '');

            const labelSpan = document.createElement('span');
            labelSpan.textContent = labelText + ': ';
            label.appendChild(labelSpan);

            const displaySpan = document.createElement('span');
            displaySpan.id = id + '-display';
            displaySpan.textContent = value + (displaySuffix || '');
            label.appendChild(displaySpan);

            const input = document.createElement('input');
            input.type = 'range';
            input.id = id;
            input.min = min;
            input.max = max;
            input.step = step;
            input.value = value;
            input.style.cssText = 'flex-grow: 1; margin-left: 10px;';
            label.appendChild(input);
            return label;
        };

        const speedLabel = createSlider('vcp-speed', 'Speed', '0.1', '4.0', '0.1', '1.00');
        const volumeLabel = createSlider('vcp-volume', 'Volume', '0.0', '1.0', '0.01', '1.0', '%');

        sliderDiv.appendChild(speedLabel);
        sliderDiv.appendChild(volumeLabel);
        popupElement.appendChild(sliderDiv);

        const bottomControlDiv = document.createElement('div');
        bottomControlDiv.style.cssText = 'display: flex; justify-content: space-around;';

        const muteSpeakBtn = createButton('mute-toggle', 'Mute/Speak');
        muteSpeakBtn.id = 'vcp-mute-speak-button';
        const closeBtn = createButton('close', 'Close');

        bottomControlDiv.appendChild(muteSpeakBtn);
        bottomControlDiv.appendChild(closeBtn);
        popupElement.appendChild(bottomControlDiv);

        document.body.appendChild(popupElement);
    }

    function handleButtonClick(action) {
        if (!currentVideo) return;
        resetPopupHideTimer(); // 버튼 클릭 시 타이머 재설정

        switch (action) {
            case 'backward':
                currentVideo.currentTime = Math.max(0, currentVideo.currentTime - 10);
                break;
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = isManuallyMuted; // 수동 음소거 상태 복원
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                        currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }
                    currentVideo.play().catch(e => {
                        console.error("[VCP] Play failed (user interaction may be required):", e);
                        isManuallyPaused = true; // 재생 실패 시 다시 일시 정지 상태로
                        currentVideo.pause(); // 명시적으로 pause() 호출
                        updatePlayPauseButton(); // UI 업데이트
                    });
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                }
                updatePlayPauseButton();
                break;
            case 'forward':
                currentVideo.currentTime = Math.min(currentVideo.duration, currentVideo.currentTime + 10);
                break;
            case 'mute-toggle':
                isManuallyMuted = !currentVideo.muted;
                currentVideo.muted = isManuallyMuted;
                if (!isManuallyMuted && currentVideo.volume === 0) { // 음소거 해제 시 볼륨이 0이면 기본값 또는 desiredVolume으로
                    currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                } else if (isManuallyMuted && currentVideo.volume > 0) {
                     // 수동으로 음소거할 때, 볼륨이 0이 아니면 desiredVolume을 현재 볼륨으로 저장 (재생 시 복원용)
                    desiredVolume = currentVideo.volume;
                }
                updateMuteSpeakButtons();
                updatePopupSliders(); // 볼륨 슬라이더도 업데이트
                break;
            case 'close':
                hidePopup();
                currentVideo.pause(); // 팝업 닫을 때 현재 영상 일시 정지
                currentVideo = null;
                isManuallySelected = false;
                break;
        }
    }

    function updatePlayPauseButton() {
        const button = popupElement.querySelector('#vcp-play-pause-button');
        if (button && currentVideo) {
            button.textContent = currentVideo.paused ? 'Play' : 'Pause';
        }
    }

    function updateMuteSpeakButtons() {
        const button = popupElement.querySelector('#vcp-mute-speak-button');
        if (button && currentVideo) {
            button.textContent = currentVideo.muted ? 'Speak' : 'Mute';
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
            if (isPopupGloballyBlocked) { return; }
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            // 슬라이더 조작 시 desiredPlaybackRate를 업데이트하고 비디오에 적용
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2);
        });

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', () => {
            if (isPopupGloballyBlocked) { return; }
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            // 슬라이더 조작은 사용자의 의도이므로 isManuallyMuted를 vol === 0 에 따라 변경
            isManuallyMuted = (vol === 0);
            if (currentVideo) { setNormalVolume(currentVideo, vol); }
            volumeDisplay.textContent = Math.round(vol * 100);
            updateMuteSpeakButtons(); // 볼륨 조작 시 무음/소리 버튼 상태도 업데이트
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            if (isPopupGloballyBlocked) return;
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
                updatePopupPosition();
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
        dragHandle.addEventListener('touchstart', startDrag, { passive: false }); // 드래그 중에는 기본 스크롤 방지
        document.addEventListener('mousemove', dragPopup);
        document.addEventListener('touchmove', dragPopup, { passive: false }); // 드래그 중에는 기본 스크롤 방지
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        if (isPopupGloballyBlocked) {
            popupElement.style.setProperty('display', 'none', 'important');
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            return;
        }

        if (isVisible) {
            const styles = { display: 'block', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
        }
    }

    function showPopup() {
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
        setPopupVisibility(true);

        // --- 수정된 부분: 팝업이 표시될 때 현재 비디오를 강제로 일시 정지 ---
        if (currentVideo && !currentVideo.paused) {
            currentVideo.pause();
            isManuallyPaused = true; // 스크립트가 수동으로 일시 정지했음을 표시
            console.log("[VCP] Popup shown. Forcing current video to pause.");
        }
        // -----------------------------------------------------------------

        updatePopupPosition();  // 여기서 바로 영상 위치로 이동
        updatePlayPauseButton(); // 팝업 보일 때 버튼 상태 업데이트
        updateMuteSpeakButtons(); // 팝업 보일 때 버튼 상태 업데이트
        updatePopupSliders(); // 슬라이더 값도 정확히 동기화
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (isPopupDragging) return; // 팝업 드래그 중에는 타이머 재설정 안함
        if (isPopupGloballyBlocked) return;
        popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
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

        if (!popupElement || !currentVideo || isPopupDragging) {
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

    const selectVideoOnDocumentClick = debounce((e) => {
        // 이 함수는 팝업 표시 여부와 관계없이 비디오 선택 및 제어 로직을 항상 수행합니다.
        // 팝업 표시 여부는 아래 조건문에서 결정됩니다.
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

        let bestVideo = null;
        let maxScore = -1;
        let foundPlayingVideo = null;

        filteredVideos.forEach(video => {
            const rect = video.getBoundingClientRect();
            const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
            const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
            const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
            
            // Calculate distance from center of viewport to center of video
            const videoCenterX = rect.left + rect.width / 2;
            const videoCenterY = rect.top + rect.height / 2;
            const centerDist = Math.hypot(videoCenterX - centerX, videoCenterY - centerY);

            // Give higher score to videos closer to center and larger visible area
            // You might need to adjust the weights (e.g., 0.7 and 0.3)
            const areaWeight = 0.7;
            const centerWeight = 0.3;
            // Normalize visibleArea and inverse centerDist for scoring
            const normalizedArea = visibleArea / (window.innerWidth * window.innerHeight); // Max 1
            const normalizedCenterDist = 1 - (centerDist / Math.hypot(window.innerWidth/2, window.innerHeight/2)); // Max 1 (closer to center is higher)

            const score = (normalizedArea * areaWeight) + (normalizedCenterDist * centerWeight);

            if (score > maxScore) {
                maxScore = score;
                bestVideo = video;
            }

            if (!video.paused && video.duration > 0 && !video.ended) {
                foundPlayingVideo = video; // 이미 재생 중인 비디오가 있다면 우선적으로 선택
            }
        });

        // 이미 재생 중인 비디오가 있다면 최우선으로 선택
        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        }


        if (bestVideo && (maxScore > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo !== bestVideo) { // 다른 비디오를 선택한 경우
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                selectAndControlVideo(bestVideo); // 이 함수는 팝업을 띄우지 않고 비디오 선택 및 제어만 함

                // --- 팝업 표시 조건 강화 ---
                if (e instanceof Event) { // 클릭 이벤트일 경우
                    if (isFullscreenPopupOnlySite) { // missav.ws, missav.live 등의 특정 사이트일 경우
                        if (document.fullscreenElement) { // 그리고 현재 전체 화면일 때만 팝업 표시
                            isManuallySelected = true;
                            updatePopupPosition();
                            showPopup();
                            resetPopupHideTimer();
                        } else { // 특정 사이트이고 일반 화면일 경우 팝업 숨김 (강제 멈춤/재생은 팝업 없이 동작)
                            isManuallySelected = false;
                            hidePopup();
                        }
                    } else { // 특정 사이트가 아닐 경우 (기존 동작대로 일반 화면에서도 팝업 표시)
                        isManuallySelected = true;
                        updatePopupPosition();
                        showPopup();
                        resetPopupHideTimer();
                    }
                } else { // 클릭이 아닌 자동 감지 시 (스크롤, DOM 변경 등)
                    isManuallySelected = false;
                    hidePopup();
                }
                // --- 팝업 표시 조건 강화 끝 ---

            } else { // 이미 선택된 비디오가 그대로 유지될 때 (즉, 현재 선택된 비디오를 다시 클릭했을 때)
                // **핵심 변경: 현재 비디오를 다시 클릭했을 때 재생/일시 정지를 토글**
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = isManuallyMuted;
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                        currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }
                    currentVideo.play().catch(e => {
                        console.error("[VCP] Play failed on re-click (user interaction may be required):", e);
                        isManuallyPaused = true; // 재생 실패 시 다시 일시 정지 상태로
                        currentVideo.pause(); // 명시적으로 pause() 호출
                        updatePlayPauseButton(); // UI 업데이트
                    });
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                }

                // --- 팝업 표시 조건 강화 ---
                if (e) { // 사용자 클릭일 때만
                    if (isFullscreenPopupOnlySite) { // missav.ws, missav.live 등의 특정 사이트일 경우
                        if (document.fullscreenElement) { // 그리고 현재 전체 화면일 때만 팝업 표시
                             isManuallySelected = true;
                             updatePopupPosition();
                             showPopup();
                             resetPopupHideTimer();
                        } else { // 특정 사이트이고 일반 화면일 경우 팝업 숨김
                            if (popupElement && popupElement.style.display !== 'none') {
                               hidePopup();
                            }
                        }
                    } else { // 특정 사이트가 아닐 경우 (기존 동작)
                        isManuallySelected = true;
                        updatePopupPosition();
                        showPopup();
                        resetPopupHideTimer();
                    }
                } else { // 클릭이 아닌 자동 감지 시에는 팝업 숨김 (만약 이미 열려있다면)
                    if (popupElement && popupElement.style.display !== 'none') {
                       hidePopup();
                    }
                }
                // --- 팝업 표시 조건 강화 끝 ---
            }
        } else { // 적합한 비디오가 없을 때
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            isManuallySelected = false; // 선택된 비디오 없으니 초기화
            if (!isPopupDragging) {
                hidePopup();
            }
        }
    }, 50); // 디바운스 시간 추가

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
                if (!isPopupDragging) {
                    hidePopup();
                }
            }

            selectVideoOnDocumentClick(null); // 스크롤 시에도 비디오 선택 로직은 실행하되, 팝업은 자동으로 안 뜸
        }, 100);
    }

    function updateVideoList() {
        findPlayableVideos();
        // **강화된 currentVideo 유효성 검사**: DOM에서 사라졌거나, 다른 비디오가 감지되면 currentVideo를 재설정
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo) || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
            // console.log("[VCP] currentVideo is no longer valid or excluded. Re-selecting.");
            if (currentVideo) currentVideo.pause(); // 이전 비디오가 있다면 일시 정지
            currentVideo = null;
            hidePopup();
            // 여기서 selectVideoOnDocumentClick(null)을 바로 호출하지 않고,
            // DOMObserver나 checkVideoInterval에서 처리하도록 하여 무한 루프 방지
        }
    }

    // --- 비디오 상태 복원 로직 ---
    function restoreVideoState(video, time, pausedState, attempt) {
        if (!video || !document.body.contains(video)) {
            // console.log(`[VCP] Restore attempt ${attempt}: Video not found in DOM or invalid.`);
            return;
        }

        // console.log(`[VCP] Restore attempt ${attempt}: Target time=${time.toFixed(2)}, current=${video.currentTime.toFixed(2)}, paused=${pausedState}, actualPaused=${video.paused}`);

        // 시간 복원 시도
        if (Math.abs(video.currentTime - time) > 0.5) { // 0.5초 이상 차이 날 경우에만 재설정
            video.currentTime = time;
            // console.log(`[VCP] Set currentTime to ${time.toFixed(2)} (attempt ${attempt})`);
        }

        // 재생/일시 정지 상태 복원
        if (pausedState) { // 원래 일시 정지 상태였으면
            if (!video.paused) {
                video.pause();
                isManuallyPaused = true;
                // console.log(`[VCP] Forced pause (attempt ${attempt})`);
            }
        } else { // 원래 재생 중이었으면
            if (video.paused && !video.ended) { // 멈춰있고 끝난 상태가 아니면
                isManuallyPaused = false;
                video.play().catch(e => {
                    console.warn(`[VCP] Failed to auto-play (attempt ${attempt}). Please press play button manually if needed.`, e);
                    isManuallyPaused = true; // 자동 재생 실패 시 강제 일시 정지 상태로
                    video.pause();
                });
                // console.log(`[VCP] Forced play (attempt ${attempt})`);
            }
        }

        updatePlayPauseButton();
        // 볼륨과 뮤트 상태는 주기적인 checkVideoStatus에서 처리
    }

    // --- 전체 화면 복원 로직 관리 ---
    function startFullscreenRestoreSequence() {
        if (!currentVideo) return;

        fullscreenRestoreAttempts = 0;
        if (fullscreenRestoreTimeout) clearTimeout(fullscreenRestoreTimeout);

        const performRestore = () => {
            if (fullscreenRestoreAttempts < FULLSCREEN_RESTORE_MAX_ATTEMPTS) {
                restoreVideoState(currentVideo, savedCurrentTime, wasPausedBeforeFullscreen, fullscreenRestoreAttempts + 1);
                fullscreenRestoreAttempts++;
                fullscreenRestoreTimeout = setTimeout(performRestore, FULLSCREEN_RESTORE_INTERVAL_MS);
            } else {
                // console.log("[VCP] Fullscreen restore sequence completed.");
            }
        };

        // 첫 번째 시도는 약간의 지연 후 시작
        fullscreenRestoreTimeout = setTimeout(performRestore, FULLSCREEN_RESTORE_INITIAL_DELAY_MS);
    }

    function stopFullscreenRestoreSequence() {
        if (fullscreenRestoreTimeout) {
            clearTimeout(fullscreenRestoreTimeout);
            fullscreenRestoreTimeout = null;
        }
        fullscreenRestoreAttempts = 0;
    }

    function setupDOMObserver() {
        const observerConfig = { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'muted', 'volume', 'paused', 'controls', 'autoplay'] };
        const observerCallback = (mutationsList) => {
            let mediaChangeDetected = false;
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    // 비디오/오디오 요소 추가/제거 감지
                    if (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) ||
                        Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO')) {
                        mediaChangeDetected = true;
                        // console.log("[VCP] DOM: Video/Audio element added/removed.");
                        break;
                    }
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    // 비디오/오디오 속성 변경 감지 (src, paused 등)
                    // console.log(`[VCP] DOM: Video/Audio attribute changed: ${mutation.attributeName} on`, mutation.target);
                    mediaChangeDetected = true;
                    break;
                }
            }
            if (mediaChangeDetected) {
                updateVideoList(); // 비디오 목록 갱신
                selectVideoOnDocumentClick(null); // 비디오 선택 로직 재실행 (팝업 자동 안 뜸)
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
                // console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting popup state.`);
                lastUrl = currentUrl;
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                isManuallySelected = false; // SPA 이동 시 수동 선택 상태 초기화
                hidePopup();
                updateVideoList(); // 비디오 목록 새로 고침
                selectVideoOnDocumentClick(null); // 팝업은 자동으로 안 뜸
                updatePopupPosition();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
            { domain: 'chzzk.naver.com', selectors: ['.app_content', '.paged_list_area', '.live_thumbnail_list_item div[class*="video_area"]'] },
            { domain: 'youtube.com', selectors: ['ytd-app', 'html', 'body'] }, // 유튜브 전체 페이지 오버플로우
            { domain: 'm.youtube.com', selectors: ['ytm-app', 'html', 'body'] }, // 모바일 유튜브 추가
            { domain: 'missav.ws', selectors: ['html', 'body'] },
            { domain: 'missav.live', selectors: ['html', 'body'] },
            { domain: 'tvwiki22.com', selectors: ['html', 'body'] } // tvwiki22.com 에도 추가 (시각적 문제 방지)
        ];
        overflowFixSites.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selectors.forEach(el => {
                    document.querySelectorAll(el).forEach(e => {
                        if (e.style.overflow !== 'visible') {
                            e.style.overflow = 'visible';
                        }
                        if (e.style.overflowX !== 'visible') {
                            e.style.overflowX = 'visible';
                        }
                        if (e.style.overflowY !== 'visible') {
                            e.style.overflowY = 'visible';
                        }
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
                    // **핵심 변경: currentVideo의 play/pause 메서드가 원본으로 되돌아갔는지 확인 및 재정의**
                    if (video.play !== originalPlayMethod || !overwrittenPlayMethods.has(video)) {
                        // console.warn("[VCP] Detected currentVideo.play() overwritten by site. Re-applying custom play() method.");
                        video.play = function() {
                            if (this === currentVideo && isManuallyPaused) {
                                return Promise.resolve(); // 수동으로 일시 정지된 상태면 재생 명령 무시
                            }
                            return originalPlayMethod.apply(this, arguments);
                        };
                        overwrittenPlayMethods.add(video);
                    }
                    if (video.pause !== originalPauseMethod || !overwrittenPauseMethods.has(video)) {
                        // console.warn("[VCP] Detected currentVideo.pause() overwritten by site. Re-applying custom pause() method.");
                        video.pause = function() {
                            return originalPauseMethod.apply(this, arguments);
                        };
                        overwrittenPauseMethods.add(video);
                    }

                    // **강화된 제어 로직:**
                    if (isManuallyPaused) { // 사용자가 멈춤을 원하는데
                        if (!video.paused) { // 비디오가 재생 중이라면
                            // console.log("[VCP] Forcing pause for manually paused video.");
                            originalPauseMethod.apply(video); // 원본 pause 메서드로 강제 정지
                        }
                    } else { // 사용자가 재생을 원하는데 (혹은 수동으로 정지한 상태가 아닌데)
                        if (video.paused && !video.ended) { // 비디오가 멈춰있다면 (끝난 상태는 제외)
                            // console.log("[VCP] Forcing play for current video.");
                            originalPlayMethod.apply(video).catch(e => {
                                // console.warn("Forced play attempt failed:", e);
                            });
                        }
                    }

                    // 전체 화면 복귀 후에도 지속적으로 currentTime을 유지하도록 강제 동기화 (복원 시퀀스 중이 아닐 때만)
                    if (currentVideo && fullscreenRestoreTimeout === null && Math.abs(currentVideo.currentTime - savedCurrentTime) > 0.5 && !wasPausedBeforeFullscreen) {
                        // console.log(`[VCP] Steady state correction: currentTime from ${currentVideo.currentTime.toFixed(2)} to ${savedCurrentTime.toFixed(2)}`);
                        currentVideo.currentTime = savedCurrentTime;
                    }

                    // 배속/볼륨 동기화 및 유지
                    // desired 값과 실제 비디오 값이 다르면, 실제 비디오 값을 desired에 반영
                    if (video.playbackRate !== desiredPlaybackRate) {
                        desiredPlaybackRate = video.playbackRate;
                    }
                    // 현재 비디오의 실제 볼륨이 desiredVolume과 다르면 강제로 desiredVolume으로 설정
                    // isManuallyMuted 상태를 고려하여 muted 속성도 조절
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
            if (popupElement && popupElement.style.display !== 'none' && !isPopupDragging) {
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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.68');

        createPopupElement();
        // 팝업 요소가 생성되었는지 확인 후 이벤트 리스너 설정
        if (popupElement) {
            setupPopupEventListeners();
        }

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
            if (fsEl) { // 전체 화면 진입 시
                // 클릭으로 전체 화면이 되었고, 대상 사이트인 경우에만 팝업 표시 (최초 전체 화면 진입 시)
                if (isFullscreenPopupOnlySite && wasClickedBeforeFullscreen && currentVideo && (fsEl === currentVideo || fsEl.contains(currentVideo))) {
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                    wasClickedBeforeFullscreen = false; // 플래그 초기화
                }
                if (popupElement) {
                    // 전체 화면 요소 안에 팝업을 배치하여 전체 화면에서만 보이도록 합니다.
                    fsEl.appendChild(popupElement);
                    updatePopupPosition(); // 위치 다시 조정
                    resetPopupHideTimer();
                }

                // 전체 화면 진입 시 현재 비디오 상태 저장 및 복원 시퀀스 중지
                if (currentVideo) {
                    savedCurrentTime = currentVideo.currentTime;
                    wasPausedBeforeFullscreen = currentVideo.paused;
                    // console.log(`[VCP] Fullscreen entered. Saving state: time=${savedCurrentTime.toFixed(2)}, paused=${wasPausedBeforeFullscreen}`);
                }
                stopFullscreenRestoreSequence(); // 전체 화면 진입 시 복원 시퀀스 중단
            } else { // 전체 화면 종료 시
                if (popupElement) {
                    // 전체 화면에서 나오면 팝업을 다시 body로 이동시킵니다.
                    document.body.appendChild(popupElement);
                    updatePopupPosition(); // 위치 다시 조정
                    resetPopupHideTimer();
                }

                // **핵심 변경: 전체 화면 종료 시 비디오 상태 복원 시퀀스 시작**
                if (currentVideo) {
                    // console.log(`[VCP] Fullscreen exited. Initiating restore sequence for time=${savedCurrentTime.toFixed(2)}, paused=${wasPausedBeforeFullscreen}`);
                    startFullscreenRestoreSequence();
                } else {
                    // 전체 화면 종료 시점에 currentVideo가 없으면 다시 비디오를 찾도록 시도
                    // console.log("[VCP] Fullscreen exited, but no currentVideo. Re-selecting.");
                    selectVideoOnDocumentClick(null);
                }
            }
        });

        // 비디오 요소가 로드될 때마다 currentTime을 저장된 값으로 시도
        document.body.addEventListener('loadeddata', (event) => {
            const video = event.target;
            if (video === currentVideo && !wasPausedBeforeFullscreen) { // 현재 비디오이고 재생 중이던 상태였을 경우
                // console.log(`[VCP] Video loadeddata event detected for currentVideo. Attempting to set currentTime to ${savedCurrentTime.toFixed(2)}.`);
                if (Math.abs(video.currentTime - savedCurrentTime) > 0.5) {
                    video.currentTime = savedCurrentTime;
                }
                video.play().catch(e => {
                    console.warn("[VCP] Auto-play failed on loadeddata event (user interaction may be required).", e);
                });
            }
        }, true); // Use capture phase to catch events early

        // 비디오 재생 준비가 될 때마다 currentTime을 저장된 값으로 시도
        document.body.addEventListener('canplay', (event) => {
            const video = event.target;
            if (video === currentVideo && !wasPausedBeforeFullscreen && video.paused) { // 현재 비디오이고 재생 중이던 상태였고 현재 멈춰있다면
                // console.log(`[VCP] Video canplay event detected for currentVideo. Attempting to set currentTime to ${savedCurrentTime.toFixed(2)} and play.`);
                if (Math.abs(video.currentTime - savedCurrentTime) > 0.5) {
                    video.currentTime = savedCurrentTime;
                }
                video.play().catch(e => {
                    console.warn("[VCP] Auto-play failed on canplay event (user interaction may be required).", e);
                });
            }
        }, true); // Use capture phase to catch events early


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
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
            if (deltaY > 10) { // 10px 이상 이동하면 드래그로 간주
                touchMoved = true;
            }
        }, { passive: true });

        document.body.addEventListener('click', (e) => {
            // 팝업 내부 클릭 또는 드래그 중에는 무시
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }

            // 일반 클릭 발생 시 wasClickedBeforeFullscreen 플래그 설정
            if (e) {
                wasClickedBeforeFullscreen = true;
            }

            // 드래그 후 터치클릭 무시 로직은 유지
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoOnDocumentClick(e); // 팝업을 띄울지 말지는 이 함수 내부에서 결정됨
        }, true);

        document.body.addEventListener('touchend', (e) => {
            // 팝업 내부 클릭 또는 드래그 중에는 무시
            if (popupElement && e && popupElement.contains(e.target)) {
                resetPopupHideTimer();
                return;
            }

            // 터치 종료 발생 시 wasClickedBeforeFullscreen 플래그 설정
            if (e) {
                wasClickedBeforeFullscreen = true;
            }

            if (touchMoved) {
                touchMoved = false;
                return;
            }
            selectVideoOnDocumentClick(e); // 팝업을 띄울지 말지는 이 함수 내부에서 결정됨
        }, true);


        startCheckingVideoStatus();

        window.addEventListener('beforeunload', () => {
            // console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval);
            stopFullscreenRestoreSequence(); // 페이지 언로드 시 복원 시퀀스 중지
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
