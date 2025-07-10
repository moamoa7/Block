// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM + TikTok + Flexible + Volume Select + Amplify + HLS Support)
// @namespace     Violentmonkey Scripts
// @version       4.08 // 모바일 iframe 내 팝업 활성화 개선 (영상 이벤트 활용)
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix + Twitch + TikTok 대응 + 볼륨 SELECT + 증폭 + m3u8 (HLS.js) 지원 (Shadow DOM Deep)
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
    let opacityTimer = null; // 투명도 자동 복귀 타이머

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    let currentOpacity = 0.025; // 초기값을 투명으로 설정
    const OPAQUE_OPACITY = 1;
    const TRANSPARENT_OPACITY = 0.025;
    const OPACITY_RESET_DELAY = 5000; // 5초 (밀리초)

    const lazySrcBlacklist = [
        'missav.ws',
        'missav.live',
        'example.net'
    ];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));

    const VALID_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m3u8'];

    const forcePlaybackRateSites = [
        { domain: 'twitch.tv', interval: 50 },
        { domain: 'tiktok.com', interval: 20 }
    ];
    let forceInterval = 200;
    forcePlaybackRateSites.forEach(site => {
        if (location.hostname.includes(site.domain)) {
            forceInterval = site.interval;
        }
    });

    let customOverflowFixSites = [];
    const defaultOverflowFixSites = [
        { domain: 'twitch.tv', selector: [
            'div.video-player__container',
            'div.video-player-theatre-mode__player',
            'div.player-theatre-mode'
        ]},
    ];

    try {
        const storedSites = localStorage.getItem('vcp_overflowFixSites');
        if (storedSites) {
            const parsedSites = JSON.parse(storedSites);
            if (Array.isArray(parsedSites) && parsedSites.every(item =>
                typeof item === 'object' && item !== null &&
                typeof item.domain === 'string' &&
                Array.isArray(item.selector) && item.selector.every(s => typeof s === 'string')
            )) {
                customOverflowFixSites = parsedSites;
                console.log('Video Controller Popup: Loaded custom overflowFixSites from localStorage.');
            } else {
                console.warn('Video Controller Popup: Invalid vcp_overflowFixSites data in localStorage. Using default.');
            }
        }
    } catch (e) {
        console.warn('Video Controller Popup: Error parsing vcp_overflowFixSites from localStorage. Using default.', e);
    }

    const overflowFixTargets = customOverflowFixSites.length > 0 ? customOverflowFixSites : defaultOverflowFixSites;

    // --- Utility Functions ---

    function fixOverflow() {
        overflowFixTargets.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selector.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.overflow = 'visible';
                    });
                });
            }
        });
    }

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

    let hlsScriptLoaded = false;
    let hlsLoadingPromise = null;

    function loadHlsScript() {
        if (hlsScriptLoaded) return Promise.resolve();
        if (hlsLoadingPromise) return hlsLoadingPromise;

        hlsLoadingPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.1/dist/hls.min.js';
            script.integrity = 'sha256-n/Q0m/WzEaNlX4Xj+K6W4uQ2hRjN+P8C5tZ5Y7d6Q0=';
            script.crossOrigin = 'anonymous';

            script.onload = () => {
                hlsScriptLoaded = true;
                console.log('Video Controller Popup: hls.js loaded with SRI.');
                resolve();
            };
            script.onerror = () => {
                console.error('Video Controller Popup: Failed to load hls.js with SRI. Integrity check failed or network error.');
                reject(new Error('Failed to load hls.js with SRI'));
            };
            document.head.appendChild(script);
        });
        return hlsLoadingPromise;
    }

    function canPlayM3u8Native() {
        const v = document.createElement('video');
        return v.canPlayType('application/vnd.apple.mpegurl') !== '';
    }

    async function setupHlsForVideo(video, src) {
        if (!video || !src || !src.toLowerCase().endsWith('.m3u8')) {
            return false;
        }

        if (canPlayM3u8Native()) {
            console.debug('Video Controller Popup: Browser natively supports m3u8, no hls.js needed for:', src);
            video.src = src;
            return true;
        }

        try {
            await loadHlsScript();

            if (video.hlsInstance) {
                video.hlsInstance.destroy();
                video.hlsInstance = null;
            }

            if (window.Hls && window.Hls.isSupported()) {
                const hls = new window.Hls();
                hls.loadSource(src);
                hls.attachMedia(video);
                video.hlsInstance = hls;
                console.log('Video Controller Popup: hls.js attached to video:', src);
                return true;
            } else {
                console.warn('Video Controller Popup: hls.js not supported by this browser or failed to initialize.');
                return false;
            }
        } catch (error) {
            console.error('Video Controller Popup: Error setting up hls.js for video:', src, error);
            return false;
        }
    }

    async function findPlayableVideos() {
        const found = findAllVideosDeep();
        const hlsSetupPromises = [];

        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset && v.dataset.src) {
                    const dataSrc = v.dataset.src;
                    let isValidUrl = false;
                    try {
                        const url = new URL(dataSrc, window.location.href);
                        if (['http:', 'https:'].includes(url.protocol) &&
                            VALID_VIDEO_EXTENSIONS.some(ext => url.pathname.toLowerCase().endsWith(ext))) {
                            isValidUrl = true;
                        }
                    } catch (e) {
                        console.debug(`Video Controller Popup: Invalid data-src URL format or protocol: ${dataSrc}`);
                    }

                    if (isValidUrl) {
                        if (dataSrc.toLowerCase().endsWith('.m3u8')) {
                            hlsSetupPromises.push(setupHlsForVideo(v, dataSrc).then(success => {
                                if (!success) {
                                    v.src = '';
                                    v.removeAttribute('src');
                                }
                            }));
                        } else {
                            v.src = dataSrc;
                        }
                    } else {
                        console.debug(`Video Controller Popup: Skipping data-src for video (not valid video URL): ${dataSrc}`);
                    }
                }
            });
        }

        found.forEach(v => {
            if (v.src && v.src.toLowerCase().endsWith('.m3u8') && !canPlayM3u8Native()) {
                if (!hlsSetupPromises.some(p => p._video === v)) {
                     hlsSetupPromises.push(setupHlsForVideo(v, v.src).then(success => {
                        if (!success) {
                            v.src = '';
                            v.removeAttribute('src');
                        }
                    }));
                }
            }
        });

        if (hlsSetupPromises.length > 0) {
            await Promise.all(hlsSetupPromises.map(p => p.catch(e => console.error("Video Controller Popup: HLS setup promise failed:", e))));
        }

        return found.filter(v => !v.classList.contains('hidden'));
    }


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

    function seekVideo(seconds) {
        if (isNetflix) {
            try {
                const player = netflix.appContext.state.playerApp.getAPI().videoPlayer;
                const sessionId = player.getAllPlayerSessionIds()[0];
                if (!sessionId) {
                    console.warn('Video Controller Popup: Netflix player session ID not found.');
                    return;
                }
                const playerSession = player.getVideoPlayerBySessionId(sessionId);
                if (!playerSession) {
                    console.warn('Video Controller Popup: Netflix video player session not found for ID:', sessionId);
                    return;
                }
                const newTime = playerSession.getCurrentTime() + seconds * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Video Controller Popup: Netflix seek error (Player API might have changed):', e);
            }
        } else if (currentVideo) {
            currentVideo.currentTime = Math.min(
                currentVideo.duration,
                Math.max(0, currentVideo.currentTime + seconds)
            );
        }
    }

    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    function setupAudioContext(video) {
        try {
            if (audioCtx && audioCtx.state !== 'closed') {
                try { audioCtx.close(); } catch (e) { console.warn("Video Controller Popup: Error closing old AudioContext:", e); }
            }
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;

            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            sourceNode = audioCtx.createMediaElementSource(video);
            gainNode = audioCtx.createGain();
            sourceNode.connect(gainNode);
            gainNode.connect(audioCtx.destination);
            connectedVideo = video;
            return true;
        } catch (e) {
            console.error("Video Controller Popup: Failed to setup AudioContext. Amplification might not work:", e);
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;
            return false;
        }
    }

    function setAmplifiedVolume(video, vol) {
        if (!video) return;

        if (vol <= 1) {
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            video.volume = vol;
        } else {
            if (!audioCtx || connectedVideo !== video) {
                if (!setupAudioContext(video)) {
                    console.warn("Video Controller Popup: Audio amplification not available. Setting video volume to 100%.");
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

    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150%', value: 1.5 }, { label: '300%', value: 3.0 }, { label: '500%', value: 5.0 }
    ];

    function updateVolumeSelect() {
        const volumeSelect = popupElement.querySelector('#volume-select');
        if (!currentVideo || !volumeSelect) return;

        if (currentVideo.muted) {
            volumeSelect.value = 'muted';
            if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
        } else {
            let currentVol = currentVideo.volume;
            let currentGain = 1;
            if (gainNode && connectedVideo === currentVideo) {
                currentGain = gainNode.gain.value;
            }

            let effectiveVolume = currentVol * currentGain;

            const closest = volumeOptions.reduce((prev, curr) => {
                if (typeof curr.value !== 'number') return prev;
                return Math.abs(curr.value - effectiveVolume) < Math.abs(prev.value - effectiveVolume) ? curr : prev;
            }, { value: 1.0 });

            volumeSelect.value = closest.value;
        }
    }

    function setPopupOpacity(opacityValue) {
        if (popupElement) {
            popupElement.style.opacity = opacityValue;
            currentOpacity = opacityValue;
            const btnBg = opacityValue === TRANSPARENT_OPACITY ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';
            popupElement.querySelectorAll('button, select').forEach(el => {
                el.style.backgroundColor = btnBg;
            });
        }
    }

    function resetOpacityTimer() {
        clearTimeout(opacityTimer);
        setPopupOpacity(OPAQUE_OPACITY);
        opacityTimer = setTimeout(() => {
            setPopupOpacity(TRANSPARENT_OPACITY);
        }, OPACITY_RESET_DELAY);
    }

    // 기존 비디오에 이벤트 리스너 제거
    function removeVideoEventListeners(video) {
        if (!video) return;
        video.removeEventListener('play', resetOpacityTimer);
        video.removeEventListener('pause', resetOpacityTimer);
        video.removeEventListener('seeking', resetOpacityTimer);
        video.removeEventListener('volumechange', updateVolumeSelect); // 볼륨 셀렉트 업데이트 이벤트는 유지
    }

    // 새로운 비디오에 이벤트 리스너 추가
    function addVideoEventListeners(video) {
        if (!video) return;
        video.addEventListener('play', resetOpacityTimer);
        video.addEventListener('pause', resetOpacityTimer);
        video.addEventListener('seeking', resetOpacityTimer);
        // 'volumechange'는 updateVolumeSelect에서 이미 처리되므로 중복 추가 방지
    }

    async function createPopup() {
        const latestVideos = await findPlayableVideos();
        // 비디오 목록에 변화가 없으면 팝업 재생성 불필요
        if (latestVideos.length === videos.length && latestVideos.every((v, i) => v === videos[i])) {
            return;
        }

        // 기존 비디오들에 붙어있던 이벤트 리스너 제거 (새 비디오 목록 반영 전)
        videos.forEach(removeVideoEventListeners);

        videos = latestVideos;

        const hostRoot = document.body;
        if (popupElement) {
            popupElement.remove();
            popupElement = null;
        }

        if (videos.length === 0) {
            if (currentIntervalId) clearInterval(currentIntervalId);
            currentIntervalId = null;
            currentVideo = null;
            if (audioCtx && audioCtx.state !== 'closed') {
                try { audioCtx.close(); } catch (e) { console.warn("Video Controller Popup: Error closing AudioContext when no videos found:", e); }
            }
            audioCtx = null;
            return;
        }

        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos[0];
        }

        const popup = document.createElement('div');
        popup.id = 'video-controller-popup';
        popup.style.cssText = `
            position: fixed;
            bottom: 0px;
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
            opacity: ${currentOpacity};
        `;
        popupElement = popup;

        popupElement.addEventListener('click', resetOpacityTimer);


        const select = document.createElement('select');
        select.style.cssText = `
            margin-right: 8px;
            font-size: 16px;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            max-width: 150px;
            background: rgba(0,0,0,0.5);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        select.style.backgroundColor = currentOpacity === TRANSPARENT_OPACITY ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';


        videos.forEach((video, i) => {
            const option = document.createElement('option');
            option.value = i;
            let label = video.currentSrc ? video.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...';
            option.textContent = label;
            option.title = label;
            if (video === currentVideo) option.selected = true;
            select.appendChild(option);
        });
        select.onchange = () => {
            if (currentIntervalId) {
                clearInterval(currentIntervalId);
                currentIntervalId = null;
            }

            if (audioCtx && audioCtx.state !== 'closed') {
                try { audioCtx.close(); } catch (e) { console.warn("Video Controller Popup: Error closing AudioContext on video change:", e); }
            }
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;

            if (currentVideo) removeVideoEventListeners(currentVideo); // 이전 비디오 이벤트 제거
            currentVideo = videos[select.value];
            if (currentVideo) addVideoEventListeners(currentVideo); // 새 비디오 이벤트 추가
            currentVideo.addEventListener('volumechange', updateVolumeSelect); // 볼륨 셀렉트 업데이트는 항상
            updateVolumeSelect();
        };
        popup.appendChild(select);

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
                user-select: none;
                white-space: nowrap;
            `;
            btn.style.backgroundColor = currentOpacity === TRANSPARENT_OPACITY ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';


            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile && currentOpacity === OPAQUE_OPACITY) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', () => {
                onClick();
                resetOpacityTimer();
                if (isMobile) {
                    btn.style.backgroundColor = 'rgba(125,125,125,0.8)';
                    setTimeout(() => { btn.style.backgroundColor = currentOpacity === OPAQUE_OPACITY ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)'; }, 200);
                }
            });
            return btn;
        }

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
                console.error('Video Controller Popup: PIP 실패:', e);
            }
        }));
        popup.appendChild(createButton('rewind', '⏪ 5초', () => seekVideo(-5)));
        popup.appendChild(createButton('forward', '5초 ⏩', () => seekVideo(5)));

        const volumeSelect = document.createElement('select');
        volumeSelect.id = 'volume-select';
        volumeSelect.style.cssText = `
            font-size: 14px;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            background: rgba(0,0,0,0.5);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        volumeSelect.style.backgroundColor = currentOpacity === TRANSPARENT_OPACITY ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';


        volumeOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            volumeSelect.appendChild(option);
        });

        volumeSelect.addEventListener('change', () => {
            if (!currentVideo) return;
            const val = volumeSelect.value;
            if (val === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
            } else {
                currentVideo.muted = false;
                if (val > 1) {
                    setAmplifiedVolume(currentVideo, Number(val));
                } else {
                    setAmplifiedVolume(currentVideo, Number(val));
                }
            }
            resetOpacityTimer();
        });

        popup.appendChild(volumeSelect);

        // 새로운 currentVideo에 이벤트 리스너 추가
        if (currentVideo) {
            addVideoEventListeners(currentVideo);
            currentVideo.addEventListener('volumechange', updateVolumeSelect);
        }

        hostRoot.appendChild(popup);

        updateVolumeSelect();
        setPopupOpacity(currentOpacity);
    }

    let debounceTimer;
    function debounce(func, delay) {
        return function() {
            const context = this;
            const args = arguments;
            clearTimeout(debounceTimer);
            Promise.resolve(func.apply(context, args));
        };
    }

    const debouncedCreatePopup = debounce(createPopup, 100);

    function run() {
        createPopup().then(() => {
            const mo = new MutationObserver(() => {
                debouncedCreatePopup();
            });
            mo.observe(document.body, { childList: true, subtree: true });

            setInterval(() => {
                debouncedCreatePopup();
            }, 5000);

            if (overflowFixTargets.some(site => location.hostname.includes(site.domain))) {
                fixOverflow();
                setInterval(fixOverflow, 1000);
            }

            // 문서 전체 클릭 이벤트 리스너 유지 (iframe 밖 영역 클릭 감지용)
            document.body.addEventListener('click', (event) => {
                if (popupElement && !popupElement.contains(event.target)) {
                    resetOpacityTimer();
                }
            });

            // 초기 로드 시 투명 상태로 시작
            setTimeout(() => {
                setPopupOpacity(TRANSPARENT_OPACITY);
            }, OPACITY_RESET_DELAY);
        });
    }

    run();

    window.vcp_config = {
        getOverflowFixSites: () => {
            console.log("Video Controller Popup: Current overflowFixSites configuration:", overflowFixTargets);
            console.log("To add/modify, use vcp_config.setOverflowFixSites([...]).");
            console.log("Example for Twitch (default):", JSON.stringify(defaultOverflowFixSites));
            return overflowFixTargets;
        },
        setOverflowFixSites: (sites) => {
            try {
                if (!Array.isArray(sites) || !sites.every(item =>
                    typeof item === 'object' && item !== null &&
                    typeof item.domain === 'string' &&
                    Array.isArray(item.selector) && item.selector.every(s => typeof s === 'string')
                )) {
                    console.error("Video Controller Popup: Invalid format for setOverflowFixSites. Expected an array of { domain: string, selector: string[] } objects.");
                    return;
                }
                const sitesJson = JSON.stringify(sites);
                localStorage.setItem('vcp_overflowFixSites', sitesJson);
                console.log("Video Controller Popup: overflowFixSites updated. Please refresh the page to apply changes.");
                console.log("New config:", sites);
            } catch (e) {
                console.error("Video Controller Popup: Failed to set overflowFixSites. Please check JSON format.", e);
            }
        },
        resetOverflowFixSites: () => {
            localStorage.removeItem('vcp_overflowFixSites');
            console.log("Video Controller Popup: overflowFixSites reset to default. Please refresh the page.");
        },
        getLazySrcBlacklist: () => {
            console.log("Video Controller Popup: Current lazySrcBlacklist:", lazySrcBlacklist);
            console.log("This list is hardcoded for safety and and cannot be changed via console.");
            return lazySrcBlacklist;
        },
        getValidVideoExtensions: () => {
            console.log("Video Controller Popup: Current VALID_VIDEO_EXTENSIONS:", VALID_VIDEO_EXTENSIONS);
            console.log("This list is hardcoded for safety and and cannot be changed via console.");
            return VALID_VIDEO_EXTENSIONS;
        },
        getPlaybackRateForceSites: () => {
            console.log("Video Controller Popup: Current forcePlaybackRateSites:", forcePlaybackRateSites);
            console.log("This list is hardcoded for safety and and cannot be changed via console.");
            return forcePlaybackRateSites;
        },
        getIdleOpacity: () => {
            console.log("Video Controller Popup: Idle opacity is now managed automatically. Current opacity:", currentOpacity);
            return currentOpacity;
        },
        setIdleOpacity: () => {
            console.warn("Video Controller Popup: setIdleOpacity is deprecated. Opacity is now managed automatically based on user interaction.");
        },
        getVersion: () => {
             console.log("Video Controller Popup: Current version is 4.08");
             return "4.08";
        }
    };

    console.log("Video Controller Popup script loaded. Type `vcp_config` in console for configuration options.");

})();
