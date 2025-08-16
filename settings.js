// ==UserScript==
// @name         VideoSpeed_Control (MediaSession Optimized)
// @namespace    https://com/
// @version      27.03-MediaSession-Tweak
// @description  🎞️ MediaSession의 탐색 시간을 영상 길이에 비례하여 동적으로 조절합니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- 설정 및 유틸리티 ---
    const FeatureFlags = { debug: false };
    const EXCLUSION_KEYWORDS = ['login', 'signin', 'auth', 'captcha', 'signup'];
    const SPECIFIC_EXCLUSIONS = [{ domain: 'avsee.ru', path: '/bbs/login.php' }];
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (FeatureFlags.debug) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; if (SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path))) return true; return false; }
    if (isExcluded()) { console.log(`[VideoSpeed] Skipped on excluded page: ${location.href}`); return; }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    const activeMediaMap = new Map();
    let uiVisible = false;
    safeExec(() => { if (window.console && console.clear) { const o = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection');
    (function hackAttachShadow() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const o = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function () { const a = arguments; if (a[0] && a[0].mode) a[0].mode = 'open'; const r = o.apply(this, a); window._shadowDomList_.push(r); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: r } })); return r; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    // --- 비디오 필터 모듈 ---
    const filterManager = (() => {
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        const DESKTOP_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen1', KERNEL_MATRIX: '1 -1 1 -1 -2 -1 1 -1 1', BLUR_STD_DEVIATION: '0.45', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 };
        const MOBILE_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen5', KERNEL_MATRIX: '1 -1 1 -1 -.5 -1 1 -1 1', BLUR_STD_DEVIATION: '0.45', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 };
        const settings = isMobile ? MOBILE_SETTINGS : DESKTOP_SETTINGS;
        let isEnabled = true;

        function createSvgFiltersAndStyle() {
            if (document.getElementById('video-enhancer-svg-filters')) return;
            const svgNs = 'http://www.w3.org/2000/svg'; const svgFilters = document.createElementNS(svgNs, 'svg'); svgFilters.id = 'video-enhancer-svg-filters'; svgFilters.style.display = 'none';
            const softeningFilter = document.createElementNS(svgNs, 'filter'); softeningFilter.id = 'SofteningFilter'; const gaussianBlur = document.createElementNS(svgNs, 'feGaussianBlur'); gaussianBlur.setAttribute('stdDeviation', settings.BLUR_STD_DEVIATION); softeningFilter.appendChild(gaussianBlur); svgFilters.appendChild(softeningFilter);
            const sharpenFilter = document.createElementNS(svgNs, 'filter'); sharpenFilter.id = settings.SHARPEN_ID; const convolveMatrix = document.createElementNS(svgNs, 'feConvolveMatrix'); Object.entries({ order: '3 3', preserveAlpha: 'true', kernelMatrix: settings.KERNEL_MATRIX, mode: 'multiply' }).forEach(([k, v]) => convolveMatrix.setAttribute(k, v)); sharpenFilter.appendChild(convolveMatrix); svgFilters.appendChild(sharpenFilter);
            const gammaFilter = document.createElementNS(svgNs, 'filter'); gammaFilter.id = 'gamma-filter'; const feComponentTransfer = document.createElementNS(svgNs, 'feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => { const feFunc = document.createElementNS(svgNs, `feFunc${ch}`); feFunc.setAttribute('type', 'gamma'); feFunc.setAttribute('exponent', (1 / settings.GAMMA_VALUE).toString()); feComponentTransfer.appendChild(feFunc); }); gammaFilter.appendChild(feComponentTransfer); svgFilters.appendChild(gammaFilter);
            const linearAdjustFilter = document.createElementNS(svgNs, 'filter'); linearAdjustFilter.id = 'linear-adjust-filter'; const linearComponentTransfer = document.createElementNS(svgNs, 'feComponentTransfer'); const shadowIntercept = settings.SHADOWS_VALUE / 200; const highlightSlope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => { const feFunc = document.createElementNS(svgNs, `feFunc${ch}`); feFunc.setAttribute('type', 'linear'); feFunc.setAttribute('slope', highlightSlope.toString()); feFunc.setAttribute('intercept', shadowIntercept.toString()); linearComponentTransfer.appendChild(feFunc); }); linearAdjustFilter.appendChild(linearComponentTransfer); svgFilters.appendChild(linearAdjustFilter);
            (document.body || document.documentElement).appendChild(svgFilters);
            const styleElement = document.createElement('style'); styleElement.id = 'video-enhancer-styles';
            styleElement.textContent = `
                video.video-filter-active,
                iframe.video-filter-active {
                    filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important;
                }
                .vsc-gpu-accelerated {
                    transform: translateZ(0);
                    will-change: transform;
                }
            `;
            (document.head || document.documentElement).appendChild(styleElement);
        }
        function updateState() {
            document.documentElement.classList.toggle('video-filter-main-switch-on', isEnabled);
            const button = uiManager.getShadowRoot()?.getElementById('vm-filter-toggle-btn');
            if (button) button.textContent = isEnabled ? '🌞' : '🌚';
            scanTask(true);
        }
        return {
            init: () => { safeExec(() => { createSvgFiltersAndStyle(); updateState(); }, 'filterManager.init'); },
            toggle: () => { isEnabled = !isEnabled; updateState(); },
            isEnabled: () => isEnabled,
        };
    })();

    // --- UI 관리 ---
    const uiManager = (() => {
        let host, shadowRoot;
        function init() {
            if (host) return;
            host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2147483647' });
            shadowRoot = host.attachShadow({ mode: 'open' });
            const style = document.createElement('style');
            style.textContent = `
                :host { pointer-events: none; } * { pointer-events: auto; }
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity 0.5s ease, width 0.3s, background 0.2s; }
                #vm-speed-slider-container.touched { opacity: 1; }
                @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } }
                #vm-speed-slider-container.minimized { width: 30px; }
                #vm-speed-slider, #vm-speed-value, #vm-speed-slider-container .vm-btn { opacity: 1; transform: scaleY(1); transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
                #vm-speed-slider-container.minimized > :not(.toggle) { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; font-size:12px; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; }
                #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); }
                #vm-filter-toggle-btn { font-size: 16px; padding: 2px 4px; }
                #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }
            `;
            shadowRoot.appendChild(style);
            (document.body || document.documentElement).appendChild(host);
        }
        return { init: () => safeExec(init, 'uiManager.init'), getShadowRoot: () => (shadowRoot || (init(), shadowRoot)), moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } };
    })();

    const speedSlider = (() => {
        let container, inited = false, isMinimized = true;
        let fadeOutTimer;
        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot();
            if (!shadowRoot) return;
            container = document.createElement('div'); container.id = 'vm-speed-slider-container';
            const filterToggleButton = document.createElement('button'); filterToggleButton.id = 'vm-filter-toggle-btn'; filterToggleButton.className = 'vm-btn'; filterToggleButton.title = 'Toggle Video Filter'; filterToggleButton.textContent = '🌞'; filterToggleButton.addEventListener('click', () => filterManager.toggle());
            const resetButton = document.createElement('button'); resetButton.className = 'vm-btn reset'; resetButton.title = 'Reset speed to 1x'; resetButton.textContent = '1x';
            const sliderEl = document.createElement('input'); sliderEl.type = 'range'; sliderEl.min = '0.2'; sliderEl.max = '4.0'; sliderEl.step = '0.2'; sliderEl.value = '1.0'; sliderEl.id = 'vm-speed-slider';
            const valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            const toggleButton = document.createElement('button'); toggleButton.className = 'vm-btn toggle'; toggleButton.title = 'Toggle Speed Controller';
            container.append(filterToggleButton, resetButton, sliderEl, valueEl, toggleButton);
            shadowRoot.appendChild(container);
            const applySpeed = (speed) => { for (const media of activeMediaMap.keys()) { if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); } };
            const updateValueText = (speed) => valueEl && (valueEl.textContent = `x${speed.toFixed(1)}`);
            function updateAppearance() { if (!container) return; container.classList.toggle('minimized', isMinimized); container.querySelector('.toggle').textContent = isMinimized ? '🔻' : '🔺'; }
            resetButton.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); });
            const debouncedApplySpeed = debounce(applySpeed, 100);
            sliderEl.addEventListener('input', (e) => { const speed = parseFloat(e.target.value); updateValueText(speed); debouncedApplySpeed(speed); container.classList.add('touched'); clearTimeout(fadeOutTimer); });
            toggleButton.addEventListener('click', () => { isMinimized = !isMinimized; updateAppearance(); });
            const startInteraction = () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); };
            const endInteractionSoon = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => { container.classList.remove('touched'); }, 3000); };
            const onDocumentTouchEnd = () => { endInteractionSoon(); document.removeEventListener('touchend', onDocumentTouchEnd); document.removeEventListener('touchcancel', onDocumentTouchEnd); };
            container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onDocumentTouchEnd); document.addEventListener('touchcancel', onDocumentTouchEnd); }, { passive: true });
            sliderEl.addEventListener('change', endInteractionSoon, { passive: true });
            sliderEl.addEventListener('blur', endInteractionSoon, { passive: true });
            const stopEventPropagation = e => e.stopPropagation();
            sliderEl.addEventListener('touchstart', stopEventPropagation, { passive: true });
            sliderEl.addEventListener('touchmove', stopEventPropagation, { passive: true });
            inited = true;
            updateAppearance();
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'),
            show: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; },
            hide: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; },
            isMinimized: () => isMinimized
        };
    })();

    // --- 미디어 스캔 및 관리 ---
    const mediaListenerMap = new WeakMap();
    let intersectionObserver = null;

    const dragBar = (() => {
        let display, inited = false; let state = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false;
        function onStart(e) { safeExec(() => { if (e.touches && e.touches.length > 1) return; let videoElement = (e.target?.tagName === 'VIDEO') ? e.target : e.target?.parentElement?.querySelector('video'); if (!videoElement || videoElement.paused || speedSlider.isMinimized() || (e.composedPath && e.composedPath().some(el => el.id === 'vm-speed-slider-container')) || (e.type === 'mousedown' && e.button !== 0)) return; const pos = e.touches ? e.touches[0] : e; Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'dragBar.onStart'); }
        function onMove(e) { if (!state.dragging) return; if (e.touches && e.touches.length > 1) { onEnd(); return; } const pos = e.touches ? e.touches[0] : e; state.currentX = pos.clientX; state.currentY = pos.clientY; if (!state.directionConfirmed) { const deltaX = Math.abs(state.currentX - state.startX); const deltaY = Math.abs(state.currentY - state.startY); if (deltaX > deltaY + 5) { state.directionConfirmed = true; } else if (deltaY > deltaX + 5) { onEnd(); return; } } if (state.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); safeExec(() => { const movementX = state.currentX - state.startX; state.accX += movementX; state.startX = state.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (state.dragging) { showDisplay(state.accX); } rafScheduled = false; }); } }, 'dragBar.onMove'); } }
        function onEnd() { if (!state.dragging) return; safeExec(() => { if (state.directionConfirmed) applySeek(); Object.assign(state, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); }, 'dragBar.onEnd'); }
        function applySeek() { const deltaSec = Math.round(state.accX / 2); if (!deltaSec) return; for (const m of activeMediaMap.keys()) { if (isFinite(m.duration)) m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec)); } }
        function init() { if (inited) return; document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }
        const showDisplay = (pixels) => { const s = Math.round(pixels / 2); if (s === lastDelta) return; lastDelta = s; if (!display) { const shadowRoot = uiManager.getShadowRoot(); display = document.createElement('div'); display.id = 'vm-time-display'; shadowRoot.appendChild(display); } const sign = s < 0 ? '-' : '+'; const a = Math.abs(s); const mm = Math.floor(a / 60).toString().padStart(2, '0'); const ss = (a % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mm}분 ${ss}초`; display.style.display = 'block'; display.style.opacity = '1'; };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } };
        return { init: () => safeExec(init, 'dragBar.init') };
    })();

    // --- MediaSession 모듈 (✨ 탐색 시간 동적 계산 로직 추가) ---
    const mediaSessionManager = (() => {
        const getSeekTime = (media) => {
            if (!media || !isFinite(media.duration)) return 10; // 기본값 10초
            // 영상 길이의 5%를 점프 시간으로 하되, 최대 15초를 넘지 않도록 함
            return Math.min(Math.floor(media.duration * 0.05), 15);
        };
        const setSession = (media) => {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                navigator.mediaSession.metadata = new window.MediaMetadata({ title: document.title, artist: location.hostname, album: 'VideoSpeed_Control' });
                navigator.mediaSession.setActionHandler('play', () => media.play());
                navigator.mediaSession.setActionHandler('pause', () => media.pause());
                navigator.mediaSession.setActionHandler('seekbackward', () => { media.currentTime -= getSeekTime(media); });
                navigator.mediaSession.setActionHandler('seekforward', () => { media.currentTime += getSeekTime(media); });
                if ('seekto' in navigator.mediaSession) {
                    navigator.mediaSession.setActionHandler('seekto', (details) => {
                        if (details.fastSeek && 'fastSeek' in media) { media.fastSeek(details.seekTime); return; }
                        media.currentTime = details.seekTime;
                    });
                }
            }, 'mediaSession.set');
        };
        const clearSession = () => { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(h => { try { navigator.mediaSession.setActionHandler(h, null); } catch { } }); }, 'mediaSession.clear'); };
        return { setSession, clearSession };
    })();

    function findAllMedia(doc = document) { const media = []; safeExec(() => { doc.querySelectorAll('video, audio').forEach(m => media.push(m)); (window._shadowDomList_ || []).forEach(sr => sr.querySelectorAll('video, audio').forEach(m => media.push(m))); if (doc === document) { document.querySelectorAll('iframe').forEach(iframe => { try { if (iframe.contentDocument) media.push(...findAllMedia(iframe.contentDocument)); } catch { } }); } }); return [...new Set(media)]; }

    function updateVideoFilterState(video) {
        const isPlaying = !video.paused && !video.ended;
        const isVisible = video.dataset.isVisible === 'true';
        const mainSwitchOn = filterManager.isEnabled();
        const shouldHaveFilter = isPlaying && isVisible && mainSwitchOn;
        video.classList.toggle('video-filter-active', shouldHaveFilter);
    }
    const mediaEventHandlers = {
        play: (media) => { updateVideoFilterState(media); scanTask(true); mediaSessionManager.setSession(media); },
        pause: (media) => { updateVideoFilterState(media); scanTask(true); mediaSessionManager.clearSession(media); },
        ended: (media) => { updateVideoFilterState(media); scanTask(true); mediaSessionManager.clearSession(media); },
    };
    function initMedia(media) {
        if (!media || mediaListenerMap.has(media)) return;
        const listeners = {};
        Object.entries(mediaEventHandlers).forEach(([evt, handler]) => {
            const listener = () => handler(media);
            listeners[evt] = listener;
            media.addEventListener(evt, listener);
        });
        mediaListenerMap.set(media, listeners);
        if (intersectionObserver && media.tagName === 'VIDEO') {
            intersectionObserver.observe(media);
        }
    }
    function cleanupMedia(media) {
        if (!mediaListenerMap.has(media)) return;
        const listeners = mediaListenerMap.get(media);
        Object.entries(listeners).forEach(([evt, listener]) => { media.removeEventListener(evt, listener); });
        mediaListenerMap.delete(media);
        if (intersectionObserver && media.tagName === 'VIDEO') {
            intersectionObserver.unobserve(media);
        }
        if (FeatureFlags.debug) console.log('[VideoSpeed] Event listeners cleaned up for removed media element.');
    }
    const scanTask = (isUiUpdateOnly = false) => {
        const allMedia = findAllMedia();
        if (!isUiUpdateOnly) {
            allMedia.forEach(initMedia);
        }
        activeMediaMap.clear();
        allMedia.forEach(m => {
            if (m.isConnected) { activeMediaMap.set(m, {}); }
        });
        allMedia.forEach(video => {
            if (video.tagName === 'VIDEO') {
                const isPlaying = !video.paused && !video.ended;
                video.classList.toggle('vsc-gpu-accelerated', isPlaying);
                updateVideoFilterState(video);
            }
        });
        const shouldBeVisible = activeMediaMap.size > 0;
        if (uiVisible !== shouldBeVisible) {
            uiVisible = shouldBeVisible;
            uiVisible ? speedSlider.show() : speedSlider.hide();
        }
    };
    const debouncedScanTask = debounce(scanTask, 350);
    function scanAddedNodes(nodes) { const mediaElements = []; nodes.forEach(node => { if (node.nodeType !== 1) return; if (node.matches?.('video, audio')) mediaElements.push(node); node.querySelectorAll?.('video, audio').forEach(m => mediaElements.push(m)); }); if (mediaElements.length > 0) { mediaElements.forEach(initMedia); scanTask(true); } }
    function scanRemovedNodes(nodes) { nodes.forEach(node => { if (node.nodeType !== 1) return; if (node.matches?.('video, audio')) { cleanupMedia(node); } node.querySelectorAll?.('video, audio').forEach(cleanupMedia); }); }

    // --- 초기화 ---
    function initialize() {
        console.log('🎉 VideoSpeed_Control (MediaSession Optimized) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        filterManager.init();

        intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                entry.target.dataset.isVisible = entry.isIntersecting;
                updateVideoFilterState(entry.target);
            });
        }, { threshold: 0.1 });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active'));
            } else {
                scanTask(true);
            }
        });

        const observer = new MutationObserver(mutations => {
            const addedNodes = [], removedNodes = [];
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    addedNodes.push(...mutation.addedNodes);
                    removedNodes.push(...mutation.removedNodes);
                }
            }
            if (removedNodes.length > 0) scanRemovedNodes(removedNodes);
            if (addedNodes.length > 0) scanAddedNodes(addedNodes);
            if(addedNodes.length === 0 && removedNodes.length === 0) debouncedScanTask();
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function () { originalPushState.apply(this, arguments); scanTask(); };
        window.addEventListener('popstate', () => scanTask());
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));

        window.addEventListener('beforeunload', () => {
            if (observer) observer.disconnect();
            if (intersectionObserver) intersectionObserver.disconnect();
            if (FeatureFlags.debug) console.log('[VideoSpeed] Cleaned up Observers.');
        });

        scanTask();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') { initialize(); } else { window.addEventListener('DOMContentLoaded', initialize, { once: true }); }

})();
