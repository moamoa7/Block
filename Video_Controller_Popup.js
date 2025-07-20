// ==UserScript==
// @name Video Controller Popup (V4.10.61: Missav 핫픽스 V4)
// @namespace Violentmonkey Scripts
// @version 4.10.61_SiteSpecificVolume_Updated_FixedMobileDrag_MissavPopupFix_V4
// @description Core video controls with streamlined UI. Specific sites auto-play with sound, others muted. Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Missav sites prevent popup on direct video player click in normal mode.
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
    let checkVideoInterval = null;
    const originalPlayMethods = new WeakMap(); // 원본 play() 메서드를 저장
    const videoClickHandlers = new WeakMap(); // 각 비디오에 붙은 클릭 핸들러를 저장

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 0.5초마다 비디오 상태 체크 (위치 갱신)

    // 팝업을 차단하고 싶은 사이트의 도메인 (전역 차단)
    const SITE_POPUP_BLOCK_LIST = []; // 현재 비어있음

    // --- 자동 소리 재생을 허용할 사이트 목록 (도메인 포함 여부 확인) ---
    const AUTO_UNMUTE_SITES = [
        'youtube.com', // YouTube
        'twitch.tv', // Twitch
        'chzzk.naver.com', // 치지직
        'soop.tv', // SOOP (숲)
        'kick.com' // Kick
    ];

    // --- Missav 사이트 팝업 제한 목록 (핵심 타겟) ---
    const MISSAV_POPUP_RESTRICTED_SITES = [
        'missav.ws',
        'missav.live'
    ];
    // 이 변수는 스크립트 로드 시점에 결정되며, 이후 변경되지 않습니다.
    const isMissavRestrictedSite = MISSAV_POPUP_RESTRICTED_SITES.some(site => location.hostname.includes(site));


    const isPopupGloballyBlocked = SITE_POPUP_BLOCK_LIST.some(blockRule => {
        const isDomainMatch = location.hostname.includes(blockRule.domain);
        if (!isDomainMatch) return false;

        if (blockRule.pathIncludes) {
            return location.pathname.includes(blockRule.pathIncludes);
        }
        return true;
    });

    const isLazySrcBlockedSite = MISSAV_POPUP_RESTRICTED_SITES.some(site => location.hostname.includes(site)); // Missav는 lazy-src를 사용하므로
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');
    const isYouTubeSite = location.hostname.includes('youtube.com'); // 유튜브 및 유튜브 뮤직 포함

    // 현재 사이트가 AUTO_UNMUTE_SITES에 포함되는지 확인하는 플래그
    const isAutoUnmuteSite = AUTO_UNMUTE_SITES.some(domain => location.hostname.includes(domain));


    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        return Array.from(root.querySelectorAll('video, audio'));
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        // dataset.src가 있으면 src로 설정 (Missav 같은 곳에서 동적 로딩 처리)
        if (isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }

        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused; // 오디오 태그이거나 재생 중이면 크기 무시
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;

            // 치지직 미리보기는 팝업 선택에서 제외 (소리만 제어)
            if (isChzzkSite && v.closest('.live_thumbnail_list_item')) {
                return true; // 일단 playable로는 간주하지만, 이후 팝업 제어에서 필터링됨
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

    // --- Missav 핫픽스를 위한 새로운 함수: 각 비디오 요소에 직접 클릭 이벤트 리스너 추가 ---
    function attachVideoEventListeners(video) {
        if (videoClickHandlers.has(video)) {
            // 이미 핸들러가 있다면 제거하고 다시 추가 (혹시 모를 중복 방지)
            video.removeEventListener('click', videoClickHandlers.get(video), true);
        }

        const handler = (event) => {
            if (isPopupGloballyBlocked) {
                return;
            }

            // Missav 사이트에서 비디오 플레이어 직접 클릭 시 팝업 방지 (전체 화면이 아닐 때)
            if (isMissavRestrictedSite && !document.fullscreenElement) {
                console.log("[VCP] Missav: Video player clicked in normal mode. Preventing popup.");
                event.preventDefault(); // 기본 재생/일시정지 등의 동작 방지
                event.stopPropagation(); // 상위 DOM으로 이벤트 전파 방지
                hidePopup(); // 혹시 열려있는 팝업이 있다면 숨김
                return; // 이후 로직 실행 중단
            }

            // Missav 사이트가 아니거나, 전체 화면 모드일 경우 (또는 일반 사이트)
            // 비디오를 현재 선택된 비디오로 설정하고 팝업 표시
            if (currentVideo !== video) {
                selectAndControlVideo(video); // 비디오 제어
            }
            isManuallySelected = true; // 사용자 수동 선택 플래그
            // 이제 팝업을 바로 띄우지 않고 handleGlobalClick에서 최종 결정
            // showPopup(); // 직접 showPopup 호출 대신 handleGlobalClick으로 위임
            // resetPopupHideTimer(); // handleGlobalClick에서 호출
            // updatePopupPosition(); // handleGlobalClick에서 호출
        };

        video.addEventListener('click', handler, true); // 캡처 단계에서 이벤트 처리
        videoClickHandlers.set(video, handler);
    }
    // --- Missav 핫픽스 끝 ---

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

        // 기존 currentVideo가 있고, 새로운 videoToControl과 다를 경우 원래 play() 메서드 복원
        if (currentVideo && currentVideo !== videoToControl && originalPlayMethods.has(currentVideo)) {
            currentVideo.play = originalPlayMethods.get(currentVideo);
            originalPlayMethods.delete(currentVideo);
        }

        // 모든 감지된 비디오에 대해 처리
        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
                // 치지직 미리보기는 소리만 강제 음소거
                if (isChzzkSite && video.closest('.live_thumbnail_list_item')) {
                    if (!video.paused || !video.muted || video.volume > 0) {
                            if (!originalPlayMethods.has(video)) {
                                originalPlayMethods.set(video, video.play);
                                video.play = function() {
                                    return Promise.resolve(); // play() 호출 블록
                                };
                            }
                            video.pause();
                            video.muted = true;
                            video.volume = 0;
                            video.currentTime = 0;
                    }
                    return;
                }

                // 현재 비디오가 아닌 다른 비디오는 무조건 일시 정지, 음소거, 볼륨 0, 현재 시간 0으로 초기화
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
            } else { // videoToControl (새로 선택된 비디오)
                // 현재 비디오가 아닌 경우에만 설정
                if (currentVideo !== videoToControl) {
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;

                    // --- 핵심 변경: 사이트별 자동 소리/무음 설정 ---
                    if (isAutoUnmuteSite) {
                        videoToControl.muted = false; // 소리 허용 사이트는 무음 해제
                        videoToControl.volume = 1.0; // 볼륨 100%
                        console.log('[VCP] Video selected. Initiating autoplay with sound (100%).');
                    } else {
                        videoToControl.muted = true; // 그 외 사이트는 무조건 무음으로 시작
                        videoToControl.volume = 0; // 무음 시 볼륨 0
                        console.log('[VCP] Video selected. Initiating muted autoplay.');
                    }
                    // --- 핵심 변경 끝 ---

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
            background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px;
            padding: 0; color: white; font-family: sans-serif; z-index: 2147483647;
            display: none; opacity: 0; transition: opacity 0.3s;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            width: 440px;
            min-width: 440px;
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
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            justify-content: space-around;
            align-items: center; margin-bottom: 10px;
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: nowrap;
            min-width: 90px;
            flex-grow: 1;
            text-align: center; font-size: 15px;
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
        speedInput.step = '0.1';
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
                    isManuallyPaused = false; // 수동 정지 해제
                    // 재생 시 음소거 상태를 사용자가 마지막으로 설정한 상태로 복원
                    currentVideo.muted = isManuallyMuted;
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                             currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }

                    currentVideo.play().catch(e => console.error("Play failed:", e));
                } else {
                    isManuallyPaused = true; // 수동 정지 설정
                    currentVideo.pause();
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
        updatePopupPosition();
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (isPopupGloballyBlocked) return;
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
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

    // --- 문서 전체 클릭 이벤트 핸들러 ---
    function handleGlobalClick(e) {
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
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
        }

        if (bestVideo && (maxIntersectionRatio > 0 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo !== bestVideo) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                selectAndControlVideo(bestVideo);
            }

            // --- 팝업 표시 조건 강화 ---
            // `e`가 클릭 이벤트일 때만 팝업을 수동으로 표시할지 결정합니다.
            // 스크롤이나 DOM 변경 등으로 인한 `handleGlobalClick` 호출 시에는 `e`가 없을 수 있습니다.
            if (e instanceof Event) {
                if (isMissavRestrictedSite) { // Missav.ws, Missav.live 등의 특정 사이트일 경우
                    if (document.fullscreenElement) { // 그리고 현재 전체 화면일 때만 팝업 표시
                        isManuallySelected = true;
                        updatePopupPosition();
                        showPopup();
                        resetPopupHideTimer();
                    } else { // 특정 사이트이고 일반 화면일 경우 팝업 숨김
                        isManuallySelected = false; // 수동 선택 해제
                        hidePopup();
                    }
                } else { // 특정 사이트가 아닐 경우 (기존 동작대로 일반 화면에서도 팝업 표시)
                    isManuallySelected = true;
                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                }
            } else { // 클릭이 아닌 자동 감지 시 (스크롤, DOM 변경 등)
                isManuallySelected = false; // 자동 감지이므로 수동 선택 아님
                // 팝업이 이미 열려 있다면 숨깁니다.
                if (popupElement && popupElement.style.display !== 'none') {
                    hidePopup();
                }
            }
            // --- 팝업 표시 조건 강화 끝 ---

        } else { // 적합한 비디오가 없을 때
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            isManuallySelected = false;
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

            // 스크롤 시에는 팝업을 자동으로 띄우지 않습니다. (가상의 빈 공간 클릭 이벤트 전달, `e`는 null)
            handleGlobalClick(null); // e를 null로 전달하여 자동 감지임을 알립니다.
        }, 100);
    }

    function updateVideoList() {
        const currentVideos = findPlayableVideos();
        currentVideos.forEach(video => {
            if (!videoClickHandlers.has(video)) {
                attachVideoEventListeners(video);
            }
        });

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
                handleGlobalClick(null); // DOM 변경 시 팝업은 자동으로 안 뜸
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
                isManuallySelected = false;
                hidePopup();
                updateVideoList();
                handleGlobalClick(null); // SPA 이동 시 팝업은 자동으로 안 뜸
                updatePopupPosition();
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
            { domain: 'chzzk.naver.com', selectors: ['.app_content', '.paged_list_area', '.live_thumbnail_list_item div[class*="video_area"]'] },
            { domain: 'youtube.com', selectors: ['ytd-app', 'html', 'body'] },
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
                        video.play().catch(e => { /* console.warn("Auto-play attempt failed:", e); */ });
                    }
                    if (video.playbackRate !== desiredPlaybackRate) {
                        desiredPlaybackRate = video.playbackRate;
                    }
                    if (Math.abs(video.volume - desiredVolume) > 0.005 || video.muted !== (isManuallyMuted || desiredVolume === 0)) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                    }
                }
            });

            if (!currentVideo || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer')))) {
                handleGlobalClick(null); // e를 null로 전달하여 자동 감지임을 알립니다.
            }

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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.61_SiteSpecificVolume_Updated_FixedMobileDrag_MissavPopupFix_V4');

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
                if (popupElement) {
                    // 전체 화면 요소 안에 팝업을 배치하여 전체 화면에서만 보이도록 합니다.
                    fsEl.appendChild(popupElement);
                    updatePopupPosition(); // 위치 다시 조정
                    // Missav 사이트이고 전체 화면으로 진입했다면 팝업을 표시
                    if (isMissavRestrictedSite && currentVideo && (fsEl === currentVideo || fsEl.contains(currentVideo))) {
                        showPopup();
                        resetPopupHideTimer();
                    }
                }
            } else { // 전체 화면 종료 시
                if (popupElement) {
                    // 전체 화면에서 나오면 팝업을 다시 body로 이동시킵니다.
                    document.body.appendChild(popupElement);
                    updatePopupPosition(); // 위치 다시 조정
                    // 전체 화면 종료 시에는 무조건 팝업 숨김
                    hidePopup();
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
        fixOverflow();

        let touchStartY = 0;
        let touchMoved = false;

        document.addEventListener('touchstart', (e) => {
            touchStartY = e.touches[0].clientY;
            touchMoved = false;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
            if (deltaY > 10) {
                touchMoved = true;
            }
        }, { passive: true });

        document.body.addEventListener('click', (e) => {
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            handleGlobalClick(e); // 클릭 이벤트 객체를 전달합니다.
        }, true);

        document.body.addEventListener('touchend', (e) => {
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            handleGlobalClick(e); // 터치 끝 이벤트 객체를 전달합니다.
        }, true);


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
