// ==UserScript==
// @name         VideoSpeed_Control (Exclusion)
// @namespace    https://com/
// @version      30.12-ButtonSizeFix
// @description  🎞️ 모든 제어 버튼의 크기 및 간격을 통일하여 UI의 시각적 일관성을 확보한 최종 버전입니다.
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
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.4', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.4', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        SHARPEN_LEVELS: {
            high:   '0 -1 0 -1 5 -1 0 -1 0',
            medium: '0 -0.5 0 -0.5 3 -0.5 0 -0.5 0',
            low:    '0 -0.125 0 -0.125 1.5 -0.125 0 -0.125 0',
            off:    '0 0 0 0 1 0 0 0 0',
        },
        SITE_METADATA_RULES: {
            'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], },
            'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] },
            'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] },
        },
        FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: ['www.youtube.com', 'm.youtube.com'],
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
        const isAudioDisabledForSite = CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname);
        let currentAudioMode = 'off';
        const audioGraphMap = new WeakMap();
        function applyAudioPreset(media) { if (isAudioDisabledForSite || !audioGraphMap.has(media)) return; const graph = audioGraphMap.get(media); const preset = CONFIG.AUDIO_PRESETS[currentAudioMode]; const c = graph.compressor; const cs = preset.compressor; c.threshold.setValueAtTime(cs.threshold, graph.context.currentTime); c.knee.setValueAtTime(cs.knee, graph.context.currentTime); c.ratio.setValueAtTime(cs.ratio, graph.context.currentTime); c.attack.setValueAtTime(cs.attack, graph.context.currentTime); c.release.setValueAtTime(cs.release, graph.context.currentTime); const eq = preset.eq; graph.bassFilter.gain.setValueAtTime(eq.bassGain, graph.context.currentTime); graph.trebleFilter.gain.setValueAtTime(eq.trebleGain, graph.context.currentTime); }
        function createAudioGraph(context) { const compressor = context.createDynamicsCompressor(); const bassFilter = context.createBiquadFilter(); bassFilter.type = 'lowshelf'; bassFilter.frequency.value = CONFIG.EQ_SETTINGS.bassFrequency; const trebleFilter = context.createBiquadFilter(); trebleFilter.type = 'highshelf'; trebleFilter.frequency.value = CONFIG.EQ_SETTINGS.trebleFrequency; const gain = context.createGain(); compressor.connect(bassFilter).connect(trebleFilter).connect(gain).connect(context.destination); return { compressor, bassFilter, trebleFilter, gain }; }
        function initAudioContext(media, attempt = 1) { if (isAudioDisabledForSite || audioGraphMap.has(media)) return; if (media.readyState < 3 && attempt < 10) { setTimeout(() => initAudioContext(media, attempt + 1), 100); return; } safeExec(() => { if (!media.isConnected) return; const context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); const source = context.createMediaElementSource(media); const graphNodes = createAudioGraph(context); source.connect(graphNodes.compressor); audioGraphMap.set(media, { context, source, ...graphNodes }); applyAudioPreset(media); }, 'audioManager.init'); }
        function processMedia(media) { if (isAudioDisabledForSite) return; media.addEventListener('play', () => initAudioContext(media), { once: true }); }
        function setAudioMode(mode) { if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return; currentAudioMode = mode; for (const media of activeMedia) applyAudioPreset(media); }
        function resetAudio() { setAudioMode('off'); }
        function cleanupMedia(media) { if (audioGraphMap.has(media)) { safeExec(() => { audioGraphMap.get(media).context.close(); audioGraphMap.delete(media); }, 'audioManager.cleanup'); } }
        function suspendContext(media) { if (audioGraphMap.has(media) && audioGraphMap.get(media).context.state === 'running') { safeExec(() => audioGraphMap.get(media).context.suspend(), 'suspend'); } }
        function resumeContext(media) { if (audioGraphMap.has(media) && audioGraphMap.get(media).context.state === 'suspended') { safeExec(() => audioGraphMap.get(media).context.resume(), 'resume'); } }
        return { processMedia, cleanupMedia, setAudioMode, resetAudio, suspendContext, resumeContext, getAudioMode: () => currentAudioMode };
    })();

    const uiManager = (() => {
        let host, shadowRoot;
        function init() { if (host) return; host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX }); shadowRoot = host.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = `:host { pointer-events: none; }
            * { pointer-events: auto; }
            #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.5s ease, background 0.2s; }
            #vm-speed-slider-container.touched, #vm-speed-slider-container.menu-visible { opacity: 1; }
            #vm-speed-slider-container.menu-visible { background: rgba(0,0,0,0.4); }
            @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } }
            
            #vm-speed-slider-container.minimized { width: 50px; } 
            
            #vm-speed-slider-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
            
            #vm-speed-slider-container .vm-collapsible { display: flex; flex-direction: column; align-items: flex-end; width: 50px; margin-top: 4px; }

            #vm-speed-slider-container.minimized .vm-collapsible { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; }
            .vm-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: 4px; height: 28px; width: 50px; }
            .vm-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 0; margin-right: 5px; background: rgba(20,20,20,0.7); border-radius: 4px; padding: 2px; }
            .vm-control-group.submenu-visible .vm-submenu { display: flex; }

            .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; font-size:12px; }
            .vm-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }
            .vm-submenu .vm-btn { min-width: 24px; font-size: 14px; padding: 2px 4px; margin: 0 2px; }
            
            .vm-btn-main { font-size: 16px; padding: 2px 4px; width: 30px; height: 100%; }

            /* [추가] 1x, 토글 버튼 크기 및 스타일 통일 */
            .vm-btn.reset, .vm-btn.toggle { 
                font-size: 16px; 
                padding: 0; 
                width: 30px; 
                height: 28px; 
                display: flex; 
                align-items: center; 
                justify-content: center; 
                box-sizing: border-box; 
            }
            .vm-btn.toggle { margin-top: 4px; }
            
            #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 60px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; }
            #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); padding-right: 5px; }
            #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }`; shadowRoot.appendChild(style); (document.body || document.documentElement).appendChild(host); }
        return { init: () => safeExec(init, 'uiManager.init'), getShadowRoot: () => { if (!shadowRoot) init(); return shadowRoot; }, moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } };
    })();

    const filterManager = (() => {
        const isFilterDisabledForSite = CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        let currentFilterMode = 'off'; let isInitialized = false;
        const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
        function createSvgFiltersAndStyle() { if (document.getElementById('video-enhancer-svg-filters')) return; const settings = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS; const svg = createSvgElement('svg', { id: 'video-enhancer-svg-filters', style: 'display:none' }); const soft = createSvgElement('filter', { id: 'SofteningFilter' }); soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })); const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID }); sharp.appendChild(createSvgElement('feConvolveMatrix', { id: 'dynamic-convolve-matrix', order: '3 3', preserveAlpha: 'true', kernelMatrix: CONFIG.SHARPEN_LEVELS.off, mode: 'multiply' })); const gamma = createSvgElement('filter', { id: 'gamma-filter' }); const gammaTransfer = createSvgElement('feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); gamma.appendChild(gammaTransfer); const linear = createSvgElement('filter', { id: 'linear-adjust-filter' }); const linearTransfer = createSvgElement('feComponentTransfer'); const intercept = settings.SHADOWS_VALUE / 200; const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() }))); linear.appendChild(linearTransfer); svg.append(soft, sharp, gamma, linear); (document.body || document.documentElement).appendChild(svg); const style = document.createElement('style'); style.id = 'video-enhancer-styles'; style.textContent = `video.video-filter-active, iframe.video-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`; (document.head || document.documentElement).appendChild(style); }
        function initialize() { if (isInitialized || isFilterDisabledForSite) return; safeExec(createSvgFiltersAndStyle, 'filter.init'); isInitialized = true; }
        function setSharpenLevel(level = 'off') { if (!isInitialized) return; const matrix = document.getElementById('dynamic-convolve-matrix'); if (matrix) { const newMatrix = CONFIG.SHARPEN_LEVELS[level]; if (matrix.getAttribute('kernelMatrix') !== newMatrix) matrix.setAttribute('kernelMatrix', newMatrix); } }
        function setFilterMode(mode) { if (isFilterDisabledForSite || !isInitialized || !CONFIG.SHARPEN_LEVELS[mode]) return; currentFilterMode = mode; for (const video of activeMedia) { updateVideoFilterState(video); } }
        function resetFilter() { setFilterMode('off'); }
        return { init: initialize, setFilterMode, getFilterMode: () => currentFilterMode, setSharpenLevel, resetFilter, isInitialized: () => isInitialized };
    })();

    const speedSlider = (() => {
        let container, inited = false, isMinimized = true, fadeOutTimer;
        const createButton = (id, title, text, className = 'vm-btn') => { const btn = document.createElement('button'); if (id) btn.id = id; btn.className = className; btn.title = title; btn.textContent = text; return btn; };
        function init() {
            if (inited) return;
            const shadowRoot = uiManager.getShadowRoot(); if (!shadowRoot) return;
            container = document.createElement('div'); container.id = 'vm-speed-slider-container';

            const videoControlGroup = document.createElement('div'); videoControlGroup.className = 'vm-control-group'; videoControlGroup.style.position = 'relative';
            const audioControlGroup = document.createElement('div'); audioControlGroup.className = 'vm-control-group'; audioControlGroup.style.position = 'relative';
            
            const filterBtnMain = createButton('vm-main-filter-btn', 'Video Filter Settings', '🌞', 'vm-btn vm-btn-main');
            const audioBtnMain = createButton('vm-main-audio-btn', 'Audio Preset Settings', '🎧', 'vm-btn vm-btn-main');
            const filterSubMenu = document.createElement('div'); filterSubMenu.className = 'vm-submenu';
            const audioSubMenu = document.createElement('div'); audioSubMenu.className = 'vm-submenu';

            const filterModes = { H: 'high', M: 'medium', L: 'low', '🚫': 'off' };
            Object.entries(filterModes).forEach(([text, mode]) => { const btn = createButton(null, `Filter: ${mode}`, text); btn.dataset.mode = mode; filterSubMenu.appendChild(btn); });
            const audioModes = { '🎙️': 'speech', '🎬': 'movie', '🎵': 'music', '🚫': 'off' };
            Object.entries(audioModes).forEach(([text, mode]) => { const btn = createButton(null, `Audio: ${mode}`, text); btn.dataset.mode = mode; audioSubMenu.appendChild(btn); });

            videoControlGroup.append(filterBtnMain, filterSubMenu);
            audioControlGroup.append(audioBtnMain, audioSubMenu);
            
            const collapsibleWrapper = document.createElement('div'); collapsibleWrapper.className = 'vm-collapsible';
            const resetBtn = createButton(null, 'Reset speed & audio', '1x', 'vm-btn reset');
            const sliderEl = document.createElement('input'); Object.assign(sliderEl, { type: 'range', min: '0.2', max: '4.0', step: '0.2', value: '1.0', id: 'vm-speed-slider' });
            const valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            collapsibleWrapper.append(resetBtn, sliderEl, valueEl);

            const toggleBtn = createButton(null, 'Toggle Speed Controller', '', 'vm-btn toggle');
            container.append(videoControlGroup, audioControlGroup, collapsibleWrapper, toggleBtn);
            shadowRoot.appendChild(container);

            if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) videoControlGroup.style.display = 'none';
            if (CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname)) audioControlGroup.style.display = 'none';

            const controlGroups = [videoControlGroup, audioControlGroup];
            const updateActiveButtons = () => {
                const currentFilter = filterManager.getFilterMode();
                filterSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentFilter));
                filterBtnMain.classList.toggle('active', currentFilter !== 'off');
                const currentAudio = audioManager.getAudioMode();
                audioSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
                audioBtnMain.classList.toggle('active', currentAudio !== 'off');
            };

            const hideAllSubMenus = () => {
                controlGroups.forEach(group => group.classList.remove('submenu-visible'));
                container.classList.remove('menu-visible');
            };

            const toggleSubMenu = (groupToShow) => {
                const isOpening = !groupToShow.classList.contains('submenu-visible');
                hideAllSubMenus();
                if (isOpening) {
                    groupToShow.classList.add('submenu-visible');
                    container.classList.add('menu-visible');
                }
            };
            
            filterBtnMain.addEventListener('click', () => toggleSubMenu(videoControlGroup));
            audioBtnMain.addEventListener('click', () => toggleSubMenu(audioControlGroup));
            
            filterSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { filterManager.setFilterMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });
            audioSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { audioManager.setAudioMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });

            const applySpeed = speed => { for (const media of activeMedia) if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); };
            const updateValueText = speed => { if (valueEl) valueEl.textContent = `x${speed.toFixed(1)}`; };
            const updateAppearance = () => { if (!container) return; container.classList.toggle('minimized', isMinimized); toggleBtn.textContent = isMinimized ? '🔻' : '🔺'; if (isMinimized) hideAllSubMenus(); };
            resetBtn.addEventListener('click', () => { sliderEl.value = '1.0'; applySpeed(1.0); updateValueText(1.0); audioManager.resetAudio(); filterManager.resetFilter(); updateActiveButtons(); });
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
            
            inited = true; updateAppearance(); updateActiveButtons();
        }
        return { init: () => safeExec(init, 'speedSlider.init'), show: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; }, hide: () => { const el = uiManager.getShadowRoot()?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; }, isMinimized: () => isMinimized };
    })();

    const dragBar = (() => { let display, inited = false; let state = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false; function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; } const getEventPosition = e => e.touches ? e.touches[0] : e; const onStart = e => safeExec(() => { if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return; const video = findAssociatedVideo(e.target); if (!video || video.paused || speedSlider.isMinimized() || e.composedPath().some(el => el.id === 'vm-speed-slider-container')) return; const pos = getEventPosition(e); Object.assign(state, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'drag.start'); const onMove = e => { if (!state.dragging) return; if (e.touches && e.touches.length > 1) return onEnd(); const pos = getEventPosition(e); state.currentX = pos.clientX; state.currentY = pos.clientY; if (!state.directionConfirmed) { const dX = Math.abs(state.currentX - state.startX); const dY = Math.abs(state.currentY - state.startY); if (dX > dY + 5) state.directionConfirmed = true; else if (dY > dX + 5) return onEnd(); } if (state.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); state.accX += state.currentX - state.startX; state.startX = state.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (state.dragging) showDisplay(state.accX); rafScheduled = false; }); } } }; const onEnd = () => { if (!state.dragging) return; if (state.directionConfirmed) applySeek(); Object.assign(state, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); }; const applySeek = () => { const delta = Math.round(state.accX / 2); if (Math.abs(delta) < 1) return; for (const media of activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); }; const showDisplay = pixels => { const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds; if (!display) { const root = uiManager.getShadowRoot(); if(!root) return; display = document.createElement('div'); display.id = 'vm-time-display'; root.appendChild(display); } const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mins}분 ${secs}초`; display.style.display = 'block'; display.style.opacity = '1'; }; const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } }; return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } }; })();
    const mediaSessionManager = (() => { const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); }; const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; }; const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; }; const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} }; return { setSession: m => { if (!('mediaSession' in navigator)) return; safeExec(() => { const { title, artist } = getMeta(); navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' }); setAction('play', () => m.play()); setAction('pause', () => m.pause()); setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); }); setAction('seekforward', () => { m.currentTime += getSeekTime(m); }); setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }); }, 'mediaSession.set'); }, clearSession: () => { if (!('mediaSession' in navigator) || activeMedia.size > 0) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); } }; })();

    const mediaListenerMap = new WeakMap();
    let intersectionObserver = null;
    function findAllMedia(doc = document) { const elems = []; safeExec(() => { elems.push(...doc.querySelectorAll('video, audio')); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...root.querySelectorAll('video, audio')); }); if (doc === document) doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) {} }); }); return [...new Set(elems)]; }

    function updateVideoFilterState(video) { if (!filterManager.isInitialized()) return; const isPlaying = !video.paused && !video.ended; const isVisible = video.dataset.isVisible === 'true'; const filterMode = filterManager.getFilterMode(); const shouldHaveFilter = isPlaying && isVisible && filterMode !== 'off'; filterManager.setSharpenLevel(filterMode); video.classList.toggle('video-filter-active', shouldHaveFilter); }
    const mediaEventHandlers = { play: e => { const m = e.target; audioManager.resumeContext(m); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); }, pause: e => { const m = e.target; audioManager.suspendContext(m); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (activeMedia.size <= 1) mediaSessionManager.clearSession(); }, ended: e => { const m = e.target; detachMediaListeners(m); if (activeMedia.size <= 1) mediaSessionManager.clearSession(); }, };
    function attachMediaListeners(media) { if (!media || processedMedia.has(media)) return; if (media.tagName === 'VIDEO') { if (!filterManager.isInitialized()) filterManager.init(); } audioManager.processMedia(media); const listeners = {}; for (const [evt, handler] of Object.entries(mediaEventHandlers)) { listeners[evt] = handler; media.addEventListener(evt, handler); } mediaListenerMap.set(media, listeners); processedMedia.add(media); if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.observe(media); }
    function detachMediaListeners(media) { if (!mediaListenerMap.has(media)) return; audioManager.cleanupMedia(media); const listeners = mediaListenerMap.get(media); for (const [evt, listener] of Object.entries(listeners)) media.removeEventListener(evt, listener); mediaListenerMap.delete(media); processedMedia.delete(media); if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.unobserve(media); }
    const scanForMedia = (isUiUpdateOnly = false) => { const allMedia = findAllMedia(); if (!isUiUpdateOnly) allMedia.forEach(attachMediaListeners); const oldMedia = new Set(activeMedia); activeMedia.clear(); allMedia.forEach(m => { if (m.isConnected) { activeMedia.add(m); oldMedia.delete(m); } }); oldMedia.forEach(detachMediaListeners); allMedia.forEach(m => { if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); } }); const shouldBeVisible = activeMedia.size > 0; if (isUiVisible !== shouldBeVisible) { isUiVisible = shouldBeVisible; if (isUiVisible) speedSlider.show(); else speedSlider.hide(); } };

    const debouncedScanTask = debounce(scanForMedia, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) attachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(attachMediaListeners); }); };
    const handleRemovedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) detachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(detachMediaListeners); }); };
    function initialize() {
        console.log('🎉 VideoSpeed_Control (Button Size Fix) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        intersectionObserver = new IntersectionObserver(entries => { entries.forEach(e => { e.target.dataset.isVisible = e.isIntersecting; if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target); }); }, { threshold: 0.1 });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active')); for (const media of activeMedia) { audioManager.suspendContext(media); } } else { scanForMedia(true); for (const media of activeMedia) { audioManager.resumeContext(media); } } });
        const mutationObserver = new MutationObserver(mutations => { let changed = false; for (const mut of mutations) { if (mut.type === 'childList') { if (mut.addedNodes.length > 0) { handleAddedNodes(mut.addedNodes); changed = true; } if (mut.removedNodes.length > 0) { handleRemovedNodes(mut.removedNodes); changed = true; } } } if (changed) scheduleIdleTask(() => scanForMedia()); });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function(...args) { let result; try { result = originalPushState.apply(this, args); } finally { scheduleIdleTask(() => scanForMedia()); } return result; };
        window.addEventListener('popstate', () => scheduleIdleTask(() => scanForMedia()));
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));
        window.addEventListener('beforeunload', () => { mutationObserver.disconnect(); intersectionObserver.disconnect(); });
        scanForMedia();
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') { initialize(); } else { window.addEventListener('DOMContentLoaded', initialize, { once: true }); }
})();
