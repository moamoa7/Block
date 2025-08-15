// ==UserScript==
// @name         VideoSpeed_Control (Truly Final Stable Version)
// @namespace    https://com/
// @version      24.08-Final-Stable
// @description  🎞️ 드래그 버그를 수정한 최종 안정화 버전입니다. 모든 기능이 포함되어 있습니다.
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
    const SEEN_MEDIA = new WeakSet();
    const activeMediaMap = new Map();
    let uiVisible = false;
    safeExec(() => { if (window.console && console.clear) { const o = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection');
    (function hackAttachShadow() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const o = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function () { const a = arguments; if (a[0] && a[0].mode) a[0].mode = 'open'; const r = o.apply(this, a); window._shadowDomList_.push(r); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: r } })); return r; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    // --- 비디오 필터 모듈 ---
    const filterManager = (() => {
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        const DESKTOP_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen1', KERNEL_MATRIX: '1 -1 1 -1 -2 -1 1 -1 1', BLUR_STD_DEVIATION: '0.5' };
        const MOBILE_SETTINGS = { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen6', KERNEL_MATRIX: '-1 -1.25 -1 -1.25 11 -1.25 -1 -1.25 -1', BLUR_STD_DEVIATION: '0.5' };
        const settings = isMobile ? MOBILE_SETTINGS : DESKTOP_SETTINGS;
        let isEnabled = true;

        function createSvgFiltersAndStyle() {
            if (document.getElementById('video-enhancer-svg-filters')) return;
            const svgNs = 'http://www.w3.org/2000/svg';
            const svgFilters = document.createElementNS(svgNs, 'svg');
            svgFilters.id = 'video-enhancer-svg-filters'; svgFilters.style.display = 'none';
            const softeningFilter = document.createElementNS(svgNs, 'filter'); softeningFilter.id = 'SofteningFilter'; const gaussianBlur = document.createElementNS(svgNs, 'feGaussianBlur'); gaussianBlur.setAttribute('stdDeviation', settings.BLUR_STD_DEVIATION); softeningFilter.appendChild(gaussianBlur); svgFilters.appendChild(softeningFilter);
            const sharpenFilter = document.createElementNS(svgNs, 'filter'); sharpenFilter.id = settings.SHARPEN_ID; const convolveMatrix = document.createElementNS(svgNs, 'feConvolveMatrix'); Object.entries({ order: '3 3', preserveAlpha: 'true', kernelMatrix: settings.KERNEL_MATRIX, mode: 'multiply' }).forEach(([k, v]) => convolveMatrix.setAttribute(k, v)); sharpenFilter.appendChild(convolveMatrix); svgFilters.appendChild(sharpenFilter);
            const gammaFilter = document.createElementNS(svgNs, 'filter'); gammaFilter.id = 'gamma-filter'; const feComponentTransfer = document.createElementNS(svgNs, 'feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => { const feFunc = document.createElementNS(svgNs, `feFunc${ch}`); feFunc.setAttribute('type', 'gamma'); feFunc.setAttribute('exponent', (1 / settings.GAMMA_VALUE).toString()); feComponentTransfer.appendChild(feFunc); }); gammaFilter.appendChild(feComponentTransfer); svgFilters.appendChild(gammaFilter);
            (document.body || document.documentElement).appendChild(svgFilters);
            const styleElement = document.createElement('style'); styleElement.id = 'video-enhancer-styles';
            styleElement.textContent = `html.video-filter-active video, html.video-filter-active iframe { filter: url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) !important; }`;
            (document.head || document.documentElement).appendChild(styleElement);
        }
        function updateState() { document.documentElement.classList.toggle('video-filter-active', isEnabled); const button = uiManager.getShadowRoot()?.getElementById('vm-filter-toggle-btn'); if (button) button.textContent = isEnabled ? '🌞' : '🌚'; }
        return {
            init: () => { safeExec(() => { createSvgFiltersAndStyle(); updateState(); }, 'filterManager.init'); },
            toggle: () => { isEnabled = !isEnabled; updateState(); }
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
                #vm-speed-slider-container {
                    position: fixed; top: 50%; right: 0;
                    transform: translateY(-50%);
                    background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100;
                    display: none; flex-direction: column; align-items: center; width: 50px;
                    opacity: 0.3; transition: opacity .2s, width .3s, background .2s;
                }
                #vm-speed-slider-container:hover { opacity: 1; }
                #vm-speed-slider-container.minimized { width: 30px; }
                #vm-speed-slider, #vm-speed-value, #vm-speed-slider-container .vm-btn { opacity: 1; transform: scaleY(1); transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
                #vm-speed-slider-container.minimized > :not(.toggle) { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; font-size:12px; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 120px; margin: 4px 0; accent-color: #e74c3c; }
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
        let container, sliderEl, valueEl, inited = false, isMinimized = true;
        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot();
            if (!shadowRoot) return;
            container = document.createElement('div'); container.id = 'vm-speed-slider-container';
            const filterToggleButton = document.createElement('button'); filterToggleButton.id = 'vm-filter-toggle-btn'; filterToggleButton.className = 'vm-btn'; filterToggleButton.title = 'Toggle Video Filter'; filterToggleButton.textContent = '🌞'; filterToggleButton.addEventListener('click', () => filterManager.toggle());
            const resetButton = document.createElement('button'); resetButton.className = 'vm-btn reset'; resetButton.title = 'Reset speed to 1x'; resetButton.textContent = '1x';
            sliderEl = document.createElement('input'); sliderEl.type = 'range'; sliderEl.min = '0.2'; sliderEl.max = '4.0'; sliderEl.step = '0.2'; sliderEl.value = '1.0'; sliderEl.id = 'vm-speed-slider';
            valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            const toggleButton = document.createElement('button'); toggleButton.className = 'vm-btn toggle'; toggleButton.title = 'Toggle Speed Controller';
            container.append(filterToggleButton, resetButton, sliderEl, valueEl, toggleButton);
            shadowRoot.appendChild(container);

            const applySpeed = (speed) => { for (const media of activeMediaMap.keys()) { if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); } };
            const updateValueText = (speed) => valueEl && (valueEl.textContent = `x${speed.toFixed(1)}`);
            function updateAppearance() {
                if (!container) return;
                container.classList.toggle('minimized', isMinimized);
                container.querySelector('.toggle').textContent = isMinimized ? '🔻' : '🔺';
            }
            resetButton.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); });
            sliderEl.addEventListener('input', (e) => { const speed = parseFloat(e.target.value); applySpeed(speed); updateValueText(speed); });
            toggleButton.addEventListener('click', () => { isMinimized = !isMinimized; updateAppearance(); });
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

    // --- ✨ 탐색 바 (전체 코드로 복원) ---
    const dragBar = (() => {
        let display, inited = false;
        let state = { dragging: false, startX: 0, startY: 0, accX: 0 };
        let lastDelta = 0;
        let rafScheduled = false;

        function onStart(e) {
            safeExec(() => {
                const target = e.target;
                let videoElement = (target?.tagName === 'VIDEO') ? target : target?.parentElement?.querySelector('video');
                if (!videoElement || videoElement.paused) return;
                // ✨ 버그의 핵심: speedSlider.isMinimized() 호출이 여기서 이뤄져야 합니다.
                if (speedSlider.isMinimized() || (e.composedPath && e.composedPath().some(el => el.id === 'vm-speed-slider-container'))) return;
                if (e.type === 'mousedown' && e.button !== 0) return;

                const pos = e.touches ? e.touches[0] : e;
                Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, accX: 0 });
                const options = { passive: false, capture: true };
                document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options);
                document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options);
            }, 'dragBar.onStart');
        }

        function onMove(e) {
            if (!state.dragging) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            safeExec(() => {
                const pos = e.touches ? e.touches[0] : e;
                state.accX += pos.clientX - state.startX;
                state.startX = pos.clientX;
                if (!rafScheduled) {
                    rafScheduled = true;
                    window.requestAnimationFrame(() => {
                        showDisplay(state.accX);
                        rafScheduled = false;
                    });
                }
            }, 'dragBar.onMove');
        }

        function onEnd() {
            if (!state.dragging) return;
            safeExec(() => {
                applySeek();
                Object.assign(state, { dragging: false, accX: 0 });
                hideDisplay();
                document.removeEventListener('mousemove', onMove, true);
                document.removeEventListener('touchmove', onMove, true);
                document.removeEventListener('mouseup', onEnd, true);
                document.removeEventListener('touchend', onEnd, true);
            }, 'dragBar.onEnd');
        }

        function applySeek() {
            const deltaSec = Math.round(state.accX / 2);
            if (!deltaSec) return;
            for (const m of activeMediaMap.keys()) {
                if (isFinite(m.duration)) m.currentTime = Math.min(m.duration, Math.max(0, m.currentTime + deltaSec));
            }
        }

        function init() {
            if (inited) return;
            document.addEventListener('mousedown', onStart, { capture: true });
            document.addEventListener('touchstart', onStart, { passive: true, capture: true });
            inited = true;
        }

        const showDisplay = (pixels) => {
            const s = Math.round(pixels / 2);
            if (s === lastDelta) return; lastDelta = s;
            if (!display) {
                const shadowRoot = uiManager.getShadowRoot();
                display = document.createElement('div');
                display.id = 'vm-time-display';
                shadowRoot.appendChild(display);
            }
            const sign = s < 0 ? '-' : '+';
            const a = Math.abs(s);
            const mm = Math.floor(a / 60).toString().padStart(2, '0');
            const ss = (a % 60).toString().padStart(2, '0');
            display.textContent = `${sign}${mm}분 ${ss}초`;
            display.style.display = 'block';
            display.style.opacity = '1';
        };

        const hideDisplay = () => {
            if (display) {
                display.style.opacity = '0';
                setTimeout(() => { if (display) display.style.display = 'none'; }, 300);
            }
        };
        return { init: () => safeExec(init, 'dragBar.init') };
    })();

    // --- ✨ 나머지 모듈 (전체 코드로 복원) ---
    const mediaSessionManager = (() => { const getSeekTime = (rate) => Math.min(Math.max(1, 5 * rate), 15); const setSession = (media) => { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = new window.MediaMetadata({ title: document.title, artist: location.hostname, album: 'VideoSpeed_Control' }); navigator.mediaSession.setActionHandler('play', () => media.play()); navigator.mediaSession.setActionHandler('pause', () => media.pause()); navigator.mediaSession.setActionHandler('seekbackward', () => { media.currentTime -= getSeekTime(media.playbackRate); }); navigator.mediaSession.setActionHandler('seekforward', () => { media.currentTime += getSeekTime(media.playbackRate); }); if ('seekto' in navigator.mediaSession) { navigator.mediaSession.setActionHandler('seekto', (details) => { if (details.fastSeek && 'fastSeek' in media) { media.fastSeek(details.seekTime); return; } media.currentTime = details.seekTime; }); } }, 'mediaSession.set'); }; const clearSession = () => { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(h => { try { navigator.mediaSession.setActionHandler(h, null); } catch { } }); }, 'mediaSession.clear'); }; return { setSession, clearSession }; })();
    function findAllMedia(doc = document) { const m = []; safeExec(() => { doc.querySelectorAll('video, audio').forEach(e => m.push(e)); (window._shadowDomList_ || []).forEach(s => s.querySelectorAll('video, audio').forEach(e => m.push(e))); if (doc === document) { document.querySelectorAll('iframe').forEach(i => { try { if (i.contentDocument) m.push(...findAllMedia(i.contentDocument)); } catch { } }); } }); return [...new Set(m)]; }
    const mediaEventHandlers = { play: (m) => { scanTask(true); mediaSessionManager.setSession(m); }, pause: (m) => { scanTask(true); mediaSessionManager.clearSession(m); }, ended: (m) => { scanTask(true); mediaSessionManager.clearSession(m); }, };
    function initMedia(m) { if (!m || SEEN_MEDIA.has(m)) return; SEEN_MEDIA.add(m); Object.entries(mediaEventHandlers).forEach(([e, h]) => m.addEventListener(e, () => h(m))); }
    const scanTask = (isUiUpdateOnly = false) => { const allMedia = findAllMedia(); if (!isUiUpdateOnly) { allMedia.forEach(initMedia); } activeMediaMap.clear(); allMedia.forEach(m => { if (m.isConnected) { activeMediaMap.set(m, {}); } }); const shouldBeVisible = activeMediaMap.size > 0; if (uiVisible !== shouldBeVisible) { uiVisible = shouldBeVisible; uiVisible ? speedSlider.show() : speedSlider.hide(); } };
    const debouncedScanTask = debounce(scanTask, 350);
    function scanAddedNodes(nodes) { const m = []; nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) m.push(n); n.querySelectorAll?.('video, audio').forEach(e => m.push(e)); }); if (m.length > 0) { m.forEach(initMedia); scanTask(true); } }

    // --- 초기화 ---
    function initialize() {
        console.log('🎉 VideoSpeed_Control (v24.08-Final-Stable) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        filterManager.init();
        const observer = new MutationObserver(mutations => { const a = mutations.flatMap(m => (m.type === 'childList' ? [...m.addedNodes] : [])); if (a.length > 0) { if ('requestIdleCallback' in window) { window.requestIdleCallback(() => scanAddedNodes(a), { timeout: 1000 }); } else { scanAddedNodes(a); } } else { debouncedScanTask(); } });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function () { originalPushState.apply(this, arguments); scanTask(); };
        window.addEventListener('popstate', () => scanTask());
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));
        scanTask();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') { initialize(); } else { window.addEventListener('DOMContentLoaded', initialize, { once: true }); }

})();
