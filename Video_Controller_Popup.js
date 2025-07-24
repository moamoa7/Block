// ==UserScript==
// @name Video Controller Popup (V4.11.17: 스크롤 passive 최적화)
// @namespace Violentmonkey Scripts
// @version 4.11.17_NoForcedControl_NoPlayPauseBtn_HorizontalBtns_EnhancedSPADetection_PassiveScroll
// @description Core video controls with streamlined UI. NO FORCED AUTOPLAY, PAUSE, or MUTE. Popup shows on click. Features dynamic 1x speed reset, Mute, and Speak buttons on a single row. Enhanced SPA handling with History API interception. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Uses IntersectionObserver for efficient video visibility detection. Restores popup position after fullscreen exit. Includes passive scroll event listener for smoother performance.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyMuted = false;  // 사용자가 팝업에서 수동으로 음소거했는지 여부
    let isPopupVisible = false;
    let popupPrevPosition = null;
    let rafId = null;
    let videoObserver = null; // IntersectionObserver 인스턴스
    let observedVideosData = new Map(); // 각 비디오의 교차 비율, ID 등을 저장

    const videoRateHandlers = new WeakMap();

    // Configuration
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300;

    // MutationObserver 인스턴스를 저장하여 나중에 disconnect 할 수 있도록 전역 변수 추가
    let domMutationObserverInstance = null;
    let spaDetectionObserverInstance = null; // History API 감지용으로 이름 변경 또는 추가

    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        let videos = Array.from(root.querySelectorAll('video, audio'));
        return videos;
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
            return isVisible && isReasonableSize && hasMedia && isWithinViewport;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) {
                // 이전 currentVideo에 대한 추가적인 정리 로직이 필요하다면 여기에 추가 (현재는 필요 없음)
            }
            currentVideo = null;
            hidePopup();
            return;
        }

        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;

            isManuallyMuted = currentVideo.muted;
            desiredPlaybackRate = currentVideo.playbackRate;
            desiredVolume = currentVideo.volume;
        }

        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume);

        updatePopupSliders();
        updateMuteSpeakButtons();
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };
        video.addEventListener('ratechange', rateChangeHandler);
        videoRateHandlers.set(video, rateChangeHandler);

        updatePopupSliders();
    }

    function setNormalVolume(video, vol) {
        if (!video || typeof video.volume === 'undefined') return;
        desiredVolume = vol;

        video.volume = Math.max(0, Math.min(1.0, desiredVolume));
        video.muted = isManuallyMuted || (desiredVolume === 0);

        updateMuteSpeakButtons();
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
            width: fit-content;
            min-width: 280px;
            overflow: hidden; text-align: center; pointer-events: auto;
            display: flex;
            flex-direction: column;
            align-items: stretch;
        `;

        const dragHandle = document.createElement('div');
        dragHandle.id = 'vcp-drag-handle';
        dragHandle.textContent = '비디오.오디오 컨트롤러';
        dragHandle.style.cssText = `
            font-weight: bold; color: #ccc; padding: 5px;
            background-color: #2a2a2a; border-bottom: 1px solid #444; cursor: grab;
            border-radius: 6px 6px 0 0; user-select: none; font-size: 16px;
        `;
        popupElement.appendChild(dragHandle);

        const speedSection = document.createElement('div');
        speedSection.className = 'vcp-section-speed';
        speedSection.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 10px;
            gap: 5px;
            border-bottom: 1px solid #444;
        `;

        const speedDisplay = document.createElement('span');
        speedDisplay.id = 'vcp-speed-display';
        speedDisplay.textContent = '1.00x';
        speedDisplay.style.cssText = 'color: #eee; font-size: 1.2em; font-weight: bold; width: 100%; text-align: center;';

        const speedInput = document.createElement('input');
        speedInput.type = 'range';
        speedInput.id = 'vcp-speed';
        speedInput.min = '0.2';
        speedInput.max = '16.0';
        speedInput.step = '0.1';
        speedInput.value = '1.0';
        speedInput.style.cssText = `
            width: 90%;
            height: 10px;
            -webkit-appearance: none;
            appearance: none;
            background: #555;
            outline: none;
            border-radius: 5px;
            cursor: pointer;
            margin: 0;
            padding: 0;
        `;

        speedSection.appendChild(speedDisplay);
        speedSection.appendChild(speedInput);
        popupElement.appendChild(speedSection);

        // --- buttonSection 스타일 변경 ---
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: flex; /* Flexbox 사용 */
            flex-direction: row; /* 가로 배열 */
            justify-content: space-around; /* 버튼들을 공간에 고르게 분배 */
            align-items: center; /* 세로 중앙 정렬 */
            gap: 10px; /* 버튼 간격 */
            padding: 10px;
            flex-grow: 1;
            min-height: 50px;
        `;
        // --- buttonSection 스타일 변경 끝 ---

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: normal;
            text-align: center; font-size: 14px;
            height: auto;
            min-height: 40px;
            flex-basis: 0; /* flex item의 기본 크기를 0으로 설정 */
            flex-grow: 1; /* 남은 공간을 균등하게 차지하도록 설정 */
            max-width: 100px; /* 각 버튼의 최대 너비 설정 (선택 사항) */
            display: flex;
            justify-content: center;
            align-items: center;
            box-sizing: border-box;
            line-height: 1.2;
        `;

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

        buttonSection.appendChild(speedResetBtn);
        buttonSection.appendChild(muteBtn);
        buttonSection.appendChild(speakBtn);
        popupElement.appendChild(buttonSection);

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function updateMuteSpeakButtons() {
        const muteBtn = popupElement.querySelector('[data-action="mute"]');
        const speakBtn = popupElement.querySelector('[data-action="speak"]');
        if (muteBtn && speakBtn && currentVideo) {
            if (currentVideo.muted) {
                muteBtn.style.backgroundColor = '#555';
                speakBtn.style.backgroundColor = '#333';
            } else {
                muteBtn.style.backgroundColor = '#333';
                speakBtn.style.backgroundColor = '#555';
            }
        } else if (muteBtn && speakBtn) {
            muteBtn.style.backgroundColor = '#333';
            speakBtn.style.backgroundColor = '#333';
        }
    }

    function handleButtonClick(action) {
        if (!currentVideo) { return; }
        resetPopupHideTimer();

        switch (action) {
            case 'reset-speed':
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0);
                break;
            case 'mute':
                if (!currentVideo.muted) {
                    isManuallyMuted = true;
                    setNormalVolume(currentVideo, 0);
                }
                updateMuteSpeakButtons();
                break;
            case 'speak':
                isManuallyMuted = false;
                setNormalVolume(currentVideo, 1.0);
                updateMuteSpeakButtons();
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
            resetPopupHideTimer();
            const rate = parseFloat(speedInput.value);
            if (currentVideo) { fixPlaybackRate(currentVideo, rate); }
            speedDisplay.textContent = rate.toFixed(2) + 'x';
        });

        const dragHandle = popupElement.querySelector('#vcp-drag-handle');
        const startDrag = (e) => {
            if (e.target !== dragHandle) return;
            resetPopupHideTimer();
            isPopupDragging = true;
            dragHandle.style.cursor = 'grabbing';
            const clientX = e.clientX || (e.touches && e.touches[0].clientX);
            const clientY = e.clientY || (e.touches && e.touches[0].clientY);
            if (clientX === undefined || clientY === undefined) return;
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
            const styles = { display: 'flex', opacity: '0.75', visibility: 'visible', pointerEvents: 'auto', zIndex: '2147483647' };
            for (const key in styles) popupElement.style.setProperty(key, styles[key], 'important');
            isPopupVisible = true;
        } else {
            if (popupHideTimer) {
                clearTimeout(popupHideTimer);
                popupHideTimer = null;
            }
            popupElement.style.display = 'none';
            popupElement.style.opacity = '0';
            popupElement.style.visibility = 'hidden';
            isPopupVisible = false;
        }
    }

    function showPopup() {
        if (!currentVideo) {
            hidePopup();
            return;
        }

        setPopupVisibility(true);
        updatePopupPosition();
        updateMuteSpeakButtons();
        updatePopupSliders();
    }

    function hidePopup() { setPopupVisibility(false); }

    function resetPopupHideTimer() {
        if (popupHideTimer) clearTimeout(popupHideTimer);
        if (!isPopupDragging && isPopupVisible) {
            popupHideTimer = setTimeout(hidePopup, POPUP_TIMEOUT_MS);
        }
    }

    function updatePopupPosition() {
        if (!currentVideo || !popupElement || isPopupDragging) {
            return;
        }

        const videoRect = currentVideo.getBoundingClientRect();
        let popupRect = popupElement.getBoundingClientRect();

        const fsEl = document.fullscreenElement;

        if (fsEl) {
            popupElement.style.width = '280px';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'absolute';
            popupElement.style.transform = 'none';

            popupRect = popupElement.getBoundingClientRect();

            const fsRect = fsEl.getBoundingClientRect();

            let targetX = videoRect.left - fsRect.left + (videoRect.width / 2);
            let targetY = videoRect.top - fsRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = targetY - (popupRect.height / 2);

            adjustedX = Math.max(0, Math.min(adjustedX, fsRect.width - popupRect.width));
            adjustedY = Math.max(0, Math.min(adjustedY, fsRect.height - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;

        } else {
            popupElement.style.width = 'fit-content';
            popupElement.style.minWidth = '280px';
            popupElement.style.height = 'auto';
            popupElement.style.minHeight = '150px';
            popupElement.style.position = 'fixed';
            popupElement.style.transform = 'none';

            popupRect = popupElement.getBoundingClientRect();

            let targetX = videoRect.left + (videoRect.width / 2);
            let targetY = videoRect.top + (videoRect.height / 2);

            let adjustedX = targetX - (popupRect.width / 2);
            let adjustedY = Math.max(0, Math.min(targetY - (popupRect.height / 2), window.innerHeight - popupRect.height));

            popupElement.style.left = `${adjustedX}px`;
            popupElement.style.top = `${adjustedY}px`;
        }

        const isVideoVisible = videoRect.top < window.innerHeight && videoRect.bottom > 0 && videoRect.left < window.innerWidth && videoRect.right > 0;
        if (!isVideoVisible) {
            hidePopup();
        }
    }

    function updatePopupSliders() {
        if (!popupElement || !currentVideo) return;

        const speedInput = popupElement.querySelector('#vcp-speed');
        const speedDisplay = popupElement.querySelector('#vcp-speed-display');

        if (speedInput && speedDisplay) {
            const rate = currentVideo.playbackRate;
            speedInput.value = rate.toFixed(1);
            speedDisplay.textContent = rate.toFixed(2) + 'x';
            desiredPlaybackRate = rate;
        }
    }

    // --- IntersectionObserver 관련 함수 ---
    function setupIntersectionObserver() {
        const observerOptions = {
            root: null, // 뷰포트 기준
            rootMargin: '0px',
            threshold: [0.3, 0.5, 0.7, 1.0] // 세분화 간략화
        };

        const observerCallback = (entries) => {
            entries.forEach(entry => {
                const video = entry.target;
                if (entry.isIntersecting) {
                    observedVideosData.set(video, {
                        intersectionRatio: entry.intersectionRatio,
                        timestamp: Date.now() // 최신 정보임을 나타내기 위해 타임스탬프 추가
                    });
                } else {
                    observedVideosData.delete(video); // 화면에서 완전히 벗어나면 Map에서 제거
                }
            });

            selectVideoLogic(null);
        };

        videoObserver = new IntersectionObserver(observerCallback, observerOptions);
    }

    function updateVideoList() {
        const currentPlayableVideos = findPlayableVideos();

        observedVideosData.forEach((value, video) => {
            if (!currentPlayableVideos.includes(video)) {
                if (videoObserver) {
                    videoObserver.unobserve(video);
                    observedVideosData.delete(video);
                }
            }
        });

        currentPlayableVideos.forEach(video => {
            if (videoObserver && !observedVideosData.has(video)) {
                videoObserver.observe(video);
                observedVideosData.set(video, { intersectionRatio: 0, timestamp: Date.now() });
            }
        });

        if (currentVideo && (!document.body.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            currentVideo = null;
            hidePopup();
        }
    }

    // --- 비디오 우선순위 점수 계산 함수 (새로운 로직 적용) ---
    function calculateVideoScore(video) {
        const rect = video.getBoundingClientRect();
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);

        const centerDist = Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);
        const centerScore = 1 / Math.pow(1 + centerDist, 5);

        const score = visibleArea * 0.7 + centerScore * 5000 * 0.3;

        return score;
    }

    // --- 교차 비율을 계산하는 별도 함수 (기존 intersectionRatio와는 다르게, 전체 면적 대비 가시 면적 비율) ---
    function calculateIntersectionRatio(video) {
        const rect = video.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return 0;

        const visibleWidth = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleHeight = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visibleArea = Math.max(0, visibleWidth) * Math.max(0, visibleHeight);
        const totalArea = rect.width * rect.height;

        return totalArea > 0 ? visibleArea / totalArea : 0;
    }


    // --- 개선된 selectVideoLogic 함수 ---
    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => data.intersectionRatio > 0)
            .map(([video, data]) => ({
                video,
                score: calculateVideoScore(video),
                intersectionRatio: calculateIntersectionRatio(video)
            }))
            .sort((a, b) => b.score - a.score);

        let activeVideo = null;

        if (candidateVideos.length > 0) {
            activeVideo = candidateVideos[0].video;
        }

        if (activeVideo) {
            if (currentVideo !== activeVideo) {
                selectAndControlVideo(activeVideo);
            }

            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
            currentVideo = null;
            hidePopup();
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            // 스크롤 멈춘 후 실행할 작업
            updateVideoList();
            if (currentVideo && (!document.body.contains(currentVideo) || !observedVideosData.has(currentVideo) || observedVideosData.get(currentVideo).intersectionRatio === 0)) {
                currentVideo = null;
                hidePopup();
            }
        }, 100); // 100ms Debounce
    }

    // --- DOM 변경 감지 및 데바운스 처리 함수 (함수화) ---
    function setupDebouncedDOMObserver(onChangeCallback, debounceMs = 300) {
        let debounceTimer = null;

        const observerCallback = (mutationsList) => {
            let mediaChanged = false;

            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    const addedHasMedia = Array.from(mutation.addedNodes).some(n =>
                        n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' ||
                        (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))
                    );
                    const removedHasMedia = Array.from(mutation.removedNodes).some(n =>
                        n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO'
                    );
                    if (addedHasMedia || removedHasMedia) {
                        mediaChanged = true;
                        break;
                    }
                } else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    if (['src', 'controls', 'style'].includes(mutation.attributeName)) {
                        mediaChanged = true;
                        break;
                    }
                }
            }

            if (mediaChanged) {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => {
                    onChangeCallback();
                    debounceTimer = null;
                }, debounceMs);
            }
        };

        const observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });

        return observer;
    }

    // --- SPA URL 변경 탐지 함수 (MutationObserver 방식) ---
    function setupSPADetection(onUrlChangeCallback) {
        let lastUrl = location.href;

        const observer = new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP][SPA-MO] URL 변경 감지: ${lastUrl} -> ${currentUrl}`);
                lastUrl = currentUrl;
                onUrlChangeCallback(currentUrl);
            }
        });

        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] }); // href 속성 변경도 감지
        return observer;
    }

    // --- History API 감싸기 (SPA URL 변경 감지 강화) ---
    function setupHistoryListener(onUrlChangeCallback) {
        let lastUrl = location.href;

        function checkUrlChange() {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP][SPA-History] URL 변경 감지: ${lastUrl} -> ${currentUrl}`);
                lastUrl = currentUrl;
                onUrlChangeCallback(currentUrl);
            }
        }

        // 원래 함수 저장 및 재정의
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function(...args) {
            originalPushState.apply(this, args);
            checkUrlChange();
        };

        history.replaceState = function(...args) {
            originalReplaceState.apply(this, args);
            checkUrlChange();
        };

        // popstate 이벤트 리스너 추가 (뒤로가기/앞으로가기 버튼 감지)
        window.addEventListener('popstate', checkUrlChange);
    }

    function fixOverflow() {
        // 이 함수는 현재 아무런 강제 스타일 변경을 하지 않음
    }

    // --- requestAnimationFrame 기반 비디오 상태 루프 ---
    function videoStatusLoop() {
        if (!currentVideo && !isPopupVisible) {
            stopVideoStatusLoop();
            return;
        }

        if (currentVideo) {
            if (currentVideo.playbackRate !== desiredPlaybackRate) {
                currentVideo.playbackRate = desiredPlaybackRate;
            }
            if (currentVideo.muted !== isManuallyMuted) {
                currentVideo.muted = isManuallyMuted;
            }
            if (!currentVideo.muted && Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
                currentVideo.volume = desiredVolume;
            }
        }

        if (popupElement && isPopupVisible && !isPopupDragging) {
            updatePopupPosition();
            updateMuteSpeakButtons();
            updatePopupSliders();
        }

        rafId = requestAnimationFrame(videoStatusLoop);
    }

    function startVideoStatusLoop() {
        if (!rafId) {
            rafId = requestAnimationFrame(videoStatusLoop);
            console.log('[VCP] Video status loop started with requestAnimationFrame.');
        }
    }

    function stopVideoStatusLoop() {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
            console.log('[VCP] Video status loop stopped.');
        }
    }
    // --- requestAnimationFrame 기반 비디오 상태 루프 끝 ---

    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 ---
    let touchStartX = 0;
    let touchStartY = 0;
    let touchMoved = false;
    const TOUCH_MOVE_THRESHOLD = 10;

    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches ? e.touches.item(0).clientX : e.clientX;
        touchStartY = e.touches ? e.touches.item(0).clientY : e.clientY;
        touchMoved = false;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!e.touches) return;
        const touch = e.touches.item(0);
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
            touchMoved = true;
        }
    }, { passive: true });

    document.body.addEventListener('click', (e) => {
        if (!e) return;
        // 팝업을 클릭한 경우는 팝업 숨김 타이머만 재설정하고 리턴
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }
        // 터치 드래그가 발생한 경우 (클릭으로 간주하지 않음)
        if (touchMoved) { touchMoved = false; return; }
        // 링크나 클릭 가능한 UI 요소를 클릭한 경우 스크립트가 비디오를 선택하지 않음
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) return;

        // 팝업이 보이고, 팝업 바깥을 클릭한 경우 팝업 숨김
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }
        // 이외의 경우 (비디오 영역 클릭 등으로 간주), 비디오 선택 로직 실행
        selectVideoLogic(e);
    }, true); // 캡처링 단계에서 이벤트 리스닝

    document.body.addEventListener('touchend', (e) => {
        if (!e) return;
        // 팝업을 터치한 경우는 팝업 숨김 타이머만 재설정하고 리턴
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }
        // 터치 드래그가 발생한 경우 (클릭으로 간주하지 않음)
        if (touchMoved) { touchMoved = false; return; }
        // 링크나 클릭 가능한 UI 요소를 터치한 경우 스크립트가 비디오를 선택하지 않음
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) return;

        // 팝업이 보이고, 팝업 바깥을 터치한 경우 팝업 숨김
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }
        // 이외의 경우 (비디오 영역 터치 등으로 간주), 비디오 선택 로직 실행
        selectVideoLogic(e);
    }, true); // 캡처링 단계에서 이벤트 리스닝
    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 끝 ---

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.17_NoForcedControl_NoPlayPauseBtn_HorizontalBtns_EnhancedSPADetection_PassiveScroll.');

        createPopupElement();
        hidePopup(); // 팝업은 초기에는 숨겨둡니다.

        console.log('[VCP] Initial forced pause/mute/play logic removed.');

        setupIntersectionObserver();
        updateVideoList(); // 초기 비디오 목록 감지 시작

        // 초기 selectVideoLogic 호출 (다른 비디오를 멈추지 않고, currentVideo만 설정)
        selectVideoLogic(null);

        // --- DOM 변경 감지 및 SPA URL 변경 감지 초기화 ---
        const handleSpaUrlChange = (newUrl) => {
            console.log(`[VCP] SPA URL 변경 감지 콜백: ${newUrl} - 비디오 상태 초기화`);
            currentVideo = null; // currentVideo만 초기화
            hidePopup();
            updateVideoList();
            selectVideoLogic(null); // SPA 변경 시에도 다시 비디오 선택 로직 실행
        };

        // MutationObserver 방식 활성화
        domMutationObserverInstance = setupDebouncedDOMObserver(() => {
            console.log('[VCP] DOM 변경 감지 (데바운스) - 비디오 목록 갱신');
            updateVideoList();
            selectVideoLogic(null);
        }, DEBOUNCE_MUTATION_OBSERVER_MS);

        // History API 감지 방식 활성화 (SPA URL 변경 감지 강화)
        setupHistoryListener(handleSpaUrlChange);
        spaDetectionObserverInstance = setupSPADetection(handleSpaUrlChange); // MutationObserver 방식은 이 변수에 할당 유지

        // --- 초기화 끝 ---

        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    popupPrevPosition = {
                        left: popupElement.style.left,
                        top: popupElement.style.top,
                    };
                    fsEl.appendChild(popupElement);
                    popupElement.style.width = '280px';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'absolute';
                    popupElement.style.transform = 'none';

                    updatePopupPosition();
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    document.body.appendChild(popupElement);
                    if (popupPrevPosition) {
                        popupElement.style.left = popupPrevPosition.left;
                        popupElement.style.top = popupPrevPosition.top;
                        console.log('[VCP] Restored popup position to:', popupPrevPosition.left, popupPrevPosition.top);
                    } else {
                        updatePopupPosition();
                    }
                    popupElement.style.width = 'fit-content';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'fixed';
                    popupElement.style.transform = 'none';

                    hidePopup();
                }
            }
        });

        window.addEventListener('resize', () => {
            updatePopupPosition();
        });

        // --- 스크롤 이벤트 리스너에 passive: true 옵션 추가 ---
        window.addEventListener('scroll', handleScrollEvent, { passive: true });
        // --- 스크롤 이벤트 리스너 변경 끝 ---

        fixOverflow(); // 이 함수는 현재 아무런 강제 스타일 변경을 하지 않음

        startVideoStatusLoop(); // 스크립트의 주 루프 시작

        window.addEventListener('beforeunload', () => {
            console.log('[VCP] Page unloading. Clearing current video and stopping loops.');
            currentVideo = null;
            if (popupElement && popupElement.parentNode) {
                popupElement.parentNode.removeChild(popupElement);
                popupElement = null;
            }
            stopVideoStatusLoop();
            if (videoObserver) {
                videoObserver.disconnect();
                videoObserver = null;
                observedVideosData.clear();
            }
            // MutationObserver 인스턴스 해제
            if (domMutationObserverInstance) {
                domMutationObserverInstance.disconnect();
                domMutationObserverInstance = null;
            }
            if (spaDetectionObserverInstance) { // 이 변수는 이제 History API 감지에도 사용될 수 있음
                // History API 감지 함수는 Observer 인스턴스를 반환하지 않으므로, 이 부분은 MutationObserver에만 해당
                spaDetectionObserverInstance.disconnect();
                spaDetectionObserverInstance = null;
            }
            // History API는 재정의되므로 별도의 해제 로직이 필요 없음. popstate 리스너는 window가 언로드되면 자동으로 해제됨.
        });
    }

    // 문서 로딩 상태에 따라 초기화
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
