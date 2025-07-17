// ==UserScript==
// @name Video Controller Popup (V4.10.42: ReferenceError Fix, No Amplification, No PIP/Fullscreen Buttons)
// @namespace Violentmonkey Scripts
// @version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified_Rolledback_AutoDetect_FixFlash_FixPosition_ChzzkAudioFix4_Optimized_V2
// @description Optimized video controls with robust popup initialization on video selection, consistent state management during dragging, enhanced scroll handling, improved mobile click recognition, and fixed ReferenceError. Amplification, PIP, and fullscreen exit buttons removed. Improved auto-detection for dynamic sites. Fixed popup flashing and position issues. Enhanced Chzzk audio leak fix with play override and preview blocking. Performance optimized with selective interval and observer usage.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0;
    let isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0;
    const videoRateHandlers = new WeakMap(), originalPlayMethods = new WeakMap();
    let isInitialized = false;
    let checkVideoInterval = null, popupHideTimer = null; // Changed to be directly managed

    const POPUP_TIMEOUT_MS = 2000;
    const AUTO_CHECK_VIDEO_INTERVAL_MS = 300; // General interval for video status, popup position

    // MutationObserver for DOM changes
    let domObserver = null;

    const SITE_POPUP_BLOCK_LIST = [
        { domain: 'sooplive.co.kr' }, { domain: 'twitch.tv' }, { domain: 'kick.com' }, { domain: 'anotherpreview.net' }
    ];
    const isPopupGloballyBlocked = SITE_POPUP_BLOCK_LIST.some(r => location.hostname.includes(r.domain));
    const isLazySrcBlockedSite = ['missav.ws', 'missav.live'].some(s => location.hostname.includes(s));
    const isChzzkSite = location.hostname.includes('chzzk.naver.com');

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        const videoElements = new Set();
        (function findInNode(node) {
            node.querySelectorAll('video, audio').forEach(v => videoElements.add(v));
            node.querySelectorAll('*').forEach(el => el.shadowRoot && findInNode(el.shadowRoot));
        })(root);
        return Array.from(videoElements);
    }

    function calculateCenterDistanceScore(video, intersectionRatio) {
        const rect = video.getBoundingClientRect();
        const videoCenterY = rect.top + (rect.height / 2);
        const normalizedDistance = Math.abs(videoCenterY - (window.innerHeight / 2)) / window.innerHeight;
        return intersectionRatio - normalizedDistance;
    }

    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect(), vH = window.innerHeight, vW = window.innerWidth;
        const iTop = Math.max(0, rect.top), iBottom = Math.min(vH, rect.bottom);
        const iLeft = Math.max(0, rect.left), iRight = Math.min(vW, rect.right);
        const iArea = Math.max(0, iRight - iLeft) * Math.max(0, iBottom - iTop);
        const videoArea = rect.width * rect.height;
        return videoArea > 0 ? iArea / videoArea : 0;
    }

    function checkCurrentVideoVisibility() {
        if (!currentVideo) return false;
        const rect = currentVideo.getBoundingClientRect(), style = getComputedStyle(currentVideo);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity > 0;
        const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
        const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || currentVideo.tagName === 'AUDIO' || !currentVideo.paused;
        const hasMedia = currentVideo.videoWidth > 0 || currentVideo.videoHeight > 0 || currentVideo.tagName === 'AUDIO';
        return isVisible && isWithinViewport && isReasonableSize && hasMedia && document.body.contains(currentVideo);
    }

    // --- Video Control & Selection Logic ---
    function selectAndControlVideo(videoToControl) {
        if (isPopupGloballyBlocked) { currentVideo && currentVideo.pause(); currentVideo = null; hidePopup(); return; }
        if (!videoToControl) { currentVideo && currentVideo.pause(); currentVideo = null; hidePopup(); return; }

        // Chzzk 미리보기 비디오는 팝업 제어 대상에서 제외
        if (isChzzkSite && videoToControl.closest('.live_thumbnail_list_item')) {
            console.log('[VCP-Chzzk] Blocking popup for preview video. Only controlling audio.');
            if (currentVideo && !currentVideo.closest('.live_thumbnail_list_item')) { /* 기존 메인 비디오 유지 */ }
            else { hidePopup(); return; }
        }

        if (currentVideo && currentVideo !== videoToControl && originalPlayMethods.has(currentVideo)) {
            currentVideo.play = originalPlayMethods.get(currentVideo);
            originalPlayMethods.delete(currentVideo);
        }

        findAllVideosDeep().forEach(v => {
            if (v !== videoToControl) {
                if (originalPlayMethods.has(v) && v !== currentVideo) { // currentVideo는 오버라이드 제거 대상에서 제외
                    v.play = originalPlayMethods.get(v); originalPlayMethods.delete(v);
                }
                if (!v.paused) v.pause();
                v.muted = true; v.volume = 0; v.currentTime = 0;
            }
        });

        currentVideo = videoToControl;
        if (originalPlayMethods.has(currentVideo)) { // 현재 비디오는 play 오버라이드 제거
            currentVideo.play = originalPlayMethods.get(currentVideo); originalPlayMethods.delete(currentVideo);
        }
        currentVideo.autoplay = true; currentVideo.playsInline = true; currentVideo.muted = false;
        console.log('[VCP] Video selected automatically. Resetting controls.');
        fixPlaybackRate(currentVideo, 1.0); setNormalVolume(currentVideo, 1.0);
        currentVideo.play().catch(e => console.warn("Autoplay/Play failed:", e));

        updatePopupSliders(); updatePopupPosition(); showPopup(); resetPopupHideTimer();
        startCheckingVideoStatus(); // 비디오 선택 시 인터벌 재개
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;
        const handler = videoRateHandlers.get(video);
        if (handler) video.removeEventListener('ratechange', handler);
        const newHandler = () => video.playbackRate !== desiredPlaybackRate && (video.playbackRate = desiredPlaybackRate);
        video.playbackRate = rate; video.addEventListener('ratechange', newHandler);
        videoRateHandlers.set(video, newHandler);
    }

    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        desiredVolume = vol; video.muted = false;
        video.volume = Math.max(0, Math.min(1.0, vol));
    }

    function updateVideoList() {
        const found = findAllVideosDeep();
        // src가 없으면 data-src 확인 (missav.ws, missav.live 같은 사이트용)
        if (!isLazySrcBlockedSite) found.forEach(v => { if (!v.src && v.dataset.src) v.src = v.dataset.src; });

        videos = found.filter(v => {
            const style = getComputedStyle(v), rect = v.getBoundingClientRect();
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            // 치지직 미리보기는 findPlayableVideos에서 true로 간주했었으나, 여기서는 선택 로직을 따름.
            return isVisible && isReasonableSize && hasMedia;
        });

        // 현재 선택된 비디오가 유효하지 않거나 미리보기 비디오라면 리셋
        if (currentVideo && (!document.body.contains(currentVideo) || !videos.includes(currentVideo) || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')))) {
            console.log('[VCP] Current video no longer valid or is Chzzk preview. Resetting.');
            currentVideo && currentVideo.pause();
            currentVideo = null;
            hidePopup();
        }
    }

    function selectVideoOnDocumentClick(e) {
        if (isPopupGloballyBlocked) { currentVideo && currentVideo.pause(); currentVideo = null; hidePopup(); return; }
        // 팝업 자체 클릭 시 타이머만 리셋하고 종료 (비디오 재선택 방지)
        if (popupElement && e && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }

        updateVideoList();
        let bestVideo = null, maxScore = -Infinity;

        videos.forEach(video => {
            // 치지직 미리보기 비디오는 메인 컨트롤 대상에서 제외
            if (isChzzkSite && video.closest('.live_thumbnail_list_item')) return;

            const ratio = calculateIntersectionRatio(video), score = calculateCenterDistanceScore(video, ratio);
            // 현재 재생 중인 비디오가 있다면 최우선으로 선택 (가장 확실한 '메인' 비디오)
            if (!video.paused && video.duration > 0 && !video.ended) { bestVideo = video; maxScore = Infinity; return; }
            if (ratio > 0 && score > maxScore) { maxScore = score; bestVideo = video; }
        });

        if (bestVideo && (maxScore > -0.5 || bestVideo.tagName === 'AUDIO' || !bestVideo.paused)) {
            if (currentVideo && currentVideo !== bestVideo) { // 새 비디오 선택
                console.log('[VCP] Switching video. Hiding previous popup.');
                currentVideo && currentVideo.pause(); hidePopup();
                selectAndControlVideo(bestVideo);
            } else if (currentVideo === bestVideo) { // 같은 비디오 클릭
                e && (showPopup(), resetPopupHideTimer());
            } else { // 초기 선택
                selectAndControlVideo(bestVideo);
            }
        } else { // 적합한 비디오가 없을 때
            currentVideo && currentVideo.pause(); currentVideo = null;
            !isPopupDragging && hidePopup();
            stopCheckingVideoStatus(); // 비디오가 없으면 인터벌 중지
        }
    }

    // --- Popup UI Functions ---
    function createPopupElement() {
        if (popupElement) return;
        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(30, 30, 30, 0.9); border: 1px solid #444; border-radius: 8px; padding: 0; color: white; font-family: sans-serif; z-index: 2147483647; display: none; opacity: 0; transition: opacity 0.3s; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5); width: 230px; overflow: hidden; text-align: center; pointer-events: auto;`;

        popupElement.innerHTML = `
            <div id="vcp-drag-handle" style="font-weight: bold; margin-bottom: 8px; color: #ccc; padding: 5px; background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab; border-radius: 6px 6px 0 0; user-select: none;">비디오.오디오 컨트롤러</div>
            <div style="padding: 10px;">
                <div style="display: flex; gap: 5px; justify-content: center; align-items: center; margin-bottom: 10px;">
                    <button data-action="play-pause" style="background-color: #333; color: white; border: 1.5px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;">재생/멈춤</button>
                    <button data-action="reset-speed-volume" style="background-color: #333; color: white; border: 1.5px solid #555; padding: 5px 10px; border-radius: 4px; cursor: pointer; transition: background-color 0.2s; white-space: nowrap; min-width: 80px; text-align: center;">재설정</button>
                </div>
                <div class="vcp-section" style="margin-bottom: 10px;">
                    <label for="vcp-speed" style="display: block; margin-bottom: 5px; color: #ccc;">배속 조절: <span id="vcp-speed-display">1.00</span>x</label>
                    <input type="range" id="vcp-speed" min="0.2" max="16.0" step="0.2" value="1.0" style="width: 100%; cursor: pointer;">
                </div>
                <div class="vcp-section" style="margin-bottom: 10px;">
                    <label for="vcp-volume" style="display: block; margin-bottom: 5px; color: #ccc;">소리 조절: <span id="vcp-volume-display">100</span>%</label>
                    <input type="range" id="vcp-volume" min="0.0" max="1.0" step="0.01" value="1.0" style="width: 100%; cursor: pointer;">
                </div>
                <div id="vcp-status" style="margin-top: 10px; font-size: 12px; color: #aaa;">Status: Ready</div>
            </div>`;
        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function handleButtonClick(action) {
        if (!currentVideo) { updateStatus('No video selected.'); return; }
        if (isPopupGloballyBlocked) { updateStatus('Popup controls disabled on this site.'); return; }
        resetPopupHideTimer(); // 버튼 클릭 시 팝업 숨김 타이머 리셋

        if (action === 'play-pause') {
            currentVideo.paused ? (currentVideo.muted = false, currentVideo.play().catch(e => console.error("Play failed:", e)), updateStatus('Playing')) : (currentVideo.pause(), updateStatus('Paused'));
        } else if (action === 'reset-speed-volume') {
            desiredPlaybackRate = 1.0; fixPlaybackRate(currentVideo, 1.0);
            setNormalVolume(currentVideo, 1.0); currentVideo.muted = false;
            updatePopupSliders(); updateStatus('1.0x Speed / 100% Volume');
        }
    }

    function setupPopupEventListeners() {
        if (!popupElement) return;
        popupElement.addEventListener('click', e => e.target.getAttribute('data-action') && handleButtonClick(e.target.getAttribute('data-action')));

        const speedInput = popupElement.querySelector('#vcp-speed'), speedDisplay = popupElement.querySelector('#vcp-speed-display');
        speedInput.addEventListener('input', () => {
            if (isPopupGloballyBlocked) { updateStatus('Popup controls disabled on this site.'); return; }
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value); desiredPlaybackRate = rate; speedDisplay.textContent = rate.toFixed(2);
            currentVideo && (fixPlaybackRate(currentVideo, rate), updateStatus(`Speed: ${rate.toFixed(2)}x`));
        });

        const volumeInput = popupElement.querySelector('#vcp-volume'), volumeDisplay = popupElement.querySelector('#vcp-volume-display');
        volumeInput.addEventListener('input', () => {
            if (isPopupGloballyBlocked) { updateStatus('Popup controls disabled on this site.'); return; }
            resetPopupHideTimer();
            const vol = parseFloat(volumeInput.value); desiredVolume = vol; volumeDisplay.textContent = Math.round(vol * 100);
            currentVideo && (setNormalVolume(currentVideo, vol), updateStatus(`Volume: ${Math.round(vol * 100)}%`));
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = e => {
            if (isPopupGloballyBlocked || e.target !== dragHandle) return;
            resetPopupHideTimer(); isPopupDragging = true; dragHandle.style.cursor = 'grabbing';
            const [cX, cY] = [e.clientX || (e.touches && e.touches[0].clientX), e.clientY || (e.touches && e.touches[0].clientY)];
            const rect = popupElement.getBoundingClientRect();
            [popupDragOffsetX, popupDragOffsetY] = [cX - rect.left, cY - rect.top];
            popupElement.style.position = 'fixed'; popupElement.style.transform = 'none'; document.body.style.userSelect = 'none';
        };
        const stopDrag = () => {
            if (!isPopupDragging) return;
            isPopupDragging = false; dragHandle.style.cursor = 'grab'; document.body.style.userSelect = '';
            resetPopupHideTimer(); updatePopupPosition();
        };
        const dragPopup = e => {
            if (!isPopupDragging) return;
            const [cX, cY] = [e.clientX || (e.touches && e.touches[0].clientX), e.clientY || (e.touches && e.touches[0].clientY)];
            if (cX === undefined || cY === undefined) return;
            popupElement.style.left = `${cX - popupDragOffsetX}px`; popupElement.style.top = `${cY - popupDragOffsetY}px`;
        };

        dragHandle.addEventListener('mousedown', startDrag); dragHandle.addEventListener('touchstart', startDrag);
        document.addEventListener('mousemove', dragPopup); document.addEventListener('touchmove', dragPopup);
        document.addEventListener('mouseup', stopDrag); document.addEventListener('touchend', stopDrag);
        document.addEventListener('mouseleave', stopDrag);
    }

    function updateStatus(message) {
        const statusElement = popupElement?.querySelector('#vcp-status');
        if (statusElement) statusElement.textContent = `Status: ${message}`;
    }

    function setPopupVisibility(isVisible) {
        if (!popupElement) return;
        if (isPopupGloballyBlocked) {
            popupElement.style.setProperty('display', 'none', 'important');
            popupElement.style.opacity = '0'; popupElement.style.visibility = 'hidden'; return;
        }
        const styles = isVisible ? { display: 'block', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' } : { display: 'none', opacity: '0', visibility: 'hidden' };
        for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
    }

    function showPopup() {
        if (!currentVideo) { hidePopup(); return; }
        if (isPopupGloballyBlocked || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) { hidePopup(); return; }
        setPopupVisibility(true);
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (!isPopupGloballyBlocked && !isPopupDragging) popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
    }

    function updatePopupPosition() {
        if (!currentVideo || isPopupGloballyBlocked || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) { hidePopup(); return; }
        if (!popupElement || !currentVideo || isPopupDragging) return;

        const videoRect = currentVideo.getBoundingClientRect();
        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;

        if (isVideoVisible) {
            const [targetX, targetY] = [videoRect.left + (videoRect.width / 2), videoRect.top + (videoRect.height / 2)];
            popupElement.style.left = `${targetX}px`; popupElement.style.top = `${targetY}px`;
            popupElement.style.transform = 'translate(-50%, -50%)'; popupElement.style.position = 'fixed';
        } else {
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo || isPopupGloballyBlocked || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) return;
        const speedInput = popupElement.querySelector('#vcp-speed'), speedDisplay = popupElement.querySelector('#vcp-speed-display');
        const volumeInput = popupElement.querySelector('#vcp-volume'), volumeDisplay = popupElement.querySelector('#vcp-volume-display');

        speedInput && speedDisplay && (speedInput.value = desiredPlaybackRate.toFixed(2), speedDisplay.textContent = desiredPlaybackRate.toFixed(2));
        volumeInput && volumeDisplay && (volumeInput.value = desiredVolume.toFixed(2), volumeDisplay.textContent = Math.round(desiredVolume * 100));
    }

    // --- Interval and Observer Management ---
    function handleVisibilityChange() {
        if (document.hidden) {
            console.log('[VCP] Document is hidden. Stopping unnecessary checks.');
            stopCheckingVideoStatus();
        } else {
            console.log('[VCP] Document is visible. Resuming checks.');
            // 페이지가 다시 보일 때, 현재 비디오 상태를 기반으로 다시 인터벌 시작
            if (currentVideo && !isPopupGloballyBlocked && !(isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) {
                startCheckingVideoStatus();
            }
        }
    }

    function startCheckingVideoStatus() {
        if (checkVideoInterval) return; // 이미 실행 중이면 중복 실행 방지
        checkVideoInterval = setInterval(() => {
            // 메인 비디오와 팝업 상태 체크
            if (!currentVideo || (!currentVideo.paused && (popupElement.style.display === 'none' || popupElement.style.visibility === 'hidden') && !(isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')))) {
                selectVideoOnDocumentClick(null); // 최적의 비디오를 찾고 제어
            }

            // currentVideo가 유효하다면 배속과 볼륨이 올바른지 확인
            if (currentVideo) {
                currentVideo.playbackRate !== desiredPlaybackRate && fixPlaybackRate(currentVideo, desiredPlaybackRate);
                currentVideo.volume !== desiredVolume && setNormalVolume(currentVideo, desiredVolume);
            }

            // 치지직 미리보기 영상 소리 누출 문제 해결
            if (isChzzkSite) {
                findAllVideosDeep().forEach(v => {
                    if (v !== currentVideo && v.closest('.live_thumbnail_list_item')) {
                        const style = getComputedStyle(v);
                        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity > 0;
                        if (isVisible && !isNaN(v.duration) && v.duration > 0 && (!v.paused || v.volume > 0 || !v.muted)) {
                            if (!originalPlayMethods.has(v)) {
                                originalPlayMethods.set(v, v.play);
                                v.play = () => Promise.resolve(); // play() 호출을 무시
                            }
                            v.pause(); v.muted = true; v.volume = 0; v.currentTime = 0;
                            // console.log('[VCP-Chzzk] Silencing & Blocking extraneous preview video:', v.src || v.tagName);
                        } else if (originalPlayMethods.has(v)) { // 재생 중이 아니면 play() 원본 복원
                            v.play = originalPlayMethods.get(v); originalPlayMethods.delete(v);
                        }
                    } else if (originalPlayMethods.has(v)) { // currentVideo나 미리보기가 아닌 경우 원본 복원
                        v.play = originalPlayMethods.get(v); originalPlayMethods.delete(v);
                    }
                });
            }
            // 팝업이 보이는 상태라면 위치 업데이트 (드래그 중이 아닐 때만)
            popupElement && getComputedStyle(popupElement).display !== 'none' && !isPopupDragging && updatePopupPosition();
        }, AUTO_CHECK_VIDEO_INTERVAL_MS);
    }

    function stopCheckingVideoStatus() {
        if (checkVideoInterval) {
            clearInterval(checkVideoInterval);
            checkVideoInterval = null;
        }
    }

    function setupDOMObserver() {
        const observerConfig = { childList: true, subtree: true, attributes: true };
        domObserver = new MutationObserver(mutationsList => {
            let foundMediaChange = false;
            for (const m of mutationsList) {
                if (m.type === 'childList' && (Array.from(m.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) || Array.from(m.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'))) { foundMediaChange = true; break; }
                else if (m.type === 'attributes' && m.target.matches('video, audio')) { foundMediaChange = true; break; }
            }
            if (foundMediaChange) {
                // DOM 변경 시, 현재 비디오가 유효한지 확인하고 필요하면 비디오를 재선택 (팝업 자동 활성화는 클릭 이벤트에서만)
                updateVideoList();
                if (!currentVideo || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) {
                    selectVideoOnDocumentClick(null);
                } else {
                    // 기존 비디오가 여전히 유효하다면, 팝업 관련 업데이트만 수행
                    updatePopupSliders();
                    updatePopupPosition();
                }
                // DOM 변경 시에는 비디오가 추가/삭제될 수 있으므로, 주기적 체크도 다시 확인
                // (currentVideo가 있으면 시작, 없으면 중지)
                if (currentVideo && !isPopupGloballyBlocked && !(isChzzkSite && currentVideo.closest('.live_thumbnail_list_item'))) {
                     startCheckingVideoStatus();
                } else {
                     stopCheckingVideoStatus();
                }
            }
        });
        domObserver.observe(document.body, observerConfig);
    }

    // --- Event Handlers & Initializers ---
    let scrollTimeout = null;
    function handleScrollEvent() {
        if (isPopupGloballyBlocked) { currentVideo && currentVideo.pause(); currentVideo = null; hidePopup(); return; }
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            // 현재 비디오가 화면 밖으로 나가거나, 미리보기 비디오가 되면 리셋
            if (currentVideo && (!checkCurrentVideoVisibility() || (isChzzkSite && currentVideo.closest('.live_thumbnail_list_item')))) {
                console.log('[VCP] Current video scrolled out of view or became invalid (or is Chzzk preview). Resetting.');
                currentVideo && currentVideo.pause(); currentVideo = null; !isPopupDragging && hidePopup();
                stopCheckingVideoStatus(); // 비디오가 사라지면 인터벌 중지
            }
            // 적합한 비디오가 없거나 팝업이 숨겨져 있다면 재선택 시도 (자동으로 팝업을 띄우지는 않음)
            if (!currentVideo || (popupElement && getComputedStyle(popupElement).display === 'none')) {
                selectVideoOnDocumentClick(null);
            } else if (currentVideo) {
                updatePopupPosition();
            }
        }, 100);
    }

    function setupSPADetection() {
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting popup state.`);
                lastUrl = currentUrl;
                currentVideo && currentVideo.pause(); currentVideo = null; hidePopup(); updateVideoList();
                selectVideoOnDocumentClick(null);
                stopCheckingVideoStatus(); // 페이지 이동 시 인터벌 중지 (새 페이지에서 필요하면 다시 시작)
            }
        }).observe(document, { subtree: true, childList: true });
    }

    function fixOverflow() {
        const overflowFixSites = [
            { domain: 'twitch.tv', selectors: ['div.video-player__container', 'div.video-player-theatre-mode__player', 'div.player-theatre-mode'] },
        ];
        overflowFixSites.forEach(site => {
            if (!location.hostname.includes(site.domain)) return;
            site.selectors.forEach(sel => document.querySelectorAll(sel).forEach(el => el.style.overflow = 'visible'));
        });
        if (isChzzkSite) {
            document.querySelectorAll('.app_content, .paged_list_area').forEach(el => el.style.overflow = 'visible');
            document.querySelectorAll('.live_thumbnail_list_item').forEach(item => {
                const videoContainer = item.querySelector('div[class*="video_area"]');
                videoContainer && videoContainer.style.setProperty('overflow', 'visible', 'important');
            });
        }
    }

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;
        console.log('[VCP] Video Controller Popup script initialized. Version 4.10.42_ReferenceErrorFix_NoAmp_NoButtons_Minified_Rolledback_AutoDetect_FixFlash_FixPosition_ChzzkAudioFix4_Optimized_V2');

        createPopupElement();
        isPopupGloballyBlocked ? setPopupVisibility(false) : hidePopup();

        document.addEventListener('fullscreenchange', () => {
            if (isPopupGloballyBlocked) { popupElement && popupElement.parentNode && popupElement.parentNode.removeChild(popupElement); return; }
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                fsEl ? (fsEl.appendChild(popupElement), updatePopupPosition(), showPopup()) : document.body.appendChild(popupElement);
                updatePopupPosition();
            }
        });

        window.addEventListener('resize', () => {
            isPopupGloballyBlocked ? hidePopup() : updatePopupPosition();
        });
        window.addEventListener('scroll', handleScrollEvent);

        // 문서 가시성 변경 이벤트 (페이지가 활성화/비활성화될 때)
        document.addEventListener('visibilitychange', handleVisibilityChange);

        updateVideoList();
        setupDOMObserver(); // DOM 변경 감지를 위한 Observer
        setupSPADetection();
        fixOverflow();

        document.body.addEventListener('click', selectVideoOnDocumentClick, true);
        document.body.addEventListener('touchend', selectVideoOnDocumentClick, true);

        // 초기 비디오 선택 시도 및 필요하면 setInterval 시작
        selectVideoOnDocumentClick(null);

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and removing popup.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement); popupElement = null;
            }
            stopCheckingVideoStatus(); // 페이지 언로드 시 모든 인터벌 중지
            if (domObserver) domObserver.disconnect(); // 옵저버 해제
        });
    }

    document.readyState === 'complete' || document.readyState === 'interactive' ? initialize() : window.addEventListener('DOMContentLoaded', initialize);
})();
