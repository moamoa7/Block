// ==UserScript==
// @name         Video_Image_Control (with Audio Tuner)
// @namespace    https://com/
// @version      62.0 (Integrated Tuner)
// @description  All-in-one script with real-time Delay/HPF sliders for the stereo widening effect.
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // UI 요소들을 담을 최상위 컨테이너 변수
    let uiContainer = null;
    let triggerElement = null;
    let speedButtonsContainer = null;

    // SPA 지원 강화를 위한 titleObserver 변수 추가
    let titleObserver = null;

    // =================================================================================
    // 1. 설정 및 상수 (Configuration and Constants)
    // =================================================================================

    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);

    // ===============================================================================
    // ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼ [ 라이브 딜레이 설정 ] ▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼▼
    //
    // 사이트별로 원하는 딜레이 값을 밀리초(ms) 단위로 직접 입력하세요. (1000ms = 1초)
    //
    const TARGET_DELAYS = {
        "youtube.com": 2750,
        "chzzk.naver.com": 2000,
        "play.sooplive.co.kr": 2000,
        "twitch.tv": 2000,
        "kick.com": 2000,
    };
    const DEFAULT_TARGET_DELAY = 2000; // 목록에 없는 사이트의 기본 딜레이 값
    //
    // ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲ [ 라이브 딜레이 설정 끝 ] ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
    // ===============================================================================

    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: isMobile ? 3 : 1,
        DEFAULT_IMAGE_FILTER_LEVEL: isMobile ? 3 : 1,
        DEFAULT_STEREO_WIDENING_ENABLED: false,
        STEREO_WIDENING_DELAY_MS: 25,
        STEREO_HPF_FREQUENCY: 120,
        DEBUG: false,
        DEBOUNCE_DELAY: 300,
        THROTTLE_DELAY: 100,
        MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05,
        SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 355,
        VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [4, 2, 1.5, 1, 0.2],
        UI_DRAG_THRESHOLD: 5,
        UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'youtube.com', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com', 'challenges.cloudflare.com'],
        SPECIFIC_EXCLUSIONS: [],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 115 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0.2', SHADOWS_VALUE: -2, HIGHLIGHTS_VALUE: 5, SATURATION_VALUE: 115 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0.3', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'], }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] }, },
        FILTER_EXCLUSION_DOMAINS: [],
        IMAGE_FILTER_EXCLUSION_DOMAINS: [],
    };

    const UI_SELECTORS = {
        HOST: 'vsc-ui-host',
        CONTAINER: 'vsc-container',
        TRIGGER: 'vsc-trigger-button',
        CONTROL_GROUP: 'vsc-control-group', SUBMENU: 'vsc-submenu', BTN: 'vsc-btn', BTN_MAIN: 'vsc-btn-main', SELECT: 'vsc-select', VIDEO_CONTROLS: 'vsc-video-controls', IMAGE_CONTROLS: 'vsc-image-controls'
    };

    // 현재 사이트에 맞는 TARGET_DELAY 값을 가져오는 함수
    function getTargetDelay() {
        const host = location.hostname;
        for (const site in TARGET_DELAYS) {
            if (host.includes(site)) {
                return TARGET_DELAYS[site];
            }
        }
        return DEFAULT_TARGET_DELAY; // 기본값
    }

    const settingsManager = (() => {
        const settings = {};
        const definitions = {
            videoFilterLevel: { name: '기본 영상 선명도', default: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, type: 'number', min: 0, max: 5 },
            imageFilterLevel: { name: '기본 이미지 선명도', default: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, type: 'number', min: 0, max: 5 }
        };
        function init() { Object.keys(definitions).forEach(key => { settings[key] = definitions[key].default; }); }
        const get = (key) => settings[key];
        const set = (key, value) => { settings[key] = value; };
        return { init, get, set, definitions };
    })();

    settingsManager.init();
    const state = {};
    resetState()
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
            isStereoWideningEnabled: CONFIG.DEFAULT_STEREO_WIDENING_ENABLED,
            audioContextMap: new WeakMap(),
            // 오디오 튜너의 현재 상태를 저장
            currentDelayMs: CONFIG.STEREO_WIDENING_DELAY_MS,
            currentHpfHz: CONFIG.STEREO_HPF_FREQUENCY,
            ui: { shadowRoot: null, hostElement: null },
            delayCheckInterval: null,
            currentPlaybackRate: 1.0,
            mediaTypesEverFound: { video: false, image: false },
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

    const stereoWideningManager = (() => {
        function createAudioGraph(media) {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            const source = context.createMediaElementSource(media);

            const dryGain = context.createGain();
            const wetGain = context.createGain();
            const splitter = context.createChannelSplitter(2);
            const merger = context.createChannelMerger(2);
            const delay = context.createDelay();
            const hpf = context.createBiquadFilter();

            // 초기값 설정 (전역 state에서 현재 튜너 값을 가져옴)
            delay.delayTime.value = state.currentDelayMs / 1000;
            dryGain.gain.value = 1.0;
            wetGain.gain.value = state.isStereoWideningEnabled ? 1.0 : 0.0;
            hpf.type = 'highpass';
            hpf.frequency.value = state.currentHpfHz;
            hpf.Q.value = 0.7;

            source.connect(dryGain).connect(context.destination);
            source.connect(splitter);
            splitter.connect(delay, 0);
            splitter.connect(merger, 1, 1);
            delay.connect(merger, 0, 0);
            merger.connect(hpf).connect(wetGain).connect(context.destination);

            const nodes = { context, source, dryGain, wetGain, delay, hpf };
            state.audioContextMap.set(media, nodes);
            return nodes;
        }

        function apply(media) {
            let nodes = state.audioContextMap.get(media);
            if (!nodes) {
                try {
                    if (media.HAVE_CURRENT_DATA) {
                       nodes = createAudioGraph(media);
                    } else {
                        media.addEventListener('canplay', () => !state.audioContextMap.has(media) && createAudioGraph(media), { once: true });
                        return;
                    }
                } catch (e) { console.error('[VSC] 오디오 그래프 생성 실패:', e); return; }
            }
            if (nodes.context.state === 'suspended') nodes.context.resume();
            nodes.wetGain.gain.setValueAtTime(1, nodes.context.currentTime);
        }

        function remove(media) {
            const nodes = state.audioContextMap.get(media);
            if (nodes) nodes.wetGain.gain.setValueAtTime(0, nodes.context.currentTime);
        }

        function cleanupForMedia(media) {
            const nodes = state.audioContextMap.get(media);
            if (nodes) {
                safeExec(() => {
                    nodes.source.disconnect();
                    if (nodes.context.state !== 'closed') nodes.context.close();
                });
                state.audioContextMap.delete(media);
            }
        }

        return { apply, remove, cleanupForMedia };
    })();

    function setStereoWideningEnabled(enabled) {
        state.isStereoWideningEnabled = !!enabled;
        const btn = state.ui.shadowRoot?.getElementById('vsc-stereo-toggle');
        if (btn) btn.classList.toggle('active', state.isStereoWideningEnabled);
        state.activeMedia.forEach(media => state.isStereoWideningEnabled ? stereoWideningManager.apply(media) : stereoWideningManager.remove(media));
    }

    function setVideoFilterLevel(level) {
        if (CONFIG.FILTER_EXCLUSION_DOMAINS.includes(location.hostname) && level > 0) return;
        if (!filterManager.isInitialized() && level > 0) filterManager.init();
        const newLevel = parseInt(level, 10);
        state.currentVideoFilterLevel = isNaN(newLevel) ? 0 : newLevel;
        settingsManager.set('videoFilterLevel', state.currentVideoFilterLevel);
        const newMatrix = calculateSharpenMatrix(state.currentVideoFilterLevel);
        filterManager.setSharpenMatrix(newMatrix);
        (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => filterManager.setSharpenMatrix(newMatrix, root));
        state.activeMedia.forEach(media => { if (media.tagName === 'VIDEO') updateVideoFilterState(media); });
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

    const uiManager = (() => {
        const styleRules = [
            ':host { pointer-events: none; }',
            '* { pointer-events: auto; -webkit-tap-highlight-color: transparent; }',
            '#vsc-container { background: none; padding: clamp(6px, 1.2vmin, 10px); border-radius: clamp(8px, 1.5vmin, 12px); z-index: 100; display: none; flex-direction: column; align-items: flex-end; width: auto; opacity: 0.3; transition: opacity 0.3s; margin-top: 5px; }',
            '#vsc-container.touched { opacity: 1; }',
            '@media (hover: hover) { #vsc-container:hover { opacity: 1; } }',
            '.vsc-control-group { display: flex; align-items: center; justify-content: flex-end; margin-top: clamp(3px, 0.8vmin, 5px); height: clamp(26px, 5.5vmin, 32px); width: clamp(28px, 6vmin, 34px); position: relative; }',
            '.vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(8px, 1.5vmin, 12px); gap: clamp(8px, 1.5vmin, 12px); width: 200px; }',
            '.vsc-control-group.submenu-visible .vsc-submenu { display: flex; }',
            '.vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(12px, 2vmin, 14px); }',
            '.vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }',
            '.vsc-btn-main { font-size: clamp(15px, 3vmin, 18px); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }',
            '.vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); }',
            '.slider-control { display: flex; flex-direction: column; gap: 5px; }',
            '.slider-control label { display: flex; justify-content: space-between; font-size: 13px; color: white; }',
            'input[type=range] { width: 100%; margin: 0; }'
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
        return { init: () => safeExec(init, 'uiManager.init'), reset: () => safeExec(reset, 'uiManager.reset') };
    })();

    const speedSlider = (() => {
        let inited = false, fadeOutTimer;
        let hideAllSubMenus = () => {};
        function startFadeSequence() {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
            if (!container) return;
            hideAllSubMenus();
            container.classList.remove('touched');
            container.style.opacity = '0.3';
        }
        function reset() { inited = false; }
        const createButton = (id, title, text, className = 'vsc-btn') => {
            const btn = document.createElement('button');
            if (id) btn.id = id;
            btn.className = className;
            btn.title = title;
            btn.textContent = text;
            return btn;
        };
        const resetFadeTimer = () => {
            const container = state.ui?.shadowRoot?.getElementById('vsc-container');
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
            container.innerHTML = '';
            container.dataset.rendered = 'true';

            // --- 헬퍼 함수 ---
            const createControlGroup = (id, mainIcon, title) => {
                const group = document.createElement('div');
                group.id = id;
                group.className = 'vsc-control-group';
                const mainBtn = createButton(null, title, mainIcon, 'vsc-btn vsc-btn-main');
                const subMenu = document.createElement('div');
                subMenu.className = 'vsc-submenu';
                group.append(mainBtn, subMenu);
                return { group, mainBtn, subMenu };
            };

            const createSelectControl = (labelText, options, changeHandler) => {
                const select = document.createElement('select');
                select.className = 'vsc-select';
                const disabledOption = new Option(labelText, "", true, true);
                disabledOption.disabled = true;
                select.add(disabledOption);
                options.forEach(opt => select.add(new Option(opt.text, opt.value)));
                select.addEventListener('change', e => {
                    changeHandler(e.target.value);
                    startFadeSequence();
                });
                return select;
            };

            const createSliderControl = (label, id, min, max, step, value, unit) => {
                const controlDiv = document.createElement('div');
                controlDiv.className = 'slider-control';
                const labelEl = document.createElement('label');
                const valueSpan = document.createElement('span');
                valueSpan.id = `${id}Val`;
                valueSpan.textContent = `${value}${unit}`;
                labelEl.textContent = `${label}: `;
                labelEl.appendChild(valueSpan);
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.id = id;
                slider.min = min; slider.max = max; slider.step = step; slider.value = value;
                controlDiv.append(labelEl, slider);
                return { controlDiv, slider, valueSpan };
            };

            // --- 컨트롤 생성 ---
            const videoOptions = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 5 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];
            const imageOptions = [{ value: "0", text: "꺼짐" }, ...Array.from({ length: 5 }, (_, i) => ({ value: (i + 1).toString(), text: `${i + 1}단계` }))];

            const { group: imageGroup, subMenu: imageSubMenu } = createControlGroup('vsc-image-controls', '🎨', '이미지 선명도');
            imageSubMenu.appendChild(createSelectControl('이미지 선명도', imageOptions, setImageFilterLevel));

            const { group: videoGroup, subMenu: videoSubMenu } = createControlGroup('vsc-video-controls', '✨', '영상 선명도');
            videoSubMenu.appendChild(createSelectControl('영상 선명도', videoOptions, setVideoFilterLevel));

            const { group: stereoGroup, subMenu: stereoSubMenu } = createControlGroup('vsc-stereo-controls', '🎧', '스테레오 확장');

            // 튜너 UI 생성
            const toggleBtn = createButton('vsc-stereo-toggle', '효과 ON/OFF', '효과 켜기', 'vsc-btn');
            toggleBtn.style.width = '100%';
            toggleBtn.onclick = () => setStereoWideningEnabled(!state.isStereoWideningEnabled);

            const delaySlider = createSliderControl('Delay', 'delaySlider', 0, 40, 1, state.currentDelayMs, 'ms');
            delaySlider.slider.oninput = () => {
                const val = parseFloat(delaySlider.slider.value);
                state.currentDelayMs = val;
                delaySlider.valueSpan.textContent = `${val}ms`;
                for (const nodes of state.audioContextMap.values()) {
                    if (nodes.delay) nodes.delay.delayTime.value = val / 1000;
                }
            };

            const hpfSlider = createSliderControl('HPF', 'hpfSlider', 50, 500, 10, state.currentHpfHz, 'Hz');
            hpfSlider.slider.oninput = () => {
                const val = parseFloat(hpfSlider.slider.value);
                state.currentHpfHz = val;
                hpfSlider.valueSpan.textContent = `${val}Hz`;
                for (const nodes of state.audioContextMap.values()) {
                    if (nodes.hpf) nodes.hpf.frequency.value = val;
                }
            };

            stereoSubMenu.append(toggleBtn, delaySlider.controlDiv, hpfSlider.controlDiv);
            container.append(imageGroup, videoGroup, stereoGroup);

            // 메뉴 상호작용
            const allGroups = [imageGroup, videoGroup, stereoGroup];
            hideAllSubMenus = () => allGroups.forEach(g => g.classList.remove('submenu-visible'));
            const handleMenuButtonClick = (e, groupToShow) => {
                e.stopPropagation();
                const isOpening = !groupToShow.classList.contains('submenu-visible');
                hideAllSubMenus();
                if (isOpening) groupToShow.classList.add('submenu-visible');
                resetFadeTimer();
            };
            allGroups.forEach(g => g.querySelector('.vsc-btn-main').onclick = (e) => handleMenuButtonClick(e, g));

            const updateActiveButtons = () => {
                shadowRoot.querySelector('#vsc-image-controls select').value = state.currentImageFilterLevel;
                shadowRoot.querySelector('#vsc-video-controls select').value = state.currentVideoFilterLevel;
                const stereoToggle = shadowRoot.getElementById('vsc-stereo-toggle');
                if (stereoToggle) {
                    stereoToggle.classList.toggle('active', state.isStereoWideningEnabled);
                    stereoToggle.textContent = state.isStereoWideningEnabled ? '효과 켜짐' : '효과 꺼짐';
                }
            };
            container.addEventListener('pointerdown', resetFadeTimer);
            updateActiveButtons();
        }
        return {
            init: () => safeExec(init, 'speedSlider.init'), reset: () => safeExec(reset, 'speedSlider.reset'), renderControls: () => safeExec(renderControls, 'speedSlider.renderControls'),
            show: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) { el.style.display = 'flex'; resetFadeTimer(); } },
            hide: () => { const el = state.ui.shadowRoot?.getElementById('vsc-container'); if (el) el.style.display = 'none'; },
            doFade: startFadeSequence, resetFadeTimer: resetFadeTimer
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

        const CHECK_INTERVAL = 500;
        const MIN_RATE = 0.95;
        const MAX_RATE = 1.05;
        const TOLERANCE = 150;

        let localIntersectionObserver;

        function isYouTubeLive() {
            if (!location.href.includes('youtube.com')) return false;
            try {
                const liveBadge = document.querySelector('.ytp-live-badge');
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
            const targetDelay = getTargetDelay(); // Use the global function
            const diff = avgDelay - targetDelay;
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
            //displayDelayInfo(avgDelay, rawDelay);
            if (delayHistory.length >= 5) { // 측정값이 5개 이상 쌓이면 표시
                displayDelayInfo(avgDelay, rawDelay);
            }
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
        play: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); mediaSessionManager.setSession(m); },
        pause: e => { const m = e.target; if (m.tagName === 'VIDEO') updateVideoFilterState(m); if (Array.from(state.activeMedia).filter(med => !med.paused).length === 0) mediaSessionManager.clearSession(); },
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
        state.mediaListenerMap.delete(media);
        if (intersectionObserver) intersectionObserver.unobserve(media);
        stereoWideningManager.cleanupForMedia(media); // 오디오 컨텍스트 정리
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
        allMedia.forEach(m => {
            if (m.tagName === 'VIDEO') { m.classList.toggle('vsc-gpu-accelerated', !m.paused && !m.ended); updateVideoFilterState(m); }
            if (state.isStereoWideningEnabled) { stereoWideningManager.apply(m); }
        });
        const allImages = findAllImages();
        allImages.forEach(attachImageListeners);
        const oldImages = new Set(state.activeImages);
        state.activeImages.clear();
        allImages.forEach(img => { if (img.isConnected) { state.activeImages.add(img); oldImages.delete(img); } });
        oldImages.forEach(detachImageListeners);
        allImages.forEach(updateImageFilterState);
        const root = state.ui?.shadowRoot;
        if (root) {
            const hasVideo = Array.from(state.activeMedia).some(m => m.tagName === 'VIDEO');
            const hasAudio = Array.from(state.activeMedia).some(m => m.tagName === 'AUDIO');
            const hasImage = state.activeImages.size > 0;
            const hasAnyMedia = hasVideo || hasAudio;

            if (speedButtonsContainer) {
                speedButtonsContainer.style.display = hasVideo ? 'flex' : 'none';
            }

            if (hasVideo) state.mediaTypesEverFound.video = true;
            if (hasImage) state.mediaTypesEverFound.image = true;
            filterManager.toggleStyleSheet(state.mediaTypesEverFound.video);
            imageFilterManager.toggleStyleSheet(state.mediaTypesEverFound.image);
            const setDisplay = (id, visible) => {
                const el = root.getElementById(id);
                if (el) el.style.display = visible ? 'flex' : 'none';
            };
            setDisplay('vsc-video-controls', hasVideo);
            setDisplay('vsc-image-controls', hasImage);
            setDisplay('vsc-stereo-controls', hasAnyMedia);
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
            if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }

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
            setStereoWideningEnabled(false);
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
            if (state.ui?.hostElement) state.ui.hostElement.remove();
            if (speedButtonsContainer) speedButtonsContainer.style.display = 'none';
            const filterControls = state.ui?.shadowRoot?.getElementById('vsc-container');
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
        if (uiContainer && state.ui?.hostElement) {
            const mainControlsWrapper = uiContainer.querySelector('#vsc-main-controls-wrapper');
            if (mainControlsWrapper) mainControlsWrapper.appendChild(state.ui.hostElement);
        }
        filterManager.init();
        imageFilterManager.init();
        speedSlider.init();
        mediaSessionManager.init();
        ensureObservers();
        autoDelayManager.start();
        speedSlider.renderControls();
        speedSlider.show();
        setVideoFilterLevel(state.currentVideoFilterLevel);
        setImageFilterLevel(state.currentImageFilterLevel);
        setStereoWideningEnabled(state.isStereoWideningEnabled);
        scheduleIdleTask(scanAndApply);
        const initialRate = state.activeMedia.size > 0 ? Array.from(state.activeMedia)[0].playbackRate : 1.0;
        updateActiveSpeedButton(initialRate);

        if (!titleObserver) {
            const titleElement = document.querySelector('head > title');
            if (titleElement) {
                titleObserver = new MutationObserver(() => {
                    const activeVideo = Array.from(state.activeMedia).find(m => m.tagName === 'VIDEO' && !m.paused);
                    if (activeVideo) mediaSessionManager.setSession(activeVideo);
                });
                titleObserver.observe(titleElement, { childList: true });
            }
        }
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

    const globalUIManager = (() => {
        let isDragging = false, wasDragged = false;
        let startPos = { x: 0, y: 0 }, translatePos = { x: 0, y: 0 }, startRect = null;

        let visibilityChangeListener = null, fullscreenChangeListener = null, beforeUnloadListener = null;

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

        function createUIElements() {
            uiContainer = document.createElement('div');
            uiContainer.id = 'vsc-global-container';
            Object.assign(uiContainer.style, {
                position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%)',
                zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '0px',
                opacity: '1', transition: 'opacity 0.3s',
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
                fontSize: 'clamp(20px, 4vmin, 26px)', cursor: 'pointer', userSelect: 'none', transition: 'transform 0.2s, background-color 0.2s, opacity 0.3s',
                opacity: '1',
                '-webkit-tap-highlight-color': 'transparent'
            });

            speedButtonsContainer = document.createElement('div');
            speedButtonsContainer.id = 'vsc-speed-buttons-container';
            Object.assign(speedButtonsContainer.style, {
                display: 'none', flexDirection: 'column', gap: '5px', alignItems: 'center',
                opacity: '0.5'
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
                    '-webkit-tap-highlight-color': 'transparent', transition: 'background-color 0.2s, box-shadow 0.2s, opacity 0.3s'
                });
                if (speed === 1.0) {
                    btn.style.boxShadow = '0 0 5px #3498db, 0 0 10px #3498db inset';
                }
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newSpeed = parseFloat(btn.dataset.speed);
                    state.activeMedia.forEach(media => safeExec(() => { media.playbackRate = newSpeed; }));
                    updateActiveSpeedButton(newSpeed);
                    if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
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
                    triggerElement.textContent = '🛑';
                    triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                } catch (err) {
                    console.error('[VSC] Failed to initialize.', err);
                    triggerElement.textContent = '⚠️';
                    triggerElement.title = '스크립트 초기화 실패! 콘솔을 확인하세요.';
                    triggerElement.style.backgroundColor = 'rgba(255, 165, 0, 0.5)';
                }
            }
            if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
        }

        function attachDragAndDrop() {
            const onDragStart = (e) => {
                if (!e.composedPath().includes(uiContainer)) return;
                isDragging = true; wasDragged = false;
                const pos = e.touches ? e.touches[0] : e;
                startPos = { x: pos.clientX, y: pos.clientY };
                startRect = uiContainer.getBoundingClientRect();
                uiContainer.style.transition = 'none'; uiContainer.style.cursor = 'grabbing';
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
                uiContainer.style.transition = ''; uiContainer.style.cursor = 'pointer';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragEnd);
                document.removeEventListener('touchmove', onDragMove);
                document.removeEventListener('touchend', onDragEnd);
                setTimeout(() => { wasDragged = false; }, 0);
                if (speedSlider.resetFadeTimer) speedSlider.resetFadeTimer();
            };

            uiContainer.addEventListener('mousedown', onDragStart, { passive: true });
            uiContainer.addEventListener('touchstart', onDragStart, { passive: false });
            const debouncedClamp = debounce(clampTranslate, 100);
            window.addEventListener('resize', debouncedClamp);
            window.addEventListener('orientationchange', debouncedClamp);
        }

        function attachGlobalListeners() {
            if (!visibilityChangeListener) {
                visibilityChangeListener = () => {
                    if (document.hidden) {
                        document.querySelectorAll('.vsc-video-filter-active, .vsc-image-filter-active').forEach(v => v.classList.remove('vsc-video-filter-active', 'vsc-image-filter-active'));
                    } else {
                        scheduleIdleTask(scanAndApply);
                    }
                };
                document.addEventListener('visibilitychange', visibilityChangeListener);
            }
            if (!fullscreenChangeListener) {
                fullscreenChangeListener = () => {
                    const targetRoot = document.fullscreenElement || document.body;
                    if (uiContainer) {
                        targetRoot.appendChild(uiContainer);
                        setTimeout(clampTranslate, 100);
                    }
                };
                document.addEventListener('fullscreenchange', fullscreenChangeListener);
            }
            if (!beforeUnloadListener) {
                beforeUnloadListener = () => {
                    if (uiContainer) uiContainer.remove();
                    cleanup();
                };
                window.addEventListener('beforeunload', beforeUnloadListener);
            }
        }

        function cleanupGlobalListeners() {
            if (visibilityChangeListener) { document.removeEventListener('visibilitychange', visibilityChangeListener); visibilityChangeListener = null; }
            if (fullscreenChangeListener) { document.removeEventListener('fullscreenchange', fullscreenChangeListener); fullscreenChangeListener = null; }
            if (beforeUnloadListener) { window.removeEventListener('beforeunload', beforeUnloadListener); beforeUnloadListener = null; }
        }

        function init() {
            createUIElements();
            uiContainer.addEventListener('click', (e) => {
                if (wasDragged) { e.stopPropagation(); return; }
                if (e.target.id === UI_SELECTORS.TRIGGER) handleTriggerClick();
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
            document.addEventListener('DOMContentLoaded', () => setTimeout(initializeGlobalUI, 0));
        } else {
            setTimeout(initializeGlobalUI, 0);
        }
    }
})();
