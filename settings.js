// ==UserScript==
// @name         Video_Image_Control
// @namespace    https://com/
// @version      58.8
// @description  오디오셋 변경 및 선택 옵션 상자로 변경
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // UI 요소들을 담을 최상위 컨테이너 변수
    let uiContainer = null;
    let triggerElement = null;
    let speedButtonsContainer = null;

    // =================================================================================
    // 1. 설정 및 상수 (Configuration and Constants)
    // =================================================================================

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 3 : 1,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 3 : 1,
        DEFAULT_AUDIO_PRESET: 'off',
        DEBUG: false,
        DEBOUNCE_DELAY: 300,
        THROTTLE_DELAY: 100,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 335,
        VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [4, 2, 1.5, 1, 0.2],
        UI_DRAG_THRESHOLD: 5,
        UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com', 'challenges.cloudflare.com'],
        SPECIFIC_EXCLUSIONS: [],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 103 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.3', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 103 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
        AUDIO_EXCLUSION_DOMAINS: [],
        AUDIO_PRESETS: {
            off: { name: '꺼짐', gain: 1, eq: [] },
            master: { name: 'master', gain: 1.0, eq: [{ freq: 60, gain: 2.0 }, { freq: 150, gain: 2.6 }, { freq: 400, gain: 2.3 }, { freq: 1000, gain: 1.0 }, { freq: 2500, gain: 2.3 }, { freq: 6000, gain: 3.7 }, { freq: 12000, gain: 4.6 }] },
            music: { name: 'music', gain: 1.15, eq: [{ freq: 60, gain: 4 }, { freq: 150, gain: 2.5 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 1 }, { freq: 3000, gain: 3 }, { freq: 6000, gain: 3.5 }, { freq: 12000, gain: 3 }] },
            gaming: { name: 'gaming', gain: 1.1, eq: [{ freq: 60, gain: 3 }, { freq: 250, gain: -1 }, { freq: 1000, gain: 3 }, { freq: 2000, gain: 5 }, { freq: 4000, gain: 6 }, { freq: 8000, gain: 4 }, { freq: 12000, gain: 2 }] },
            liveBroadcast: { name: 'liveBroadcast', gain: 1.1, eq: [{ freq: 80, gain: 2 }, { freq: 150, gain: 1.5 }, { freq: 400, gain: 1 }, { freq: 1000, gain: 3 }, { freq: 2000, gain: 3.5 }, { freq: 3000, gain: 3 }, { freq: 6000, gain: 2 }, { freq: 12000, gain: 2 }] },
            movie: { name: 'movie', gain: 1.25, eq: [{ freq: 80, gain: 6 }, { freq: 200, gain: 4 }, { freq: 500, gain: 1 }, { freq: 1000, gain: 2 }, { freq: 3000, gain: 3.5 }, { freq: 6000, gain: 5 }, { freq: 10000, gain: 4 }] }
        },
        MAX_EQ_BANDS: 7
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
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 5 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 5 },
            audioPreset: { name: '기본 오디오 프리셋', default: CONFIG.DEFAULT_AUDIO_PRESET, type: 'string', options: ['off', 'master', 'liveBroadcast', 'movie', 'music', 'gaming'] }
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
            delayCheckInterval: null,
            currentPlaybackRate: 1.0,
            mediaTypesEverFound: { video: false, audio: false, image: false },
            lastUrl: ''
        });
    }

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { console.error(`[VSC] Error in ${label}:`, e); } }
    const debounce = (fn, wait) => { let timeoutId; return (...args) => { clearTimeout(timeoutId); timeoutId = setTimeout(() => fn.apply(this, args), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };
    function calculateSharpenMatrix(level) { const parsedLevel = parseInt(level, 10); if (isNaN(parsedLevel) || parsedLevel === 0) return '0 0 0 0 1 0 0 0 0'; const intensity = 1 + (parsedLevel - 0.5) * (5.0 / 4); const off = (1 - intensity) / 4; return `0 ${off} 0 ${off} ${intensity} ${off} 0 ${off} 0`; }

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    function isExcluded() {
    const url = location.href.toLowerCase();

    if (CONFIG.EXCLUSION_KEYWORDS.some(keyword => url.includes(keyword))) {
        return true;
    }

    // 페이지 요소(iframe)를 검사하는 로직도 추가하면 더 안전하지만,
    // 대부분의 경우 위의 URL 검사만으로도 충분합니다.
    if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) {
        return true;
    }

    return false;
}
    if (isExcluded()) return; Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
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
            '* { pointer-events: auto; -webkit-tap-highlight-color: transparent; }',
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
            const createFilterControl = (id, labelText, mainIcon, changeHandler, options) => {
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
                options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.text;
                    select.appendChild(option);
                });
                select.addEventListener('change', e => {
                    changeHandler(e.target.value);
                    clearTimeout(fadeOutTimer);
                    startFadeSequence();
                });
                subMenu.appendChild(select);
                group.append(mainBtn, subMenu);
                return group;
            };

            const videoOptions = [
                { value: "0", text: "꺼짐" },
                ...Array.from({ length: settingsManager.definitions.videoFilterLevel.max }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))
            ];
            const imageOptions = [
                { value: "0", text: "꺼짐" },
                ...Array.from({ length: settingsManager.definitions.imageFilterLevel.max }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))
            ];
            const audioOptions = [
                { value: "off", text: "꺼짐" },
                { value: "master", text: "master" },
                { value: "music", text: "music" },
                { value: "gaming", text: "gaming" },
                { value: "liveBroadcast", text: "liveBroadcast" },
                { value: "movie", text: "movie" }
            ];

            const videoControlGroup = createFilterControl('vsc-video-controls', '영상 선명도', '✨', setVideoFilterLevel, videoOptions);
            const imageControlGroup = createFilterControl('vsc-image-controls', '이미지 선명도', '🎨', setImageFilterLevel, imageOptions);
            const audioControlGroup = createFilterControl('vsc-audio-controls', '오디오 EQ', '🎧', audioManager.setAudioMode, audioOptions);

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
            audioControlGroup.querySelector('.vsc-btn-main').addEventListener('click', (e) => handleMenuButtonClick(e, audioControlGroup));

            const updateActiveButtons = () => {
                const videoSelect = shadowRoot.querySelector('#vsc-video-controls select');
                if (videoSelect) videoSelect.value = state.currentVideoFilterLevel;
                const imageSelect = shadowRoot.querySelector('#vsc-image-controls select');
                if (imageSelect) imageSelect.value = state.currentImageFilterLevel;
                const audioSelect = shadowRoot.querySelector('#vsc-audio-controls select');
                if (audioSelect) audioSelect.value = state.currentAudioMode;
            };

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
                setAction('play', () => safeExec(() => m.play()));
                setAction('pause', () => safeExec(() => m.pause()));
                setAction('seekbackward', () => safeExec(() => { m.currentTime -= getSeekTime(m); }));
                setAction('seekforward', () => safeExec(() => { m.currentTime += getSeekTime(m); }));
                setAction('seekto', d => safeExec(() => { if (d.fastSeek && 'fastSeek' in m) { m.fastSeek(d.seekTime); } else { m.currentTime = d.seekTime; } }));
            }, 'mediaSession.set');
        }
        function clearSession() { if (!('mediaSession' in navigator)) return; safeExec(() => { navigator.mediaSession.metadata = null; ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setAction(a, null)); }, 'mediaSession.clear'); }
        return { init, setSession, clearSession };
    })();

    const autoDelayManager = (() => {
    let video = null;
    const DELAY_HISTORY_SIZE = 30;
    let delayHistory = [];

    // 모든 관련 설정을 내부 상수로 관리
    const CHECK_INTERVAL = 500;
    const TARGET_DELAY = 1500;
    const MIN_RATE = 0.95;
    const MAX_RATE = 1.05;
    const TOLERANCE = 150;

    let localIntersectionObserver;

    function isYouTubeLive() {
        if (!location.href.includes('youtube.com')) return false;
        try {
            const liveBadge = document.querySelector('.ytp-live-badge');
            // 배지가 실제로 보이고, '다시보기'를 의미하는 텍스트가 없는 경우에만 진짜 라이브로 판단
            return liveBadge && liveBadge.offsetParent !== null && !/스트림이었음|was live/i.test(liveBadge.textContent);
        } catch {
            return false;
        }
    }

    function findVideo() {
        return state.activeMedia.size > 0 ? Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO') : null;
    }

    function calculateDelay(videoElement) {
        if (!videoElement || !videoElement.buffered || videoElement.buffered.length === 0) return null;
        try {
            const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
            return Math.max(0, (bufferedEnd - videoElement.currentTime) * 1000);
        } catch {
            return null;
        }
    }

    function recordDelay(rawDelay) {
        delayHistory.push(rawDelay);
        if (delayHistory.length > DELAY_HISTORY_SIZE) delayHistory.shift();
    }

    function getAverageDelay() {
        if (delayHistory.length === 0) return null;
        return delayHistory.reduce((a, b) => a + b, 0) / delayHistory.length;
    }

    function getPlaybackRate(avgDelay) {
        const diff = avgDelay - TARGET_DELAY;
        if (Math.abs(diff) <= TOLERANCE) {
            return 1.0;
        }
        const rateAdjustment = diff / 12000;
        const newRate = 1.0 + rateAdjustment;
        return Math.max(MIN_RATE, Math.min(newRate, MAX_RATE));
    }

    function adjustPlaybackRate(videoElement, targetRate) {
        if (!videoElement) return;
        if (Math.abs(videoElement.playbackRate - targetRate) < 0.001) return;
        safeExec(() => {
            videoElement.playbackRate = targetRate;
            state.currentPlaybackRate = targetRate;
        });
    }

    function displayDelayInfo(avgDelay, rawDelay) {
        let infoEl = document.getElementById('vsc-delay-info');
        if (!infoEl) {
            infoEl = document.createElement('div');
            infoEl.id = 'vsc-delay-info';
            Object.assign(infoEl.style, {
                position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1,
                background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px',
                fontFamily: 'monospace', fontSize: '10pt', lineHeight: '1.2', opacity: '0.8',
                display: 'flex', alignItems: 'center', pointerEvents: 'none'
            });
            document.body.appendChild(infoEl);
        }
        let textSpan = infoEl.querySelector('span');
        if (!textSpan) {
            textSpan = document.createElement('span');
            infoEl.prepend(textSpan);
        }
        textSpan.textContent = `딜레이: ${avgDelay.toFixed(0)}ms / 현재: ${rawDelay.toFixed(0)}ms / 배속: ${state.currentPlaybackRate.toFixed(3)}x`;
    }

    function checkAndAdjust() {
        if (!video) video = findVideo();
        if (!video) return;

        const rawDelay = calculateDelay(video);
        if (rawDelay === null) return;

        recordDelay(rawDelay);
        const avgDelay = getAverageDelay();
        if (avgDelay === null) return;

        if (location.href.includes('youtube.com') && !isYouTubeLive()) {
            if (video.playbackRate !== 1.0) {
                safeExec(() => { video.playbackRate = 1.0; state.currentPlaybackRate = 1.0; });
            }
            const infoEl = document.getElementById('vsc-delay-info');
            if (infoEl) infoEl.remove();
            return;
        }

        const newRate = getPlaybackRate(avgDelay);
        adjustPlaybackRate(video, newRate);
        displayDelayInfo(avgDelay, rawDelay);
    }

    function setupIntersectionObserver() {
        if (localIntersectionObserver) return;
        localIntersectionObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting && entry.target.tagName === 'VIDEO') video = entry.target;
            });
        }, { threshold: 0.5 });
        state.activeMedia.forEach(media => {
            if (media.tagName === 'VIDEO') localIntersectionObserver.observe(media);
        });
    }

    function start() {
        if (!CONFIG.LIVE_STREAM_URLS.some(domain => location.href.includes(domain))) return;
        if (location.href.includes('youtube.com') && !isYouTubeLive()) return;
        if (state.delayCheckInterval) return;

        delayHistory = [];
        video = findVideo();
        if(video) {
            state.currentPlaybackRate = video.playbackRate;
        }

        setupIntersectionObserver();
        state.delayCheckInterval = setInterval(checkAndAdjust, CHECK_INTERVAL);
    }

    function stop() {
        if (state.delayCheckInterval) clearInterval(state.delayCheckInterval);
        state.delayCheckInterval = null;
        if (localIntersectionObserver) localIntersectionObserver.disconnect();
        localIntersectionObserver = null;
        if (video) safeExec(() => { if (video.playbackRate !== 1.0) video.playbackRate = 1.0; video = null; });
        delayHistory = [];
        const infoEl = document.getElementById('vsc-delay-info');
        if (infoEl) infoEl.remove();
    }

    return { start, stop };
})();

    function findAllMedia(doc = document) {
        const elems = [];
        const query = 'video, audio';
        const minSize = CONFIG.VIDEO_MIN_SIZE;
        const filterFn = media => {
            if (media.tagName === 'AUDIO') return true;
            const rect = media.getBoundingClientRect();
            return rect.width >= minSize || rect.height >= minSize;
        };
        safeExec(() => {
            elems.push(...Array.from(doc.querySelectorAll(query)).filter(filterFn));
            (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => {
                try {
                    elems.push(...Array.from(root.querySelectorAll(query)).filter(filterFn));
                } catch (e) {
                    console.warn('[VSC] Failed to query a shadow root.', e);
                }
            });
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
        const size = CONFIG.IMAGE_MIN_SIZE;
        const filterFn = img => img.naturalWidth > size && img.naturalHeight > size;
        safeExec(() => {
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
            const isActive = Math.abs(buttonRate - rate) < 0.01;
            b.style.boxShadow = isActive ? '0 0 5px #3498db, 0 0 10px #3498db inset' : 'none';
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

            if (speedButtonsContainer) {
                speedButtonsContainer.style.display = hasVideo ? 'flex' : 'none';
            }

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
    let isInitialized = false;

    function cleanup() {
        safeExec(() => {
            if (mainObserver) { mainObserver.disconnect(); mainObserver = null; }
            if (intersectionObserver) { intersectionObserver.disconnect(); intersectionObserver = null; }

            globalUIManager.cleanupGlobalListeners();

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
            const filterControls = state.ui.shadowRoot?.getElementById('vsc-container');
            if (filterControls) filterControls.style.display = 'none';
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
            mainObserver = new MutationObserver((mutations) => {
                if (mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) {
                    scheduleIdleTask(() => scanAndApply());
                }
            });
            mainObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        if (!intersectionObserver) {
            intersectionObserver = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    e.target.dataset.isVisible = String(e.isIntersecting);
                    if (e.target.tagName === 'VIDEO') updateVideoFilterState(e.target);
                    if (e.target.tagName === 'IMG') updateImageFilterState(e.target);
                });
            }, { rootMargin: '200px 0px 200px 0px' });
        }
    }

    let spaNavigationHandler = null;
    function hookSpaNavigation() {
        if (spaNavigationHandler) return;
        spaNavigationHandler = debounce(() => {
            if (location.href === state.lastUrl) return;

            if (uiContainer) {
                uiContainer.remove();
                uiContainer = null;
                triggerElement = null;
                speedButtonsContainer = null;
            }
            cleanup();
            setTimeout(initializeGlobalUI, 500);
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

        const hasMedia = findAllMedia().length > 0;
        if (hasMedia) {
            showWarningMessage("주의: 일부 영상은 오디오 필터 적용 시 CORS 보안 정책으로 인해 무음 처리될 수 있습니다.");
        }

        autoDelayManager.start();

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

    function showWarningMessage(message) {
        if (document.getElementById('vsc-warning-bar')) return;

        const warningEl = document.createElement('div');
        warningEl.id = 'vsc-warning-bar';
        const messageSpan = document.createElement('span');
        const closeBtn = document.createElement('button');
        let hideTimeout;

        Object.assign(warningEl.style, {
            position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px',
            borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX - 1, display: 'flex',
            alignItems: 'center', gap: '15px', fontSize: '14px', fontFamily: 'sans-serif',
            boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0',
            transition: 'opacity 0.5s ease-in-out', maxWidth: '90%',
        });

        messageSpan.textContent = message;

        Object.assign(closeBtn.style, {
            background: 'none', border: 'none', color: '#aaa', fontSize: '20px',
            cursor: 'pointer', lineHeight: '1', padding: '0',
        });

        closeBtn.textContent = '×';

        const removeWarning = () => {
            clearTimeout(hideTimeout);
            warningEl.style.opacity = '0';
            setTimeout(() => warningEl.remove(), 500);
        };

        closeBtn.onclick = removeWarning;
        warningEl.append(messageSpan, closeBtn);
        document.body.appendChild(warningEl);

        setTimeout(() => (warningEl.style.opacity = '1'), 100);
        hideTimeout = setTimeout(removeWarning, CONFIG.UI_WARN_TIMEOUT);
    }

    // =================================================================================
    // 4. 전역 UI 관리자 (Global UI Manager)
    // =================================================================================
    const globalUIManager = (() => {
        let isDragging = false, wasDragged = false;
        let startPos = { x: 0, y: 0 }, translatePos = { x: 0, y: 0 }, startRect = null;
        let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null;

        function createUIElements() {
            uiContainer = document.createElement('div');
            uiContainer.id = 'vsc-global-container';
            Object.assign(uiContainer.style, {
                position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%)',
                zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '0px',
                '-webkit-tap-highlight-color': 'transparent'
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
                fontSize: 'clamp(20px, 4vmin, 26px)', cursor: 'pointer', userSelect: 'none', transition: 'transform 0.2s, background-color 0.2s', // 여기에 쉼표(,)를 추가하세요.
                '-webkit-tap-highlight-color': 'transparent'
            });

            speedButtonsContainer = document.createElement('div');
            speedButtonsContainer.id = 'vsc-speed-buttons-container';
            Object.assign(speedButtonsContainer.style, {
                display: 'none', flexDirection: 'column', gap: '5px', alignItems: 'center'
            });

            CONFIG.SPEED_PRESETS.forEach(speed => {
                const btn = document.createElement('button');
                btn.textContent = `${speed}x`;
                btn.dataset.speed = speed;
                btn.className = 'vsc-btn';
                Object.assign(btn.style, {
                    width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)',
                    background: 'rgba(52, 152, 219, 0.5)', color: 'white', border: 'none',
                    borderRadius: 'clamp(4px, 0.8vmin, 6px)', cursor: 'pointer',
                    '-webkit-tap-highlight-color': 'transparent'
                });
                if (speed === 1.0) {
                    btn.style.boxShadow = '0 0 5px #3498db, 0 0 10px #3498db inset';
                }
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newSpeed = parseFloat(btn.dataset.speed);
                    state.activeMedia.forEach(media => safeExec(() => { media.playbackRate = newSpeed; }));
                    updateActiveSpeedButton(newSpeed);
                });
                speedButtonsContainer.appendChild(btn);
            });

            mainControlsWrapper.appendChild(triggerElement);
            uiContainer.append(mainControlsWrapper, speedButtonsContainer);
            document.body.appendChild(uiContainer);
        }

        function handleTriggerClick() {
            if (wasDragged) return;
            if (isInitialized) {
                cleanup();
                triggerElement.textContent = '⚡';
                triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
            } else {
                try {
                    start();
                    triggerElement.textContent = '❌';
                    triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                } catch (err) {
                    console.error('[VSC] Failed to initialize.', err);
                    triggerElement.textContent = '⚠️';
                    triggerElement.title = '스크립트 초기화 실패! 콘솔을 확인하세요.';
                    triggerElement.style.backgroundColor = 'rgba(255, 165, 0, 0.5)';
                }
            }
        }

        function attachDragAndDrop() {
            const clampTranslate = () => {
                if (!uiContainer) return;
                const rect = uiContainer.getBoundingClientRect();
                const parentWidth = window.innerWidth;
                const parentHeight = window.innerHeight;
                let newX = translatePos.x;
                let newY = translatePos.y;
                if (rect.left < 0) newX -= rect.left;
                if (rect.top < 0) newY -= rect.top;
                if (rect.right > parentWidth) newX -= (rect.right - parentWidth);
                if (rect.bottom > parentHeight) newY -= (rect.bottom - parentHeight);
                translatePos.x = newX;
                translatePos.y = newY;
                uiContainer.style.transform = `translateY(-50%) translate(${translatePos.x}px, ${translatePos.y}px)`;
            };

            const onDragStart = (e) => {
                if (!e.composedPath().includes(uiContainer)) return;
                isDragging = true;
                wasDragged = false;
                const pos = e.touches ? e.touches[0] : e;
                startPos = { x: pos.clientX, y: pos.clientY };
                startRect = uiContainer.getBoundingClientRect();
                uiContainer.style.transition = 'none';
                uiContainer.style.cursor = 'grabbing';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onDragMove, { passive: false });
                document.addEventListener('mouseup', onDragEnd, { passive: true });
                document.addEventListener('touchmove', onDragMove, { passive: false });
                document.addEventListener('touchend', onDragEnd, { passive: true });
            };

            const onDragMove = (e) => {
                if (!isDragging) return;
                e.preventDefault();
                const pos = e.touches ? e.touches[0] : e;
                const deltaX = pos.clientX - startPos.x;
                const deltaY = pos.clientY - startPos.y;
                let newLeft = startRect.left + deltaX;
                let newTop = startRect.top + deltaY;
                const parentWidth = window.innerWidth;
                const parentHeight = window.innerHeight;
                newLeft = Math.max(0, Math.min(newLeft, parentWidth - startRect.width));
                newTop = Math.max(0, Math.min(newTop, parentHeight - startRect.height));
                const finalTranslateX = translatePos.x + (newLeft - startRect.left);
                const finalTranslateY = translatePos.y + (newTop - startRect.top);
                uiContainer.style.transform = `translateY(-50%) translate(${finalTranslateX}px, ${finalTranslateY}px)`;
                if (!wasDragged && (Math.abs(deltaX) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(deltaY) > CONFIG.UI_DRAG_THRESHOLD)) {
                    wasDragged = true;
                }
            };

            const onDragEnd = () => {
                if (!isDragging) return;
                const finalTransform = uiContainer.style.transform;
                const matches = finalTransform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
                if (matches) {
                    translatePos.x = parseFloat(matches[1]);
                    translatePos.y = parseFloat(matches[2]);
                }
                isDragging = false;
                uiContainer.style.transition = '';
                uiContainer.style.cursor = 'pointer';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragEnd);
                document.removeEventListener('touchmove', onDragMove);
                document.removeEventListener('touchend', onDragEnd);
                setTimeout(() => { wasDragged = false; }, 0);
            };

            uiContainer.addEventListener('mousedown', onDragStart, { passive: true });
            uiContainer.addEventListener('touchstart', onDragStart, { passive: true });
            const debouncedClamp = debounce(clampTranslate, 100);
            window.addEventListener('resize', debouncedClamp);
            window.addEventListener('orientationchange', debouncedClamp);
        }

        function attachGlobalListeners() {
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
        }

        function cleanupGlobalListeners() {
            if (visibilityChangeListener) {
                document.removeEventListener('visibilitychange', visibilityChangeListener);
                visibilityChangeListener = null;
            }
            if (fullscreenChangeListener) {
                document.removeEventListener('fullscreenchange', fullscreenChangeListener);
                fullscreenChangeListener = null;
            }
            if (beforeUnloadListener) {
                window.removeEventListener('beforeunload', beforeUnloadListener);
                beforeUnloadListener = null;
            }
        }

        function init() {
            createUIElements();
            triggerElement.addEventListener('click', (e) => {
                if(wasDragged) {
                    e.stopPropagation();
                    return;
                }
                handleTriggerClick();
            });
            attachDragAndDrop();
            attachGlobalListeners();
        }

        return { init, cleanupGlobalListeners };
    })();

    function initializeGlobalUI() {
        if (document.getElementById('vsc-global-container')) return;

        const initialMediaCheck = () => {
            const hasMedia = findAllMedia().length > 0;
            const hasImages = findAllImages().length > 0;
            if (hasMedia || hasImages) {
                if (!document.getElementById('vsc-global-container')) {
                     globalUIManager.init();
                     hookSpaNavigation();
                }
                if (mediaObserver) mediaObserver.disconnect();
            }
        };

        const mediaObserver = new MutationObserver(debounce(initialMediaCheck, 500));
        mediaObserver.observe(document.body, { childList: true, subtree: true });

        initialMediaCheck();
    }

    if (!isExcluded()) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initializeGlobalUI, 2000));
        } else {
            setTimeout(initializeGlobalUI, 2000);
        }
    }
})();
