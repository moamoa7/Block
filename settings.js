// ==UserScript==
// @name         VideoSpeed_Control (Professional)
// @namespace    https://com/
// @version      27.08-Professional
// @description  🎞️ 성능, 메모리 관리, 안정성이 대폭 향상된 최종 버전입니다. 견고한 메타데이터, 지능형 스캔 등 모든 고급 기능을 지원합니다.
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration and Constants ---
    const CONFIG = {
        DEBUG: false,
        DEBOUNCE_DELAY: 350,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05, // 5% of video duration
        SEEK_TIME_MAX_SEC: 15,   // max 15 seconds
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen2', KERNEL_MATRIX: '1 -1 1 -1 -1 -1 1 -1 1', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.15, SHARPEN_ID: 'Sharpen1', KERNEL_MATRIX: '1 -1 1 -1 -2 -1 1 -1 1', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 105 },

        // [UPGRADE] Robust site-specific rules with fallback selectors.
        SITE_METADATA_RULES: {
            'www.youtube.com': {
                title: [
                    'h1.ytd-watch-metadata #video-primary-info-renderer #title', // Current main title
                    'h1.title.ytd-video-primary-info-renderer' // Older structure
                ],
                artist: [
                    '#owner-name a', // Current channel name
                    '#upload-info.ytd-video-owner-renderer a'
                ],
            },
            'www.netflix.com': {
                title: ['.title-title', '.video-title'],
                artist: ['Netflix'],
            },
            'www.tving.com': {
                title: ['h2.program__title__main', '.title-main'],
                artist: ['TVING'],
            },
        },

        FILTER_EXCLUSION_DOMAINS: [],
    };

    // --- Utilities ---
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => {
        if (idleCallbackId) window.cancelIdleCallback(idleCallbackId);
        idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 });
    };

    // --- Script Initialization Guard ---
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() {
        const url = location.href.toLowerCase();
        const hostname = location.hostname.toLowerCase();
        if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true;
        return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path));
    }
    if (isExcluded()) {
        if (CONFIG.DEBUG) console.log(`[VideoSpeed] Skipped on excluded page: ${location.href}`);
        return;
    }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    // --- Global State ---
    const activeMedia = new Set();
    const processedMedia = new WeakSet();
    let isUiVisible = false;

    // --- Environment Hacks & Protections ---
    (function protectConsoleClear() {
        if (!CONFIG.DEBUG) return; // [UPGRADE] Only active in debug mode.
        safeExec(() => {
            if (window.console && console.clear) {
                const originalClear = console.clear;
                console.clear = () => console.log('--- 🚫 console.clear() blocked by VideoSpeed_Control (Debug Mode) ---');
                Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear });
            }
        }, 'consoleClearProtection');
    })();

    (function openAllShadowRoots() {
        if (window._hasHackAttachShadow_) return;
        safeExec(() => {
            // [UPGRADE] Use WeakRef to prevent memory leaks in SPAs.
            window._shadowDomList_ = window._shadowDomList_ || [];
            const originalAttachShadow = window.Element.prototype.attachShadow;
            window.Element.prototype.attachShadow = function (options) {
                const modifiedOptions = { ...options, mode: 'open' };
                const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]);
                window._shadowDomList_.push(new WeakRef(shadowRoot));
                document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } }));
                return shadowRoot;
            };
            window._hasHackAttachShadow_ = true;
        }, 'hackAttachShadow');
    })();


    /**
     * Manages SVG filters for video enhancement.
     */
    const filterManager = (() => {
        // ... (No changes in this module, it's already robust)
        const isFilterDisabledForSite = CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
        const settings = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
        let isEnabled = true;
        const createSvgElement = (tag, attributes = {}) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            for (const [key, value] of Object.entries(attributes)) { el.setAttribute(key, value); }
            return el;
        };
        function createSvgFiltersAndStyle() {
            if (isFilterDisabledForSite || document.getElementById('video-enhancer-svg-filters')) return;
            const svgFilters = createSvgElement('svg', { id: 'video-enhancer-svg-filters' });
            svgFilters.style.display = 'none';
            const softeningFilter = createSvgElement('filter', { id: 'SofteningFilter' });
            softeningFilter.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION }));
            const sharpenFilter = createSvgElement('filter', { id: settings.SHARPEN_ID });
            sharpenFilter.appendChild(createSvgElement('feConvolveMatrix', { order: '3 3', preserveAlpha: 'true', kernelMatrix: settings.KERNEL_MATRIX, mode: 'multiply' }));
            const gammaFilter = createSvgElement('filter', { id: 'gamma-filter' });
            const feCompTransferGamma = createSvgElement('feComponentTransfer');
            ['R', 'G', 'B'].forEach(ch => { feCompTransferGamma.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })); });
            gammaFilter.appendChild(feCompTransferGamma);
            const linearAdjustFilter = createSvgElement('filter', { id: 'linear-adjust-filter' });
            const feCompTransferLinear = createSvgElement('feComponentTransfer');
            const shadowIntercept = settings.SHADOWS_VALUE / 200;
            const highlightSlope = 1 + (settings.HIGHLIGHTS_VALUE / 100);
            ['R', 'G', 'B'].forEach(ch => { feCompTransferLinear.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: highlightSlope.toString(), intercept: shadowIntercept.toString() })); });
            linearAdjustFilter.appendChild(feCompTransferLinear);
            svgFilters.append(softeningFilter, sharpenFilter, gammaFilter, linearAdjustFilter);
            (document.body || document.documentElement).appendChild(svgFilters);
            const styleElement = document.createElement('style');
            styleElement.id = 'video-enhancer-styles';
            styleElement.textContent = `video.video-filter-active, iframe.video-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`;
            (document.head || document.documentElement).appendChild(styleElement);
        }
        function updateState() {
            if (isFilterDisabledForSite) return;
            document.documentElement.classList.toggle('video-filter-main-switch-on', isEnabled);
            const button = uiManager.getShadowRoot()?.getElementById('vm-filter-toggle-btn');
            if (button) button.textContent = isEnabled ? '🌞' : '🌚';
            scanForMedia(true);
        }
        return {
            init: () => safeExec(() => { createSvgFiltersAndStyle(); updateState(); }, 'filterManager.init'),
            toggle: () => { if (isFilterDisabledForSite) return; isEnabled = !isEnabled; updateState(); },
            isEnabled: () => isFilterDisabledForSite ? false : isEnabled,
        };
    })();


    /**
     * Manages the UI host and shadow root.
     */
    const uiManager = (() => {
        // ... (No changes in this module)
        let host, shadowRoot;
        function init() {
            if (host) return;
            host = document.createElement('div');
            host.id = 'vsc-ui-host';
            Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX });
            shadowRoot = host.attachShadow({ mode: 'open' });
            shadowRoot.innerHTML = `<style>:host { pointer-events: none; } * { pointer-events: auto; } #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity 0.5s ease, width 0.3s, background 0.2s; } #vm-speed-slider-container.touched { opacity: 1; } @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } } #vm-speed-slider-container.minimized { width: 30px; } #vm-speed-slider-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; } #vm-speed-slider-container.minimized > :not(.toggle) { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; } .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; font-size:12px; } #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 60px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; } #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); } #vm-filter-toggle-btn { font-size: 16px; padding: 2px 4px; } #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }</style>`;
            (document.body || document.documentElement).appendChild(host);
        }
        return {
            init: () => safeExec(init, 'uiManager.init'),
            getShadowRoot: () => { if (!shadowRoot) init(); return shadowRoot; },
            moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); }
        };
    })();


    /**
     * Manages the speed slider UI and functionality.
     */
    const speedSlider = (() => {
        // ... (No changes in this module)
        let container, inited = false, isMinimized = true, fadeOutTimer;
        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot();
            if (!shadowRoot) return;
            container = document.createElement('div');
            container.id = 'vm-speed-slider-container';
            container.innerHTML = `<button id="vm-filter-toggle-btn" class="vm-btn" title="Toggle Video Filter">🌞</button><button class="vm-btn reset" title="Reset speed to 1x">1x</button><input type="range" min="0.2" max="4.0" step="0.2" value="1.0" id="vm-speed-slider"><div id="vm-speed-value">x1.0</div><button class="vm-btn toggle" title="Toggle Speed Controller"></button>`;
            shadowRoot.appendChild(container);
            const sliderEl = container.querySelector('#vm-speed-slider');
            const valueEl = container.querySelector('#vm-speed-value');
            const toggleButton = container.querySelector('.toggle');
            const resetButton = container.querySelector('.reset');
            const filterButton = container.querySelector('#vm-filter-toggle-btn');
            if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) { filterButton.style.display = 'none'; }
            const applySpeed = (speed) => { for (const media of activeMedia) { if (media.playbackRate !== speed) { safeExec(() => { media.playbackRate = speed; }); } } };
            const updateValueText = (speed) => { if (valueEl) valueEl.textContent = `x${speed.toFixed(1)}`; };
            const updateAppearance = () => { if (!container) return; container.classList.toggle('minimized', isMinimized); toggleButton.textContent = isMinimized ? '🔻' : '🔺'; };
            resetButton.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); });
            filterButton.addEventListener('click', () => filterManager.toggle());
            toggleButton.addEventListener('click', () => { isMinimized = !isMinimized; updateAppearance(); });
            const debouncedApplySpeed = debounce(applySpeed, 100);
            sliderEl.addEventListener('input', (event) => { const speed = parseFloat(event.target.value); updateValueText(speed); debouncedApplySpeed(speed); container.classList.add('touched'); clearTimeout(fadeOutTimer); });
            const endInteractionSoon = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => container.classList.remove('touched'), 3000); };
            const onDocumentTouchEnd = () => { endInteractionSoon(); document.removeEventListener('touchend', onDocumentTouchEnd); document.removeEventListener('touchcancel', onDocumentTouchEnd); };
            container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onDocumentTouchEnd); document.addEventListener('touchcancel', onDocumentTouchEnd); }, { passive: true });
            sliderEl.addEventListener('change', endInteractionSoon, { passive: true });
            sliderEl.addEventListener('blur', endInteractionSoon, { passive: true });
            const stopPropagation = e => e.stopPropagation();
            sliderEl.addEventListener('touchstart', stopPropagation, { passive: true });
            sliderEl.addEventListener('touchmove', stopPropagation, { passive: true });
            inited = true;
            updateAppearance();
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'),
            show: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; },
            hide: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; },
            isMinimized: () => isMinimized,
        };
    })();


    /**
     * Manages drag-to-seek functionality on video elements.
     */
    const dragBar = (() => {
        // ... (No changes in this module)
        let display, inited = false;
        let state = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false };
        let lastDelta = 0;
        let rafScheduled = false;
        function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const videoInChildren = target.querySelector('video'); if (videoInChildren) return videoInChildren; if (target.parentElement) { return target.parentElement.querySelector('video'); } return null; }
        const getEventPosition = (event) => event.touches ? event.touches[0] : event;
        const onStart = (event) => safeExec(() => {
            if (event.touches && event.touches.length > 1) return;
            if (event.type === 'mousedown' && event.button !== 0) return;
            const videoElement = findAssociatedVideo(event.target);
            if (!videoElement || videoElement.paused || speedSlider.isMinimized() || event.composedPath().some(el => el.id === 'vm-speed-slider-container')) return;
            const pos = getEventPosition(event);
            Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false });
            const options = { passive: false, capture: true };
            const moveEvent = event.type === 'mousedown' ? 'mousemove' : 'touchmove';
            const endEvent = event.type === 'mousedown' ? 'mouseup' : 'touchend';
            document.addEventListener(moveEvent, onMove, options);
            document.addEventListener(endEvent, onEnd, options);
        }, 'dragBar.onStart');
        const onMove = (event) => {
            if (!state.dragging) return;
            if (event.touches && event.touches.length > 1) { onEnd(); return; }
            const pos = getEventPosition(event);
            state.currentX = pos.clientX;
            state.currentY = pos.clientY;
            if (!state.directionConfirmed) {
                const deltaX = Math.abs(state.currentX - state.startX);
                const deltaY = Math.abs(state.currentY - state.startY);
                if (deltaX > deltaY + 5) { state.directionConfirmed = true; } else if (deltaY > deltaX + 5) { onEnd(); return; }
            }
            if (state.directionConfirmed) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const movementX = state.currentX - state.startX;
                state.accX += movementX;
                state.startX = state.currentX;
                if (!rafScheduled) {
                    rafScheduled = true;
                    window.requestAnimationFrame(() => { if (state.dragging) showDisplay(state.accX); rafScheduled = false; });
                }
            }
        };
        const onEnd = () => {
            if (!state.dragging) return;
            if (state.directionConfirmed) applySeek();
            Object.assign(state, { dragging: false, accX: 0, directionConfirmed: false });
            hideDisplay();
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('touchmove', onMove, true);
            document.removeEventListener('mouseup', onEnd, true);
            document.removeEventListener('touchend', onEnd, true);
        };
        const applySeek = () => { const deltaSec = Math.round(state.accX / 2); if (Math.abs(deltaSec) < 1) return; for (const media of activeMedia) { if (isFinite(media.duration)) { media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + deltaSec)); } } };
        const showDisplay = (pixels) => {
            const seconds = Math.round(pixels / 2);
            if (seconds === lastDelta) return;
            lastDelta = seconds;
            if (!display) {
                const shadowRoot = uiManager.getShadowRoot();
                if(!shadowRoot) return;
                display = document.createElement('div');
                display.id = 'vm-time-display';
                shadowRoot.appendChild(display);
            }
            const sign = seconds < 0 ? '-' : '+';
            const absSeconds = Math.abs(seconds);
            const minutes = Math.floor(absSeconds / 60).toString().padStart(2, '0');
            const remainingSeconds = (absSeconds % 60).toString().padStart(2, '0');
            display.textContent = `${sign}${minutes}분 ${remainingSeconds}초`;
            display.style.display = 'block';
            display.style.opacity = '1';
        };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } };
        return {
            init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'dragBar.init'); }
        };
    })();


    /**
     * Manages MediaSession API integration with dynamic seek time and rich metadata.
     */
    const mediaSessionManager = (() => {
        const getSeekTime = (media) => {
            if (!media || !isFinite(media.duration)) return 10;
            const dynamicSeekTime = Math.floor(media.duration * CONFIG.SEEK_TIME_PERCENT);
            return Math.min(dynamicSeekTime, CONFIG.SEEK_TIME_MAX_SEC);
        };

        // Helper to find text content from an array of selectors.
        const getTextFromSelectors = (selectors) => {
            if (!Array.isArray(selectors)) return null;
            for (const selector of selectors) {
                const element = document.querySelector(selector);
                if (element) return element.textContent.trim();
            }
            return null;
        };

        const getMetadata = () => {
            const hostname = location.hostname;
            const rule = CONFIG.SITE_METADATA_RULES[hostname];

            if (rule) {
                const title = getTextFromSelectors(rule.title) || document.title;
                const artist = getTextFromSelectors(rule.artist) || location.hostname;
                return { title, artist };
            }
            return { title: document.title, artist: location.hostname };
        };

        // Helper to reduce boilerplate for setActionHandler.
        const setAction = (action, handler) => {
            try { navigator.mediaSession.setActionHandler(action, handler); } catch (error) {
                if(CONFIG.DEBUG) console.warn(`[VideoSpeed] MediaSession action "${action}" not supported.`);
            }
        };

        const setSession = (media) => {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                const { title, artist } = getMetadata();
                navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' });
                setAction('play', () => media.play());
                setAction('pause', () => media.pause());
                setAction('seekbackward', () => { media.currentTime -= getSeekTime(media); });
                setAction('seekforward', () => { media.currentTime += getSeekTime(media); });
                setAction('seekto', (details) => {
                    if (details.fastSeek && 'fastSeek' in media) { media.fastSeek(details.seekTime); }
                    else { media.currentTime = details.seekTime; }
                });
            }, 'mediaSession.set');
        };

        const clearSession = () => {
            if (!('mediaSession' in navigator) || activeMedia.size > 0) return;
            safeExec(() => {
                navigator.mediaSession.metadata = null;
                ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(action => setAction(action, null));
            }, 'mediaSession.clear');
        };

        return { setSession, clearSession };
    })();


    // --- Media Scanning and Management ---
    const mediaListenerMap = new WeakMap();
    let intersectionObserver = null;

    function findAllMedia(doc = document) {
        const mediaElements = [];
        safeExec(() => {
            mediaElements.push(...doc.querySelectorAll('video, audio'));
            // [UPGRADE] Dereference WeakRefs and clean up the list.
            window._shadowDomList_ = (window._shadowDomList_ || []).filter(ref => ref.deref());
            window._shadowDomList_.forEach(ref => {
                const shadowRoot = ref.deref();
                if (shadowRoot) {
                    mediaElements.push(...shadowRoot.querySelectorAll('video, audio'));
                }
            });
            if (doc === document) {
                doc.querySelectorAll('iframe').forEach(iframe => {
                    try {
                        if (iframe.contentDocument) {
                            mediaElements.push(...findAllMedia(iframe.contentDocument));
                        }
                    } catch (error) { /* Cross-origin iframe */ }
                });
            }
        });
        return [...new Set(mediaElements)];
    }

    function updateVideoFilterState(video) {
        const isPlaying = !video.paused && !video.ended;
        const isVisible = video.dataset.isVisible === 'true';
        const mainSwitchOn = filterManager.isEnabled();
        const shouldHaveFilter = isPlaying && isVisible && mainSwitchOn;
        video.classList.toggle('video-filter-active', shouldHaveFilter);
    }

    const mediaEventHandlers = {
        play: (event) => { const media = event.target; updateVideoFilterState(media); scanForMedia(true); mediaSessionManager.setSession(media); },
        pause: (event) => { if (activeMedia.size <= 1) mediaSessionManager.clearSession(); },
        ended: (event) => { if (activeMedia.size <= 1) mediaSessionManager.clearSession(); },
    };

    function attachMediaListeners(media) {
        if (!media || processedMedia.has(media)) return; // [UPGRADE] Skip already processed media.
        const listeners = {};
        for (const [eventName, handler] of Object.entries(mediaEventHandlers)) {
            listeners[eventName] = handler;
            media.addEventListener(eventName, handler);
        }
        mediaListenerMap.set(media, listeners);
        processedMedia.add(media); // Mark as processed.
        if (intersectionObserver && media.tagName === 'VIDEO') {
            intersectionObserver.observe(media);
        }
    }

    function detachMediaListeners(media) {
        if (!mediaListenerMap.has(media)) return;
        const listeners = mediaListenerMap.get(media);
        for (const [eventName, listener] of Object.entries(listeners)) {
            media.removeEventListener(eventName, listener);
        }
        mediaListenerMap.delete(media);
        processedMedia.delete(media); // Allow reprocessing if re-added.
        if (intersectionObserver && media.tagName === 'VIDEO') {
            intersectionObserver.unobserve(media);
        }
        if (CONFIG.DEBUG) console.log('[VideoSpeed] Event listeners cleaned up for removed media element.');
    }

    const scanForMedia = (isUiUpdateOnly = false) => {
        const allMedia = findAllMedia();
        if (!isUiUpdateOnly) {
            allMedia.forEach(attachMediaListeners);
        }

        activeMedia.clear();
        allMedia.forEach(media => {
            if (media.isConnected) {
                activeMedia.add(media);
            }
        });

        allMedia.forEach(media => {
            if (media.tagName === 'VIDEO') {
                const isPlaying = !media.paused && !media.ended;
                media.classList.toggle('vsc-gpu-accelerated', isPlaying);
                updateVideoFilterState(media);
            }
        });

        const shouldBeVisible = activeMedia.size > 0;
        if (isUiVisible !== shouldBeVisible) {
            isUiVisible = shouldBeVisible;
            if (isUiVisible) speedSlider.show();
            else speedSlider.hide();
        }
    };

    const debouncedScanTask = debounce(scanForMedia, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = (nodes) => { nodes.forEach(node => { if (node.nodeType !== 1) return; if (node.matches?.('video, audio')) attachMediaListeners(node); node.querySelectorAll?.('video, audio').forEach(attachMediaListeners); }); };
    const handleRemovedNodes = (nodes) => { nodes.forEach(node => { if (node.nodeType !== 1) return; if (node.matches?.('video, audio')) detachMediaListeners(node); node.querySelectorAll?.('video, audio').forEach(detachMediaListeners); }); };

    /**
     * Main initialization function.
     */
    function initialize() {
        console.log('🎉 VideoSpeed_Control (Professional) Initialized.');
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
                scanForMedia(true);
            }
        });

        const mutationObserver = new MutationObserver(mutations => {
            let mediaChanged = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    if (mutation.addedNodes.length > 0) { handleAddedNodes(mutation.addedNodes); mediaChanged = true; }
                    if (mutation.removedNodes.length > 0) { handleRemovedNodes(mutation.removedNodes); mediaChanged = true; }
                }
            }
            if (mediaChanged) scheduleIdleTask(() => scanForMedia(true)); // [UPGRADE] Use requestIdleCallback
        });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });

        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState;
        history.pushState = function (...args) { originalPushState.apply(this, args); scanForMedia(); };
        window.addEventListener('popstate', () => scanForMedia());
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));

        window.addEventListener('beforeunload', () => {
            mutationObserver.disconnect();
            intersectionObserver.disconnect();
            if (CONFIG.DEBUG) console.log('[VideoSpeed] Cleaned up Observers.');
        });

        scanForMedia();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize, { once: true });
    }
})();
