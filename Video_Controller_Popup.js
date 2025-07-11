// ==UserScript==
// @name Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace Violentmonkey Scripts
// @version 4.09.8_Optimized (Modified) // 요청에 따라 버전 업데이트 및 수정 표기
// @description 여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let currentIntervalId = null; // 재생 속도 강제 유지 인터벌 ID
    let videos = [];              // 감지된 모든 비디오 요소 배열
    let currentVideo = null;      // 현재 제어 중인 비디오 요소
    let popupElement = null;      // 팝업 UI 요소
    let isSeeking = false;        // 탐색 중 상태 추적 (넷플릭스 탐색 시 충돌 방지)

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    // 팝업 투명도 설정: localStorage에서 로드하거나, 없으면 PC/모바일 모두 '1' (불투명)으로 시작
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '1';

    // Lazy-src 예외 사이트 (data-src를 src로 변환하지 않을 사이트)
    const lazySrcBlacklist = [
        'missav.ws',
        'missav.live',
        'example.net'
    ];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

    // 강제 배속 유지 사이트 설정 및 기본 간격
    const forcePlaybackRateSites = [
        { domain: 'twitch.tv', interval: 50 },
        { domain: 'tiktok.com', interval: 20 },
        { domain: 'youtube.com', interval: 100 } // 유튜브 추가
    ];
    let forceInterval = 200; // 기본 강제 유지 간격 (ms)
    forcePlaybackRateSites.forEach(site => {
        if (location.hostname.includes(site.domain)) {
            forceInterval = site.interval;
        }
    });

    // overflow visible fix 사이트 설정 (PIP 모드 시 UI 잘림 방지 등)
    const overflowFixSites = [
        { domain: 'twitch.tv', selector: [
            'div.video-player__container',
            'div.video-player-theatre-mode__player',
            'div.player-theatre-mode'
        ]},
    ];
    const overflowFixTargets = overflowFixSites.filter(site =>
        location.hostname.includes(site.domain)
    );

    // --- Utility Functions ---

    /**
     * 특정 사이트의 overflow 속성을 'visible'로 설정하여 UI 잘림을 방지합니다.
     */
    function fixOverflow() {
        overflowFixTargets.forEach(site => {
            site.selector.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.overflow = 'visible';
                });
            });
        });
    }

    /**
     * DOM 전체 (Shadow DOM 포함)에서 모든 <video> 요소를 깊이 탐색하여 찾습니다.
     * @param {Document|ShadowRoot} root - 탐색을 시작할 문서 또는 ShadowRoot.
     * @returns {HTMLVideoElement[]} - 찾은 비디오 요소 배열.
     */
    function findAllVideosDeep(root = document) {
        const found = [];
        root.querySelectorAll('video').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found.push(...findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    }

    /**
     * 재생 가능한 비디오 요소를 찾아 반환합니다.
     * lazy-src 블랙리스트에 없는 사이트에서는 data-src를 src로 변환합니다.
     * @returns {HTMLVideoElement[]} - 필터링된 비디오 요소 배열.
     */
    function findPlayableVideos() {
        const found = findAllVideosDeep();
        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    v.src = v.dataset.src;
                }
            });
        }
        // 숨겨진 비디오, 오디오 트랙, 그리고 크기가 너무 작은 비디오를 제외합니다.
        return found.filter(v =>
            !v.classList.contains('hidden') &&
            v.videoWidth > 0 &&
            v.videoHeight > 0 &&
            v.clientWidth > 50 && // 최소 너비 50px 이상
            v.clientHeight > 50   // 최소 높이 50px 이상
        );
    }

    /**
     * 비디오의 재생 속도를 설정하고, 특정 사이트에서는 이를 강제 유지합니다.
     * @param {HTMLVideoElement} video - 속도를 조절할 비디오 요소.
     * @param {number} rate - 설정할 재생 속도.
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;
        video.playbackRate = rate;

        // 기존 인터벌이 있으면 제거
        if (currentIntervalId) {
            clearInterval(currentIntervalId);
        }

        // 특정 사이트에서만 강제 재생 속도 유지 인터벌 설정
        const siteConfig = forcePlaybackRateSites.find(site => location.hostname.includes(site.domain));
        if (siteConfig) {
            currentIntervalId = setInterval(() => {
                // 비디오 재생 속도가 설정된 rate와 다르면 다시 적용
                if (video.playbackRate !== rate) {
                    video.playbackRate = rate;
                }
                // (선택 사항: video가 null이 되면 인터벌 중지)
                if (!document.body.contains(video)) {
                     clearInterval(currentIntervalId);
                     currentIntervalId = null;
                }
            }, siteConfig.interval);
        }
    }

    /**
     * 비디오의 재생 시간을 이동시킵니다. 넷플릭스 전용 로직 포함.
     * @param {number} seconds - 이동할 시간 (초). 양수면 앞으로, 음수면 뒤로.
     */
    function seekVideo(seconds) {
        if (isSeeking) return; // 탐색 중이면 중복 실행 방지
        isSeeking = true;

        if (isNetflix) {
            try {
                // 넷플릭스 전용 seek API 사용 (Web Audio API 사용 여부와 무관)
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Netflix seek error:', e);
            }
        } else if (currentVideo) {
            // 일반 비디오 seek 로직
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }

        setTimeout(() => { isSeeking = false; }, 100); // 탐색 상태 초기화
    }

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null; // 현재 오디오 컨텍스트에 연결된 비디오를 추적

    /**
     * Web Audio Context를 설정하여 비디오의 오디오를 조작할 수 있도록 준비합니다.
     * @param {HTMLVideoElement} video - 오디오 컨텍스트에 연결할 비디오 요소.
     * @returns {boolean} - 설정 성공 여부.
     */
    function setupAudioContext(video) {
        try {
            if (!video) return false;

            // 기존 연결 해제 및 초기화
            if (sourceNode) {
                sourceNode.disconnect();
                sourceNode = null;
            }
            if (gainNode) {
                gainNode.disconnect();
                gainNode = null;
            }
            connectedVideo = null;

            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            // 비디오 요소에서 오디오 스트림 생성
            sourceNode = audioCtx.createMediaElementSource(video);
            // 볼륨 조절을 위한 GainNode 생성
            gainNode = audioCtx.createGain();

            // 노드 연결: Video Source -> GainNode -> Destination (스피커)
            sourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            connectedVideo = video; // 현재 연결된 비디오 추적
            return true;
        } catch (e) {
            console.error("Failed to setup AudioContext. Amplification might not work:", e);
            // 오디오 컨텍스트 설정 실패 시 관련 변수 초기화
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;
            return false;
        }
    }

    /**
     * 비디오의 볼륨을 설정합니다. 100% 초과 볼륨은 Web Audio API를 사용하여 증폭합니다.
     * @param {HTMLVideoElement} video - 볼륨을 조절할 비디오 요소.
     * @param {number} vol - 설정할 볼륨 값 (0.0 ~ 5.0).
     */
    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        // 비디오 상태 확인 및 재생 시작 시 AudioContext 활성화
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
        }

        if (vol <= 1) {
            // 100% 이하 볼륨: 비디오 자체 볼륨 속성 사용
            // 증폭 노드가 활성화되어 있다면 게인 노드를 1 (기본값)로 설정
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } else {
            // 100% 초과 볼륨: Web Audio API를 사용하여 증폭
            // AudioContext가 없거나, 다른 비디오에 연결되어 있으면 재설정
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    console.warn("Audio amplification not available. Setting video volume to 100%.");
                    video.volume = 1; // 증폭 실패 시 비디오 볼륨만 최대화
                    return;
                }
            }

            if (gainNode) {
                // 비디오 자체 볼륨은 최대로 설정 (Web Audio API로 스트리밍하기 위함)
                video.volume = 1;
                // GainNode로 증폭 볼륨 적용
                gainNode.gain.value = vol;
            }
        }
    }

    // --- UI Update & Creation ---
    // 볼륨 드롭다운 옵션 정의
    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150% (Amplify)', value: 1.5 }, { label: '300% (Amplify)', value: 3.0 }, { label: '500% (Amplify)', value: 5.0 },
        { label: 'Transparent', value: 'transparent' }, // 팝업 투명도 조절 옵션
        { label: 'Opaque', value: 'opaque' } // 팝업 불투명도 조절 옵션
    ];

    /**
     * 팝업의 볼륨 드롭다운을 현재 비디오의 볼륨 상태에 맞춰 업데이트합니다.
     */
    function updateVolumeSelect() {
        const volumeSelect = popupElement?.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        // 팝업 투명도 옵션 먼저 처리
        if (idleOpacity === '0.025') {
            volumeSelect.value = 'transparent';
        } else if (idleOpacity === '1') {
            volumeSelect.value = 'opaque';
        }

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0; // 음소거 시 게인 노드도 0으로
        } else {
            let effectiveVolume = currentVideo.volume;
            if (gainNode && connectedVideo === currentVideo) {
                // 증폭이 적용 중이라면 게인 노드의 값으로 유효 볼륨 계산
                effectiveVolume = gainNode.gain.value;
            }

            // 가장 가까운 볼륨 옵션 찾기
            const closest = volumeOptions.reduce((prev, curr) => {
                if (typeof curr.value !== 'number') return prev; // 숫자 볼륨 옵션만 비교
                return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
            }, { value: 1.0 });

            // 팝업 투명도 옵션과 충돌하지 않는 경우에만 볼륨 옵션 선택
            if (volumeSelect.value !== 'transparent' && volumeSelect.value !== 'opaque') {
                 volumeSelect.value = closest.value;
            }
        }
    }

    /**
     * 비디오 컨트롤 팝업 UI를 생성하거나 업데이트합니다.
     */
    function createPopup() {
        const hostRoot = document.body;

        // 팝업 존재 여부 확인 및 제거
        if (popupElement) popupElement.remove();
        
        // 새로운 비디오 목록 감지
        videos = findPlayableVideos();
        
        if (videos.length === 0) {
            // 비디오가 없으면 관련 인터벌 및 현재 비디오 초기화
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            return;
        }

        // 현재 선택된 비디오가 없거나, 목록에 없으면 첫 번째 비디오 선택
        if (!currentVideo || !videos.includes(currentVideo)) {
            // 기존 비디오가 제거되었거나, 페이지 로드 후 처음인 경우
            currentVideo = videos[0];
        }

        // 팝업 요소 생성 및 스타일 설정
        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 10px; /* 화면 하단에 고정 */
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.5);
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            z-index: 2147483647; /* 항상 최상위 */
            pointer-events: auto; /* 팝업 클릭 가능하도록 설정 */
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            align-items: center;
            box-shadow: 0 0 15px rgba(0,0,0,0.5);
            transition: opacity 0.3s ease;
            opacity: ${idleOpacity}; /* 초기 투명도 적용 */
        `;
        popupElement = popup;

        // 버튼 및 셀렉트 공통 스타일 정의
        const controlStyles = `
            font-size: 16px;
            font-weight: bold;
            padding: 4px 10px;
            border: 1px solid #fff;
            border-radius: 4px;
            background-color: rgba(0,0,0,0.5);
            color: #fff;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background-color 0.2s;
        `;

        // 비디오 선택 드롭다운 생성
        const videoSelect = document.createElement('select');
        videoSelect.style.cssText = controlStyles + `
            max-width: 150px;
            text-overflow: ellipsis;
            background: #000;
            `;
        
        videos.forEach((video, i) => {
            const option = document.createElement('option');
            option.value = i;
            // 비디오 소스 URL의 마지막 부분을 레이블로 사용하거나, 제목이 없으면 Video X로 표기
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            // 레이블이 너무 길면 자르고 툴팁으로 전체 이름 제공
            if (label.length > 25) label = label.slice(0, 22) + '...';
            option.textContent = label;
            option.title = video.currentSrc;
            
            // 현재 비디오 선택 표시
            if (video === currentVideo) {
                 option.selected = true;
            }
            videoSelect.appendChild(option);
        });

        videoSelect.onchange = () => {
            // 비디오 변경 시 재생 속도 강제 유지 인터벌 정리
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }

            // 비디오 변경 시 오디오 노드 정리 (중요: 메모리 누수 방지 및 새 비디오 연결 준비)
            if (connectedVideo && connectedVideo !== currentVideo && sourceNode && gainNode) {
                try {
                    sourceNode.disconnect();
                    gainNode.disconnect();
                } catch (e) {
                    console.warn("Error disconnecting audio nodes on video change:", e);
                } finally {
                    sourceNode = null;
                    gainNode = null;
                    connectedVideo = null;
                }
            }

            // 기존 비디오의 volumechange 리스너 제거 (중복 방지)
            if (currentVideo) currentVideo.removeEventListener('volumechange', updateVolumeSelect);
            
            // 새 비디오로 설정
            currentVideo = videos[videoSelect.value];
            
            // 새 비디오에 volumechange 리스너 추가 및 볼륨 드롭다운 업데이트
            if (currentVideo) currentVideo.addEventListener('volumechange', updateVolumeSelect);
            updateVolumeSelect(); 
        };
        popup.appendChild(videoSelect);

        // 버튼 생성 헬퍼 함수
        function createButton(id, text, onClick) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.style.cssText = controlStyles;
            
            // 마우스 오버 및 터치 피드백 효과
            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', () => {
                onClick();
                if (isMobile) { 
                    btn.style.backgroundColor = 'rgba(125,125,125,0.8)';
                    setTimeout(() => { btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; }, 200);
                }
            });
            return btn;
        }

        // 재생 속도 및 PIP, 시간 이동 버튼 추가
        popup.appendChild(createButton('slow', '0.2x', () => fixPlaybackRate(currentVideo, 0.2)));
        popup.appendChild(createButton('normal', '1.0x', () => fixPlaybackRate(currentVideo, 1.0)));
        popup.appendChild(createButton('fast', '5.0x', () => fixPlaybackRate(currentVideo, 5.0)));
        popup.appendChild(createButton('pip', '📺 PIP', async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else {
                    await currentVideo.requestPictureInPicture();
                }
            } catch (e) {
                console.error('PIP Error:', e);
            }
        }));
        popup.appendChild(createButton('back15', '《 15s', () => seekVideo(-15)));
        popup.appendChild(createButton('forward15', '15s 》', () => seekVideo(15)));

        // 볼륨 선택 드롭다운 생성
        const volumeSelect = document.createElement('select');
        volumeSelect.id = 'volume-select';
        volumeSelect.style.cssText = controlStyles + `
            margin-left: 8px;
            background: #000;
        `;
        
        volumeOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            volumeSelect.appendChild(option);
        });

        volumeSelect.onchange = () => {
            if (!currentVideo) return;
            const value = volumeSelect.value;
            
            if (value === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
            } else if (value === 'transparent') {
                idleOpacity = '0.025';
                localStorage.setItem('vcp_idleOpacity', idleOpacity); // 설정 저장
                popupElement.style.opacity = idleOpacity;
            } else if (value === 'opaque') {
                idleOpacity = '1';
                localStorage.setItem('vcp_idleOpacity', idleOpacity); // 설정 저장
                popupElement.style.opacity = idleOpacity;
            } else {
                currentVideo.muted = false;
                const vol = parseFloat(value);
                setAmplifiedVolume(currentVideo, vol);
            }
        };

        // 팝업 생성 시 현재 비디오의 볼륨 상태를 드롭다운에 반영하고, volumechange 이벤트 리스너 추가
        if (currentVideo) {
            // 기존 리스너 제거 (중복 방지)
            currentVideo.removeEventListener('volumechange', updateVolumeSelect); 
            // 새 리스너 추가
            currentVideo.addEventListener('volumechange', updateVolumeSelect);
        }
        updateVolumeSelect(); // 드롭다운 초기화 및 현재 볼륨 동기화
        popup.appendChild(volumeSelect);

        // 팝업 투명도 자동 조절 (마우스 오버/터치)
        if (!isMobile) {
            popup.addEventListener('mouseenter', () => popup.style.opacity = '1');
            popup.addEventListener('mouseleave', () => popup.style.opacity = idleOpacity);
        } else {
            popup.addEventListener('touchstart', () => {
                popup.style.opacity = '1';
                clearTimeout(popup.fadeTimeout);
                popup.fadeTimeout = setTimeout(() => {
                    popup.style.opacity = idleOpacity;
                }, 3000); // 3초 후 투명도 복원
            });
        }
        
        hostRoot.appendChild(popup); // 최종적으로 팝업을 body에 추가
    }

    // --- Main Execution ---
    /**
     * 스크립트의 주요 실행 로직을 시작합니다.
     */
    function run() {
        createPopup(); // 초기 팝업 생성

        // MutationObserver를 사용하여 DOM 변경 감지 (비디오 추가/삭제 등)
        const mo = new MutationObserver(() => {
            const newVideos = findPlayableVideos();
            // 비디오 목록의 길이 또는 참조가 변경되면 팝업을 재생성하여 업데이트
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                createPopup();
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });

        // 주기적으로 비디오 목록을 확인하여 동적으로 로드되는 비디오를 감지 (MutationObserver 보완)
        setInterval(() => {
            const newVideos = findPlayableVideos();
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                createPopup();
            }
        }, 2000); // 2초마다 확인

        // 오버플로우 픽스 대상 사이트가 있으면 주기적으로 실행
        if (overflowFixTargets.length > 0) {
            fixOverflow(); // 초기 실행
            setInterval(fixOverflow, 1000); // 1초마다 반복 실행
        }
    }

    // 스크립트 실행 시작
    run();
})();
