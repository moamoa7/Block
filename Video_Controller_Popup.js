// ==UserScript==
// @name         Video Controller Popup - UI Sync Fix
// @namespace    http://tampermonkey.net/
// @version      4.11.16_UI_Sync_Fix
// @description  Enhances video and audio playback control with a popup, improved autoplay, intelligent video selection, and UI synchronization.
// @author       YourName (Original by Others, Modified by Gemini)
// @match        *://*/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration Constants ---
    const POPUP_HIDE_DELAY_MS = 3000; // 팝업이 자동으로 숨겨지는 시간 (ms)
    const DEBOUNCE_MUTATION_OBSERVER_MS = 300; // DOM 변경 감지 디바운스 시간 (ms)

    // --- Global Variables ---
    let popupElement = null;
    let playPauseButton = null;
    let speedSlider = null;
    let volumeSlider = null;
    let muteButton = null;
    let speakButton = null;
    let speedValueDisplay = null;
    let volumeValueDisplay = null;

    let currentVideo = null; // 현재 제어 중인 비디오 요소
    let desiredPlaybackRate = 1.0; // 사용자가 설정한 원하는 재생 속도
    let desiredVolume = 1.0; // 사용자가 설정한 원하는 볼륨
    let isManuallyPaused = false; // 사용자가 직접 일시정지했는지 여부
    let isManuallyMuted = false; // 사용자가 직접 음소거했는지 여부
    let popupHideTimer = null;
    let isPopupVisible = false;
    let isPopupDragging = false;
    let rafId = null; // requestAnimationFrame ID
    let isInitialized = false; // 스크립트 초기화 여부

    let videoObserver = null; // IntersectionObserver 인스턴스
    const observedVideosData = new Map(); // 관찰 중인 비디오 요소와 그 데이터 (intersectionRatio, timestamp)

    let popupPrevPosition = null; // 전체 화면 진입 전 팝업 위치 저장

    // 브라우저의 기본 play 메소드를 저장하여 오버라이드 후 복원하기 위함
    const originalPlayMethods = new WeakMap();

    // --- Utility Functions ---

    /**
     * 모든 비디오 요소를 찾아 반환합니다. 섀도우 돔 내부의 비디오도 포함합니다.
     * @returns {HTMLVideoElement[]} 발견된 비디오 요소 배열
     */
    function findAllVideosDeep() {
        const videos = Array.from(document.querySelectorAll('video'));
        // 섀도우 돔 내부의 비디오 찾기 (일부 웹사이트에서 사용)
        document.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                el.shadowRoot.querySelectorAll('video').forEach(shadowVideo => {
                    videos.push(shadowVideo);
                });
            }
        });
        return Array.from(new Set(videos)); // 중복 제거
    }

    /**
     * 팝업 요소를 생성하고 DOM에 추가합니다.
     */
    function createPopupElement() {
        if (popupElement) return;

        popupElement = document.createElement('div');
        popupElement.id = 'video-controller-popup';
        popupElement.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(0, 0, 0, 0.7);
            border-radius: 8px;
            padding: 10px;
            color: white;
            z-index: 99999;
            font-family: Arial, sans-serif;
            font-size: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            cursor: grab;
            resize: both; /* 크기 조절 가능 */
            overflow: auto; /* 내용이 넘칠 경우 스크롤바 */
            min-width: 280px;
            width: fit-content;
            height: auto;
            min-height: 150px;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
            transition: opacity 0.2s ease-in-out;
        `;

        popupElement.innerHTML = `
            <div style="font-weight: bold; text-align: center; margin-bottom: 5px;">Video Controller</div>
            <div style="display: flex; align-items: center; gap: 5px;">
                <button id="vcp-play-pause-btn" style="flex-shrink: 0; padding: 8px 12px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; min-width: 80px;">▶ Play</button>
                <div style="flex-grow: 1; display: flex; flex-direction: column;">
                    <label for="vcp-speed-slider" style="display: flex; justify-content: space-between; align-items: center;">
                        <span>Speed:</span>
                        <span id="vcp-speed-value">1.0x</span>
                    </label>
                    <input type="range" id="vcp-speed-slider" min="0.5" max="4.0" step="0.1" value="1.0" style="width: 100%;">
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 5px;">
                <button id="vcp-mute-btn" style="flex-shrink: 0; padding: 8px 12px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; min-width: 80px;">🔇 Mute</button>
                <button id="vcp-speak-btn" style="flex-shrink: 0; padding: 8px 12px; background: #2196F3; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; min-width: 80px; display: none;">🔊 Speak</button>
                <div style="flex-grow: 1; display: flex; flex-direction: column;">
                    <label for="vcp-volume-slider" style="display: flex; justify-content: space-between; align-items: center;">
                        <span>Volume:</span>
                        <span id="vcp-volume-value">100%</span>
                    </label>
                    <input type="range" id="vcp-volume-slider" min="0" max="1" step="0.01" value="1" style="width: 100%;">
                </div>
            </div>
            <div style="text-align: center;">
                <button id="vcp-reset-speed-btn" style="padding: 5px 10px; background: #607D8B; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">Reset Speed</button>
            </div>
        `;

        document.body.appendChild(popupElement);
        attachPopupEvents();
    }

    /**
     * 팝업 관련 UI 요소 참조를 가져오고 이벤트 리스너를 붙입니다.
     */
    function attachPopupEvents() {
        playPauseButton = popupElement.querySelector('#vcp-play-pause-btn');
        speedSlider = popupElement.querySelector('#vcp-speed-slider');
        volumeSlider = popupElement.querySelector('#vcp-volume-slider');
        muteButton = popupElement.querySelector('#vcp-mute-btn');
        speakButton = popupElement.querySelector('#vcp-speak-btn');
        speedValueDisplay = popupElement.querySelector('#vcp-speed-value');
        volumeValueDisplay = popupElement.querySelector('#vcp-volume-value');
        const resetSpeedButton = popupElement.querySelector('#vcp-reset-speed-btn');

        playPauseButton.addEventListener('click', () => handleButtonClick('play-pause'));
        speedSlider.addEventListener('input', (e) => {
            desiredPlaybackRate = parseFloat(e.target.value);
            if (currentVideo) {
                fixPlaybackRate(currentVideo, desiredPlaybackRate);
            }
            speedValueDisplay.textContent = `${desiredPlaybackRate.toFixed(1)}x`;
            resetPopupHideTimer();
        });
        volumeSlider.addEventListener('input', (e) => {
            desiredVolume = parseFloat(e.target.value);
            if (currentVideo) {
                setNormalVolume(currentVideo, desiredVolume);
            }
            volumeValueDisplay.textContent = `${Math.round(desiredVolume * 100)}%`;
            resetPopupHideTimer();
        });
        muteButton.addEventListener('click', () => handleButtonClick('mute'));
        speakButton.addEventListener('click', () => handleButtonClick('speak'));
        resetSpeedButton.addEventListener('click', () => handleButtonClick('reset-speed'));

        // 팝업 드래그 기능
        let offsetX, offsetY;
        popupElement.addEventListener('mousedown', (e) => {
            if (e.target === popupElement || e.target.id === 'video-controller-popup' || e.target.parentNode.id === 'video-controller-popup') {
                isPopupDragging = true;
                popupElement.style.cursor = 'grabbing';
                offsetX = e.clientX - popupElement.getBoundingClientRect().left;
                offsetY = e.clientY - popupElement.getBoundingClientRect().top;
                popupElement.style.userSelect = 'none'; // 드래그 중 텍스트 선택 방지
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isPopupDragging) return;
            popupElement.style.left = `${e.clientX - offsetX}px`;
            popupElement.style.top = `${e.clientY - offsetY}px`;
        });

        document.addEventListener('mouseup', () => {
            isPopupDragging = false;
            popupElement.style.cursor = 'grab';
            popupElement.style.userSelect = 'auto';
        });

        // 모바일 터치 드래그
        popupElement.addEventListener('touchstart', (e) => {
            if (e.target === popupElement || e.target.id === 'video-controller-popup' || e.target.parentNode.id === 'video-controller-popup') {
                isPopupDragging = true;
                popupElement.style.cursor = 'grabbing';
                const touch = e.touches[0];
                offsetX = touch.clientX - popupElement.getBoundingClientRect().left;
                offsetY = touch.clientY - popupElement.getBoundingClientRect().top;
                popupElement.style.userSelect = 'none';
            }
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!isPopupDragging || !e.touches[0]) return;
            const touch = e.touches[0];
            popupElement.style.left = `${touch.clientX - offsetX}px`;
            popupElement.style.top = `${touch.clientY - offsetY}px`;
            e.preventDefault(); // 스크롤 방지
        }, { passive: false });

        document.addEventListener('touchend', () => {
            isPopupDragging = false;
            popupElement.style.cursor = 'grab';
            popupElement.style.userSelect = 'auto';
        });
    }

    /**
     * 팝업을 표시합니다.
     */
    function showPopup() {
        if (!popupElement) return;
        popupElement.style.display = 'flex';
        popupElement.style.opacity = '1';
        isPopupVisible = true;
        startVideoStatusLoop(); // 팝업이 보일 때 루프 시작
    }

    /**
     * 팝업을 숨깁니다.
     */
    function hidePopup() {
        if (!popupElement) return;
        popupElement.style.opacity = '0';
        setTimeout(() => {
            if (isPopupVisible) { // 이전에 showPopup이 호출되어 true인 경우만 display none 처리
                 popupElement.style.display = 'none';
            }
        }, 200); // opacity transition duration
        isPopupVisible = false;
        // 팝업이 숨겨지고 currentVideo가 없으면 루프 중지
        if (!currentVideo) {
            stopVideoStatusLoop();
        }
    }

    /**
     * 팝업 자동 숨김 타이머를 재설정합니다.
     */
    function resetPopupHideTimer() {
        if (popupHideTimer) {
            clearTimeout(popupHideTimer);
        }
        popupHideTimer = setTimeout(hidePopup, POPUP_HIDE_DELAY_MS);
    }

    /**
     * 팝업 버튼의 텍스트와 스타일을 업데이트합니다.
     */
    function updatePlayPauseButton() {
        if (!playPauseButton || !currentVideo) return;
        if (currentVideo.paused) {
            playPauseButton.textContent = '▶ Play';
            playPauseButton.style.backgroundColor = '#4CAF50'; // Green
        } else {
            playPauseButton.textContent = '⏸ Pause';
            playPauseButton.style.backgroundColor = '#FF9800'; // Orange
        }
    }

    /**
     * 음소거/소리 버튼의 텍스트와 스타일을 업데이트합니다.
     */
    function updateMuteSpeakButtons() {
        if (!muteButton || !speakButton || !currentVideo) return;

        if (currentVideo.muted || currentVideo.volume === 0) {
            muteButton.style.display = 'none';
            speakButton.style.display = 'block';
            speakButton.style.backgroundColor = '#2196F3'; // Blue
        } else {
            muteButton.style.display = 'block';
            speakButton.style.display = 'none';
            muteButton.style.backgroundColor = '#f44336'; // Red
        }
    }

    /**
     * 팝업 슬라이더의 현재 값을 업데이트합니다.
     */
    function updatePopupSliders() {
        if (!speedSlider || !volumeSlider || !currentVideo) return;

        // 재생 속도 슬라이더
        speedSlider.value = currentVideo.playbackRate;
        speedValueDisplay.textContent = `${currentVideo.playbackRate.toFixed(1)}x`;

        // 볼륨 슬라이더
        volumeSlider.value = currentVideo.volume;
        volumeValueDisplay.textContent = `${Math.round(currentVideo.volume * 100)}%`;
    }

    /**
     * 팝업 위치를 currentVideo에 따라 업데이트합니다.
     */
    function updatePopupPosition() {
        if (!popupElement || !currentVideo || !isPopupVisible || isPopupDragging) return;

        const videoRect = currentVideo.getBoundingClientRect();
        const popupWidth = popupElement.offsetWidth;
        const popupHeight = popupElement.offsetHeight;

        // 팝업이 전체 화면 요소 내부에 있는 경우
        if (document.fullscreenElement && document.fullscreenElement.contains(popupElement)) {
            // 전체 화면 내에서 비디오의 상대적인 위치를 기준으로 팝업 배치
            const fsRect = document.fullscreenElement.getBoundingClientRect();
            let left = videoRect.right + 10;
            let top = videoRect.top;

            // 오른쪽으로 벗어나면 왼쪽으로 이동
            if (left + popupWidth > fsRect.width) {
                left = videoRect.left - popupWidth - 10;
            }
            // 위로 벗어나면 아래로 이동
            if (top + popupHeight > fsRect.height) {
                top = fsRect.height - popupHeight - 10;
            }
             // 왼쪽으로 벗어나면 비디오의 왼쪽에 배치
            if (left < 0) {
                left = videoRect.left;
            }
            // 위로 벗어나면 비디오의 위쪽에 배치
            if (top < 0) {
                top = videoRect.top;
            }
            popupElement.style.left = `${left}px`;
            popupElement.style.top = `${top}px`;
        } else { // 일반 문서 내부에 있는 경우
            let left = videoRect.right + 10;
            let top = videoRect.top;

            // 뷰포트 오른쪽 경계를 넘으면 비디오 왼쪽에 배치
            if (left + popupWidth > window.innerWidth - 10) {
                left = videoRect.left - popupWidth - 10;
            }
            // 뷰포트 위쪽 경계를 넘으면 아래로 이동
            if (top < 10) {
                top = 10;
            }
            // 뷰포트 아래쪽 경계를 넘으면 위로 이동
            if (top + popupHeight > window.innerHeight - 10) {
                top = window.innerHeight - popupHeight - 10;
            }

            // 왼쪽 경계를 넘으면 10px 마진으로 설정
            if (left < 10) {
                left = 10;
            }

            popupElement.style.left = `${left}px`;
            popupElement.style.top = `${top}px`;
        }
    }

    /**
     * 비디오의 재생 속도를 설정하고 필요하다면 브라우저의 기본 play 메소드를 오버라이드합니다.
     * @param {HTMLVideoElement} video - 대상 비디오 요소.
     * @param {number} rate - 설정할 재생 속도.
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;
        video.playbackRate = rate;

        // 속도 변경 시 자동재생 제한 회피 시도 (일부 브라우저에서 필요)
        if (!originalPlayMethods.has(video)) {
            originalPlayMethods.set(video, video.play);
            video.play = () => {
                const playPromise = originalPlayMethods.get(video).call(video);
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        // 사용자의 인터랙션이 없는 상태에서 autoplay가 막힌 경우 무시
                        // console.warn("[VCP] Playback blocked:", error);
                    });
                }
                return playPromise;
            };
        }
    }

    /**
     * 비디오의 볼륨을 설정하고 음소거 상태를 업데이트합니다.
     * @param {HTMLVideoElement} video - 대상 비디오 요소.
     * @param {number} volume - 설정할 볼륨 (0.0 ~ 1.0).
     */
    function setNormalVolume(video, volume) {
        if (!video) return;

        // 사용자가 볼륨을 0으로 직접 설정하거나 음소거 버튼을 눌렀을 때만 isManuallyMuted를 true로 설정
        // isManuallyMuted는 'mute' 버튼 클릭 시 true로 설정됨
        if (volume === 0 && !isManuallyMuted) {
             isManuallyMuted = true;
        } else if (volume > 0 && isManuallyMuted) {
             isManuallyMuted = false;
        } else if (volume > 0 && !video.muted) { // 볼륨이 0보다 크고 이미 음소거 상태가 아닐 때
            isManuallyMuted = false;
        }


        // 현재 비디오가 수동으로 음소거된 상태가 아니라면
        if (!isManuallyMuted) {
            video.muted = false; // 명시적으로 음소거 해제
            video.volume = volume;
        } else {
            video.muted = true; // 음소거 상태 유지
            video.volume = 0; // 볼륨도 0으로 설정
        }

        // 볼륨 변경 시 오디오 자동재생 제한 회피 시도 (일부 브라우저에서 필요)
        if (!originalPlayMethods.has(video)) {
            originalPlayMethods.set(video, video.play);
            video.play = () => {
                const playPromise = originalPlayMethods.get(video).call(video);
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        // console.warn("[VCP] Playback blocked by volume change:", error);
                    });
                }
                return playPromise;
            };
        }
        updateMuteSpeakButtons(); // 볼륨/음소거 상태 변경 시 버튼 업데이트
    }


    // --- Core Logic ---

    /**
     * IntersectionObserver 콜백 함수. 비디오의 가시성 변화를 처리합니다.
     * @param {IntersectionObserverEntry[]} entries - 관찰된 요소들의 배열.
     */
    function handleIntersection(entries) {
        entries.forEach(entry => {
            const video = entry.target;
            // 맵에 비디오 정보 업데이트
            if (observedVideosData.has(video)) {
                const data = observedVideosData.get(video);
                data.intersectionRatio = entry.intersectionRatio;
                data.timestamp = Date.now();
                observedVideosData.set(video, data);
            } else {
                // 새로 관찰 시작된 비디오일 경우 초기 값 설정
                observedVideosData.set(video, { intersectionRatio: entry.intersectionRatio, timestamp: Date.now() });
            }
        });
        // Intersection 변화가 있을 때마다 가장 적절한 비디오를 선택
        selectVideoLogic(null); // 이벤트 객체 없이 호출
    }

    /**
     * IntersectionObserver를 설정합니다.
     */
    function setupIntersectionObserver() {
        if (videoObserver) {
            videoObserver.disconnect();
        }
        const options = {
            root: null, // 뷰포트
            rootMargin: '0px',
            threshold: Array.from({ length: 101 }, (v, i) => i * 0.01) // 0%부터 100%까지 1% 단위로 감지
        };
        videoObserver = new IntersectionObserver(handleIntersection, options);
    }

    /**
     * 현재 페이지의 모든 비디오 요소를 찾아 관찰을 시작하거나 중지합니다.
     * DOM 변경 시, 스크롤 시 호출됩니다.
     */
    function updateVideoList() {
        const allVideos = findAllVideosDeep();
        const currentPlayableVideos = new Set(); // 현재 관찰해야 할 비디오 목록

        allVideos.forEach(video => {
            // 재생 가능한 비디오 (넓이, 높이가 0이 아닌 경우)만 고려
            if (video.offsetWidth > 0 && video.offsetHeight > 0) {
                currentPlayableVideos.add(video);
            }
        });

        // 더 이상 존재하지 않거나 재생 불가능한 비디오는 관찰 중지
        observedVideosData.forEach((data, video) => {
            if (!currentPlayableVideos.has(video) || !document.body.contains(video)) {
                if (videoObserver) {
                    videoObserver.unobserve(video);
                }
                observedVideosData.delete(video);
                if (currentVideo === video) {
                    if (currentVideo) currentVideo.pause();
                    currentVideo = null;
                    hidePopup();
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

        // currentVideo가 유효하지 않으면 초기화 (DOM에서 사라졌거나 더 이상 재생 가능한 비디오가 아님)
        if (currentVideo && (!document.body.contains(currentVideo) || !currentPlayableVideos.includes(currentVideo))) {
            if (currentVideo) currentVideo.pause();
            currentVideo = null;
            hidePopup();
        }
    }

    /**
     * 현재 보이는 비디오 중 가장 적합한 비디오를 선택합니다.
     * @param {Event|null} e - 이벤트 객체 (클릭 이벤트 등). UI 업데이트 시 팝업을 표시합니다.
     */
    function selectVideoLogic(e) {
        let candidateVideos = Array.from(observedVideosData.entries())
            .filter(([video, data]) => data.intersectionRatio > 0) // 뷰포트에 보이는 비디오만 필터링
            .map(([video, data]) => {
                const rect = video.getBoundingClientRect();
                const centerDist = Math.hypot( // 비디오 중심과 뷰포트 중심 간의 거리
                    rect.left + rect.width / 2 - window.innerWidth / 2,
                    rect.top + rect.height / 2 - window.innerHeight / 2
                );

                // 중앙에 가까울수록 높은 점수
                const centerScore = 1 / Math.pow(1 + centerDist, 5); // 1 + dist로 0 나누기 방지

                // 현재 재생 중인 비디오에 큰 점수 부여 (계속 제어할 확률 높임)
                const isPlayingScore = (!video.paused && video.duration > 0 && !video.ended) ? 10000 : 0;

                // 최종 점수: 가시성 * 10000 + 중앙 점수 * 5000 + 재생 중 점수
                const score = data.intersectionRatio * 10000 + centerScore * 5000 + isPlayingScore;

                return { video: video, score: score, intersectionRatio: data.intersectionRatio, centerDist: centerDist };
            })
            .sort((a, b) => b.score - a.score); // 점수가 높은 순으로 정렬

        let activeVideo = null;

        // 1. 현재 제어 중인 비디오가 여전히 유효하고 보이는 경우, 그 비디오를 유지
        if (currentVideo && document.body.contains(currentVideo) && observedVideosData.has(currentVideo) && observedVideosData.get(currentVideo).intersectionRatio > 0) {
            activeVideo = currentVideo;
        } else if (candidateVideos.length > 0) {
            // 2. 새로운 활성 비디오를 선택 (가시성이 가장 높고, 같으면 중앙에 가까운 비디오)
            activeVideo = candidateVideos
                .sort((a, b) => {
                    // 교차 비율이 다르면 교차 비율이 높은 것 우선
                    if (b.intersectionRatio !== a.intersectionRatio) {
                        return b.intersectionRatio - a.intersectionRatio;
                    }
                    // 교차 비율이 같으면 중앙에 더 가까운 것 우선 (거리가 작은 값)
                    return a.centerDist - b.centerDist;
                })
                .find(v => v.intersectionRatio > 0)?.video || null;
        }

        if (activeVideo) {
            if (currentVideo !== activeVideo) {
                // 이전 비디오가 있다면 일시 정지
                if (currentVideo) {
                    currentVideo.pause();
                }
                selectAndControlVideo(activeVideo); // 새 비디오 제어 시작
            }

            // 클릭 이벤트로 호출된 경우에만 팝업 표시 및 타이머 재설정
            if (e instanceof Event) {
                showPopup();
                resetPopupHideTimer();
            }
        } else {
            // 활성 비디오가 없으면 현재 비디오 초기화 및 팝업 숨김
            if (currentVideo) {
                currentVideo.pause();
            }
            currentVideo = null;
            hidePopup();
        }
    }

    let scrollTimeout = null;
    function handleScrollEvent() {
        if (scrollTimeout) clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            updateVideoList();
            // 스크롤 후 현재 비디오가 더 이상 보이지 않으면 초기화
            if (currentVideo && (!document.body.contains(currentVideo) || !observedVideosData.has(currentVideo) || observedVideosData.get(currentVideo).intersectionRatio === 0)) {
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }
        }, 100);
    }

    /**
     * 비디오 컨트롤 팝업의 버튼 클릭 이벤트를 처리합니다.
     * @param {string} action - 수행할 액션 ('play-pause', 'reset-speed', 'mute', 'speak').
     */
    function handleButtonClick(action) {
        if (!currentVideo) { return; }
        resetPopupHideTimer(); // 버튼 클릭 시 팝업 숨김 타이머 재설정

        switch (action) {
            case 'play-pause':
                if (currentVideo.paused) {
                    isManuallyPaused = false;
                    currentVideo.muted = isManuallyMuted; // 수동 음소거 상태에 따라 뮤트 설정
                    // 수동으로 음소거되지 않았고 볼륨이 0일 경우, desiredVolume으로 설정하여 소리 나게 함
                    if (!isManuallyMuted && currentVideo.volume === 0) {
                        currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0;
                    }
                    currentVideo.play().catch(e => console.error("Play failed:", e));
                } else {
                    isManuallyPaused = true;
                    currentVideo.pause();
                }
                // play/pause 이벤트 리스너가 updatePlayPauseButton을 호출하므로 여기서 직접 호출은 필요 없음
                // updatePlayPauseButton();
                break;
            case 'reset-speed':
                desiredPlaybackRate = 1.0;
                fixPlaybackRate(currentVideo, 1.0);
                speedValueDisplay.textContent = `${desiredPlaybackRate.toFixed(1)}x`; // 즉시 업데이트
                updatePopupSliders(); // 슬라이더 위치도 업데이트
                break;
            case 'mute':
                if (!currentVideo.muted) {
                    isManuallyMuted = true;
                    setNormalVolume(currentVideo, 0); // 볼륨을 0으로 설정
                }
                // setNormalVolume 내부에서 updateMuteSpeakButtons 호출됨
                break;
            case 'speak':
                isManuallyMuted = false;
                setNormalVolume(currentVideo, desiredVolume > 0 ? desiredVolume : 1.0); // 원하는 볼륨으로 설정, 0이면 기본 1.0
                // setNormalVolume 내부에서 updateMuteSpeakButtons 호출됨
                break;
        }
    }


    /**
     * 선택된 비디오를 제어 대상으로 설정하고 이전 비디오를 처리합니다.
     * @param {HTMLVideoElement|null} videoToControl - 새로 제어할 비디오 요소 또는 null.
     */
    function selectAndControlVideo(videoToControl) {
        if (!videoToControl) {
            if (currentVideo) {
                // 기존 currentVideo에 연결된 이벤트 리스너 제거
                currentVideo.removeEventListener('play', updatePlayPauseButton);
                currentVideo.removeEventListener('pause', updatePlayPauseButton);
                currentVideo.removeEventListener('volumechange', updateMuteSpeakButtons); // 볼륨 변경 이벤트도 추가하여 음소거 상태 동기화
                currentVideo.pause();
                currentVideo = null;
                hidePopup();
            }
            return;
        }

        // 새 비디오 선택 시 이전 currentVideo 정리
        if (currentVideo && currentVideo !== videoToControl) {
            // 기존 currentVideo에 연결된 이벤트 리스너 제거
            currentVideo.removeEventListener('play', updatePlayPauseButton);
            currentVideo.removeEventListener('pause', updatePlayPauseButton);
            currentVideo.removeEventListener('volumechange', updateMuteSpeakButtons);
            // 오버라이드된 play 메소드 복원
            if (originalPlayMethods.has(currentVideo)) {
                currentVideo.play = originalPlayMethods.get(currentVideo);
                originalPlayMethods.delete(currentVideo);
            }
            // 기존 비디오 일시 정지 및 초기화 (음소거, 볼륨 0)
            if (!currentVideo.paused) { currentVideo.pause(); }
            currentVideo.muted = true;
            currentVideo.volume = 0;
            currentVideo.currentTime = 0; // 초기화 시점도 0으로
        }

        // 현재 비디오가 아닌 모든 비디오는 일시 정지 및 음소거
        findAllVideosDeep().forEach(video => {
            if (video !== videoToControl) {
                if (originalPlayMethods.has(video)) {
                    video.play = originalPlayMethods.get(video);
                    originalPlayMethods.delete(video);
                }
                if (!video.paused) { video.pause(); }
                if (!video.muted || video.volume > 0) { video.muted = true; video.volume = 0; }
            }
        });

        // 새로운 currentVideo 설정 및 자동 재생 시도
        if (currentVideo !== videoToControl) {
            currentVideo = videoToControl;
            isManuallyPaused = false; // 새 비디오는 재생 시도하므로 수동 일시정지 아님
            desiredPlaybackRate = currentVideo.playbackRate; // 새 비디오의 현재 속도/볼륨 가져오기
            desiredVolume = currentVideo.volume;
            isManuallyMuted = currentVideo.muted;

            // 새로운 currentVideo에 이벤트 리스너 연결
            currentVideo.addEventListener('play', updatePlayPauseButton);
            currentVideo.addEventListener('pause', updatePlayPauseButton);
            currentVideo.addEventListener('volumechange', updateMuteSpeakButtons); // 볼륨 변경 이벤트 추가

            // 자동 재생 시도
            currentVideo.autoplay = true;
            currentVideo.playsInline = true; // iOS에서 인라인 재생 허용

            currentVideo.muted = false; // 처음에는 소리 나게 시도
            currentVideo.volume = desiredVolume > 0 ? desiredVolume : 1.0; // 이전 설정 볼륨 또는 기본 1.0
            isManuallyMuted = false;

            currentVideo.play().catch(e => {
                console.warn("[VCP] Autoplay with sound failed:", e.name, e.message, "Attempting muted autoplay.");
                currentVideo.muted = true;
                currentVideo.volume = 0;
                isManuallyMuted = true;
                currentVideo.play().catch(mutedError => {
                    console.error("[VCP] Muted autoplay also failed:", mutedError.name, mutedError.message);
                });
            });
        }

        // 현재 비디오의 상태를 팝업에 반영
        fixPlaybackRate(currentVideo, desiredPlaybackRate);
        setNormalVolume(currentVideo, desiredVolume); // 이 함수 안에서 isManuallyMuted도 업데이트
        updatePopupSliders();
        updatePlayPauseButton(); // 초기 상태 반영
        updateMuteSpeakButtons(); // 초기 상태 반영
    }

    // --- MutationObserver Debounce 로직 적용 ---
    let domMutationTimer = null;
    function setupDOMObserver() {
        const observerConfig = { childList: true, subtree: true, attributes: true }; // attributes 감지 추가
        const observerCallback = (mutationsList) => {
            let foundMediaChange = false;
            for (const mutation of mutationsList) {
                // 노드 추가/제거 감지 (video/audio 태그 또는 그 하위의 video/audio)
                if (mutation.type === 'childList' && (
                    Array.from(mutation.addedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio')))) ||
                    Array.from(mutation.removedNodes).some(n => n.nodeName === 'VIDEO' || n.nodeName === 'AUDIO' || (n.nodeType === 1 && (n.querySelector('video') || n.querySelector('audio'))))
                )) {
                    foundMediaChange = true;
                    break;
                }
                // 속성 변경 감지 (video/audio 태그의 src, controls, style 등)
                else if (mutation.type === 'attributes' && mutation.target.matches('video, audio')) {
                    if (mutation.attributeName === 'src' || mutation.attributeName === 'controls' || mutation.attributeName === 'style' || mutation.attributeName === 'autoplay' || mutation.attributeName === 'muted') {
                        foundMediaChange = true;
                        break;
                    }
                }
            }
            if (foundMediaChange) {
                if (domMutationTimer) clearTimeout(domMutationTimer);
                domMutationTimer = setTimeout(() => {
                    console.log('[VCP] DOM change detected and debounced. Re-scanning videos.');
                    updateVideoList();
                    // selectVideoLogic(null); // IntersectionObserver 콜백에서 처리되므로 여기서는 제거
                    domMutationTimer = null;
                }, DEBOUNCE_MUTATION_OBSERVER_MS);
            }
        };
        const mutationObserver = new MutationObserver(observerCallback);
        mutationObserver.observe(document.body, observerConfig);
    }

    /**
     * SPA(Single Page Application) 환경에서 URL 변경을 감지하고 상태를 리셋합니다.
     */
    function setupSPADetection() {
        let lastUrl = location.href;
        new MutationObserver(() => {
            const currentUrl = location.href;
            if (currentUrl !== lastUrl) {
                console.log(`[VCP] URL changed from ${lastUrl} to ${currentUrl}. Resetting popup state.`);
                lastUrl = currentUrl;
                if (currentVideo) currentVideo.pause();
                currentVideo = null;
                hidePopup();
                // 모든 비디오 관찰 중지 및 데이터 초기화 (필수)
                if (videoObserver) {
                    videoObserver.disconnect();
                    observedVideosData.clear();
                }
                setupIntersectionObserver(); // 새 IntersectionObserver 설정
                updateVideoList(); // 비디오 목록 다시 스캔
                // selectVideoLogic(null); // IntersectionObserver 콜백에서 처리되므로 여기서는 제거
            }
        }).observe(document, { subtree: true, childList: true }); // document 자체의 변경을 감시하여 URL 변화에 대응
    }

    /**
     * 특정 사이트에서 발생하는 overflow 문제를 수정합니다.
     */
    function fixOverflow() {
        const overflowFixSites = [
            // { domain: 'example.com', selectors: ['body', '#main-container'] }
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

    // --- requestAnimationFrame 기반 비디오 상태 루프 ---
    function videoStatusLoop() {
        // 팝업이 보이지 않고, 제어할 비디오도 없을 때는 루프를 멈춥니다.
        if (!currentVideo && !isPopupVisible) {
            stopVideoStatusLoop();
            return;
        }

        // currentVideo가 있고 재생 중이며 끝난 상태가 아닐 때
        if (currentVideo && !currentVideo.paused && !currentVideo.ended) {
            // 원하는 재생 속도와 다르면 설정
            if (currentVideo.playbackRate !== desiredPlaybackRate) {
                currentVideo.playbackRate = desiredPlaybackRate;
            }
            // 원하는 볼륨과 다르면 설정 (미세한 차이는 무시)
            if (Math.abs(currentVideo.volume - desiredVolume) > 0.005) {
                currentVideo.volume = desiredVolume;
            }
            // 원하는 음소거 상태와 다르면 설정
            if (currentVideo.muted !== isManuallyMuted) {
                currentVideo.muted = isManuallyMuted;
            }
        } else if (currentVideo && currentVideo.paused && !currentVideo.ended && !isManuallyPaused) {
            // currentVideo가 일시정지 상태인데 수동으로 정지한 것이 아니면 다시 재생 시도
            // 이는 웹사이트 자체의 재생/일시정지 제어에 대한 폴백 역할을 함
            currentVideo.play().catch(e => { /* 무시 */ });
        }

        // 모든 비디오를 순회하며 currentVideo가 아닌 다른 비디오는 제어
        findAllVideosDeep().forEach(video => {
            if (video !== currentVideo) {
                if (!video.paused) { video.pause(); } // 현재 비디오가 아니면 일시정지
                if (!video.muted || video.volume > 0) { video.muted = true; video.volume = 0; } // 음소거 및 볼륨 0
            }
        });

        // 팝업이 보이고 드래그 중이 아닐 때만 팝업 위치 및 슬라이더 업데이트
        if (popupElement && isPopupVisible && !isPopupDragging) {
            updatePopupPosition();
            updatePopupSliders(); // 슬라이더 값은 계속 동기화 필요
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
    const TOUCH_MOVE_THRESHOLD = 10; // 픽셀 단위

    document.addEventListener('touchstart', (e) => {
        touchStartX = e.touches ? e.touches.item(0).clientX : e.clientX;
        touchStartY = e.touches ? e.touches.item(0).clientY : e.clientY;
        touchMoved = false;
    }, { passive: true }); // passive: true로 스크롤 성능 최적화

    document.addEventListener('touchmove', (e) => {
        if (!e.touches) return;
        const touch = e.touches.item(0);
        const deltaX = Math.abs(touch.clientX - touchStartX);
        const deltaY = Math.abs(touch.clientY - touchStartY);
        if (deltaX > TOUCH_MOVE_THRESHOLD || deltaY > TOUCH_MOVE_THRESHOLD) {
            touchMoved = true;
        }
    }, { passive: true }); // passive: true로 스크롤 성능 최적화

    // document.body 대신 document에 직접 이벤트를 추가하여 모든 클릭 감지 (캡처링 단계)
    document.addEventListener('click', (e) => {
        if (!e) return;
        // 팝업 내부 클릭은 팝업 숨김 타이머만 리셋
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        // 터치 드래그 후 발생하는 클릭 이벤트 무시
        if (touchMoved) {
            touchMoved = false;
            return;
        }
        // 링크 또는 클릭 가능한 요소는 무시
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) {
            return;
        }
        // 팝업 외부 클릭 시 팝업 숨김
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }
        // 비디오 선택 로직 실행
        selectVideoLogic(e);
    }, true); // true: 캡처링 단계에서 이벤트 감지

    document.addEventListener('touchend', (e) => {
        if (!e) return;
        // 팝업 내부 터치 종료는 팝업 숨김 타이머만 리셋
        if (popupElement && isPopupVisible && popupElement.contains(e.target)) {
            resetPopupHideTimer();
            return;
        }
        // 터치 드래그 후 발생하는 터치 종료 이벤트 무시
        if (touchMoved) {
            touchMoved = false;
            return;
        }
        // 링크 또는 클릭 가능한 요소는 무시
        const clickedLink = e.target.closest('a');
        const isClickableElement = e.target.matches('button, input, [role="button"], [tabindex]:not([tabindex="-1"]), label, select, textarea');
        if (clickedLink || isClickableElement) {
            return;
        }
        // 팝업 외부 터치 종료 시 팝업 숨김
        if (popupElement && isPopupVisible && !popupElement.contains(e.target)) {
            hidePopup();
        }
        // 비디오 선택 로직 실행
        selectVideoLogic(e);
    }, true); // true: 캡처링 단계에서 이벤트 감지
    // --- 모바일 터치/클릭 오작동 및 링크 클릭 문제 픽스 끝 ---

    /**
     * 스크립트 초기화 함수.
     * 한 번만 실행되도록 보장합니다.
     */
    function initialize() {
        if (isInitialized) return;
        isInitialized = true;

        console.log('[VCP] Video Controller Popup script initialized. Version 4.11.16_UI_Sync_Fix');

        createPopupElement();
        hidePopup(); // 초기에는 팝업 숨김

        setupIntersectionObserver();
        updateVideoList(); // 초기 비디오 목록 감지 시작

        // 전체 화면 이벤트 리스너
        document.addEventListener('fullscreenchange', () => {
            const fsEl = document.fullscreenElement;
            if (popupElement) {
                if (fsEl) {
                    // 전체 화면 진입 시 팝업 위치 저장 및 전체 화면 요소에 추가
                    popupPrevPosition = {
                        left: popupElement.style.left,
                        top: popupElement.style.top,
                    };
                    fsEl.appendChild(popupElement);
                    popupElement.style.width = '280px';
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'absolute'; // 전체 화면 내에서 절대 위치
                    popupElement.style.transform = 'none'; // translateX/Y 제거

                    updatePopupPosition(); // 전체 화면 내에서 위치 재조정
                    showPopup();
                    resetPopupHideTimer();
                } else {
                    // 전체 화면 종료 시 팝업을 body로 다시 옮기고 이전 위치 복원
                    document.body.appendChild(popupElement);
                    if (popupPrevPosition) {
                        popupElement.style.left = popupPrevPosition.left;
                        popupElement.style.top = popupPrevPosition.top;
                        console.log('[VCP] Restored popup position to:', popupPrevPosition.left, popupPrevPosition.top);
                    } else {
                        updatePopupPosition(); // 이전 위치가 없으면 기본 위치 재조정
                    }
                    popupElement.style.width = 'fit-content'; // 크기 속성 복원
                    popupElement.style.minWidth = '280px';
                    popupElement.style.height = 'auto';
                    popupElement.style.minHeight = '150px';
                    popupElement.style.position = 'fixed'; // 일반 문서 내에서 고정 위치
                    popupElement.style.transform = 'none';

                    hidePopup(); // 전체 화면 종료 시 팝업 숨김
                }
            }
        });

        // 윈도우 크기 변경 시 팝업 위치 업데이트
        window.addEventListener('resize', () => {
            updatePopupPosition();
        });

        // 스크롤 이벤트 감지
        window.addEventListener('scroll', handleScrollEvent);

        // DOM 변경 감지 및 SPA URL 변경 감지
        setupDOMObserver();
        setupSPADetection();
        fixOverflow(); // 특정 사이트의 오버플로우 문제 해결

        startVideoStatusLoop(); // 비디오 상태를 지속적으로 확인하는 루프 시작

        // 페이지 언로드 시 정리 작업
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
        });
    }

    // 문서 로드 상태에 따라 초기화
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize);
    }
})();
