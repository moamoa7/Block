// ==UserScript==
// @name         Mobile Gesture
// @namespace    http://tampermonkey.net/
// @version      67.05.0
// @description  모바일 브라우저에서 동영상을 전용 앱처럼 편리하게 제어할 수 있는 터치 제스처 플러그인입니다. (수정판: iframe 더블탭 가로모드 전환)
// @author       Gemini & Claude
// @license      MIT
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const isMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
    if (!isMobile) return;

    const CFG = {
        minDist: 10, longPress: 500, rateBase: 2.0, senseX: 0.25, senseY: 1.0,
        progressBarColor: '#FF6699', uiTimeout: 2500, maxScale: 8.0, senseRate: 0.015
    };

    const TAP_PROTECT_DURATION = 500;
    const ENFORCE_STATE_DURATION = 800;

    let seekSec = GM_getValue('gt_seek_sec', 10);
    let seekMode = GM_getValue('gt_seek_mode', 'sec');
    let fpsMode = GM_getValue('gt_fps', 30);

    let state = { isScreenLocked: false, pinchMode: 'speed', scale: 1.0, panX: 0, panY: 0 };
    let startX, startY, initTime, initRate, targetV, targetP, isTouch = false, action = null, lpTimer = null, toastTimer = null, lastTapTime = 0, tapCount = 0, uiTimer = null;
    let activeSeekSide = null, seekAccumulator = 0, seekFrameCount = 0, seekSessionTimer = null, wasPlayingBeforeSequence = false;
    let initPinchDist = 0, initScale = 1.0, initPanX = 0, initPanY = 0, initSpeed = 1.0, initCenterX = 0, initCenterY = 0, originDx = 0, originDy = 0;

    let blockGestureUntil = 0;
    let enforceStateUntil = 0;
    let enforceTarget = null;

    const lockOrientation = (dir) => {
        if (screen.orientation?.lock) {
            screen.orientation.lock(dir).catch(() => {
                try { window.top.postMessage({ type: 'gt_lock_orientation', dir }, '*'); } catch(e){}
            });
        } else {
            try { window.top.postMessage({ type: 'gt_lock_orientation', dir }, '*'); } catch(e){}
        }
    };

    const unlockOrientation = () => {
        if (screen.orientation?.unlock) screen.orientation.unlock();
        try { window.top.postMessage({ type: 'gt_unlock_orientation' }, '*'); } catch(e){}
    };

    const getVideoOrientationDir = (v) => {
        return (v && v.videoWidth > 0 && v.videoWidth < v.videoHeight) ? 'portrait' : 'landscape';
    };

    window.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'gt_lock_orientation') {
            if (screen.orientation && screen.orientation.lock) screen.orientation.lock(e.data.dir).catch(()=>{});
        } else if (e.data && e.data.type === 'gt_unlock_orientation') {
            if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
        }
    });

    const VIP_SELECTORS = '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], [data-testid="video-container"], .player-wrapper, .one-video-player_display-w, .one-video-player, vk-video-player, [aria-label="Видео плеер"], [aria-label="Video Player"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, iframe';

    const IGNORE_TOUCH_SELECTORS = '[data-vsc-ui="1"], .gt-btn-base, .dplayer-controller, .dplayer-bar-wrap, .vjs-control-bar, .art-bottom, .art-controls, .bpx-player-control-wrap, .plyr__controls, .xgplayer-controls, .tcplayer-controls, .prism-controlbar, .mui-player-controls, .wrapper-bottom, [data-testid="player_controls"], [data-testid="progress_bar"], [data-testid="volume-slider"], input[type="range"], .buttons-bar, .progress-bar-container';

    const isExcludedZone = (e) => {
        const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
        if (path.length > 0) {
            for (let el of path) {
                if (el.matches && el.matches(IGNORE_TOUCH_SELECTORS)) return true;
            }
            return false;
        }
        let el = e.target;
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.matches && el.matches(IGNORE_TOUCH_SELECTORS)) return true;
            el = el.parentNode || el.host;
        }
        return false;
    };

    const findUp = (el, selector) => {
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.matches && el.matches(selector)) return el;
            el = el.parentNode || el.host;
        }
        return null;
    };

    const findDeepVid = (root) => {
        if (!root) return null;
        let v = root.querySelector ? root.querySelector('video') : null;
        if (v) return v;
        let els = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (let el of els) {
            if (el.shadowRoot) { v = findDeepVid(el.shadowRoot); if (v) return v; }
        }
        return null;
    };

    const getValidPlayerRoot = (video) => {
        let current = video.parentNode || (video.getRootNode && video.getRootNode().host) || video;
        let bestMatch = null;
        let fallbackMatch = null;
        let depth = 0;
        while (current && current !== document.body && current !== document.documentElement && depth < 15) {
            if (current.getBoundingClientRect) {
                const rect = current.getBoundingClientRect();
                if (rect.width > 50 && rect.height > 50) {
                    if (!fallbackMatch) fallbackMatch = current;
                    if (current.matches && current.matches(VIP_SELECTORS)) bestMatch = current;
                }
            }
            current = current.parentNode || current.host;
            depth++;
        }
        return bestMatch || fallbackMatch || video.parentNode || video;
    };

    const setIconIfChanged = (btn, key) => {
        if (!btn) return;
        if (btn.dataset.gtIcon !== key) { btn.innerHTML = key; btn.dataset.gtIcon = key; }
    };

    const hijackFullscreenAPI = () => {
        const fsMethods = ['requestFullscreen', 'webkitRequestFullscreen', 'mozRequestFullScreen', 'msRequestFullscreen'];
        fsMethods.forEach(method => {
            if (Element.prototype[method]) {
                const originalMethod = Element.prototype[method];
                Element.prototype[method] = function(...args) {
                    try {
                        let target = this;
                        if (this.tagName === 'VIDEO') {
                            const isNaked = !this.parentNode.classList?.contains('gt-video-wrapper') && !findUp(this.parentNode, VIP_SELECTORS.replace(', iframe', ''));
                            if (isNaked) { target = this.parentNode; target.classList.add('gt-fullscreen-active'); }
                        }
                        const promise = originalMethod.apply(target, args);
                        let v = target.tagName === 'VIDEO' ? target : findDeepVid(target);
                        if (!v) v = findDeepVid(document);
                        if (v) lockOrientation(getVideoOrientationDir(v));
                        return promise;
                    } catch (e) { return originalMethod.apply(this, args); }
                };
            }
        });
    };
    hijackFullscreenAPI();

    // ★ FIX: iframe 안에 있는지 감지
    const isInsideIframe = () => {
        try { return window.self !== window.top; } catch(e) { return true; }
    };
    const inIframe = isInsideIframe();

    const toggleNativeFullscreen = (container, video) => {
        const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement) || container.classList.contains('gt-fullscreen-active');
        const fsBtn = container.querySelector('.art-icon-fullscreenOn, .art-control-fullscreen, .dplayer-full-icon, .plyr__control[data-plyr="fullscreen"], .vjs-fullscreen-control, .xgplayer-fullscreen, .tcplayer-fullscreen-btn, .prism-fullscreen-btn, [aria-label*="全屏"], [title*="全屏"], [aria-label*="전체 화면"], [title*="전체화면"], .fullscreen-btn, .bilibili-player-video-btn-fullscreen');
        if (isFS) {
            if (fsBtn) { try { fsBtn.click(); } catch(e){} }
            if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            container.classList.remove('gt-fullscreen-active');
            unlockOrientation();
        } else {
            // ★ FIX: iframe 내부에서 실행 중이면, requestFullscreen 대신 가로모드 토글
            if (inIframe) {
                const isLandscape = screen.orientation && screen.orientation.type.startsWith('landscape');
                if (isLandscape) {
                    unlockOrientation();
                    showMsg('세로 모드');
                } else {
                    lockOrientation('landscape');
                    showMsg('가로 모드');
                }
                return;
            }

            const forceLockLandscape = () => { lockOrientation(getVideoOrientationDir(video)); };
            if (fsBtn) { try { fsBtn.click(); } catch(e){} }
            container.classList.add('gt-fullscreen-active');
            const reqFs = container.requestFullscreen || container.webkitRequestFullscreen || container.mozRequestFullScreen;
            if (reqFs) {
                const p = reqFs.call(container);
                if (p && p.then) {
                    p.then(() => setTimeout(forceLockLandscape, 150)).catch(()=>{
                        // ★ FIX: fullscreen 실패 시에도 가로모드 전환으로 fallback
                        lockOrientation('landscape');
                        showMsg('가로 모드');
                        container.classList.remove('gt-fullscreen-active');
                    });
                } else { setTimeout(forceLockLandscape, 150); }
            } else if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen(); setTimeout(forceLockLandscape, 150);
            } else {
                // ★ FIX: 어떤 fullscreen API도 없으면 가로모드 전환
                lockOrientation('landscape');
                showMsg('가로 모드');
                container.classList.remove('gt-fullscreen-active');
            }
        }
    };

    const toggleOrientation = () => {
        if (!screen.orientation) return;
        const dir = screen.orientation.type.startsWith('landscape') ? 'portrait' : 'landscape';
        lockOrientation(dir);
    };

    const FS_TOUCH_LOCK_SELECTORS = ':fullscreen, :fullscreen *, .gt-fullscreen-active, .gt-fullscreen-active *, .gt-lock-touch-full';
    const NORMAL_TOUCH_SELECTORS = '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, video';

    GM_addStyle(`
        ${NORMAL_TOUCH_SELECTORS} { touch-action: pan-y !important; overscroll-behavior: none !important; }
        ${FS_TOUCH_LOCK_SELECTORS} { touch-action: none !important; overscroll-behavior: none !important; }

        .gt-toast { position: fixed; top: 10%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.15); color: #fff; padding: 4px 10px; border-radius: 4px; font: 700 14px system-ui; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s; text-shadow: 0 0 2px #000; border: 1px solid rgba(255,255,255,0.05); }
        .gt-toast.show { opacity: 1; }
        .gt-seek-msg { position: absolute !important; top: 50% !important; color: rgba(255, 255, 255, 0.95) !important; z-index: 2147483647 !important; pointer-events: none !important; opacity: 0; transition: opacity 0.15s ease-out; display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; gap: 6px !important; font-family: system-ui, -apple-system, sans-serif !important; white-space: nowrap !important; text-shadow: 0 0 10px rgba(0,0,0,0.8), 0 0 4px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.5) !important; }
        .gt-seek-msg.left { left: 15%; transform: translateY(-50%); }
        .gt-seek-msg.right { right: 15%; transform: translateY(-50%); }
        .gt-seek-msg.show { opacity: 1; }
        .gt-seek-text { display: block !important; font-size: 15px !important; font-weight: 500 !important; line-height: 1 !important; white-space: nowrap !important; transform-origin: center center !important; will-change: transform; }
        .gt-arrows { display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; font-size: 22px !important; font-weight: 400 !important; line-height: 1 !important; }
        .gt-arrows span { display: block !important; line-height: 1 !important; white-space: nowrap !important; }
        .gt-pop-anim { animation: gt-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes gt-pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
        .gt-arrow-slide-r { animation: gt-slide-r 0.6s infinite; }
        @keyframes gt-slide-r { 0% { transform: translateX(-4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(4px); opacity: 0; } }
        .gt-arrow-slide-l { animation: gt-slide-l 0.6s infinite; }
        @keyframes gt-slide-l { 0% { transform: translateX(4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(-4px); opacity: 0; } }
        :fullscreen { background-color: #000 !important; }

        .gt-ui-layer { position: absolute !important; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none !important; z-index: 2147483647 !important; }
        .gt-mini-progress { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 2147483640; pointer-events: none; overflow: hidden; opacity: 0.9; transition: height 0.2s, opacity 0.3s; box-shadow: 0 -1px 1px rgba(0,0,0,0.2); }
        .gt-mini-progress .gt-fill { height: 100%; width: 0%; background: ${CFG.progressBarColor}; transition: width 0.1s linear; box-shadow: 0 0 4px ${CFG.progressBarColor}; }
        :fullscreen .gt-mini-progress, .gt-fullscreen-active .gt-mini-progress { height: 3px !important; }
        .gt-lock-shield { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483645; background: rgba(0,0,0,0); touch-action: none; display: none; pointer-events: auto; }
        :fullscreen .gt-lock-shield, .gt-fullscreen-active .gt-lock-shield { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; }

        .gt-btn-base { position: absolute; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity 0.3s ease, transform 0.15s ease; border: none; background: transparent; color: rgba(255, 255, 255, 0.95); filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.8)); }
        .gt-btn-base * { pointer-events: none !important; }
        .gt-btn-base svg { width: 15px; height: 15px; transition: all 0.2s ease; transform-origin: center center; fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        .gt-btn-base svg * { fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        .gt-btn-base span { font-size: 11px; font-weight: 800; font-family: system-ui; letter-spacing: 0.5px; transform-origin: center center; display: inline-block; }
        .gt-ui-visible .gt-btn-base { opacity: 0.65 !important; pointer-events: auto !important; }
        .gt-ui-visible .gt-btn-base.hidden-by-state { display: none !important; pointer-events: none !important; }
        .gt-btn-base:active { opacity: 0.9 !important; color: #fff; }

        /* ===== 일반 모드 배치 ===== */
        .gt-pip-btn { top: 40px; left: 10px; }
        .gt-shot-btn { top: calc(40px + 32px); left: 10px; }
        .gt-seek-mode-btn { top: 40px; right: 10px; }
        .gt-seek-val-btn { top: calc(40px + 32px); right: 10px; }
        .gt-lock-btn { bottom: 48px; right: 10px; }
        .gt-mode-btn { bottom: calc(48px + 32px); right: 10px; }
        .gt-fit-btn { bottom: 32px; left: 33%; transform: translateX(-50%); }
        .gt-rotate-btn { bottom: 32px; left: 67%; transform: translateX(-50%); }
        .gt-reset-speed-btn { bottom: 32px; left: calc(33% - 36px); transform: translateX(-50%); }
        .gt-reset-zoom-btn { bottom: 32px; left: calc(67% + 36px); transform: translateX(-50%); }

        /* ===== 전체화면 배치 ===== */
        :fullscreen .gt-btn-base, .gt-fullscreen-active .gt-btn-base { width: 38px; height: 38px; }
        :fullscreen .gt-ui-visible .gt-btn-base, .gt-fullscreen-active .gt-ui-visible .gt-btn-base { opacity: 0.5 !important; }
        :fullscreen .gt-btn-base svg, .gt-fullscreen-active .gt-btn-base svg { width: 22px; height: 22px; }
        :fullscreen .gt-btn-base span, .gt-fullscreen-active .gt-btn-base span { font-size: 14px; }
        :fullscreen .gt-pip-btn, .gt-fullscreen-active .gt-pip-btn { top: 55px; left: 20px; }
        :fullscreen .gt-shot-btn, .gt-fullscreen-active .gt-shot-btn { top: calc(55px + 50px); left: 20px; }
        :fullscreen .gt-seek-mode-btn, .gt-fullscreen-active .gt-seek-mode-btn { top: 55px; right: 20px; }
        :fullscreen .gt-seek-val-btn, .gt-fullscreen-active .gt-seek-val-btn { top: calc(55px + 50px); right: 20px; }
        :fullscreen .gt-lock-btn, .gt-fullscreen-active .gt-lock-btn { bottom: 60px; right: 20px; }
        :fullscreen .gt-mode-btn, .gt-fullscreen-active .gt-mode-btn { bottom: calc(60px + 50px); right: 20px; }
        :fullscreen .gt-fit-btn, .gt-fullscreen-active .gt-fit-btn { bottom: 40px; left: 33%; transform: translateX(-50%); }
        :fullscreen .gt-rotate-btn, .gt-fullscreen-active .gt-rotate-btn { bottom: 40px; left: 67%; transform: translateX(-50%); }
        :fullscreen .gt-reset-speed-btn, .gt-fullscreen-active .gt-reset-speed-btn { bottom: 40px; left: calc(33% - 48px); transform: translateX(-50%); }
        :fullscreen .gt-reset-zoom-btn, .gt-fullscreen-active .gt-reset-zoom-btn { bottom: 40px; left: calc(67% + 48px); transform: translateX(-50%); }
    `);

    const SVG_LOCK = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
    const SVG_UNLOCK = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
    const SVG_SPEED = `<svg viewBox="0 0 24 24" width="100%" height="100%"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
    const SVG_ZOOM = `<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line><line x1="11" y1="8" x2="11" y2="14"></line><line x1="8" y1="11" x2="14" y2="11"></line></svg>`;
    const SVG_RESET_ZOOM = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4 2"></rect></svg>`;
    const SVG_SEC = `<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
    const SVG_FRAME = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"></rect><line x1="7" y1="2" x2="7" y2="22"></line><line x1="17" y1="2" x2="17" y2="22"></line><line x1="2" y1="12" x2="22" y2="12"></line><line x1="2" y1="7" x2="7" y2="7"></line><line x1="2" y1="17" x2="7" y2="17"></line><line x1="17" y1="17" x2="22" y2="17"></line><line x1="17" y1="7" x2="22" y2="7"></line></svg>`;
    const SVG_FIT = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4"></path></svg>`;
    const SVG_SHOT = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`;
    const SVG_PIP = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"></path></svg>`;

    const getFS = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

    const identify = (e) => {
        let targetVideo = null;
        let rootContainer = null;

        let cx, cy;
        if (e.touches && e.touches.length > 0) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
        else if (e.changedTouches && e.changedTouches.length > 0) { cx = e.changedTouches[0].clientX; cy = e.changedTouches[0].clientY; }
        else { cx = e.clientX; cy = e.clientY; }

        if (cx !== undefined && cy !== undefined) {
            let currentRoot = document;
            while (currentRoot) {
                let els;
                try { els = currentRoot.elementsFromPoint(cx, cy) || []; } catch (_) { els = []; }
                for (let el of els) { if (el.tagName === 'VIDEO') { targetVideo = el; break; } }
                if (targetVideo) break;
                let nextRoot = null;
                for (let el of els) { if (el.shadowRoot) { nextRoot = el.shadowRoot; break; } }
                currentRoot = nextRoot;
            }
        }

        if (!targetVideo && cx !== undefined && cy !== undefined) {
            const deepSearch = (root) => {
                let v = root.querySelector ? root.querySelector('video') : null;
                if (v) {
                    const r = v.getBoundingClientRect();
                    if (r.width > 0 && cx >= r.left - 10 && cx <= r.right + 10 && cy >= r.top - 10 && cy <= r.bottom + 10) return v;
                }
                if (root.querySelectorAll) {
                    for (let el of root.querySelectorAll('*')) {
                        if (el.shadowRoot) { v = deepSearch(el.shadowRoot); if (v) return v; }
                    }
                }
                return null;
            };
            targetVideo = deepSearch(document);
        }

        if (!targetVideo) {
            const videos = document.querySelectorAll('video');
            if (videos.length > 0) {
                targetVideo = Array.from(videos).sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
                if (targetVideo && targetVideo.clientWidth < 50) targetVideo = null;
            }
        }

        if (!targetVideo) return null;

        if (targetVideo.gtRoot && document.contains(targetVideo.gtRoot)) {
            rootContainer = targetVideo.gtRoot;
        } else {
            rootContainer = getValidPlayerRoot(targetVideo);
            if (rootContainer && rootContainer !== document.body && rootContainer !== document.documentElement) {
                targetVideo.gtRoot = rootContainer;
            }
        }

        if (!rootContainer || rootContainer === document.body || rootContainer === document.documentElement) {
            rootContainer = targetVideo.parentNode || targetVideo;
        }
        if (rootContainer && rootContainer.tagName === 'VIDEO') { rootContainer = rootContainer.parentNode; }

        if (e.touches && e.touches.length > 0) {
            const isFS = !!getFS() || (rootContainer && rootContainer.classList.contains('gt-fullscreen-active'));
            if (!isFS) {
                const checkBox = rootContainer || targetVideo;
                const rect = checkBox.getBoundingClientRect();
                const touch = e.touches[0];
                if (touch.clientX < rect.left - 10 || touch.clientX > rect.right + 10 ||
                    touch.clientY < rect.top - 10 || touch.clientY > rect.bottom + 10) return null;
            }
        }

        return {
            root: rootContainer, video: targetVideo,
            isNaked: (!rootContainer.classList?.contains('gt-video-wrapper') && !findUp(rootContainer, VIP_SELECTORS.replace(', iframe', '')))
        };
    };

    const showMsg = (txt) => {
        let t = document.getElementById('gt-toast');
        if (!t) { t = document.createElement('div'); t.id = 'gt-toast'; t.className = 'gt-toast'; }
        const p = document.fullscreenElement || document.body;
        if (t.parentNode !== p) { if (t.parentNode) t.parentNode.removeChild(t); p.appendChild(t); }
        t.textContent = txt; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 800);
    };

    let activeUIEl = null;
    const updateUIState = (root, video) => {
        if(!root) return;
        let uiLayer = null;
        if (root.shadowRoot) uiLayer = root.shadowRoot.querySelector('.gt-ui-layer');
        if (!uiLayer) uiLayer = root.querySelector('.gt-ui-layer');
        if(!uiLayer) return;

        const btnLock = uiLayer.querySelector('.gt-lock-btn'), btnMode = uiLayer.querySelector('.gt-mode-btn'), btnRot = uiLayer.querySelector('.gt-rotate-btn'), btnRst = uiLayer.querySelector('.gt-reset-speed-btn'), btnZoomRst = uiLayer.querySelector('.gt-reset-zoom-btn'), btnSeekMode = uiLayer.querySelector('.gt-seek-mode-btn'), btnSeekVal = uiLayer.querySelector('.gt-seek-val-btn'), btnFit = uiLayer.querySelector('.gt-fit-btn'), btnShot = uiLayer.querySelector('.gt-shot-btn'), btnPip = uiLayer.querySelector('.gt-pip-btn'), shield = uiLayer.querySelector('.gt-lock-shield');

        setIconIfChanged(btnLock, state.isScreenLocked ? SVG_LOCK : SVG_UNLOCK);
        setIconIfChanged(btnMode, state.pinchMode === 'speed' ? SVG_SPEED : SVG_ZOOM);
        setIconIfChanged(btnSeekMode, seekMode === 'sec' ? SVG_SEC : SVG_FRAME);
        setIconIfChanged(btnSeekVal, `<span>${seekMode === 'sec' ? seekSec + 's' : fpsMode + 'f'}</span>`);

        if (state.isScreenLocked) {
            if(shield) shield.style.display = 'block';
            [btnMode, btnRot, btnRst, btnZoomRst, btnSeekMode, btnSeekVal, btnFit, btnShot, btnPip].forEach(b => b?.classList.add('hidden-by-state'));
        } else {
            if(shield) shield.style.display = 'none';
            const isFS = !!getFS() || (root && root.classList && root.classList.contains('gt-fullscreen-active'));
            [btnMode, btnSeekMode, btnSeekVal, btnShot, btnPip].forEach(b => b?.classList.remove('hidden-by-state'));
            if (btnRot) { if (isFS) btnRot.classList.remove('hidden-by-state'); else btnRot.classList.add('hidden-by-state'); }
            if (btnFit) { if (isFS) btnFit.classList.remove('hidden-by-state'); else btnFit.classList.add('hidden-by-state'); }
            if(btnRst) { if(video && video.playbackRate !== 1.0) btnRst.classList.remove('hidden-by-state'); else btnRst.classList.add('hidden-by-state'); }
            if(btnZoomRst) { if(state.scale > 1.0) btnZoomRst.classList.remove('hidden-by-state'); else btnZoomRst.classList.add('hidden-by-state'); }
        }
    };

    const wakeUpUI = (root, video) => {
        if (!root) return;
        let uiLayer = null;
        if (root.shadowRoot) uiLayer = root.shadowRoot.querySelector('.gt-ui-layer');
        if (!uiLayer) uiLayer = root.querySelector('.gt-ui-layer');
        if(!uiLayer) return;
        if (activeUIEl && activeUIEl !== uiLayer) activeUIEl.classList.remove('gt-ui-visible');
        activeUIEl = uiLayer; uiLayer.classList.add('gt-ui-visible'); updateUIState(root, video);
        if (uiTimer) clearTimeout(uiTimer); uiTimer = setTimeout(() => { if (activeUIEl) activeUIEl.classList.remove('gt-ui-visible'); activeUIEl = null; }, CFG.uiTimeout);
    };

    const hideUI = (root) => {
        if (!root) return;
        let uiLayer = null;
        if (root.shadowRoot) uiLayer = root.shadowRoot.querySelector('.gt-ui-layer');
        if (!uiLayer) uiLayer = root.querySelector('.gt-ui-layer');
        if(uiLayer) { uiLayer.classList.remove('gt-ui-visible'); if (activeUIEl === uiLayer) activeUIEl = null; }
        if (uiTimer) clearTimeout(uiTimer);
    };

    const applyTransform = (video) => {
        if(!video) return;
        if (state.scale <= 1.05) { state.scale = 1.0; state.panX = 0; state.panY = 0; }
        else {
            const mX = (video.clientWidth * state.scale - video.clientWidth) / 2, mY = (video.clientHeight * state.scale - video.clientHeight) / 2;
            state.panX = Math.max(-mX, Math.min(mX, state.panX)); state.panY = Math.max(-mY, Math.min(mY, state.panY));
        }
        video.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
    };

    let pendingRate = null; let lastRateUpdateTime = 0; let rateFlushTimer = null;
    const setRateThrottled = (v, rate) => {
        pendingRate = rate;
        const now = Date.now();
        if (now - lastRateUpdateTime > 150) {
            v.playbackRate = pendingRate; lastRateUpdateTime = now; pendingRate = null;
            if (rateFlushTimer) { clearTimeout(rateFlushTimer); rateFlushTimer = null; }
        } else if (!rateFlushTimer) {
            const videoRef = v;
            rateFlushTimer = setTimeout(() => {
                if (pendingRate !== null && videoRef) { try { videoRef.playbackRate = pendingRate; } catch(e){} pendingRate = null; }
                rateFlushTimer = null;
            }, 160);
        }
    };

    const bindTap = (btn, handler) => {
        let lastExec = 0;
        const wrap = (e) => {
            e.stopPropagation(); e.stopImmediatePropagation(); if (e.type === 'touchend' && e.cancelable) e.preventDefault();
            const now = Date.now(); if (now - lastExec < 300) return; lastExec = now; handler(e);
            const icon = btn.querySelector('svg') || btn.querySelector('span');
            if (icon) { icon.classList.remove('gt-pop-anim'); void icon.offsetWidth; icon.classList.add('gt-pop-anim'); }
        };
        btn.addEventListener('touchend', wrap, {passive: false, capture: true}); btn.addEventListener('click', wrap, {capture: true});
        ['touchstart', 'mousedown', 'pointerdown', 'contextmenu', 'dblclick'].forEach(evt => { btn.addEventListener(evt, (e)=>{e.stopPropagation(); e.stopImmediatePropagation();}, { capture: true, passive: false }); });
    };

    const ensureUIAndWrapper = (hit) => {
        let { root, video, isNaked } = hit;
        if (isNaked) { video.setAttribute('controlslist', 'nofullscreen'); }

        let uiLayer = root.querySelector('.gt-ui-layer');
        if (!uiLayer) {
            uiLayer = document.createElement('div');
            uiLayer.className = 'gt-ui-layer';

            const bar = document.createElement('div'); bar.className = 'gt-mini-progress'; bar.innerHTML = '<div class="gt-fill"></div>'; uiLayer.appendChild(bar);

            const shield = document.createElement('div'); shield.className = 'gt-lock-shield';
            const blk = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); wakeUpUI(root, video); };
            ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'touchstart', 'touchend'].forEach(evt => shield.addEventListener(evt, blk, {capture:true, passive:false}));
            uiLayer.appendChild(shield);

            if (document.pictureInPictureEnabled) {
                const pipBtn = document.createElement('div'); pipBtn.className = 'gt-btn-base gt-pip-btn'; pipBtn.innerHTML = SVG_PIP;
                bindTap(pipBtn, () => {
                    if (document.pictureInPictureElement) document.exitPictureInPicture();
                    else video.requestPictureInPicture().catch(() => showMsg('PIP 모드 실행 실패'));
                    wakeUpUI(root, video);
                });
                uiLayer.appendChild(pipBtn);
            }

            const shotBtn = document.createElement('div'); shotBtn.className = 'gt-btn-base gt-shot-btn'; shotBtn.innerHTML = SVG_SHOT;
            bindTap(shotBtn, () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataURL = canvas.toDataURL('image/png');
                    const a = document.createElement('a'); a.href = dataURL;
                    a.download = `Screenshot_${Math.floor(Date.now()/1000)}.png`; a.click();
                    showMsg('스크린샷이 저장되었습니다');
                } catch (e) { showMsg('스크린샷 실패: 교차 출처(CORS) 제한'); }
                wakeUpUI(root, video);
            });
            uiLayer.appendChild(shotBtn);

            const smBtn = document.createElement('div'); smBtn.className = 'gt-btn-base gt-seek-mode-btn';
            bindTap(smBtn, () => { seekMode = seekMode === 'sec' ? 'frame' : 'sec'; GM_setValue('gt_seek_mode', seekMode); updateUIState(root, video); showMsg(`탐색 모드: ${seekMode==='sec'?'초 단위':'프레임 단위'}`); wakeUpUI(root, video); }); uiLayer.appendChild(smBtn);

            const svBtn = document.createElement('div'); svBtn.className = 'gt-btn-base gt-seek-val-btn';
            bindTap(svBtn, () => { if(seekMode==='sec'){ const a=[10,15,30,1,5]; seekSec=a[(a.indexOf(seekSec)+1)%a.length]; GM_setValue('gt_seek_sec', seekSec); showMsg(`이동 간격: ${seekSec}초`);} else { fpsMode=fpsMode===30?60:30; GM_setValue('gt_fps', fpsMode); showMsg(`프레임 레이트: ${fpsMode}`);} updateUIState(root, video); wakeUpUI(root, video); }); uiLayer.appendChild(svBtn);

            const lBtn = document.createElement('div'); lBtn.className = 'gt-btn-base gt-lock-btn';
            bindTap(lBtn, () => { state.isScreenLocked = !state.isScreenLocked; if(state.isScreenLocked){ const r=video.getBoundingClientRect(); const clk=new MouseEvent('click', {bubbles:true, cancelable:true, clientX:r.left+r.width/2, clientY:r.top+r.height/2}); video.dispatchEvent(clk); } wakeUpUI(root, video); }); uiLayer.appendChild(lBtn);

            const mBtn = document.createElement('div'); mBtn.className = 'gt-btn-base gt-mode-btn';
            bindTap(mBtn, () => { state.pinchMode = state.pinchMode==='speed'?'zoom':'speed'; wakeUpUI(root, video); showMsg(state.pinchMode==='speed'?'두 손가락: 재생 속도 조절':'두 손가락: 화면 확대/이동'); }); uiLayer.appendChild(mBtn);

            const fitBtn = document.createElement('div'); fitBtn.className = 'gt-btn-base gt-fit-btn'; fitBtn.innerHTML = SVG_FIT;
            bindTap(fitBtn, () => {
                const fits = ['contain', 'cover', 'fill'];
                const current = video.style.objectFit || 'contain';
                const next = fits[(fits.indexOf(current) + 1) % fits.length];
                video.style.objectFit = next;
                showMsg(next === 'cover' ? '화면: 꽉 채우기 (자르기)' : (next === 'fill' ? '화면: 꽉 채우기 (늘리기)' : '화면: 원본 비율'));
                wakeUpUI(root, video);
            });
            uiLayer.appendChild(fitBtn);

            const rBtn = document.createElement('div'); rBtn.className = 'gt-btn-base gt-rotate-btn'; rBtn.innerHTML = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`;
            bindTap(rBtn, () => { toggleOrientation(); wakeUpUI(root, video); }); uiLayer.appendChild(rBtn);

            const rstBtn = document.createElement('div'); rstBtn.className = 'gt-btn-base gt-reset-speed-btn'; rstBtn.innerHTML = `<span>1.0x</span>`;
            bindTap(rstBtn, () => { video.playbackRate = 1.0; showMsg('원래 속도로 복구'); wakeUpUI(root, video); }); uiLayer.appendChild(rstBtn);

            const zoomRstBtn = document.createElement('div'); zoomRstBtn.className = 'gt-btn-base gt-reset-zoom-btn'; zoomRstBtn.innerHTML = SVG_RESET_ZOOM;
            bindTap(zoomRstBtn, () => { state.scale = 1.0; state.panX = 0; state.panY = 0; if (video.parentNode && video.parentNode.dataset.gtOverflow) { video.parentNode.style.overflow = video.parentNode.dataset.gtOverflow; } if (video) video.style.transform = `translate(0px, 0px) scale(1)`; showMsg('원래 크기로 복구'); wakeUpUI(root, video); }); uiLayer.appendChild(zoomRstBtn);

            const style = window.getComputedStyle(root);
            if (style.position === 'static') root.style.position = 'relative';
            root.appendChild(uiLayer);
        }

        if (!video.dataset.gtTimeupdate) {
            video.addEventListener('timeupdate', () => {
                let ul = null;
                if (root.shadowRoot) ul = root.shadowRoot.querySelector('.gt-ui-layer');
                if (!ul) ul = root.querySelector('.gt-ui-layer');
                if (ul) {
                    const fill = ul.querySelector('.gt-mini-progress .gt-fill');
                    if (fill && video.duration) fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
                }
            }); video.dataset.gtTimeupdate = 'true';
        }

        if (!video.dataset.gtStateLock) {
            let enforceDepth = 0;
            const MAX_ENFORCE_DEPTH = 2;
            video.addEventListener('pause', () => {
                if (Date.now() < enforceStateUntil && enforceTarget === 'playing' && enforceDepth < MAX_ENFORCE_DEPTH) {
                    enforceDepth++;
                    video.play().catch(()=>{}).finally(() => { setTimeout(() => { enforceDepth = Math.max(0, enforceDepth - 1); }, 100); });
                }
            });
            video.addEventListener('play', () => {
                if (Date.now() < enforceStateUntil && enforceTarget === 'paused' && enforceDepth < MAX_ENFORCE_DEPTH) {
                    enforceDepth++;
                    video.pause();
                    setTimeout(() => { enforceDepth = Math.max(0, enforceDepth - 1); }, 100);
                }
            });
            video.dataset.gtStateLock = 'true';
        }

        return root;
    };

    const getPinchData = (touches) => {
        const dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
        return { dist: Math.hypot(dx, dy), cx: (touches[0].clientX + touches[1].clientX) / 2, cy: (touches[0].clientY + touches[1].clientY) / 2 };
    };

    const handleAccumulatedSeek = (dir, uiLayer, video) => {
        activeSeekSide = dir;
        let stepVal, displayText;
        if (seekMode === 'sec') { stepVal = seekSec; seekAccumulator += stepVal; displayText = `${seekAccumulator}초`; }
        else { stepVal = 1 / fpsMode; seekFrameCount += 1; seekAccumulator = seekFrameCount / fpsMode; displayText = `${seekFrameCount}프레임`; }

        video.currentTime = dir === 'left' ? Math.max(0, video.currentTime - stepVal) : Math.min(video.duration || 0, video.currentTime + stepVal);

        let t = uiLayer.querySelector('#gt-seek-' + dir);
        if (!t) { t = document.createElement('div'); t.id = 'gt-seek-' + dir; t.className = `gt-seek-msg ${dir}`; uiLayer.appendChild(t); }

        const sign = dir === 'left' ? '-' : '+';
        const arrowsHtml = dir === 'left'
            ? `<div class="gt-arrows"><span>‹</span><span class="gt-arrow-slide-l">‹</span></div>`
            : `<div class="gt-arrows"><span class="gt-arrow-slide-r">›</span><span>›</span></div>`;
        const textHtml = `<span class="gt-seek-text gt-pop-anim">${sign}${displayText}</span>`;
        t.innerHTML = dir === 'left' ? arrowsHtml + textHtml : textHtml + arrowsHtml;

        t.classList.add('show'); clearTimeout(seekSessionTimer);
        seekSessionTimer = setTimeout(() => {
            t.classList.remove('show'); activeSeekSide = null; seekAccumulator = 0; seekFrameCount = 0;
            setTimeout(() => { if (t && t.parentNode && !t.classList.contains('show')) t.innerHTML = ''; }, 200);
        }, 800);
    };

    const isInFullscreen = () => !!getFS() || !!(targetP && targetP.classList.contains('gt-fullscreen-active'));

    const onStart = (e) => {
        if (!getFS()) { document.querySelectorAll('.gt-fullscreen-active').forEach(el => { el.classList.remove('gt-fullscreen-active'); }); }

        const isEx = isExcludedZone(e);
        const currentIsFS = isInFullscreen();

        if (state.isScreenLocked && !isEx) {
            if (currentIsFS || (targetP && targetP.contains(e.target))) {
                if (e.cancelable) e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
                if (targetP && targetV) wakeUpUI(targetP, targetV); lastTapTime = Date.now(); return;
            }
        }

        if (isEx) { clearTimeout(lpTimer); return; }

        let hit = identify(e); if (!hit || !hit.video) return;
        targetP = ensureUIAndWrapper(hit); targetV = hit.video;

        const isFS = !!getFS() || targetP.classList.contains('gt-fullscreen-active');
        if (isFS) {
            if (!targetP.classList.contains('gt-lock-touch-full')) targetP.classList.add('gt-lock-touch-full');
            if (!targetV.classList.contains('gt-lock-touch-full')) targetV.classList.add('gt-lock-touch-full');
        }

        clearTimeout(lpTimer); const now = Date.now();

        const isRapid = (now - lastTapTime < 350);
        if (!isRapid) {
            tapCount = 1;
            wasPlayingBeforeSequence = targetV ? !targetV.paused : false;
            wakeUpUI(targetP, targetV);
        } else { tapCount++; }
        lastTapTime = now;

        if (e.touches && e.touches.length > 1) {
            if (e.cancelable) e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            tapCount = 0;
            enforceTarget = wasPlayingBeforeSequence ? 'playing' : 'paused'; enforceStateUntil = now + ENFORCE_STATE_DURATION;
            if (enforceTarget === 'playing' && targetV.paused) targetV.play().catch(()=>{});
            else if (enforceTarget === 'paused' && !targetV.paused) targetV.pause();
        }

        if (tapCount >= 2) {
            blockGestureUntil = now + TAP_PROTECT_DURATION;
            if (e.cancelable) e.preventDefault();
            e.stopPropagation(); e.stopImmediatePropagation();

            const uiLayer = targetP.querySelector('.gt-ui-layer') || targetP;

            const rRect = targetP.getBoundingClientRect();
            const rClientX = (e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX);
            const rWidth = rRect.width || window.innerWidth;
            const rLeft = rRect.width ? rRect.left : 0;
            const r = (rClientX - rLeft) / rWidth;

            if (r < 0.3) handleAccumulatedSeek('left', uiLayer, targetV);
            else if (r > 0.7) handleAccumulatedSeek('right', uiLayer, targetV);
            else if (tapCount === 2) toggleNativeFullscreen(targetP, targetV);

            enforceTarget = wasPlayingBeforeSequence ? 'playing' : 'paused'; enforceStateUntil = now + ENFORCE_STATE_DURATION;
            if (enforceTarget === 'playing' && targetV.paused) targetV.play().catch(()=>{});
            else if (enforceTarget === 'paused' && !targetV.paused) targetV.pause();

            isTouch = false;
            if (getFS()) hideUI(targetP);
            return;
        }

        if (!e.touches || e.touches.length === 0) { isTouch = false; return; }
        isTouch = true; action = null; startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        initTime = targetV.currentTime; initRate = targetV.playbackRate;

        if (e.touches.length === 2) {
            const p = getPinchData(e.touches); initPinchDist = p.dist; initCenterX = p.cx; initCenterY = p.cy;
            initScale = state.scale; initPanX = state.panX; initPanY = state.panY; initSpeed = targetV.playbackRate;
            const rect = targetV.getBoundingClientRect(); originDx = initCenterX - (rect.left + rect.width/2 - initPanX); originDy = initCenterY - (rect.top + rect.height/2 - initPanY);
            action = 'pinch'; if (getFS()) hideUI(targetP);
        } else if (e.touches.length === 1 && state.scale === 1.0) {
            lpTimer = setTimeout(() => {
                if (isTouch && targetV) { action = 'rate'; targetV.playbackRate = Math.max(0.1, initRate + CFG.rateBase - 1.0); showMsg(`${targetV.playbackRate.toFixed(1)}x`); if (getFS()) hideUI(targetP); }
            }, CFG.longPress);
        }
    };

    const onMove = (e) => {
        if (state.isScreenLocked) {
            if (!isExcludedZone(e) && (!!getFS() || (targetP && targetP.contains(e.target)))) {
                if (e.cancelable) e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            } return;
        }

        if (!isTouch || !targetV) return;

        if (action === 'pinch' || action === 'rate' || action === 'seek') {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation(); e.stopImmediatePropagation();
        }

        if (action === 'pinch' && e.touches.length === 2) {
            const p = getPinchData(e.touches);
            if (state.pinchMode === 'zoom') {
                state.scale = Math.max(1.0, Math.min(CFG.maxScale, initScale * (p.dist/initPinchDist)));
                if (state.scale > 1.0) { const ds = state.scale/initScale; state.panX = (p.cx-initCenterX)+initPanX*ds+originDx*(1-ds); state.panY = (p.cy-initCenterY)+initPanY*ds+originDy*(1-ds); }
                else { state.panX = 0; state.panY = 0; } applyTransform(targetV);
            } else {
                let s = initSpeed + ((p.dist-initPinchDist) * 0.005);
                let finalSpeed = s;
                if (finalSpeed > 0.95 && finalSpeed < 1.05) finalSpeed = 1.0;
                finalSpeed = Math.max(0.1, Math.min(4.0, finalSpeed));
                setRateThrottled(targetV, finalSpeed);
                showMsg(finalSpeed === 1.0 ? '1.0x' : `${finalSpeed.toFixed(2)}x`);
            } return;
        }

        if (action === 'pinch' || action === 'pinch_wait' || action === 'ignore') return;

        const dx = e.touches[0].clientX - startX, dy = startY - e.touches[0].clientY;

        if (action === 'rate') { targetV.playbackRate = Math.max(0.1, Math.min(4.0, initRate + (CFG.rateBase + dx * CFG.senseRate) - 1.0)); showMsg(`${targetV.playbackRate.toFixed(1)}x`); return; }

        if (!action) {
            if (Math.abs(dx) > CFG.minDist || Math.abs(dy) > CFG.minDist) {
                clearTimeout(lpTimer);
                if (Math.abs(dx) > Math.abs(dy)) {
                    action = 'seek';
                    enforceTarget = wasPlayingBeforeSequence ? 'playing' : 'paused'; enforceStateUntil = Date.now() + ENFORCE_STATE_DURATION;
                    if (enforceTarget === 'playing' && targetV.paused) targetV.play().catch(()=>{});
                    else if (enforceTarget === 'paused' && !targetV.paused) targetV.pause();
                    if (getFS()) hideUI(targetP);
                } else { action = 'ignore'; }
            } else return;
        }

        if (action === 'seek') { targetV.currentTime = Math.max(0, Math.min(targetV.duration||0, initTime + dx * CFG.senseX)); showMsg(`${Math.floor(targetV.currentTime/60)}:${(Math.floor(targetV.currentTime%60)+'').padStart(2,'0')}`); }
    };

    const onEnd = (e) => {
        const now = Date.now();
        const isEx = isExcludedZone(e);

        if (now < blockGestureUntil && !isEx) {
            e.stopPropagation(); e.stopImmediatePropagation();
            if (e.cancelable) e.preventDefault();
            isTouch = false; return;
        }

        if (state.isScreenLocked) {
            if (!isEx && (!!getFS() || (targetP && targetP.contains(e.target)))) { e.stopPropagation(); e.stopImmediatePropagation(); }
            isTouch = false; return;
        }
        if (!isTouch) return;
        if (e.touches.length > 0) { if (action === 'pinch') action = 'pinch_wait'; return; }

        if (pendingRate !== null && targetV) { targetV.playbackRate = pendingRate; pendingRate = null; }

        clearTimeout(lpTimer);

        const endVideo = targetV;
        const endRoot = targetP;

        if (action === 'rate' && targetV) { targetV.playbackRate = initRate; showMsg(''); wakeUpUI(targetP, targetV); }
        if ((action === 'pinch' || action === 'pinch_wait' || action === 'pan') && targetV) { wakeUpUI(targetP, targetV); }

        if (!action || action === 'ignore') { if (!activeSeekSide) wakeUpUI(targetP, targetV); }
        else { blockGestureUntil = now + TAP_PROTECT_DURATION; }

        isTouch = false; targetV = null; action = null;

        setTimeout(() => {
            if(endRoot) endRoot.classList.remove('gt-lock-touch-full');
            if(endVideo) endVideo.classList.remove('gt-lock-touch-full');
        }, 100);
    };

    const pOpt = { passive: false, capture: true };
    document.addEventListener('touchstart', onStart, pOpt); document.addEventListener('touchmove', onMove, pOpt); document.addEventListener('touchend', onEnd, pOpt); document.addEventListener('touchcancel', onEnd, pOpt);

    ['pointerdown', 'pointerup', 'pointercancel', 'click', 'dblclick'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            const isEx = isExcludedZone(e);
            if (evt === 'dblclick' && !isEx && identify(e)) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return;
            }
            if (Date.now() < blockGestureUntil) {
                if (!isEx) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
            } else if (evt === 'click') {
                const isL = state.isScreenLocked && !isEx && ((!!getFS()) || (targetP && targetP.contains(e.target)));
                if (activeSeekSide || isL) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); if (isL && targetP && targetV) wakeUpUI(targetP, targetV); }
            }
        }, { capture: true, passive: false });
    });

    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
        document.addEventListener(evt, () => {
            let fsEl = getFS();
            if (!fsEl) {
                hideUI(targetP);
                document.querySelectorAll('.gt-lock-touch-full').forEach(el => el.classList.remove('gt-lock-touch-full'));
                unlockOrientation();
                if (state.scale !== 1.0) {
                    state.scale = 1.0; state.panX = 0; state.panY = 0;
                    const v = targetV || document.querySelector('video');
                    if (v) v.style.transform = '';
                }
                const toast = document.getElementById('gt-toast');
                if (toast && toast.parentNode !== document.body) { if (toast.parentNode) toast.parentNode.removeChild(toast); document.body.appendChild(toast); }
            } else {
                setTimeout(() => {
                    let v = targetV || document.querySelector('video');
                    let root = fsEl;
                    if (root && root.tagName === 'VIDEO') root = root.parentNode;
                    let uiLayer = targetP ? targetP.querySelector('.gt-ui-layer') : null;
                    if (!uiLayer) uiLayer = document.querySelector('.gt-ui-layer');
                    if (uiLayer && root && !root.contains(uiLayer)) {
                        const style = window.getComputedStyle(root);
                        if (style.position === 'static') root.style.position = 'relative';
                        root.appendChild(uiLayer); targetP = root;
                    }
                    if (root && v) wakeUpUI(root, v);
                    if (v) lockOrientation(getVideoOrientationDir(v));
                }, 200);
            }
        });
    });
})();
