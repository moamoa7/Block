// ==UserScript==
// @name         Mobile Gesture
// @namespace    http://tampermonkey.net/
// @version      69.0.1
// @description  모바일 브라우저에서 동영상을 전용 앱처럼 편리하게 제어할 수 있는 터치 제스처 플러그인 (슬림화 버전)
// @author       Gemini & Claude
// @license      MIT
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/moamoa7/adblock/main/Mobile_Gesture.js
// @downloadURL  https://raw.githubusercontent.com/moamoa7/adblock/main/Mobile_Gesture.js
// ==/UserScript==

(function() {
    'use strict';

    const isMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
    if (!isMobile) return;

    const CFG = {
        minDist: 10, longPress: 500, rateBase: 2.0, senseX: 0.25,
        progressBarColor: '#FF6699', uiTimeout: 2500, maxScale: 8.0, senseRate: 0.015
    };

    const TAP_PROTECT_DURATION = 500;
    const SEEK_SEC = 10;

    let startX, startY, initTime, initRate, targetV, targetP, isTouch = false, action = null, lpTimer = null, lastTapTime = 0, tapCount = 0;
    let activeSeekSide = null, seekAccumulator = 0, seekSessionTimer = null;
    let initPinchDist = 0, initScale = 1.0, initPanX = 0, initPanY = 0, initCenterX = 0, initCenterY = 0, originDx = 0, originDy = 0;

    let blockGestureUntil = 0;
    let virtualTime = null;
    let lastThrottledTime = 0;

    const isFullscreenActive = (root) => {
        return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement)
            || (root && root.classList && root.classList.contains('gt-fullscreen-active'));
    };

    const getFS = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;

    // ★ 복구: Shadow DOM 재귀 비디오 찾기 (성능 위험은 fullscreenchange에서만 1회 호출이라 OK)
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

    const updateTouchAction = (video, root) => {
        const isFS = isFullscreenActive(root);
        const isZoomed = video && video.gtState && video.gtState.scale > 1.0;

        if (isFS || isZoomed) {
            if (video) video.style.setProperty('touch-action', 'none', 'important');
            if (root && root !== document.body) root.style.setProperty('touch-action', 'none', 'important');
        } else {
            if (video) video.style.removeProperty('touch-action');
            if (root && root !== document.body) root.style.removeProperty('touch-action');
        }
    };

    const updateOverscrollBehavior = (video, root) => {
        const isFS = isFullscreenActive(root);
        const isZoomed = video && video.gtState && video.gtState.scale > 1.0;

        if (isFS || isZoomed) {
            if (video) video.style.setProperty('overscroll-behavior', 'none', 'important');
            if (root && root !== document.body) root.style.setProperty('overscroll-behavior', 'none', 'important');
        } else {
            if (video) video.style.removeProperty('overscroll-behavior');
            if (root && root !== document.body) root.style.removeProperty('overscroll-behavior');
        }
    };

    const updateWrapperOverflow = (video) => {
        const wrapper = video && video.parentNode;
        if (!wrapper || !wrapper.classList.contains('gt-video-wrapper')) return;
        const isZoomed = video.gtState && video.gtState.scale > 1.0;
        const isFS = isFullscreenActive(video.gtRoot);

        if (isFS || isZoomed) {
            wrapper.style.overflow = 'hidden';
        } else {
            wrapper.style.overflow = wrapper.dataset.gtOverflow || 'visible';
        }
    };

    const isPreviewVideo = (v) => {
        const rect = v.getBoundingClientRect();
        if (rect.width === 0) return false;
        if (rect.width < 300) return true;

        const isSilentAuto = !v.hasAttribute('controls') && (v.muted || v.hasAttribute('muted')) && (v.autoplay || v.hasAttribute('autoplay'));

        let p = v.parentNode;
        let depth = 0;
        while (p && p !== document.body && depth < 3) {
            if (p.tagName === 'A' && rect.width < 600) return true;
            if (typeof p.className === 'string' && /(hover-?play|preview-?vid)/i.test(p.className)) {
                if (rect.width < 600) return true;
            }
            p = p.parentNode;
            depth++;
        }
        if (isSilentAuto && rect.width < 450) return true;
        return false;
    };

    const getDeviceScale = (containerH, isPreview) => {
        if (isPreview) return 0.5;

        let logicalW = GM_getValue('gt_logical_w', 0);
        let innerW = window.innerWidth;
        let screenW = Math.min(window.screen.width, window.screen.height);

        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
            if (logicalW === 0 || Math.abs(logicalW - screenW) > 50) {
                if (screenW < 600) {
                    logicalW = screenW;
                    GM_setValue('gt_logical_w', logicalW);
                } else if (logicalW === 0) {
                    logicalW = 400;
                }
            }
        }

        let scale = 1.0;
        const isMobileHW = logicalW > 0 && logicalW < 600;

        if (isMobileHW && innerW >= 800) {
            let fullScale = innerW / logicalW;
            if (containerH > 0) {
                if (202 * fullScale + 60 > containerH) {
                    if (202 * 1.5 + 60 <= containerH) { scale = 1.5; }
                    else { scale = 1.0; }
                } else { scale = fullScale; }
            } else { scale = fullScale; }
        }
        return scale;
    };

    const applyFixedScale = (root, video, uiLayer) => {
        if (!uiLayer || !uiLayer.id) return;
        const containerH = (root ? root.clientHeight : 0) || video.clientHeight || window.innerHeight;
        const isPreview = video.dataset.gtIsPreview === 'true';
        const S = getDeviceScale(containerH, isPreview);
        let styleEl = uiLayer.querySelector('style');
        if (styleEl) { styleEl.textContent = getUICss(S, uiLayer.id); }
    };

    const lockOrientation = (dir) => {
        if (screen.orientation?.lock) {
            screen.orientation.lock(dir).catch(() => {});
        }
    };

    const unlockOrientation = () => {
        if (screen.orientation?.unlock) screen.orientation.unlock();
    };

    const getVideoOrientationDir = (v) => {
        return (v && v.videoWidth > 0 && v.videoWidth < v.videoHeight) ? 'portrait' : 'landscape';
    };

    const VIP_SELECTORS = '.video-js, .vjs-custom-skin, .player-container, .art-video-player, .xgplayer, .tcplayer, .prism-player, .mui-player, [data-testid="videoComponent"], [data-testid="video-container"], .player-wrapper, .one-video-player_display-w, .one-video-player, vk-video-player, [aria-label="Видео плеер"], [aria-label="Video Player"], .plyr, #html5video, #movie_player, .html5-video-player, .bpx-player-container, .dplayer, .artplayer-app, .MacPlayer, .ckplayer, #playleft, iframe';

    const IGNORE_TOUCH_SELECTORS = '.gt-btn-base, .dplayer-controller, .dplayer-bar-wrap, .vjs-control-bar, .art-bottom, .art-controls, .bpx-player-control-wrap, .plyr__controls, .xgplayer-controls, .tcplayer-controls, .prism-controlbar, .mui-player-controls, .wrapper-bottom, [data-testid="player_controls"], [data-testid="progress_bar"], [data-testid="volume-slider"], input[type="range"], .buttons-bar, .progress-bar-container';

    const FS_BTN_SELECTORS = '.art-icon-fullscreenOn, .art-control-fullscreen, .dplayer-full-icon, .plyr__control[data-plyr="fullscreen"], .vjs-fullscreen-control, .xgplayer-fullscreen, .tcplayer-fullscreen-btn, .prism-fullscreen-btn, [aria-label*="全屏"], [title*="全屏"], [aria-label*="전체 화면"], [title*="전체화면"], .fullscreen-btn, .bilibili-player-video-btn-fullscreen, [data-testid="btn-fullscreen"], [aria-label="На весь экран"]';

    const isExcludedZone = (e) => {
        const path = (typeof e.composedPath === 'function') ? e.composedPath() : [];
        if (path.length > 0) {
            for (let el of path) {
                if (el.nodeType === 1) {
                    if (el.hasAttribute && el.hasAttribute('data-vsc-ui')) return true;
                    if (el.id === 'vsc-host' || el.id === 'vsc-gear-host' || el.id === 'vsc-osd-host') return true;
                }
                if (el.matches && el.matches(IGNORE_TOUCH_SELECTORS)) return true;
            }
            return false;
        }
        let el = e.target;
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.hasAttribute && el.hasAttribute('data-vsc-ui')) return true;
            if (el.id === 'vsc-host' || el.id === 'vsc-gear-host' || el.id === 'vsc-osd-host') return true;
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

    const isNakedForumVideo = (video) => {
        if (findUp(video, VIP_SELECTORS.replace(', iframe', ''))) return false;
        let p = video.parentNode;
        if (!p || p === document.body || p === document.documentElement) return true;

        const className = (p.className || '').toLowerCase();
        if (/(bbs|thread|post|article|content|message|text)/.test(className)) return true;

        const pRect = p.getBoundingClientRect();
        const vRect = video.getBoundingClientRect();
        if (pRect.height - vRect.height > 50 || pRect.width - vRect.width > 50) return true;

        return false;
    };

    const restoreVideoStyle = (video) => {
        if (!video) return;

        if (video.dataset.gtOrigObjectFit !== undefined) {
            if (video.dataset.gtOrigObjectFit === '') {
                video.style.removeProperty('object-fit');
            } else {
                video.style.objectFit = video.dataset.gtOrigObjectFit;
            }
        }

        if (video.gtState) {
            video.gtState.scale = 1.0;
            video.gtState.panX = 0;
            video.gtState.panY = 0;
            video.style.transform = '';
        }

        video.style.removeProperty('touch-action');
        video.style.removeProperty('overscroll-behavior');

        const wrapper = video.parentNode;
        if (wrapper && wrapper.classList.contains('gt-video-wrapper')) {
            wrapper.style.height = 'auto';
            wrapper.style.maxWidth = '100%';
            wrapper.style.removeProperty('touch-action');
            wrapper.style.removeProperty('overscroll-behavior');
            wrapper.style.overflow = wrapper.dataset.gtOverflow || 'visible';

            if (wrapper.dataset.gtOrigW) {
                const origW = wrapper.dataset.gtOrigW;
                wrapper.style.width = (!origW || origW === 'auto' || origW === '0px') ? '100%' : origW;
            }

            video.style.width = '100%';
            video.style.height = 'auto';
            video.style.maxWidth = '100%';
        }
    };

    const clearAllBlockingStyles = (video) => {
        if (!video) return;
        video.style.removeProperty('touch-action');
        video.style.removeProperty('overscroll-behavior');

        const root = video.gtRoot;
        if (root && root !== document.body) {
            root.style.removeProperty('touch-action');
            root.style.removeProperty('overscroll-behavior');
        }

        const wrapper = video.parentNode;
        if (wrapper && wrapper.classList.contains('gt-video-wrapper')) {
            wrapper.style.removeProperty('touch-action');
            wrapper.style.removeProperty('overscroll-behavior');
            wrapper.style.overflow = wrapper.dataset.gtOverflow || 'visible';
        }
    };

    const backupVideoStyle = (video) => {
        if (!video) return;
        if (video.dataset.gtOrigObjectFit === undefined) {
            video.dataset.gtOrigObjectFit = video.style.objectFit || '';
        }
    };

    const toggleNativeFullscreen = (container, video) => {
        const isFS = !!(document.fullscreenElement || document.webkitFullscreenElement) || container.classList.contains('gt-fullscreen-active');
        const fsBtn = container.querySelector(FS_BTN_SELECTORS);

        if (isFS) {
            restoreVideoStyle(video);

            if (fsBtn) { try { fsBtn.click(); } catch(e){} }
            if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
            else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
            container.classList.remove('gt-fullscreen-active');
            unlockOrientation();
            clearAllBlockingStyles(video);
        } else {
            backupVideoStyle(video);

            const forceLockLandscape = () => { lockOrientation(getVideoOrientationDir(video)); };
            if (fsBtn) { try { fsBtn.click(); } catch(e){} }
            container.classList.add('gt-fullscreen-active');
            updateTouchAction(video, container);
            updateOverscrollBehavior(video, container);
            const reqFs = container.requestFullscreen || container.webkitRequestFullscreen || container.mozRequestFullScreen;
            if (reqFs) {
                const p = reqFs.call(container);
                if (p && p.then) {
                    p.then(() => setTimeout(forceLockLandscape, 150)).catch(()=>{
                        if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
                        setTimeout(forceLockLandscape, 150);
                    });
                } else { setTimeout(forceLockLandscape, 150); }
            } else if (video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen(); setTimeout(forceLockLandscape, 150);
            }
        }
    };

    const toggleOrientation = () => {
        if (!screen.orientation) return;
        const dir = screen.orientation.type.startsWith('landscape') ? 'portrait' : 'landscape';
        lockOrientation(dir);
    };

    const getUICss = (S, uid) => {
        const TS = S > 1.0 ? S * 0.75 : S;
        const FS = S > 1.0 ? S * 0.5 : 1.0;

        return `
        #${uid} { position: absolute !important; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none !important; z-index: 2147483647 !important; }

        #${uid} .gt-mini-progress { position: absolute; bottom: 0; left: 0; width: 100%; height: 2px; background: rgba(255,255,255,0.2); z-index: 2147483640; pointer-events: none; overflow: hidden; opacity: 0; transition: height 0.2s, opacity 0.3s; box-shadow: 0 -1px 1px rgba(0,0,0,0.2); display: none; }
        #${uid} .gt-mini-progress .gt-fill { height: 100%; width: 0%; background: ${CFG.progressBarColor}; transition: width 0.1s linear; box-shadow: 0 0 4px ${CFG.progressBarColor}; }
        :fullscreen #${uid} .gt-mini-progress, .gt-fullscreen-active #${uid} .gt-mini-progress { display: block !important; opacity: 0.9 !important; height: 3px !important; }

        #${uid} .gt-btn-base { position: absolute; width: ${38 * FS}px; height: ${38 * FS}px; display: none; align-items: center; justify-content: center; z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity 0.3s ease, transform 0.15s ease; border: none; background: rgba(0,0,0,0.35); border-radius: 50%; color: rgba(255, 255, 255, 0.95); filter: drop-shadow(0px 2px 4px rgba(0,0,0,0.8)); }
        #${uid} .gt-btn-base * { pointer-events: none !important; }
        #${uid} .gt-btn-base svg { width: ${22 * FS}px; height: ${22 * FS}px; transition: all 0.2s ease; transform-origin: center center; fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }
        #${uid} .gt-btn-base svg * { fill: none !important; stroke: currentColor !important; stroke-width: 2 !important; stroke-linecap: round !important; stroke-linejoin: round !important; }

        :fullscreen #${uid} .gt-btn-base, .gt-fullscreen-active #${uid} .gt-btn-base { display: flex !important; opacity: 0.6 !important; pointer-events: auto !important; }
        :fullscreen #${uid} .gt-btn-base.hidden-by-state, .gt-fullscreen-active #${uid} .gt-btn-base.hidden-by-state { display: none !important; pointer-events: none !important; }
        :fullscreen #${uid} .gt-btn-base:active, .gt-fullscreen-active #${uid} .gt-btn-base:active { opacity: 1 !important; color: #fff; background: rgba(0,0,0,0.55); }

        #${uid} .gt-pip-btn { top: 20px; left: 20px; }
        #${uid} .gt-rotate-btn { bottom: 20px; left: 20px; }
        #${uid} .gt-fit-btn { top: 20px; right: 20px; }
        #${uid} .gt-reset-zoom-btn { bottom: 20px; right: 20px; }

        :fullscreen #${uid} .gt-pip-btn, .gt-fullscreen-active #${uid} .gt-pip-btn { top: 30px; left: 30px; }
        :fullscreen #${uid} .gt-rotate-btn, .gt-fullscreen-active #${uid} .gt-rotate-btn { bottom: 30px; left: 30px; }
        :fullscreen #${uid} .gt-fit-btn, .gt-fullscreen-active #${uid} .gt-fit-btn { top: 30px; right: 30px; }
        :fullscreen #${uid} .gt-reset-zoom-btn, .gt-fullscreen-active #${uid} .gt-reset-zoom-btn { bottom: 30px; right: 30px; }

        #${uid} .gt-seek-msg { position: absolute !important; top: 45% !important; color: rgba(255, 255, 255, 0.95) !important; z-index: 2147483647 !important; pointer-events: none !important; opacity: 0; transition: opacity 0.15s ease-out; display: none !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; gap: ${6 * FS}px !important; font-family: system-ui, -apple-system, sans-serif !important; white-space: nowrap !important; text-shadow: 0 0 ${10 * FS}px rgba(0,0,0,0.8), 0 0 ${4 * FS}px rgba(0,0,0,0.6), 0 ${2 * FS}px ${4 * FS}px rgba(0,0,0,0.5) !important; }
        :fullscreen #${uid} .gt-seek-msg, .gt-fullscreen-active #${uid} .gt-seek-msg { display: flex !important; }
        #${uid} .gt-seek-msg.left { left: 15%; transform: translateY(-50%); }
        #${uid} .gt-seek-msg.right { right: 15%; transform: translateY(-50%); }
        #${uid} .gt-seek-msg.show { opacity: 1; }
        #${uid} .gt-seek-text { display: block !important; font-size: ${15 * FS}px !important; font-weight: 500 !important; line-height: 1 !important; white-space: nowrap !important; transform-origin: center center !important; will-change: transform; }
        #${uid} .gt-arrows { display: flex !important; flex-direction: row !important; flex-wrap: nowrap !important; align-items: center !important; justify-content: center !important; font-size: ${22 * FS}px !important; font-weight: 400 !important; line-height: 1 !important; }
        #${uid} .gt-arrows span { display: block !important; line-height: 1 !important; white-space: nowrap !important; }

        #${uid} .gt-toast { position: absolute; top: 10%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.5); color: #fff; padding: ${5 * FS}px ${12 * FS}px; border-radius: ${4 * FS}px; font: 700 ${14 * FS}px system-ui; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s; text-shadow: 0 0 ${2 * FS}px #000; border: 1px solid rgba(255,255,255,0.05); display: none; }
        :fullscreen #${uid} .gt-toast, .gt-fullscreen-active #${uid} .gt-toast { display: block !important; }
        #${uid} .gt-toast.show { opacity: 1; }
        `;
    };

    GM_addStyle(`
        :fullscreen { background-color: #000 !important; }
        .gt-pop-anim { animation: gt-pop 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
        @keyframes gt-pop { 0% { transform: scale(1); } 40% { transform: scale(1.35); } 100% { transform: scale(1); } }
        .gt-arrow-slide-r { animation: gt-slide-r 0.6s infinite; }
        @keyframes gt-slide-r { 0% { transform: translateX(-4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(4px); opacity: 0; } }
        .gt-arrow-slide-l { animation: gt-slide-l 0.6s infinite; }
        @keyframes gt-slide-l { 0% { transform: translateX(4px); opacity: 0; } 40% { opacity: 1; } 100% { transform: translateX(-4px); opacity: 0; } }
        #gt-toast-global { position: fixed; top: 10%; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.5); color: #fff; padding: 5px 12px; border-radius: 4px; font: 700 14px system-ui; z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity 0.2s; text-shadow: 0 0 2px #000; border: 1px solid rgba(255,255,255,0.05); }
        #gt-toast-global.show { opacity: 1; }
    `);

    const SVG_RESET_ZOOM = `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" stroke-dasharray="4 2"></rect></svg>`;
    const SVG_FIT = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 8V4h4m8 0h4v4m0 8v4h-4m-8 0H4v-4"></path></svg>`;
    const SVG_PIP = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z"></path></svg>`;
    const SVG_ROTATE = `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>`;

    const showMsg = (txt, video = null) => {
        let uiLayer = (video && video.gtUI) ? video.gtUI : (targetV && targetV.gtUI ? targetV.gtUI : null);

        let t;
        if (uiLayer) {
            t = uiLayer.querySelector('.gt-toast');
            if (!t) {
                t = document.createElement('div');
                t.className = 'gt-toast';
                uiLayer.appendChild(t);
            }
            t.style.position = 'absolute';
        } else {
            t = document.getElementById('gt-toast-global');
            if (!t) {
                t = document.createElement('div');
                t.id = 'gt-toast-global';
                t.className = 'gt-toast';
                document.body.appendChild(t);
            }
            t.style.position = 'fixed';
            t.style.zIndex = '2147483647';
        }

        t.textContent = txt;
        t.classList.add('show');
        if (t.gtTimer) clearTimeout(t.gtTimer);
        t.gtTimer = setTimeout(() => t.classList.remove('show'), 800);
    };

    const identify = (e) => {
        let targetVideo = null;
        let rootContainer = null;

        const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
        for (let el of path) {
            if (el.tagName === 'VIDEO') { targetVideo = el; break; }
        }

        // ★ 보조: composedPath에서 못 찾으면 fullscreenElement 내부에서 찾기
        if (!targetVideo) {
            const fsEl = getFS();
            if (fsEl) {
                if (fsEl.tagName === 'VIDEO') targetVideo = fsEl;
                else targetVideo = findDeepVid(fsEl);
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
            const isFS = !!getFS() || (rootContainer && rootContainer.classList && rootContainer.classList.contains('gt-fullscreen-active'));
            if (!isFS) {
                const checkBox = rootContainer || targetVideo;
                const rect = checkBox.getBoundingClientRect();
                const touch = e.touches[0];
                if (touch.clientX < rect.left - 10 || touch.clientX > rect.right + 10 ||
                    touch.clientY < rect.top - 10 || touch.clientY > rect.bottom + 10) return null;
            }
        }

        return { root: rootContainer, video: targetVideo };
    };

    const updateUIState = (root, video) => {
        if (!video || !video.gtUI || !video.gtState) return;
        let uiLayer = video.gtUI;
        const vState = video.gtState;

        const btnRot = uiLayer.querySelector('.gt-rotate-btn');
        const btnZoomRst = uiLayer.querySelector('.gt-reset-zoom-btn');
        const btnFit = uiLayer.querySelector('.gt-fit-btn');
        const btnPip = uiLayer.querySelector('.gt-pip-btn');

        if (btnPip) btnPip.classList.remove('hidden-by-state');
        if (btnRot) btnRot.classList.remove('hidden-by-state');
        if (btnFit) btnFit.classList.remove('hidden-by-state');
        if (btnZoomRst) {
            if (vState.scale > 1.0) btnZoomRst.classList.remove('hidden-by-state');
            else btnZoomRst.classList.add('hidden-by-state');
        }
    };

    const wakeUpUI = (root, video) => {
        if (!video || !video.gtUI) return;
        const isFS = isFullscreenActive(root);
        if (!isFS) return;

        const uiLayer = video.gtUI;
        uiLayer.classList.add('gt-ui-visible');
        updateUIState(root, video);
        if (video.gtUITimer) clearTimeout(video.gtUITimer);
        video.gtUITimer = setTimeout(() => { uiLayer.classList.remove('gt-ui-visible'); }, CFG.uiTimeout);
    };

    const hideUI = (video) => {
        if (video && video.gtUI) {
            video.gtUI.classList.remove('gt-ui-visible');
            if (video.gtUITimer) clearTimeout(video.gtUITimer);
        }
    };

    const applyTransform = (video) => {
        if (!video || !video.gtState) return;
        const vState = video.gtState;
        if (vState.scale <= 1.05) { vState.scale = 1.0; vState.panX = 0; vState.panY = 0; }
        else {
            const mX = (video.clientWidth * vState.scale - video.clientWidth) / 2, mY = (video.clientHeight * vState.scale - video.clientHeight) / 2;
            vState.panX = Math.max(-mX, Math.min(mX, vState.panX)); vState.panY = Math.max(-mY, Math.min(mY, vState.panY));
        }
        video.style.setProperty('transition', 'none', 'important');
        video.style.setProperty('will-change', 'transform', 'important');
        video.style.transform = `translate(${vState.panX}px, ${vState.panY}px) scale(${vState.scale})`;
        updateTouchAction(video, video.gtRoot);
        updateWrapperOverflow(video);
    };

    const bindTap = (btn, handler) => {
        let lastExec = 0;
        const wrap = (e) => {
            e.stopPropagation(); e.stopImmediatePropagation(); if (e.type === 'touchend' && e.cancelable) e.preventDefault();
            const now = Date.now(); if (now - lastExec < 300) return; lastExec = now; handler(e);
            const icon = btn.querySelector('svg') || btn.querySelector('span');
            if (icon) { icon.classList.remove('gt-pop-anim'); void icon.offsetWidth; icon.classList.add('gt-pop-anim'); }
        };
        btn.addEventListener('touchend', wrap, {passive: false, capture: true});
        btn.addEventListener('click', wrap, {capture: true});
        ['touchstart', 'mousedown', 'pointerdown', 'contextmenu', 'dblclick'].forEach(evt => {
            btn.addEventListener(evt, (e)=>{e.stopPropagation(); e.stopImmediatePropagation();}, { capture: true, passive: false });
        });
    };

    const buildUI = (root, video) => {
        const uid = 'gt-ui-' + Math.random().toString(36).substr(2, 9);
        let uiLayer = document.createElement('div');
        uiLayer.id = uid;
        uiLayer.className = 'gt-ui-layer';

        const isPreview = video.dataset.gtIsPreview === 'true';
        const containerH = root.clientHeight || video.clientHeight || window.innerHeight;
        const S = getDeviceScale(containerH, isPreview);

        const styleEl = document.createElement('style');
        styleEl.textContent = getUICss(S, uid);
        uiLayer.appendChild(styleEl);

        const bar = document.createElement('div'); bar.className = 'gt-mini-progress'; bar.innerHTML = '<div class="gt-fill"></div>'; uiLayer.appendChild(bar);

        // 좌측 상단: PIP
        if (document.pictureInPictureEnabled) {
            const pipBtn = document.createElement('div'); pipBtn.className = 'gt-btn-base gt-pip-btn'; pipBtn.innerHTML = SVG_PIP;
            bindTap(pipBtn, () => {
                if (document.pictureInPictureElement) document.exitPictureInPicture();
                else video.requestPictureInPicture().catch(() => showMsg('PIP 모드 실행 실패', video));
                wakeUpUI(root, video);
            });
            uiLayer.appendChild(pipBtn);
        }

        // 좌측 하단: 회전
        const rBtn = document.createElement('div'); rBtn.className = 'gt-btn-base gt-rotate-btn'; rBtn.innerHTML = SVG_ROTATE;
        bindTap(rBtn, () => { toggleOrientation(); wakeUpUI(root, video); });
        uiLayer.appendChild(rBtn);

        // 우측 상단: Fit
        const fitBtn = document.createElement('div'); fitBtn.className = 'gt-btn-base gt-fit-btn'; fitBtn.innerHTML = SVG_FIT;
        bindTap(fitBtn, () => {
            const fits = ['contain', 'cover', 'fill'];
            const current = video.style.objectFit || 'contain';
            const next = fits[(fits.indexOf(current) + 1) % fits.length];
            video.style.objectFit = next;
            showMsg(next === 'cover' ? '화면: 꽉 채우기 (자르기)' : (next === 'fill' ? '화면: 꽉 채우기 (늘리기)' : '화면: 원본 비율'), video);
            wakeUpUI(root, video);
        });
        uiLayer.appendChild(fitBtn);

        // 우측 하단: 줌 리셋
        const zoomRstBtn = document.createElement('div'); zoomRstBtn.className = 'gt-btn-base gt-reset-zoom-btn'; zoomRstBtn.innerHTML = SVG_RESET_ZOOM;
        bindTap(zoomRstBtn, () => {
            if(!video.gtState)return;
            video.gtState.scale = 1.0; video.gtState.panX = 0; video.gtState.panY = 0;
            video.style.transform = `translate(0px, 0px) scale(1)`;
            updateTouchAction(video, video.gtRoot); updateWrapperOverflow(video);
            showMsg('원래 크기로 복구', video); wakeUpUI(root, video);
        });
        uiLayer.appendChild(zoomRstBtn);

        if (root.shadowRoot) {
            root.shadowRoot.appendChild(uiLayer);
        } else {
            const style = window.getComputedStyle(root);
            if (style.position === 'static') root.style.position = 'relative';
            root.appendChild(uiLayer);
        }
        return uiLayer;
    };

    const checkAndBuildUI = (root, video) => {
        if (!video.gtState) {
            video.gtState = { scale: 1.0, panX: 0, panY: 0 };
        }

        let uiLayer = root.shadowRoot ? root.shadowRoot.querySelector('.gt-ui-layer') : root.querySelector('.gt-ui-layer');

        if (uiLayer && video.gtUI && uiLayer !== video.gtUI) {
            uiLayer.remove();
            uiLayer = null;
        }

        if (!uiLayer) {
            const container = root.shadowRoot || root;
            Array.from(container.children).forEach(child => {
                if (child.classList && child.classList.contains('gt-ui-layer') && child !== video.gtUI) {
                    child.remove();
                }
            });
            uiLayer = buildUI(root, video);
            video.gtUI = uiLayer;
        }

        return uiLayer;
    };

    // ★ UI 레이어를 새 root로 이동 (전체화면 진입 시 핵심)
    const moveUIToRoot = (video, newRoot) => {
        if (!video || !video.gtUI || !newRoot) return;
        if (newRoot.tagName === 'VIDEO') newRoot = newRoot.parentNode;
        if (!newRoot) return;

        const isInside = newRoot.contains(video.gtUI) || (newRoot.shadowRoot && newRoot.shadowRoot.contains(video.gtUI));
        if (isInside) return;

        const style = window.getComputedStyle(newRoot);
        if (style.position === 'static') newRoot.style.position = 'relative';

        if (newRoot.shadowRoot) {
            newRoot.shadowRoot.appendChild(video.gtUI);
        } else {
            newRoot.appendChild(video.gtUI);
        }
        video.gtRoot = newRoot;
    };

    const initVideoCore = (video) => {
        if (!video || video.dataset.gtCoreInit) return;
        video.dataset.gtCoreInit = 'true';

        if (!video.gtState) video.gtState = { scale: 1.0, panX: 0, panY: 0 };
        video.dataset.gtIsPreview = isPreviewVideo(video) ? 'true' : 'false';

        const root = getValidPlayerRoot(video);
        if (root && root !== document.body && root !== document.documentElement) {
            video.gtRoot = root;
            checkAndBuildUI(root, video);
            updateTouchAction(video, root);
            updateOverscrollBehavior(video, root);
        }

        video.addEventListener('timeupdate', () => {
            if (video.gtUI && video.duration) {
                const fill = video.gtUI.querySelector('.gt-mini-progress .gt-fill');
                if (fill) fill.style.width = `${(video.currentTime / video.duration) * 100}%`;
            }
        });
    };

    const scanAndInitCore = () => {
        document.querySelectorAll('video').forEach(initVideoCore);
    };

    const domObserver = new MutationObserver((mutations) => {
        let hasNew = false;
        for (let m of mutations) { if (m.addedNodes.length) { hasNew = true; break; } }
        if (hasNew) scanAndInitCore();
    });
    domObserver.observe(document, { childList: true, subtree: true });

    ['play', 'loadedmetadata'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            if (e.target && e.target.tagName === 'VIDEO') initVideoCore(e.target);
        }, { capture: true, passive: true });
    });
    scanAndInitCore();

    const setupPlayer = (video) => {
        if (!video) return false;

        let root = getValidPlayerRoot(video);
        if (!root || root === document.body || root === document.documentElement) return false;

        const isPreview = isPreviewVideo(video);
        video.dataset.gtIsPreview = isPreview ? 'true' : 'false';

        video.style.setProperty('transition', 'none', 'important');
        video.style.setProperty('will-change', 'transform', 'important');

        const isNaked = isNakedForumVideo(video);
        video.dataset.gtIsNaked = isNaked ? 'true' : 'false';

        if (isNaked && video.parentNode && !video.parentNode.classList.contains('gt-video-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'gt-video-wrapper';

            const cStyle = window.getComputedStyle(video);

            video.dataset.gtOrigWidth = video.style.width || '';
            video.dataset.gtOrigHeight = video.style.height || '';
            video.dataset.gtOrigMargin = video.style.margin || '';
            video.dataset.gtOrigObjectFit = video.style.objectFit || '';

            wrapper.style.position = 'relative';
            wrapper.style.display = (cStyle.display === 'inline' || cStyle.display === 'inline-block') ? 'inline-block' : 'block';

            let w = video.style.width || video.getAttribute('width') || cStyle.width;
            let h = video.style.height || video.getAttribute('height') || cStyle.height;

            wrapper.dataset.gtOrigW = w || '';
            wrapper.dataset.gtOrigH = h || '';
            wrapper.dataset.gtComputedW = cStyle.width;
            wrapper.dataset.gtComputedH = cStyle.height;
            wrapper.dataset.gtOverflow = cStyle.overflow || '';

            wrapper.style.width = (!w || w === 'auto' || w === '0px') ? '100%' : w;
            wrapper.style.maxWidth = '100%';
            wrapper.style.height = 'auto';
            wrapper.style.overflow = 'visible';
            wrapper.style.margin = cStyle.margin;
            wrapper.style.background = '#000';

            video.parentNode.insertBefore(wrapper, video);
            wrapper.appendChild(video);

            video.style.margin = '0';
            video.style.width = '100%';
            video.style.height = 'auto';
            video.style.maxWidth = '100%';
            if (!video.style.objectFit) video.style.objectFit = 'contain';

            root = wrapper;
            video.setAttribute('controlslist', 'nofullscreen');
        }

        if (video.dataset.gtOrigObjectFit === undefined) {
            video.dataset.gtOrigObjectFit = video.style.objectFit || '';
        }

        if (!video.dataset.gtSetupDone || video.gtRoot !== root) {
            video.dataset.gtSetupDone = 'true';
            video.gtRoot = root;
            initVideoCore(video);
        }

        updateTouchAction(video, root);
        updateOverscrollBehavior(video, root);

        checkAndBuildUI(root, video);
        return true;
    };

    const getPinchData = (touches) => {
        const dx = touches[0].clientX - touches[1].clientX, dy = touches[0].clientY - touches[1].clientY;
        return { dist: Math.hypot(dx, dy), cx: (touches[0].clientX + touches[1].clientX) / 2, cy: (touches[0].clientY + touches[1].clientY) / 2 };
    };

    const handleAccumulatedSeek = (dir, uiLayer, video) => {
        activeSeekSide = dir;
        seekAccumulator += SEEK_SEC;
        const displayText = `${seekAccumulator}초`;

        video.currentTime = dir === 'left' ? Math.max(0, video.currentTime - SEEK_SEC) : Math.min(video.duration || 0, video.currentTime + SEEK_SEC);

        let t = uiLayer.querySelector('.gt-seek-msg');
        if (!t) { t = document.createElement('div'); t.className = `gt-seek-msg ${dir}`; uiLayer.appendChild(t); }
        t.className = `gt-seek-msg ${dir}`;

        const sign = dir === 'left' ? '-' : '+';
        let textNode = t.querySelector('.gt-seek-text');
        if (!textNode) {
            const arrowsHtml = dir === 'left'
                ? `<div class="gt-arrows"><span>‹</span><span class="gt-arrow-slide-l">‹</span></div>`
                : `<div class="gt-arrows"><span class="gt-arrow-slide-r">›</span><span>›</span></div>`;
            const textHtml = `<span class="gt-seek-text gt-pop-anim">${sign}${displayText}</span>`;
            t.innerHTML = dir === 'left' ? arrowsHtml + textHtml : textHtml + arrowsHtml;
        } else {
            textNode.classList.remove('gt-pop-anim'); void textNode.offsetWidth; textNode.classList.add('gt-pop-anim');
            textNode.textContent = `${sign}${displayText}`;
        }

        t.classList.add('show'); clearTimeout(seekSessionTimer);
        seekSessionTimer = setTimeout(() => {
            t.classList.remove('show'); activeSeekSide = null; seekAccumulator = 0;
            setTimeout(() => { if (t && t.parentNode && !t.classList.contains('show')) t.innerHTML = ''; }, 200);
        }, 800);
    };

    const onStart = (e) => {
        if (!getFS()) { document.querySelectorAll('.gt-fullscreen-active').forEach(el => { el.classList.remove('gt-fullscreen-active'); }); }

        const isEx = isExcludedZone(e);

        let hit = identify(e); if (!hit || !hit.video) return;
        targetV = hit.video;
        if (!targetV.gtState) targetV.gtState = { scale: 1.0, panX: 0, panY: 0 };

        if (isEx) { clearTimeout(lpTimer); return; }

        setupPlayer(targetV);

        // ★ 전체화면 진입 후 UI가 fullscreen 컨테이너 밖에 있으면 이동
        const fsEl = getFS();
        if (fsEl && targetV.gtUI && !fsEl.contains(targetV.gtUI)) {
            let newRoot = fsEl.tagName === 'VIDEO' ? fsEl.parentNode : fsEl;
            if (newRoot) moveUIToRoot(targetV, newRoot);
        }

        let uiLayer = checkAndBuildUI(targetV.gtRoot, targetV);
        targetP = targetV.gtRoot;

        const curIsFS = isFullscreenActive(targetP);
        if (curIsFS) {
            if (!targetP.classList.contains('gt-fullscreen-active')) targetP.classList.add('gt-fullscreen-active');
        }

        clearTimeout(lpTimer); const now = Date.now();

        const isRapid = (now - lastTapTime < 350);
        if (!isRapid) {
            tapCount = 1;
            if (curIsFS) wakeUpUI(targetP, targetV);
        } else { tapCount++; }
        lastTapTime = now;

        if (e.touches && e.touches.length > 1) {
            if (!curIsFS) { isTouch = false; return; }
            if (e.cancelable) e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
            tapCount = 0;
        }

        if (tapCount >= 2) {
            const rRect = targetP.getBoundingClientRect();
            const rClientX = (e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX);
            const rWidth = rRect.width || window.innerWidth;
            const rLeft = rRect.width ? rRect.left : 0;
            const r = (rClientX - rLeft) / rWidth;

            if (r < 0.3) {
                if (!curIsFS) { isTouch = false; return; }
                blockGestureUntil = now + TAP_PROTECT_DURATION;
                if (e.cancelable) e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                handleAccumulatedSeek('left', uiLayer, targetV);
            } else if (r > 0.7) {
                if (!curIsFS) { isTouch = false; return; }
                blockGestureUntil = now + TAP_PROTECT_DURATION;
                if (e.cancelable) e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                handleAccumulatedSeek('right', uiLayer, targetV);
            } else if (tapCount === 2 && targetV.dataset.gtIsPreview !== 'true') {
                blockGestureUntil = now + TAP_PROTECT_DURATION;
                if (e.cancelable) e.preventDefault();
                e.stopPropagation(); e.stopImmediatePropagation();
                toggleNativeFullscreen(targetP, targetV);
            }

            isTouch = false;
            if (getFS()) hideUI(targetV);
            return;
        }

        if (!e.touches || e.touches.length === 0) { isTouch = false; return; }
        isTouch = true; action = null; startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        initTime = targetV.currentTime; initRate = targetV.playbackRate;
        virtualTime = null;

        if (e.touches.length === 2) {
            if (!curIsFS) { isTouch = false; return; }
            const vState = targetV.gtState;
            const p = getPinchData(e.touches); initPinchDist = p.dist; initCenterX = p.cx; initCenterY = p.cy;
            initScale = vState.scale; initPanX = vState.panX; initPanY = vState.panY;
            const rect = targetV.getBoundingClientRect(); originDx = initCenterX - (rect.left + rect.width/2 - initPanX); originDy = initCenterY - (rect.top + rect.height/2 - initPanY);
            action = 'pinch'; hideUI(targetV);
        } else if (e.touches.length === 1) {
            if (curIsFS && targetV.gtState.scale === 1.0) {
                lpTimer = setTimeout(() => {
                    if (isTouch && targetV) { action = 'rate'; targetV.playbackRate = Math.max(0.1, initRate + CFG.rateBase - 1.0); showMsg(`${targetV.playbackRate.toFixed(1)}x`, targetV); hideUI(targetV); }
                }, CFG.longPress);
            }
        }
    };

    const onMove = (e) => {
        if (!targetV || !targetV.gtState) return;
        const vState = targetV.gtState;

        if (!isTouch) return;

        const isFS = isFullscreenActive(targetP);

        if (action === 'pinch' || action === 'rate' || action === 'seek') {
            if (e.cancelable) e.preventDefault();
            e.stopPropagation(); e.stopImmediatePropagation();
        }

        if (action === 'pinch' && e.touches.length === 2) {
            const p = getPinchData(e.touches);
            vState.scale = Math.max(1.0, Math.min(CFG.maxScale, initScale * (p.dist/initPinchDist)));
            if (vState.scale > 1.0) { const ds = vState.scale/initScale; vState.panX = (p.cx-initCenterX)+initPanX*ds+originDx*(1-ds); vState.panY = (p.cy-initCenterY)+initPanY*ds+originDy*(1-ds); }
            else { vState.panX = 0; vState.panY = 0; } applyTransform(targetV);
            return;
        }

        if (action === 'pinch' || action === 'pinch_wait' || action === 'ignore') return;

        const dx = e.touches[0].clientX - startX, dy = startY - e.touches[0].clientY;

        if (action === 'rate') { targetV.playbackRate = Math.max(0.1, Math.min(4.0, initRate + (CFG.rateBase + dx * CFG.senseRate) - 1.0)); showMsg(`${targetV.playbackRate.toFixed(1)}x`, targetV); return; }

        if (!action) {
            if (Math.abs(dx) > CFG.minDist || Math.abs(dy) > CFG.minDist) {
                clearTimeout(lpTimer);

                if (!isFS) {
                    action = 'scroll_pass';
                    isTouch = false;
                    return;
                }

                if (Math.abs(dx) > Math.abs(dy)) {
                    action = 'seek';
                    if (e.cancelable) e.preventDefault();
                    hideUI(targetV);
                } else {
                    action = 'ignore';
                }
            } else {
                return;
            }
        }

        const now = Date.now();
        const canUpdateVisual = (now - lastThrottledTime > 32);

        if (action === 'seek') {
            if (e.cancelable) e.preventDefault();
            virtualTime = Math.max(0, Math.min(targetV.duration || 0, initTime + dx * CFG.senseX));
            if (canUpdateVisual) {
                const formatTime = (t) => {
                    let h = Math.floor(t / 3600).toString().padStart(2, '0');
                    let m = Math.floor((t % 3600) / 60).toString().padStart(2, '0');
                    let s = Math.floor(t % 60).toString().padStart(2, '0');
                    return h !== '00' ? `${h}:${m}:${s}` : `${m}:${s}`;
                };
                showMsg(`${formatTime(virtualTime)}`, targetV);
                lastThrottledTime = now;
            }
        }
    };

    const onEnd = (e) => {
        const now = Date.now();
        const isEx = isExcludedZone(e);

        if (now < blockGestureUntil && !isEx) {
            e.stopPropagation(); e.stopImmediatePropagation();
            if (e.cancelable) e.preventDefault();
            isTouch = false; return;
        }

        if (!isTouch) return;
        if (e.touches.length > 0) { if (action === 'pinch') action = 'pinch_wait'; return; }

        if (action === 'seek' && virtualTime !== null && targetV) {
            targetV.currentTime = virtualTime;
            virtualTime = null;
        }

        clearTimeout(lpTimer);

        const endVideo = targetV;
        const endRoot = targetP;
        const isFS = isFullscreenActive(endRoot);

        if (action === 'rate' && targetV) { targetV.playbackRate = initRate; showMsg('', targetV); if (isFS) wakeUpUI(targetP, targetV); }
        if ((action === 'pinch' || action === 'pinch_wait' || action === 'pan') && targetV) { if (isFS) wakeUpUI(targetP, targetV); }

        if (!action || action === 'ignore' || action === 'scroll_pass') { if (!activeSeekSide && isFS) wakeUpUI(targetP, targetV); }
        else { blockGestureUntil = now + TAP_PROTECT_DURATION; }

        isTouch = false; targetV = null; action = null;
    };

    const pOpt = { passive: false, capture: true };
    document.addEventListener('touchstart', onStart, pOpt);
    document.addEventListener('touchmove', onMove, pOpt);
    document.addEventListener('touchend', onEnd, pOpt);
    document.addEventListener('touchcancel', onEnd, pOpt);

    ['pointerdown', 'pointerup', 'pointercancel', 'click', 'dblclick'].forEach(evt => {
        document.addEventListener(evt, (e) => {
            const isEx = isExcludedZone(e);
            if (evt === 'dblclick' && !isEx && identify(e)) {
                e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); return;
            }
            if (Date.now() < blockGestureUntil) {
                if (!isEx) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
            } else if (evt === 'click') {
                if (activeSeekSide) { e.stopPropagation(); e.stopImmediatePropagation(); e.preventDefault(); }
            }
        }, { capture: true, passive: false });
    });

    // ★ 핵심: fullscreenchange에서 UI 레이어를 강제로 fullscreen 컨테이너로 이동
    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
        document.addEventListener(evt, () => {
            let fsEl = getFS();
            if (!fsEl) {
                document.querySelectorAll('.gt-fullscreen-active').forEach(el => el.classList.remove('gt-fullscreen-active'));
                unlockOrientation();

                document.querySelectorAll('video').forEach(v => {
                    if (v.parentNode && v.parentNode.classList.contains('gt-video-wrapper')) {
                        v.gtRoot = v.parentNode;
                    }
                    restoreVideoStyle(v);
                    clearAllBlockingStyles(v);
                });

                setTimeout(() => {
                    document.querySelectorAll('video').forEach(v => {
                        clearAllBlockingStyles(v);
                        if (v.gtUI && v.gtRoot) {
                            // 원래 root로 UI 복귀
                            const origRoot = getValidPlayerRoot(v);
                            if (origRoot && origRoot !== document.body && origRoot !== document.documentElement) {
                                moveUIToRoot(v, origRoot);
                            }
                            applyFixedScale(v.gtRoot, v, v.gtUI);
                        }
                    });
                }, 200);
            } else {
                // 전체화면 진입
                setTimeout(() => {
                    let v = targetV;
                    if (!v || !v.isConnected) {
                        v = fsEl.tagName === 'VIDEO' ? fsEl : findDeepVid(fsEl);
                    }
                    if (!v) v = document.querySelector('video');
                    if (!v) return;

                    initVideoCore(v);
                    backupVideoStyle(v);

                    let newRoot = fsEl.tagName === 'VIDEO' ? fsEl.parentNode : fsEl;
                    if (!newRoot) newRoot = fsEl;

                    newRoot.classList.add('gt-fullscreen-active');

                    if (v.gtUI) {
                        moveUIToRoot(v, newRoot);
                    } else {
                        v.gtRoot = newRoot;
                        checkAndBuildUI(newRoot, v);
                    }

                    updateTouchAction(v, v.gtRoot || newRoot);
                    updateOverscrollBehavior(v, v.gtRoot || newRoot);
                    applyFixedScale(v.gtRoot || newRoot, v, v.gtUI);
                    wakeUpUI(v.gtRoot || newRoot, v);
                    lockOrientation(getVideoOrientationDir(v));
                }, 200);
            }
        });
    });
})();
