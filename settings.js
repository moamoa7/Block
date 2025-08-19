// ==UserScript==
// @name         Video_Image_Control
// @namespace    https://com/
// @version      35.1
// @description  이미지.비디오.오디오 기본값 설정 기능 추가
// @match        *://*/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration and Constants ---
    const CONFIG = {
        // --- NEW: Default Filter Settings ---
        // 여기에서 비디오, 이미지, 오디오 필터의 기본 모드를 설정할 수 있습니다.
        // 페이지 로드 시 이 설정이 기본값으로 적용됩니다.
        DEFAULT_VIDEO_FILTER_MODE: 'medium', // 사용 가능한 값: 'off', 'low', 'medium', 'high'
        DEFAULT_IMAGE_FILTER_MODE: 'medium', // 사용 가능한 값: 'off', 'low', 'medium', 'high'
        DEFAULT_AUDIO_PRESET: 'movie',      // 사용 가능한 값: 'off', 'speech', 'movie', 'music'

        DEBUG: false,
        DEBOUNCE_DELAY: 350,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.05, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 105 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.05, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.6', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 105 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SHARPEN_LEVELS: {
            high:   '0 -1 0 -1 5.0 -1 0 -1 0',
            medium: '0 -0.5 0 -0.5 3.0 -0.5 0 -0.5 0',
            low:    '0 -0.3 0 -0.3 2.2 -0.3 0 -0.3 0',
            off:    '0 -0.1 0 -0.1 1.4 -0.1 0 -0.1 0',
        },
        IMAGE_SHARPEN_LEVELS: {
            high:   '0 -0.5 0 -0.5 3.0 -0.5 0 -0.5 0',
            medium: '0 -0.25 0 -0.25 2.0 -0.25 0 -0.25 0',
            low:    '0 -0.15 0 -0.15 1.6 -0.15 0 -0.15 0',
            off:    '0 -0.1 0 -0.1 1.4 -0.1 0 -0.1 0',
        },
        SITE_METADATA_RULES: {
            'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], },
            'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] },
            'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] },
        },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [], // For future use
        AUDIO_EXCLUSION_DOMAINS: ['www.youtube.com', 'm.youtube.com'],
        AUDIO_PRESETS: {
            off: { gain: 1, eq: [] },
            speech: {
                gain: 1.1,
                eq: [
                    { freq: 100, gain: -2 }, { freq: 250, gain: 1 }, { freq: 500, gain: 3 },
                    { freq: 1000, gain: 4 }, { freq: 2000, gain: 4.5 }, { freq: 4000, gain: 2 },
                    { freq: 8000, gain: -1 }
                ]
            },
            movie: {
                gain: 1.25,
                eq: [
                    { freq: 80, gain: 6 }, { freq: 200, gain: 4 }, { freq: 500, gain: 1 },
                    { freq: 1000, gain: 2 }, { freq: 3000, gain: 3.5 }, { freq: 6000, gain: 5 },
                    { freq: 10000, gain: 4 }
                ]
            },
            music: {
                gain: 1.1,
                eq: [
                    { freq: 60, gain: 5 }, { freq: 150, gain: 3 }, { freq: 400, gain: 1 },
                    { freq: 1000, gain: 0.5 }, { freq: 3000, gain: 2.5 }, { freq: 6000, gain: 4 },
                    { freq: 12000, gain: 3.5 }
                ]
            }
        },
        MAX_EQ_BANDS: 7,
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

    const state = {
        activeMedia: new Set(),
        processedMedia: new WeakSet(),
        activeImages: new Set(),
        processedImages: new WeakSet(),
        mediaListenerMap: new WeakMap(),
        isUiVisible: false,
        isMinimized: true,
        // --- MODIFIED: Initialize state with default values from CONFIG ---
        currentFilterMode: CONFIG.DEFAULT_VIDEO_FILTER_MODE || 'off',
        currentImageFilterMode: CONFIG.DEFAULT_IMAGE_FILTER_MODE || 'off',
        currentAudioMode: CONFIG.DEFAULT_AUDIO_PRESET || 'off',
        ui: { shadowRoot: null },
        rAF: { pendingSpeedUpdate: false, latestSpeed: 1.0 }
    };

    (function protectConsoleClear() { if (!CONFIG.DEBUG) return; safeExec(() => { if (window.console && console.clear) { const originalClear = console.clear; console.clear = () => console.log('--- 🚫 console.clear() blocked by VideoSpeed_Control (Debug Mode) ---'); Object.defineProperty(console, 'clear', { configurable: false, writable: false, value: console.clear }); } }, 'consoleClearProtection'); })();
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const originalAttachShadow = window.Element.prototype.attachShadow; window.Element.prototype.attachShadow = function (options) { const modifiedOptions = { ...options, mode: 'open' }; const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]); window._shadowDomList_.push(new WeakRef(shadowRoot)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } })); return shadowRoot; }; window._hasHackAttachShadow_ = true; }, 'hackAttachShadow'); })();

    const audioManager = (() => {
        const isAudioDisabledForSite = CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname);
        let ctx = null;
        let masterGain;
        const eqFilters = [];
        const sourceMap = new WeakMap();
        function ensureContext() {
            if (ctx || isAudioDisabledForSite) return;
            try {
                ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
                masterGain = ctx.createGain();
                for (let i = 0; i < CONFIG.MAX_EQ_BANDS; i++) {
                    const eqFilter = ctx.createBiquadFilter();
                    eqFilter.type = 'peaking';
                    eqFilters.push(eqFilter);
                    if (i > 0) {
                        eqFilters[i - 1].connect(eqFilter);
                    }
                }
                if (eqFilters.length > 0) {
                    eqFilters[eqFilters.length - 1].connect(masterGain);
                }
                masterGain.connect(ctx.destination);
            } catch(e) {
                if(CONFIG.DEBUG) console.error("[VideoSpeed] AudioContext creation failed:", e);
                ctx = null;
            }
        }
        function connectMedia(media) {
            if (sourceMap.has(media) || !ctx) return;
            if (ctx.state === 'suspended') { ctx.resume().catch(()=>{}); }
            const source = ctx.createMediaElementSource(media);
            const firstNode = eqFilters.length > 0 ? eqFilters[0] : masterGain;
            source.connect(firstNode);
            sourceMap.set(media, { source });
            applyAudioPresetToNodes();
        }
        function applyAudioPresetToNodes() {
            if (!ctx) return;
            const preset = CONFIG.AUDIO_PRESETS[state.currentAudioMode] || CONFIG.AUDIO_PRESETS.off;
            const now = ctx.currentTime;
            const rampTime = 0.05;
            masterGain.gain.cancelScheduledValues(now);
            masterGain.gain.linearRampToValueAtTime(preset.gain, now + rampTime);
            for (let i = 0; i < eqFilters.length; i++) {
                const band = preset.eq[i];
                const filter = eqFilters[i];
                filter.gain.cancelScheduledValues(now);
                filter.frequency.cancelScheduledValues(now);
                filter.Q.cancelScheduledValues(now);
                if (band) {
                    filter.frequency.setValueAtTime(band.freq, now);
                    filter.gain.linearRampToValueAtTime(band.gain, now + rampTime);
                    filter.Q.setValueAtTime(1.41, now);
                } else {
                    filter.frequency.setValueAtTime(1000, now);
                    filter.Q.setValueAtTime(1.41, now);
                    filter.gain.linearRampToValueAtTime(0, now + rampTime);
                }
            }
        }
        function processMedia(media) {
            if (isAudioDisabledForSite) return;
            media.addEventListener('play', () => {
                ensureContext();
                if (!ctx) return;
                connectMedia(media);
            }, { once: true });
        }
        function cleanupMedia(media) {
            if (isAudioDisabledForSite || !ctx) return;
            const rec = sourceMap.get(media);
            if (!rec) return;
            try {
                rec.source.disconnect();
                try {
                    if (rec.source && "mediaElement" in rec.source) {
                        rec.source.mediaElement = null;
                    }
                } catch (e) {}
            } catch (err) {
                if (CONFIG.DEBUG) console.warn("audioManager.cleanupMedia error:", err);
            } finally {
                sourceMap.delete(media);
            }
        }
        function setAudioMode(mode) {
            if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return;
            state.currentAudioMode = mode;
            applyAudioPresetToNodes();
        }
        function resetAudio() { setAudioMode('off'); }
        function suspendContext() {
            if (isAudioDisabledForSite || !ctx) return;
            const anyPlaying = Array.from(state.activeMedia).some(m => !m.paused && !m.ended);
            if (!anyPlaying && ctx.state === 'running') ctx.suspend().catch(()=>{});
        }
        function resumeContext() {
            if (isAudioDisabledForSite || !ctx) return;
            if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
        }
        return {
            processMedia, cleanupMedia, setAudioMode, resetAudio,
            suspendContext, resumeContext, getAudioMode: () => state.currentAudioMode
        };
    })();

    const uiManager = (() => {
        let host;
        function init() { if (host) return; host = document.createElement('div'); host.id = 'vsc-ui-host'; Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX }); state.ui.shadowRoot = host.attachShadow({ mode: 'open' }); const style = document.createElement('style'); style.textContent = `:host { pointer-events: none; }
                * { pointer-events: auto; }
                #vm-speed-slider-container { position: fixed; top: 50%; right: 0; transform: translateY(-50%); background: transparent; padding: 6px; border-radius: 8px 0 0 8px; z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.5s ease, background 0.2s; }
                #vm-speed-slider-container.touched, #vm-speed-slider-container.menu-visible { opacity: 1; }
                #vm-speed-slider-container.menu-visible { background: rgba(0,0,0,0.0); }
                @media (hover: hover) and (pointer: fine) { #vm-speed-slider-container:hover { opacity: 1; } }
                #vm-speed-slider-container.minimized { width: 50px; }
                #vm-speed-slider-container > :not(.toggle) { transition: opacity 0.2s, transform 0.2s; transform-origin: bottom; }
                #vm-speed-slider-container .vm-collapsible { display: flex; flex-direction: column; align-items: flex-end; width: 50px; margin-top: 4px; }
                #vm-speed-slider-container.minimized .vm-collapsible { opacity: 0; transform: scaleY(0); height: 0; margin: 0; padding: 0; visibility: hidden; }
                .vm-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: 4px; height: 28px; width: 25px; }
                .vm-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 0; margin-right: 5px; background: rgba(0,0,0,0.0); border-radius: 4px; padding: 2px; }
                .vm-control-group.submenu-visible .vm-submenu { display: flex; }
                .vm-btn { background: #444; color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; font-size:12px; }
                .vm-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }
                .vm-submenu .vm-btn { min-width: 24px; font-size: 14px; padding: 2px 4px; margin: 0 2px; }
                .vm-btn-main { font-size: 16px; padding: 2px 4px; width: 30px; height: 100%; }
                .vm-btn.reset, .vm-btn.toggle { font-size: 16px; padding: 0; width: 30px; height: 28px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
                .vm-btn.toggle { margin-top: 4px; }
                #vm-speed-slider { writing-mode: vertical-lr; direction: rtl; width: 32px; height: 60px; margin: 4px 0; accent-color: #e74c3c; touch-action: none; }
                #vm-speed-value { color: #f44336; font-weight:700; font-size:14px; text-shadow:1px 1px 2px rgba(0,0,0,.5); padding-right: 5px; }
                #vm-time-display { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:102; background:rgba(0,0,0,.7); color:#fff; padding:10px 20px; border-radius:5px; font-size:1.5rem; display:none; opacity:1; transition:opacity .3s ease-out; pointer-events:none; }`; state.ui.shadowRoot.appendChild(style); (document.body || document.documentElement).appendChild(host); }
        return { init: () => safeExec(init, 'uiManager.init'), moveUiTo: (target) => { if (host && target && host.parentNode !== target) target.appendChild(host); } };
    })();

    const filterManager = (() => {
        const isFilterDisabledForSite = CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        let isInitialized = false;
        const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
        function createSvgFiltersAndStyle() { if (document.getElementById('video-enhancer-svg-filters')) return; const settings = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS; const svg = createSvgElement('svg', { id: 'video-enhancer-svg-filters', style: 'display:none' }); const soft = createSvgElement('filter', { id: 'SofteningFilter' }); soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })); const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID }); sharp.appendChild(createSvgElement('feConvolveMatrix', { id: 'dynamic-convolve-matrix', order: '3 3', preserveAlpha: 'true', kernelMatrix: CONFIG.SHARPEN_LEVELS.off, mode: 'multiply' })); const gamma = createSvgElement('filter', { id: 'gamma-filter' }); const gammaTransfer = createSvgElement('feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); gamma.appendChild(gammaTransfer); const linear = createSvgElement('filter', { id: 'linear-adjust-filter' }); const linearTransfer = createSvgElement('feComponentTransfer'); const intercept = settings.SHADOWS_VALUE / 200; const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() }))); linear.appendChild(linearTransfer); svg.append(soft, sharp, gamma, linear); (document.body || document.documentElement).appendChild(svg); const style = document.createElement('style'); style.id = 'video-enhancer-styles'; style.textContent = `video.video-filter-active, iframe.video-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#gamma-filter) url(#SofteningFilter) url(#${settings.SHARPEN_ID}) url(#linear-adjust-filter) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`; (document.head || document.documentElement).appendChild(style); }
        function initialize() { if (isInitialized || isFilterDisabledForSite) return; safeExec(createSvgFiltersAndStyle, 'filter.init'); isInitialized = true; }
        function setSharpenLevel(level = 'off') { if (!isInitialized) return; const matrix = document.getElementById('dynamic-convolve-matrix'); if (matrix) { const newMatrix = CONFIG.SHARPEN_LEVELS[level]; if (matrix.getAttribute('kernelMatrix') !== newMatrix) matrix.setAttribute('kernelMatrix', newMatrix); } }
        function setFilterMode(mode) { if (isFilterDisabledForSite || !isInitialized || !CONFIG.SHARPEN_LEVELS[mode]) return; state.currentFilterMode = mode; for (const video of state.activeMedia) { updateVideoFilterState(video); } }
        function resetFilter() { setFilterMode('off'); }
        return { init: initialize, setFilterMode, getFilterMode: () => state.currentFilterMode, setSharpenLevel, resetFilter, isInitialized: () => isInitialized };
    })();

    const imageFilterManager = (() => {
        const isFilterDisabledForSite = CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname);
        let isInitialized = false;
        const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
        function createSvgFiltersAndStyle() { if (document.getElementById('image-enhancer-svg-filters')) return; const settings = CONFIG.IMAGE_FILTER_SETTINGS; const svg = createSvgElement('svg', { id: 'image-enhancer-svg-filters', style: 'display:none' }); const soft = createSvgElement('filter', { id: 'ImageSofteningFilter' }); soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION })); const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID }); sharp.appendChild(createSvgElement('feConvolveMatrix', { id: 'image-dynamic-convolve-matrix', order: '3 3', preserveAlpha: 'true', kernelMatrix: CONFIG.IMAGE_SHARPEN_LEVELS.off, mode: 'multiply' })); const gamma = createSvgElement('filter', { id: 'image-gamma-filter' }); const gammaTransfer = createSvgElement('feComponentTransfer'); ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); gamma.appendChild(gammaTransfer); const linear = createSvgElement('filter', { id: 'image-linear-adjust-filter' }); const linearTransfer = createSvgElement('feComponentTransfer'); const intercept = settings.SHADOWS_VALUE / 200; const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100); ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() }))); linear.appendChild(linearTransfer); svg.append(soft, sharp, gamma, linear); (document.body || document.documentElement).appendChild(svg); const style = document.createElement('style'); style.id = 'image-enhancer-styles'; style.textContent = `img.image-filter-active { filter: saturate(${settings.SATURATION_VALUE}%) url(#image-gamma-filter) url(#ImageSofteningFilter) url(#${settings.SHARPEN_ID}) url(#image-linear-adjust-filter) !important; }`; (document.head || document.documentElement).appendChild(style); }
        function initialize() { if (isInitialized || isFilterDisabledForSite) return; safeExec(createSvgFiltersAndStyle, 'imageFilter.init'); isInitialized = true; }
        function setSharpenLevel(level = 'off') { if (!isInitialized) return; const matrix = document.getElementById('image-dynamic-convolve-matrix'); if (matrix) { const newMatrix = CONFIG.IMAGE_SHARPEN_LEVELS[level]; if (matrix.getAttribute('kernelMatrix') !== newMatrix) matrix.setAttribute('kernelMatrix', newMatrix); } }
        function setFilterMode(mode) { if (isFilterDisabledForSite || !isInitialized || !CONFIG.IMAGE_SHARPEN_LEVELS[mode]) return; state.currentImageFilterMode = mode; for (const image of state.activeImages) { updateImageFilterState(image); } }
        function resetFilter() { setFilterMode('off'); }
        return { init: initialize, setFilterMode, getFilterMode: () => state.currentImageFilterMode, setSharpenLevel, resetFilter, isInitialized: () => isInitialized };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        const createButton = (id, title, text, className = 'vm-btn') => { const btn = document.createElement('button'); if (id) btn.id = id; btn.className = className; btn.title = title; btn.textContent = text; return btn; };
        function init() {
            if (inited) return;
            const shadowRoot = state.ui.shadowRoot; if (!shadowRoot) return;
            const container = document.createElement('div'); container.id = 'vm-speed-slider-container';

            const videoControlGroup = document.createElement('div'); videoControlGroup.id = 'vsc-video-controls'; videoControlGroup.className = 'vm-control-group'; videoControlGroup.style.position = 'relative';
            const audioControlGroup = document.createElement('div'); audioControlGroup.id = 'vsc-audio-controls'; audioControlGroup.className = 'vm-control-group'; audioControlGroup.style.position = 'relative';
            const imageControlGroup = document.createElement('div'); imageControlGroup.id = 'vsc-image-controls'; imageControlGroup.className = 'vm-control-group'; imageControlGroup.style.position = 'relative';

            const filterBtnMain = createButton('vm-main-filter-btn', 'Video Filter Settings', '🌞', 'vm-btn vm-btn-main');
            const audioBtnMain = createButton('vm-main-audio-btn', 'Audio Preset Settings', '🎧', 'vm-btn vm-btn-main');
            const imageBtnMain = createButton('vm-main-image-btn', 'Image Filter Settings', '🎨', 'vm-btn vm-btn-main');

            const filterSubMenu = document.createElement('div'); filterSubMenu.className = 'vm-submenu';
            const audioSubMenu = document.createElement('div'); audioSubMenu.className = 'vm-submenu';
            const imageSubMenu = document.createElement('div'); imageSubMenu.className = 'vm-submenu';

            const filterModes = { H: 'high', M: 'medium', L: 'low', '🚫': 'off' };
            Object.entries(filterModes).forEach(([text, mode]) => {
                const btn = createButton(null, `Filter: ${mode}`, text); btn.dataset.mode = mode; filterSubMenu.appendChild(btn);
                const imgBtn = createButton(null, `Image Filter: ${mode}`, text); imgBtn.dataset.mode = mode; imageSubMenu.appendChild(imgBtn);
            });
            const audioModes = { '🎙️': 'speech', '🎬': 'movie', '🎵': 'music', '🚫': 'off' };
            Object.entries(audioModes).forEach(([text, mode]) => { const btn = createButton(null, `Audio: ${mode}`, text); btn.dataset.mode = mode; audioSubMenu.appendChild(btn); });

            videoControlGroup.append(filterBtnMain, filterSubMenu);
            audioControlGroup.append(audioBtnMain, audioSubMenu);
            imageControlGroup.append(imageBtnMain, imageSubMenu);

            const collapsibleWrapper = document.createElement('div'); collapsibleWrapper.className = 'vm-collapsible';
            const resetBtn = createButton(null, 'Reset speed', '1x', 'vm-btn reset');
            const sliderEl = document.createElement('input'); Object.assign(sliderEl, { type: 'range', min: '0.2', max: '4.0', step: '0.2', value: '1.0', id: 'vm-speed-slider' });
            const valueEl = document.createElement('div'); valueEl.id = 'vm-speed-value'; valueEl.textContent = 'x1.0';
            collapsibleWrapper.append(resetBtn, sliderEl, valueEl);

            const toggleBtn = createButton(null, 'Toggle Speed Controller', '', 'vm-btn toggle');
            container.append(imageControlGroup, videoControlGroup, audioControlGroup, collapsibleWrapper, toggleBtn);
            shadowRoot.appendChild(container);

            if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) videoControlGroup.style.display = 'none';
            if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname)) imageControlGroup.style.display = 'none';
            if (CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname)) audioControlGroup.style.display = 'none';

            const controlGroups = [videoControlGroup, audioControlGroup, imageControlGroup];
            const updateActiveButtons = () => {
                const currentFilter = filterManager.getFilterMode();
                filterSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentFilter));
                filterBtnMain.classList.toggle('active', currentFilter !== 'off');

                const currentAudio = audioManager.getAudioMode();
                audioSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
                audioBtnMain.classList.toggle('active', currentAudio !== 'off');

                const currentImageFilter = imageFilterManager.getFilterMode();
                imageSubMenu.querySelectorAll('.vm-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentImageFilter));
                imageBtnMain.classList.toggle('active', currentImageFilter !== 'off');
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
            imageBtnMain.addEventListener('click', () => toggleSubMenu(imageControlGroup));

            filterSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { filterManager.setFilterMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });
            audioSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { audioManager.setAudioMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });
            imageSubMenu.addEventListener('click', (e) => { if (e.target.matches('.vm-btn')) { imageFilterManager.setFilterMode(e.target.dataset.mode); hideAllSubMenus(); updateActiveButtons(); } });

            const applySpeed = speed => { for (const media of state.activeMedia) if (media.playbackRate !== speed) safeExec(() => { media.playbackRate = speed; }); };
            const updateValueText = speed => { if (valueEl) valueEl.textContent = `x${speed.toFixed(1)}`; };
            const updateAppearance = () => { if (!container) return; container.classList.toggle('minimized', state.isMinimized); toggleBtn.textContent = state.isMinimized ? '🔻' : '🔺'; if (state.isMinimized) hideAllSubMenus(); };

            resetBtn.addEventListener('click', () => { sliderEl.value = '1.0'; state.rAF.latestSpeed = 1.0; applySpeed(1.0); updateValueText(1.0); });
            toggleBtn.addEventListener('click', () => { state.isMinimized = !state.isMinimized; updateAppearance(); });

            sliderEl.addEventListener('input', e => {
                const speed = parseFloat(e.target.value);
                updateValueText(speed);
                state.rAF.latestSpeed = speed;
                if (!state.rAF.pendingSpeedUpdate) {
                    state.rAF.pendingSpeedUpdate = true;
                    window.requestAnimationFrame(() => {
                        applySpeed(state.rAF.latestSpeed);
                        state.rAF.pendingSpeedUpdate = false;
                    });
                }
            });

            const endInteraction = () => { clearTimeout(fadeOutTimer); fadeOutTimer = setTimeout(() => container.classList.remove('touched'), 3000); };
            const onTouchEnd = () => { endInteraction(); document.removeEventListener('touchend', onTouchEnd); document.removeEventListener('touchcancel', onTouchEnd); };
            container.addEventListener('touchstart', () => { clearTimeout(fadeOutTimer); container.classList.add('touched'); document.addEventListener('touchend', onTouchEnd); document.addEventListener('touchcancel', onTouchEnd); }, { passive: true });
            sliderEl.addEventListener('change', endInteraction, { passive: true });
            sliderEl.addEventListener('blur', endInteraction, { passive: true });

            inited = true; updateAppearance(); updateActiveButtons();
        }
        return { init: () => safeExec(init, 'speedSlider.init'), show: () => { const el = state.ui.shadowRoot?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'flex'; }, hide: () => { const el = state.ui.shadowRoot?.getElementById('vm-speed-slider-container'); if (el) el.style.display = 'none'; }, isMinimized: () => state.isMinimized };
    })();

    const dragBar = (() => { let display, inited = false; let dragState = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false }; let lastDelta = 0; let rafScheduled = false; function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; } const getEventPosition = e => e.touches ? e.touches[0] : e; const onStart = e => safeExec(() => { if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return; const video = findAssociatedVideo(e.target); if (!video || video.paused || speedSlider.isMinimized() || e.composedPath().some(el => el.id === 'vm-speed-slider-container')) return; const pos = getEventPosition(e); Object.assign(dragState, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false }); const options = { passive: false, capture: true }; document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options); document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options); }, 'drag.start'); const onMove = e => { if (!dragState.dragging) return; if (e.touches && e.touches.length > 1) return onEnd(); const pos = getEventPosition(e); dragState.currentX = pos.clientX; dragState.currentY = pos.clientY; if (!dragState.directionConfirmed) { const dX = Math.abs(dragState.currentX - dragState.startX); const dY = Math.abs(dragState.currentY - dragState.startY); if (dX > dY + 5) dragState.directionConfirmed = true; else if (dY > dX + 5) return onEnd(); } if (dragState.directionConfirmed) { e.preventDefault(); e.stopImmediatePropagation(); dragState.accX += dragState.currentX - dragState.startX; dragState.startX = dragState.currentX; if (!rafScheduled) { rafScheduled = true; window.requestAnimationFrame(() => { if (dragState.dragging) showDisplay(dragState.accX); rafScheduled = false; }); } } }; const onEnd = () => { if (!dragState.dragging) return; if (dragState.directionConfirmed) applySeek(); Object.assign(dragState, { dragging: false, accX: 0, directionConfirmed: false }); hideDisplay(); document.removeEventListener('mousemove', onMove, true); document.removeEventListener('touchmove', onMove, true); document.removeEventListener('mouseup', onEnd, true); document.removeEventListener('touchend', onEnd, true); }; const applySeek = () => { const delta = Math.round(dragState.accX / 2); if (Math.abs(delta) < 1) return; for (const media of state.activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); }; const showDisplay = pixels => { const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds; if (!display) { const root = state.ui.shadowRoot; if(!root) return; display = document.createElement('div'); display.id = 'vm-time-display'; root.appendChild(display); } const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0'); display.textContent = `${sign}${mins}분 ${secs}초`; display.style.display = 'block'; display.style.opacity = '1'; }; const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } }; return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } }; })();
    const mediaSessionManager = (() => { const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); }; const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; }; const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; }; const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} }; return { setSession: m => { if (!('mediaSession' in navigator)) return; safeExec(() => { const { title, artist } = getMeta(); navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'VideoSpeed_Control' }); setAction('play', () => m.play()); setAction('pause', () => m.pause()); setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); }); setAction('seekforward', () => { m.currentTime += getSeekTime(m); }); setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }); }, 'mediaSession.set'); }, clearSession: () => { if (!('mediaSession' in navigator) || state.activeMedia.size > 0) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); } }; })();

    let intersectionObserver = null;
    function findAllMedia(doc = document) { const elems = []; safeExec(() => { elems.push(...doc.querySelectorAll('video, audio')); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...root.querySelectorAll('video, audio')); }); if (doc === document) doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) {} }); }); return [...new Set(elems)]; }
    function findAllImages(doc = document) { const elems = []; safeExec(() => { elems.push(...Array.from(doc.querySelectorAll('img')).filter(img => img.naturalWidth > 100 && img.naturalHeight > 100)); (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if(root) elems.push(...Array.from(root.querySelectorAll('img')).filter(img => img.naturalWidth > 100 && img.naturalHeight > 100)); }); }); return [...new Set(elems)]; }

    function updateVideoFilterState(video) { if (!filterManager.isInitialized()) return; const isPlaying = !video.paused && !video.ended; const isVisible = video.dataset.isVisible === 'true'; const filterMode = filterManager.getFilterMode(); const shouldHaveFilter = isPlaying && isVisible && filterMode !== 'off'; filterManager.setSharpenLevel(filterMode); video.classList.toggle('video-filter-active', shouldHaveFilter); }
    function updateImageFilterState(image) { if (!imageFilterManager.isInitialized()) return; const isVisible = image.dataset.isVisible === 'true'; const filterMode = imageFilterManager.getFilterMode(); const shouldHaveFilter = isVisible && filterMode !== 'off'; imageFilterManager.setSharpenLevel(filterMode); image.classList.toggle('image-filter-active', shouldHaveFilter); }

    const mediaEventHandlers = { play: e => { const m = e.target; audioManager.resumeContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); }, pause: e => { const m = e.target; audioManager.suspendContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); }, ended: e => { const m = e.target; detachMediaListeners(m); if (state.activeMedia.size <= 1) mediaSessionManager.clearSession(); }, };

    function attachMediaListeners(media) {
        if (!media || state.processedMedia.has(media)) return;
        if (media.tagName === 'VIDEO') { if (!filterManager.isInitialized()) filterManager.init(); }
        audioManager.processMedia(media);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) {
            listeners[evt] = handler;
            media.addEventListener(evt, handler);
        }
        state.mediaListenerMap.set(media, listeners);
        state.processedMedia.add(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.observe(media);
    }
    function detachMediaListeners(media) {
        if (!state.mediaListenerMap.has(media)) return;
        const listeners = state.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) {
            media.removeEventListener(evt, listener);
        }
        audioManager.cleanupMedia(media);
        state.mediaListenerMap.delete(media);
        state.processedMedia.delete(media);
        if (intersectionObserver && media.tagName === 'VIDEO') intersectionObserver.unobserve(media);
    }

    function attachImageListeners(image) {
        if (!image || state.processedImages.has(image)) return;
        if (!imageFilterManager.isInitialized()) imageFilterManager.init();
        state.processedImages.add(image);
        if (intersectionObserver) intersectionObserver.observe(image);
    }
    function detachImageListeners(image) {
        if (!state.processedImages.has(image)) return;
        state.processedImages.delete(image);
        if (intersectionObserver) intersectionObserver.unobserve(image);
    }

    const scanAndApply = () => {
        // Scan for Media (Video/Audio)
        const allMedia = findAllMedia();
        allMedia.forEach(attachMediaListeners);
        const oldMedia = new Set(state.activeMedia);
        state.activeMedia.clear();
        allMedia.forEach(m => { if (m.isConnected) { state.activeMedia.add(m); oldMedia.delete(m); } });
        oldMedia.forEach(detachMediaListeners);
        allMedia.forEach(m => { if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); } });

        // Scan for Images
        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);
        const oldImages = new Set(state.activeImages);
        state.activeImages.clear();
        allImages.forEach(img => { if (img.isConnected) { state.activeImages.add(img); oldImages.delete(img); } });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);

        // --- Dynamic UI Visibility Update ---
        const root = state.ui.shadowRoot;
        if (root) {
            const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
            const hasAudio = Array.from(state.activeMedia).some(m => m.tagName === 'AUDIO') || hasVideo; // Video usually has audio
            const hasImage = state.activeImages.size > 0;

            const videoControls = root.getElementById('vsc-video-controls');
            const audioControls = root.getElementById('vsc-audio-controls');
            const imageControls = root.getElementById('vsc-image-controls');

            const speedControlSlider = root.querySelector('.vm-collapsible');
            const toggleButton = root.querySelector('.vm-btn.toggle');

            if (videoControls) videoControls.style.display = hasVideo ? 'flex' : 'none';
            if (audioControls) audioControls.style.display = hasAudio ? 'flex' : 'none';
            if (imageControls) imageControls.style.display = hasImage ? 'flex' : 'none';

            const shouldShowSpeedControls = hasVideo || hasAudio;
            if (speedControlSlider) speedControlSlider.style.display = shouldShowSpeedControls ? 'flex' : 'none';
            if (toggleButton) toggleButton.style.display = shouldShowSpeedControls ? 'flex' : 'none';

            const anyMedia = hasVideo || hasAudio || hasImage;
            if (state.isUiVisible !== anyMedia) {
                state.isUiVisible = anyMedia;
                if (state.isUiVisible) speedSlider.show();
                else speedSlider.hide();
            }
        }
    };

    const debouncedScanTask = debounce(scanAndApply, CONFIG.DEBOUNCE_DELAY);
    const handleAddedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) attachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(attachMediaListeners); if (n.matches?.('img')) attachImageListeners(n); n.querySelectorAll?.('img').forEach(attachImageListeners); }); };
    const handleRemovedNodes = nodes => { nodes.forEach(n => { if (n.nodeType !== 1) return; if (n.matches?.('video, audio')) detachMediaListeners(n); n.querySelectorAll?.('video, audio').forEach(detachMediaListeners); if (n.matches?.('img')) detachImageListeners(n); n.querySelectorAll?.('img').forEach(detachImageListeners); }); };

    function initialize() {
        console.log('🎉 VideoSpeed_Control (Refactor) Initialized.');
        uiManager.init();
        speedSlider.init();
        dragBar.init();
        intersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(e => {
                e.target.dataset.isVisible = e.isIntersecting;
                if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target);
                if (e.target.tagName === 'IMG') updateImageFilterState(e.target);
            });
        }, { threshold: 0.1 });
        document.addEventListener('visibilitychange', () => { if (document.hidden) { document.querySelectorAll('video.video-filter-active').forEach(v => v.classList.remove('video-filter-active')); for (const media of state.activeMedia) { audioManager.suspendContext(); } } else { scheduleIdleTask(scanAndApply); for (const media of state.activeMedia) { audioManager.resumeContext(); } } });
        const mutationObserver = new MutationObserver(mutations => { let changed = false; for (const mut of mutations) { if (mut.type === 'childList') { if (mut.addedNodes.length > 0) { handleAddedNodes(mut.addedNodes); changed = true; } if (mut.removedNodes.length > 0) { handleRemovedNodes(mut.removedNodes); changed = true; } } } if (changed) scheduleIdleTask(scanAndApply); });
        mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener('addShadowRoot', debouncedScanTask);
        const originalPushState = history.pushState; history.pushState = function(...args) { let result; try { result = originalPushState.apply(this, args); } finally { scheduleIdleTask(scanAndApply); } return result; };
        window.addEventListener('popstate', () => scheduleIdleTask(scanAndApply));
        document.addEventListener('fullscreenchange', () => uiManager.moveUiTo(document.fullscreenElement || document.body));
        window.addEventListener('beforeunload', () => { mutationObserver.disconnect(); if (intersectionObserver) intersectionObserver.disconnect(); });
        scheduleIdleTask(scanAndApply);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        initialize();
    } else {
        window.addEventListener('DOMContentLoaded', initialize, { once: true });
    }
})();
