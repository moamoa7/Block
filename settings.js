// ==UserScript==
// @name         VideoSpeed_Control (Definitive Final)
// @namespace    https://com/
// @version      29.06-PresetEQ
// @description  🎞️ 오디오 제어 기능을 목적별 프리셋(영화/스피치/음악) 순환 방식으로 통합하여 사용성을 극대화했습니다.
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
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        SHARPEN_LEVELS: {
            high:   '0 -1 0 -1 5 -1 0 -1 0',
            medium: '0 -0.5 0 -0.5 3 -0.5 0 -0.5 0',
            low:    '0 -0.25 0 -0.25 2 -0.25 0 -0.25 0',
            off:    '0 0 0 0 1 0 0 0 0',
        },
        SITE_METADATA_RULES: {
            'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], },
            'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] },
            'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] },
        },
        FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_PRESETS: {
            off: { compressor: { threshold: 0, knee: 0, ratio: 1, attack: 0, release: 0.25 }, eq: { bassGain: 0, trebleGain: 0 }, icon: "🚫" },
            speech: { compressor: { threshold: -35, knee: 20, ratio: 6, attack: 0.01, release: 0.3 }, eq: { bassGain: -1, trebleGain: 4 }, icon: "🎙️" },
            movie: { compressor: { threshold: -45, knee: 25, ratio: 8, attack: 0.005, release: 0.4 }, eq: { bassGain: 5, trebleGain: 2 }, icon: "🎬" },
            music: { compressor: { threshold: -25, knee: 15, ratio: 2.5, attack: 0.02, release: 0.5 }, eq: { bassGain: 3, trebleGain: 1 }, icon: "🎵" }
        },
        EQ_SETTINGS: { bassFrequency: 400, trebleFrequency: 5000 },
    };

    // --- Utilities & Guards ---
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VideoSpeed] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path)); }
    if (isExcluded()) { return; }
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    const activeMedia = new Set();
    const processedMedia = new WeakSet();
    let isUiVisible = false;
    (function protectConsoleClear() { if (!CONFIG.DEBUG) return; safeExec(() => { if (window.console && console.clear) { const originalClear = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked by VideoSpeed_Control (Debug Mode) ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection'); })();
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const originalAttachShadow = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function (options) { const modifiedOptions = { ...options, mode: 'open' }; const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]); window._shadowDomList_.push(new WeakRef(shadowRoot)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } })); return shadowRoot; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    const audioManager = (() => {
        const PRESET_ORDER = ['off', 'speech', 'movie', 'music'];
        let currentAudioMode = 'off';
        const audioGraphMap = new WeakMap();
        function applyAudioPreset(media) { if (!audioGraphMap.has(media)) return; const graph = audioGraphMap.get(media); const preset = CONFIG.AUDIO_PRESETS[currentAudioMode]; const c = graph.compressor; const cs = preset.compressor; c.threshold.setValueAtTime(cs.threshold, graph.context.currentTime); c.knee.setValueAtTime(cs.knee, graph.context.currentTime); c.ratio.setValueAtTime(cs.ratio, graph.context.currentTime); c.attack.setValueAtTime(cs.attack, graph.context.currentTime); c.release.setValueAtTime(cs.release, graph.context.currentTime); const eq = preset.eq; graph.bassFilter.gain.setValueAtTime(eq.bassGain, graph.context.currentTime); graph.trebleFilter.gain.setValueAtTime(eq.trebleGain, graph.context.currentTime); }
        function createAudioGraph(context) { const compressor = context.createDynamicsCompressor(); const bassFilter = context.createBiquadFilter(); bassFilter.type = 'lowshelf'; bassFilter.frequency.value = CONFIG.EQ_SETTINGS.bassFrequency; const trebleFilter = context.createBiquadFilter(); trebleFilter.type = 'highshelf'; trebleFilter.frequency.value = CONFIG.EQ_SETTINGS.trebleFrequency; const gain = context.createGain(); compressor.connect(bassFilter).connect(trebleFilter).connect(gain).connect(context.destination); return { compressor, bassFilter, trebleFilter, gain }; }
        function initAudioContext(media) { if (audioGraphMap.has(media)) return; safeExec(() => { const context = new (window.AudioContext || window.webkitAudioContext)(); const source = context.createMediaElementSource(media); const graphNodes = createAudioGraph(context); source.connect(graphNodes.compressor); audioGraphMap.set(media, { context, source, ...graphNodes }); applyAudioPreset(media); }, 'audioManager.init'); }
        function cycleAudioMode() { const currentIndex = PRESET_ORDER.indexOf(currentAudioMode); const nextIndex = (currentIndex + 1) % PRESET_ORDER.length; currentAudioMode = PRESET_ORDER[nextIndex]; const button = uiManager.getShadowRoot()?.getElementById('vm-audio-mode-btn'); if (button) { button.textContent = CONFIG.AUDIO_PRESETS[currentAudioMode].icon; button.title = `Cycle Audio Mode (${currentAudioMode})`; } for (const media of activeMedia) applyAudioPreset(media); }
        function resetAudio() { currentAudioMode = 'off'; filterManager.resetFilter(); const root = uiManager.getShadowRoot(); if (root) { const audioBtn = root.getElementById('vm-audio-mode-btn'); if (audioBtn) { audioBtn.textContent = CONFIG.AUDIO_PRESETS.off.icon; audioBtn.title = 'Cycle Audio Mode (off)'; } } for (const media of activeMedia) applyAudioPreset(media); }
        function processMedia(media) { media.addEventListener('play', () => initAudioContext(media), { once: true }); }
        function cleanupMedia(media) { if (audioGraphMap.has(media)) { safeExec(() => { audioGraphMap.get(media).context.close(); audioGraphMap.delete(media); }, 'audioManager.cleanup'); } }
        function suspendContext(media) { if (audioGraphMap.has(media) && audioGraphMap.get(media).context.state === 'running') { audioGraphMap.get(media).context.suspend(); } }
        function resumeContext(media) { if (audioGraphMap.has(media) && audioGraphMap.get(media).context.state === 'suspended') { audioGraphMap.get(media).context.resume(); } }
        return { processMedia, cleanupMedia, cycleAudioMode, resetAudio, suspendContext, resumeContext };
    })();

    const uiManager = (() => {
        let host, shadowRoot;
        function init() { if (host) return; host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX }); shadowRoot = host.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = `:host { pointer-events: none; } * { pointer-events: auto; } #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: center; width: 50px; opacity: 0.3; transition: opacity 0.5s ease, width 0.3s, background 0.2s; } #vm-speed-slider-container.touched { opacity: 1; } @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } } #vm-speed-slider-container.minimized { width: 30px; } #vm-speed-slider-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; } #vm-speed-slider-container.minimized > :not(.toggle) { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; } .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; margin-top: 4px; font-size:12px; } #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 60px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; } #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); } #vm-filter-toggle-btn, #vm-audio-mode-btn { font-size: 16px; padding: 2px 4px; } #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }`; shadowRoot.appendChild(style); (document.body || document.documentElement).appendChild(host); }
        return { init: () => safeExec(init, 'uiManager.init'), getShadowRoot: () => { if (!shadowRoot) init(); return shadowRoot; }, moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } };
    })();

    const filterManager = (() => {
        const isFilterDisabledForSite = CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        const settings = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
        let currentFilterMode = 'off';
        const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
        function createSvgFiltersAndStyle() { if (isFilterDisabledForSite || document.getElementById('video-enhancer-svg-filters')) return; const svg = createSvgElement('svg', { id: 'video-enhancer-svg-filters', style: 'display:none' }); const soft = createSvgElement('filter', { id: 'SofteningFilter' }); soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })); const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID }); sharp.appendChild(createSvgElement('feConvolveMatrix', { id: 'dynamic-convolve-matrix', order: '3 3', preserveAlpha: 'true', kernelMatrix: CONFIG.SHARPEN_LEVELS.off, mode: 'multiply' })); const gamma = createSvgElement('filter', { id: 'gamma-filter' }); const gammaTransfer = createSvgElement('feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); gamma.appendChild(gammaTransfer); const linear = createSvgElement('filter', { id: 'linear-adjust-filter' }); const linearTransfer = createSvgElement('feComponentTransfer'); const intercept = settings.SHADOWS_VALUE / 200; const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() }))); linear.appendChild(linearTransfer); svg.append(soft, sharp, gamma, linear); (document.body || document.documentElement).appendChild(svg); const style = document.createElement('style'); style.id = 'video-enhancer-styles'; style.textContent = `video.video-filter-active, iframe.video-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`; (document.head || document.documentElement).appendChild(style); }
        function setSharpenLevel(level = 'off') { const matrix = document.getElementById('dynamic-convolve-matrix'); if (matrix) { const newMatrix = CONFIG.SHARPEN_LEVELS[level]; if (matrix.getAttribute('kernelMatrix') !== newMatrix) matrix.setAttribute('kernelMatrix', newMatrix); } }
        function cycleFilterMode() {
            if (isFilterDisabledForSite) return;
            const modes = ['high', 'medium', 'low', 'off'];
            currentFilterMode = modes[(modes.indexOf(currentFilterMode) + 1) % modes.length];
            for (const video of activeMedia) { updateVideoFilterState(video); }
        }
        function resetFilter() {
            currentFilterMode = 'off';
            scanForMedia(true);
        }
        return { init: () => safeExec(createSvgFiltersAndStyle, 'filter.init'), cycleFilterMode, getFilterMode: () => currentFilterMode, setSharpenLevel, resetFilter };
    })();

    const speedSlider = (() => {
        let container, inited = false, isMinimized = true, fadeOutTimer;
        const createButton = (id, title, text) => { const btn = document.createElement('button'); if(id) btn.id = id; btn.className = 'vm-btn'; btn.title = title; btn.textContent = text; return btn; };
        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot(); if (!shadowRoot) return;
            container = document.createElement('div'); container.id = 'vm-speed-slider-container';
            const filterBtn = createButton('vm-filter-toggle-btn', 'Cycle Filter Mode (Off)', '🌚');
            const audioBtn = createButton('vm-audio-mode-btn', 'Cycle Audio Mode (Off)', '🚫');
            const resetBtn = createButton(null, 'Reset speed & audio', '1x'); resetBtn.classList.add('reset');
            const sliderEl = document.createElement('input'); Object.assign(sliderEl, { type: 'range', min: '0.2', max: '4.0', step: '0.2', value: '1.0', id: 'vm-speed-slider' });
            const valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            const toggleBtn = createButton(null, 'Toggle Speed Controller', ''); toggleBtn.classList.add('toggle');
            container.append(filterBtn, audioBtn, resetBtn, sliderEl, valueEl, toggleBtn);
            shadowRoot.appendChild(container);
            if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) filterBtn.style.display = 'none';
            const applySpeed = speed => { for (const media of activeMedia) if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); };
            const updateValueText = speed => { if (valueEl) valueEl.textContent = `x${speed.toFixed(1)}`; };
            const updateAppearance = () => { if (!container) return; container.classList.toggle('minimized', isMinimized); toggleBtn.textContent = isMinimized ? '🔻' : '🔺'; };
            resetBtn.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); audioManager.resetAudio(); });
            filterBtn.addEventListener('click', () => filterManager.cycleFilterMode());
            audioBtn.addEventListener('click', () => audioManager.cycleAudioMode());
            toggleBtn.addEventListener('click', () => { isMinimized = !isMinimized; updateAppearance(); });
            const debouncedApplySpeed = debounce(applySpeed, 100);
            sliderEl.addEventListener('input', e => { const speed = parseFloat(e.target.value); updateValueText(speed); debouncedApplySpeed(speed); container.classList.add('touched'); clearTimeout(fadeOutTimer); });
            const endInteraction = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => container.classList.remove('touched'), 3000); };
            const onTouchEnd = () => { endInteraction(); document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd); };
            container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onTouchEnd); document.addEventListener('touchcancel', onTouchEnd); }, { passive: true });
            sliderEl.addEventListener('change', endInteraction, { passive: true });
            sliderEl.addEventListener('blur', endInteraction, { passive: true });
            const stopProp = e => e.stopPropagation();
            sliderEl.addEventListener('touchstart', stopProp, { passive: true });
            sliderEl.addEventListener('touchmove', stopProp, { passive: true });
            inited = true;
            updateAppearance();
        }
        return { init: () => safeExec(init, 'speedSlider.init'), show: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; }, hide: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; }, isMinimized: () => isMinimized };
    })();

    const dragBar = (() => {
        let display, inited = false; let state = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false;
        function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; }
        const getEventPosition = e => e.touches ? e.touches[0] : e;
        const onStart = e => safeExec(() => { if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return; const video = findAssociatedVideo(e.target); if (!video || video.paused || speedSlider.isMinimized() || e.composedPath().some(el => el.id === 'vm-speed-slider-container')) return; const pos = getEventPosition(e); Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'drag.start');
        const onMove = e => { if (!state.dragging) return; if (e.touches && e.touches.length > 1) return onEnd(); const pos = getEventPosition(e); state.currentX = pos.clientX; state.currentY = pos.clientY; if (!state.directionConfirmed) { const dX = Math.abs(state.currentX - state.startX); const dY = Math.abs(state.currentY - state.startY); if (dX > dY + 5) state.directionConfirmed = true; else if (dY > dX + 5) return onEnd(); } if (state.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); state.accX += state.currentX - state.startX; state.startX = state.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (state.dragging) showDisplay(state.accX); rafScheduled = false; }); } } };
        const onEnd = () => { if (!state.dragging) return; if (state.directionConfirmed) applySeek(); Object.assign(state, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); };
        const applySeek = () => { const delta = Math.round(state.accX / 2); if (Math.abs(delta) < 1) return; for (const media of activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); };
        const showDisplay = pixels => { const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds; if (!display) { const root = uiManager.getShadowRoot(); if(!root) return; display = document.createElement('div'); display.id = 'vm-time-display'; root.appendChild(display); } const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mins}분 ${secs}초`; display.style.display = 'block'; display.style.opacity = '1'; };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } };
        return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } };
    })();

    const mediaSessionManager = (() => {
        const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); };
        const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; };
        const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; };
        const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} };
        return { setSession: m => { if (!('mediaSession' in navigator)) return; safeExec(() => { const { title, artist } = getMeta(); navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' }); setAction('play', () => m.play()); setAction('pause', () => m.pause()); setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); }); setAction('seekforward', () => { m.currentTime += getSeekTime(m); }); setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }); }, 'mediaSession.set'); }, clearSession: () => { if (!('mediaSession' in navigator) || activeMedia.size > 0) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); } };
    })();

    const mediaListenerMap = new WeakMap();
    let intersectionObserver = null;
    function findAllMedia(doc = document) { const elems = []; safeExec(() => { elems.push(...doc.querySelectorAll('video, audio')); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...root.querySelectorAll('video, audio')); }); if (doc === document) doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) {} }); }); return [...new Set(elems)]; }

    function updateFilterButtonUI() {
        const button = uiManager.getShadowRoot()?.getElementById('vm-filter-toggle-btn');
        if (button) {
            const mode = filterManager.getFilterMode();
            const isOff = mode === 'off';
            const levelChar = isOff ? '' : ` ${mode.charAt(0).toUpperCase()}`;
            button.textContent = isOff ? '🌚' : `🌞${levelChar}`;
            button.title = `Cycle Filter Mode (Current: ${mode})`;
        }
    }

    function updateVideoFilterState(video) {
        const isPlaying = !video.paused && !video.ended;
        const isVisible = video.dataset.isVisible === 'true';
        const filterMode = filterManager.getFilterMode();

        const shouldHaveFilter = isPlaying && isVisible && filterMode !== 'off';

        filterManager.setSharpenLevel(filterMode);
        video.classList.toggle('video-filter-active', shouldHaveFilter);
        updateFilterButtonUI();
    }

    const mediaEventHandlers = {
        play: e => { const m = e.target; audioManager.resumeContext(m); updateVideoFilterState(m); },
        pause: e => { audioManager.suspendContext(e.target); updateVideoFilterState(e.target); },
        ended: e => { const m = e.target; detachMediaListeners(m); if (activeMedia.size <= 1) mediaSessionManager.clearSession(); },
    };

    function attachMediaListeners(media) {
        if (!media || processedMedia.has(media)) return;
        audioManager.processMedia(media);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) { listeners[evt] = handler; media.addEventListener(evt, handler); }
        mediaListenerMap.set(media, listeners);
        processedMedia.add(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.observe(media);
    }

    function detachMediaListeners(media) {
        if (!mediaListenerMap.has(media)) return;
        audioManager.cleanupMedia(media);
        const listeners = mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) media.removeEventListener(evt, listener);
        mediaListenerMap.delete(media);
        processedMedia.delete(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.unobserve(media);
    }

    const scanForMedia = (isUiUpdateOnly = false) => {
        const allMedia = findAllMedia();
        if (!isUiUpdateOnly) allMedia.forEach(attachMediaListeners);
        const oldMedia = new Set(activeMedia);
        activeMedia.clear();
        allMedia.forEach(m => { if (m.isConnected) { activeMedia.add(m); oldMedia.delete(m); } });
        oldMedia.forEach(detachMediaListeners);
        allMedia.forEach(m => { if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); } });
        const shouldBeVisible = activeMedia.size > 0;
        if (isUiVisible !== shouldBeVisible) { isUiVisible = shouldBeVisible; if (isUiVisible) speedSlider.show(); else speedSlider.hide(); }
    };

    const debouncedScanTask = debounce(scanForMedia, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) attachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(attachMediaListeners); }); };
    const handleRemovedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) detachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(detachMediaListeners); }); };

    function initialize() {
        console.log('🎉 VideoSpeed_Control (Final Logic Fix) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        filterManager.init();
        intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(e => { e.target.dataset.isVisible = e.isIntersecting; updateVideoFilterState(e.target); });
        }, { threshold: 0.1 });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active')); } else { scanForMedia(true); } });
        const mutationObserver = new MutationObserver(mutations => {
            let changed = false;
            for (const mut of mutations) {
                if (mut.type === 'childList') {
                    if (mut.addedNodes.length > 0) { handleAddedNodes(mut.addedNodes); changed = true; }
                    if (mut.removedNodes.length > 0) { handleRemovedNodes(mut.removedNodes); changed = true; }
                }
            }
            if (changed) scheduleIdleTask(() => scanForMedia());
        });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState;
        history.pushState = function(...args) {
            let result;
            try { result = originalPushState.apply(this, args); } finally { scheduleIdleTask(() => scanForMedia()); }
            return result;
        };
        window.addEventListener('popstate', () => scheduleIdleTask(() => scanForMedia()));
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));
        window.addEventListener('beforeunload', () => { mutationObserver.disconnect(); intersectionObserver.disconnect(); });
        scanForMedia();
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize, { once: true });
    }
})();
