// ==UserScript==
// @name Video Controller Popup (V4.10.42: ReferenceError Fix, No Amplification, No PIP/Fullscreen Buttons)
// @namespace Violentmonkey Scripts
// @version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified_Rolledback_AutoDetect_FixFlash_FixPosition
// @description Optimized video controls with robust popup initialization on video selection, consistent state management during dragging, enhanced scroll handling, improved mobile click recognition, and fixed ReferenceError. Amplification, PIP, and fullscreen exit buttons removed. Improved auto-detection for dynamic sites. Fixed popup flashing and position issues.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyPaused = false;
    const videoRateHandlers = new WeakMap(); // ratechange 이벤트 리스너 관리를 위해 다시 사용
    let checkVideoInterval = null; // 비디오 상태를 주기적으로 확인할 인터벌 변수

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 500; // 0.5초마다 비디오 상태 확인

    // 여기에 팝업을 차단하고 싶은 사이트의 도메인과 경로 조건을 추가합니다.
    const SITE_POPUP_BLOCK_LIST = [
        { domain: 'sooplive.co.kr', pathIncludes: null }, // 모든 경로에서 차단
        { domain: 'twitch.tv', pathIncludes: null },     // 모든 경로에서 차단
        { domain: 'kick.com', pathIncludes: null },      // 모든 경로에서 차단
        { domain: 'anotherpreview.net', pathIncludes: null }, // 모든 경로에서 차단
        // 예시: 'previewsite.com'의 '/preview/' 경로에서만 팝업 차단
        // { domain: 'previewsite.com', pathIncludes: '/preview/' }
    ];

    const isPopupGloballyBlocked = SITE_POPUP_BLOCK_LIST.some(blockRule => {
        const isDomainMatch = location.hostname.includes(blockRule.domain);
        if (!isDomainMatch) return false;

        if (blockRule.pathIncludes) {
            return location.pathname.includes(blockRule.pathIncludes);
        }
        return true;
    });

    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(site => location.hostname.includes(site));

    // --- Utility Functions (Moved to top for scope visibility) ---
    function findAllVideosDeep(root = document) {
        const videoElements = new Set();
        root.querySelectorAll('video, audio').forEach(v => videoElements.add(v));
        root.querySelectorAll('*').forEach(el => { if (el.shadowRoot) findAllVideosDeep(el.shadowRoot).forEach(v => videoElements.add(v)); });
        return Array.from(videoElements);
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        if (!isLazySrcBlockedSite) found.forEach(v => { if (!v.src && v.dataset && v.dataset.src) v.src = v.dataset.src; });
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            return isVisible && isReasonableSize && hasMedia;
        });
        videos = playableVideos; // Update global videos list
        return playableVideos;
    }

    function calculateCenterDistanceScore(video, intersectionRatio) {
        const rect = video.getBoundingClientRect();
        const viewportHeight = window.innerHeight;

        const videoCenterY = rect.top + (rect.height / 2);
        const viewportCenterY = viewportHeight / 2;

        const distance = Math.abs(videoCenterY - viewportCenterY);
        const normalizedDistance = distance / viewportHeight;

        const score = intersectionRatio - normalizedDistance;
        return score;
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

    // 현재 선택된 비디오가 유효하고 화면에 보이는지 확인
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
        // 팝업이 완전히 차단된 사이트에서는 이 함수가 실행되지 않도록 합니다.
        if (isPopupGloballyBlocked) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; }
            hidePopup();
            return;
        }

        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        videos.forEach(video => {
            if (video !== videoToControl && !video.paused) {
                video.pause();
            }
        });

        currentVideo = videoToControl;

        currentVideo.autoplay = true;
        currentVideo.playsInline = true;
        currentVideo.muted = false; // 기본 음소거 해제
        console.log('[VCP] Video selected automatically based on prominence. Resetting controls.');
        fixPlaybackRate(currentVideo, 1.0); // ratechange 이벤트 리스너를 통해 배속 보정
        setNormalVolume(currentVideo, 1.0);
        isManuallyPaused = false;

        currentVideo.play().catch(e => console.warn("Autoplay/Play on select failed:", e));

        updatePopupSliders();
        updatePopupPosition(); // 비디오 선택 시 팝업 위치 업데이트
        showPopup();
        resetPopupHideTimer(); // 팝업이 띄워졌으니 숨김 타이머를 리셋합니다.
    }

    // fixPlaybackRate 함수를 ratechange 이벤트 리스너 방식으로 롤백
    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;
        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) video.playbackRate = desiredPlaybackRate;
        };

        video.playbackRate = rate;
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);
    }

    // 볼륨 설정을 기본 HTML5 비디오/오디오 요소로만 제어
    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        desiredVolume = vol;
        video.muted = false; // 볼륨 조절 시 음소거 해제
        video.volume = Math.max(0, Math.min(1.0, vol)); // 0.0에서 1.0 사이로 값 제한
    }

    // --- Popup UI Functions ---
    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        // 초기 transform 속성을 유지하고, 위치는 left/top으로 고정
        popupElement.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px; padding: 0; color: white; font-family: sans-serif; z-index: 2147483647; display: none; opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); width: 230px; overflow: hidden; text-align: center; pointer-events: auto;`;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `font-weight: bold; margin-bottom: 8px; color: #ccc; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;`;
        popupElement.appendChild(dragHandle);

        const contentContainer = document.createElement('div');
        contentContainer.style.cssText = 'padding: 10px;';

        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = 'display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;';

        const playPauseBtn = document.createElement('button');
        playPauseBtn.setAttribute('data-action', 'play-pause');
        playPauseBtn.textContent = '재생/멈춤';
        playPauseBtn.style.cssText = `background-color: #333; color: white; border: 1.5px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;

        const resetBtn = document.createElement('button');
        resetBtn.setAttribute('data-action', 'reset-speed-volume');
        resetBtn.textContent = '재설정';
        resetBtn.style.cssText = `background-color: #333; color: white; border: 1.5px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;

        buttonSection.appendChild(playPauseBtn);
        buttonSection.appendChild(resetBtn);
        contentContainer.appendChild(buttonSection);

        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section';
        speedSection.style.marginBottom = '10px';

        const speedLabel = document.createElement('label');
        speedLabel.htmlFor = 'vcp-speed';
        speedLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #ccc;';

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
        speedInput.step = '0.2';
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
        volumeLabel.style.cssText = 'display: block; margin-bottom: 5px; color: #ccc;';

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

        const statusElement = document.createElement('div');
        statusElement.id = 'vcp-status';
        statusElement.textContent = 'Status: Ready';
        statusElement.style.cssText = 'margin-top: 10px; font-size: 12px; color: #aaa;';
        contentContainer.appendChild(statusElement);

        popupElement.appendChild(contentContainer);
        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function handleButtonClick(action) {
        if (!currentVideo) { updateStatus('No video selected.'); return; }
        // 팝업이 완전히 차단된 사이트에서는 버튼 클릭 동작도 제한
        if (isPopupGloballyBlocked) {
            updateStatus('Popup controls disabled on this site.');
            return;
        }
        resetPopupHideTimer();

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = false;
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                    updateStatus('Playing');
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                    updateStatus('Paused');
                }
                break;
            case 'reset-speed-volume':
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0); // ratechange 이벤트 리스너를 통해 배속 보정
                setNormalVolume(currentVideo, 1.0);
                currentVideo.muted = false;
                updatePopupSliders();
                updateStatus('1.0x Speed / 100% Volume');
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
            // 팝업이 완전히 차단된 사이트에서는 슬라이더 동작도 제한
            if (isPopupGloballyBlocked) {
                updateStatus('Popup controls disabled on this site.');
                return;
            }
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            desiredPlaybackRate = rate;
            speedDisplay.textContent = rate.toFixed(2);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); updateStatus(`Speed: ${rate.toFixed(2)}x`); }
        });

        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', () => {
            // 팝업이 완전히 차단된 사이트에서는 슬라이더 동작도 제한
            if (isPopupGloballyBlocked) {
                updateStatus('Popup controls disabled on this site.');
                return;
            }
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value);
            volumeDisplay.textContent = Math.round(vol * 100);
            if (currentVideo) { setNormalVolume(currentVideo, vol); updateStatus(`Volume: ${Math.round(vol * 100)}%`); }
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            // 팝업이 완전히 차단된 사이트에서는 드래그 동작도 제한
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
            // 드래그 시작 시 transform을 제거하여 left/top으로만 제어
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
            popupElement.style.left = `${clientX - popupDragOffsetX}px`;
            popupElement.style.top = `${clientY - popupDragOffsetY}px`;
        };

        dragHandle.addEventListener('mousedown', startDrag);
        dragHandle.addEventListener('touchstart', startDrag);
        document.addEventListener('mousemove', dragPopup);
        document.addEventListener('touchmove', dragPopup);
        document.addEventListener('mouseup', stopDrag);
        document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;

        // 팝업이 완전히 차단된 사이트에서는 항상 숨김
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
            if (isPopupGloballyBlocked && !isPopupDragging) {
                popupElement.style.setProperty('display', 'none', 'important');
            } else {
                popupElement.style.display = 'none';
                popupElement.style.opacity = '0';
                popupElement.style.visibility = 'hidden';
            }
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        // 팝업이 완전히 차단된 사이트에서는 보이지 않도록 함
        if (isPopupGloballyBlocked) {
            hidePopup();
            return;
        }
        setPopupVisibility(true);
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        // 팝업이 완전히 차단된 사이트에서는 타이머 자체가 의미 없으므로 리턴
        if (isPopupGloballyBlocked) return;
        if (!isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        // 팝업이 완전히 차단된 사이트에서는 위치 업데이트도 하지 않음
        if (isPopupGloballyBlocked) {
            hidePopup();
            return;
        }

        if (!popupElement || !currentVideo || isPopupDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        // 팝업의 너비와 높이를 직접 가져와 계산
        const popupRect = popupElement.getBoundingClientRect();

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            // 비디오 중앙에 팝업을 위치시키고, 팝업 자신의 크기만큼 절반 이동
            // 팝업의 고정된 너비/높이를 가정하거나, getBoundingClientRect()로 실제 크기 가져오기
            const targetX = videoRect.left + (videoRect.width / 2);
            const targetY = videoRect.top + (videoRect.height / 2);

            // 팝업의 중앙이 비디오의 중앙에 오도록 left/top을 설정
            popupElement.style.left = `${targetX}px`;
            popupElement.style.top = `${targetY}px`;
            // 항상 transform을 사용하여 중앙 정렬
            popupElement.style.transform = 'translate(-50%, -50%)';
            popupElement.style.position = 'fixed';
        } else {
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;
        // 팝업이 완전히 차단된 사이트에서는 슬라이더 업데이트도 하지 않음
        if (isPopupGloballyBlocked) {
            return;
        }
        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume');
        const volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        if (speedInput && speedDisplay) {
            const rate = desiredPlaybackRate;
            speedInput.value = rate.toFixed(2);
            speedDisplay.textContent = rate.toFixed(2);
        }

        if (volumeInput && volumeDisplay) {
            const volume = desiredVolume;
            volumeInput.value = volume.toFixed(2);
            volumeDisplay.textContent = Math.round(volume * 100);
        }
    }

    // --- Video Control & Selection Logic ---
    function selectVideoOnDocumentClick(e) { // 이 함수는 이제 클릭 이벤트 외에도 호출될 수 있음
        // 팝업이 완전히 차단된 사이트에서는 비디오 선택 및 팝업 표시 로직을 완전히 건너뜁니다.
        if (isPopupGloballyBlocked) {
            // 현재 제어 중인 비디오가 있다면 일시 정지합니다.
            if (currentVideo) {
                currentVideo.pause();
                currentVideo = null;
            }
            hidePopup();
            return;
        }

        // 팝업 자체를 클릭한 경우, 팝업 숨김 타이머만 리셋하고 종료
        // 그리고 팝업이 이미 보이는 상태라면 더 이상 비디오를 다시 선택할 필요 없음
        if (popupElement && e && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }

        updateVideoList(); // 현재 페이지의 모든 재생 가능한 비디오 목록을 업데이트

        let bestVideo = null;
        let maxScore = -Infinity;

        // 현재 화면에 가장 적합한 비디오를 찾음
        videos.forEach(video => {
            const ratio = calculateIntersectionRatio(video);
            const score = calculateCenterDistanceScore(video, ratio);

            // 현재 재생 중인 비디오가 있다면 그 비디오를 우선적으로 선택
            // (paused 상태가 아니고, 길이가 0이 아니며, 끝나지 않은 비디오)
            if (!video.paused && video.duration > 0 && !video.ended) {
                bestVideo = video;
                maxScore = Infinity; // 강제 선택을 위한 높은 점수
                return; // 가장 높은 점수를 찾았으니 더 이상 반복할 필요 없음
            }

            if (ratio > 0 && score > maxScore) {
                maxScore = score;
                bestVideo = video;
            }
        });

        // 팝업 상태 관리: 새로운 비디오 선택 또는 비디오 없음
        if (bestVideo && (maxScore > -0.5 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) { // 오디오 태그나 재생 중인 비디오는 점수 무관하게 고려
            if (currentVideo && currentVideo !== bestVideo) {
                // 이전 비디오와 다른 새로운 비디오가 선택됨
                console.log('[VCP] Switching video. Hiding previous popup.');
                currentVideo.pause();
                hidePopup();
                currentVideo = null;
                selectAndControlVideo(bestVideo); // 새로운 비디오 제어 시작
            } else if (currentVideo === bestVideo) {
                // 같은 비디오라면
                // 클릭 이벤트에 의해서 호출된 경우에만 팝업을 다시 띄우고 타이머 리셋
                if (e) { // 'e'가 존재한다는 것은 사용자 클릭에 의해 호출되었다는 의미
                    showPopup();
                    resetPopupHideTimer();
                }
            } else {
                // 이전에 제어하던 비디오가 없거나 초기 선택인 경우
                selectAndControlVideo(bestVideo);
            }
        } else {
            // 적합한 비디오가 없을 경우 (예: 모든 비디오가 화면 밖으로 스크롤됨)
            if (currentVideo) { // 이전에 제어하던 비디오가 있었다면 일시 정지
                currentVideo.pause();
            }
            currentVideo = null; // 현재 제어 비디오 없음
            if (!isPopupDragging) {
                hidePopup();
            }
        }
    }

    // --- 스크롤 이벤트 핸들러 (추가) ---
    let scrollTimeout = null;
    function handleScrollEvent() {
        // 팝업이 완전히 차단된 사이트에서는 스크롤 이벤트에 대한 팝업 로직도 건너뜁니다.
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

            // 현재 제어 중인 비디오가 유효하고 화면에 보이는지 확인
            if (currentVideo && !checkCurrentVideoVisibility()) {
                console.log('[VCP] Current video scrolled out of view or became invalid. Resetting.');
                currentVideo.pause();
                currentVideo = null;
                if (!isPopupDragging) {
                    hidePopup();
                }
            }

            // 팝업이 숨겨져 있거나, 현재 비디오가 없는 경우
            // 또는 스크롤로 인해 가장 적합한 비디오가 변경되었을 수 있으므로 재선택 시도
            // 이때는 e가 없으므로 팝업이 자동으로 다시 띄워지지 않도록 함
            if (!currentVideo || (popupElement && popupElement.style.display === 'none')) {
                selectVideoOnDocumentClick(null);
            } else if (currentVideo) {
                // 현재 비디오가 있고 팝업이 보이는 상태라면, 팝업 위치만 업데이트
                updatePopupPosition();
                // 스크롤 시에는 팝업을 계속 보여줄 필요 없으므로 resetPopupHideTimer 호출 안함
            }
        }, 100);
    }

    // --- Main Initialization ---
    function updateVideoList() {
        findPlayableVideos();
        // currentVideo가 DOM에 없거나 더 이상 videos 목록에 없으면 초기화
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo))) {
            console.log('[VCP] Current video no longer valid. Resetting.');
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
                // DOM 변경 감지 시 즉시 비디오 선택 로직 시도 (팝업을 자동으로 다시 띄우지는 않음)
                if (!currentVideo) {
                    selectVideoOnDocumentClick(null);
                }
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
                currentVideo = null; // Reset current video
                hidePopup(); // Hide popup
                updateVideoList(); // Re-scan for videos on new page
                // URL 변경 시 즉시 비디오 선택 로직 시도 (팝업을 자동으로 다시 띄우지는 않음)
                selectVideoOnDocumentClick(null);
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
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

    // 비디오를 주기적으로 확인하고 제어하는 함수
    function startCheckingVideoStatus() {
        if (checkVideoInterval) clearInterval(checkVideoInterval); // 기존 인터벌이 있다면 중지
        checkVideoInterval = setInterval(() => {
            // 현재 제어 중인 비디오가 없거나, (팝업이 숨겨진 상태에서) 비디오가 재생 중인데 currentVideo가 설정 안 된 경우
            // 이 로직은 주로 페이지 로드/SPA 전환 시 초기 비디오 감지를 담당하고,
            // 팝업 깜빡임을 방지하기 위해 팝업이 이미 보이는 상태에서는 selectVideoOnDocumentClick을 호출하지 않습니다.
            if (!currentVideo || (!currentVideo.paused && (popupElement.style.display === 'none' || popupElement.style.visibility === 'hidden'))) {
                 // 여기서는 selectVideoOnDocumentClick에 e (이벤트)를 전달하지 않으므로,
                 // 클릭으로 인한 팝업 재표시 로직은 활성화되지 않습니다.
                selectVideoOnDocumentClick(null);
            }
            // 현재 비디오가 있다면 배속과 볼륨이 올바른지 확인 (방어적 코드)
            if (currentVideo && currentVideo.playbackRate !== desiredPlaybackRate) {
                fixPlaybackRate(currentVideo, desiredPlaybackRate);
            }
            if (currentVideo && currentVideo.volume !== desiredVolume) {
                 setNormalVolume(currentVideo, desiredVolume);
            }
            // 팝업이 보이는 상태라면, 주기적으로 위치를 업데이트 (끌고 있을 때는 제외)
            if (popupElement && popupElement.style.display !== 'none' && !isPopupDragging) {
                updatePopupPosition();
            }
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified_Rolledback_AutoDetect_FixFlash_FixPosition');

        createPopupElement();
        // 팝업이 완전히 차단된 사이트에서는 초기부터 숨겨진 상태로 유지
        if (isPopupGloballyBlocked) {
            setPopupVisibility(false);
        } else {
            hidePopup();
        }

        document.addEventListener('fullscreenchange', () => {
            // 팝업이 완전히 차단된 사이트에서는 전체화면 시에도 팝업 표시를 막음
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
                    // 전체화면 진입/종료 시에도 위치 업데이트
                    updatePopupPosition();
                    showPopup();
                } else {
                    document.body.appendChild(popupElement);
                    // 전체화면 진입/종료 시에도 위치 업데이트
                    updatePopupPosition();
                }
            }
        });

        window.addEventListener('resize', () => {
            // 팝업이 완전히 차단된 사이트에서는 리사이즈 시에도 팝업 위치 업데이트를 하지 않음
            if (isPopupGloballyBlocked) {
                hidePopup();
                return;
            }
            updatePopupPosition();
        });

        // 스크롤 이벤트 리스너 추가
        window.addEventListener('scroll', handleScrollEvent);

        updateVideoList();
        setupDOMObserver();
        setupSPADetection();
        fixOverflow();

        // 모바일 클릭 인식을 위해 'touchend' 이벤트 추가
        document.body.addEventListener('click', selectVideoOnDocumentClick, true);
        document.body.addEventListener('touchend', selectVideoOnDocumentClick, true);

        // 주기적으로 비디오 상태를 확인하고 제어하는 인터벌 시작
        startCheckingVideoStatus();

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            if (checkVideoInterval) clearInterval(checkVideoInterval); // 페이지 언로드 시 인터벌 중지
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
