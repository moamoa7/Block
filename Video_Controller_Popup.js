// ==UserScript==
// @name Video Controller Popup
// @namespace Violentmonkey Scripts
// @version 4.10.68
// @description Core video controls: popup on click, dynamic Play/Pause, speed, mute/unmute. Prevents other videos from auto-playing. Auto-unmutes on specified sites. Enhanced fullscreen exit stability and play button responsiveness for complex players. Auto-play blocking for specific sites has been rolled back.
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
    let isManuallySelected = false; // 사용자가 팝업을 클릭하여 비디오를 수동으로 선택했는지 여부
    const videoRateHandlers = new WeakMap();

    // **핵심 변경: 원본 play/pause 메서드 저장 및 재정의 추적**
    const originalPlayMethod = HTMLMediaElement.prototype.play;
    const originalPauseMethod = HTMLMediaElement.prototype.pause;
    const overwrittenPlayMethods = new WeakSet(); // play()를 재정의한 비디오를 추적
    const overwrittenPauseMethods = new WeakSet(); // pause()를 재정의한 비디오를 추적

    let checkVideoInterval = null;

    // --- 추가된 변수: 클릭에 의한 전체 화면 전환 감지 ---
    let wasClickedBeforeFullscreen = false; // 클릭이 발생한 직후 전체 화면 전환 여부를 판단할 플래그
    let savedCurrentTime = 0; // 전체 화면 진입 전 재생 시간을 저장할 변수
    let wasPausedBeforeFullscreen = true; // 전체 화면 진입 전 일시 정지 상태를 저장할 변수
    let fullscreenRestoreAttempts = 0; // 전체 화면 복원 시도 횟수
    let fullscreenRestoreTimeout = null; // 전체 화면 복원 타이머 ID

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 0.5초마다 비디오 상태 체크 (위치 갱신)
    const FULLSCREEN_RESTORE_INITIAL_DELAY_MS = 100; // 전체 화면 복귀 시 첫 상태 복원을 위한 지연 시간
    const FULLSCREEN_RESTORE_INTERVAL_MS = 100; // 반복 재시도 간격
    const FULLSCREEN_RESTORE_MAX_ATTEMPTS = 5; // 최대 재시도 횟수 (총 500ms 동안 시도)


    // 팝업을 차단하고 싶은 사이트의 도메인 (기존 기능)
    const SITE_POPUP_BLOCK_LIST = []; // 현재 비어있음

    // --- 새로 추가된: 자동 소리 재생을 허용할 사이트 목록 ---
    const AUTO_UNMUTE_SITES = [
        'youtube.com', // YouTube
        'twitch.tv', // Twitch
        'chzzk.naver.com', // 치지직
        'sooplive.co.kr', // SOOP (숲) 수정!
        'kick.com' // Kick
    ];

    // --- 새로 추가된: 일반 화면 클릭 시 팝업을 띄우지 않고, 전체 화면 시에만 팝업을 띄울 사이트 목록 ---
    const FULLSCREEN_POPUP_ONLY_SITES = [
        'missav.ws',
        'missav.live'
    ];

    // **핵심 변경: 자동 재생을 강제 정지하던 사이트 목록에서 missav.ws와 missav.live 제거**
    // 이제 이 목록은 비어있습니다.
    const FORCE_PAUSE_ON_SELECT_SITES = [
        // 'missav.ws', // 롤백됨
        // 'missav.live' // 롤백됨
    ];

    // 현재 사이트가 전역적으로 팝업이 차단되는지 확인
    const isPopupGloballyBlocked = SITE_POPUP_BLOCK_LIST.some(blockRule => {
        const isDomainMatch = location.hostname.includes(blockRule.domain);
        if (!isDomainMatch) return false;

        if (blockRule.pathIncludes) {
            return location.pathname.includes(blockRule.pathIncludes);
        }
        return true;
    });

    // 현재 사이트가 lazy src를 사용하는 사이트인지 확인
    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));
    // 치지직 사이트인지 확인
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');
    // 유튜브 사이트인지 확인 (youtube.com, m.youtube.com 등 포함)
    const isYouTubeSite = location.hostname.includes('youtube.com');

    // 현재 사이트가 AUTO_UNMUTE_SITES에 포함되는지 확인하는 플래그
    const isAutoUnmuteSite = AUTO_UNMUTE_SITES.some(domain => location.hostname.includes(domain));

    // 현재 사이트가 FULLSCREEN_POPUP_ONLY_SITES에 포함되는지 확인하는 플래그
    const isFullscreenPopupOnlySite = FULLSCREEN_POPUP_ONLY_SITES.some(domain => location.hostname.includes(domain));

    // **핵심 변경: 현재 사이트가 FORCE_PAUSE_ON_SELECT_SITES에 포함되는지 확인하는 플래그 (이제 항상 false)**
    const isForcePauseOnSelectSite = FORCE_PAUSE_ON_SELECT_SITES.some(domain => location.hostname.includes(domain));

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        return Array.from(root.querySelectorAll('video, audio'));
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        // dataset.src가 있으면 src로 설정 (lazy src 사이트 제외)
        if (!isLazySrcBlockedSite) found.forEach(v => { if (!v.src && v.dataset && v.dataset.src) v.src = v.dataset.src; });
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;

            // 치지직 미리보기는 팝업 선택에서 제외 (소리만 제어)
            if (isChzzkSite && v.closest('.live_thumbnail_list_item')) {
                return true; // 일단 playable로는 간주하지만, 이후 selectVideoOnDocumentClick에서 필터링됨
            }
            // 유튜브 Shorts, 쇼츠 비디오는 컨트롤에서 제외
            if (isYouTubeSite && (v.closest('ytd-reel-video-renderer') || v.closest('ytm-reel-player-renderer'))) {
                return false;
            }

            return isVisible && isReasonableSize && hasMedia;
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
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO';

        return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
    }

    function selectAndControlVideo(videoToControl) {
        if (isPopupGloballyBlocked) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; }
            hidePopup();
            return;
        }

        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        if (isChzzkSite && videoToControl.closest('.live_thumbnail_list_item')) {
            hidePopup(); // 치지직 미리보기는 팝업 뜨지 않음
            return;
        }

        // **핵심 변경: 기존 currentVideo가 있고, 새로운 videoToControl과 다를 경우 원본 play()/pause() 메서드 복원**
        if (currentVideo && currentVideo !== videoToControl) {
            if (overwrittenPlayMethods.has(currentVideo)) {
                currentVideo.play = originalPlayMethod;
                overwrittenPlayMethods.delete(currentVideo);
            }
            if (overwrittenPauseMethods.has(currentVideo)) {
                currentVideo.pause = originalPauseMethod;
                overwrittenPauseMethods.delete(currentVideo);
            }
        }

        // 모든 감지된 비디오에 대해 처리
        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
                // 치지직 미리보기는 소리만 강제 음소거
                if (isChzzkSite && video.closest('.live_thumbnail_list_item')) {
                    if (!video.paused || !video.muted || video.volume > 0) {
                        // 미리보기는 play()를 막습니다.
                        if (!overwrittenPlayMethods.has(video)) {
                            video.play = () => Promise.resolve();
                            overwrittenPlayMethods.add(video);
                        }
                        video.pause();
                        video.muted = true;
                        video.volume = 0;
                        video.currentTime = 0;
                    }
                    return;
                }

                // 현재 비디오가 아닌 다른 비디오는 무조건 일시 정지, 음소거, 볼륨 0, 현재 시간 0으로 초기화
                // **핵심 변경: 원본 play()/pause() 메서드 복원**
                if (overwrittenPlayMethods.has(video)) {
                    video.play = originalPlayMethod;
                    overwrittenPlayMethods.delete(video);
                }
                if (overwrittenPauseMethods.has(video)) {
                    video.pause = originalPauseMethod;
                    overwrittenPauseMethods.delete(video);
                }

                if (!video.paused) {
                    video.pause();
                }
                video.muted = true;
                video.volume = 0;
                video.currentTime = 0;
            } else { // videoToControl (새로 선택된 비디오)
                // 현재 비디오가 아닌 경우에만 설정
                if (currentVideo !== videoToControl) {
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;

                    // --- 핵심 변경: 사이트별 자동 소리/무음 설정 ---
                    if (isAutoUnmuteSite) {
                        videoToControl.muted = false; // 소리 허용 사이트는 무음 해제
                        videoToControl.volume = 1.0; // 볼륨 100%
                    } else {
                        videoToControl.muted = true; // 그 외 사이트는 무조건 무음으로 시작
                        videoToControl.volume = 0; // 무음 시 볼륨 0
                    }
                    // --- 핵심 변경 끝 ---

                    // **핵심 변경: play()/pause() 메서드 재정의 로직 롤백 (FORCE_PAUSE_ON_SELECT_SITES에 대한 조건부 로직 제거)**
                    // 이제 모든 비디오에 대해 원본 play/pause 메서드를 호출하거나, 재정의를 완전히 제거합니다.
                    if (overwrittenPlayMethods.has(videoToControl)) {
                        videoToControl.play = originalPlayMethod;
                        overwrittenPlayMethods.delete(videoToControl);
                    }
                    if (overwrittenPauseMethods.has(videoToControl)) {
                        videoToControl.pause = originalPauseMethod;
                        overwrittenPauseMethods.delete(videoToControl);
                    }

                    // **핵심 변경: 자동 재생 시도 로직 롤백 (FORCE_PAUSE_ON_SELECT_SITES 조건 제거)**
                    videoToControl.play().catch(e => {
                        // console.warn("Autoplay/Play on select failed:", e);
                    });
                }
            }
        });

        // 최종적으로 currentVideo 설정 및 팝업 슬라이더 업데이트 (이 함수는 팝업을 띄우지 않음)
        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false; // 새 비디오 선택 시 수동 정지 상태 초기화
            desiredPlaybackRate = currentVideo.playbackRate;

            // --- 핵심 변경: desiredVolume 및 isManuallyMuted 초기화 로직 ---
            desiredVolume = 1.0; // 모든 경우에 100%를 목표 볼륨으로 설정
            isManuallyMuted = !isAutoUnmuteSite; // 소리 허용 사이트가 아니면 초기에는 스크립트에 의해 음소거된 상태
            // --- 핵심 변경 끝 ---
            
            // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES에 있다면, 선택과 동시에 isManuallyPaused를 true로 설정 (이 로직 제거)**
            // if (isForcePauseOnSelectSite) {
            //     isManuallyPaused = true;
            // }
        }

        // 배속 및 볼륨 적용 (desired 값으로 강제)
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume); // 이 시점에서는 위 설정에 따라 volume=1.0, muted 상태가 결정됨

        updatePopupSliders(); // 팝업 슬라이더 UI 업데이트
        updatePlayPauseButton(); // 재생/멈춤 버튼 텍스트 업데이트
        updateMuteSpeakButtons(); // 무음/소리 버튼 텍스트 업데이트
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        // desiredPlaybackRate는 현재 비디오의 실제 재생 속도를 추적
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            // 외부에서 재생 속도가 변경될 경우 desiredPlaybackRate도 업데이트
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };

        // UI를 통해 설정하는 경우에만 비디오의 playbackRate를 변경
        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
        updatePopupSliders(); // 슬라이더와 디스플레이 업데이트
    }

    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        // desiredVolume은 현재 비디오의 실제 볼륨을 추적
        desiredVolume = vol;

        // UI를 통해 설정하는 경우에만 비디오의 볼륨과 뮤트 상태를 변경
        // 여기서 바로 video.volume을 desiredVolume으로 설정하여 일관성을 유지
        video.volume = Math.max(0, Math.min(1.0, desiredVolume));

        // 사용자가 수동으로 뮤트했거나, 볼륨이 0일 경우 뮤트 상태를 유지
        // isManuallyMuted는 '무음'/'소리' 버튼 클릭 시에만 변경됨
        video.muted = isManuallyMuted || (desiredVolume === 0);

        updatePopupSliders(); // 슬라이더와 디스플레이 업데이트
        updateMuteSpeakButtons(); // 무음/소리 버튼 텍스트 업데이트
    }

    // --- Popup UI Functions ---
    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed;
            /* 중앙 정렬 제거 */
            /* top: 50%; left: 50%; transform: translate(-50%, -50%); */
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
            display: none; opacity: 0; transition: opacity 0.3s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: 440px; /* 4버튼 한 줄을 위한 충분한 너비 확보 */
            min-width: 440px; /* 최소 너비도 설정 */
            overflow: hidden; text-align: center; pointer-events: auto;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            font-weight: bold; margin-bottom: 8px; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
        `;
        popupElement.appendChild(dragHandle);

        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = 'padding: 10px;';

        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: flex; /* Flexbox 사용하여 버튼 정렬 */
            flex-wrap: nowrap; /* 버튼이 줄바꿈되지 않도록 강제 */
            gap: 8px; /* 버튼 간격 조정 */
            justify-content: space-around; /* 버튼들을 공간 분할하여 정렬 */
            align-items: center; margin-bottom: 10px;
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px; /* 패딩 조정 */
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: nowrap; /* 텍스트 줄바꿈 방지 */
            min-width: 90px; /* 각 버튼의 최소 너비 설정 (4개 버튼에 맞게 조정) */
            flex-grow: 1; /* 남은 공간을 균등하게 차지하도록 */
            text-align: center; font-size: 15px; /* 폰트 크기 약간 줄임 */
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
        buttonSection.appendChild(muteBtn); // 무음 버튼 추가
        buttonSection.appendChild(speakBtn); // 소리 버튼 추가
        contentContainer.appendChild(buttonSection);

        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.marginBottom = '10px';

        const speedLabel = document.createElement('label');
        speedLabel.htmlFor = 'vcp-speed';
        speedLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #ccc; font-size: 16px;';
        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedLabel.textContent = '배속 조절: ';
        speedLabel.appendChild(speedDisplay);
        speedLabel.appendChild(document.createTextNode('x'));

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1'; // 스텝 미세 조정
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
        volumeLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #ccc; font-size: 16px;';
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
        volumeInput.max = '1.0';
        volumeInput.step = '0.01';
        volumeInput.value = '1.0';
        volumeInput.style.cssText = 'width: 100%; cursor: pointer;';

        volumeSection.appendChild(volumeLabel);
        volumeSection.appendChild(volumeInput);
        contentContainer.appendChild(volumeSection);

        popupElement.appendChild(contentContainer);
        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    // 재생/멈춤 버튼 텍스트 업데이트
    function updatePlayPauseButton() {
        const playPauseBtn = popupElement.querySelector('[data-action="play-pause"]');
        if (playPauseBtn && currentVideo) {
            playPauseBtn.textContent = currentVideo.paused ? '재생' : '멈춤';
        } else if (playPauseBtn) {
             playPauseBtn.textContent = '재생/멈춤'; // 비디오 없으면 기본 텍스트
        }
    }

    // 무음/소리 버튼 상태 업데이트
    function updateMuteSpeakButtons() {
        const muteBtn = popupElement.querySelector('[data-action="mute"]');
        const speakBtn = popupElement.querySelector('[data-action="speak"]');
        if (muteBtn && speakBtn && currentVideo) {
            if (currentVideo.muted) {
                muteBtn.style.backgroundColor = '#555'; // 활성 색상
                speakBtn.style.backgroundColor = '#333'; // 비활성 색상
            } else {
                muteBtn.style.backgroundColor = '#333'; // 비활성 색상
                speakBtn.style.backgroundColor = '#555'; // 활성 색상
            }
        } else if (muteBtn && speakBtn) {
            muteBtn.style.backgroundColor = '#333'; // 비디오 없으면 기본 색상
            speakBtn.style.backgroundColor = '#333'; // 비디오 없으면 기본 색상
        }
    }

    function handleButtonClick(action) {
        if (!currentVideo) { return; }
        if (isPopupGloballyBlocked) { return; }
        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES인 경우 재생 시도하지 않음 로직 제거**
                    isManuallyPaused = false; // 수동 정지 해제
                    // 재생 시 음소거 상태를 사용자가 마지막으로 설정한 상태로 복원
                    currentVideo.muted = isManuallyMuted;
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                         currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }

                    // **핵심 변경:** 이제 `originalPlayMethod`를 직접 호출하여 재생 시도
                    originalPlayMethod.apply(currentVideo).catch(e => {
                        console.error("[VCP] Play failed when clicking button (user interaction may be required):", e);
                        isManuallyPaused = true; // 재생 실패 시 다시 일시 정지 상태로
                        originalPauseMethod.apply(currentVideo); // 명시적으로 pause() 호출
                    });
                } else {
                    isManuallyPaused = true; // 수동 정지 설정
                    // **핵심 변경:** `originalPauseMethod`를 직접 호출하여 일시 정지 시도
                    originalPauseMethod.apply(currentVideo);
                }
                updatePlayPauseButton(); // 버튼 텍스트 업데이트
                updateMuteSpeakButtons(); // 음소거 상태 변경 가능성이 있으므로 업데이트
                updatePopupSliders(); // 볼륨 슬라이더도 업데이트
                break;
            case 'reset-speed': // 배속 1x로 초기화
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0);
                break;
            case 'mute': // 무음 설정
                if (!currentVideo.muted) { // 이미 뮤트 상태가 아닐 경우에만 뮤트
                    isManuallyMuted = true;
                    setNormalVolume(currentVideo, 0); // 볼륨을 0으로 설정하여 무음화
                }
                updateMuteSpeakButtons(); // 버튼 상태 업데이트
                updatePopupSliders(); // 볼륨 슬라이더도 업데이트
                break;
            case 'speak': // 소리 설정 (무음 해제 및 볼륨 100%로 설정)
                // 현재 음소거 상태와 관계없이, 음소거 해제 및 볼륨 100%로 설정
                isManuallyMuted = false; // 사용자가 '소리'를 원함을 표시
                setNormalVolume(currentVideo, 1.0); // 무조건 100%로 설정
                updateMuteSpeakButtons(); // 버튼 상태 업데이트
                updatePopupSliders(); // 볼륨 슬라이더도 업데이트
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

    function selectVideoOnDocumentClick(e) {
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

        if (bestVideo && (maxIntersectionRatio > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
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
                // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES 대응 로직 제거**
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = isManuallyMuted;
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                         currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }
                    originalPlayMethod.apply(currentVideo).catch(e => { // 원본 play() 메서드 호출
                        console.error("[VCP] Play failed on re-click (user interaction may be required):", e);
                        isManuallyPaused = true; // 재생 실패 시 다시 일시 정지 상태로
                        originalPauseMethod.apply(currentVideo); // 명시적으로 pause() 호출
                    });
                } else {
                    isManuallyPaused = true;
                    originalPauseMethod.apply(currentVideo); // 원본 pause() 메서드 호출
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
        // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES인 경우 재생 시도하지 않음 로직 제거**
        if (pausedState) { // 원래 일시 정지 상태였으면
            if (!video.paused) {
                originalPauseMethod.apply(video); // 원본 pause 메서드로 강제 정지
                isManuallyPaused = true;
                // console.log(`[VCP] Forced pause (attempt ${attempt})`);
            }
        } else { // 원래 재생 중이었으면
            if (video.paused && !video.ended) { // 멈춰있고 끝난 상태가 아니면
                isManuallyPaused = false;
                originalPlayMethod.apply(video).catch(e => { // 원본 play 메서드로 재생 시도
                    console.warn(`[VCP] Failed to auto-play (attempt ${attempt}). Please press play button manually if needed.`, e);
                    isManuallyPaused = true; // 자동 재생 실패 시 강제 일시 정지 상태로
                    originalPauseMethod.apply(video);
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
            { domain: 'missav.ws', selectors: ['html', 'body'] }, // missav.ws 에도 추가
            { domain: 'missav.live', selectors: ['html', 'body'] } // missav.live 에도 추가
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
                    // **핵심 변경: currentVideo의 play/pause 메서드가 원본으로 되돌아갔는지 확인 및 재정의 로직 롤백**
                    // 이제 play/pause 메서드를 재정의하지 않고, 항상 원본 메서드를 사용합니다.
                    if (overwrittenPlayMethods.has(video)) {
                        video.play = originalPlayMethod;
                        overwrittenPlayMethods.delete(video);
                    }
                    if (overwrittenPauseMethods.has(video)) {
                        video.pause = originalPauseMethod;
                        overwrittenPauseMethods.delete(video);
                    }


                    // **강화된 제어 로직:**
                    if (isManuallyPaused) { // 사용자가 멈춤을 원하는데
                        if (!video.paused) { // 비디오가 재생 중이라면
                            // console.log("[VCP] Forcing pause for manually paused video.");
                            originalPauseMethod.apply(video); // 원본 pause 메서드로 강제 정지
                        }
                    } else { // 사용자가 재생을 원하는데 (혹은 수동으로 정지한 상태가 아닌데)
                        if (video.paused && !video.ended) { // 비디오가 멈춰있다면 (끝난 상태는 제외)
                            // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES인 경우 재생 시도하지 않음 로직 제거**
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

                // **핵심 변경: 전체 화면 종료 시 비디오 상태 복원 시퀀스 시작 (FORCE_PAUSE_ON_SELECT_SITES 조건 제거)**
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
                // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES인 경우 재생 시도하지 않음 로직 제거**
                // console.log(`[VCP] Video loadeddata event detected for currentVideo. Attempting to set currentTime to ${savedCurrentTime.toFixed(2)}.`);
                if (Math.abs(video.currentTime - savedCurrentTime) > 0.5) {
                    video.currentTime = savedCurrentTime;
                }
                originalPlayMethod.apply(video).catch(e => { // 원본 play() 메서드 호출
                    console.warn("[VCP] Auto-play failed on loadeddata event (user interaction may be required).", e);
                });
            }
        }, true); // Use capture phase to catch events early

        // 비디오 재생 준비가 될 때마다 currentTime을 저장된 값으로 시도
        document.body.addEventListener('canplay', (event) => {
            const video = event.target;
            if (video === currentVideo && !wasPausedBeforeFullscreen && video.paused) { // 현재 비디오이고 재생 중이던 상태였고 현재 멈춰있다면
                // **핵심 변경: FORCE_PAUSE_ON_SELECT_SITES인 경우 재생 시도하지 않음 로직 제거**
                // console.log(`[VCP] Video canplay event detected for currentVideo. Attempting to set currentTime to ${savedCurrentTime.toFixed(2)} and play.`);
                if (Math.abs(video.currentTime - savedCurrentTime) > 0.5) {
                    video.currentTime = savedCurrentTime;
                }
                originalPlayMethod.apply(video).catch(e => { // 원본 play() 메서드 호출
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
