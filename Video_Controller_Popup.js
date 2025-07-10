// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace     Violentmonkey Scripts
// @version       3.94 // 버전 업데이트
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match         *://*/*
// @grant         none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables ---
    let currentIntervalId = null;
    let videos = [];
    let currentVideo = null;
    let popupElement = null;

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    // 팝업 투명도 설정: localStorage에서 로드하거나, 없으면 PC/모바일 모두 '1' (불투명)으로 시작
    // 사용자가 '투명' 옵션을 선택하면 '0.025'가 저장되고 다음 접속 시에도 유지됩니다.
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '1';

    // Lazy-src 예외 사이트
    const lazySrcBlacklist = [
        'missav.ws',
        'missav.live',
        'example.net' // 예시 사이트, 필요에 따라 추가/제거
    ];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

    // 강제 배속 유지 사이트 설정
    const forcePlaybackRateSites = [
        { domain: 'twitch.tv', interval: 50 },
        { domain: 'tiktok.com', interval: 20 } // 틱톡은 더 짧은 간격으로 강제 유지 시도
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
        return found.filter(v => !v.classList.contains('hidden'));
    }

    /**
     * 비디오의 재생 속도를 설정하고, 특정 사이트에서는 이를 강제 유지합니다.
     * @param {HTMLVideoElement} video - 속도를 조절할 비디오 요소.
     * @param {number} rate - 설정할 재생 속도.
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;
        video.playbackRate = rate;
        if (currentIntervalId) clearInterval(currentIntervalId);
        currentIntervalId = setInterval(() => {
            if (video.playbackRate !== rate) {
                video.playbackRate = rate;
            }
        }, forceInterval);
    }

    /**
     * 비디오의 재생 시간을 이동시킵니다. 넷플릭스 전용 로직 포함.
     * @param {number} seconds - 이동할 시간 (초). 양수면 앞으로, 음수면 뒤로.
     */
    function seekVideo(seconds) {
        if (isNetflix) {
            try {
                // 넷플릭스 전용 seek API 사용
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Netflix seek error:', e); // 사용자에게 알림 대신 콘솔 경고
            }
        } else if (currentVideo) {
            // 일반 비디오 seek 로직
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }
    }

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null; // 현재 오디오 컨텍스트에 연결된 비디오를 추적

    /**
     * Web Audio Context를 설정하여 비디오의 오디오를 조작할 수 있도록 준비합니다.
     * 새로운 비디오를 위해 호출될 때, 기존 노드를 명확히 disconnect()하고 null로 초기화합니다.
     * @param {HTMLVideoElement} video - 오디오 컨텍스트에 연결할 비디오 요소.
     * @returns {boolean} - 설정 성공 여부.
     */
    function setupAudioContext(video) {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }

            // 기존 연결 해제 및 초기화
            if (sourceNode) {
                try { sourceNode.disconnect(); } catch (e) { console.warn("Error disconnecting old sourceNode:", e); }
                sourceNode = null;
            }
            if (gainNode) {
                try { gainNode.disconnect(); } catch (e) { console.warn("Error disconnecting old gainNode:", e); }
                gainNode = null;
            }
            // connectedVideo도 초기화하여 다음 연결 시 명확하게 새로 설정되도록 함
            connectedVideo = null;

            sourceNode = audioCtx.createMediaElementSource(video);
            gainNode = audioCtx.createGain();
            sourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            connectedVideo = video; // 현재 오디오 컨텍스트에 연결된 비디오 추적
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

        if (vol <= 1) {
            // 100% 이하 볼륨은 video.volume 속성으로 직접 제어
            // 증폭 노드가 활성화되어 있다면 기본값(1)으로 설정
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } else {
            // 100% 초과 볼륨은 Web Audio API를 사용하여 증폭
            // AudioContext가 설정되지 않았거나 다른 비디오에 연결되어 있다면 재설정
            if (!audioCtx || !sourceNode || !gainNode || connectedVideo !== video) {
                if (!setupAudioContext(video)) { // setupAudioContext 실패 시 증폭 불가
                    console.warn("Audio amplification not available. Setting video volume to 100%.");
                    video.volume = 1; // 증폭 실패 시 비디오 볼륨만 최대화
                    return;
                }
            }
            if (gainNode) { // setupAudioContext가 성공적으로 완료되었는지 확인
                video.volume = 1; // 비디오 자체 볼륨은 최대로 설정
                gainNode.gain.value = vol; // GainNode로 증폭 볼륨 적용
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
        { label: '150%', value: 1.5 }, { label: '300%', value: 3.0 }, { label: '500%', value: 5.0 },
        { label: '투명', value: 'transparent' }, // 팝업 투명도 조절 옵션
        { label: '불투명', value: 'opaque' }
    ];

    /**
     * 팝업의 볼륨 드롭다운을 현재 비디오의 볼륨 상태에 맞춰 업데이트합니다.
     * (비디오 자체 볼륨 조절 시에도 동기화)
     */
    function updateVolumeSelect() {
        const volumeSelect = popupElement.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0; // 음소거 시 게인 노드도 0으로
        } else {
            let currentVol = currentVideo.volume;
            let currentGain = 1;
            if (gainNode && connectedVideo === currentVideo) {
                currentGain = gainNode.gain.value;
            }

            // 실제 사용자에게 들리는 유효 볼륨 계산
            let effectiveVolume = currentVol * currentGain;

            // 가장 가까운 볼륨 옵션 찾기
            const closest = volumeOptions.reduce((prev, curr) => {
                if (typeof curr.value !== 'number') return prev; // 'muted', 'transparent', 'opaque' 옵션은 제외
                return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
            }, { value: 1.0 }); // 기본 비교값 1.0 (100%)

            volumeSelect.value = closest.value;
        }

        // 팝업 투명도 옵션도 현재 idleOpacity 값에 맞춰 선택되도록 업데이트
        // 실제 opacity 값과 일치하는 옵션을 선택하도록 합니다.
        if (idleOpacity === '0.025') {
            volumeSelect.value = 'transparent';
        } else if (idleOpacity === '1') {
            volumeSelect.value = 'opaque';
        }
    }


    /**
     * 비디오 컨트롤 팝업 UI를 생성하거나 업데이트합니다.
     */
    function createPopup() {
        const hostRoot = document.body;
        if (popupElement) popupElement.remove(); // 기존 팝업이 있으면 제거

        videos = findPlayableVideos(); // 현재 페이지의 모든 재생 가능한 비디오를 다시 감지
        if (videos.length === 0) {
            // 비디오가 없으면 관련 인터벌 및 현재 비디오 초기화
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            return; // 팝업 생성 중단
        }

        // 현재 선택된 비디오가 없거나, 더 이상 감지된 비디오 목록에 없으면 첫 번째 비디오 선택
        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos[0];
        }

        // 팝업 요소 생성 및 스타일 설정
        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 0px; /* 화면 하단에 고정 */
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
        popupElement = popup; // 전역 변수에 팝업 요소 저장

        // 비디오 선택 드롭다운 생성
        const select = document.createElement('select');
        select.style.cssText = `
            margin-right: 8px;
            font-size: 16px;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            max-width: 150px;
            background: #000;
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        videos.forEach((video, i) => {
            const option = document.createElement('option');
            option.value = i;
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...'; // 긴 이름 자르기
            option.textContent = label;
            option.title = label; // 툴팁으로 전체 이름 표시
            if (video === currentVideo) option.selected = true; // 현재 비디오 선택 표시
            select.appendChild(option);
        });
        select.onchange = () => {
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }

            // --- 비디오 변경 시 오디오 노드 명확하게 정리하는 로직 추가 ---
            if (connectedVideo && audioCtx && sourceNode && gainNode) {
                try {
                    sourceNode.disconnect();
                    gainNode.disconnect();
                    // audioCtx.close(); // AudioContext 자체를 닫는 대신 노드만 연결 해제하여 재사용 가능성을 높임
                } catch (e) {
                    console.warn("Error disconnecting audio nodes on video change:", e);
                } finally {
                    sourceNode = null;
                    gainNode = null;
                    connectedVideo = null;
                }
            }
            // --- 오디오 노드 정리 로직 끝 ---

            // 기존 비디오의 volumechange 리스너 제거 (중복 방지)
            if (currentVideo) currentVideo.removeEventListener('volumechange', updateVolumeSelect);
            currentVideo = videos[select.value];
            // 새 비디오에 volumechange 리스너 추가
            if (currentVideo) currentVideo.addEventListener('volumechange', updateVolumeSelect);
            updateVolumeSelect(); // 새 비디오의 볼륨 상태로 드롭다운 업데이트
        };
        popup.appendChild(select);

        // 버튼 생성 헬퍼 함수
        function createButton(id, text, onClick) {
            const btn = document.createElement('button');
            btn.id = id;
            btn.textContent = text;
            btn.style.cssText = `
                font-size: 16px;
                font-weight: bold;
                padding: 4px 10px;
                border: 1px solid #fff;
                border-radius: 4px;
                background-color: rgba(0,0,0,0.5);
                color: #fff;
                cursor: pointer;
                user-select: none; /* 텍스트 선택 방지 */
                white-space: nowrap;
            `;
            // 마우스 오버 및 터치 피드백 효과 (모바일에서는 마우스 이벤트 스킵)
            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', () => {
                onClick();
                if (isMobile) { // 모바일에서 터치 시 시각적 피드백
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
                console.error('PIP Error:', e); // alert 대신 콘솔 오류 메시지 사용
            }
        }));
        popup.appendChild(createButton('back15', '《 15s', () => seekVideo(-15)));
        popup.appendChild(createButton('forward15', '15s 》', () => seekVideo(15)));

        // 볼륨 선택 드롭다운 생성
        const volumeSelect = document.createElement('select');
        volumeSelect.id = 'volume-select'; // DOM에서 쉽게 찾을 수 있도록 ID 부여
        volumeSelect.style.cssText = `
            margin-left: 8px;
            font-size: 16px;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            background: #000;
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
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
                if (popupElement) {
                    popupElement.style.opacity = idleOpacity;
                    // 투명도 변경 시 버튼 배경색도 조정 (더 투명하게)
                    popupElement.querySelectorAll('button').forEach(btn => {
                        btn.style.backgroundColor = 'rgba(0,0,0,0.1)';
                    });
                }
            } else if (value === 'opaque') {
                idleOpacity = '1';
                localStorage.setItem('vcp_idleOpacity', idleOpacity); // 설정 저장
                if (popupElement) {
                    popupElement.style.opacity = idleOpacity;
                    // 불투명 변경 시 버튼 배경색도 조정 (원래대로)
                    popupElement.querySelectorAll('button').forEach(btn => {
                        btn.style.backgroundColor = 'rgba(0,0,0,0.5)';
                    });
                }
            } else {
                currentVideo.muted = false;
                const vol = parseFloat(value);
                setAmplifiedVolume(currentVideo, vol);
            }
        };

        // 팝업 생성 시 현재 비디오의 볼륨 상태를 드롭다운에 반영하고, volumechange 이벤트 리스너 추가
        if (currentVideo) {
            currentVideo.removeEventListener('volumechange', updateVolumeSelect); // 이전 리스너 제거 (중복 방지)
            currentVideo.addEventListener('volumechange', updateVolumeSelect); // 새 리스너 추가
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
     * 팝업 생성, DOM 변경 감지, 주기적 비디오 목록 확인 등을 포함합니다.
     */
    function run() {
        createPopup(); // 초기 팝업 생성

        // MutationObserver를 사용하여 DOM 변경 감지 (비디오 추가/삭제 등)
        const mo = new MutationObserver(() => {
            const newVideos = findPlayableVideos();
            // 비디오 목록이 변경되면 팝업을 재생성하여 업데이트
            // 이때 기존 currentVideo가 새로운 목록에 없으면 첫 번째 비디오로 자동 변경됩니다.
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

    run(); // 스크립트 실행 시작

})();
