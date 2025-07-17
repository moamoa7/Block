// ==UserScript==
// @name Video Controller Popup (V4.10.42: ReferenceError Fix, No Amplification, No PIP/Fullscreen Buttons)
// @namespace Violentmonkey Scripts
// @version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified
// @description Optimized video controls with robust popup initialization on video selection, consistent state management during dragging, enhanced scroll handling, improved mobile click recognition, and fixed ReferenceError. Amplification, PIP, and fullscreen exit buttons removed.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyPaused = false;
    const videoRateHandlers = new WeakMap();

    // --- Configuration ---
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
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
        fixPlaybackRate(currentVideo, 1.0);
        setNormalVolume(currentVideo, 1.0);
        isManuallyPaused = false;

        currentVideo.play().catch(e => console.warn("Autoplay/Play on select failed:", e));

        updatePopupSliders();
        updatePopupPosition();
        showPopupTemporarily();
    }

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
        playPauseBtn.style.cssText = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;

        const resetBtn = document.createElement('button');
        resetBtn.setAttribute('data-action', 'reset-speed-volume');
        resetBtn.textContent = '재설정';
        resetBtn.style.cssText = `background-color: #333; color: white; border: 1px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;`;

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

        // --- PIP 및 전체 종료 버튼을 제거합니다 ---
        // const modeSection = document.createElement('div');
        // modeSection.className = 'vcp-section';
        // modeSection.style.marginBottom = '10px';

        // const pipBtn = document.createElement('button');
        // pipBtn.setAttribute('data-action', 'pip');
        // pipBtn.textContent = 'PIP 모드';
        // pipBtn.style.cssText = `${playPauseBtn.style.cssText} margin-top: 5px;`;

        // const exitFullscreenBtn = document.createElement('button');
        // exitFullscreenBtn.setAttribute('data-action', 'exit-fullscreen');
        // exitFullscreenBtn.textContent = '전체 종료';
        // exitFullscreenBtn.style.cssText = `${playPauseBtn.style.cssText} margin-top: 5px;`;

        // modeSection.appendChild(pipBtn);
        // modeSection.appendChild(exitFullscreenBtn);
        // contentContainer.appendChild(modeSection); // 이 줄도 제거합니다.

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
                fixPlaybackRate(currentVideo, 1.0);
                setNormalVolume(currentVideo, 1.0);
                currentVideo.muted = false;
                updatePopupSliders();
                updateStatus('1.0x Speed / 100% Volume');
                break;
            // 'pip' 및 'exit-fullscreen' case를 제거합니다.
            // case 'pip':
            //     if (document.pictureInPictureEnabled && currentVideo.requestPictureInPicture) {
            //         (document.pictureInPictureElement ? document.exitPictureInPicture() : currentVideo.requestPictureInPicture()).catch(e => console.error(e));
            //         updateStatus(document.pictureInPictureElement ? 'Exiting PIP' : 'Entering PIP');
            //     }
            //     break;
            // case 'exit-fullscreen':
            //     if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            //     break;
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

    function showPopupTemporarily() {
        if (!currentVideo) {
            hidePopup();
            return;
        }
        // 팝업이 완전히 차단된 사이트에서는 보이지 않도록 함
        if (isPopupGloballyBlocked) {
            hidePopup();
            return;
        }
        if (popupElement && currentVideo) { showPopup(); updatePopupPosition(); resetPopupHideTimer(); }
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
        const popupRect = popupElement.getBoundingClientRect();
        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            const viewportX = videoRect.left + (videoRect.width / 2) - (popupRect.width / 2);
            const viewportY = videoRect.top + (videoRect.height / 2) - (popupRect.height / 2);
            const safeX = Math.max(0, Math.min(viewportX, window.innerWidth - popupRect.width));
            const safeY = Math.max(0, Math.min(viewportY, window.innerHeight - popupRect.height));

            popupElement.style.left = `${safeX}px`;
            popupElement.style.top = `${safeY}px`;
            popupElement.style.transform = 'none';
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
    function selectVideoOnDocumentClick(e) {
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

            if (ratio > 0 && score > maxScore) {
                maxScore = score;
                bestVideo = video;
            }
        });

        // 팝업 상태 관리: 새로운 비디오 선택 또는 비디오 없음
        if (bestVideo && maxScore > -0.5) { // 적어도 어느 정도 화면에 있고 중심에 가까운 비디오
            if (currentVideo && currentVideo !== bestVideo) {
                // 이전 비디오와 다른 새로운 비디오가 선택됨
                console.log('[VCP] Switching video. Hiding previous popup.');
                currentVideo.pause();
                hidePopup();
                currentVideo = null;
            }

            if (currentVideo === bestVideo) {
                // 같은 비디오라면 잠시 팝업만 보여줌 (클릭 이벤트로 인한 경우)
                showPopupTemporarily();
            } else {
                // 다른 비디오가 선택되면 새로운 비디오에 대해 팝업을 새로 표시
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
            if (!currentVideo || (popupElement && popupElement.style.display === 'none')) {
                selectVideoOnDocumentClick(null);
            } else if (currentVideo) {
                // 현재 비디오가 있고 팝업이 보이는 상태라면, 팝업 위치만 업데이트
                updatePopupPosition();
                resetPopupHideTimer();
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

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified');

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
                    showPopup();
                } else {
                    document.body.appendChild(popupElement);
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

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
