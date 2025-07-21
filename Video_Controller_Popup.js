// ==UserScript==
// @name         Video Controller Popup Refactored
// @namespace    http://tampermonkey.net/
// @version      4.10.76_Refactored
// @description  Plays, mutes, adjusts speed/volume of HTML5 videos/audios on scroll, click, or DOM changes. Popup appears on click, can be globally blocked for certain sites, or blocked only on click for specific players.
// @author       YourName (or original author)
// @match        *://*/*
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
            all: initial !important; /* 모든 CSS 속성 강제 초기화 */
            position: fixed !important;
            background: rgba(0, 0, 0, 0.8) !important;
            border-radius: 8px !important;
            padding: 10px !important;
            color: white !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important;
            font-size: 14px !important;
            text-align: center !important;
            z-index: 2147483647 !important; /* 최상위 z-index 강제 */
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3) !important;
            display: none !important; /* 초기에는 숨김 */
            opacity: 0 !important;
            visibility: hidden !important;
            transition: opacity 0.2s ease-in-out !important;
            box-sizing: border-box !important; /* 패딩, 보더가 너비에 포함되도록 */
            width: max-content !important; /* 내용물에 맞춰 너비 조정 */
            min-width: 250px !important; /* 최소 너비 설정 */
            pointer-events: none !important; /* 초기에는 클릭 불가능하도록 강제 */
            left: 0 !important; /* transform으로만 위치를 제어할 것이므로 초기화 */
            top: 0 !important; /* transform으로만 위치를 제어할 것이므로 초기화 */
        `;

        // 드래그 핸들 생성
        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.style.cssText = 'cursor: grab !important; padding: 5px !important; margin: -5px -5px 5px -5px !important; background: rgba(255, 255, 255, 0.1) !important; border-radius: 5px !important; user-select: none !important;';
        const dragSpan = document.createElement('span');
        dragSpan.textContent = '▶ Video Controller';
        dragHandle.appendChild(dragSpan);
        popupElement.appendChild(dragHandle);

        // 플레이/일시정지 및 배속1x 버튼 컨테이너
        const buttonContainer1 = document.createElement('div');
        buttonContainer1.style.cssText = 'display: flex !important; justify-content: space-between !important; align-items: center !important; margin-bottom: 10px !important;';

        const playPauseButton = document.createElement('button');
        playPauseButton.setAttribute('data-action', 'play-pause');
        playPauseButton.style.cssText = 'flex-grow: 1 !important; padding: 8px 12px !important; margin-right: 5px !important; background: #007bff !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 14px !important; transition: background 0.2s !important;';
        playPauseButton.textContent = '재생/일시정지';
        buttonContainer1.appendChild(playPauseButton);

        const resetSpeedButton = document.createElement('button');
        resetSpeedButton.setAttribute('data-action', 'reset-speed');
        resetSpeedButton.style.cssText = 'padding: 8px 12px !important; background: #6c757d !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 14px !important; transition: background 0.2s !important;';
        resetSpeedButton.textContent = '배속1x';
        buttonContainer1.appendChild(resetSpeedButton);
        popupElement.appendChild(buttonContainer1);

        // 배속 슬라이더
        const speedContainer = document.createElement('div');
        speedContainer.style.cssText = 'margin-bottom: 10px !important;';
        const speedLabel = document.createElement('label');
        speedLabel.setAttribute('for', 'vcp-speed');
        speedLabel.style.cssText = 'display: block !important; margin-bottom: 5px !important;';
        speedLabel.textContent = '배속: ';
        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00';
        speedLabel.appendChild(speedDisplay);
        speedContainer.appendChild(speedLabel);
        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.25';
        speedInput.max = '4';
        speedInput.step = '0.05';
        speedInput.value = '1';
        speedInput.style.cssText = 'width: 100% !important; cursor: grab !important;';
        speedContainer.appendChild(speedInput);
        popupElement.appendChild(speedContainer);

        // 볼륨 슬라이더
        const volumeContainer = document.createElement('div');
        volumeContainer.style.cssText = 'margin-bottom: 10px !important;';
        const volumeLabel = document.createElement('label');
        volumeLabel.setAttribute('for', 'vcp-volume');
        volumeLabel.style.cssText = 'display: block !important; margin-bottom: 5px !important;';
        volumeLabel.textContent = '볼륨: ';
        const volumeDisplay = document.createElement('span');
        volumeDisplay.id = 'vcp-volume-display';
        volumeDisplay.textContent = '100';
        volumeLabel.appendChild(volumeDisplay);
        volumeContainer.appendChild(volumeLabel);
        const volumeInput = document.createElement('input');
        volumeInput.type = 'range';
        volumeInput.id = 'vcp-volume';
        volumeInput.min = '0';
        volumeInput.max = '1';
        volumeInput.step = '0.01';
        volumeInput.value = '1';
        volumeInput.style.cssText = 'width: 100% !important; cursor: grab !important;';
        volumeContainer.appendChild(volumeInput);
        popupElement.appendChild(volumeContainer);

        // 무음/소리 버튼 컨테이너
        const buttonContainer2 = document.createElement('div');
        buttonContainer2.style.cssText = 'display: flex !important; justify-content: space-between !important; align-items: center !important;';

        const muteButton = document.createElement('button');
        muteButton.setAttribute('data-action', 'mute');
        muteButton.style.cssText = 'flex-grow: 1 !important; padding: 8px 12px !important; margin-right: 5px !important; background: #28a745 !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 14px !important; transition: background 0.2s !important;';
        muteButton.textContent = '무음';
        buttonContainer2.appendChild(muteButton);

        const speakButton = document.createElement('button');
        speakButton.setAttribute('data-action', 'speak');
        speakButton.style.cssText = 'flex-grow: 1 !important; padding: 8px 12px !important; background: #dc3545 !important; color: white !important; border: none !important; border-radius: 4px !important; cursor: pointer !important; font-size: 14px !important; transition: background 0.2s !important;';
        speakButton.textContent = '소리';
        buttonContainer2.appendChild(speakButton);
        popupElement.appendChild(buttonContainer2);

        // 초기에는 body에 추가 (이후 필요에 따라 변경)
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
            playPauseButton.style.setProperty('background', currentVideo.paused ? '#007bff' : '#ffc107', 'important'); // 색상 변경
        }
    }

    function updateMuteSpeakButtons() {
        if (!popupElement || !currentVideo) return;
        const muteButton = popupElement.querySelector('[data-action="mute"]');
        const speakButton = popupElement.querySelector('[data-action="speak"]');

        if (muteButton && speakButton) {
            if (currentVideo.muted || currentVideo.volume === 0) {
                muteButton.style.setProperty('background', '#dc3545', 'important'); // 활성화 색상
                speakButton.style.setProperty('background', '#28a745', 'important'); // 비활성화 색상 (원래 색)
                muteButton.textContent = '무음 (활성)';
                speakButton.textContent = '소리';
            } else {
                muteButton.style.setProperty('background', '#28a745', 'important'); // 비활성화 색상 (원래 색)
                speakButton.style.setProperty('background', '#dc3545', 'important'); // 활성화 색상
                muteButton.textContent = '무음';
                speakButton.textContent = '소리 (활성)';
            }
        }
    }

    function setupPopupEventListeners() {
        if (!popupElement) return;

        // 팝업 내부의 모든 클릭 이벤트를 캡처링 단계에서 처리
        popupElement.addEventListener('click', (e) => {
            const action = e.target.getAttribute('data-action');
            if (action) {
                handleButtonClick(action);
            }
            e.stopImmediatePropagation(); // 팝업 내부 클릭은 무조건 전파 중단
        }, true); // 캡처링 단계에서 이벤트 처리

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', (e) => {
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2);
            e.stopImmediatePropagation(); // 슬라이더 조작 시 이벤트 전파 중단
        }, true); // 캡처링 단계에서 이벤트 처리

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', (e) => {
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            isManuallyMuted = (vol === 0);
            if (currentVideo) { setNormalVolume(currentVideo, vol); }
            volumeDisplay.textContent = Math.round(vol * 100);
            updateMuteSpeakButtons();
            e.stopImmediatePropagation(); // 슬라이더 조작 시 이벤트 전파 중단
        }, true); // 캡처링 단계에서 이벤트 처리

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        let initialPopupX = 0;
        let initialPopupY = 0;

        const startDrag = (e) => {
            if (e.target !== dragHandle) return;
            resetPopupHideTimer();
            isPopupDragging = true;
            dragHandle.style.setProperty('cursor', 'grabbing', 'important');

            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);

            // 현재 팝업의 transform 값 파싱
            const transform = window.getComputedStyle(popupElement).transform;
            let matrix = new DOMMatrixReadOnly(transform);
            initialPopupX = matrix.m41; // transform.x
            initialPopupY = matrix.m42; // transform.y

            popupDragOffsetX = clientX - initialPopupX;
            popupDragOffsetY = clientY - initialPopupY;

            document.body.style.setProperty('user-select', 'none', 'important'); // 텍스트 선택 방지
            document.body.style.setProperty('-webkit-user-select', 'none', 'important');
            document.body.style.setProperty('-moz-user-select', 'none', 'important');
            document.body.style.setProperty('-ms-user-select', 'none', 'important');
        };

        const stopDrag = (e) => {
            if (isPopupDragging) {
                isPopupDragging = false;
                dragHandle.style.setProperty('cursor', 'grab', 'important');
                document.body.style.setProperty('user-select', '', 'important'); // 텍스트 선택 허용
                document.body.style.setProperty('-webkit-user-select', '', 'important');
                document.body.style.setProperty('-moz-user-select', '', 'important');
                document.body.style.setProperty('-ms-user-select', '', 'important');
                resetPopupHideTimer();
            }
        };

        const dragPopup = (e) => {
            if (!isPopupDragging) return;
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;

            const newX = clientX - popupDragOffsetX;
            const newY = clientY - popupDragOffsetY;

            // 드래그 중에는 transform으로 위치 제어
            popupElement.style.setProperty('transform', `translate3d(${newX}px, ${newY}px, 0)`, 'important');

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
            popupElement.style.setProperty('display', 'block', 'important');
            popupElement.style.setProperty('opacity', '0.75', 'important');
            popupElement.style.setProperty('visibility', 'visible', 'important');
            popupElement.style.setProperty('pointer-events', 'auto', 'important');
            popupElement.style.setProperty('z-index', '2147483647', 'important');
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.setProperty('opacity', '0', 'important');
            popupElement.style.setProperty('visibility', 'hidden', 'important');
            popupElement.style.setProperty('pointer-events', 'none', 'important');
            // transition이 끝난 후 display: none 처리
            popupElement.addEventListener('transitionend', function handler() {
                if (popupElement && popupElement.style.opacity === '0') {
                    popupElement.style.setProperty('display', 'none', 'important');
                }
                popupElement.removeEventListener('transitionend', handler);
            }, { once: true });
        }
    }

    function showPopup() {
        if (!currentVideo || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) || (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer')))) {
            hidePopup();
            return;
        }

        // 팝업 삽입 위치 조정 시도
        // 현재 비디오 요소가 document.body에 직접 붙어있지 않고 부모 요소가 있다면
        // 플레이어 바로 다음 형제 요소로 팝업을 삽입하여 stacking context를 맞춤
        let parentToAppendTo = document.body;
        if (currentVideo && currentVideo.parentNode && currentVideo.parentNode !== document.body) {
            try {
                // 비디오 요소의 부모가 null이 아니고, 유효한 노드이며, 바디가 아닌 경우
                // 팝업을 비디오 요소의 부모에 추가하여 stacking context를 맞출 수 있도록 시도
                currentVideo.parentNode.insertBefore(popupElement, currentVideo.nextSibling);
                parentToAppendTo = currentVideo.parentNode;
                // console.log('[VCP] Popup moved next to current video.');
            } catch (e) {
                // console.warn('[VCP] Failed to insert popup next to video, falling back to body.', e);
                document.body.appendChild(popupElement);
            }
        } else if (popupElement.parentNode !== document.body) {
            // 이미 다른 곳에 삽입되어 있다면 다시 body로
            document.body.appendChild(popupElement);
        }


        setPopupVisibility(true);
        updatePopupPosition(); // 팝업이 화면에 잘 보이도록 위치 조정
        updatePlayPauseButton();
        updateMuteSpeakButtons();
        updatePopupSliders();
        resetPopupHideTimer(); // 팝업이 나타날 때도 타이머 리셋
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        // 드래그 중이 아닐 때만 타이머 설정
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        // 팝업 드래그 중이 아니며, 팝업이 표시되어 있을 때만 위치 업데이트
        if (!popupElement || isPopupDragging || popupElement.style.visibility === 'hidden') {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        const popupRect = popupElement.getBoundingClientRect(); // 현재 팝업의 크기

        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const isVideoVisible = videoRect.top < viewportHeight && videoRect.bottom > 0 &&
                               videoRect.left < viewportWidth && videoRect.right > 0;

        if (isVideoVisible) {
            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX;
            let adjustedY = targetY;

            // 팝업을 중앙에 오도록 조정
            // 팝업 자체의 크기를 반영하여 정확한 중앙에 오도록 함
            adjustedX -= popupRect.width / 2;
            adjustedY -= popupRect.height / 2;

            // 화면 경계 내에 팝업이 위치하도록 조정 (패딩 포함)
            const padding = 10; // 팝업 내부 패딩과 유사하게 여유 공간 확보
            adjustedX = Math.max(padding, Math.min(adjustedX, viewportWidth - popupRect.width - padding));
            adjustedY = Math.max(padding, Math.min(adjustedY, viewportHeight - popupRect.height - padding));

            // 드래그 중이 아닐 때만 위치 조정
            if (!isPopupDragging) {
                // transform을 사용하여 위치를 조정하여 left/top을 직접 건드리는 것보다 부드럽게
                // left/top은 0으로 유지하고 transform으로만 위치를 제어
                popupElement.style.setProperty('transform', `translate3d(${adjustedX}px, ${adjustedY}px, 0)`, 'important');
                popupElement.style.setProperty('position', 'fixed', 'important'); // 전체화면에서도 fixed 유지
            }

        } else {
            // 비디오가 화면을 벗어나면 팝업 숨김
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo || popupElement.style.visibility === 'hidden') return;

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

    function findBestVideoOnPage() {
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

                const score = visibleArea * 0.7 + (1 / Math.pow(1 + centerDist, 5)) * 5000 * 0.3;

                return { video: v, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);

        let bestVideo = sorted[0]?.video || null;
        let foundPlayingVideo = null;

        videos.forEach(video => {
            if (!video.paused && video.duration > 0 && !video.ended) {
                if (!(isChzzkSite && video.closest('.live_thumbnail_list_item')) &&
                    !(isYouTubeSite && (video.closest('ytd-reel-video-renderer') || video.closest('ytm-reel-player-renderer')))) {
                    foundPlayingVideo = video;
                    return;
                }
            }
        });

        if (foundPlayingVideo) {
            bestVideo = foundPlayingVideo;
        }

        return bestVideo;
    }

    let touchStartY = 0;
    let touchMoved = false;

    document.addEventListener('touchstart', (e) => {
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        touchStartY = e.touches[0].clientY;
        touchMoved = false;
    }, { passive: true, capture: true });

    document.addEventListener('touchmove', (e) => {
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        const deltaY = Math.abs(e.touches[0].clientY - touchStartY);
        if (deltaY > 10) {
            touchMoved = true;
        }
    }, { passive: true, capture: true });

    // 전역 클릭 이벤트 핸들러: 캡처링 단계에서 발생하여 다른 스크립트보다 먼저 이벤트를 가로챔.
    document.addEventListener('click', (e) => {
        // 팝업 내부 클릭 또는 드래그 중인 경우 이 스크립트의 다른 클릭 이벤트 처리 방지
        // 팝업이 보이고, 클릭된 요소가 팝업 내부인 경우, 추가적인 처리 없이 바로 종료
        if (popupElement && popupElement.style.visibility !== 'hidden' && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            // 팝업 내부의 이벤트는 setupPopupEventListeners에서 개별적으로 처리하며
            // 거기서 stopImmediatePropagation을 이미 호출하므로 여기서 또 호출할 필요 없음.
            return;
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
                // showPopup 내부에서 resetPopupHideTimer()가 호출됨
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
        if (popupElement && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            e.stopImmediatePropagation();
            return;
        }
        if (touchMoved) {
            e.stopImmediatePropagation();
        }
    }, { passive: true, capture: true });


    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            const newBestVideo = findBestVideoOnPage();

            if (currentVideo && (!checkCurrentVideoVisibility() ||
                (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')) ||
                (isYouTubeSite && currentVideo && (currentVideo.closest('ytd-reel-video-renderer') || currentVideo.closest('ytm-reel-player-renderer'))))) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }

            if (newBestVideo && currentVideo !== newBestVideo) {
                selectAndControlVideo(newBestVideo);
                hidePopup();
            } else if (!newBestVideo && currentVideo) {
            }

            if (!isPopupDragging) {
                hidePopup();
            }

        }, 100);
    }

    function updateVideoList() {
        findPlayableVideos();
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
                if (mutation.type === 'childList' && (Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))))) {
                    foundMediaChange = true;
                    break;
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    // attributes: true 가 비디오 관련 속성 변경 (예: autoplay, controls 등)을 감지합니다.
                    // 모든 속성 변경을 감지하므로 필요 시 특정 속성 변경만 필터링 가능
                    foundMediaChange = true;
                    break;
                }
            }
            if (foundMediaChange) {
                // DOM 변경 감지 시 현재 비디오 목록을 업데이트하고 최적의 비디오를 다시 선택합니다.
                const newBestVideo = findBestVideoOnPage();
                if (newBestVideo && currentVideo !== newBestVideo) {
                    selectAndControlVideo(newBestVideo);
                } else if (!newBestVideo && currentVideo) {
                    // 더 이상 적합한 비디오가 없으면 현재 비디오를 정지하고 초기화합니다.
                    if (currentVideo) currentVideo.pause();
                    currentVideo = null;
                }
                // 팝업은 바로 숨기고, 클릭 시 다시 나타나도록 합니다.
                hidePopup();
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
                console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting state.`);
                lastUrl = currentUrl;
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                isManuallyPaused = false;
                hidePopup();

                const newBestVideo = findBestVideoOnPage();
                if (newBestVideo) {
                    selectAndControlVideo(newBestVideo);
                }
                // URL 변경 후 바로 팝업 위치 업데이트 시도
                if (popupElement && popupElement.style.visibility !== 'hidden') {
                     updatePopupPosition();
                }
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
                        el.style.setProperty('overflow', 'visible', 'important');
                    });
                });
            }
        });
    }

    function findAllVideosDeep() {
        return Array.from(document.querySelectorAll('video, audio'))
            .filter(media => {
                const rect = media.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) return false;
                if (!document.body.contains(media)) return false;
                if (isChzzkSite && media.closest('.live_thumbnail_list_item')) return false;
                if (isYouTubeSite && (media.closest('ytd-reel-video-renderer') || media.closest('ytm-reel-player-renderer'))) return false;
                return true;
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
                    // 현재 비디오가 아닌 다른 비디오는 무조건 음소거
                    if (!video.muted || video.volume > 0) {
                        video.muted = true;
                        video.volume = 0;
                    }
                } else {
                    // 현재 선택된 비디오는 사용자의 설정에 따라 제어
                    if (video.paused && !video.ended && !isManuallyPaused) {
                        video.play().catch(e => { /* console.warn("Auto-play attempt failed:", e); */ });
                    }
                    if (video.playbackRate !== desiredPlaybackRate) {
                        video.playbackRate = desiredPlaybackRate;
                    }
                    // desiredVolume이 0인데 muted가 false이거나, 그 반대인 경우 조정
                    if (Math.abs(video.volume - desiredVolume) > 0.005 || video.muted !== (isManuallyMuted || desiredVolume === 0)) {
                        video.volume = desiredVolume;
                        video.muted = isManuallyMuted || (desiredVolume === 0);
                    }
                }
            });

            // 팝업이 보이고 드래그 중이 아닐 때만 업데이트
            if (popupElement && popupElement.style.visibility !== 'hidden' && !isPopupDragging) {
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

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.76_Refactored');

        createPopupElement();
        hidePopup();

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    // 전체화면 진입 시, 팝업을 전체화면 요소 안으로 이동
                    fsEl.appendChild(popupElement);
                    console.log('[VCP] Moved popup to fullscreen element.');
                    showPopup(); // 전체화면 진입 시 팝업 보이기
                } else {
                    // 전체화면 종료 시, 팝업을 다시 body로 이동
                    document.body.appendChild(popupElement);
                    console.log('[VCP] Moved popup back to body.');
                    hidePopup(); // 전체화면 종료 시 팝업 숨김
                }
                // 위치는 updatePopupPosition에서 알아서 다시 계산
                updatePopupPosition();
            }
        });


        window.addEventListener('resize', () => {
            if (popupElement && popupElement.style.visibility !== 'hidden') {
                updatePopupPosition();
            }
        });

        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList();
        setupDOMObserver();
        setupSPADetection();
        fixOverflow();

        setupPopupEventListeners(); // 팝업 자체의 이벤트 리스너 설정

        startCheckingVideoStatus();

        // 페이지를 떠날 때 리소스 정리
        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval);
        });
    }

    // 문서 준비 상태에 따라 초기화
    // `interactive` 상태에서도 초기화하여 더 빨리 작동하도록 함
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }

    // 혹시 DOMContentLoaded 이전에 로드된 경우를 대비하여 직접 실행 시도
    // (Tampermonkey/Violentmonkey 설정에 따라 다를 수 있음)
    // setTimeout(initialize, 0); // 0ms 지연으로 비동기 실행 보장

})();
