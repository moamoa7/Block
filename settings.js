// ==UserScript==
// @name         Video_Image_Control (v51.4 Final-Mod)
// @namespace    https://com/
// @version      50.0
// @description  초기 대표 아이콘 처리 일원화 / 화면 로딩 후 처리방식으로 전환
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =================================================================================
    // 1. 설정 및 상수 (Configuration and Constants)
    // =================================================================================

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 5 : 4,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 4 : 2,
        DEFAULT_AUDIO_PRESET: 'movie',
        LONG_PRESS_RATE: 4.0,
        DEBUG: false,
        DEBOUNCE_DELAY: 300,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 350,
        LIVE_STREAM_URLS: ['play.sooplive.co.kr/', 'chzzk.naver.com/'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.20, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 110 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.05, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.6', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 105 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: [],
        AUDIO_PRESETS: { off: { gain: 1, eq: [] }, speech: { gain: 1.1, eq: [{ freq: 100, gain: -2 }, { freq: 250, gain: 1 }, { freq: 500, gain: 3 }, { freq: 1000, gain: 4 }, { freq: 2000, gain: 4.5 }, { freq: 4000, gain: 2 }, { freq: 8000, gain: -1 }] }, movie: { gain: 1.25, eq: [{ freq: 80, gain: 6 }, { freq: 200, gain: 4 }, { freq: 500, gain: 1 }, { freq: 1000, gain: 2 }, { freq: 3000, gain: 3.5 }, { freq: 6000, gain: 5 }, { freq: 10000, gain: 4 }] }, music: { gain: 1.1, eq: [{ freq: 60, gain: 5 }, { freq: 150, gain: 3 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 0.5 }, { freq: 3000, gain: 2.5 }, { freq: 6000, gain: 4 }, { freq: 12000, gain: 3.5 }] } },
        MAX_EQ_BANDS: 7,
        DELAY_ADJUSTER: { CHECK_INTERVAL: 100, HISTORY_DURATION: 2000, TRIGGER_DELAY: 1500, TARGET_DELAY: 1000, SPEED_LEVELS: [{ minDelay: 5000, playbackRate: 1.3 }, { minDelay: 3000, playbackRate: 1.25 }, { minDelay: 2500, playbackRate: 1.2 }, { minDelay: 2000, playbackRate: 1.15 }, { minDelay: 1500, playbackRate: 1.1 }, { minDelay: 0, playbackRate: 1.05 }], NORMAL_RATE: 1.0 }
    };

    const UI_SELECTORS = {
        HOST: 'vsc-ui-host',
        CONTAINER: 'vsc-container',
        TRIGGER: 'vsc-trigger-button',
        CONTROL_GROUP: 'vsc-control-group', SUBMENU: 'vsc-submenu', BTN: 'vsc-btn', BTN_MAIN: 'vsc-btn-main', SELECT: 'vsc-select', VIDEO_CONTROLS: 'vsc-video-controls', IMAGE_CONTROLS: 'vsc-image-controls', AUDIO_CONTROLS: 'vsc-audio-controls', SPEED_CONTROLS: 'vsc-speed-controls', PIP_CONTROLS: 'vsc-pip-controls', DRAG_HANDLE_GROUP: 'vsc-drag-handle-group', DRAG_HANDLE: 'vsc-drag-handle',
    };

    // =================================================================================
    // 2. 상태 및 유틸리티 (State and Utilities)
    // =================================================================================

    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 6 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 6 },
            audioPreset: { name: '기본 오디오 프리셋', default: CONFIG.DEFAULT_AUDIO_PRESET, type: 'string', options: ['off', 'speech', 'movie', 'music'] },
            longPressRate: { name: '길게 눌러 재생 배속', default: CONFIG.LONG_PRESS_RATE, type: 'number', min: 1, max: 16 }
        };
        function init() { Object.keys(definitions).forEach(key => { settings[key] = definitions[key].default; }); }
        const get = (key) => settings[key];
        const set = (key, value) => { settings[key] = value; };
        return { init, get, set, definitions };
    })();

    settingsManager.init();

    const state = {};
    function resetState() {
        Object.keys(state).forEach(key => delete state[key]);
        Object.assign(state, {
            activeMedia: new Set(),
            processedMedia: new WeakSet(),
            activeImages: new Set(),
            processedImages: new WeakSet(),
            mediaListenerMap: new WeakMap(),
            isUiVisible: false,
            isMinimized: true,
            isDragSeekEnabled: false,
            currentVideoFilterLevel: settingsManager.get('videoFilterLevel') || 0,
            currentImageFilterLevel: settingsManager.get('imageFilterLevel') || 0,
            currentAudioMode: settingsManager.get('audioPreset') || 'off',
            ui: { shadowRoot: null, hostElement: null },
            delayHistory: [],
            isDelayAdjusting: false,
            delayCheckInterval: null,
            currentPlaybackRate: 1.0,
            isPipActive: false,
            mediaTypesEverFound: { video: false, audio: false, image: false },
            lastUrl: ''
        });
    }

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    function calculateSharpenMatrix(level) { const parsedLevel = parseInt(level, 10); if (isNaN(parsedLevel) || parsedLevel === 0) return '0 0 0 0 1 0 0 0 0'; const intensity = 1.0 + (parsedLevel - 1) * (5.0 / 5); const off = (1 - intensity) / 4; return `0 ${off} 0 ${off} ${intensity} ${off} 0 ${off} 0`; }
    function isLiveStreamPage() { const url = location.href; return CONFIG.LIVE_STREAM_URLS.some(pattern => url.includes(pattern)); }
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path)); }
    if (isExcluded()) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const originalAttachShadow = Element.prototype.attachShadow; Element.prototype.attachShadow = function (options) { const modifiedOptions = { ...options, mode: 'open' }; const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]); window._shadowDomList_.push(new WeakRef(shadowRoot)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } })); return shadowRoot; }; window._hasHackAttachShadow_ = true; }, 'openAllShadowRoots'); })();

    // =================================================================================
    // 3. 핵심 모듈 (Core Modules)
    // =================================================================================

    class SvgFilterManager {
        #isInitialized = false; #styleElement = null; #svgNode = null; #options;
        constructor(options) { this.#options = options; }
        getSvgNode() { return this.#svgNode; }
        isInitialized() { return this.#isInitialized; }
        toggleStyleSheet(enable) { if (this.#styleElement) this.#styleElement.media = enable ? 'all' : 'none'; }
        init() {
            if (this.#isInitialized) return;
            safeExec(() => {
                const { svgNode, styleElement } = this.#createElements();
                this.#svgNode = svgNode; this.#styleElement = styleElement;
                (document.body || document.documentElement).appendChild(this.#svgNode);
                (document.head || document.documentElement).appendChild(this.#styleElement);
                this.#isInitialized = true;
            }, `${this.constructor.name}.init`);
        }
        setSharpenMatrix(matrix, rootNode = document) {
            if (!this.isInitialized()) return;
            const matrixEl = rootNode.getElementById(this.#options.matrixId);
            if (matrixEl && matrixEl.getAttribute('kernelMatrix') !== matrix) {
                matrixEl.setAttribute('kernelMatrix', matrix);
            }
        }
        #createElements() {
            const createSvgElement = (tag, attr) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); return el; };
            const { settings, svgId, styleId, matrixId, className } = this.#options;
            const svg = createSvgElement('svg', { id: svgId, style: 'display:none; position:absolute; width:0; height:0;' });
            const soft = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_soft` });
            soft.appendChild(createSvgElement('feGaussianBlur', { stdDeviation: settings.BLUR_STD_DEVIATION }));
            const sharp = createSvgElement('filter', { id: settings.SHARPEN_ID });
            sharp.appendChild(createSvgElement('feConvolveMatrix', { id: matrixId, order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', mode: 'multiply' }));
            const gamma = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_gamma` });
            const gammaTransfer = createSvgElement('feComponentTransfer');
            ['R', 'G', 'B'].forEach(ch => gammaTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })));
            gamma.appendChild(gammaTransfer);
            const linear = createSvgElement('filter', { id: `${settings.SHARPEN_ID}_linear` });
            const linearTransfer = createSvgElement('feComponentTransfer');
            const intercept = settings.SHADOWS_VALUE / 200;
            const slope = 1 + (settings.HIGHLIGHTS_VALUE / 100);
            ['R', 'G', 'B'].forEach(ch => linearTransfer.appendChild(createSvgElement(`feFunc${ch}`, { type: 'linear', slope: slope.toString(), intercept: intercept.toString() })));
            linear.appendChild(linearTransfer);
            svg.append(soft, sharp, gamma, linear);
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `.${className} { filter: saturate(${settings.SATURATION_VALUE}%) url(#${gamma.id}) url(#${soft.id}) url(#${sharp.id}) url(#${linear.id}) !important; } .vsc-gpu-accelerated { transform: translateZ(0); will-change: transform; }`;
            return { svgNode: svg, styleElement: style };
        }
    }
    const filterManager = new SvgFilterManager({ settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', matrixId: 'vsc-dynamic-convolve-matrix', className: 'vsc-video-filter-active' });
    const imageFilterManager = new SvgFilterManager({ settings: CONFIG.IMAGE_FILTER_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', matrixId: 'vsc-image-convolve-matrix', className: 'vsc-image-filter-active' });

    function setVideoFilterLevel(level) {
        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!filterManager.isInitialized() && level > 0) filterManager.init();

        const newLevel = parseInt(level, 10);
        state.currentVideoFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('videoFilterLevel', state.currentVideoFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentVideoFilterLevel);
        filterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => filterManager.setSharpenMatrix(newMatrix, root));
        state.activeMedia.forEach(media => {
            if (media.tagName === 'VIDEO') updateVideoFilterState(media);
        });
    }

    function setImageFilterLevel(level) {
        if (CONFIG.IMAGE_FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!imageFilterManager.isInitialized() && level > 0) imageFilterManager.init();

        const newLevel = parseInt(level, 10);
        state.currentImageFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('imageFilterLevel', state.currentImageFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentImageFilterLevel);
        imageFilterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => imageFilterManager.setSharpenMatrix(newMatrix, root));
        state.activeImages.forEach(image => updateImageFilterState(image));
    }

    const audioManager = (() => {
        const isAudioDisabledForSite = CONFIG.AUDIO_EXCLUSION_DOMAINS.includes(location.hostname);
        let ctx = null, masterGain;
        const eqFilters = [], sourceMap = new WeakMap();
        function ensureContext() {
            if (ctx || isAudioDisabledForSite) return;
            try {
                ctx = new(window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
                masterGain = ctx.createGain();
                for (let i = 0; i < CONFIG.MAX_EQ_BANDS; i++) {
                    const eqFilter = ctx.createBiquadFilter(); eqFilter.type = 'peaking';
                    eqFilters.push(eqFilter);
                    if (i > 0) eqFilters[i - 1].connect(eqFilter);
                }
                if (eqFilters.length > 0) eqFilters[eqFilters.length - 1].connect(masterGain);
                masterGain.connect(ctx.destination);
            } catch (e) { if (CONFIG.DEBUG) console.error("[VSC] AudioContext creation failed:", e); ctx = null; }
        }
        function connectMedia(media) {
            if (!ctx) return;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            let rec = sourceMap.get(media);
            if (!rec) { const source = ctx.createMediaElementSource(media); rec = { source }; sourceMap.set(media, rec); }
            try { rec.source.disconnect(); } catch (e) {}
            const firstNode = eqFilters.length > 0 ? eqFilters[0] : masterGain;
            rec.source.connect(firstNode);
            applyAudioPresetToNodes();
        }
        function applyAudioPresetToNodes() {
            if (!ctx) return;
            const preset = CONFIG.AUDIO_PRESETS[state.currentAudioMode] || CONFIG.AUDIO_PRESETS.off;
            const now = ctx.currentTime, rampTime = 0.05;
            masterGain.gain.cancelScheduledValues(now);
            masterGain.gain.linearRampToValueAtTime(preset.gain, now + rampTime);
            for (let i = 0; i < eqFilters.length; i++) {
                const band = preset.eq[i], filter = eqFilters[i];
                filter.gain.cancelScheduledValues(now); filter.frequency.cancelScheduledValues(now); filter.Q.cancelScheduledValues(now);
                if (band) { filter.frequency.setValueAtTime(band.freq, now); filter.gain.linearRampToValueAtTime(band.gain, now + rampTime); filter.Q.setValueAtTime(1.41, now); }
                else { filter.frequency.setValueAtTime(1000, now); filter.Q.setValueAtTime(1.41, now); filter.gain.linearRampToValueAtTime(0, now + rampTime); }
            }
        }
        function processMedia(media) {
            if (isAudioDisabledForSite) return;
            media.addEventListener('play', () => {
                ensureContext(); if (!ctx) return;
                if (!sourceMap.has(media)) connectMedia(media); else resumeContext();
            });
        }
        function cleanupMedia(media) {
            if (isAudioDisabledForSite || !ctx) return;
            const rec = sourceMap.get(media); if (!rec) return;
            try { rec.source.disconnect(); }
            catch (err) { if (CONFIG.DEBUG) console.warn("audioManager.cleanupMedia error:", err); }
        }
        function setAudioMode(mode) { if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return; state.currentAudioMode = mode; settingsManager.set('audioPreset', mode); applyAudioPresetToNodes(); }
        function suspendContext() { safeExec(() => { const anyPlaying = Array.from(state.activeMedia).some(m => !m.paused && !m.ended); if (ctx && !anyPlaying && ctx.state === 'running') ctx.suspend().catch(() => {}); }); }
        function resumeContext() { safeExec(() => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }); }
        function closeContext() {
            if (ctx && ctx.state !== 'closed') {
                ctx.close().then(() => ctx = null).catch(() => { ctx = null; });
            }
        }
        return { processMedia, cleanupMedia, setAudioMode, getAudioMode: () => state.currentAudioMode, suspendContext, resumeContext, closeContext };
    })();

    const uiManager = (() => {
        const styleRules = [
            ':host { pointer-events: none; }',
            '* { pointer-events: auto; }',
            '#vsc-container { position: fixed; top: 50%; right: 40px; background: rgba(0,0,0,0.1); padding: 6px; border-radius: 8px; z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.3s; transform: translateY(-50%); }',
            '#vsc-container.touched { opacity: 1; }',
            '@media (hover: hover) { #vsc-container:hover { opacity: 1; } }',
            '.vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: 4px; height: 28px; width: 30px; position: relative; }',
            '.vsc-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: 5px; background: rgba(0,0,0,0.7); border-radius: 4px; padding: 5px; align-items: center; }',
            '.vsc-control-group.submenu-visible .vsc-submenu { display: flex; }',
            '.vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius:4px; border:none; padding:4px 6px; cursor:pointer; font-size:12px; }',
            '.vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }',
            '.vsc-submenu .vsc-btn { min-width: 24px; font-size: 14px; padding: 2px 4px; margin: 0 2px; }',
            '.vsc-btn-main { font-size: 16px; padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
            '.vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: 4px; padding: 4px 6px; font-size: 13px; }',
            '#vsc-time-display, #vsc-delay-info, #vsc-gesture-indicator { position:fixed; z-index:10001; background:rgba(0,0,0,.7); color:#fff; padding:5px 10px; border-radius:5px; font-size:1.2rem; pointer-events:none; }',
            '#vsc-time-display, #vsc-gesture-indicator { top:50%; left:50%; transform:translate(-50%,-50%); }',
            '#vsc-delay-info { display: flex; align-items: center; bottom: 10px; left: 10px; font-family: monospace; font-size: 10pt; line-height: 1.2; opacity: 0.8; }',
            '.vsc-loading-indicator { font-size: 16px; color: white; width: 30px; height: 28px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
            '#vsc-pip-btn { background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 36 36\' width=\'100%25\' height=\'100%25\'%3E%3Cpath d=\'M25,17 L17,17 L17,23 L25,23 L25,17 L25,17 Z M29,25 L29,10.98 C29,9.88 28.1,9 27,9 L9,9 C7.9,9 7,9.88 7,10.98 L7,25 C7,26.1 7.9,27 9,27 L27,27 C28.1,27 29,26.1 29,25 L29,25 Z M27,25.02 L9,25.02 L9,10.97 L27,10.97 L27,25.02 L27,25.02 Z\' fill=\'%23fff\'/%3E%3C/svg%3E") no-repeat center; background-size: 70% 70%; }',
        ];
        function init() {
            if (state.ui.hostElement) return;
            const host = document.createElement('div');
            host.id = UI_SELECTORS.HOST;
            Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: CONFIG.MAX_Z_INDEX });
            state.ui.shadowRoot = host.attachShadow({ mode: 'open' });
            state.ui.hostElement = host;
            const style = document.createElement('style');
            style.textContent = styleRules.join('\n');
            state.ui.shadowRoot.appendChild(style);
            // [FIX] UI가 전체화면 iframe 내에서 재호출될 때 올바른 위치에 나타나도록 수정
            const attachTarget = document.fullscreenElement || document.body || document.documentElement;
            attachTarget.appendChild(host);
        }
        function reset() {
            // state is reset globally in resetState()
        }
        return {
            init: () => safeExec(init, 'uiManager.init'),
            reset: () => safeExec(reset, 'uiManager.reset'),
            moveUiTo: (target) => { if (state.ui.hostElement && target && state.ui.hostElement.parentNode !== target) target.appendChild(state.ui.hostElement); },
        };
    })();

    const pipButtonManager = (() => {
        let isPipAvailable = ('pictureInPictureEnabled' in document);
        const togglePIP = () => {
            safeExec(() => {
                if (document.pictureInPictureElement) { document.exitPictureInPicture(); state.isPipActive = false; return; }
                const playingVideo = Array.from(state.activeMedia).find((media) => media.tagName === 'VIDEO' && !media.paused && !media.ended && media.currentTime > 0);
                const videoToShow = playingVideo || Array.from(state.activeMedia).find(media => media.tagName === 'VIDEO');
                if (videoToShow) videoToShow.requestPictureInPicture().then(() => { state.isPipActive = true; }).catch(console.error);
            });
        };
        const createButton = () => {
            if (!isPipAvailable) return null;
            const btn = document.createElement('button');
            btn.id = 'vsc-pip-btn';
            btn.className = 'vsc-btn vsc-btn-main';
            btn.title = '화면 속 화면 (PIP)';
            btn.addEventListener('click', togglePIP);
            return btn;
        };
        return { createButton, isAvailable: () => isPipAvailable };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        let hideAllSubMenus = () => {};

        function reset() {
            inited = false;
        }

        const createButton = (id, title, text, className = 'vsc-btn') => {
            const btn = document.createElement('button');
            if (id) btn.id = id;
            btn.className = className;
            btn.title = title;
            btn.textContent = text;
            return btn;
        };

        const resetFadeTimer = () => {
            const container = state.ui.shadowRoot?.getElementById('vsc-container');
            if (!container) return;
            clearTimeout(fadeOutTimer);
            container.style.opacity = '';
            container.classList.add('touched');
            fadeOutTimer = setTimeout(() => {
                container.classList.remove('touched');
                container.style.opacity = '0.3';
            }, 3000);
        };

        function init() {
            if (inited) return;
            const shadowRoot = state.ui.shadowRoot;
            if (!shadowRoot) return;
            const container = document.createElement('div');
            container.id = 'vsc-container';
            shadowRoot.appendChild(container);
            inited = true;
        }

        function renderControls() {
            const shadowRoot = state.ui.shadowRoot;
            if (!shadowRoot) return;
            const container = shadowRoot.getElementById('vsc-container');
            if (!container || container.dataset.rendered) return;

            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }
            container.dataset.rendered = 'true';
            const createFilterControl = (id, labelText, mainIcon, changeHandler, maxLevel) => {
                const group = document.createElement('div');
                group.id = id;
                group.className = 'vsc-control-group';
                const mainBtn = createButton(null, labelText, mainIcon, 'vsc-btn vsc-btn-main');
                const subMenu = document.createElement('div');
                subMenu.className = 'vsc-submenu';
                const select = document.createElement('select');
                select.className = 'vsc-select';

                const disabledOption = document.createElement('option');
                disabledOption.value = "";
                disabledOption.textContent = labelText;
                disabledOption.disabled = true;
                disabledOption.selected = true;
                select.appendChild(disabledOption);

                const offOption = document.createElement('option');
                offOption.value = "0";
                offOption.textContent = "꺼짐";
                select.appendChild(offOption);

                for (let i = 1; i <= maxLevel; i++) {
                    const option = document.createElement('option');
                    option.value = i;
                    option.textContent = `${i}단계`;
                    select.appendChild(option);
                }
                select.addEventListener('change', e => {
                    changeHandler(e.target.value);
                    hideAllSubMenus();
                });
                subMenu.appendChild(select);
                group.append(mainBtn, subMenu);
                return group;
            };

            const maxVideoLevel = settingsManager.definitions.videoFilterLevel.max;
            const maxImageLevel = settingsManager.definitions.imageFilterLevel.max;
            const videoControlGroup = createFilterControl('vsc-video-controls', '영상 선명도', '🌞', setVideoFilterLevel, maxVideoLevel);
            const imageControlGroup = createFilterControl('vsc-image-controls', '이미지 선명도', '🎨', setImageFilterLevel, maxImageLevel);
            const audioControlGroup = document.createElement('div');
            audioControlGroup.id = 'vsc-audio-controls';
            audioControlGroup.className = 'vsc-control-group';
            const audioBtnMain = createButton('vsc-audio-btn', '오디오 프리셋', '🎧', 'vsc-btn vsc-btn-main');
            const audioSubMenu = document.createElement('div');
            audioSubMenu.className = 'vsc-submenu';
            const audioModes = { '🎙️': 'speech', '🎬': 'movie', '🎵': 'music', '🚫': 'off' };
            Object.entries(audioModes).forEach(([text, mode]) => {
                const btn = createButton(null, `오디오: ${mode}`, text);
                btn.dataset.mode = mode;
                audioSubMenu.appendChild(btn);
            });
            audioControlGroup.append(audioBtnMain, audioSubMenu);
            const speedControlGroup = document.createElement('div');
            speedControlGroup.id = 'vsc-speed-controls';
            speedControlGroup.className = 'vsc-control-group';
            const speedBtnMain = createButton('vsc-speed-btn', '속도 조절', '⏱️', 'vsc-btn vsc-btn-main');
            const speedSubMenu = document.createElement('div');
            speedSubMenu.className = 'vsc-submenu';
            speedSubMenu.style.gap = '4px';
            const speedSelect = document.createElement('select');
            speedSelect.className = 'vsc-select';
            const speeds = [0.2, 1, 2, 3, 4];
            speeds.forEach(speed => {
                const option = document.createElement('option');
                option.value = speed;
                option.textContent = `${speed}x`;
                if (speed === 1.0) option.selected = true;
                speedSelect.appendChild(option);
            });
            speedSelect.addEventListener('change', e => {
                const newSpeed = parseFloat(e.target.value);
                for (const media of state.activeMedia) {
                    if (media.playbackRate !== newSpeed) safeExec(() => {
                        media.playbackRate = newSpeed;
                    });
                }
            });
            const dragToggleBtn = createButton('vsc-drag-toggle', '', '', 'vsc-btn');
            dragToggleBtn.style.width = '30px';
            dragToggleBtn.style.height = '28px';
            const updateDragToggleBtn = () => {
                if (state.isDragSeekEnabled) {
                    dragToggleBtn.textContent = '✋';
                    dragToggleBtn.title = '드래그 탐색 끄기';
                    dragToggleBtn.classList.add('active');
                } else {
                    dragToggleBtn.textContent = '🚫';
                    dragToggleBtn.title = '드래그 탐색 켜기';
                    dragToggleBtn.classList.remove('active');
                }
            };
            dragToggleBtn.addEventListener('click', () => {
                state.isDragSeekEnabled = !state.isDragSeekEnabled;
                updateDragToggleBtn();
            });
            updateDragToggleBtn();
            speedSubMenu.append(speedSelect, dragToggleBtn);
            speedControlGroup.append(speedBtnMain, speedSubMenu);
            const pipControlGroup = document.createElement('div');
            pipControlGroup.id = 'vsc-pip-controls';
            pipControlGroup.className = 'vsc-control-group';
            const pipBtn = pipButtonManager.createButton();
            if (pipBtn) {
                pipControlGroup.appendChild(pipBtn);
            }
            const dragHandleBtn = createButton('vsc-drag-handle', 'UI 이동', '✥', 'vsc-btn vsc-btn-main');
            dragHandleBtn.style.cursor = 'grab';
            const dragHandleGroup = document.createElement('div');
            dragHandleGroup.id = 'vsc-drag-handle-group';
            dragHandleGroup.className = 'vsc-control-group';
            dragHandleGroup.appendChild(dragHandleBtn);
            container.append(imageControlGroup, videoControlGroup, audioControlGroup, speedControlGroup, pipControlGroup, dragHandleGroup);
            const controlGroups = [videoControlGroup, imageControlGroup, audioControlGroup, speedControlGroup];
            hideAllSubMenus = () => {
                controlGroups.forEach(group => group.classList.remove('submenu-visible'));
            };
            const handleMenuButtonClick = (e, groupToShow) => {
                e.stopPropagation();
                const isOpening = !groupToShow.classList.contains('submenu-visible');
                hideAllSubMenus();
                if (isOpening) {
                    groupToShow.classList.add('submenu-visible');
                }
                resetFadeTimer();
            };
            videoControlGroup.querySelector('.vsc-btn-main').addEventListener('click', (e) => handleMenuButtonClick(e, videoControlGroup));
            imageControlGroup.querySelector('.vsc-btn-main').addEventListener('click', (e) => handleMenuButtonClick(e, imageControlGroup));
            audioBtnMain.addEventListener('click', (e) => handleMenuButtonClick(e, audioControlGroup));
            speedBtnMain.addEventListener('click', (e) => handleMenuButtonClick(e, speedControlGroup));
            const updateActiveButtons = () => {
                const videoSelect = shadowRoot.querySelector('#vsc-video-controls select');
                if (videoSelect) {
                    videoSelect.value = state.currentVideoFilterLevel;
                }
                const imageSelect = shadowRoot.querySelector('#vsc-image-controls select');
                if (imageSelect) {
                    imageSelect.value = state.currentImageFilterLevel;
                }
                const currentAudio = state.currentAudioMode;
                audioSubMenu.querySelectorAll('.vsc-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
            };
            audioSubMenu.addEventListener('click', (e) => {
                if (e.target.matches('.vsc-btn')) {
                    e.stopPropagation();
                    audioManager.setAudioMode(e.target.dataset.mode);
                    hideAllSubMenus();
                    updateActiveButtons();
                    resetFadeTimer();
                }
            });
            const dragState = { isDragging: false, hasMoved: false, startX: 0, startY: 0 };
            const DRAG_THRESHOLD = 5;
            const onDragStart = (e) => {
                if (!dragHandleBtn.contains(e.target)) return;
                e.preventDefault();
                e.stopPropagation();
                dragState.isDragging = true;
                dragState.hasMoved = false;
                const pos = e.touches ? e.touches[0] : e;
                dragState.startX = pos.clientX;
                dragState.startY = pos.clientY;
                const rect = container.getBoundingClientRect();
                dragState.initialTop = rect.top;
                dragState.initialRight = window.innerWidth - rect.right;
                dragHandleBtn.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onDragMove, { passive: false });
                document.addEventListener('mouseup', onDragEnd, { passive: false });
                document.addEventListener('touchmove', onDragMove, { passive: false });
                document.addEventListener('touchend', onDragEnd, { passive: false });
            };
            const onDragMove = (e) => {
                if (!dragState.isDragging) return;
                const pos = e.touches ? e.touches[0] : e;
                const totalDeltaX = pos.clientX - dragState.startX;
                const totalDeltaY = pos.clientY - dragState.startY;
                if (!dragState.hasMoved && (Math.abs(totalDeltaX) > DRAG_THRESHOLD || Math.abs(totalDeltaY) > DRAG_THRESHOLD)) {
                    dragState.hasMoved = true;
                    container.style.transform = 'none';
                }
                if (dragState.hasMoved) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    let newTop = dragState.initialTop + totalDeltaY;
                    let newRight = dragState.initialRight - totalDeltaX;
                    const containerRect = container.getBoundingClientRect();
                    newTop = Math.max(0, Math.min(window.innerHeight - containerRect.height, newTop));
                    newRight = Math.max(0, Math.min(window.innerWidth - containerRect.width, newRight));
                    container.style.top = `${newTop}px`;
                    container.style.right = `${newRight}px`;
                    container.style.left = 'auto';
                    container.style.bottom = 'auto';
                }
            };
            const onDragEnd = () => {
                if (!dragState.isDragging) return;
                dragState.isDragging = false;
                dragHandleBtn.style.cursor = 'grab';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragEnd);
                document.removeEventListener('touchmove', onDragMove);
                document.removeEventListener('touchend', onDragEnd);
            };
            dragHandleBtn.addEventListener('mousedown', onDragStart);
            dragHandleBtn.addEventListener('touchstart', onDragStart, { passive: false });
            container.addEventListener('pointerdown', resetFadeTimer);
            updateActiveButtons();
        }

        function setMode(mode) {
            const shadowRoot = state.ui.shadowRoot; if (!shadowRoot) return;
            const isLive = mode === 'live';
            const speedControls = shadowRoot.getElementById('vsc-speed-controls');
            if (speedControls) speedControls.style.display = isLive ? 'none' : 'flex';
            let delayInfoEl = shadowRoot.getElementById('vsc-delay-info');
            if (!delayInfoEl && isLive) {
                delayInfoEl = document.createElement('div'); delayInfoEl.id = 'vsc-delay-info';
                shadowRoot.appendChild(delayInfoEl);
            } else if (delayInfoEl) {
                delayInfoEl.style.display = isLive ? 'block' : 'none';
            }
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'),
            reset: () => safeExec(reset, 'speedSlider.reset'),
            renderControls: () => safeExec(renderControls, 'speedSlider.renderControls'),
            show: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) { el.style.display = 'flex'; resetFadeTimer(); } },
            hide: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) el.style.display = 'none'; },
            setMode,
            resetFadeTimer,
        };
    })();

    const dragBar = (() => {
        let display, inited = false;
        let dragState = { dragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0, accX: 0, directionConfirmed: false };
        let lastDelta = 0;
        let rafScheduled = false;
        function findAssociatedVideo(target) { if (target.tagName === 'VIDEO') return target; const v = target.querySelector('video'); if (v) return v; if (target.parentElement) return target.parentElement.querySelector('video'); return null; }
        const getEventPosition = e => e.touches ? e.touches[0] : e;
        const onStart = e => safeExec(() => {
            if (e.touches && e.touches.length > 1 || (e.type === 'mousedown' && e.button !== 0)) return;
            const video = findAssociatedVideo(e.target);
            if (!video || !state.isDragSeekEnabled || e.composedPath().some(el => el.id === 'vsc-container')) return;
            const pos = getEventPosition(e);
            Object.assign(dragState, { dragging: true, startX: pos.clientX, startY: pos.clientY, currentX: pos.clientX, currentY: pos.clientY, accX: 0, directionConfirmed: false });
            const options = { passive: false, capture: true };
            document.addEventListener(e.type === 'mousedown' ? 'mousemove' : 'touchmove', onMove, options);
            document.addEventListener(e.type === 'mousedown' ? 'mouseup' : 'touchend', onEnd, options);
        }, 'drag.start');
        const onMove = e => {
            if (!dragState.dragging) return;
            if (e.touches && e.touches.length > 1) return onEnd();
            const pos = getEventPosition(e);
            dragState.currentX = pos.clientX; dragState.currentY = pos.clientY;
            if (!dragState.directionConfirmed) {
                const dX = Math.abs(dragState.currentX - dragState.startX);
                const dY = Math.abs(dragState.currentY - dragState.startY);
                if (dX > dY + 5) dragState.directionConfirmed = true;
                else if (dY > dX + 5) return onEnd();
            }
            if (dragState.directionConfirmed) {
                e.preventDefault(); e.stopImmediatePropagation();
                dragState.accX += dragState.currentX - dragState.startX;
                dragState.startX = dragState.currentX;
                if (!rafScheduled) {
                    rafScheduled = true;
                    window.requestAnimationFrame(() => { if (dragState.dragging) showDisplay(dragState.accX); rafScheduled = false; });
                }
            }
        };
        const onEnd = () => {
            if (!dragState.dragging) return;
            if (dragState.directionConfirmed) applySeek();
            Object.assign(dragState, { dragging: false, accX: 0, directionConfirmed: false });
            hideDisplay();
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('touchmove', onMove, true);
            document.removeEventListener('mouseup', onEnd, true);
            document.removeEventListener('touchend', onEnd, true);
        };
        const applySeek = () => { const delta = Math.round(dragState.accX / 2); if (Math.abs(delta) < 1) return; for (const media of state.activeMedia) if (isFinite(media.duration)) media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + delta)); };
        const showDisplay = pixels => {
            const seconds = Math.round(pixels / 2); if (seconds === lastDelta) return; lastDelta = seconds;
            if (!display) { const root = state.ui.shadowRoot; if (!root) return; display = document.createElement('div'); display.id = 'vsc-time-display'; root.appendChild(display); }
            const sign = seconds < 0 ? '-' : '+'; const abs = Math.abs(seconds); const mins = Math.floor(abs / 60).toString().padStart(2, '0'); const secs = (abs % 60).toString().padStart(2, '0');
            display.textContent = `${sign}${mins}:${secs}`;
            display.style.display = 'block'; display.style.opacity = '1';
        };
        const hideDisplay = () => { if (display) { display.style.opacity = '0'; setTimeout(() => { if (display) display.style.display = 'none'; }, 300); } };
        return { init: () => { if (inited) return; safeExec(() => { document.addEventListener('mousedown', onStart, { capture: true }); document.addEventListener('touchstart', onStart, { passive: true, capture: true }); inited = true; }, 'drag.init'); } };
    })();

    const mobileGestureManager = (() => {
        let longPressTimer = null, gestureIndicator = null;
        const LONG_PRESS_DELAY = 800;
        const findAssociatedVideo = (target) => { if (target.tagName === 'VIDEO') return target; const v = target.closest('body, .player, #player, #movie_player')?.querySelector('video'); return v || null; };
        const showIndicator = (text) => {
            if (!state.ui.shadowRoot) return;
            if (!gestureIndicator) { gestureIndicator = document.createElement('div'); gestureIndicator.id = 'vsc-gesture-indicator'; state.ui.shadowRoot.appendChild(gestureIndicator); }
            gestureIndicator.textContent = text; gestureIndicator.style.display = 'block';
        };
        const hideIndicator = () => { if (gestureIndicator) { gestureIndicator.style.opacity = '0'; setTimeout(() => { if (gestureIndicator) gestureIndicator.style.display = 'none'; }, 300); } };
        const onTouchStart = (e) => {
            if (e.touches.length !== 1 || state.isDragSeekEnabled || e.composedPath().some(el => el.id === 'vsc-container')) return;
            const video = findAssociatedVideo(e.target); if (!video) return;
            longPressTimer = setTimeout(() => {
                safeExec(() => {
                    video.dataset.originalRate = video.playbackRate;
                    const highSpeedRate = settingsManager.get('longPressRate');
                    video.playbackRate = highSpeedRate;
                    showIndicator(`x ${highSpeedRate.toFixed(1)}`);
                });
                longPressTimer = null;
            }, LONG_PRESS_DELAY);
        };
        const onTouchMove = () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } };
        const onTouchEnd = () => {
            if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
            let rateChanged = false;
            for (const media of state.activeMedia) {
                if (media.dataset.originalRate) {
                    safeExec(() => { media.playbackRate = parseFloat(media.dataset.originalRate); delete media.dataset.originalRate; });
                    rateChanged = true;
                }
            }
            if (rateChanged) hideIndicator();
        };
        const init = () => { if (!isMobile) return; document.addEventListener('touchstart', onTouchStart, { passive: true }); document.addEventListener('touchmove', onTouchMove, { passive: true }); document.addEventListener('touchend', onTouchEnd, { passive: true }); document.addEventListener('touchcancel', onTouchEnd, { passive: true }); };
        return { init: () => safeExec(init, 'mobileGestureManager.init') };
    })();

    const mediaSessionManager = (() => {
        let inited = false;
        const getSeekTime = m => { if (!m || !isFinite(m.duration)) return 10; return Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC); };
        const getText = sels => { if (!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; };
        const getMeta = () => { const rule = CONFIG.SITE_METADATA_RULES[location.hostname]; if (rule) { return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname }; } return { title: document.title, artist: location.hostname }; };
        const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) {} };
        function init() { if (inited) return; inited = true; }
        function setSession(m) {
            if (!('mediaSession' in navigator)) return;
            safeExec(() => {
                const { title, artist } = getMeta();
                navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'Video_Image_Control' });
                setAction('play', () => m.play()); setAction('pause', () => m.pause());
                setAction('seekbackward', () => { m.currentTime -= getSeekTime(m); });
                setAction('seekforward', () => { m.currentTime += getSeekTime(m); });
                setAction('seekto', d => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } });
            }, 'mediaSession.set');
        }
        function clearSession() { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); }
        return { init, setSession, clearSession };
    })();

    const autoDelayManager = (() => {
        let video = null;
        const D_CONFIG = CONFIG.DELAY_ADJUSTER;
        let FEEL_DELAY_FACTOR = 0.7, SMOOTH_STEP = 0.02;
        const SAMPLING_DURATION = 2000;
        let samplingData = [];
        let localIntersectionObserver;
        function findVideo() { return state.activeMedia.size > 0 ? Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO') : null; }
        function calculateDelay(videoElement) { if (!videoElement || !videoElement.buffered || videoElement.buffered.length === 0) return null; try { const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1); const delay = bufferedEnd - videoElement.currentTime; return delay >= 0 ? delay * 1000 : null; } catch { return null; } }
        function calculateAdjustedDelay(videoElement) { const rawDelay = calculateDelay(videoElement); if (rawDelay === null) return null; const clampedDelay = Math.min(Math.max(rawDelay, 0), 5000); return clampedDelay * FEEL_DELAY_FACTOR; }
        function getPlaybackRate(avgDelay) { for (const config of D_CONFIG.SPEED_LEVELS) { if (avgDelay >= config.minDelay) return config.playbackRate; } return D_CONFIG.SPEED_LEVELS[D_CONFIG.SPEED_LEVELS.length - 1].playbackRate; }
        function adjustPlaybackRate(targetRate) { if (!video) return; const diff = targetRate - video.playbackRate; if (Math.abs(diff) < 0.01) return; safeExec(() => { video.playbackRate += diff * SMOOTH_STEP; state.currentPlaybackRate = video.playbackRate; }); }

        function displayDelayInfo(messageOrAvg, minDelay) {
            if (!state.ui.shadowRoot) return;
            let infoEl = state.ui.shadowRoot.getElementById('vsc-delay-info');
            if (!infoEl) {
                infoEl = document.createElement('div');
                infoEl.id = 'vsc-delay-info';
                state.ui.shadowRoot.appendChild(infoEl);
            }
            let textSpan = infoEl.querySelector('span');
            if (!textSpan) {
                textSpan = document.createElement('span');
                infoEl.prepend(textSpan);
            }
            if (typeof messageOrAvg === 'string') {
                textSpan.textContent = messageOrAvg;
            } else {
                const avgDelay = messageOrAvg;
                const status = state.isDelayAdjusting ? `${state.currentPlaybackRate.toFixed(2)}x` : '1.00x';
                textSpan.textContent = `딜레이: ${avgDelay.toFixed(0)}ms (min: ${minDelay.toFixed(0)}ms) / 속도: ${status}`;
            }
            let refreshBtn = infoEl.querySelector('.vsc-delay-refresh-btn');
            if (!refreshBtn) {
                refreshBtn = document.createElement('button');
                refreshBtn.textContent = '🔄';
                refreshBtn.title = '딜레이 측정 재시작';
                refreshBtn.className = 'vsc-delay-refresh-btn';
                Object.assign(refreshBtn.style, { background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px', fontSize: '14px', padding: '0 2px', verticalAlign: 'middle' });
                refreshBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    restart();
                });
                infoEl.appendChild(refreshBtn);
            }
        }

        function sampleInitialDelayAndFPS() {
            return new Promise(resolve => {
                const startTime = Date.now(); let lastFrame = performance.now(); let fpsSamples = [];
                function sampleFrame() {
                    const now = performance.now(); const delta = now - lastFrame; lastFrame = now; fpsSamples.push(1000 / delta);
                    const delay = calculateDelay(video); if (delay !== null) samplingData.push(delay);
                    if (Date.now() - startTime < SAMPLING_DURATION) { requestAnimationFrame(sampleFrame); }
                    else { const avgDelay = samplingData.reduce((a, b) => a + b, 0) / samplingData.length || 0; const minDelay = Math.min(...samplingData); const avgFPS = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length || 60; resolve({ avgDelay, minDelay, avgFPS }); }
                }
                sampleFrame();
            });
        }
        function autoOptimizeParameters({ avgDelay, minDelay, avgFPS }) { FEEL_DELAY_FACTOR = Math.min(Math.max(0.5, 1000 / (avgDelay + 1)), 1.0); SMOOTH_STEP = Math.min(Math.max(0.01, avgFPS / 60 * 0.05), 0.1); if (CONFIG.DEBUG) console.log(`autoDelayManager 초기 최적화 완료: FEEL_DELAY_FACTOR=${FEEL_DELAY_FACTOR.toFixed(2)}, SMOOTH_STEP=${SMOOTH_STEP.toFixed(3)}`); }
        function checkAndAdjust() {
            if (!video) video = findVideo(); if (!video) return;
            const adjustedDelay = calculateAdjustedDelay(video); if (adjustedDelay === null) return;
            const now = Date.now(); state.delayHistory.push({ delay: adjustedDelay, timestamp: now });
            state.delayHistory = state.delayHistory.filter(item => now - item.timestamp <= D_CONFIG.HISTORY_DURATION);
            if (state.delayHistory.length === 0) return;
            const avgDelay = state.delayHistory.reduce((sum, item) => sum + item.delay, 0) / state.delayHistory.length;
            const minDelay = Math.min(...state.delayHistory.map(i => i.delay));
            displayDelayInfo(avgDelay, minDelay);
            if (!state.isDelayAdjusting && avgDelay >= D_CONFIG.TRIGGER_DELAY) state.isDelayAdjusting = true;
            else if (state.isDelayAdjusting && avgDelay <= D_CONFIG.TARGET_DELAY) { state.isDelayAdjusting = false; adjustPlaybackRate(D_CONFIG.NORMAL_RATE); }
            if (state.isDelayAdjusting) { const newRate = getPlaybackRate(avgDelay); adjustPlaybackRate(newRate); }
        }
        function setupIntersectionObserver() {
            if (localIntersectionObserver) return;
            localIntersectionObserver = new IntersectionObserver(entries => { entries.forEach(entry => { if (entry.isIntersecting && entry.target.tagName === 'VIDEO') video = entry.target; }); }, { threshold: 0.5 });
            state.activeMedia.forEach(media => { if (media.tagName === 'VIDEO') localIntersectionObserver.observe(media); });
        }
        async function start() {
            if (state.delayCheckInterval) return; video = null;
            setupIntersectionObserver();
            video = findVideo();
            if (video) {
                const sample = await sampleInitialDelayAndFPS(); autoOptimizeParameters(sample);
                state.delayHistory = samplingData.map(d => ({ delay: d, timestamp: Date.now() }));
            }
            state.delayCheckInterval = setInterval(checkAndAdjust, D_CONFIG.CHECK_INTERVAL);
        }
        function stop() {
            if (state.delayCheckInterval) { clearInterval(state.delayCheckInterval); state.delayCheckInterval = null; }
            if (localIntersectionObserver) { localIntersectionObserver.disconnect(); localIntersectionObserver = null; }
            const infoEl = state.ui.shadowRoot?.getElementById('vsc-delay-info'); if (infoEl) infoEl.remove();
            if (video) { safeExec(()=>{ if(video.playbackRate!==1.0) video.playbackRate=1.0; }); video=null; }
            samplingData = [];
        }
        function restart() {
            safeExec(() => {
                stop();
                displayDelayInfo("딜레이: 계산 중...");
                start();
                if (CONFIG.DEBUG) console.log("🔄️ autoDelayManager manually restarted.");
            }, 'autoDelayManager.restart');
        }
        return { start, stop, restart };
    })();

    // =================================================================================
    // 4. DOM 스캔 및 이벤트 관리 (DOM Scanning and Event Management)
    // =================================================================================

    function findAllMedia(doc = document) {
        const elems = [];
        safeExec(() => {
            elems.push(...doc.querySelectorAll('video, audio'));
            (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if (root) elems.push(...root.querySelectorAll('video, audio')); });
            doc.querySelectorAll('iframe').forEach(f => { try { if (f.contentDocument) elems.push(...findAllMedia(f.contentDocument)); } catch (e) {} });
        });
        return [...new Set(elems)];
    }
    function findAllImages(doc = document) {
        const elems = [];
        safeExec(() => {
            const size = CONFIG.IMAGE_MIN_SIZE;
            const filterFn = img => img.naturalWidth > size && img.naturalHeight > size;
            elems.push(...Array.from(doc.querySelectorAll('img')).filter(filterFn));
            (window._shadowDomList_ || []).filter(r => r.deref()).forEach(r => { const root = r.deref(); if (root) elems.push(...Array.from(root.querySelectorAll('img')).filter(filterFn)); });
        });
        return [...new Set(elems)];
    }

    function updateVideoFilterState(video) {
        if (!filterManager.isInitialized()) return;
        const isVisible = video.dataset.isVisible !== 'false';
        const shouldHaveFilter = isVisible && state.currentVideoFilterLevel > 0;
        video.classList.toggle('vsc-video-filter-active', shouldHaveFilter);
    }
    function updateImageFilterState(image) {
        if (!imageFilterManager.isInitialized()) return;
        const isVisible = image.dataset.isVisible !== 'false';
        const shouldHaveFilter = isVisible && state.currentImageFilterLevel > 0;
        image.classList.toggle('vsc-image-filter-active', shouldHaveFilter);
    }

    const mediaEventHandlers = {
        play: e => { const m = e.target; audioManager.resumeContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); },
        pause: e => { const m = e.target; audioManager.suspendContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).filter(med => !med.paused).length === 0) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).filter(med => !med.paused).length === 0) mediaSessionManager.clearSession(); },
    };

    function injectFiltersIntoRoot(element, manager) {
        const root = element.getRootNode();
        const injectedAttr = `data-vsc-filters-injected-${manager === filterManager ? 'video' : 'image'}`;
        if (root instanceof ShadowRoot && !root.host.hasAttribute(injectedAttr)) {
            const svgNode = manager.getSvgNode();
            if (svgNode) {
                root.appendChild(svgNode.cloneNode(true)); root.host.setAttribute(injectedAttr, 'true');
                const level = (element.tagName === 'VIDEO') ? state.currentVideoFilterLevel : state.currentImageFilterLevel;
                manager.setSharpenMatrix(calculateSharpenMatrix(level), root);
            }
        }
    }

    function attachMediaListeners(media) {
        if (!media || state.processedMedia.has(media) || !intersectionObserver) return;
        if (media.tagName === 'VIDEO') injectFiltersIntoRoot(media, filterManager);
        audioManager.processMedia(media);
        const listeners = {};
        for (const [evt, handler] of Object.entries(mediaEventHandlers)) { listeners[evt] = handler; media.addEventListener(evt, handler); }
        state.mediaListenerMap.set(media, listeners);
        state.processedMedia.add(media);
        intersectionObserver.observe(media);
    }
    function attachImageListeners(image) {
        if (!image || state.processedImages.has(image) || !intersectionObserver) return;
        injectFiltersIntoRoot(image, imageFilterManager);
        state.processedImages.add(image);
        intersectionObserver.observe(image);
    }
    function detachMediaListeners(media) {
        if (!state.mediaListenerMap.has(media)) return;
        const listeners = state.mediaListenerMap.get(media);
        for (const [evt, listener] of Object.entries(listeners)) media.removeEventListener(evt, listener);
        audioManager.cleanupMedia(media);
        state.mediaListenerMap.delete(media);
        state.processedMedia.delete(media);
        if (intersectionObserver) intersectionObserver.unobserve(media);
    }
    function detachImageListeners(image) {
        if (!state.processedImages.has(image)) return;
        state.processedImages.delete(image);
        if (intersectionObserver) intersectionObserver.unobserve(image);
    }

    const scanAndApply = () => {
        const allMedia = findAllMedia();
        allMedia.forEach(attachMediaListeners);
        const oldMedia = new Set(state.activeMedia);
        state.activeMedia.clear();
        allMedia.forEach(m => { if (m.isConnected) { state.activeMedia.add(m); oldMedia.delete(m); } });
        oldMedia.forEach(detachMediaListeners);
        allMedia.forEach(m => { if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); } });

        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);
        const oldImages = new Set(state.activeImages);
        state.activeImages.clear();
        allImages.forEach(img => { if (img.isConnected) { state.activeImages.add(img); oldImages.delete(img); } });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);

        const root = state.ui.shadowRoot;
        if (root) {
            const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
            const hasAudio = Array.from(state.activeMedia).some(m => m.tagName === 'AUDIO') || hasVideo;
            const hasImage = state.activeImages.size > 0;

            if (hasVideo) state.mediaTypesEverFound.video = true;
            if (hasAudio) state.mediaTypesEverFound.audio = true;
            if (hasImage) state.mediaTypesEverFound.image = true;

            filterManager.toggleStyleSheet(state.mediaTypesEverFound.video);
            imageFilterManager.toggleStyleSheet(state.mediaTypesEverFound.image);

            const setDisplay = (id, visible) => {
                const el = root.getElementById(id);
                if (el) el.style.display = visible ? 'flex' : 'none';
            };

            // ((로직 변경)) 시계 클릭 시점에 감지된 요소에 해당하는 UI만 표시
            setDisplay('vsc-video-controls', hasVideo);
            setDisplay('vsc-audio-controls', hasAudio);
            setDisplay('vsc-image-controls', hasImage);

            const hasAnyMedia = hasVideo || hasAudio;
            setDisplay('vsc-speed-controls', hasAnyMedia);
            setDisplay('vsc-pip-controls', hasVideo && pipButtonManager.isAvailable());

            const isAnyMediaPresent = hasAnyMedia || hasImage;
            setDisplay('vsc-drag-handle-group', isAnyMediaPresent);
        }
    };


    // =================================================================================
    // 5. 초기화 및 라이프사이클 (Initialization and Lifecycle)
    // =================================================================================

    const debouncedScanTask = debounce(scanAndApply, CONFIG.DEBOUNCE_DELAY);
    let mainObserver = null;
    let intersectionObserver = null;
    let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null, spaNavigationHandler = null;
    let isInitialized = false;
    let triggerElement = null; // [FIX] 전체화면 전환 시 아이콘 참조를 유지하기 위한 변수

    function cleanup() {
        safeExec(() => {
            // [FIX] 3단계 완전 소독 및 강제 초기화 로직

            if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
            if (intersectionObserver) { intersectionObserver.disconnect(); intersectionObserver = null; }
            if (visibilityChangeListener) { document.removeEventListener('visibilitychange', visibilityChangeListener); visibilityChangeListener = null; }
            if (fullscreenChangeListener) { document.removeEventListener('fullscreenchange', fullscreenChangeListener); fullscreenChangeListener = null; }
            if (beforeUnloadListener) { window.removeEventListener('beforeunload', beforeUnloadListener); beforeUnloadListener = null; }

            autoDelayManager.stop();
            mediaSessionManager.clearSession();

            // --- 3단계 필터 완전 소독 ---
            // 1단계: 필터 레벨을 0으로 설정하여 효과를 '없음'으로 변경
            setVideoFilterLevel(0);
            setImageFilterLevel(0);

            // 2단계: 페이지 전체에서 강제로 필터 클래스를 찾아 제거 (가장 확실한 방법)
            const allRoots = [document, ...(window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean)];
            allRoots.forEach(root => {
                root.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(el => {
                    el.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active', 'vsc-gpu-accelerated');
                });
            });

            // 3단계: 필터 스타일시트 자체를 비활성화하여 원천 차단
            filterManager.toggleStyleSheet(false);
            imageFilterManager.toggleStyleSheet(false);
            // --- 소독 완료 ---

            // 모든 미디어 요소의 재생속도를 1배로 강제 초기화
            findAllMedia().forEach(media => {
                safeExec(() => {
                    if (media.playbackRate !== 1.0) media.playbackRate = 1.0;
                    if (media.dataset.originalRate) delete media.dataset.originalRate;
                });
            });

            audioManager.closeContext();

            const host = state.ui.hostElement;
            if (host) host.remove();

            uiManager.reset();
            speedSlider.reset();
            settingsManager.init(); // (설정 메모리 초기화): UI를 닫을 때 설정 값을 기본값으로 초기화

            isInitialized = false;
            if (CONFIG.DEBUG) console.log("🧼 Video_Image_Control cleaned up completely.");
        }, 'cleanup');
    }

    function ensureObservers() {
        if (!mainObserver) {
            mainObserver = new MutationObserver(mutations => {
                if (!mutations.some(m => m.target.id === UI_SELECTORS.HOST)) {
                    scheduleIdleTask(scanAndApply);
                }
            });
            mainObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        }
        if (!intersectionObserver) {
            intersectionObserver = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    e.target.dataset.isVisible = String(e.isIntersecting);
                    if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target);
                    if (e.target.tagName === 'IMG') updateImageFilterState(e.target);
                });
            });
        }
    }

    function hookSpaNavigation() {
        if (spaNavigationHandler) return;
        spaNavigationHandler = debounce(() => {
            if (location.href === state.lastUrl) {
                return;
            }
            const trigger = document.getElementById(UI_SELECTORS.TRIGGER);
            if(trigger) trigger.remove();
            cleanup();
            createTriggerButton();
        }, 500);

        ['pushState', 'replaceState'].forEach(method => {
            const original = history[method];
            if (original) {
                 history[method] = function(...args) {
                    let result;
                    try {
                        result = original.apply(this, args);
                    } finally {
                        window.dispatchEvent(new Event(`vsc:${method}`));
                    }
                    return result;
                }
            }
        });
        window.addEventListener('popstate', spaNavigationHandler);
        window.addEventListener('vsc:pushState', spaNavigationHandler);
        window.addEventListener('vsc:replaceState', spaNavigationHandler);
        document.addEventListener('addShadowRoot', debouncedScanTask);
    }

    function start() {
        if (isInitialized) return;

        resetState();
        state.lastUrl = location.href;

        uiManager.init();
        filterManager.init();
        imageFilterManager.init();
        speedSlider.init();
        dragBar.init();
        mobileGestureManager.init();
        mediaSessionManager.init();

        ensureObservers();

        // ((추가 작업)) UI 감시견 로직 삭제

        const isLive = isLiveStreamPage();
        if (isLive) {
            autoDelayManager.start();
            speedSlider.setMode('live');
        } else {
            speedSlider.setMode('vod');
        }

        speedSlider.renderControls();
        speedSlider.show();

        hookSpaNavigation();

        visibilityChangeListener = () => {
            if (document.hidden) {
                document.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(v => v.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active'));
                audioManager.suspendContext();
            } else {
                scheduleIdleTask(scanAndApply);
                audioManager.resumeContext();
            }
        };
        document.addEventListener('visibilitychange', visibilityChangeListener);

        fullscreenChangeListener = async () => {
            const fullscreenElement = document.fullscreenElement || document.body;
            uiManager.moveUiTo(fullscreenElement);
            // The main fullscreen listener now uses the triggerElement reference, so this part is mostly for the UI container
            if (triggerElement) {
                fullscreenElement.appendChild(triggerElement);
            }
            speedSlider.show();
            speedSlider.resetFadeTimer();
            if (isMobile && document.fullscreenElement) {
                const video = document.fullscreenElement.querySelector('video') || (document.fullscreenElement.tagName === 'VIDEO' ? document.fullscreenElement : null);
                if (video) {
                    const lockLandscape = async () => {
                        if (video.videoWidth > video.videoHeight) {
                            if (screen.orientation?.lock) {
                                try { await screen.orientation.lock('landscape'); } catch (err) {}
                            }
                        }
                    };
                    if (video.readyState >= 1) await lockLandscape(); else video.addEventListener('loadedmetadata', lockLandscape, { once: true });
                }
            } else if (isMobile && !document.fullscreenElement) {
                if (screen.orientation?.unlock) {
                    try { screen.orientation.unlock(); } catch (e) {}
                }
            }
        };
        document.addEventListener('fullscreenchange', fullscreenChangeListener);

        beforeUnloadListener = () => cleanup();
        window.addEventListener('beforeunload', beforeUnloadListener);

        setVideoFilterLevel(state.currentVideoFilterLevel);
        setImageFilterLevel(state.currentImageFilterLevel);
        audioManager.setAudioMode(state.currentAudioMode);
        scheduleIdleTask(scanAndApply);

        isInitialized = true;
        if (CONFIG.DEBUG) console.log("🎉 Video_Image_Control initialized.");
    }

    function createTriggerButton() {
        if (triggerElement || document.getElementById(UI_SELECTORS.TRIGGER)) return;

        // ((로직 변경)) 초기 시계 아이콘 나올때 태그 검사 실시
        const hasMedia = findAllMedia().length > 0;
        const hasImages = findAllImages().length > 0;
        if (!hasMedia && !hasImages) {
            if (CONFIG.DEBUG) console.log("[VSC] No media or large images found. Trigger button will not be displayed.");
            return; // 태그 요소 미 감지시 시계 안보이게
        }

        const trigger = document.createElement('div');
        triggerElement = trigger; // [FIX] 전역 변수에 참조 저장
        trigger.id = UI_SELECTORS.TRIGGER;
        trigger.textContent = '⚡';
        Object.assign(trigger.style, {
          position: 'fixed',
          top: '50%',             // 화면 세로 70% 위치
          right: '0vw',            // 화면 왼쪽 여백
          transform: 'translateY(-50%)', // 세로 가운데 정렬
          width: '40px',
          height: '40px',
          background: 'rgba(0, 0, 0, 0.5)',
          color: 'white',
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '24px',
          cursor: 'pointer',
          zIndex: CONFIG.MAX_Z_INDEX,
          userSelect: 'none',
          transition: 'transform 0.2s, background-color 0.2s'
      });

        let isDragging = false;
        let wasDragged = false;
        let startX, startY;

        trigger.addEventListener('click', (e) => {
            if (wasDragged) {
                e.stopPropagation();
                return;
            }
            if (isInitialized) {
                cleanup();
                trigger.textContent = '⚡';
                trigger.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            } else {
                start();
                trigger.textContent = '❌';
                trigger.style.backgroundColor = 'rgba(200, 0, 0, 0.6)';
            }
        });

        document.body.appendChild(trigger);

        trigger.addEventListener('mousedown', (e) => {
            isDragging = true;
            wasDragged = false;
            startX = e.clientX;
            startY = e.clientY;
            trigger.style.cursor = 'grabbing';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            // [FIX] 클릭 시 미세한 움직임으로 위치가 변경되는 문제 해결
            // 드래그 시작으로 간주되기 전에는 위치를 업데이트하지 않음
            if (!wasDragged) {
                if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) {
                    wasDragged = true;
                }
            }

            // 드래그가 확인된 경우에만 위치를 변경
            if (wasDragged) {
                const x = e.clientX - (trigger.offsetWidth / 2);
                const y = e.clientY - (trigger.offsetHeight / 2);

                trigger.style.right = 'auto';
                trigger.style.bottom = 'auto';
                trigger.style.left = `${x}px`;
                trigger.style.top = `${y}px`;
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                trigger.style.cursor = 'pointer';
            }
        });
    }

    if (!isExcluded()) {
        // 동적으로 로딩되는 미디어를 감지하기 위해 2초 지연 후 아이콘 생성
        setTimeout(() => {
            createTriggerButton();
        }, 2000);

        // [FIX] 프레임 영상 전체화면 전환/복귀 시 아이콘이 사라지는 문제 해결
        document.addEventListener('fullscreenchange', () => {
            if (triggerElement) {
                const targetRoot = document.fullscreenElement || document.body;
                targetRoot.appendChild(triggerElement);
            }
        });
    }
})();
