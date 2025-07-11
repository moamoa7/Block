// ==UserScript==
// @name Video Controller Popup (Full Fix + Shadow DOM Deep + TikTok + Flexible Sites + Volume Select + Amplify)
// @namespace Violentmonkey Scripts
// @version 4.09.8_Optimized (Transparent Default + Amp Fix) 
// @description 여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix Seek + Twitch + TikTok 대응 + 배열 관리 + 볼륨 SELECT + 증폭 (Shadow DOM Deep)
// @match *://*/*
// @grant none
// ==/UserScript==

(function() {
    'use strict';

    // --- Core Variables & State Management ---
    let currentIntervalId = null; 
    let videos = [];              
    let currentVideo = null;      
    let popupElement = null;      
    let isSeeking = false;        

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    // 팝업 투명도 설정: localStorage에 설정값이 없으면 '0.025' (투명)을 기본값으로 사용
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '0.025';
    
    // Lazy-src 예외 사이트
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
        { domain: 'youtube.com', interval: 100 }
    ];
    let forceInterval = 200; // 기본 강제 유지 간격 (ms)
    forcePlaybackRateSites.forEach(site => {
        if (location.hostname.includes(site.domain)) {
            forceInterval = site.interval;
        }
    });

    // 증폭(Amplification)이 차단되어야 하는 사이트 (볼륨 100% 이상 불가)
    const amplificationBlockedSites = [
        'netflix.com'
    ];
    const isAmplificationBlocked = amplificationBlockedSites.some(site => location.hostname.includes(site));


    // overflow visible fix 사이트 설정
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
            v.clientWidth > 50 && 
            v.clientHeight > 50   
        );
    }

    /**
     * 비디오의 재생 속도를 설정하고, 특정 사이트에서는 이를 강제 유지합니다.
     */
    function fixPlaybackRate(video, rate) {
        if (!video) return;
        video.playbackRate = rate;

        if (currentIntervalId) {
            clearInterval(currentIntervalId);
        }

        const siteConfig = forcePlaybackRateSites.find(site => location.hostname.includes(site.domain));
        if (siteConfig) {
            currentIntervalId = setInterval(() => {
                if (video.playbackRate !== rate) {
                    video.playbackRate = rate;
                }
                if (!document.body.contains(video)) {
                     clearInterval(currentIntervalId);
                     currentIntervalId = null;
                }
            }, siteConfig.interval);
        }
    }

    /**
     * 비디오의 재생 시간을 이동시킵니다. 넷플릭스 전용 로직 포함.
     */
    function seekVideo(seconds) {
        if (isSeeking) return; 
        isSeeking = true;

        if (isNetflix) {
            try {
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Netflix seek error:', e);
            }
        } else if (currentVideo) {
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }

        setTimeout(() => { isSeeking = false; }, 100); 
    }

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null; 

    /**
     * Web Audio Context를 설정하여 비디오의 오디오를 조작할 수 있도록 준비합니다.
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

            sourceNode = audioCtx.createMediaElementSource(video);
            gainNode = audioCtx.createGain();

            sourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            connectedVideo = video; 
            return true;
        } catch (e) {
            console.error("Failed to setup AudioContext. Amplification might not work:", e);
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;
            return false;
        }
    }

    /**
     * 비디오의 볼륨을 설정합니다. 100% 초과 볼륨은 Web Audio API를 사용하여 증폭합니다.
     * 특정 사이트에서는 증폭을 차단하고 100%로 강제 설정합니다.
     */
    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        // 증폭 차단 사이트에서 100% 이상 볼륨 요청 시 100%로 제한
        if (isAmplificationBlocked && vol > 1) {
            console.warn(`Amplification is restricted on this site (${location.hostname}). Setting volume to 100%.`);
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = 1;
            return;
        }

        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume().catch(e => console.error("AudioContext resume error:", e));
        }

        if (vol <= 1) {
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } else {
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    console.warn("Audio amplification not available. Setting video volume to 100%.");
                    video.volume = 1; 
                    return;
                }
            }

            if (gainNode) {
                video.volume = 1;
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
    ];

    /**
     * 팝업의 볼륨 드롭다운을 현재 비디오의 볼륨 상태에 맞춰 업데이트합니다.
     */
    function updateVolumeSelect() {
        const volumeSelect = popupElement?.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0; 
        } else {
            let effectiveVolume = currentVideo.volume;
            if (gainNode && connectedVideo === currentVideo) {
                effectiveVolume = gainNode.gain.value;
            }

            // 가장 가까운 볼륨 옵션 찾기
            const closest = volumeOptions.reduce((prev, curr) => {
                if (typeof curr.value !== 'number') return prev; 
                return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
            }, { value: 1.0 });

            volumeSelect.value = closest.value;
        }
    }

    /**
     * 비디오 컨트롤 팝업 UI를 생성하거나 업데이트합니다.
     */
    function createPopup() {
        const hostRoot = document.body;

        if (popupElement) popupElement.remove();
        
        videos = findPlayableVideos();
        
        if (videos.length === 0) {
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            return;
        }

        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos[0];
        }

        // 팝업 요소 생성 및 스타일 설정
        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 10px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0,0,0,0.5);
            color: #fff;
            padding: 8px 12px;
            border-radius: 8px;
            z-index: 2147483647;
            pointer-events: auto;
            display: flex;
            flex-wrap: nowrap;
            gap: 8px;
            align-items: center;
            box-shadow: 0 0 15px rgba(0,0,0,0.5);
            transition: opacity 0.3s ease;
            opacity: ${idleOpacity}; // 초기 투명도 적용 (기본값 0.025)
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
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...';
            option.textContent = label;
            option.title = video.currentSrc;
            
            if (video === currentVideo) {
                 option.selected = true;
            }
            videoSelect.appendChild(option);
        });

        videoSelect.onchange = () => {
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }

            // 비디오 변경 시 오디오 노드 정리
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

            if (currentVideo) currentVideo.removeEventListener('volumechange', updateVolumeSelect);
            
            currentVideo = videos[videoSelect.value];
            
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
            
            // 증폭 차단 사이트에서는 100% 이상 옵션을 비활성화
            if (isAmplificationBlocked && parseFloat(opt.value) > 1) {
                option.disabled = true;
                option.title = "Amplification blocked on this site";
            }
            volumeSelect.appendChild(option);
        });

        volumeSelect.onchange = () => {
            if (!currentVideo) return;
            const value = volumeSelect.value;
            
            if (value === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
            } else {
                currentVideo.muted = false;
                const vol = parseFloat(value);
                setAmplifiedVolume(currentVideo, vol);
            }
        };

        // 팝업 생성 시 볼륨 상태 동기화
        if (currentVideo) {
            currentVideo.removeEventListener('volumechange', updateVolumeSelect); 
            currentVideo.addEventListener('volumechange', updateVolumeSelect);
        }
        updateVolumeSelect(); 
        popup.appendChild(volumeSelect);

        // 팝업 투명도 자동 조절 (마우스 오버/터치)
        // PC: 마우스 진입 시 불투명, 이탈 시 투명 (idleOpacity로 복귀)
        if (!isMobile) {
            popup.addEventListener('mouseenter', () => {
                popup.style.opacity = '1';
            });
            popup.addEventListener('mouseleave', () => {
                popup.style.opacity = idleOpacity;
            });
        } 
        // 모바일: 터치 시 불투명, 3초 후 투명
        else {
            popup.addEventListener('touchstart', () => {
                popup.style.opacity = '1';
                clearTimeout(popup.fadeTimeout);
                popup.fadeTimeout = setTimeout(() => {
                    popup.style.opacity = idleOpacity;
                }, 3000); 
            });
        }
        
        hostRoot.appendChild(popup);
    }

    // --- Main Execution ---
    /**
     * 스크립트의 주요 실행 로직을 시작합니다.
     */
    function run() {
        createPopup(); 

        // MutationObserver를 사용하여 DOM 변경 감지 (비디오 추가/삭제 등)
        const mo = new MutationObserver(() => {
            const newVideos = findPlayableVideos();
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                createPopup();
            }
        });
        mo.observe(document.body, { childList: true, subtree: true });

        // 주기적으로 비디오 목록 확인
        setInterval(() => {
            const newVideos = findPlayableVideos();
            if (newVideos.length !== videos.length || !newVideos.every((v, i) => v === videos[i])) {
                createPopup();
            }
        }, 2000); 

        // 오버플로우 픽스 대상 사이트가 있으면 주기적으로 실행
        if (overflowFixTargets.length > 0) {
            fixOverflow(); 
            setInterval(fixOverflow, 1000); 
        }
    }

    // 스크립트 실행 시작
    run();
})();
