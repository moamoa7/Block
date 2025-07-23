// ==UserScript==
// @name Video Controller Popup (V4.11.15: 자동재생 개선, 모바일 전체화면 클릭／위치 픽스, IntersectionObserver 최적화)
// @namespace Violentmonkey Scripts
// @version 4.11.15_AutoplayAttemptImprovement_MobileFullScreenClickFix_Debounce_FS_Pos_Restore_RAF_IO_Opt
// @description Core video controls with streamlined UI. All videos auto-play with sound (if possible). Popup shows on click. Features dynamic Play/Pause, 1x speed reset, Mute, and Speak buttons. Improved SPA handling. Minimized UI with horizontal speed slider. Debounced MutationObserver and RequestAnimationFrame for performance. Uses IntersectionObserver for efficient video visibility detection. Restores popup position after fullscreen exit.
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let videos = [], currentVideo = null, popupElement = null, desiredPlaybackRate = 1.0, desiredVolume = 1.0,
        isPopupDragging = false, popupDragOffsetX = 0, popupDragOffsetY = 0, isInitialized = false;
    let isManuallyPaused = false;
    let isManuallyMuted = false;
    let isPopupVisible = false;
    let popupPrevPosition = null;
    let rafId = null;
    let videoObserver = null; // IntersectionObserver 인스턴스
    let observedVideosData = new Map(); // 각 비디오의 교차 비율, ID 등을 저장

    const videoRateHandlers = new WeakMap();
    const originalPlayMethods = new WeakMap();

    // Configuration
    let popupHideTimer = null;
    const POPUP_TIMEOUT_MS = 2000;
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300;

    // MutationObserver 인스턴스를 저장하여 나중에 disconnect 할 수 있도록 전역 변수 추가
    let domMutationObserverInstance = null;
    let spaDetectionObserverInstance = null;

    // 재생 강제 반복 방지용 변수 추가
    let lastPlayState = null; // 'playing', 'paused', null (초기 상태)


    // --- Utility Functions ---
    function findAllVideosDeep(root = document) {
        return Array.from(root.querySelectorAll('video, audio'));
    }

    function findPlayableVideos() {
        const found = findAllVideosDeep();
        const playableVideos = found.filter(v => {
            const style = window.getComputedStyle(v);
            const isMedia = v.tagName === 'AUDIO' || v.tagName === 'VIDEO';
            const rect = v.getBoundingClientRect();
            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity > 0;
            const isReasonableSize = (rect.width >= 50 && rect.height >= 50) || isMedia || !v.paused;
            const hasMedia = v.videoWidth > 0 || v.videoHeight > 0 || isMedia;
            const isWithinViewport = (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
            return isVisible && isReasonableSize && hasMedia && isWithinViewport;
        });
        videos = playableVideos;
        return playableVideos;
    }

    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) { currentVideo.pause(); currentVideo = null; hidePopup(); }
            return;
        }

        if (currentVideo && currentVideo !== videoToControl && originalPlayMethods.has(currentVideo)) {
            currentVideo.play = originalPlayMethods.get(currentVideo);
            originalPlayMethods.delete(currentVideo);
        }

        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
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
            } else {
                if (currentVideo !== videoToControl) {
                    videoToControl.autoplay = true;
                    videoToControl.playsInline = true;

                    videoToControl.muted = false;
                    videoToControl.volume = 1.0;
                    isManuallyMuted = false;

                    videoToControl.play().catch(e => {
                        console.warn("[VCP] Autoplay with sound failed:", e.name, e.message, "Attempting muted autoplay.");
                        videoToControl.muted = true;
                        videoToControl.volume = 0;
                        isManuallyMuted = true;
                        videoToControl.play().catch(mutedError => {
                            console.error("[VCP] Muted autoplay also failed:", mutedError.name, mutedError.message);
                        });
                    });
                }
            }
        });

        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false;
            desiredPlaybackRate = currentVideo.playbackRate;
            desiredVolume = currentVideo.volume;
            isManuallyMuted = currentVideo.muted;
            lastPlayState = null; // 새 비디오 선택 시 재생 상태 초기화
        }

        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume);
        updatePopupSliders();
        // updatePlayPauseButton(); // 재생/멈춤 버튼 제거
        updateMuteSpeakButtons();
    }

    function fixPlaybackRate(video, rate) {
        if (!video || typeof video.playbackRate === 'undefined') return;
        desiredPlaybackRate = rate;

        const existingHandler = videoRateHandlers.get(video);
        if (existingHandler) video.removeEventListener('ratechange', existingHandler);

        const rateChangeHandler = () => {
            if (video.playbackRate !== desiredPlaybackRate) {
                desiredPlaybackRate = video.playbackRate;
                updatePopupSliders();
            }
        };

        if (video.playbackRate !== rate) {
            video.playbackRate = rate;
        }
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

        // 버튼 섹션 수정: grid-template-columns를 1fr 1fr 1fr로 변경하여 3개의 버튼이 나란히 오도록 설정
        const buttonSection = document.createElement('div');
        buttonSection.style.cssText = `
            display: grid;
            grid-template-columns: 1fr 1fr 1fr; /* 3개의 열로 변경 */
            grid-template-rows: 1fr; /* 1개의 행으로 변경 */
            gap: 10px;
            padding: 10px;
            flex-grow: 1;
            align-content: stretch;
            justify-items: stretch;
            min-height: 50px; /* 높이 조정 */
        `;

        const buttonStyle = `
            background-color: #333; color: white; border: 1.5px solid #555;
            padding: 8px 10px;
            border-radius: 4px; cursor: pointer; transition: background-color 0.2s;
            white-space: normal;
            text-align: center; font-size: 14px;
            height: auto;
            min-height: 40px;
            width: 100%;
            min-width: 75px;
            display: flex;
            justify-content: center;
            align-items: center;
            box-sizing: border-box;
            line-height: 1.2;
        `;

        // 재생/멈춤 버튼 제거
        // const playPauseBtn = document.createElement('button');
        // playPauseBtn.setAttribute('data-action', 'play-pause');
        // playPauseBtn.textContent = '재생/멈춤';
        // playPauseBtn.style.cssText = buttonStyle;

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

        // buttonSection.appendChild(playPauseBtn); // 재생/멈춤 버튼 제거
        buttonSection.appendChild(speedResetBtn);
        buttonSection.appendChild(muteBtn);
        buttonSection.appendChild(speakBtn);
        popupElement.appendChild(buttonSection);

        document.body.appendChild(popupElement);
        setupPopupEventListeners();
    }

    function updatePlayPauseButton() {
        // 이 함수는 더 이상 사용되지 않지만, 다른 곳에서 호출될 수 있으므로 일단 비워둠
        // const playPauseBtn = popupElement.querySelector('[data-action="play-pause"]');
        // if (playPauseBtn && currentVideo) {
        //     playPauseBtn.textContent = currentVideo.paused ? '재생' : '멈춤';
        // } else if (playPauseBtn) {
        //     playPauseBtn.textContent = '재생/멈춤';
        // }
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
            // 'play-pause' 케이스 제거
            // case 'play-pause':
            //     if (currentVideo.paused) {
            //         isManuallyPaused = false;
            //         currentVideo.muted = isManuallyMuted;
            //         if (!isManuallyMuted && currentVideo.volume === 0) {
            //             currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
            //         }
            //         currentVideo.play().catch(e => console.error("Play failed:", e));
            //     } else {
            //         isManuallyPaused = true;
            //         currentVideo.pause();
            //     }
            //     lastPlayState = currentVideo.paused ? 'paused' : 'playing';
            //     updatePlayPauseButton();
            //     updateMuteSpeakButtons();
            //     updatePopupSliders();
            //     break;
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
        // updatePlayPauseButton(); // 재생/멈춤 버튼 제거
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
            threshold: [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0] // 5% 단위로 세분화
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

            selectVideoLogic(null); // 모든 교차 변화가 반영된 후 가장 적합한 비디오를 선택
        };

        videoObserver = new IntersectionObserver(observerCallback, observerOptions);
    }

    function updateVideoList() {
        const currentPlayableVideos = findPlayableVideos();

        // 기존에 관찰 중이던 비디오 중 현재 목록에 없는 것은 관찰 중단
        observedVideosData.forEach((value, video) => {
            if (!currentPlayableVideos.includes(video)) {
                if (videoObserver) {
                    videoObserver.unobserve(video);
                    observedVideosData.delete(video);
                }
            }
        });

        // 새로 찾은 비디오 중 아직 관찰하지 않는 비디오는 관찰 시작
        currentPlayableVideos.forEach(video => {
            if (videoObserver && !observedVideosData.has(video)) {
                videoObserver.observe(video);
                // 초기 상태를 반영하기 위해 0으로 시작 (콜백에서 업데이트됨)
                observedVideosData.set(video, { intersectionRatio: 0, timestamp: Date.now() });
            }
        });

        // currentVideo가 유효하지 않으면 초기화
        if (currentVideo && (!document.body.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            hidePopup();
            lastPlayState = null; // 비디오 변경 시 재생 상태 초기화
        }
    }

    // --- 비디오 우선순위 점수 계산 함수 ---
    function calculateVideoScore(video, data) {
        const rect = video.getBoundingClientRect();
        const centerDist = Math.hypot(
            rect.left + rect.width / 2 - window.innerWidth / 2,
            rect.top + rect.height / 2 - window.innerHeight / 2
        );

        // 중앙에 가까울수록 점수가 높아지도록 스케일링
        const centerScore = 1 / Math.pow(1 + centerDist, 5);
        // 비디오가 재생 중이면 매우 높은 가중치 부여
        const isPlayingScore = (!video.paused && video.duration > 0 && !video.ended) ? 10000 : 0;

        // 교차 비율, 중앙 근접도, 재생 상태를 종합한 복합 점수
        return data.intersectionRatio * 10000 + centerScore * 5000 + isPlayingScore;
    }

    // --- 개선된 selectVideoLogic 함수 ---
    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => data.intersectionRatio > 0) // 뷰포트에 보이는 비디오만 필터링
            .map(([video, data]) => ({
                video,
                // 분리된 calculateVideoScore 함수를 사용하여 점수 계산
                score: calculateVideoScore(video, data),
                intersectionRatio: data.intersectionRatio // IntersectionObserver 콜백 디버깅 또는 추가 로직을 위해 유지
            }))
            .sort((a, b) => b.score - a.score); // score 기준 1회만 정렬

        let activeVideo = null;

        // 현재 비디오가 여전히 유효하고 화면에 보이면 그대로 유지 (최우선)
        if (currentVideo && document.body.contains(currentVideo) && observedVideosData.has(currentVideo) && observedVideosData.get(currentVideo).intersectionRatio > 0) {
            activeVideo = currentVideo;
        } else if (candidateVideos.length > 0) {
            // 그 외의 경우, 가장 score가 높은 비디오를 선택
            activeVideo = candidateVideos[0].video;
        }

        if (activeVideo) {
            // 현재 제어 중인 비디오가 새로 선택된 비디오와 다르면 비디오 전환
            if (currentVideo !== activeVideo) {
                if (currentVideo) currentVideo.pause(); // 기존 비디오 일시 정지
                selectAndControlVideo(activeVideo); // 새 비디오 제어 시작
            }

            // 클릭 이벤트 등으로 호출된 경우에만 팝업 표시 및 타이머 재설정
            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
            // 제어할 비디오가 없으면 현재 비디오를 null로 설정하고 팝업 숨김
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            hidePopup();
            lastPlayState = null; // 비디오가 없으면 재생 상태 초기화
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            if (currentVideo && (!document.body.contains(currentVideo) || !observedVideosData.has(currentVideo) || observedVideosData.get(currentVideo).intersectionRatio === 0)) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
                lastPlayState = null; // 스크롤로 비디오 사라지면 재생 상태 초기화
            }
        }, 100);
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

    // --- SPA URL 변경 탐지 함수 (함수화) ---
    function setupSPADetection(onUrlChangeCallback) {
        let lastUrl = location.href;

        const observer = new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                lastUrl = currentUrl;
                onUrlChangeCallback(currentUrl);
            }
        });

        // document 전체를 관찰하여 URL 변경을 감지 (URL 변경은 일반적으로 DOM 변경을 동반함)
        observer.observe(document, { subtree: true, childList: true });

        return observer;
    }

    function fixOverflow() {
        const overflowFixSites = []; // 필요한 경우 특정 사이트의 overflow 이슈를 처리합니다.
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

    // --- requestAnimationFrame 기반 비디오 상태 루프 ---
    function videoStatusLoop() {
        if (!currentVideo && !isPopupVisible) {
            stopVideoStatusLoop();
            return;
        }

        if (currentVideo && !currentVideo.ended) {
            const isPlayingNow = !currentVideo.paused;

            if (currentVideo.playbackRate !== desiredPlaybackRate) {
                currentVideo.playbackRate = desiredPlaybackRate;
            }
            if (Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
                currentVideo.volume = desiredVolume;
            }
            if (currentVideo.muted !== isManuallyMuted) {
                currentVideo.muted = isManuallyMuted;
            }

            // 재생 강제 반복 방지: 상태 변화를 감지해서 play() 호출
            // 비디오가 현재 재생 중이 아니고 (일시 정지 상태), 수동으로 일시 정지한 상태가 아닐 때
            if (!isPlayingNow && !isManuallyPaused) {
                // 이전에 'playing' 상태가 아니었다면 (즉, 'paused' 또는 null 이었다면) play()를 시도
                if (lastPlayState !== 'playing') {
                    currentVideo.play().catch(e => {
                        // play() 실패 시 (예: 사용자 제스처 필요) 콘솔에 경고만 표시
                        console.warn("[VCP] Autoplay attempt failed in loop:", e.name, e.message);
                    });
                    lastPlayState = 'playing'; // 재생 시도 후 상태를 'playing'으로 변경
                }
            } else if (isPlayingNow) {
                // 비디오가 현재 재생 중이라면 상태를 'playing'으로 유지
                lastPlayState = 'playing';
            } else {
                // 그 외의 경우 (예: 수동 일시 정지 상태), 상태를 'paused'로 유지
                lastPlayState = 'paused';
            }
        }

        // currentVideo를 제외한 다른 모든 비디오는 일시 정지 및 음소거
        findAllVideosDeep().forEach(video => {
            if (video !== currentVideo) {
                if (!video.paused) { video.pause(); }
                if (!video.muted || video.volume > 0) { video.muted = true; video.volume = 0; }
            }
        });

        // 팝업이 보이고 드래그 중이 아니면 팝업 UI 업데이트
        if (popupElement && isPopupVisible && !isPopupDragging) {
            updatePopupPosition();
            // updatePlayPauseButton(); // 재생/멈춤 버튼 제거
            updateMuteSpeakButtons();
            updatePopupSliders();
        }

        // 다음 애니메이션 프레임에 루프 다시 실행
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
            lastPlayState = null; // 루프 중단 시 재생 상태 초기화
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
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }
        if (touchMoved) { touchMoved = false; return; }
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) return;
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) hidePopup();
        selectVideoLogic(e);
    }, true);

    document.body.addEventListener('touchend', (e) => {
        if (!e) return;
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) { resetPopupHideTimer(); return; }
        if (touchMoved) { touchMoved = false; return; }
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) return;
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) hidePopup();
        selectVideoLogic(e);
    }, true);
    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 끝 ---

    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.15_IntersectionObserver_Opt (Bugfix applied)');

        createPopupElement();
        hidePopup();

        setupIntersectionObserver();
        updateVideoList(); // 초기 비디오 목록 감지 시작

        // --- DOM 변경 감지 및 SPA URL 변경 감지 초기화 ---
        domMutationObserverInstance = setupDebouncedDOMObserver(() => {
            console.log('[VCP] DOM 변경 감지 (데바운스) - 비디오 목록 갱신');
            updateVideoList();
        }, DEBOUNCE_MUTATION_OBSERVER_MS);

        spaDetectionObserverInstance = setupSPADetection((newUrl) => {
            console.log(`[VCP] SPA URL 변경 감지: ${newUrl} - 비디오 상태 초기화`);
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            hidePopup();
            lastPlayState = null; // SPA 변경 시 재생 상태 초기화
            updateVideoList();
        });
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

        window.addEventListener('scroll', handleScrollEvent);

        fixOverflow();

        startVideoStatusLoop();

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
            if (spaDetectionObserverInstance) {
                spaDetectionObserverInstance.disconnect();
                spaDetectionObserverInstance = null;
            }
        });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
