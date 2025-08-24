// ==UserScript==
// @name         Video_Image_Control
// @namespace    https://com/
// @version      53.3
// @description  VIDEO_MIN_SIZE 추가하여 작은 영상은 제어 대상에서 제외
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // UI 요소들을 담을 최상위 컨테이너 변수
    let uiContainer = null;
    let triggerElement = null;
    let speedButtonsContainer = null; // 배속 버튼 컨테이너 추가

    // =================================================================================
    // 1. 설정 및 상수 (Configuration and Constants)
    // =================================================================================

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 3 : 2,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 6 : 2,
        DEFAULT_AUDIO_PRESET: 'off',
        DEBUG: false,
        DEBOUNCE_DELAY: 300,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 335,
        VIDEO_MIN_SIZE: 200, // [추가] 비디오의 최소 너비/높이 값 (이 값보다 작으면 제어 대상에서 제외)
        LIVE_STREAM_URLS: ['play.sooplive.co.kr/', 'chzzk.naver.com/', 'twitch.tv', 'kick.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com'],
        SPECIFIC_EXCLUSIONS: [{ domain: 'avsee.ru', path: '/bbs/login.php' }],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -3, HIGHLIGHTS_VALUE: 10, SATURATION_VALUE: 103 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.5', SHADOWS_VALUE: -3, HIGHLIGHTS_VALUE: 10, SATURATION_VALUE: 103 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: [],
        AUDIO_PRESETS: { off: { gain: 1, eq: [] }, speech: { gain: 1.05, eq: [{ freq: 80, gain: -3 }, { freq: 200, gain: -1 }, { freq: 500, gain: 2 }, { freq: 1000, gain: 4 }, { freq: 3000, gain: 5 }, { freq: 6000, gain: 2 }, { freq: 12000, gain: -2 }] }, liveBroadcast: { gain: 1.1, eq: [{ freq: 80, gain: 2 }, { freq: 150, gain: 1.5 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 3 }, { freq: 2000, gain: 3.5 }, { freq: 3000, gain: 3 }, { freq: 6000, gain: 2 }, { freq: 12000, gain: 2 }] }, movie: { gain: 1.25, eq: [{ freq: 80, gain: 6 }, { freq: 200, gain: 4 }, { freq: 500, gain: 1 }, { freq: 1000, gain: 2 }, { freq: 3000, gain: 3.5 }, { freq: 6000, gain: 5 }, { freq: 10000, gain: 4 }] }, music: { gain: 1.15, eq: [{ freq: 60, gain: 4 }, { freq: 150, gain: 2.5 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 1 }, { freq: 3000, gain: 3 }, { freq: 6000, gain: 3.5 }, { freq: 12000, gain: 3 }] }, gaming: { gain: 1.1, eq: [{ freq: 60, gain: 3 }, { freq: 250, gain: -1 }, { freq: 1000, gain: 3 }, { freq: 2000, gain: 5 }, { freq: 4000, gain: 6 }, { freq: 8000, gain: 4 }, { freq: 12000, gain: 2 }] } },
        MAX_EQ_BANDS: 7,
        DELAY_ADJUSTER: { CHECK_INTERVAL: 500, HISTORY_DURATION: 1000, TRIGGER_DELAY: 1500, TARGET_DELAY: 1500, SPEED_LEVELS: [{ minDelay: 4000, playbackRate: 1.10 }, { minDelay: 3750, playbackRate: 1.09 }, { minDelay: 3500, playbackRate: 1.08 }, { minDelay: 3250, playbackRate: 1.07 }, { minDelay: 3000, playbackRate: 1.06 }, { minDelay: 2750, playbackRate: 1.05 }, { minDelay: 2500, playbackRate: 1.04 }, { minDelay: 2250, playbackRate: 1.03 }, { minDelay: 2000, playbackRate: 1.02 }, { minDelay: 1750, playbackRate: 1.01 }, { minDelay: 1500, playbackRate: 1.00 }], NORMAL_RATE: 1.0 }
    };

    const UI_SELECTORS = {
        HOST: 'vsc-ui-host',
        CONTAINER: 'vsc-container',
        TRIGGER: 'vsc-trigger-button',
        CONTROL_GROUP: 'vsc-control-group', SUBMENU: 'vsc-submenu', BTN: 'vsc-btn', BTN_MAIN: 'vsc-btn-main', SELECT: 'vsc-select', VIDEO_CONTROLS: 'vsc-video-controls', IMAGE_CONTROLS: 'vsc-image-controls', AUDIO_CONTROLS: 'vsc-audio-controls'
    };

    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 6 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 6 },
            audioPreset: { name: '기본 오디오 프리셋', default: CONFIG.DEFAULT_AUDIO_PRESET, type: 'string', options: ['off', 'speech', 'liveBroadcast', 'movie', 'music', 'gaming'] }
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
            currentVideoFilterLevel: settingsManager.get('videoFilterLevel') || 0,
            currentImageFilterLevel: settingsManager.get('imageFilterLevel') || 0,
            currentAudioMode: settingsManager.get('audioPreset') || 'off',
            ui: { shadowRoot: null, hostElement: null },
            delayHistory: [],
            isDelayAdjusting: false,
            delayCheckInterval: null,
            currentPlaybackRate: 1.0,
            mediaTypesEverFound: { video: false, audio: false, image: false },
            lastUrl: ''
        });
    }

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    function calculateSharpenMatrix(level) { const parsedLevel = parseInt(level, 10); if (isNaN(parsedLevel) || parsedLevel === 0) return '0 0 0 0 1 0 0 0 0'; const intensity = 1 + (parsedLevel - 0.5) * (5.0 / 5); const off = (1 - intensity) / 4; return `0 ${off} 0 ${off} ${intensity} ${off} 0 ${off} 0`; }
    function isLiveStreamPage() { const url = location.href; return CONFIG.LIVE_STREAM_URLS.some(pattern => url.includes(pattern)); }
    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() { const url = location.href.toLowerCase(); const hostname = location.hostname.toLowerCase(); if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) return true; return CONFIG.SPECIFIC_EXCLUSIONS.some(rule => hostname.includes(rule.domain) && url.includes(rule.path)); }
    if (isExcluded()) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const originalAttachShadow = Element.prototype.attachShadow; Element.prototype.attachShadow = function (options) { const modifiedOptions = { ...options, mode: 'open' }; const shadowRoot = originalAttachShadow.apply(this, [modifiedOptions]); window._shadowDomList_.push(new WeakRef(shadowRoot)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot } })); return shadowRoot; }; window._hasHackAttachShadow_ = true; }, 'openAllShadowRoots'); })();

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
            } catch (e) {
                if (CONFIG.DEBUG) console.error("[VSC] AudioContext creation failed:", e);
                ctx = null;
            }
        }
        function connectMedia(media) {
            if (!ctx || sourceMap.has(media)) return;
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            try {
                const source = ctx.createMediaElementSource(media);
                sourceMap.set(media, { source });
                const firstNode = eqFilters.length > 0 ? eqFilters[0] : masterGain;
                source.connect(firstNode);
            } catch (e) {
                if (e.name === 'SecurityError') {
                    console.warn('[VSC] Audio processing failed due to CORS policy. Disabling audio features for this video.');
                    const audioBtn = uiContainer?.querySelector('#vsc-ui-host')?.shadowRoot.getElementById('vsc-audio-btn');
                    if (audioBtn) {
                        audioBtn.disabled = true;
                        audioBtn.style.opacity = '0.5';
                        audioBtn.style.cursor = 'not-allowed';
                        audioBtn.title = '보안 정책(CORS)으로 인해 이 영상의 오디오는 제어할 수 없습니다.';
                    }
                    closeContext();
                } else {
                    if (CONFIG.DEBUG) console.error('[VSC] Error connecting media:', e);
                }
            }
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
                    filter.gain.linearRampToValueAtTime(0, now + rampTime);
                }
            }
        }
        function processMedia(media) {
            if (ctx) {
                connectMedia(media);
            }
        }
        function cleanupMedia(media) {
            if (!ctx) return;
            const rec = sourceMap.get(media);
            if (!rec) return;
            try { rec.source.disconnect(); } catch (err) {}
            sourceMap.delete(media);
        }
        function setAudioMode(mode) {
            if (isAudioDisabledForSite || !CONFIG.AUDIO_PRESETS[mode]) return;
            if (mode === 'off' && !ctx) {
                state.currentAudioMode = 'off';
                settingsManager.set('audioPreset', 'off');
                return;
            }
            if (mode !== 'off' && !ctx) {
                ensureContext();
                if (!ctx) return;
                state.activeMedia.forEach(media => connectMedia(media));
            }
            state.currentAudioMode = mode;
            settingsManager.set('audioPreset', mode);
            applyAudioPresetToNodes();
        }
        function suspendContext() { safeExec(() => { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); }); }
        function resumeContext() { safeExec(() => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }); }
        function closeContext() {
            if (ctx && ctx.state !== 'closed') {
                ctx.close().then(() => {
                    ctx = null;
                    eqFilters.length = 0;
                }).catch(() => { ctx = null; });
            }
        }
        return { processMedia, cleanupMedia, setAudioMode, getAudioMode: () => state.currentAudioMode, suspendContext, resumeContext, closeContext };
    })();

    const uiManager = (() => {
        const styleRules = [
            ':host { pointer-events: none; }',
            '* { pointer-events: auto; }',
            '#vsc-container { background: rgba(0,0,0,0.1); padding: clamp(6px, 1.2vmin, 10px); border-radius: clamp(8px, 1.5vmin, 12px); z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.3s; margin-top: 5px; }',
            '#vsc-container.touched { opacity: 1; }',
            '@media (hover: hover) { #vsc-container:hover { opacity: 1; } }',
            '.vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: clamp(3px, 0.8vmin, 5px); height: clamp(26px, 5.5vmin, 32px); width: clamp(28px, 6vmin, 34px); position: relative; }',
            '.vsc-submenu { display: none; flex-direction: row; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(5px, 1vmin, 8px); align-items: center; }',
            '.vsc-control-group.submenu-visible .vsc-submenu { display: flex; }',
            '.vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(12px, 2vmin, 14px); }',
            '.vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }',
            '.vsc-submenu .vsc-btn { min-width: auto; font-size: clamp(13px, 2.5vmin, 15px); padding: clamp(2px, 0.5vmin, 4px) clamp(4px, 1vmin, 6px); margin: 0 clamp(2px, 0.4vmin, 3px); }',
            '.vsc-btn-main { font-size: clamp(15px, 3vmin, 18px); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
            '.vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); }',
            '#vsc-delay-info { display: flex; align-items: center; bottom: 50px; Right: 10px; font-family: monospace; font-size: 10pt; line-height: 1.2; opacity: 0.8; }',
            '.vsc-loading-indicator { font-size: 16px; color: white; width: 30px; height: 28px; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
        ];
        function init() {
            if (state.ui.hostElement) return;
            const host = document.createElement('div');
            host.id = UI_SELECTORS.HOST;
            host.style.pointerEvents = 'none';
            state.ui.shadowRoot = host.attachShadow({ mode: 'open' });
            state.ui.hostElement = host;
            const style = document.createElement('style');
            style.textContent = styleRules.join('\n');
            state.ui.shadowRoot.appendChild(style);
        }
        function reset() {}
        return {
            init: () => safeExec(init, 'uiManager.init'),
            reset: () => safeExec(reset, 'uiManager.reset'),
        };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        let hideAllSubMenus = () => {};
        function startFadeSequence() {
            const container = state.ui.shadowRoot?.getElementById('vsc-container');
            if (!container) return;
            hideAllSubMenus();
            container.classList.remove('touched');
            container.style.opacity = '0.3';
        }
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
            fadeOutTimer = setTimeout(startFadeSequence, 10000);
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
                    clearTimeout(fadeOutTimer);
                    startFadeSequence();
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
            const audioModes = { '🎙️': 'speech', '📡': 'liveBroadcast', '🎬': 'movie', '🎵': 'music', '🎮': 'gaming', '🚫': 'off' };
            Object.entries(audioModes).forEach(([text, mode]) => {
                const btn = createButton(null, `오디오: ${mode}`, text);
                btn.dataset.mode = mode;
                audioSubMenu.appendChild(btn);
            });
            audioControlGroup.append(audioBtnMain, audioSubMenu);
            container.append(imageControlGroup, videoControlGroup, audioControlGroup);
            const controlGroups = [videoControlGroup, imageControlGroup, audioControlGroup];
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
            const updateActiveButtons = () => {
                const videoSelect = shadowRoot.querySelector('#vsc-video-controls select');
                if (videoSelect) videoSelect.value = state.currentVideoFilterLevel;
                const imageSelect = shadowRoot.querySelector('#vsc-image-controls select');
                if (imageSelect) imageSelect.value = state.currentImageFilterLevel;
                const currentAudio = state.currentAudioMode;
                audioSubMenu.querySelectorAll('.vsc-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === currentAudio));
            };
            audioSubMenu.addEventListener('click', (e) => {
                if (e.target.matches('.vsc-btn')) {
                    e.stopPropagation();
                    audioManager.setAudioMode(e.target.dataset.mode);
                    updateActiveButtons();
                    clearTimeout(fadeOutTimer);
                    startFadeSequence();
                }
            });
            container.addEventListener('pointerdown', resetFadeTimer);
            updateActiveButtons();
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'),
            reset: () => safeExec(reset, 'speedSlider.reset'),
            renderControls: () => safeExec(renderControls, 'speedSlider.renderControls'),
            show: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) { el.style.display = 'flex'; resetFadeTimer(); } },
            hide: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) el.style.display = 'none'; },
            resetFadeTimer,
        };
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
        let FEEL_DELAY_FACTOR = 1.0, SMOOTH_STEP = 1;
        const SAMPLING_DURATION = 2000;
        let samplingData = [];
        let localIntersectionObserver;
        function findVideo() { return state.activeMedia.size > 0 ? Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO') : null; }
        function calculateDelay(videoElement) { if (!videoElement || !videoElement.buffered || videoElement.buffered.length === 0) return null; try { const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1); const delay = bufferedEnd - videoElement.currentTime; return delay >= 0 ? delay * 1000 : null; } catch { return null; } }
        function calculateAdjustedDelay(videoElement) { const rawDelay = calculateDelay(videoElement); if (rawDelay === null) return null; const clampedDelay = Math.min(Math.max(rawDelay, 0), 5000); return clampedDelay * FEEL_DELAY_FACTOR; }
        function getPlaybackRate(avgDelay) { for (const config of D_CONFIG.SPEED_LEVELS) { if (avgDelay >= config.minDelay) { return config.playbackRate; } } return D_CONFIG.NORMAL_RATE; }
        function adjustPlaybackRate(targetRate) { if (!video) return; const diff = targetRate - video.playbackRate; if (Math.abs(diff) < 0.01) return; safeExec(() => { video.playbackRate += diff * SMOOTH_STEP; state.currentPlaybackRate = video.playbackRate; }); }
        function displayDelayInfo(messageOrAvg, minDelay) {
            let infoEl = document.getElementById('vsc-delay-info');
            if (!infoEl) {
                infoEl = document.createElement('div');
                infoEl.id = 'vsc-delay-info';
                Object.assign(infoEl.style, {
                    position: 'fixed', bottom: '50px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)',
                    color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt',
                    lineHeight: '1.2', opacity: '0.8', display: 'flex', alignItems: 'center', pointerEvents: 'none'
                });
                document.body.appendChild(infoEl);
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
                const status = `${state.currentPlaybackRate.toFixed(3)}x`;
                textSpan.textContent = `딜레이: ${avgDelay.toFixed(0)}ms (min: ${minDelay.toFixed(0)}ms) / 속도: ${status}`;
            }
            let refreshBtn = infoEl.querySelector('.vsc-delay-refresh-btn');
            if (!refreshBtn) {
                refreshBtn = document.createElement('button');
                refreshBtn.textContent = '🔄';
                refreshBtn.title = '딜레이 측정 재시작';
                refreshBtn.className = 'vsc-delay-refresh-btn';
                Object.assign(refreshBtn.style, {
                    background: 'none', border: 'none', color: 'white', cursor: 'pointer', marginLeft: '5px',
                    fontSize: '14px', padding: '0 2px', verticalAlign: 'middle', pointerEvents: 'auto'
                });
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
            else if (state.isDelayAdjusting && avgDelay <= D_CONFIG.TARGET_DELAY) { state.isDelayAdjusting = false; video.playbackRate = D_CONFIG.NORMAL_RATE; adjustPlaybackRate(D_CONFIG.NORMAL_RATE); }
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
            const infoEl = document.getElementById('vsc-delay-info'); if (infoEl) infoEl.remove();
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

    // [수정] 비디오 크기를 체크하는 로직을 추가
    function findAllMedia(doc = document) {
        const elems = [];
        safeExec(() => {
            const query = 'video, audio';
            const minSize = CONFIG.VIDEO_MIN_SIZE;

            const filterFn = media => {
                // 오디오 요소는 크기 체크 없이 항상 포함
                if (media.tagName === 'AUDIO') return true;
                // 비디오 요소는 실제 표시되는 크기를 기준으로 필터링
                const rect = media.getBoundingClientRect();
                return rect.width >= minSize && rect.height >= minSize;
            };

            // 현재 문서에서 미디어 찾기 및 필터링
            elems.push(...Array.from(doc.querySelectorAll(query)).filter(filterFn));

            // 그림자 DOM(Shadow DOM) 내부에서 미디어 찾기 및 필터링
            (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => {
                 elems.push(...Array.from(root.querySelectorAll(query)).filter(filterFn));
            });

            // 아이프레임(iframe) 내부에서 재귀적으로 미디어 찾기
            doc.querySelectorAll('iframe').forEach(f => {
                try {
                    if (f.contentDocument) {
                        elems.push(...findAllMedia(f.contentDocument));
                    }
                } catch (e) {}
            });
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

    function updateActiveSpeedButton(rate) {
        if (!speedButtonsContainer) return;
        speedButtonsContainer.querySelectorAll('button').forEach(b => {
            const buttonRate = parseFloat(b.dataset.speed);
            b.classList.toggle('active', Math.abs(buttonRate - rate) < 0.01);
        });
    }

    const mediaEventHandlers = {
        play: e => { const m = e.target; audioManager.resumeContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); },
        pause: e => { const m = e.target; audioManager.suspendContext(); if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).filter(med => !med.paused).length === 0) mediaSessionManager.clearSession(); },
        ended: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).filter(med => !med.paused).length === 0) mediaSessionManager.clearSession(); },
        ratechange: e => { updateActiveSpeedButton(e.target.playbackRate); },
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
            setDisplay('vsc-video-controls', hasVideo);
            setDisplay('vsc-audio-controls', hasAudio);
            setDisplay('vsc-image-controls', hasImage);
        }
    };

    const debouncedScanTask = debounce(scanAndApply, CONFIG.DEBOUNCE_DELAY);
    let mainObserver = null;
    let intersectionObserver = null;
    let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null, spaNavigationHandler = null;
    let isInitialized = false;

    function cleanup() {
        safeExec(() => {
            if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
            if (intersectionObserver) { intersectionObserver.disconnect(); intersectionObserver = null; }
            if (spaNavigationHandler) {
                window.removeEventListener('popstate', spaNavigationHandler);
                window.removeEventListener('vsc:pushState', spaNavigationHandler);
                window.removeEventListener('vsc:replaceState', spaNavigationHandler);
                document.removeEventListener('addShadowRoot', debouncedScanTask);
                spaNavigationHandler = null;
            }
            autoDelayManager.stop();
            mediaSessionManager.clearSession();
            setVideoFilterLevel(0);
            setImageFilterLevel(0);
            const allRoots = [document, ...(window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean)];
            allRoots.forEach(root => {
                root.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(el => {
                    el.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active', 'vsc-gpu-accelerated');
                });
            });
            filterManager.toggleStyleSheet(false);
            imageFilterManager.toggleStyleSheet(false);
            audioManager.setAudioMode('off');
            if (state.ui.hostElement) state.ui.hostElement.remove();
            if (speedButtonsContainer) speedButtonsContainer.style.display = 'none';
            resetState();
            settingsManager.init();
            uiManager.reset();
            speedSlider.reset();
            isInitialized = false;
            if (CONFIG.DEBUG) console.log("🧼 Video_Image_Control cleaned up completely.");
        }, 'cleanup');
    }

    function ensureObservers() {
        if (!mainObserver) {
            mainObserver = new MutationObserver(() => scheduleIdleTask(scanAndApply));
            mainObserver.observe(document.documentElement, { childList: true, subtree: true });
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
            if (location.href === state.lastUrl) return;
            if (uiContainer) uiContainer.remove();
            uiContainer = null;
            triggerElement = null;
            speedButtonsContainer = null;
            cleanup();
            initializeGlobalUI();
        }, 500);
        if (!window.vscPatchedHistory) {
            ['pushState', 'replaceState'].forEach(method => {
                const original = history[method];
                if (original) {
                    history[method] = function(...args) {
                        const result = original.apply(this, args);
                        window.dispatchEvent(new Event(`vsc:${method}`));
                        return result;
                    }
                }
            });
            window.vscPatchedHistory = true;
        }
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
        if (uiContainer && state.ui.hostElement) {
            const mainControlsWrapper = uiContainer.querySelector('#vsc-main-controls-wrapper');
            if (mainControlsWrapper) mainControlsWrapper.appendChild(state.ui.hostElement);
        }
        filterManager.init();
        imageFilterManager.init();
        speedSlider.init();
        mediaSessionManager.init();
        ensureObservers();

        const isLive = isLiveStreamPage();
        const hasMedia = findAllMedia().length > 0;

        if (isLive || !hasMedia) {
            if (speedButtonsContainer) speedButtonsContainer.style.display = 'none';
        } else {
            if (speedButtonsContainer) speedButtonsContainer.style.display = 'flex';
        }

        if (isLive) {
            autoDelayManager.start();
        }

        speedSlider.renderControls();
        speedSlider.show();
        setVideoFilterLevel(state.currentVideoFilterLevel);
        setImageFilterLevel(state.currentImageFilterLevel);
        audioManager.setAudioMode(state.currentAudioMode);
        scheduleIdleTask(scanAndApply);
        const initialRate = state.activeMedia.size > 0 ? Array.from(state.activeMedia)[0].playbackRate : 1.0;
        updateActiveSpeedButton(initialRate);
        isInitialized = true;
        if (CONFIG.DEBUG) console.log("🎉 Video_Image_Control initialized.");
    }

    function initializeGlobalUI() {
        if (document.getElementById('vsc-global-container')) return;
        const hasMedia = findAllMedia().length > 0;
        const hasImages = findAllImages().length > 0;
        if (!hasMedia && !hasImages) {
            if (CONFIG.DEBUG) console.log("[VSC] No media or large images found. UI will not be created.");
            return;
        }
        uiContainer = document.createElement('div');
        uiContainer.id = 'vsc-global-container';
        Object.assign(uiContainer.style, {
            position: 'fixed', top: '50%', right: '1.5vmin', transform: 'translateY(-50%)',
            zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'flex-start', gap: '10px'
        });
        const mainControlsWrapper = document.createElement('div');
        mainControlsWrapper.id = 'vsc-main-controls-wrapper';
        Object.assign(mainControlsWrapper.style, {
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0px'
        });
        triggerElement = document.createElement('div');
        triggerElement.id = UI_SELECTORS.TRIGGER;
        triggerElement.textContent = '⚡';
        Object.assign(triggerElement.style, {
            width: 'clamp(32px, 7vmin, 44px)', height: 'clamp(32px, 7vmin, 44px)', background: 'rgba(0, 0, 0, 0.5)',
            color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 'clamp(20px, 4vmin, 26px)', cursor: 'pointer', userSelect: 'none', transition: 'transform 0.2s, background-color 0.2s'
        });
        mainControlsWrapper.appendChild(triggerElement);
        speedButtonsContainer = document.createElement('div');
        speedButtonsContainer.id = 'vsc-speed-buttons-container';
        Object.assign(speedButtonsContainer.style, {
            display: 'none', flexDirection: 'column', gap: '5px'
        });
        const speeds = [4, 2, 1, 0.2];
        speeds.forEach(speed => {
            const btn = document.createElement('button');
            btn.textContent = `${speed}x`;
            btn.dataset.speed = speed;
            btn.className = 'vsc-btn';
            Object.assign(btn.style, {
                width: 'clamp(38px, 8vmin, 50px)', height: 'clamp(28px, 6vmin, 36px)', fontSize: 'clamp(12px, 2.2vmin, 14px)',
            });
            if (speed === 1.0) btn.classList.add('active');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const newSpeed = parseFloat(btn.dataset.speed);
                state.activeMedia.forEach(media => safeExec(() => { media.playbackRate = newSpeed; }));
                updateActiveSpeedButton(newSpeed);
            });
            speedButtonsContainer.appendChild(btn);
        });
        uiContainer.append(mainControlsWrapper, speedButtonsContainer);
        document.body.appendChild(uiContainer);
        let isDragging = false, wasDragged = false, startX, startY, initialTop, initialRight;
        const DRAG_THRESHOLD = 5;
        const onDragStart = (e) => {
            if (!e.composedPath().includes(uiContainer)) return;
            isDragging = true;
            wasDragged = false;
            const pos = e.touches ? e.touches[0] : e;
            startX = pos.clientX;
            startY = pos.clientY;
            const rect = uiContainer.getBoundingClientRect();
            initialTop = rect.top;
            initialRight = window.innerWidth - rect.right;
            uiContainer.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onDragMove, { passive: false });
            document.addEventListener('mouseup', onDragEnd, { passive: false });
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onDragEnd, { passive: false });
        };
        const onDragMove = (e) => {
            if (!isDragging) return;
            const pos = e.touches ? e.touches[0] : e;
            const deltaX = pos.clientX - startX;
            const deltaY = pos.clientY - startY;
            if (!wasDragged && (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD)) {
                wasDragged = true;
                uiContainer.style.transition = 'none';
                uiContainer.style.transform = 'none';
            }
            if (wasDragged) {
                e.preventDefault();
                e.stopImmediatePropagation();
                let newTop = initialTop + deltaY;
                let newRight = initialRight - deltaX;
                const containerRect = uiContainer.getBoundingClientRect();
                newTop = Math.max(0, Math.min(window.innerHeight - containerRect.height, newTop));
                newRight = Math.max(0, Math.min(window.innerWidth - containerRect.width, newRight));
                uiContainer.style.top = `${newTop}px`;
                uiContainer.style.right = `${newRight}px`;
                uiContainer.style.left = 'auto';
                uiContainer.style.bottom = 'auto';
            }
        };
        const onDragEnd = () => {
            if (!isDragging) return;
            isDragging = false;
            uiContainer.style.cursor = 'pointer';
            document.body.style.userSelect = '';
            uiContainer.style.transition = '';
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('touchend', onDragEnd);
            setTimeout(() => { wasDragged = false; }, 0);
        };
        uiContainer.addEventListener('mousedown', onDragStart);
        uiContainer.addEventListener('touchstart', onDragStart, { passive: true });
        triggerElement.addEventListener('click', (e) => {
            if (wasDragged) {
                e.stopPropagation();
                return;
            }
            if (isInitialized) {
                cleanup();
                triggerElement.textContent = '⚡';
                triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            } else {
                start();
                triggerElement.textContent = '❌';
                triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.6)';
            }
        });
        if (!visibilityChangeListener) {
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
        }
        if (!fullscreenChangeListener) {
            fullscreenChangeListener = () => {
                const targetRoot = document.fullscreenElement || document.body;
                if (uiContainer) targetRoot.appendChild(uiContainer);
            };
            document.addEventListener('fullscreenchange', fullscreenChangeListener);
        }
        if (!beforeUnloadListener) {
            beforeUnloadListener = () => {
                if(uiContainer) uiContainer.remove();
                cleanup();
            };
            window.addEventListener('beforeunload', beforeUnloadListener);
        }
        hookSpaNavigation();
    }

    if (!isExcluded()) {
        setTimeout(initializeGlobalUI, 2000);
    }
})();
