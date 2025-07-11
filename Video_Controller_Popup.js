// ==UserScript==
// @name          Video Controller Popup (Full Fix + Shadow DOM + TikTok + Flexible + Volume Select + Amplify + HLS Support)
// @namespace     Violentmonkey Scripts
// @version       4.09.5 // Added: Whitelist for volume amplification restriction
// @description   여러 영상 선택 + 앞뒤 이동 + 배속 + PIP + Lazy data-src + Netflix + Twitch + TikTok 대응 + 볼륨 SELECT + 증폭 + m3u8 (HLS.js) 지원 (Shadow DOM Deep)
// @match         *://*/*
// @grant         none
// ==/UserScript==

(function() {
    'use strict';

    /*** --- [ 1. Core Variables & Config ] --- ***/
    let currentIntervalId = null; // Still keep for potential cleanup, but less critical for rate forcing
    let currentPlaybackRateRAFId = null; // For requestAnimationFrame
    let currentPlaybackRateObserver = null; // For MutationObserver on playbackRate
    let videos = [];
    let currentVideo = null;
    let popupElement = null;
    let opacityTimer = null;
    let desiredPlaybackRate = 1.0; // Store the desired rate

    const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isNetflix = location.hostname.includes('netflix.com');

    const OPAQUE_OPACITY = 1;
    //const TRANSPARENT_OPACITY = 0.025;
    const TRANSPARENT_OPACITY = 1;
    const OPACITY_RESET_DELAY = 3000;

    const lazySrcBlacklist = ['missav.ws', 'missav.live', 'example.net'];
    const isLazySrcBlockedSite = lazySrcBlacklist.some(site => location.hostname.includes(site));
    const VALID_VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m3u8'];

    // forcePlaybackRateSites are now primarily for `MutationObserver` or `requestAnimationFrame` checks
    // The `interval` property might still be useful for other potential periodic checks if needed,
    // but the core rate enforcement shifts to MO/RAF.
    const forcePlaybackRateSites = [
        { domain: 'twitch.tv', interval: 50 },
        { domain: 'tiktok.com', interval: 20 }
    ];
    let forceInterval = 200; // Default, will be overridden if on a specific site
    forcePlaybackRateSites.forEach(site => {
        if (location.hostname.includes(site.domain)) {
            forceInterval = site.interval; // Still used as a general "how often to check"
        }
    });

    const defaultOverflowFixSites = [
        { domain: 'twitch.tv', selector: [
            'div.video-player__container',
            'div.video-player-theatre-mode__player',
            'div.player-theatre-mode'
        ]}
    ];

    let customOverflowFixSites = [];
    try {
        const storedSites = localStorage.getItem('vcp_overflowFixSites');
        if (storedSites) {
            const parsed = JSON.parse(storedSites);
            if (Array.isArray(parsed)) customOverflowFixSites = parsed;
        }
    } catch { customOverflowFixSites = []; }

    const overflowFixTargets = customOverflowFixSites.length > 0 ? customOverflowFixSites : defaultOverflowFixSites;

    // --- NEW: Whitelist for sites where volume amplification should be restricted (100% max) ---
    // Please add the domains where you want this behavior to apply.
    const volumeAmplificationRestrictionSites = [
        'avsee.ru', // Example domain
        // 'another-site.com',
    ];
    const isVolumeAmplificationRestricted = volumeAmplificationRestrictionSites.some(site => location.hostname.includes(site));
    // -----------------------------------------------------------------------------------------

    /*** --- [ 2. Utility Functions ] --- ***/

    const fixOverflow = () => {
        overflowFixTargets.forEach(site => {
            if (location.hostname.includes(site.domain)) {
                site.selector.forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => {
                        el.style.overflow = 'visible';
                    });
                });
            }
        });
    };

    const findAllVideosDeep = (root = document) => {
        let found = [];
        root.querySelectorAll('video').forEach(v => found.push(v));
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) {
                found = found.concat(findAllVideosDeep(el.shadowRoot));
            }
        });
        return found;
    };

    let debounceTimer;
    function debounce(func, delay) {
        return function() {
            const context = this;
            const args = arguments;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                func.apply(context, args);
            }, delay);
        };
    }
    const debouncedCreatePopup = debounce(async () => { await createPopup(); }, 100);


    /*** --- [ 3. HLS (m3u8) Support ] --- ***/
    let hlsScriptLoaded = false;
    let hlsScriptLoadAttempted = false; // Add a flag to track if load has been attempted

    const loadHlsScript = () => {
        if (hlsScriptLoaded) return Promise.resolve();
        if (hlsScriptLoadAttempted) {
             // If load was attempted and failed, reject immediately.
            return Promise.reject(new Error('hls.js load previously failed.'));
        }
        hlsScriptLoadAttempted = true; // Mark as attempted
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.1/dist/hls.min.js';
            s.integrity = 'sha256-n/Q0m/WzEaNlX4Xj+K6W4uQ2hRjN+P8C5tZ5Y7d6Q0='; // SRI 추가
            s.crossOrigin = 'anonymous'; // SRI를 위해 필요
            s.onload = () => { hlsScriptLoaded = true; resolve(); };
            s.onerror = () => { // HLS 로드 실패 시 에러 처리 강화
                console.error('Video Controller Popup: Failed to load hls.js with SRI. Integrity check failed or network error.');
                // Display a user-friendly alert or notification
                alert('Video Controller Popup: Failed to load HLS.js. M3U8 videos might not play correctly.');
                reject(new Error('Failed to load hls.js with SRI'));
            };
            document.head.appendChild(s);
        });
    };

    const canPlayM3u8Native = () => {
        const v = document.createElement('video');
        return !!v.canPlayType('application/vnd.apple.mpegurl');
    };

    const setupHlsForVideo = async (video, src) => {
        if (canPlayM3u8Native()) {
            video.src = src;
            return;
        }
        try {
            await loadHlsScript();
            if (video.hlsInstance) { // 기존 인스턴스 정리
                video.hlsInstance.destroy();
                video.hlsInstance = null;
            }
            if (window.Hls && window.Hls.isSupported()) {
                const hls = new Hls();
                hls.loadSource(src);
                hls.attachMedia(video);
                video.hlsInstance = hls;
            } else {
                console.warn('Video Controller Popup: HLS.js not supported by this browser or failed to initialize.');
                video.src = ''; // HLS 지원 없으면 src 초기화
                video.removeAttribute('src');
                // Inform the user about the HLS limitation
                // You could add a small temporary message near the video or within the popup
            }
        } catch (error) {
            console.error('Video Controller Popup: Error setting up hls.js for video:', src, error);
            video.src = ''; // 에러 발생 시 src 초기화
            video.removeAttribute('src');
            // Inform the user about the HLS setup failure
            // Consider displaying a more prominent message if multiple HLS videos fail
        }
    };

    /*** --- [ 4. Video Finding & Lazy Src ] --- ***/
    const findPlayableVideos = async () => {
        const found = findAllVideosDeep();
        const hlsPromises = [];
        if (!isLazySrcBlockedSite) {
            found.forEach(v => {
                if (!v.src && v.dataset?.src) {
                    const dataSrc = v.dataset.src;
                    const isValid = VALID_VIDEO_EXTENSIONS.some(ext => dataSrc.endsWith(ext));
                    if (isValid) {
                        if (dataSrc.endsWith('.m3u8')) {
                            hlsPromises.push(setupHlsForVideo(v, dataSrc));
                        } else {
                            v.src = dataSrc;
                        }
                    }
                }
            });
        }
        await Promise.allSettled(hlsPromises);
        return found.filter(v => v.currentSrc || v.hlsInstance);
    };

    /*** --- [ 5. Core Control Functions ] --- ***/
    const enforcePlaybackRate = () => {
        if (currentVideo && currentVideo.playbackRate !== desiredPlaybackRate) {
            currentVideo.playbackRate = desiredPlaybackRate;
        }
        currentPlaybackRateRAFId = requestAnimationFrame(enforcePlaybackRate);
    };

    const fixPlaybackRate = (video, rate) => {
        if (!video) return;

        // Clear existing enforcement mechanisms
        if (currentPlaybackRateRAFId) {
            cancelAnimationFrame(currentPlaybackRateRAFId);
            currentPlaybackRateRAFId = null;
        }
        if (currentPlaybackRateObserver) {
            currentPlaybackRateObserver.disconnect();
            currentPlaybackRateObserver = null;
        }
        clearInterval(currentIntervalId); // Clear old setInterval if any
        currentIntervalId = null;

        desiredPlaybackRate = rate;
        video.playbackRate = desiredPlaybackRate;

        // Use MutationObserver for sites that aggressively reset playbackRate
        if (forcePlaybackRateSites.some(site => location.hostname.includes(site.domain))) {
            currentPlaybackRateObserver = new MutationObserver(mutations => {
                mutations.forEach(mutation => {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'playbackRate') {
                        if (video.playbackRate !== desiredPlaybackRate) {
                            video.playbackRate = desiredPlaybackRate;
                        }
                    }
                });
            });
            currentPlaybackRateObserver.observe(video, { attributes: true, attributeFilter: ['playbackRate'] });
        }

        // Fallback or additional enforcement with requestAnimationFrame
        currentPlaybackRateRAFId = requestAnimationFrame(enforcePlaybackRate);
    };

    // --- Added function to apply playback rate to ALL videos ---
    const applyRateToAll = (rate) => {
        // Set the global desired rate for the current video's enforcement
        desiredPlaybackRate = rate;

        // Apply the rate to all videos found on the page
        videos.forEach(v => {
            if (v && !isNaN(rate)) {
                v.playbackRate = rate;
            }
        });

        // Re-start enforcement for the current video if necessary (handled by fixPlaybackRate)
        if (currentVideo) {
            fixPlaybackRate(currentVideo, rate);
        }
    };
    // -------------------------------------------------------------

    const seekVideo = sec => {
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
                const newTime = playerSession.getCurrentTime() + sec * 1000;
                playerSession.seek(newTime);
            } catch (e) {
                console.warn('Video Controller Popup: Netflix seek error (Player API might have changed):', e);
            }
        } else if (currentVideo) {
            currentVideo.currentTime = Math.max(0, Math.min(currentVideo.duration, currentVideo.currentTime + sec));
        }
    };

    /*** --- [ 6. Volume & Amplify ] --- ***/
    let audioCtx = null;
    let gainNode = null;
    let sourceNode = null;
    let connectedVideo = null;

    const setupAudioContext = video => {
        // Ensure amplification is allowed on this site before setting up
        if (isVolumeAmplificationRestricted) {
            return false;
        }

        try {
            // 기존 AudioContext가 있다면 연결 해제 및 닫기
            if (audioCtx && audioCtx.state !== 'closed') {
                if (sourceNode) {
                    sourceNode.disconnect();
                    sourceNode = null;
                }
                if (gainNode) {
                    gainNode.disconnect();
                    gainNode = null;
                }
                try {
                    audioCtx.close();
                } catch (e) {
                    console.warn("Video Controller Popup: Error closing old AudioContext:", e);
                }
            }
            // 변수 초기화
            audioCtx = null;
            gainNode = null;
            sourceNode = null;
            connectedVideo = null;

            // 새로운 AudioContext 생성
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
    };

    const setAmplifiedVolume = (video, vol) => {
        if (!video) return;

        // --- NEW Logic: Restriction Check ---
        if (isVolumeAmplificationRestricted && vol > 1.0) {
            console.log("Video Controller Popup: Volume amplification restricted on this site. Setting volume to 100%.");
            video.volume = 1.0;
            // Ensure no existing amplification is active
            if (gainNode && connectedVideo === video) {
                gainNode.gain.value = 1;
            }
            return;
        }
        // ------------------------------------

        if (vol <= 1) {
            video.volume = vol;
            if (gainNode && connectedVideo === video) gainNode.gain.value = 1;
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
    };

    const volumeOptions = [
        { label: 'Mute', value: 'muted' },
        { label: '10%', value: 0.1 }, { label: '20%', value: 0.2 }, { label: '30%', value: 0.3 },
        { label: '40%', value: 0.4 }, { label: '50%', value: 0.5 }, { label: '60%', value: 0.6 },
        { label: '70%', value: 0.7 }, { label: '80%', value: 0.8 }, { label: '90%', value: 0.9 },
        { label: '100%', value: 1.0 },
        { label: '150%', value: 1.5 }, { label: '300%', value: 3.0 }, { label: '500%', value: 5.0 }
    ];

    const updateVolumeSelect = () => {
        const volumeSelect = popupElement?.querySelector('#volume-select');
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

            // 실제 볼륨이 옵션에 없는 경우 (예: 1.2배속)에도 현재 값과 가장 가까운 옵션을 선택하도록 개선
            const optionExists = volumeOptions.some(opt => opt.value === String(effectiveVolume) || opt.value === effectiveVolume);
            if (!optionExists) {
                // 가장 가까운 옵션을 선택하거나, 필요하다면 새 옵션을 동적으로 추가하는 로직 고려
                // 현재는 closest.value를 사용하므로 가장 가까운 옵션이 선택됨
            }
            volumeSelect.value = String(closest.value); // 'muted'와 같은 문자열 값을 위해 String() 변환
        }
    };


    /*** --- [ 7. Popup UI & Events ] --- ***/
    const setPopupOpacity = o => {
        if (!popupElement) return;
        popupElement.style.opacity = o;
        const btnBg = o === TRANSPARENT_OPACITY ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.5)';
        popupElement.querySelectorAll('button, select').forEach(el => {
            el.style.backgroundColor = btnBg;
        });
    };

    const resetOpacityTimer = () => {
        clearTimeout(opacityTimer);
        setPopupOpacity(OPAQUE_OPACITY);
        opacityTimer = setTimeout(() => setPopupOpacity(TRANSPARENT_OPACITY), OPACITY_RESET_DELAY);
    };

    function removeVideoEventListeners(video) {
        if (!video) return;
        video.removeEventListener('play', resetOpacityTimer);
        video.removeEventListener('pause', resetOpacityTimer);
        video.removeEventListener('seeking', resetOpacityTimer);
        video.removeEventListener('volumechange', updateVolumeSelect);
        // PIP 모드 변경 시 팝업 가시성 유지
        video.removeEventListener('enterpictureinpicture', resetOpacityTimer);
        video.removeEventListener('leavepictureinpicture', resetOpacityTimer);
    }

    function addVideoEventListeners(video) {
        if (!video) return;
        video.addEventListener('play', resetOpacityTimer);
        video.addEventListener('pause', resetOpacityTimer);
        video.addEventListener('seeking', resetOpacityTimer);
        video.addEventListener('volumechange', updateVolumeSelect);
        // PIP 모드 변경 시 팝업 가시성 유지
        video.addEventListener('enterpictureinpicture', resetOpacityTimer);
        video.addEventListener('leavepictureinpicture', resetOpacityTimer);
    }

    const createPopup = async () => {
        const latestVideos = await findPlayableVideos();

        // 비디오 목록에 변화가 없으면 팝업 재생성 불필요
        // 하지만 currentVideo가 null이거나 videos에 없는 경우를 처리하여,
        // 페이지 로드 후 처음으로 비디오가 감지될 때 팝업이 생성되도록 함
        const videoListChanged = latestVideos.length !== videos.length || !latestVideos.every((v, i) => v === videos[i]);
        const currentVideoInvalid = !currentVideo || !latestVideos.includes(currentVideo);

        if (!videoListChanged && !currentVideoInvalid && popupElement) {
            // 비디오 목록 변화 없고, 현재 비디오 유효하며, 팝업이 이미 있다면, 업데이트만 수행
            updateVolumeSelect();
            const selectElement = popupElement.querySelector('select');
            if (selectElement) {
                const currentIndex = videos.indexOf(currentVideo);
                if (currentIndex !== -1 && String(selectElement.value) !== String(currentIndex)) {
                    selectElement.value = currentIndex;
                }
            }
            return;
        }

        // 기존 비디오들에 붙어있던 이벤트 리스너 제거 (새 비디오 목록 반영 전)
        videos.forEach(removeVideoEventListeners);
        // Disconnect previous playback rate observer
        if (currentPlaybackRateObserver) {
            currentPlaybackRateObserver.disconnect();
            currentPlaybackRateObserver = null;
        }
        if (currentPlaybackRateRAFId) {
            cancelAnimationFrame(currentPlaybackRateRAFId);
            currentPlaybackRateRAFId = null;
        }
        clearInterval(currentIntervalId); // Clear old setInterval if any
        currentIntervalId = null;

        videos = latestVideos;

        if (videos.length === 0) {
            // 비디오가 없으면 팝업 제거 및 관련 리소스 해제
            popupElement?.remove();
            popupElement = null;

            // AudioContext 리소스 해제
            if (audioCtx && audioCtx.state !== 'closed') {
                if (sourceNode) sourceNode.disconnect();
                if (gainNode) gainNode.disconnect();
                try { audioCtx.close(); } catch (e) { /* ignore */ }
            }
            audioCtx = null; gainNode = null; sourceNode = null; connectedVideo = null;
            currentVideo = null;
            return;
        }

        // currentVideo가 유효하지 않으면 첫 번째 비디오로 설정
        if (!currentVideo || !videos.includes(currentVideo)) {
            currentVideo = videos[0];
            desiredPlaybackRate = currentVideo.playbackRate; // Initialize desired rate
        }

        // 기존 팝업 제거
        popupElement?.remove();

        const popup = document.createElement('div');
        popup.id = 'vcp-popup';
        popup.style.cssText = `
            position:fixed;bottom:0;left:50%;transform:translateX(-50%);
            background:rgba(0,0,0,0.5);color:#fff;padding:8px 12px;border-radius:8px;
            z-index:2147483647;
            display:flex;gap:8px;
            opacity:${TRANSPARENT_OPACITY};
            transition:opacity 0.3s ease;
            pointer-events: auto;
            flex-wrap: nowrap;
            align-items: center;
            box-shadow: 0 0 15px rgba(0,0,0,0.5);
            font-family: 'Segoe UI', Arial, sans-serif; /* 폰트 지정 */
        `;
        popup.addEventListener('click', resetOpacityTimer);
        popupElement = popup;

        const videoSelect = document.createElement('select');
        videoSelect.style.cssText = `
            margin-right: 8px;
            font-size: 16px;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            max-width: 50px; /* Adjusted from 150px to 50px */
            background: rgba(0,0,0,0.5);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.5);
            text-overflow: ellipsis;
            white-space: nowrap;
            -webkit-appearance: none; /* 기본 스타일 제거 */
            -moz-appearance: none;
            appearance: none;
            background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M287%2C197.9c-3.2%2C3.2-8.3%2C3.2-11.6%2C0L146.2%2C70.6L16.9%2C197.9c-3.2%2C3.2-8.3%2C3.2-11.6%2C0c-3.2-3.2-3.2-8.3%2C0-11.6l135.9-135.9c3.2-3.2%2C8.3-3.2%2C11.6%2C0l135.9%2C135.9C290.2%2C189.6%2C290.2%2C194.7%2C287%2C197.9z%22%2F%3E%3C%2Fsvg%3E'); /* 사용자 정의 화살표 */
            background-repeat: no-repeat;
            background-position: right 8px top 50%;
            background-size: 12px auto;
        `;
        videos.forEach((v, i) => {
            const opt = document.createElement('option');
            opt.value = i;
            let label = v.currentSrc ? v.currentSrc.split('/').pop() : `Video ${i + 1}`;
            if (label.length > 25) label = label.slice(0, 22) + '...';
            opt.textContent = label;
            opt.title = label;
            if (v === currentVideo) opt.selected = true;
            videoSelect.appendChild(opt);
        });
        videoSelect.onchange = (e) => {
            if (currentVideo) removeVideoEventListeners(currentVideo);
            currentVideo = videos[e.target.value];
            if (currentVideo) addVideoEventListeners(currentVideo);
            updateVolumeSelect();
            // When switching videos, re-apply the desired playback rate
            fixPlaybackRate(currentVideo, desiredPlaybackRate);
        };
        popup.appendChild(videoSelect);

        const createButton = (id, text, onClick) => {
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
                transition: background-color 0.2s ease;
            `;
            btn.addEventListener('mouseenter', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(125,125,125,0.8)'; });
            btn.addEventListener('mouseleave', () => { if (!isMobile) btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; });
            btn.addEventListener('click', (event) => {
                event.stopPropagation(); // 버튼 클릭 시 팝업의 resetOpacityTimer 방지 (내부적으로 호출)
                onClick();
                resetOpacityTimer();
                if (isMobile) {
                    btn.style.backgroundColor = 'rgba(125,125,125,0.8)';
                    setTimeout(() => { btn.style.backgroundColor = 'rgba(0,0,0,0.5)'; }, 200);
                }
            });
            return btn;
        };

        // --- Modified speed buttons to use applyRateToAll ---
        popup.appendChild(createButton('speed-0.2x', '0.2x', () => applyRateToAll(0.2)));
        popup.appendChild(createButton('speed-1.0x', '1.0x', () => applyRateToAll(1.0)));
        popup.appendChild(createButton('speed-4.0x', '4.0x', () => applyRateToAll(4.0)));
        // ----------------------------------------------------

        popup.appendChild(createButton('rewind-5s', '⏪ 5초', () => seekVideo(-5)));
        popup.appendChild(createButton('forward-5s', '5초 ⏩', () => seekVideo(5)));
        popup.appendChild(createButton('pip-mode', '📺 PIP', async () => {
            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else {
                    if (currentVideo && document.pictureInPictureEnabled) {
                        await currentVideo.requestPictureInPicture();
                    } else {
                        alert('PIP 모드를 사용할 수 없습니다. 비디오를 재생 중인지 확인해주세요.');
                    }
                }
            } catch (e) {
                console.error('Video Controller Popup: PIP 실패:', e);
                alert('PIP 모드 실행 중 오류가 발생했습니다.');
            }
        }));

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
            -webkit-appearance: none;
            -moz-appearance: none;
            appearance: none;
            background-image: url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%23fff%22%20d%3D%22M287%2C197.9c-3.2%2C3.2-8.3%2C3.2-11.6%2C0L146.2%2C70.6L16.9%2C197.9c-3.2%2C3.2-8.3%2C3.2-11.6%2C0c-3.2-3.2-3.2-8.3%2C0-11.6l135.9-135.9c3.2-3.2%2C8.3-3.2%2C11.6%2C0l135.9%2C135.9C290.2%2C189.6%2C290.2%2C194.7%2C287%2C197.9z%22%2F%3E%3C%2Fsvg%3E');
            background-repeat: no-repeat;
            background-position: right 8px top 50%;
            background-size: 12px auto;
        `;
        volumeOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            volumeSelect.appendChild(option);
        });
        volumeSelect.onchange = () => {
            if (!currentVideo) return;
            const val = volumeSelect.value;
            if (val === 'muted') {
                currentVideo.muted = true;
                if (gainNode && connectedVideo === currentVideo) gainNode.gain.value = 0;
            } else {
                currentVideo.muted = false;
                setAmplifiedVolume(currentVideo, parseFloat(val));
            }
            resetOpacityTimer();
        };
        popup.appendChild(volumeSelect);

        if (currentVideo) {
            addVideoEventListeners(currentVideo);
            fixPlaybackRate(currentVideo, desiredPlaybackRate); // Re-apply desired rate
        }

        document.body.appendChild(popup);
        updateVolumeSelect();
        setTimeout(() => setPopupOpacity(TRANSPARENT_OPACITY), OPACITY_RESET_DELAY);
    };

    /*** --- [ 8. Init & Observers ] --- ***/
    const run = () => {
        debouncedCreatePopup();

        // MutationObserver to detect new videos or changes in the DOM
        const mo = new MutationObserver(debouncedCreatePopup);
        mo.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true // Listen for attribute changes, important for lazy-loaded videos or data-src
        });

        // Periodic check in case MutationObserver misses something or for general robustness
        setInterval(debouncedCreatePopup, 5000);

        if (overflowFixTargets.some(site => location.hostname.includes(site.domain))) {
            fixOverflow();
            setInterval(fixOverflow, 1000);
        }

        document.body.addEventListener('click', (event) => {
            // 팝업 내부 클릭 시에는 타이머 초기화만 하고, 외부 클릭 시 팝업 투명화
            if (popupElement && !popupElement.contains(event.target)) {
                resetOpacityTimer();
            }
        });
        // Added touchstart listener for mobile devices
        document.body.addEventListener('touchstart', (event) => {
            if (popupElement && !popupElement.contains(event.target)) {
                resetOpacityTimer();
            }
        }, { passive: true }); // Use passive: true for touch events to improve scrolling performance
    };

    run();
    console.log('Video Controller Popup v4.09.5 loaded. (Volume amplification restricted on whitelisted sites)');

})();
