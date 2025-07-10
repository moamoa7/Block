// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM + TikTok + Flexible + Volume Select + Amplify + HLS Support)
// @namespace     Violentmonkey Scripts
// @version       4.05 // fixOverflow 자동 실행 로직 및 이전 수정사항 반영
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

    // --- Environment Flags ---
    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    // --- Configuration ---
    let idleOpacity = localStorage.getItem('vcp_idleOpacity') || '1';

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
            // 현재 도메인이 설정된 사이트와 일치하는지 확인
            if (location.hostname.includes(site.domain)) {
                site.selector.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        // console.log(`Fixing overflow for: ${sel}`, el); // 디버깅용
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

    // HLS.js 로드용 전역 변수
    let hlsScriptLoaded = false;
    let hlsLoadingPromise = null;

    function loadHlsScript() {
        if (hlsScriptLoaded) return Promise.resolve();
        if (hlsLoadingPromise) return hlsLoadingPromise;

        hlsLoadingPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.1/dist/hls.min.js';
            // 🎉 SRI (Subresource Integrity) 속성 추가
            script.integrity = 'sha256-n/Q0m/WzEaNlX4Xj+K6W4uQ2hRjN+P8C5tZ5Y7d6Q0=';
            script.crossOrigin = 'anonymous'; // SRI 사용 시 crossOrigin 속성 필요

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

    // m3u8 재생 지원 여부 확인 (브라우저 기본)
    function canPlayM3u8Native() {
        const v = document.createElement('video');
        return v.canPlayType('application/vnd.apple.mpegurl') !== '';
    }

    // hls.js로 m3u8 세팅 함수
    async function setupHlsForVideo(video, src) {
        if (!video || !src || !src.toLowerCase().endsWith('.m3u8')) {
            return false; // Not an m3u8, or invalid input
        }

        if (canPlayM3u8Native()) {
            console.debug('Video Controller Popup: Browser natively supports m3u8, no hls.js needed for:', src);
            video.src = src;
            return true;
        }

        try {
            // Ensure Hls.js is loaded
            await loadHlsScript();

            if (video.hlsInstance) {
                // Destroy existing hls instance if re-attaching
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

    // data-src 검사 및 m3u8 지원 자동 설정 포함 findPlayableVideos
    async function findPlayableVideos() { // Make this function async
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
                            // If m3u8, add to promises, but don't set src yet
                            hlsSetupPromises.push(setupHlsForVideo(v, dataSrc).then(success => {
                                if (!success) {
                                    // If HLS setup failed, clear src to prevent default browser behavior on a bad m3u8
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

        // Apply hls.js for existing m3u8 src if native support is missing
        found.forEach(v => {
            if (v.src && v.src.toLowerCase().endsWith('.m3u8') && !canPlayM3u8Native()) {
                // If it's already an m3u8 and not natively supported, set up HLS.js
                // Add to promises if not already being handled by data-src logic
                if (!hlsSetupPromises.some(p => p._video === v)) { // Prevent double handling
                     hlsSetupPromises.push(setupHlsForVideo(v, v.src).then(success => {
                        if (!success) {
                            v.src = '';
                            v.removeAttribute('src');
                        }
                    }));
                }
            }
        });

        // Wait for all HLS setup promises to resolve
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

    // --- Web Audio API 증폭 관련 변수 및 함수 ---
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

    // --- UI Update & Creation ---
    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150%', value: 1.5 }, { label: '300%', value: 3.0 }, { label: '500%', value: 5.0 },
        { label: '투명', value: 'transparent' },
        { label: '불투명', value: 'opaque' }
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

        if (idleOpacity === '0.025') {
            volumeSelect.value = 'transparent';
        } else if (idleOpacity === '1') {
            volumeSelect.value = 'opaque';
        }
    }

    async function createPopup() { // Make this async
        const latestVideos = await findPlayableVideos(); // Await the result
        if (latestVideos.length === videos.length && latestVideos.every((v, i) => v === videos[i])) {
            return;
        }

        videos = latestVideos;

        const hostRoot = document.body;
        // 기존 popupElement가 있다면 제거: .remove()로 단일화
        if (popupElement) {
            popupElement.remove();
            popupElement = null; // 참조도 제거
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
            opacity: ${idleOpacity};
        `;
        popupElement = popup;

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

            if (currentVideo) currentVideo.removeEventListener('volumechange', updateVolumeSelect);
            currentVideo = videos[select.value];
            if (currentVideo) currentVideo.addEventListener('volumechange', updateVolumeSelect);
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
            background: #000;
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
            text-overflow: ellipsis;
            white-space: nowrap;
        `;

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
            } else if (val === 'transparent') {
                idleOpacity = '0.025';
                localStorage.setItem('vcp_idleOpacity', idleOpacity);
                popupElement.style.opacity = idleOpacity;
            } else if (val === 'opaque') {
                idleOpacity = '1';
                localStorage.setItem('vcp_idleOpacity', idleOpacity);
                popupElement.style.opacity = idleOpacity;
            } else {
                currentVideo.muted = false;
                if (val > 1) {
                    setAmplifiedVolume(currentVideo, Number(val));
                } else {
                    setAmplifiedVolume(currentVideo, Number(val));
                }
            }
        });

        popup.appendChild(volumeSelect);

        currentVideo.addEventListener('volumechange', updateVolumeSelect);

        hostRoot.appendChild(popup);

        updateVolumeSelect();
        // fixOverflow() 호출은 run() 함수에서 주기적으로 처리됩니다.
    }

    // --- Debounce Utility ---
    let debounceTimer;
    function debounce(func, delay) {
        return function() {
            const context = this;
            const args = arguments;
            clearTimeout(debounceTimer);
            // Ensure createPopup is awaited when debounced
            Promise.resolve(func.apply(context, args));
        };
    }

    const debouncedCreatePopup = debounce(createPopup, 100);

    // --- Main Execution ---
    function run() {
        // Initial popup creation, awaited to ensure HLS is handled for initial videos
        createPopup().then(() => {
            const mo = new MutationObserver(() => {
                debouncedCreatePopup();
            });
            mo.observe(document.body, { childList: true, subtree: true });

            // 주기적으로 팝업을 생성하여 새로운 비디오를 감지
            setInterval(() => {
                debouncedCreatePopup();
            }, 5000); // 5초마다 실행

            // Twitch와 같은 사이트에서 overflow 문제 해결을 위해 fixOverflow 함수 호출
            // 설정된 overflowFixSites가 현재 도메인에 적용될 때만 실행
            if (overflowFixTargets.some(site => location.hostname.includes(site.domain))) {
                fixOverflow(); // 초기 로드 시 한 번 실행
                setInterval(fixOverflow, 1000); // 1초마다 주기적으로 실행
            }
        });
    }

    run();

    // --- User Configuration Access (개발자 도구 콘솔을 통해 접근) ---
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
            console.log("Video Controller Popup: Current idleOpacity:", idleOpacity);
            return idleOpacity;
        },
        setIdleOpacity: (opacity) => {
            if (opacity === '0.025' || opacity === '1') {
                localStorage.setItem('vcp_idleOpacity', opacity);
                idleOpacity = opacity;
                if (popupElement) {
                    popupElement.style.opacity = idleOpacity;
                    popupElement.querySelectorAll('button').forEach(btn => {
                        btn.style.backgroundColor = opacity === '0.025' ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';
                    });
                }
                console.log("Video Controller Popup: idleOpacity updated to:", opacity);
            } else {
                console.warn("Video Controller Popup: Invalid opacity. Use '0.025' for transparent or '1' for opaque.");
            }
        },
        getVersion: () => {
             console.log("Video Controller Popup: Current version is 4.05");
             return "4.05";
        }
    };

    console.log("Video Controller Popup script loaded. Type `vcp_config` in console for configuration options.");

})();
