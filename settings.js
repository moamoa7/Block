// ==UserScript==
// @name         Video_Image_Control (Final & Fixed & Multiband & DynamicEQ)
// @namespace    https://com/
// @version      100.2
// @description  다이나믹 EQ 프리셋 적용 버그 수정 및 UI 동기화
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;

    // --- [ARCHITECTURE] CONFIGURATION & CONSTANTS ---
    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 10 : 4,
        DEFAULT_VIDEO_FILTER_LEVEL_2: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 10 : 2,
        DEFAULT_IMAGE_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 10 : 2,
        DEFAULT_WIDENING_ENABLED: false, DEFAULT_WIDENING_FACTOR: 1.0, DEFAULT_STEREO_PAN: 0, DEFAULT_HPF_ENABLED: false,
        EFFECTS_HPF_FREQUENCY: 20, DEFAULT_EQ_ENABLED: false, DEFAULT_EQ_SUBBASS_GAIN: 0, DEFAULT_EQ_BASS_GAIN: 0,
        DEFAULT_EQ_MID_GAIN: 0, DEFAULT_EQ_TREBLE_GAIN: 0, DEFAULT_EQ_PRESENCE_GAIN: 0, DEFAULT_ADAPTIVE_WIDTH_ENABLED: false,
        DEFAULT_ADAPTIVE_WIDTH_FREQ: 150, DEFAULT_REVERB_ENABLED: false, DEFAULT_REVERB_MIX: 0.3, DEFAULT_PRE_GAIN_ENABLED: false,
        DEFAULT_PRE_GAIN: 1.0, DEFAULT_BASS_BOOST_GAIN: 0, DEFAULT_VIDEO_SHARPEN_DIRECTION: '4-way', AUTODELAY_EMA_ALPHA: 0.15,
        DEFAULT_DEESSER_ENABLED: false, DEFAULT_DEESSER_THRESHOLD: -30, DEFAULT_DEESSER_FREQ: 8000, DEFAULT_EXCITER_ENABLED: false,
        DEFAULT_EXCITER_AMOUNT: 0, DEFAULT_PARALLEL_COMP_ENABLED: false, DEFAULT_PARALLEL_COMP_MIX: 0, DEFAULT_LIMITER_ENABLED: false,
        DEFAULT_MASTERING_SUITE_ENABLED: false, DEBUG: false, AUTODELAY_INTERVAL_NORMAL: 1000, AUTODELAY_INTERVAL_STABLE: 3000,
        AUTODELAY_STABLE_THRESHOLD: 100, AUTODELAY_STABLE_COUNT: 5, AUTODELAY_PID_KP: 0.0002, AUTODELAY_PID_KI: 0.00001,
        AUTODELAY_PID_KD: 0.0001, AUTODELAY_MIN_RATE: 1.0, AUTODELAY_MAX_RATE: 1.025, LIVE_JUMP_INTERVAL: 6000,
        LIVE_JUMP_END_THRESHOLD: 1.0, DEBOUNCE_DELAY: 300, THROTTLE_DELAY: 100, MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05, SEEK_TIME_MAX_SEC: 15, IMAGE_MIN_SIZE: 335, VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [2.0, 1.5, 1.2, 1, 0.5, 0.2], UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'youtube.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
        LIVE_JUMP_WHITELIST: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com'],
        EXCLUSION_KEYWORDS: ['login', 'signin', 'auth', 'captcha', 'signup', 'frdl.my', 'up4load.com', 'challenges.cloudflare.com', 'noti.sooplive.co.kr'],
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 104 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.04, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: -1, HIGHLIGHTS_VALUE: 3, SATURATION_VALUE: 104 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 1, SATURATION_VALUE: 100 },
        SITE_METADATA_RULES: { 'www.youtube.com': { title: ['h1.ytd-watch-metadata #video-primary-info-renderer #title', 'h1.title.ytd-video-primary-info-renderer'], artist: ['#owner-name a', '#upload-info.ytd-video-owner-renderer a'] }, 'www.netflix.com': { title: ['.title-title', '.video-title'], artist: ['Netflix'] }, 'www.tving.com': { title: ['h2.program__title__main', '.title-main'], artist: ['TVING'] } },
        FILTER_EXCLUSION_DOMAINS: [], IMAGE_FILTER_EXCLUSION_DOMAINS: [],
        TARGET_DELAYS: {"play.sooplive.co.kr": 2500, "chzzk.naver.com": 2500, "ok.ru": 2500 }, DEFAULT_TARGET_DELAY: 3000,
        LOUDNESS_TARGET: -16,
        LOUDNESS_ANALYSIS_INTERVAL: 250,
        LOUDNESS_ADJUSTMENT_SPEED: 0.1,
        UI_AGC_APPLY_DELAY: 150,
        UI_HIDDEN_CLASS_NAME: 'vsc-hidden',
        DEFAULT_MULTIBAND_COMP_ENABLED: false,
        DEFAULT_MULTIBAND_COMP_SETTINGS: {
            low:     { crossover: 120, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
            lowMid:  { crossover: 800, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
            highMid: { crossover: 5000, threshold: -24, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
            high:    { threshold: -24, ratio: 4, attack: 0.003, release: 0.25, makeupGain: 0 },
        },
    };

    // --- [ARCHITECTURE] UTILITY FUNCTIONS ---
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { console.error(`[VSC] Error in ${label}:`, e.message); if (CONFIG.DEBUG) console.error("Full error object:", e); }};
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };

    function isExcluded() {
        const url = location.href.toLowerCase();
        if (CONFIG.EXCLUSION_KEYWORDS.some(k => url.includes(k))) return true;
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
        return false;
    }
    if (isExcluded()) return;

    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });
    (function openAllShadowRoots() { if (window._hasHackAttachShadow_) return; safeExec(() => { window._shadowDomList_ = window._shadowDomList_ || []; const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (opt) { const m = { ...opt, mode: 'open' }; const s = o.apply(this, [m]); window._shadowDomList_.push(new WeakRef(s)); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: s } })); return s; }; window._hasHackAttachShadow_ = true; }); })();

    // --- [ARCHITECTURE] STATE MANAGER (Observer Pattern) ---
    class StateManager {
        constructor() {
            this.state = {};
            this.listeners = {};
        }

        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;

            this.state = {
                app: { isInitialized: false, isMobile },
                media: {
                    activeMedia: new Set(), processedMedia: new WeakSet(),
                    activeImages: new Set(), processedImages: new WeakSet(),
                    mediaListenerMap: new WeakMap(), currentlyVisibleMedia: null,
                    mediaTypesEverFound: { video: false, image: false },
                },
                videoFilter: {
                    level: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL,
                    level2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
                    gamma: parseFloat(videoDefaults.GAMMA_VALUE),
                    blur: parseFloat(videoDefaults.BLUR_STD_DEVIATION),
                    shadows: parseInt(videoDefaults.SHADOWS_VALUE, 10),
                    highlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10),
                    saturation: parseInt(videoDefaults.SATURATION_VALUE, 10),
                    sharpenDirection: CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION,
                },
                imageFilter: { level: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL },
                audio: {
                    audioContextMap: new WeakMap(), audioInitialized: false,
                    isHpfEnabled: CONFIG.DEFAULT_HPF_ENABLED, hpfHz: CONFIG.EFFECTS_HPF_FREQUENCY,
                    isEqEnabled: CONFIG.DEFAULT_EQ_ENABLED, eqSubBassGain: CONFIG.DEFAULT_EQ_SUBBASS_GAIN,
                    eqBassGain: CONFIG.DEFAULT_EQ_BASS_GAIN, eqMidGain: CONFIG.DEFAULT_EQ_MID_GAIN,
                    eqTrebleGain: CONFIG.DEFAULT_EQ_TREBLE_GAIN, eqPresenceGain: CONFIG.DEFAULT_EQ_PRESENCE_GAIN,
                    bassBoostGain: CONFIG.DEFAULT_BASS_BOOST_GAIN, bassBoostFreq: 60, bassBoostQ: 1.0,
                    isWideningEnabled: CONFIG.DEFAULT_WIDENING_ENABLED, wideningFactor: CONFIG.DEFAULT_WIDENING_FACTOR,
                    isAdaptiveWidthEnabled: CONFIG.DEFAULT_ADAPTIVE_WIDTH_ENABLED, adaptiveWidthFreq: CONFIG.DEFAULT_ADAPTIVE_WIDTH_FREQ,
                    isReverbEnabled: CONFIG.DEFAULT_REVERB_ENABLED, reverbMix: CONFIG.DEFAULT_REVERB_MIX,
                    stereoPan: CONFIG.DEFAULT_STEREO_PAN, isPreGainEnabled: CONFIG.DEFAULT_PRE_GAIN_ENABLED,
                    preGain: CONFIG.DEFAULT_PRE_GAIN, lastManualPreGain: CONFIG.DEFAULT_PRE_GAIN,
                    isDeesserEnabled: CONFIG.DEFAULT_DEESSER_ENABLED,
                    deesserThreshold: CONFIG.DEFAULT_DEESSER_THRESHOLD, deesserFreq: CONFIG.DEFAULT_DEESSER_FREQ,
                    isExciterEnabled: CONFIG.DEFAULT_EXCITER_ENABLED, exciterAmount: CONFIG.DEFAULT_EXCITER_AMOUNT,
                    isParallelCompEnabled: CONFIG.DEFAULT_PARALLEL_COMP_ENABLED, parallelCompMix: CONFIG.DEFAULT_PARALLEL_COMP_MIX,
                    isLimiterEnabled: CONFIG.DEFAULT_LIMITER_ENABLED, isMasteringSuiteEnabled: CONFIG.DEFAULT_MASTERING_SUITE_ENABLED,
                    masteringTransientAmount: 0.2, masteringDrive: 0,
                    isLoudnessNormalizationEnabled: false,
                    loudnessTarget: CONFIG.LOUDNESS_TARGET,
                    isAgcEnabled: true,
                    preGainEnabledBeforeAuto: false,
                    isMultibandCompEnabled: CONFIG.DEFAULT_MULTIBAND_COMP_ENABLED,
                    multibandComp: JSON.parse(JSON.stringify(CONFIG.DEFAULT_MULTIBAND_COMP_SETTINGS)),
                    isDynamicEqEnabled: false,
                    dynamicEq: {
                        activeBand: 1,
                        bands: [
                            { freq: 150,  q: 1.4, threshold: -30, gain: 4 },
                            { freq: 1200, q: 2.0, threshold: -24, gain: -4},
                            { freq: 4500, q: 3.0, threshold: -20, gain: 5 },
                            { freq: 8000, q: 4.0, threshold: -18, gain: 4 },
                        ]
                    },
                    activePresetKey: 'default',
                },
                ui: {
                    shadowRoot: null, hostElement: null, areControlsVisible: false,
                    globalContainer: null,
                    lastUrl: location.href, audioContextWarningShown: false,
                    warningMessage: null,
                },
                playback: {
                    currentRate: 1.0, targetRate: 1.0, isLive: false, jumpToLiveRequested: 0,
                },
                liveStream: {
                    delayInfo: null, isRunning: false, resetRequested: null,
                },
                settings: {
                    videoFilterLevel: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL,
                    videoFilterLevel2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
                    imageFilterLevel: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL,
                    autoRefresh: true,
                }
            };
        }

        get(key) {
            return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state);
        }

        set(key, value) {
            const keys = key.split('.');
            let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) {
                if (obj === undefined) return;
                obj = obj[keys[i]];
            }
            const finalKey = keys[keys.length - 1];
            if(obj === undefined) return;
            const oldValue = obj[finalKey];

            if (oldValue !== value) {
                obj[finalKey] = value;
                this.notify(key, value, oldValue);
            }
        }

        subscribe(key, callback) {
            if (!this.listeners[key]) {
                this.listeners[key] = [];
            }
            this.listeners[key].push(callback);

            return () => {
                this.listeners[key] = this.listeners[key].filter(cb => cb !== callback);
            };
        }

        notify(key, newValue, oldValue) {
            if (this.listeners[key]) {
                this.listeners[key].forEach(callback => callback(newValue, oldValue));
            }
            let currentKey = key;
            while (currentKey.includes('.')) {
                const prefix = currentKey.substring(0, currentKey.lastIndexOf('.'));
                const wildcardKey = `${prefix}.*`;
                if (this.listeners[wildcardKey]) {
                    this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue));
                }
                currentKey = prefix;
            }
        }
    }

    // --- [ARCHITECTURE] BASE PLUGIN CLASS ---
    class Plugin {
        constructor(name) {
            this.name = name;
            this.stateManager = null;
            this.subscriptions = [];
        }
        init(stateManager) {
            this.stateManager = stateManager;
        }
        destroy() {
            this.subscriptions.forEach(unsubscribe => unsubscribe());
            this.subscriptions = [];
        }
        subscribe(key, callback) {
            const unsubscribe = this.stateManager.subscribe(key, callback);
            this.subscriptions.push(unsubscribe);
        }
    }

    // --- [ARCHITECTURE] PLUGIN MANAGER ---
    class PluginManager {
        constructor(stateManager) {
            this.plugins = [];
            this.stateManager = stateManager;
        }
        register(plugin) { this.plugins.push(plugin); }
        initAll() {
            this.stateManager.init();
            this.plugins.forEach(plugin => {
                safeExec(() => plugin.init(this.stateManager), `Plugin ${plugin.name} init`);
            });
            this.stateManager.set('app.isInitialized', true);
            this.stateManager.set('app.pluginsInitialized', true);
        }
        destroyAll() {
            this.plugins.forEach(plugin => {
                safeExec(() => plugin.destroy(), `Plugin ${plugin.name} destroy`);
            });
            this.stateManager.set('app.isInitialized', false);
        }
    }

    // --- [PLUGIN] CoreMediaPlugin: Detects and manages media elements ---
    class CoreMediaPlugin extends Plugin {
        constructor() {
            super('CoreMedia');
            this.mainObserver = null;
            this.intersectionObserver = null;
            this.maintenanceInterval = null;
            this.debouncedScanTask = debounce(this.scanAndApply.bind(this), CONFIG.DEBOUNCE_DELAY || 300);
        }

        init(stateManager) {
            super.init(stateManager);
            this.subscribe('app.pluginsInitialized', () => {
                this.ensureObservers();
                this.scanAndApply();
                document.addEventListener('addShadowRoot', this.debouncedScanTask);
                if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
                this.maintenanceInterval = setInterval(() => this.scanAndApply(), 2500);
            });
        }

        destroy() {
            super.destroy();
            if (this.mainObserver) { this.mainObserver.disconnect(); this.mainObserver = null; }
            if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; }
            if (this.maintenanceInterval) { clearInterval(this.maintenanceInterval); this.maintenanceInterval = null; }
            document.removeEventListener('addShadowRoot', this.debouncedScanTask);
        }

        ensureObservers() {
            if (!this.mainObserver) {
                this.mainObserver = new MutationObserver(() => {
                    scheduleIdleTask(this.scanAndApply.bind(this));
                });
                this.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
            }
            if (!this.intersectionObserver) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    let mostVisibleMedia = null;
                    let maxRatio = -1;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        e.target.dataset.isVisible = String(isVisible);
                        if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') {
                            this.stateManager.set('media.visibilityChange', { target: e.target, isVisible });
                        }
                        if (isVisible && e.intersectionRatio > maxRatio && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) {
                            maxRatio = e.intersectionRatio;
                            mostVisibleMedia = e.target;
                        }
                    });
                    if (this.stateManager.get('app.isMobile')) {
                        this.stateManager.set('media.currentlyVisibleMedia', mostVisibleMedia);
                    }
                }, { root: null, rootMargin: '0px', threshold: [0, 0.01, 0.5, 1.0] });
            }
        }

        scanAndApply() {
            this._processElements(this.findAllMedia.bind(this), this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this), 'media.activeMedia');
            this._processElements(this.findAllImages.bind(this), this.attachImageListeners.bind(this), this.detachImageListeners.bind(this), 'media.activeImages');
        }

        _processElements(findAllFn, attachFn, detachFn, stateKey) {
            const allElements = findAllFn();
            if (allElements.length > 0 && !this.stateManager.get('ui.globalContainer')) {
                this.stateManager.set('ui.createRequested', true);
            }

            const activeSet = this.stateManager.get(stateKey);
            const oldElements = new Set(activeSet);
            const newActiveSet = new Set();

            allElements.forEach(el => {
                if (el.isConnected) {
                    newActiveSet.add(el);
                    attachFn(el);
                    oldElements.delete(el);
                }
            });

            oldElements.forEach(detachFn);

            if (newActiveSet.size !== activeSet.size || ![...newActiveSet].every(el => activeSet.has(el))) {
                this.stateManager.set(stateKey, newActiveSet);
            }
        }

        findAllMedia(doc = document) {
            const elems = new Set();
            const q = 'video, audio';
            const filterFn = m => m.tagName === 'AUDIO' || (m.offsetWidth >= CONFIG.VIDEO_MIN_SIZE || m.offsetHeight >= CONFIG.VIDEO_MIN_SIZE);
            safeExec(() => {
                doc.querySelectorAll(q).forEach(m => filterFn(m) && elems.add(m));
                (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(root => {
                    try { root.querySelectorAll(q).forEach(m => filterFn(m) && elems.add(m)); } catch (e) {}
                });
                doc.querySelectorAll('iframe').forEach(f => {
                    try {
                        if (f.contentDocument) {
                            const frameElems = this.findAllMedia(f.contentDocument);
                            frameElems.forEach(m => elems.add(m));
                        }
                    } catch (e) {}
                });
            });
            return [...elems];
        }

        findAllImages(doc = document) {
            const elems = new Set();
            const s = CONFIG.IMAGE_MIN_SIZE;
            const filterFn = i => (i.naturalWidth > s && i.naturalHeight > s) || (i.offsetWidth > s && i.offsetHeight > s);
            safeExec(() => {
                doc.querySelectorAll('img').forEach(i => filterFn(i) && elems.add(i));
                (window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean).forEach(r => r.querySelectorAll('img').forEach(i => filterFn(i) && elems.add(i)));
                doc.querySelectorAll('iframe').forEach(f => {
                    try {
                        if (f.contentDocument) {
                            const frameElems = this.findAllImages(f.contentDocument);
                            frameElems.forEach(i => elems.add(i));
                        }
                    } catch (e) {}
                });
            });
            return [...elems];
        }

        attachMediaListeners(media) {
            if (!media || this.stateManager.get('media.processedMedia').has(media) || !this.intersectionObserver) return;
            if (this.stateManager.filterManagers?.video) {
                injectFiltersIntoRoot(media, this.stateManager.filterManagers.video, this.stateManager);
            }
            const listeners = {
                play: () => this.stateManager.set('playback.currentRate', media.playbackRate),
                pause: () => {},
                ended: () => {},
                ratechange: () => this.stateManager.set('playback.currentRate', media.playbackRate),
            };
            for (const [evt, handler] of Object.entries(listeners)) { media.addEventListener(evt, handler); }
            this.stateManager.get('media.mediaListenerMap').set(media, listeners);
            this.stateManager.get('media.processedMedia').add(media);
            this.intersectionObserver.observe(media);
        }

        detachMediaListeners(media) {
            const listenerMap = this.stateManager.get('media.mediaListenerMap');
            if (!listenerMap.has(media)) return;
            const listeners = listenerMap.get(media);
            for (const [evt, listener] of Object.entries(listeners)) { media.removeEventListener(evt, listener); }
            listenerMap.delete(media);
            if (this.intersectionObserver) this.intersectionObserver.unobserve(media);
        }

        attachImageListeners(image) {
            if (!image || this.stateManager.get('media.processedImages').has(image) || !this.intersectionObserver) return;
            if (this.stateManager.filterManagers?.image) {
                injectFiltersIntoRoot(image, this.stateManager.filterManagers.image, this.stateManager);
            }
            this.stateManager.get('media.processedImages').add(image);
            this.intersectionObserver.observe(image);
        }

        detachImageListeners(image) {
            if (!this.stateManager.get('media.processedImages').has(image)) return;
            if (this.intersectionObserver) this.intersectionObserver.unobserve(image);
        }
    }

    // --- [PLUGIN] SvgFilterPlugin: Manages SVG filters for video/images ---
    class SvgFilterPlugin extends Plugin {
        constructor() {
            super('SvgFilter');
            this.filterManager = null;
            this.imageFilterManager = null;
        }

        init(stateManager) {
            super.init(stateManager);
            this.filterManager = this._createManager({
                settings: this.stateManager.get('app.isMobile') ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS,
                svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', matrixId: 'vsc-dynamic-convolve-matrix', className: 'vsc-video-filter-active'
            });
            this.imageFilterManager = this._createManager({
                settings: CONFIG.IMAGE_FILTER_SETTINGS,
                svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', matrixId: 'vsc-image-convolve-matrix', className: 'vsc-image-filter-active'
            });

            this.filterManager.init();
            this.imageFilterManager.init();

            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.subscribe('imageFilter.level', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates());
            this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates());

            this.applyAllVideoFilters();
            this.applyAllImageFilters();
            this.stateManager.filterManagers = { video: this.filterManager, image: this.imageFilterManager };
        }

        _createManager(options) {
            class SvgFilterManager {
                #isInitialized = false; #styleElement = null; #svgNode = null; #options;
                constructor(options) { this.#options = options; }
                isInitialized() { return this.#isInitialized; }
                getSvgNode() { return this.#svgNode; }
                getStyleNode() { return this.#styleElement; }
                toggleStyleSheet(enable) { if (this.#styleElement) this.#styleElement.media = enable ? 'all' : 'none'; }
                init() { if (this.#isInitialized) return; safeExec(() => { const { svgNode, styleElement } = this.#createElements(); this.#svgNode = svgNode; this.#styleElement = styleElement; (document.head || document.documentElement).appendChild(styleElement); (document.body || document.documentElement).appendChild(svgNode); this.#isInitialized = true; }, `${this.constructor.name}.init`); }
                #createElements() { const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; }; const { settings, svgId, styleId, matrixId, className } = this.#options; const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`; const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' }); const combinedFilter = createSvgElement('filter', { id: combinedFilterId }); const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", type: "saturate", values: (settings.SATURATION_VALUE / 100).toString(), result: "saturate_out" }); const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() }))); const blur = createSvgElement('feGaussianBlur', { "data-vsc-id": "blur", in: "gamma_out", stdDeviation: settings.BLUR_STD_DEVIATION, result: "blur_out" }); const sharpen_pass1 = createSvgElement('feConvolveMatrix', { id: matrixId + '_pass1', "data-vsc-id": "sharpen_pass1", in: "blur_out", order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', result: "sharpen_out_1" }); const sharpen_pass2 = createSvgElement('feConvolveMatrix', { id: matrixId + '_pass2', "data-vsc-id": "sharpen_pass2", in: "sharpen_out_1", order: '3 3', preserveAlpha: 'true', kernelMatrix: '0 0 0 0 1 0 0 0 0', result: "sharpen_out_2" }); const linear = createSvgElement('feComponentTransfer', { "data-vsc-id": "linear", in: "sharpen_out_2" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'linear', slope: (1 + settings.HIGHLIGHTS_VALUE / 100).toString(), intercept: (settings.SHADOWS_VALUE / 200).toString() }))); combinedFilter.append(saturation, gamma, blur, sharpen_pass1, sharpen_pass2, linear); svg.append(combinedFilter); const style = document.createElement('style'); style.id = styleId; style.textContent = `.${className} { filter: url(#${combinedFilterId}) !important; } .${'vsc-gpu-accelerated'} { transform: translateZ(0); will-change: transform; } .vsc-btn.analyzing { box-shadow: 0 0 5px #f39c12, 0 0 10px #f39c12 inset !important; }`; return { svgNode: svg, styleElement: style }; }
                updateFilterValues(values) { if (!this.isInitialized()) return; const { saturation, gamma, blur, sharpenMatrix1, sharpenMatrix2, shadows, highlights } = values; const rootNodes = [document, ...(window._shadowDomList_ || []).map(r => r.deref()).filter(Boolean)]; rootNodes.forEach(rootNode => { if (saturation !== undefined) { rootNode.querySelectorAll(`[data-vsc-id="saturate"]`).forEach(el => el.setAttribute('values', (saturation / 100).toString())); } if (gamma !== undefined) { const exponent = (1 / gamma).toString(); rootNode.querySelectorAll(`[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB`).forEach(el => el.setAttribute('exponent', exponent)); } if (blur !== undefined) { rootNode.querySelectorAll(`[data-vsc-id="blur"]`).forEach(el => el.setAttribute('stdDeviation', blur.toString())); } if (sharpenMatrix1 !== undefined) { rootNode.querySelectorAll(`[data-vsc-id="sharpen_pass1"]`).forEach(el => el.setAttribute('kernelMatrix', sharpenMatrix1)); } if (sharpenMatrix2 !== undefined) { rootNode.querySelectorAll(`[data-vsc-id="sharpen_pass2"]`).forEach(el => el.setAttribute('kernelMatrix', sharpenMatrix2)); } if (shadows !== undefined || highlights !== undefined) { const slope = (1 + (highlights ?? 0) / 100).toString(); const intercept = ((shadows ?? 0) / 200).toString(); rootNode.querySelectorAll(`[data-vsc-id="linear"] feFuncR, [data-vsc-id="linear"] feFuncG, [data-vsc-id="linear"] feFuncB`).forEach(el => { el.setAttribute('slope', slope); el.setAttribute('intercept', intercept); }); }}); }
            }
            return new SvgFilterManager(options);
        }

        calculateSharpenMatrix(level, direction = '4-way') {
            const p = parseInt(level, 10); if (isNaN(p) || p === 0) return '0 0 0 0 1 0 0 0 0'; const BASE_STRENGTH = 0.125; const i = 1 + p * BASE_STRENGTH; if (direction === '8-way') { const o = (1 - i) / 8; return `${o} ${o} ${o} ${o} ${i} ${o} ${o} ${o} ${o}`; } else { const o = (1 - i) / 4; return `0 ${o} 0 ${o} ${i} ${o} 0 ${o} 0`; }
        }

        applyAllVideoFilters() {
            if (!this.filterManager.isInitialized()) return;
            const vf = this.stateManager.get('videoFilter');
            const values = {
                saturation: vf.saturation, gamma: vf.gamma, blur: vf.blur,
                sharpenMatrix1: this.calculateSharpenMatrix(vf.level, vf.sharpenDirection),
                sharpenMatrix2: this.calculateSharpenMatrix(vf.level2, vf.sharpenDirection),
                shadows: vf.shadows, highlights: vf.highlights,
            };
            this.filterManager.updateFilterValues(values);
            this.updateMediaFilterStates();
        }

        applyAllImageFilters() {
            if (!this.imageFilterManager.isInitialized()) return;
            const level = this.stateManager.get('imageFilter.level');
            const values = { sharpenMatrix1: this.calculateSharpenMatrix(level) };
            this.imageFilterManager.updateFilterValues(values);
            this.updateMediaFilterStates();
        }

        updateMediaFilterStates() {
            this.stateManager.get('media.activeMedia').forEach(media => {
                if (media.tagName === 'VIDEO') this._updateVideoFilterState(media);
            });
            this.stateManager.get('media.activeImages').forEach(image => {
                this._updateImageFilterState(image);
            });
        }

        _updateVideoFilterState(video) {
            const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 ||
                Math.abs(vf.gamma - 1.0) > 0.001 || vf.blur > 0 || vf.shadows !== 0 || vf.highlights !== 0;
            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            video.classList.toggle('vsc-video-filter-active', controlsVisible && video.dataset.isVisible !== 'false' && shouldApply);
        }

        _updateImageFilterState(image) {
            const level = this.stateManager.get('imageFilter.level');
            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            image.classList.toggle('vsc-image-filter-active', controlsVisible && image.dataset.isVisible !== 'false' && level > 0);
        }
    }

    function injectFiltersIntoRoot(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        const root = element.getRootNode();
        const attr = `data-vsc-filters-injected-${manager === (element.tagName.toUpperCase() === 'VIDEO' ? stateManager.filterManagers.video : stateManager.filterManagers.image) ? 'video' : 'image'}`;

        if (root instanceof ShadowRoot && !root.host.hasAttribute(attr)) {
            const svgNode = manager.getSvgNode();
            const styleNode = manager.getStyleNode();

            if (svgNode && styleNode) {
                root.appendChild(styleNode.cloneNode(true));
                root.appendChild(svgNode.cloneNode(true));
                root.host.setAttribute(attr, 'true');
            }
        }
    }

    // --- [PLUGIN] AudioFXPlugin: Manages all Web Audio API effects ---
    class AudioFXPlugin extends Plugin {
        constructor() {
            super('AudioFX');
            this.animationFrameMap = new WeakMap();
            this.audioActivityStatus = new WeakMap();
            this.loudnessAnalyzerMap = new WeakMap();
            this.loudnessIntervalMap = new WeakMap();
        }

        init(stateManager) {
            super.init(stateManager);
            this.subscribe('audio.*', debounce(() => this.applyAudioEffectsToAllMedia(), 50));
            this.subscribe('media.activeMedia', (newMediaSet, oldMediaSet) => {
                const added = [...newMediaSet].filter(x => !oldMediaSet.has(x));
                const removed = [...oldMediaSet].filter(x => !newMediaSet.has(x));
                if (this.stateManager.get('audio.audioInitialized')) {
                    added.forEach(media => this.ensureContextResumed(media));
                }
                removed.forEach(media => this.cleanupForMedia(media));
            });
            this.subscribe('audio.audioInitialized', (isInitialized) => {
                if (isInitialized) {
                    const currentMedia = this.stateManager.get('media.activeMedia');
                    currentMedia.forEach(media => this.ensureContextResumed(media));
                }
            });

            this.subscribe('audio.activityCheckRequested', () => {
                this.stateManager.get('media.activeMedia').forEach(media => {
                    const nodes = this.stateManager.get('audio.audioContextMap').get(media);
                    if (nodes) {
                        this.audioActivityStatus.delete(media);
                        this.checkAudioActivity(media, nodes);
                        console.log('[VSC] Audio activity re-check requested.', media);
                    }
                });
            });

            this.subscribe('audio.isLoudnessNormalizationEnabled', (isEnabled) => {
                this.stateManager.get('media.activeMedia').forEach(media => {
                    if (isEnabled) {
                        this.startLoudnessAnalysis(media);
                    } else {
                        this.stopLoudnessAnalysis(media);
                    }
                });
            });
        }

        destroy() {
            super.destroy();
            this.stateManager.get('media.activeMedia').forEach(media => this.cleanupForMedia(media));
        }

        applyAudioEffectsToAllMedia() {
            if (!this.stateManager.get('audio.audioInitialized')) return;
            const sm = this.stateManager;
            const mediaToAffect = sm.get('app.isMobile') && sm.get('media.currentlyVisibleMedia') ?
                [sm.get('media.currentlyVisibleMedia')] : Array.from(sm.get('media.activeMedia'));
            mediaToAffect.forEach(media => {
                if (media) this.reconnectGraph(media)
            });
        }

        createImpulseResponse(context, duration = 2, decay = 2) {
            const sampleRate = context.sampleRate; const length = sampleRate * duration;
            const impulse = context.createBuffer(2, length, sampleRate);
            const impulseL = impulse.getChannelData(0); const impulseR = impulse.getChannelData(1);
            for (let i = 0; i < length; i++) {
                impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
                impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
            return impulse;
        }

        makeTransientCurve(amount) {
            const samples = 44100; const curve = new Float32Array(samples);
            const k = 2 * amount / (1 - amount || 1e-6);
            for (let i = 0; i < samples; i++) {
                const x = i * 2 / samples - 1;
                curve[i] = (1 + k) * x / (1 + k * Math.abs(x));
            }
            return curve;
        }

        makeDistortionCurve(amount) {
            const k = typeof amount === 'number' ? amount : 50; const n_samples = 44100;
            const curve = new Float32Array(n_samples); const deg = Math.PI / 180;
            for (let i = 0; i < n_samples; ++i) {
                const x = i * 2 / n_samples - 1;
                curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
            }
            return curve;
        }

        createAudioGraph(media) {
            const context = new (window.AudioContext || window.webkitAudioContext)();
            let source;
            try { media.crossOrigin = "anonymous"; source = context.createMediaElementSource(media);
            } catch (e) {
                this.stateManager.set('ui.warningMessage', '오디오 효과 적용 실패 (CORS). 페이지 새로고침이 필요할 수 있습니다.');
                console.error('[VSC] MediaElementSource creation failed.', e); context.close(); return null;
            }
            const nodes = { context, source, stereoPanner: context.createStereoPanner(), masterGain: context.createGain(), analyser: context.createAnalyser(), loudnessAnalyzer: context.createAnalyser(), safetyLimiter: context.createDynamicsCompressor(), cumulativeLUFS: 0, lufsSampleCount: 0, band1_SubBass: context.createBiquadFilter(), band2_Bass: context.createBiquadFilter(), band3_Mid: context.createBiquadFilter(), band4_Treble: context.createBiquadFilter(), band5_Presence: context.createBiquadFilter(), gain1_SubBass: context.createGain(), gain2_Bass: context.createGain(), gain3_Mid: context.createGain(), gain4_Treble: context.createGain(), gain5_Presence: context.createGain(), merger: context.createGain(), reverbConvolver: context.createConvolver(), reverbWetGain: context.createGain(), reverbSum: context.createGain(), deesserBand: context.createBiquadFilter(), deesserCompressor: context.createDynamicsCompressor(), exciterHPF: context.createBiquadFilter(), exciter: context.createWaveShaper(), exciterPostGain: context.createGain(), parallelCompressor: context.createDynamicsCompressor(), parallelDry: context.createGain(), parallelWet: context.createGain(), limiter: context.createDynamicsCompressor(), masteringTransientShaper: context.createWaveShaper(), masteringLimiter1: context.createDynamicsCompressor(), masteringLimiter2: context.createDynamicsCompressor(), masteringLimiter3: context.createDynamicsCompressor() };

            const mbc = {
                splitter1: context.createBiquadFilter(), splitter2: context.createBiquadFilter(), splitter3: context.createBiquadFilter(),
                compLow: context.createDynamicsCompressor(), compLowMid: context.createDynamicsCompressor(), compHighMid: context.createDynamicsCompressor(), compHigh: context.createDynamicsCompressor(),
                gainLow: context.createGain(), gainLowMid: context.createGain(), gainHighMid: context.createGain(), gainHigh: context.createGain(),
                merger: context.createGain()
            };
            mbc.splitter1.type = 'lowpass';
            mbc.splitter2.type = 'lowpass';
            mbc.splitter3.type = 'lowpass';
            Object.assign(nodes, { mbc });

            nodes.dynamicEq = [];
            for (let i = 0; i < 4; i++) {
                const deq_band = {
                    peaking: context.createBiquadFilter(),
                    sidechain: context.createBiquadFilter(),
                    compressor: context.createDynamicsCompressor(),
                    gain: context.createGain()
                };
                deq_band.peaking.type = 'peaking';
                deq_band.sidechain.type = 'bandpass';
                nodes.dynamicEq.push(deq_band);
            }


            try { nodes.reverbConvolver.buffer = this.createImpulseResponse(context); } catch (e) { console.error("[VSC] Failed to create reverb impulse response.", e); }
            nodes.safetyLimiter.threshold.value = -0.5; nodes.safetyLimiter.knee.value = 0; nodes.safetyLimiter.ratio.value = 20; nodes.safetyLimiter.attack.value = 0.001; nodes.safetyLimiter.release.value = 0.05;
            nodes.analyser.fftSize = 256;
            nodes.loudnessAnalyzer.fftSize = 2048;
            nodes.band1_SubBass.type = "lowpass"; nodes.band1_SubBass.frequency.value = 80; nodes.band2_Bass.type = "bandpass"; nodes.band2_Bass.frequency.value = 150; nodes.band2_Bass.Q.value = 1; nodes.band3_Mid.type = "bandpass"; nodes.band3_Mid.frequency.value = 1000; nodes.band3_Mid.Q.value = 1; nodes.band4_Treble.type = "bandpass"; nodes.band4_Treble.frequency.value = 4000; nodes.band4_Treble.Q.value = 1; nodes.band5_Presence.type = "highpass"; nodes.band5_Presence.frequency.value = 8000;
            this.stateManager.get('audio.audioContextMap').set(media, nodes);

            nodes.source.connect(nodes.masterGain);
            nodes.masterGain.connect(nodes.safetyLimiter);
            nodes.safetyLimiter.connect(nodes.analyser);
            nodes.safetyLimiter.connect(nodes.loudnessAnalyzer);
            nodes.safetyLimiter.connect(nodes.context.destination);
            return nodes;
        }

        reconnectGraph(media) {
            const nodes = this.stateManager.get('audio.audioContextMap').get(media);
            if (!nodes) return;
            const audioState = this.stateManager.get('audio');

            safeExec(() => {
                Object.values(nodes).forEach(node => { if (node && typeof node.disconnect === 'function' && node !== nodes.context && node !== nodes.loudnessAnalyzer) { try { node.disconnect(); } catch (e) { /* Ignore */ } } });

                if (this.animationFrameMap.has(media)) cancelAnimationFrame(this.animationFrameMap.get(media));
                this.animationFrameMap.delete(media);

                let lastNode = nodes.source;

                nodes.stereoPanner.pan.value = audioState.stereoPan;

                if (audioState.isDeesserEnabled) {
                    nodes.deesserBand.type = 'bandpass'; nodes.deesserBand.frequency.value = audioState.deesserFreq; nodes.deesserBand.Q.value = 3;
                    nodes.deesserCompressor.threshold.value = audioState.deesserThreshold; nodes.deesserCompressor.knee.value = 10; nodes.deesserCompressor.ratio.value = 10; nodes.deesserCompressor.attack.value = 0.005; nodes.deesserCompressor.release.value = 0.1;
                    lastNode.connect(nodes.deesserBand).connect(nodes.deesserCompressor);
                    lastNode = lastNode.connect(nodes.deesserCompressor);
                }

                if (audioState.isEqEnabled || audioState.bassBoostGain > 0) {
                    const merger = nodes.merger;
                    lastNode.connect(nodes.band1_SubBass); lastNode.connect(nodes.band2_Bass); lastNode.connect(nodes.band3_Mid); lastNode.connect(nodes.band4_Treble); lastNode.connect(nodes.band5_Presence);
                    let lastSubBassNode = nodes.band1_SubBass;
                    if (audioState.bassBoostGain > 0) {
                        if (!nodes.bassBoost) { nodes.bassBoost = nodes.context.createBiquadFilter(); nodes.bassBoost.type = "peaking"; }
                        nodes.bassBoost.frequency.value = audioState.bassBoostFreq; nodes.bassBoost.Q.value = audioState.bassBoostQ; nodes.bassBoost.gain.value = audioState.bassBoostGain;
                        lastSubBassNode = lastSubBassNode.connect(nodes.bassBoost);
                    }
                    if (audioState.isEqEnabled) {
                        nodes.gain1_SubBass.gain.value = Math.pow(10, audioState.eqSubBassGain / 20); nodes.gain2_Bass.gain.value = Math.pow(10, audioState.eqBassGain / 20);
                        nodes.gain3_Mid.gain.value = Math.pow(10, audioState.eqMidGain / 20); nodes.gain4_Treble.gain.value = Math.pow(10, audioState.eqTrebleGain / 20);
                        nodes.gain5_Presence.gain.value = Math.pow(10, audioState.eqPresenceGain / 20);
                    } else {
                        [nodes.gain1_SubBass, nodes.gain2_Bass, nodes.gain3_Mid, nodes.gain4_Treble, nodes.gain5_Presence].forEach(g => g.gain.value = 1);
                    }
                    lastSubBassNode.connect(nodes.gain1_SubBass).connect(merger);
                    nodes.band2_Bass.connect(nodes.gain2_Bass).connect(merger);
                    nodes.band3_Mid.connect(nodes.gain3_Mid).connect(merger);
                    nodes.band4_Treble.connect(nodes.gain4_Treble).connect(merger);
                    nodes.band5_Presence.connect(nodes.gain5_Presence).connect(merger);
                    lastNode = merger;
                }

                if (audioState.isDynamicEqEnabled) {
                    const deqSettings = audioState.dynamicEq.bands;
                    for(let i = 0; i < nodes.dynamicEq.length; i++) {
                        const band = nodes.dynamicEq[i];
                        const settings = deqSettings[i];

                        band.peaking.frequency.value = settings.freq;
                        band.peaking.Q.value = settings.q;

                        band.sidechain.frequency.value = settings.freq;
                        band.sidechain.Q.value = settings.q * 1.5;

                        band.compressor.threshold.value = settings.threshold;
                        band.compressor.knee.value = 5;
                        band.compressor.ratio.value = 2;
                        band.compressor.attack.value = 0.005;
                        band.compressor.release.value = 0.15;

                        band.gain.gain.value = settings.gain;

                        lastNode.connect(band.peaking);
                        lastNode.connect(band.sidechain).connect(band.compressor).connect(band.gain);
                        band.gain.connect(band.peaking.gain);

                        lastNode = band.peaking;
                    }
                }


                if (audioState.isHpfEnabled) {
                    if (!nodes.hpf) nodes.hpf = nodes.context.createBiquadFilter();
                    nodes.hpf.type = 'highpass'; nodes.hpf.frequency.value = audioState.hpfHz;
                    lastNode = lastNode.connect(nodes.hpf);
                }

                if (audioState.isMultibandCompEnabled) {
                    const mbcNodes = nodes.mbc;
                    const merger = mbcNodes.merger;

                    mbcNodes.splitter1.frequency.value = this.stateManager.get('audio.multibandComp.low.crossover');
                    mbcNodes.splitter2.frequency.value = this.stateManager.get('audio.multibandComp.lowMid.crossover');
                    mbcNodes.splitter3.frequency.value = this.stateManager.get('audio.multibandComp.highMid.crossover');

                    const highPass1 = nodes.context.createBiquadFilter(); highPass1.type = 'highpass';
                    highPass1.frequency.value = this.stateManager.get('audio.multibandComp.low.crossover');
                    const highPass2 = nodes.context.createBiquadFilter(); highPass2.type = 'highpass';
                    highPass2.frequency.value = this.stateManager.get('audio.multibandComp.lowMid.crossover');
                    const highPass3 = nodes.context.createBiquadFilter(); highPass3.type = 'highpass';
                    highPass3.frequency.value = this.stateManager.get('audio.multibandComp.highMid.crossover');

                    lastNode.connect(mbcNodes.splitter1).connect(mbcNodes.compLow).connect(mbcNodes.gainLow).connect(merger);
                    lastNode.connect(highPass1).connect(mbcNodes.splitter2).connect(mbcNodes.compLowMid).connect(mbcNodes.gainLowMid).connect(merger);
                    lastNode.connect(highPass2).connect(mbcNodes.splitter3).connect(mbcNodes.compHighMid).connect(mbcNodes.gainHighMid).connect(merger);
                    lastNode.connect(highPass3).connect(mbcNodes.compHigh).connect(mbcNodes.gainHigh).connect(merger);

                    const bands = ['low', 'lowMid', 'highMid', 'high'];
                    const compMap = { low: mbcNodes.compLow, lowMid: mbcNodes.compLowMid, highMid: mbcNodes.compHighMid, high: mbcNodes.compHigh };
                    const gainMap = { low: mbcNodes.gainLow, lowMid: mbcNodes.gainLowMid, highMid: mbcNodes.gainHighMid, high: mbcNodes.gainHigh };

                    bands.forEach(band => {
                        const comp = compMap[band];
                        const gain = gainMap[band];

                        comp.threshold.value = this.stateManager.get(`audio.multibandComp.${band}.threshold`);
                        comp.ratio.value = this.stateManager.get(`audio.multibandComp.${band}.ratio`);
                        comp.attack.value = this.stateManager.get(`audio.multibandComp.${band}.attack`);
                        comp.release.value = this.stateManager.get(`audio.multibandComp.${band}.release`);
                        gain.gain.value = Math.pow(10, this.stateManager.get(`audio.multibandComp.${band}.makeupGain`) / 20);
                    });

                    lastNode = merger;
                }

                if (audioState.isExciterEnabled && audioState.exciterAmount > 0) {
                    const exciterSum = nodes.context.createGain(); const exciterDry = nodes.context.createGain(); const exciterWet = nodes.context.createGain();
                    const wetAmount = audioState.isMasteringSuiteEnabled ? audioState.exciterAmount / 150 : audioState.exciterAmount / 100;
                    exciterDry.gain.value = 1.0 - wetAmount; exciterWet.gain.value = wetAmount;
                    nodes.exciterHPF.type = 'highpass'; nodes.exciterHPF.frequency.value = 5000;
                    nodes.exciter.curve = this.makeDistortionCurve(audioState.exciterAmount * 15); nodes.exciter.oversample = '4x';
                    nodes.exciterPostGain.gain.value = 0.5;
                    lastNode.connect(exciterDry).connect(exciterSum);
                    lastNode.connect(nodes.exciterHPF).connect(nodes.exciter).connect(nodes.exciterPostGain).connect(exciterWet).connect(exciterSum);
                    lastNode = exciterSum;
                }

                if (audioState.isParallelCompEnabled && audioState.parallelCompMix > 0) {
                    nodes.parallelCompressor.threshold.value = -30; nodes.parallelCompressor.knee.value = 15; nodes.parallelCompressor.ratio.value = 12;
                    nodes.parallelCompressor.attack.value = 0.003; nodes.parallelCompressor.release.value = 0.1;
                    nodes.parallelDry.gain.value = 1.0 - (audioState.parallelCompMix / 100); nodes.parallelWet.gain.value = audioState.parallelCompMix / 100;
                    const parallelSum = nodes.context.createGain();
                    lastNode.connect(nodes.parallelDry).connect(parallelSum);
                    lastNode.connect(nodes.parallelCompressor).connect(nodes.parallelWet).connect(parallelSum);
                    lastNode = parallelSum;
                }

                let spatialNode;
                if (audioState.isWideningEnabled) {
                    if (!nodes.ms_splitter) { Object.assign(nodes, { ms_splitter: nodes.context.createChannelSplitter(2), ms_mid_sum: nodes.context.createGain(), ms_mid_level: nodes.context.createGain(), ms_side_invert_R: nodes.context.createGain(), ms_side_sum: nodes.context.createGain(), ms_side_level: nodes.context.createGain(), ms_side_gain: nodes.context.createGain(), adaptiveWidthFilter: nodes.context.createBiquadFilter(), ms_decode_L_sum: nodes.context.createGain(), ms_decode_invert_Side: nodes.context.createGain(), ms_decode_R_sum: nodes.context.createGain(), ms_merger: nodes.context.createChannelMerger(2) }); }
                    lastNode.connect(nodes.ms_splitter); nodes.ms_splitter.connect(nodes.ms_mid_sum, 0); nodes.ms_splitter.connect(nodes.ms_mid_sum, 1);
                    nodes.ms_mid_sum.connect(nodes.ms_mid_level); nodes.ms_splitter.connect(nodes.ms_side_sum, 0); nodes.ms_splitter.connect(nodes.ms_side_invert_R, 1).connect(nodes.ms_side_sum);
                    nodes.ms_side_invert_R.gain.value = -1; nodes.ms_side_sum.connect(nodes.ms_side_level);
                    nodes.ms_mid_level.gain.value = 0.5; nodes.ms_side_level.gain.value = 0.5;
                    nodes.adaptiveWidthFilter.type = 'highpass'; nodes.adaptiveWidthFilter.frequency.value = audioState.isAdaptiveWidthEnabled ? audioState.adaptiveWidthFreq : 0;
                    nodes.ms_side_level.connect(nodes.adaptiveWidthFilter).connect(nodes.ms_side_gain);
                    nodes.ms_side_gain.gain.value = audioState.wideningFactor; nodes.ms_decode_invert_Side.gain.value = -1;
                    nodes.ms_mid_level.connect(nodes.ms_decode_L_sum); nodes.ms_side_gain.connect(nodes.ms_decode_L_sum);
                    nodes.ms_mid_level.connect(nodes.ms_decode_R_sum); nodes.ms_side_gain.connect(nodes.ms_decode_invert_Side).connect(nodes.ms_decode_R_sum);
                    nodes.ms_decode_L_sum.connect(nodes.ms_merger, 0, 0); nodes.ms_decode_R_sum.connect(nodes.ms_merger, 0, 1);
                    spatialNode = nodes.ms_merger;
                } else {
                    spatialNode = lastNode.connect(nodes.stereoPanner);
                }

                if (audioState.isReverbEnabled) {
                    nodes.reverbWetGain.gain.value = audioState.reverbMix;
                    spatialNode.connect(nodes.reverbSum);
                    spatialNode.connect(nodes.reverbConvolver).connect(nodes.reverbWetGain).connect(nodes.reverbSum);
                    lastNode = nodes.reverbSum;
                } else {
                    lastNode = spatialNode;
                }

                if (audioState.isMasteringSuiteEnabled) {
                    nodes.masteringTransientShaper.curve = this.makeTransientCurve(audioState.masteringTransientAmount); nodes.masteringTransientShaper.oversample = '4x';
                    lastNode = lastNode.connect(nodes.masteringTransientShaper);
                    const drive = audioState.masteringDrive; const l1 = nodes.masteringLimiter1;
                    l1.threshold.value = -12 + (drive / 2); l1.knee.value = 5; l1.ratio.value = 4; l1.attack.value = 0.005; l1.release.value = 0.08;
                    const l2 = nodes.masteringLimiter2; l2.threshold.value = -8 + (drive / 2); l2.knee.value = 3; l2.ratio.value = 8; l2.attack.value = 0.003; l2.release.value = 0.05;
                    const l3 = nodes.masteringLimiter3; l3.threshold.value = -2.0; l3.knee.value = 0; l3.ratio.value = 20; l3.attack.value = 0.001; l3.release.value = 0.02;
                    lastNode = lastNode.connect(l1).connect(l2).connect(l3);
                } else if (audioState.isLimiterEnabled) {
                    nodes.limiter.threshold.value = -1.5; nodes.limiter.knee.value = 0; nodes.limiter.ratio.value = 20;
                    nodes.limiter.attack.value = 0.001; nodes.limiter.release.value = 0.05;
                    lastNode = lastNode.connect(nodes.limiter);
                }

                nodes.masterGain.gain.value = audioState.isPreGainEnabled ? audioState.preGain : 1.0;
                lastNode.connect(nodes.masterGain);
                nodes.masterGain.connect(nodes.safetyLimiter);
                nodes.safetyLimiter.connect(nodes.analyser);
                nodes.safetyLimiter.connect(nodes.loudnessAnalyzer);
                nodes.safetyLimiter.connect(nodes.context.destination);
            }, 'reconnectGraph');
        }

        checkAudioActivity(media, nodes) {
            if (this.audioActivityStatus.get(media) === 'passed' || this.audioActivityStatus.get(media) === 'checking') return;
            this.audioActivityStatus.set(media, 'checking');

            let attempts = 0;
            const MAX_ATTEMPTS = 8;
            const CHECK_INTERVAL = 350;
            const analyserData = new Uint8Array(nodes.analyser.frequencyBinCount);

            const intervalId = setInterval(() => {

                if (!media.isConnected || nodes.context.state === 'closed') {
                    clearInterval(intervalId);
                    this.audioActivityStatus.delete(media);
                    return;
                }
                if (media.paused) {
                    attempts = 0;
                    return;
                }

                attempts++;
                nodes.analyser.getByteFrequencyData(analyserData);
                const sum = analyserData.reduce((a, b) => a + b, 0);

                if (sum > 0) {
                    clearInterval(intervalId);
                    this.audioActivityStatus.set(media, 'passed');
                    return;
                }

                if (attempts >= MAX_ATTEMPTS) {
                    clearInterval(intervalId);
                    this.audioActivityStatus.set(media, 'failed');

                    if (this.stateManager.get('settings.autoRefresh')) {
                        console.warn('[VSC] 오디오 신호 없음 (CORS 의심). 페이지를 새로고침합니다.', media);
                        try {
                            sessionStorage.setItem('vsc_message', 'CORS 보안 정책으로 오디오 효과 적용에 실패하여 페이지를 자동 새로고침했습니다.');
                        } catch(e) { console.error('[VSC] sessionStorage 접근 실패:', e); }

                        this.stateManager.set('ui.warningMessage', 'CORS 오류 감지. 1.5초 후 오디오 복원을 위해 페이지를 새로고침합니다.');
                        this.cleanupForMedia(media);
                        setTimeout(() => { location.reload(); }, 1500);
                    } else {
                        console.warn('[VSC] 오디오 신호 없음 (CORS 의심). 자동 새로고침 비활성화됨.', media);
                        this.stateManager.set('ui.warningMessage', '오디오 효과 적용 실패 (CORS 보안 정책 가능성).');
                    }
                }
            }, CHECK_INTERVAL);
        }

        getOrCreateNodes(media) {
            const audioContextMap = this.stateManager.get('audio.audioContextMap');
            if (audioContextMap.has(media)) return audioContextMap.get(media);
            const newNodes = this.createAudioGraph(media);
            if (newNodes) {
                this.checkAudioActivity(media, newNodes);
                if (this.stateManager.get('audio.isLoudnessNormalizationEnabled')) {
                    this.startLoudnessAnalysis(media);
                }
            }
            return newNodes;
        }

        cleanupForMedia(media) {
            this.stopLoudnessAnalysis(media);
            if (this.animationFrameMap.has(media)) { cancelAnimationFrame(this.animationFrameMap.get(media)); this.animationFrameMap.delete(media); }
            const nodes = this.stateManager.get('audio.audioContextMap').get(media);
            if (nodes) {
                safeExec(() => { if (nodes.context.state !== 'closed') nodes.context.close(); }, 'cleanupForMedia');
                this.stateManager.get('audio.audioContextMap').delete(media);
            }
        }

        ensureContextResumed(media) {
            const nodes = this.getOrCreateNodes(media);
            if (nodes && nodes.context.state === 'suspended') {
                nodes.context.resume().catch(e => {
                    if (!this.stateManager.get('ui.audioContextWarningShown')) {
                        console.warn('[VSC] AudioContext resume failed. Click UI to enable.', e.message);
                        this.stateManager.set('ui.warningMessage', '오디오 효과를 위해 UI 버튼을 한 번 클릭해주세요.');
                        this.stateManager.set('ui.audioContextWarningShown', true);
                    }
                });
            }
        }

        _getInstantRMS() {
            return new Promise(resolve => {
                const media = this.stateManager.get('media.currentlyVisibleMedia') || [...this.stateManager.get('media.activeMedia')][0];
                if (!media) return resolve(0);

                const nodes = this.stateManager.get('audio.audioContextMap').get(media);
                if (!nodes || !nodes.loudnessAnalyzer) return resolve(0);

                const bufferLength = nodes.loudnessAnalyzer.frequencyBinCount;
                const dataArray = new Float32Array(bufferLength);
                nodes.loudnessAnalyzer.getFloatTimeDomainData(dataArray);

                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i] * dataArray[i];
                }
                const rms = Math.sqrt(sum / bufferLength);
                resolve(rms);
            });
        }

        startLoudnessAnalysis(media) {
            if (this.loudnessIntervalMap.has(media)) return;

            const nodes = this.stateManager.get('audio.audioContextMap').get(media);
            if (!nodes || !nodes.loudnessAnalyzer) return;

            const bufferLength = nodes.loudnessAnalyzer.frequencyBinCount;
            const dataArray = new Float32Array(bufferLength);
            let currentGain = this.stateManager.get('audio.preGain');

            const intervalId = setInterval(() => {
                if (!media.isConnected || media.paused) return;

                nodes.loudnessAnalyzer.getFloatTimeDomainData(dataArray);

                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i] * dataArray[i];
                }
                const rms = Math.sqrt(sum / bufferLength);

                if (rms === 0) return;

                const measuredLoudness = 20 * Math.log10(rms);

                const targetLoudness = this.stateManager.get('audio.loudnessTarget');
                const error = targetLoudness - measuredLoudness;

                const currentPreGain = this.stateManager.get('audio.preGain');
                const targetPreGain = currentPreGain * Math.pow(10, error / 20);

                const newGain = currentGain * (1 - CONFIG.LOUDNESS_ADJUSTMENT_SPEED) + targetPreGain * CONFIG.LOUDNESS_ADJUSTMENT_SPEED;
                currentGain = Math.max(0.1, Math.min(newGain, 4.0));

                this.stateManager.set('audio.preGain', currentGain);

            }, CONFIG.LOUDNESS_ANALYSIS_INTERVAL);

            this.loudnessIntervalMap.set(media, intervalId);
        }

        stopLoudnessAnalysis(media) {
            if (this.loudnessIntervalMap.has(media)) {
                clearInterval(this.loudnessIntervalMap.get(media));
                this.loudnessIntervalMap.delete(media);
            }
            const lastManualGain = this.stateManager.get('audio.lastManualPreGain');
            this.stateManager.set('audio.preGain', lastManualGain);
        }
    }

    // --- [PLUGIN] LiveStreamPlugin: Manages live stream delay and seeking ---
    class LiveStreamPlugin extends Plugin {
        constructor() {
            super('LiveStream');
            this.video = null; this.avgDelay = null; this.intervalId = null; this.pidIntegral = 0;
            this.lastError = 0; this.consecutiveStableChecks = 0;
            this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL;
        }

        init(stateManager) {
            super.init(stateManager);
            this.subscribe('liveStream.isRunning', (isRunning) => {
                if(isRunning) {
                    this.start();
                } else {
                    this.stop();
                }
            });
            this.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge());
            this.subscribe('liveStream.resetRequested', () => {
                if (this.stateManager.get('liveStream.isRunning')) {
                    this.avgDelay = null;
                    this.pidIntegral = 0;
                    this.lastError = 0;
                    console.log('[VSC] Live stream delay meter reset.');
                }
            });

            const isLiveUrl = CONFIG.LIVE_STREAM_URLS.some(d => location.href.includes(d));
            if (isLiveUrl) {
                this.stateManager.set('liveStream.isRunning', true);
            }
        }

        destroy() {
            super.destroy();
            this.stop();
        }

        switchInterval(newInterval) {
            if (this.currentInterval === newInterval) return;
            clearInterval(this.intervalId);
            this.currentInterval = newInterval;
            this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval);
        }

        findVideo() {
            const visibleVideos = Array.from(this.stateManager.get('media.activeMedia'))
                .filter(m => m.tagName === 'VIDEO' && m.dataset.isVisible === 'true');
            if (visibleVideos.length === 0) return null;
            return visibleVideos.sort((a,b) => (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight))[0];
        }

        calculateDelay(v) {
            if (!v) return null;
            if (typeof v.liveLatency === 'number' && v.liveLatency > 0) return v.liveLatency * 1000;
            if (v.buffered && v.buffered.length > 0) {
                try {
                    const end = v.buffered.end(v.buffered.length-1);
                    if (v.currentTime > end) return 0;
                    return Math.max(0, (end - v.currentTime) * 1000);
                } catch { return null; }
            }
            return null;
        }

        getSmoothPlaybackRate(currentDelay, targetDelay) {
            const error = currentDelay - targetDelay;
            this.pidIntegral += error;
            const derivative = error - this.lastError;
            this.lastError = error;
            let rateChange = CONFIG.AUTODELAY_PID_KP * error + CONFIG.AUTODELAY_PID_KI * this.pidIntegral + CONFIG.AUTODELAY_PID_KD * derivative;
            return Math.max(CONFIG.AUTODELAY_MIN_RATE, Math.min(1 + rateChange, CONFIG.AUTODELAY_MAX_RATE));
        }

        checkAndAdjust() {
            this.video = this.findVideo();
            if (!this.video) {
                const currentInfo = this.stateManager.get('liveStream.delayInfo');
                if (currentInfo) {
                    this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: null, rate: currentInfo.rate });
                }
                return;
            };
            const rawDelay = this.calculateDelay(this.video);

            if (rawDelay === null) {
                this.stateManager.set('liveStream.delayInfo', {
                    avg: this.avgDelay, raw: null, rate: this.video.playbackRate
                });
                return;
            }

            this.avgDelay = this.avgDelay === null ? rawDelay : CONFIG.AUTODELAY_EMA_ALPHA * rawDelay + (1 - CONFIG.AUTODELAY_EMA_ALPHA) * this.avgDelay;

            this.stateManager.set('liveStream.delayInfo', {
                avg: this.avgDelay, raw: rawDelay, rate: this.video.playbackRate
            });

            const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY;
            const error = this.avgDelay - targetDelay;

            if (Math.abs(error) < CONFIG.AUTODELAY_STABLE_THRESHOLD) this.consecutiveStableChecks++; else { this.consecutiveStableChecks = 0; if (this.isStable) { this.isStable = false; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_NORMAL); } }
            if (this.consecutiveStableChecks >= CONFIG.AUTODELAY_STABLE_COUNT && !this.isStable) { this.isStable = true; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_STABLE); }

            let newRate;
            if (this.avgDelay !== null && this.avgDelay <= targetDelay) {
                newRate = 1.0;
                this.pidIntegral = 0;
                this.lastError = 0;
            } else {
                newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay);
            }

            if (Math.abs(this.video.playbackRate - newRate) > 0.001) {
                this.video.playbackRate = newRate;
            }

            const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child');
            if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) {
                const isLiveNow = this.avgDelay < (CONFIG.DEFAULT_TARGET_DELAY + 500);
                liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080';
            }
        }

        start() {
            if (this.intervalId) return;
            setTimeout(() => {
                this.stateManager.set('liveStream.delayInfo', { raw: null, avg: null, rate: 1.0 });
            }, 0);
            this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval);
        }

        stop() {
            if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }

            const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child');
            if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) {
                liveJumpBtn.style.boxShadow = '';
            }

            this.stateManager.set('liveStream.delayInfo', null);
            this.video = null; this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0;
            this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL;
        }

        seekToLiveEdge() {
            const videos = Array.from(this.stateManager.get('media.activeMedia'))
                .filter(m => m.tagName === 'VIDEO');
            if (videos.length === 0) return;

            const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY;

            videos.forEach(v => {
                try {
                    const seekableEnd = (v.seekable && v.seekable.length > 0)
                        ? v.seekable.end(v.seekable.length - 1)
                        : Infinity;
                    const bufferedEnd = (v.buffered && v.buffered.length > 0)
                        ? v.buffered.end(v.buffered.length - 1)
                        : 0;

                    const liveEdge = Math.min(seekableEnd, bufferedEnd);

                    if (!isFinite(liveEdge)) return;

                    const delayMs = (liveEdge - v.currentTime) * 1000;

                    if (delayMs <= targetDelay) return;

                    if (!v._lastLiveJump) v._lastLiveJump = 0;
                    if (Date.now() - v._lastLiveJump < CONFIG.LIVE_JUMP_INTERVAL) return;

                    if (liveEdge - v.currentTime < CONFIG.LIVE_JUMP_END_THRESHOLD) return;

                    v._lastLiveJump = Date.now();
                    v.currentTime = liveEdge - 0.5;
                    if (v.paused) v.play().catch(console.warn);

                } catch (e) {
                    console.error('[VSC] seekToLiveEdge error:', e);
                }
            });
        }
    }

    // --- [PLUGIN] PlaybackControlPlugin: Manages speed and basic playback ---
    class PlaybackControlPlugin extends Plugin {
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate));
        }
        setPlaybackRate(rate) {
            this.stateManager.get('media.activeMedia').forEach(media => {
                if (media.playbackRate !== rate) media.playbackRate = rate;
            });
        }
    }

    // --- [PLUGIN] MediaSessionPlugin: Integrates with the Media Session API ---
    class MediaSessionPlugin extends Plugin {
        constructor() { super('MediaSession'); }

        init(stateManager) {
            super.init(stateManager);
            this.subscribe('media.activeMedia', () => this.updateSession());
        }

        updateSession() {
            if (!('mediaSession' in navigator)) return;
            const activeMedia = Array.from(this.stateManager.get('media.activeMedia')).find(m => !m.paused);
            if (activeMedia) this.setSession(activeMedia);
            else this.clearSession();
        }

        getMeta() {
            const rule = CONFIG.SITE_METADATA_RULES[location.hostname];
            const getText = sels => { if(!Array.isArray(sels)) return null; for (const sel of sels) { const el = document.querySelector(sel); if (el) return el.textContent.trim(); } return null; };
            if (rule) return { title: getText(rule.title) || document.title, artist: getText(rule.artist) || location.hostname };
            return { title: document.title, artist: location.hostname };
        }

        setSession(m) {
            safeExec(() => {
                const { title, artist } = this.getMeta();
                navigator.mediaSession.metadata = new window.MediaMetadata({ title, artist, album: 'Video_Image_Control' });
                const setAction = (act, h) => { try { navigator.mediaSession.setActionHandler(act, h); } catch (e) { } };
                const seekTime = (!m || !isFinite(m.duration)) ? 10 : Math.min(Math.floor(m.duration * CONFIG.SEEK_TIME_PERCENT), CONFIG.SEEK_TIME_MAX_SEC);
                setAction('play', () => m.play());
                setAction('pause', () => m.pause());
                setAction('seekbackward', () => { m.currentTime -= seekTime; });
                setAction('seekforward', () => { m.currentTime += seekTime; });
            }, 'MediaSession.set');
        }

        clearSession() {
            safeExec(() => {
                navigator.mediaSession.metadata = null;
                ['play', 'pause', 'seekbackward', 'seekforward'].forEach(a => { try { navigator.mediaSession.setActionHandler(a, null); } catch(e){} });
            }, 'MediaSession.clear');
        }
    }

    // --- [PLUGIN] NavigationPlugin: Handles Single Page Application navigation ---
    class NavigationPlugin extends Plugin {
        constructor(pluginManager) {
            super('Navigation');
            this.pluginManager = pluginManager;
            this.spaNavigationHandler = debounce(this.handleNavigation.bind(this), 500);
        }

        init(stateManager) {
            super.init(stateManager);
            this.hookSpaNavigation();
        }

        handleNavigation() {
            if (location.href === this.stateManager.get('ui.lastUrl')) return;
            this.pluginManager.destroyAll();
            setTimeout(() => { this.pluginManager.initAll(); }, 100);
        }

        hookSpaNavigation() {
            if (!window.vscPatchedHistory) {
                ['pushState', 'replaceState'].forEach(method => {
                    const original = history[method];
                    if (original) { history[method] = function (...args) { const result = original.apply(this, args); window.dispatchEvent(new Event(`vsc:${method}`)); return result; }; }
                });
                window.vscPatchedHistory = true;
            }
            window.addEventListener('popstate', this.spaNavigationHandler);
            window.addEventListener('vsc:pushState', this.spaNavigationHandler);
            window.addEventListener('vsc:replaceState', this.spaNavigationHandler);
        }
    }

    // --- [PLUGIN] UIPlugin: Manages all DOM elements and user interactions ---
    class UIPlugin extends Plugin {
        constructor() {
            super('UI');
            this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null;
            this.hostElement = null; this.shadowRoot = null; this.fadeOutTimer = null;
            this.isDragging = false; this.wasDragged = false;
            this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 };
            this.animationFrameId = null;
            this.delayMeterEl = null;
            this.audioFXPlugin = null;
            this.speedButtons = [];
            this.uiElements = {};
            this.modalHost = null;
            this.modalShadowRoot = null;

            this.presetMap = {
                'default': {
                    name: '기본값 (모든 효과 꺼짐)',
                    targetLUFS: CONFIG.LOUDNESS_TARGET,
                    multiband_enabled: false,
                    smartEQ_enabled: false
                },
                'basic_clear': {
                    name: '✔ 기본 개선 (명료)',
                    hpf_enabled: true, hpf_hz: 70, eq_enabled: true, eq_mid: 2, eq_treble: 1.5, eq_presence: 2,
                    preGain_enabled: true, preGain_value: 1, mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 2,
                    targetLUFS: -16, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -24, ratio: 3, attack: 10, release: 300, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -26, ratio: 3.5, attack: 8, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -28, ratio: 4, attack: 5, release: 200, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -30, ratio: 4.5, attack: 2, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 120, Q: 1.2, threshold: -21, gain: -2 },
                        { frequency: 1000, Q: 1.0, threshold: -22, gain: 2 },
                        { frequency: 4000, Q: 0.8, threshold: -24, gain: 2 },
                        { frequency: 8000, Q: 1.5, threshold: -25, gain: 1 }
                    ]
                },
                'movie_immersive': {
                    name: '🎬 영화/드라마 (몰입감)',
                    hpf_enabled: true, hpf_hz: 60, eq_enabled: true, eq_subBass: 1, eq_bass: 0.8, eq_mid: 2, eq_treble: 1.3, eq_presence: 1.2,
                    widen_enabled: true, widen_factor: 1.4, deesser_enabled: true, deesser_threshold: -25, parallel_comp_enabled: true, parallel_comp_mix: 15,
                    mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 0, preGain_enabled: true, preGain_value: 0.8,
                    targetLUFS: -15, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -22, ratio: 2.8, attack: 12, release: 300, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -25, ratio: 3.2, attack: 8, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -27, ratio: 3.8, attack: 5, release: 200, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -29, ratio: 4.2, attack: 2, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 80, Q: 1.0, threshold: -20, gain: -1 },
                        { frequency: 500, Q: 1.0, threshold: -22, gain: 1 },
                        { frequency: 3000, Q: 0.9, threshold: -24, gain: 2 },
                        { frequency: 10000, Q: 1.2, threshold: -25, gain: 1 }
                    ]
                },
                'action_blockbuster': {
                    name: '💥 액션 블록버스터 (타격감)',
                    hpf_enabled: true, hpf_hz: 50, eq_enabled: true, eq_subBass: 1.5, eq_bass: 1.2, eq_mid: -2, eq_treble: 1.2, eq_presence: 1.8,
                    widen_enabled: true, widen_factor: 1.5, parallel_comp_enabled: true, parallel_comp_mix: 18,
                    mastering_suite_enabled: true, mastering_transient: 0.5, mastering_drive: 3,
                    targetLUFS: -14, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -26, ratio: 3.5, attack: 12, release: 320, makeup: 2.5 },
                        { freqLow: 120, freqHigh: 1000, threshold: -27, ratio: 4, attack: 8, release: 260, makeup: 2 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -28, ratio: 4.5, attack: 6, release: 200, makeup: 1.5 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -30, ratio: 5, attack: 3, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 60, Q: 1.0, threshold: -19, gain: 2 },
                        { frequency: 250, Q: 1.2, threshold: -21, gain: -1 },
                        { frequency: 2000, Q: 0.8, threshold: -23, gain: 2 },
                        { frequency: 8000, Q: 1.3, threshold: -24, gain: 2 }
                    ]
                },
                'concert_hall': {
                    name: '🏟️ 라이브 콘서트 (현장감)',
                    hpf_enabled: true, hpf_hz: 60, eq_enabled: true, eq_subBass: 1, eq_bass: 1, eq_mid: 0.5, eq_treble: 1, eq_presence: 1.2,
                    widen_enabled: true, widen_factor: 1.3, preGain_enabled: true, preGain_value: 1.2, reverb_enabled: true, reverb_mix: 0.5,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 2.5,
                    targetLUFS: -14.5, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -24, ratio: 3, attack: 12, release: 280, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -26, ratio: 3.2, attack: 9, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -27, ratio: 3.8, attack: 6, release: 210, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -29, ratio: 4.2, attack: 3, release: 160, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 100, Q: 1.0, threshold: -20, gain: -1 },
                        { frequency: 500, Q: 1.1, threshold: -21, gain: 2 },
                        { frequency: 3000, Q: 0.9, threshold: -23, gain: 2 },
                        { frequency: 9000, Q: 1.3, threshold: -25, gain: 2 }
                    ]
                },
                'music_dynamic': {
                    name: '🎶 음악 (다이나믹 & 펀치감)',
                    hpf_enabled: true, hpf_hz: 40, eq_enabled: true, eq_subBass: 1.2, eq_bass: 1.2, eq_mid: 1, eq_treble: 1, eq_presence: 2,
                    widen_enabled: true, widen_factor: 1.3, exciter_enabled: true, exciter_amount: 12,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 3,
                    targetLUFS: -13, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -25, ratio: 3.5, attack: 10, release: 300, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -27, ratio: 4, attack: 8, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -28, ratio: 4.5, attack: 5, release: 200, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -30, ratio: 5, attack: 2, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 70, Q: 1.0, threshold: -20, gain: 2 },
                        { frequency: 250, Q: 1.2, threshold: -21, gain: -1 },
                        { frequency: 1500, Q: 1.0, threshold: -23, gain: 2 },
                        { frequency: 7000, Q: 1.2, threshold: -24, gain: 2 }
                    ]
                },
                'mastering_balanced': {
                    name: '🔥 밸런스 마스터링 (고음질)',
                    hpf_enabled: true, hpf_hz: 45, eq_enabled: true, eq_treble: 1.2, eq_presence: 1,
                    widen_enabled: true, widen_factor: 1.25, exciter_enabled: true, exciter_amount: 10,
                    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 3.5, preGain_enabled: true, preGain_value: 1.5,
                    targetLUFS: -13.5, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -24, ratio: 3.2, attack: 10, release: 300, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -26, ratio: 3.8, attack: 8, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -27, ratio: 4.2, attack: 5, release: 200, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -29, ratio: 4.5, attack: 2, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 80, Q: 1.0, threshold: -20, gain: -1 },
                        { frequency: 500, Q: 1.0, threshold: -22, gain: 1 },
                        { frequency: 2500, Q: 0.9, threshold: -23, gain: 2 },
                        { frequency: 10000, Q: 1.3, threshold: -25, gain: 2 }
                    ]
                },
                'vocal_clarity_pro': {
                    name: '🎙️ 목소리 명료 (강의/뉴스)',
                    hpf_enabled: true, hpf_hz: 110, eq_enabled: true, eq_subBass: -2, eq_bass: -1, eq_mid: 3, eq_treble: 2, eq_presence: 2.5,
                    preGain_enabled: true, preGain_value: 1.0, deesser_enabled: true, deesser_threshold: -35, parallel_comp_enabled: true, parallel_comp_mix: 12,
                    mastering_suite_enabled: true, mastering_transient: 0.1, mastering_drive: 1.5,
                    targetLUFS: -18, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -20, ratio: 2.5, attack: 15, release: 320, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -23, ratio: 3, attack: 10, release: 260, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -25, ratio: 3.5, attack: 7, release: 210, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -27, ratio: 4, attack: 4, release: 160, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 120, Q: 1.2, threshold: -20, gain: -2 },
                        { frequency: 1000, Q: 1.0, threshold: -22, gain: 3 },
                        { frequency: 4000, Q: 0.8, threshold: -24, gain: 3 },
                        { frequency: 9000, Q: 1.5, threshold: -25, gain: 1 }
                    ]
                },
                'gaming_pro': {
                    name: '🎮 게이밍 (사운드 플레이)',
                    hpf_enabled: true, hpf_hz: 50, eq_enabled: true, eq_subBass: -1, eq_mid: 2, eq_treble: 2, eq_presence: 2.5,
                    widen_enabled: true, widen_factor: 1.2, mastering_suite_enabled: true, mastering_transient: 0.5, mastering_drive: 2.5,
                    targetLUFS: -15, multiband_enabled: true,
                    multiband_bands: [
                        { freqLow: 20, freqHigh: 120, threshold: -23, ratio: 3, attack: 12, release: 300, makeup: 2 },
                        { freqLow: 120, freqHigh: 1000, threshold: -25, ratio: 3.5, attack: 9, release: 250, makeup: 1.5 },
                        { freqLow: 1000, freqHigh: 6000, threshold: -27, ratio: 4, attack: 6, release: 200, makeup: 1 },
                        { freqLow: 6000, freqHigh: 20000, threshold: -29, ratio: 4.5, attack: 3, release: 150, makeup: 1 }
                    ],
                    smartEQ_enabled: true,
                    smartEQ_bands: [
                        { frequency: 80, Q: 1.0, threshold: -20, gain: -1 },
                        { frequency: 500, Q: 1.0, threshold: -22, gain: 2 },
                        { frequency: 3000, Q: 0.9, threshold: -23, gain: 3 },
                        { frequency: 8000, Q: 1.3, threshold: -24, gain: 2 }
                    ]
                }
            };

        }

        init(stateManager) {
            super.init(stateManager);

            setTimeout(() => {
                if(window.vscPluginManager) {
                    this.audioFXPlugin = window.vscPluginManager.plugins.find(p => p.name === 'AudioFX');
                }
            }, 0);

            this.subscribe('ui.createRequested', () => {
                if (!this.globalContainer) {
                    this.createGlobalUI();
                    this.stateManager.set('ui.globalContainer', this.globalContainer);
                }
            });

            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            this.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info));
            this.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());

            this.subscribe('audio.activePresetKey', (presetKey) => {
                if (!this.shadowRoot) return;
                this.shadowRoot.querySelectorAll('.vsc-preset-select').forEach(select => {
                    if (select.value !== presetKey) {
                        select.value = presetKey;
                    }
                });
            });


            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));

            const vscMessage = sessionStorage.getItem('vsc_message');
            if (vscMessage) {
                this.showWarningMessage(vscMessage);
                sessionStorage.removeItem('vsc_message');
            }

            document.addEventListener('fullscreenchange', () => {
                const fullscreenRoot = document.fullscreenElement || document.body;
                if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) {
                    fullscreenRoot.appendChild(this.globalContainer);
                }
                if (this.modalHost && this.modalHost.parentElement !== fullscreenRoot) {
                    fullscreenRoot.appendChild(this.modalHost);
                }
            });
        }

        destroy() {
            super.destroy();
            if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; }
            if (this.modalHost) { this.modalHost.remove(); this.modalHost = null; }
            if (this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; }
        }

        showWarningMessage(message) {
            if (!message) return;
            let warningEl = document.getElementById('vsc-warning-bar');
            if (warningEl) {
                warningEl.querySelector('span').textContent = message;
                warningEl.style.opacity = '1';
                if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout);
            } else {
                warningEl = document.createElement('div');
                warningEl.id = 'vsc-warning-bar';
                Object.assign(warningEl.style, {
                    position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)',
                    background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px',
                    borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex',
                    alignItems: 'center', gap: '15px', fontSize: '14px',
                    boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0',
                    transition: 'opacity 0.5s ease-in-out', maxWidth: '90%',
                });
                const messageSpan = document.createElement('span');
                messageSpan.textContent = message;
                const closeBtn = document.createElement('button');
                Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' });
                closeBtn.textContent = '×';
                closeBtn.onclick = () => warningEl.style.opacity = '0';
                warningEl.append(messageSpan, closeBtn);
                document.body.appendChild(warningEl);
                setTimeout(() => (warningEl.style.opacity = '1'), 100);
            }
            warningEl.hideTimeout = setTimeout(() => {
                warningEl.style.opacity = '0';
            }, CONFIG.UI_WARN_TIMEOUT);
        }

        updateDelayMeterVisibility() {
            if (this.delayMeterEl) {
                const controlsVisible = this.stateManager.get('ui.areControlsVisible');
                this.delayMeterEl.style.display = controlsVisible ? 'flex' : 'none';
            }
        }

        updateDelayMeter(info) {
            if (!info && this.delayMeterEl) {
                this.delayMeterEl.remove();
                this.delayMeterEl = null;
                return;
            }
            if (info && !this.delayMeterEl && document.body) {
                this.delayMeterEl = document.createElement('div');
                Object.assign(this.delayMeterEl.style, {
                    position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1,
                    background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px',
                    fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px'
                });

                const textSpan = document.createElement('span');
                const refreshBtn = document.createElement('button');
                refreshBtn.textContent = '🔄';
                refreshBtn.title = '딜레이 측정 초기화';
                Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' });
                refreshBtn.onclick = () => {
                    this.stateManager.set('liveStream.resetRequested', Date.now());
                    if (textSpan) {
                        textSpan.textContent = '딜레이 리셋 중...';
                    }
                };

                const closeBtn = document.createElement('button');
                closeBtn.textContent = '✖';
                closeBtn.title = '닫기';
                Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' });
                closeBtn.onclick = () => {
                    this.stateManager.set('liveStream.isRunning', false);
                };
                this.delayMeterEl.append(textSpan, refreshBtn, closeBtn);
                document.body.appendChild(this.delayMeterEl);
                this.updateDelayMeterVisibility();
            }
            if (this.delayMeterEl) {
                const textSpan = this.delayMeterEl.querySelector('span');
                if (textSpan) {
                    if (info.raw === null && info.avg === null) {
                        textSpan.textContent = '딜레이 측정 중...';
                    } else {
                        textSpan.textContent = `딜레이: ${info.avg?.toFixed(0) || 'N/A'}ms / 현재: ${info.raw?.toFixed(0) || 'N/A'}ms / 배속: ${info.rate?.toFixed(3) || 'N/A'}x`;
                    }
                }
            }
        }

        resetFadeTimer() {
            const container = this.uiElements.mainContainer;
            if (container) {
                clearTimeout(this.fadeOutTimer);
                container.style.opacity = '1';
                this.fadeOutTimer = setTimeout(() => this.startFadeSequence(), 10000);
            }
        }

        startFadeSequence() {
            const container = this.uiElements.mainContainer;
            if (container) {
                container.querySelectorAll('.vsc-control-group.submenu-visible').forEach(g => g.classList.remove('submenu-visible'));
                container.style.opacity = '0.3';
            }
        }

        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile');

            this.globalContainer = document.createElement('div');
            this.globalContainer.style.setProperty('--vsc-translate-x', '0px');
            this.globalContainer.style.setProperty('--vsc-translate-y', '0px');

            Object.assign(this.globalContainer.style, {
                position: 'fixed',
                top: '50%',
                right: '1vmin',
                transform: 'translateY(-50%) translate(var(--vsc-translate-x), var(--vsc-translate-y))',
                zIndex: CONFIG.MAX_Z_INDEX,
                display: 'flex',
                alignItems: 'flex-start',
                gap: '5px',
                WebkitTapHighlightColor: 'transparent'
            });

            this.mainControlsContainer = document.createElement('div');
            Object.assign(this.mainControlsContainer.style, {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '5px'
            });

            this.triggerElement = document.createElement('div');
            this.triggerElement.textContent = '⚡';
            Object.assign(this.triggerElement.style, {
                width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex',
                alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none',
                fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                transition: 'box-shadow 0.3s ease-in-out, background-color 0.3s',
                order: '1',
                touchAction: 'none',
            });
            this.triggerElement.addEventListener('click', (e) => {
                if (this.wasDragged) {
                    e.stopPropagation();
                    return;
                }
                const isVisible = this.stateManager.get('ui.areControlsVisible');
                this.stateManager.set('ui.areControlsVisible', !isVisible);
            });

            this.speedButtonsContainer = document.createElement('div');
            this.speedButtonsContainer.id = 'vsc-speed-buttons-container';
            this.speedButtonsContainer.style.cssText = `
                display:none; flex-direction:column; gap:5px; align-items:center;
                background: transparent;
                border-radius: 0px; padding: 0px;
            `;

            this.attachDragAndDrop();
            this.mainControlsContainer.appendChild(this.triggerElement);
            this.globalContainer.appendChild(this.mainControlsContainer);
            this.globalContainer.appendChild(this.speedButtonsContainer);
            document.body.appendChild(this.globalContainer);
        }

        onControlsVisibilityChange(isVisible) {
            if (!this.triggerElement) return;
            this.triggerElement.textContent = isVisible ? '🛑' : '⚡';
            this.triggerElement.style.backgroundColor = isVisible ? 'rgba(200, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.5)';
            if (isVisible && !this.hostElement) {
                this.createControlsHost();
            }
            if(this.hostElement) {
                this.hostElement.style.display = isVisible ? 'flex' : 'none';
            }
            if(this.speedButtonsContainer) {
                const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO');
                this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none';
            }
            this.updateUIVisibility();
        }

        createControlsHost() {
            this.hostElement = document.createElement('div');
            this.hostElement.style.order = '2';
            this.stateManager.set('ui.hostElement', this.hostElement);
            this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
            this.stateManager.set('ui.shadowRoot', this.shadowRoot);

            this.modalHost = document.createElement('div');
            this.modalShadowRoot = this.modalHost.attachShadow({ mode: 'open' });
            const currentRoot = document.fullscreenElement || document.body;
            currentRoot.appendChild(this.modalHost);


            this.renderAllControls();
            this.mainControlsContainer.prepend(this.hostElement);
        }

        updateUIVisibility() {
            if (!this.shadowRoot) return;

            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            const activeMedia = this.stateManager.get('media.activeMedia');
            const activeImages = this.stateManager.get('media.activeImages');

            const hasVideo = [...activeMedia].some(m => m.tagName === 'VIDEO');
            const hasAudio = [...activeMedia].some(m => m.tagName === 'AUDIO');
            const hasImage = activeImages.size > 0;
            const hasAnyMedia = hasVideo || hasAudio;

            if(this.speedButtonsContainer) {
                this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none';
            }

            const setVisible = (element, visible) => {
                if (element) element.classList.toggle(CONFIG.UI_HIDDEN_CLASS_NAME, !visible);
            };
            setVisible(this.uiElements.videoControls, hasVideo);
            setVisible(this.uiElements.imageControls, hasImage);
            setVisible(this.uiElements.audioControls, hasAnyMedia);
        }

        updateActiveSpeedButton(rate) {
            if (this.speedButtons.length === 0) return;
            this.speedButtons.forEach(b => {
                const speed = parseFloat(b.dataset.speed);
                if (speed) {
                    const isActive = Math.abs(speed - rate) < 0.01;
                    if (isActive) {
                        b.style.background = 'rgba(231, 76, 60, 0.9)';
                        b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset';
                    } else {
                        b.style.background = 'rgba(52, 152, 219, 0.7)';
                        b.style.boxShadow = '';
                    }
                }
            });
        }

        _createControlGroup(id, icon, title, parent) {
            const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group';
            const mainBtn = document.createElement('button'); mainBtn.className = 'vsc-btn vsc-btn-main'; mainBtn.textContent = icon; mainBtn.title = title;
            const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu';
            group.append(mainBtn, subMenu);
            mainBtn.onclick = (e) => {
                e.stopPropagation();
                const isOpening = !group.classList.contains('submenu-visible');
                this.shadowRoot.querySelectorAll('.vsc-control-group').forEach(g => g.classList.remove('submenu-visible'));
                if(isOpening) group.classList.add('submenu-visible');
                this.resetFadeTimer();
                if (id === 'vsc-stereo-controls' && isOpening && !this.stateManager.get('audio.audioInitialized')) {
                    this.stateManager.set('audio.audioInitialized', true);
                    this.stateManager.set('audio.activityCheckRequested', Date.now());
                }
            };
            parent.appendChild(group);
            if (id === 'vsc-image-controls') this.uiElements.imageControls = group;
            if (id === 'vsc-video-controls') this.uiElements.videoControls = group;
            if (id === 'vsc-stereo-controls') this.uiElements.audioControls = group;
            return subMenu;
        }

        _createSlider(label, id, min, max, step, stateKey, unit, formatFn) {
            const div = document.createElement('div'); div.className = 'slider-control';
            const labelEl = document.createElement('label'); const span = document.createElement('span');
            const updateText = (v) => { const val = parseFloat(v); if(isNaN(val)) return; span.textContent = formatFn ? formatFn(val) : `${val.toFixed(1)}${unit}`; };
            labelEl.textContent = `${label}: `; labelEl.appendChild(span);
            const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step;
            slider.value = this.stateManager.get(stateKey);

            const debouncedSetState = debounce((val) => {
                this.stateManager.set(stateKey, val);
                if (stateKey === 'audio.preGain') {
                    this.stateManager.set('audio.lastManualPreGain', val);
                }
            }, 50);

            slider.oninput = () => {
                const val = parseFloat(slider.value);
                updateText(val);
                debouncedSetState(val);
            };

            this.subscribe(stateKey, (val) => {
                updateText(val);
                if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) {
                    slider.value = val;
                }
            });
            updateText(slider.value);
            div.append(labelEl, slider);
            return { control: div, slider: slider };
        }

        _createToggleBtn(id, text, stateKey) {
            const btn = document.createElement('button'); btn.id = id; btn.textContent = text; btn.className = 'vsc-btn';
            btn.onclick = () => { this.stateManager.set(stateKey, !this.stateManager.get(stateKey)); };
            this.subscribe(stateKey, (val) => btn.classList.toggle('active', val));
            btn.classList.toggle('active', this.stateManager.get(stateKey));
            return btn;
        }

        _createSelectControl(labelText, options, changeHandler) {
            const div = document.createElement('div');
            div.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px;';

            const label = document.createElement('label');
            label.textContent = labelText + ':';
            label.style.cssText = `color: white; font-size: ${this.stateManager.get('app.isMobile') ? '12px' : '13px'}; white-space: nowrap;`;

            const select = document.createElement('select');
            select.className = 'vsc-select';
            options.forEach(opt => {
                const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.text;
                select.appendChild(o);
            });
            select.onchange = e => changeHandler(e.target.value);

            div.append(label, select);
            return div;
        }

        _createDivider() { const d = document.createElement('div'); d.className = 'vsc-divider'; return d; }

        renderAllControls() {
            if (this.shadowRoot.getElementById('vsc-main-container')) {
                return;
            }

            const style = document.createElement('style');
            const isMobile = this.stateManager.get('app.isMobile');
            style.textContent = `
                :host { pointer-events: none; } * { pointer-events: auto; -webkit-tap-highlight-color: transparent; }
                #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; opacity: 0.3; transition: opacity 0.3s; }
                #vsc-main-container:hover { opacity: 1; }
                #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap:5px;}
                .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; background: rgba(0,0,0,0.7); border-radius: 8px; }
                .${CONFIG.UI_HIDDEN_CLASS_NAME} { display: none !important; }
                .vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '4px' : 'clamp(6px, 1vmin, 9px)'}; }
                #vsc-stereo-controls .vsc-submenu { width: ${isMobile ? 'auto' : '520px'}; max-width: 90vw; }
                #vsc-video-controls .vsc-submenu { width: ${isMobile ? '280px' : '320px'}; max-width: 80vw; }
                #vsc-image-controls .vsc-submenu { width: 100px; }
                .vsc-control-group.submenu-visible .vsc-submenu { display: flex; }
                .vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(${isMobile ? '11px, 1.8vmin, 13px' : '12px, 2vmin, 14px'}); }
                .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }
                .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .vsc-btn-main { font-size: clamp(${isMobile ? '14px, 2.5vmin, 16px' : '15px, 3vmin, 18px'}); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; background: none; }
                .slider-control { display: flex; flex-direction: column; gap: ${isMobile ? '2px' : '4px'}; }
                .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '12px' : '13px'}; color: white; align-items: center; }
                input[type=range] { width: 100%; margin: 0; }
                input[type=range]:disabled { opacity: 0.5; }
                .vsc-audio-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; width: 100%; }
                .vsc-audio-column { display: flex; flex-direction: column; gap: ${isMobile ? '3px' : '8px'}; border-right: 1px solid #444; padding-right: 12px; }
                .vsc-audio-column:last-child { border-right: none; padding-right: 0; }
                .vsc-button-group { display: flex; gap: 8px; width: 100%; }
                .vsc-divider { border-top: 1px solid #444; margin: 8px 0; }
                .vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); width: 100%; box-sizing: border-box; }
                .vsc-button-group > .vsc-btn { flex-basis: 0; flex-grow: 1; }
                .vsc-mastering-row { display: flex; align-items: center; gap: 12px; }
                .vsc-mastering-row > .vsc-btn { flex: 1; }
                .vsc-mastering-row > .slider-control { flex: 1; }
                .vsc-tabs { display: flex; gap: 5px; border-bottom: 1px solid #444; margin-bottom: 10px; width: 100%; }
                .vsc-tab-btn { background: none; border: none; border-bottom: 2px solid transparent; color: #aaa; padding: 4px 8px; cursor: pointer; font-size: clamp(13px, 2.2vmin, 14px); }
                .vsc-tab-btn.active { color: white; border-bottom-color: #3498db; }
                .vsc-tab-pane { display: none; flex-direction: column; gap: 8px; }
                .vsc-tab-pane.active { display: flex; }
                .vsc-deq-band-selectors { display: flex; gap: 6px; justify-content: center; margin-bottom: 8px; }
                .vsc-deq-band-btn { width: 30px; height: 30px; border: 1px solid #555; background: #222; color: #ccc; font-weight: bold; }
                .vsc-deq-band-btn.active { border-color: #3498db; background: #3498db; color: white; }
                #vsc-mbc-modal {
                    display: none; position: fixed; top: 50%; left: 50%;
                    transform: translate(-50%, -50%);
                    width: auto; height: auto;
                    background: rgba(0,0,0,0.5); z-index: ${CONFIG.MAX_Z_INDEX + 1};
                    justify-content: center; align-items: center;
                    border-radius: 10px;
                    padding: 10px;
                }
                #vsc-mbc-container {
                    background: rgba(30,30,30,0.95); border: 1px solid #555; border-radius: 8px;
                    padding: clamp(8px, 2vw, 12px);
                    color: white; display: flex; flex-direction: column;
                    gap: clamp(8px, 1.5vw, 10px);
                    min-width: clamp(250px, 80vw, 550px);
                }
                #vsc-mbc-header { display: flex; justify-content: space-between; align-items: center; }
                #vsc-mbc-header h3 { margin: 0; font-size: clamp(13px, 2.2vw, 15px); }
                #vsc-mbc-bands {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 10px;
                }
                .vsc-mbc-band { display: flex; flex-direction: column; gap: 8px; padding: clamp(6px, 1.5vw, 8px); border: 1px solid #444; border-radius: 5px; }
                .vsc-mbc-band h4 { margin: 0 0 8px 0; text-align: center; font-size: clamp(13px, 2.2vw, 14px); color: #3498db; }

                @media (max-width: 600px) {
                    #vsc-mbc-bands {
                        grid-template-columns: 1fr;
                        gap: 8px;
                    }
                    #vsc-mbc-container {
                        min-width: clamp(250px, 75vw, 300px);
                    }
                }
            `;
            this.shadowRoot.appendChild(style);
            this.modalShadowRoot.appendChild(style.cloneNode(true));

            const mainContainer = document.createElement('div');
            mainContainer.id = 'vsc-main-container';
            this.uiElements.mainContainer = mainContainer;

            const controlsContainer = document.createElement('div');
            controlsContainer.id = 'vsc-controls-container';

            const imageSubMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controlsContainer);
            const imageSelect = document.createElement('select'); imageSelect.className = 'vsc-select';
            [{ v: "0", t: "꺼짐" }, ...Array.from({ length: 20 }, (_, i) => ({ v: (i + 1).toString(), t: `${i + 1}단계` }))].forEach(opt => {
                const o = document.createElement('option'); o.value = opt.v; o.textContent = opt.t; imageSelect.appendChild(o);
            });
            imageSelect.onchange = () => this.stateManager.set('imageFilter.level', parseInt(imageSelect.value, 10));
            this.subscribe('imageFilter.level', (val) => imageSelect.value = val);
            imageSelect.value = this.stateManager.get('imageFilter.level');
            imageSubMenu.appendChild(imageSelect);

            const videoSubMenu = this._createControlGroup('vsc-video-controls', '✨', '영상 필터', controlsContainer);
            const videoDefaults = this.stateManager.get('app.isMobile') ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            const videoResetBtn = document.createElement('button'); videoResetBtn.className = 'vsc-btn'; videoResetBtn.textContent = '초기화';
            videoResetBtn.style.marginTop = '8px';

            const sharpenDirOptions = [ { value: '4-way', text: '4방향 (기본)' }, { value: '8-way', text: '8방향 (강함)' } ];
            const sharpenDirSelect = this._createSelectControl( '샤프 방향', sharpenDirOptions, (value) => this.stateManager.set('videoFilter.sharpenDirection', value) );
            this.subscribe('videoFilter.sharpenDirection', val => sharpenDirSelect.querySelector('select').value = val);
            sharpenDirSelect.querySelector('select').value = this.stateManager.get('videoFilter.sharpenDirection');


            videoResetBtn.onclick = () => {
                this.stateManager.set('videoFilter.level', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL);
                this.stateManager.set('videoFilter.level2', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2);
                this.stateManager.set('videoFilter.saturation', parseInt(videoDefaults.SATURATION_VALUE, 10));
                this.stateManager.set('videoFilter.gamma', parseFloat(videoDefaults.GAMMA_VALUE));
                this.stateManager.set('videoFilter.blur', parseFloat(videoDefaults.BLUR_STD_DEVIATION));
                this.stateManager.set('videoFilter.shadows', parseInt(videoDefaults.SHADOWS_VALUE, 10));
                this.stateManager.set('videoFilter.highlights', parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10));
                this.stateManager.set('videoFilter.sharpenDirection', CONFIG.DEFAULT_VIDEO_SHARPEN_DIRECTION);
            };
            videoSubMenu.append(
                this._createSlider('샤프(윤곽)', 'v-sharpen1', 0, 20, 1, 'videoFilter.level', '단계', v => `${v.toFixed(0)}단계`).control,
                this._createSlider('샤프(디테일)', 'v-sharpen2', 0, 20, 1, 'videoFilter.level2', '단계', v => `${v.toFixed(0)}단계`).control,
                sharpenDirSelect,
                this._createSlider('채도', 'v-saturation', 0, 200, 1, 'videoFilter.saturation', '%', v => `${v.toFixed(0)}%`).control,
                this._createSlider('감마', 'v-gamma', 0.5, 1.5, 0.01, 'videoFilter.gamma', '', v => v.toFixed(2)).control,
                this._createSlider('블러', 'v-blur', 0, 1, 0.05, 'videoFilter.blur', '', v => v.toFixed(2)).control,
                this._createSlider('대비', 'v-shadows', -50, 50, 1, 'videoFilter.shadows', '', v => v.toFixed(0)).control,
                this._createSlider('밝기', 'v-highlights', -50, 50, 1, 'videoFilter.highlights', '', v => v.toFixed(0)).control,
                videoResetBtn
            );

            const audioSubMenu = this._createControlGroup('vsc-stereo-controls', '🎧', '사운드 필터', controlsContainer);

            const tabsContainer = document.createElement('div');
            tabsContainer.className = 'vsc-tabs';

            const panesContainer = document.createElement('div');

            const createTab = (id, text, isActive = false) => {
                const btn = document.createElement('button');
                btn.className = 'vsc-tab-btn';
                btn.dataset.tabId = id;
                btn.textContent = text;
                if (isActive) btn.classList.add('active');

                const pane = document.createElement('div');
                pane.id = id;
                pane.className = 'vsc-tab-pane';
                if (isActive) pane.classList.add('active');

                tabsContainer.appendChild(btn);
                panesContainer.appendChild(pane);

                btn.onclick = () => {
                    tabsContainer.querySelectorAll('.vsc-tab-btn').forEach(b => b.classList.remove('active'));
                    panesContainer.querySelectorAll('.vsc-tab-pane').forEach(p => p.classList.remove('active'));
                    btn.classList.add('active');
                    pane.classList.add('active');
                };
                return pane;
            };

            const basicPane = createTab('vsc-audio-basic-pane', '기본', true);
            const dynamicsPane = createTab('vsc-audio-dynamics-pane', '다이나믹스');
            const clarityPane = createTab('vsc-audio-clarity-pane', '명료도');

            audioSubMenu.append(tabsContainer, panesContainer);

            const basicGrid = document.createElement('div');
            basicGrid.className = 'vsc-audio-grid';
            basicGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            const basicCol1 = document.createElement('div'); basicCol1.className = 'vsc-audio-column';
            const basicCol2 = document.createElement('div'); basicCol2.className = 'vsc-audio-column';

            const eqSliders = [
                this._createSlider('초저음', 'eq-sub', -12, 12, 1, 'audio.eqSubBassGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
                this._createSlider('저음', 'eq-bass', -12, 12, 1, 'audio.eqBassGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
                this._createSlider('중음', 'eq-mid', -12, 12, 1, 'audio.eqMidGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
                this._createSlider('고음', 'eq-treble', -12, 12, 1, 'audio.eqTrebleGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
                this._createSlider('초고음', 'eq-pres', -12, 12, 1, 'audio.eqPresenceGain', 'dB', v => `${v.toFixed(0)}dB`).slider
            ];
            const hpfSlider = this._createSlider('주파수', 'hpf-freq', 20, 500, 5, 'audio.hpfHz', 'Hz', v => `${v.toFixed(0)}Hz`).slider;
            basicCol1.append(
                this._createToggleBtn('eq-toggle', 'EQ', 'audio.isEqEnabled'),
                ...eqSliders.map(s => s.parentElement),
                this._createDivider(),
                this._createSlider('베이스 부스트', 'bass-boost', 0, 9, 0.5, 'audio.bassBoostGain', 'dB', v => `${v.toFixed(1)}dB`).control
            );
            const preGainGroup = document.createElement('div');
            preGainGroup.className = 'vsc-button-group';
            const manualVolBtn = this._createToggleBtn('pre-gain-toggle', '볼륨', 'audio.isPreGainEnabled');
            const agcBtn = this._createToggleBtn('agc-toggle', 'AGC', 'audio.isAgcEnabled');
            const autoVolBtn = this._createToggleBtn('loudness-norm-toggle', '', 'audio.isLoudnessNormalizationEnabled');
            autoVolBtn.innerHTML = '자동<br>보정';
            preGainGroup.append(manualVolBtn, agcBtn, autoVolBtn);

            const widenSlider = this._createSlider('강도', 'widen-factor', 0, 3, 0.1, 'audio.wideningFactor', 'x').slider;
            const reverbSlider = this._createSlider('울림', 'reverb-mix', 0, 1, 0.05, 'audio.reverbMix', '', v => v.toFixed(2)).slider;
            const preGainSlider = this._createSlider('볼륨 크기', 'pre-gain-slider', 0, 4, 0.1, 'audio.preGain', 'x', v => v.toFixed(1)).slider;
            basicCol2.append(
                this._createToggleBtn('widen-toggle', 'Virtualizer', 'audio.isWideningEnabled'), widenSlider.parentElement,
                this._createToggleBtn('adaptive-width-toggle', 'Bass Mono', 'audio.isAdaptiveWidthEnabled'),
                this._createDivider(),
                this._createToggleBtn('reverb-toggle', '리버브', 'audio.isReverbEnabled'), reverbSlider.parentElement,
                this._createDivider(),
                this._createSlider('Pan', 'pan', -1, 1, 0.1, 'audio.stereoPan', '', v => v.toFixed(1)).control,
                this._createDivider(),
                preGainGroup, preGainSlider.parentElement,
                this._createDivider(),
                this._createToggleBtn('hpf-toggle', 'HPF', 'audio.isHpfEnabled'),
                hpfSlider.parentElement
            );
            this.uiElements.manualVolBtn = manualVolBtn;
            this.uiElements.preGainSlider = preGainSlider;
            basicGrid.append(basicCol1, basicCol2);
            basicPane.appendChild(basicGrid);

            const dynamicsGrid = document.createElement('div');
            dynamicsGrid.className = 'vsc-audio-grid';
            dynamicsGrid.style.gridTemplateColumns = 'repeat(2, 1fr)';
            const dynamicsCol1 = document.createElement('div'); dynamicsCol1.className = 'vsc-audio-column';
            const dynamicsCol2 = document.createElement('div'); dynamicsCol2.className = 'vsc-audio-column';

            const deesserSliders = [
                this._createSlider('강도', 'deesser-thresh', -60, 0, 1, 'audio.deesserThreshold', 'dB', v => `${v.toFixed(0)}dB`).slider,
                this._createSlider('주파수', 'deesser-freq', 4000, 12000, 100, 'audio.deesserFreq', 'kHz', v => `${(v/1000).toFixed(1)}kHz`).slider
            ];
            const exciterSlider = this._createSlider('강도', 'exciter-amount', 0, 100, 1, 'audio.exciterAmount', '%', v => `${v.toFixed(0)}%`).slider;
            const pcompSlider = this._createSlider('믹스', 'pcomp-mix', 0, 100, 1, 'audio.parallelCompMix', '%', v => `${v.toFixed(0)}%`).slider;

            dynamicsCol1.append(
                this._createToggleBtn('deesser-toggle', '디에서', 'audio.isDeesserEnabled'), ...deesserSliders.map(s=>s.parentElement),
                this._createDivider(),
                this._createToggleBtn('exciter-toggle', '익사이터', 'audio.isExciterEnabled'), exciterSlider.parentElement,
                this._createDivider(),
                this._createToggleBtn('pcomp-toggle', '업컴프', 'audio.isParallelCompEnabled'), pcompSlider.parentElement
            );

            const mbcGroup = document.createElement('div');
            mbcGroup.className = 'vsc-button-group';
            const mbcToggleBtn = this._createToggleBtn('mbc-toggle', '멀티밴드', 'audio.isMultibandCompEnabled');
            const mbcSettingsBtn = document.createElement('button');
            mbcSettingsBtn.className = 'vsc-btn';
            mbcSettingsBtn.textContent = '설정';
            mbcSettingsBtn.onclick = () => {
                const modal = this.modalShadowRoot.getElementById('vsc-mbc-modal');
                if (modal) modal.style.display = 'flex';
            };
            this.subscribe('audio.isMultibandCompEnabled', (isEnabled) => mbcSettingsBtn.disabled = !isEnabled);
            mbcSettingsBtn.disabled = !this.stateManager.get('audio.isMultibandCompEnabled');
            mbcGroup.append(mbcToggleBtn, mbcSettingsBtn);

            const masteringContainer = document.createElement('div');
            masteringContainer.className = 'vsc-mastering-row';
            const masteringToggleBtn = this._createToggleBtn('mastering-toggle', '마스터링', 'audio.isMasteringSuiteEnabled');
            masteringToggleBtn.addEventListener('click', () => { this.stateManager.set('audio.isLimiterEnabled', false); });
            const transientSliderObj = this._createSlider('타격감', 'master-transient', 0, 100, 1, 'audio.masteringTransientAmount', '%', v => `${(v * 100).toFixed(0)}%`);
            const driveSliderObj = this._createSlider('음압', 'master-drive', 0, 12, 0.5, 'audio.masteringDrive', 'dB', v => `${v.toFixed(1)}dB`);
            masteringContainer.append(masteringToggleBtn, transientSliderObj.control, driveSliderObj.control);

            dynamicsCol2.append(
                 mbcGroup,
                 this._createDivider(),
                 masteringContainer
            );
            dynamicsGrid.append(dynamicsCol1, dynamicsCol2);
            dynamicsPane.appendChild(dynamicsGrid);

            const deqToggleBtn = this._createToggleBtn('deq-toggle', '스마트 명료도 활성화', 'audio.isDynamicEqEnabled');
            deqToggleBtn.style.width = '100%';

            const bandSelectors = document.createElement('div');
            bandSelectors.className = 'vsc-deq-band-selectors';

            const deqControlsContainer = document.createElement('div');
            deqControlsContainer.style.display = 'flex';
            deqControlsContainer.style.flexDirection = 'column';
            deqControlsContainer.style.gap = '8px';
            deqControlsContainer.style.width = '250px';

            const deqFreqSlider = this._createSlider('Frequency', 'deq-freq', 20, 20000, 1, `audio.dynamicEq.bands.0.freq`, 'Hz', v => `${v < 1000 ? v.toFixed(0) : (v/1000).toFixed(1)} ${v < 1000 ? 'Hz' : 'kHz'}`).control;
            const deqQSlider = this._createSlider('Q', 'deq-q', 0.1, 10, 0.1, `audio.dynamicEq.bands.0.q`, '', v => v.toFixed(1)).control;
            const deqThresholdSlider = this._createSlider('Threshold', 'deq-thresh', -60, 0, 1, `audio.dynamicEq.bands.0.threshold`, 'dB', v => `${v.toFixed(0)}dB`).control;
            const deqGainSlider = this._createSlider('Gain', 'deq-gain', -12, 12, 1, `audio.dynamicEq.bands.0.gain`, 'dB', v => `${v.toFixed(0)}dB`).control;

            deqControlsContainer.append(deqFreqSlider, deqQSlider, deqThresholdSlider, deqGainSlider);

            const updateDeqUI = () => {
                const activeBandIndex = this.stateManager.get('audio.dynamicEq.activeBand') - 1;
                const bands = this.stateManager.get('audio.dynamicEq.bands');
                if (!bands || !bands[activeBandIndex]) return;
                const bandSettings = bands[activeBandIndex];

                bandSelectors.querySelectorAll('.vsc-deq-band-btn').forEach((btn, index) => {
                    btn.classList.toggle('active', index === activeBandIndex);
                });

                const updateSlider = (sliderEl, value) => {
                    if (sliderEl && Math.abs(sliderEl.value - value) > 0.001) {
                         sliderEl.value = value;
                         sliderEl.dispatchEvent(new Event('input', { bubbles:true }));
                    }
                };
                updateSlider(deqControlsContainer.querySelector('#deq-freq'), bandSettings.freq);
                updateSlider(deqControlsContainer.querySelector('#deq-q'), bandSettings.q);
                updateSlider(deqControlsContainer.querySelector('#deq-thresh'), bandSettings.threshold);
                updateSlider(deqControlsContainer.querySelector('#deq-gain'), bandSettings.gain);
            };

            for (let i = 1; i <= 4; i++) {
                const btn = document.createElement('button');
                btn.className = 'vsc-btn vsc-deq-band-btn';
                btn.textContent = i;
                btn.dataset.bandIndex = i;
                btn.onclick = () => {
                    this.stateManager.set('audio.dynamicEq.activeBand', i);
                };
                bandSelectors.appendChild(btn);
            }
            this.subscribe('audio.dynamicEq.activeBand', updateDeqUI);

            const createDeqSliderUpdater = (param) => (e) => {
                const activeBandIndex = this.stateManager.get('audio.dynamicEq.activeBand') - 1;
                let bands = JSON.parse(JSON.stringify(this.stateManager.get('audio.dynamicEq.bands')));
                bands[activeBandIndex][param] = parseFloat(e.target.value);
                this.stateManager.set('audio.dynamicEq.bands', bands);
            };

            deqControlsContainer.querySelector('#deq-freq').oninput = debounce(createDeqSliderUpdater('freq'), 50);
            deqControlsContainer.querySelector('#deq-q').oninput = debounce(createDeqSliderUpdater('q'), 50);
            deqControlsContainer.querySelector('#deq-thresh').oninput = debounce(createDeqSliderUpdater('threshold'), 50);
            deqControlsContainer.querySelector('#deq-gain').oninput = debounce(createDeqSliderUpdater('gain'), 50);
            this.subscribe('audio.dynamicEq.bands', updateDeqUI);

            this.subscribe('audio.isDynamicEqEnabled', (isEnabled) => {
                deqControlsContainer.style.opacity = isEnabled ? '1' : '0.5';
                deqControlsContainer.querySelectorAll('input').forEach(input => input.disabled = !isEnabled);
            });
            deqControlsContainer.style.opacity = this.stateManager.get('audio.isDynamicEqEnabled') ? '1' : '0.5';
            deqControlsContainer.querySelectorAll('input').forEach(input => input.disabled = !this.stateManager.get('audio.isDynamicEqEnabled'));

            clarityPane.append(deqToggleBtn, bandSelectors, deqControlsContainer);
            updateDeqUI();

            const bottomControls = document.createElement('div');
            bottomControls.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid #444; padding-top: 8px; margin-top: 8px;';
            const presetSelect = document.createElement('select');
            presetSelect.className = 'vsc-select vsc-preset-select';
            Object.entries(this.presetMap).forEach(([key, val]) => {
                const opt = document.createElement('option');
                opt.value = key; opt.textContent = val.name;
                presetSelect.appendChild(opt);
            });
            const resetBtn = document.createElement('button'); resetBtn.className = 'vsc-btn'; resetBtn.textContent = '초기화';

            bottomControls.append(presetSelect, resetBtn);
            [basicPane, dynamicsPane, clarityPane].forEach(pane => pane.appendChild(bottomControls.cloneNode(true)));

            panesContainer.querySelectorAll('.vsc-preset-select').forEach(sel => {
                sel.onchange = (e) => this.applyPreset(e.target.value);
            });
            panesContainer.querySelectorAll('button').forEach(btn => {
                if(btn.textContent === '초기화') {
                    btn.onclick = () => this.applyPreset('default');
                }
            });


            this.createMultibandCompModal();

            const setupSliderToggle = (stateKey, sliders) => {
                const update = (isEnabled) => sliders.forEach(s => { if(s) s.disabled = !isEnabled; });
                this.subscribe(stateKey, update);
                update(this.stateManager.get(stateKey));
            };
            setupSliderToggle('audio.isEqEnabled', eqSliders);
            setupSliderToggle('audio.isDeesserEnabled', deesserSliders);
            setupSliderToggle('audio.isExciterEnabled', [exciterSlider]);
            setupSliderToggle('audio.isParallelCompEnabled', [pcompSlider]);
            setupSliderToggle('audio.isWideningEnabled', [widenSlider]);
            setupSliderToggle('audio.isReverbEnabled', [reverbSlider]);
            setupSliderToggle('audio.isHpfEnabled', [hpfSlider]);
            setupSliderToggle('audio.isMasteringSuiteEnabled', [transientSliderObj.slider, driveSliderObj.slider]);

            this.subscribe('audio.isLoudnessNormalizationEnabled', (isAuto) => {
                if (isAuto) {
                    this.stateManager.set('audio.preGainEnabledBeforeAuto', this.stateManager.get('audio.isPreGainEnabled'));
                    this.stateManager.set('audio.isPreGainEnabled', true);
                } else {
                    this.stateManager.set('audio.isPreGainEnabled', this.stateManager.get('audio.preGainEnabledBeforeAuto'));
                }
                this._updateVolumeControlsState();
            });

            this.subscribe('audio.isPreGainEnabled', () => {
                this._updateVolumeControlsState();
            });

            this._updateVolumeControlsState();

            if (this.speedButtons.length === 0) {
                CONFIG.SPEED_PRESETS.forEach(speed => {
                    const btn = document.createElement('button');
                    btn.textContent = `${speed.toFixed(1)}x`;
                    btn.dataset.speed = speed;
                    btn.className = 'vsc-btn';
                    Object.assign(btn.style, {
                        background: 'rgba(52, 152, 219, 0.7)', color: 'white',
                        width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)',
                        fontSize: 'clamp(12px, 2vmin, 14px)', padding: '0',
                        transition: 'background-color 0.2s, box-shadow 0.2s'
                    });

                    btn.onclick = () => this.stateManager.set('playback.targetRate', speed);
                    this.speedButtonsContainer.appendChild(btn);
                    this.speedButtons.push(btn);
                });
                const isLiveJumpSite = CONFIG.LIVE_JUMP_WHITELIST.some(d =>
                    location.hostname === d || location.hostname.endsWith('.' + d)
                );
                if (isLiveJumpSite) {
                    const liveJumpBtn = document.createElement('button');
                    liveJumpBtn.textContent = '⚡';
                    liveJumpBtn.title = '실시간으로 이동';
                    liveJumpBtn.className = 'vsc-btn';
                    Object.assign(liveJumpBtn.style, {
                        width: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                        height: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                        fontSize: this.stateManager.get('app.isMobile') ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                        borderRadius: '50%', padding: '0',
                        transition: 'box-shadow 0.3s'
                    });
                    liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now());
                    this.speedButtonsContainer.appendChild(liveJumpBtn);
                }
            }


            mainContainer.appendChild(controlsContainer);
            this.shadowRoot.appendChild(mainContainer);
            this.updateActiveSpeedButton(this.stateManager.get('playback.currentRate'));
        }

        createMultibandCompModal() {
            const modal = document.createElement('div');
            modal.id = 'vsc-mbc-modal';
            modal.onclick = () => modal.style.display = 'none';

            const container = document.createElement('div');
            container.id = 'vsc-mbc-container';
            container.onclick = e => e.stopPropagation();

            const header = document.createElement('div');
            header.id = 'vsc-mbc-header';
            const title = document.createElement('h3');
            title.textContent = '멀티밴드 컴프레서 설정';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'vsc-btn';
            closeBtn.textContent = '✖';
            closeBtn.onclick = () => modal.style.display = 'none';
            header.append(title, closeBtn);

            const bandsContainer = document.createElement('div');
            bandsContainer.id = 'vsc-mbc-bands';

            const bandInfo = {
                low: { name: 'Low', color: '#e74c3c'},
                lowMid: { name: 'Low Mid', color: '#f39c12'},
                highMid: { name: 'High Mid', color: '#2ecc71'},
                high: { name: 'High', color: '#3498db'},
            };

            for (const [key, info] of Object.entries(bandInfo)) {
                const bandDiv = document.createElement('div');
                bandDiv.className = 'vsc-mbc-band';

                const bandTitle = document.createElement('h4');
                bandTitle.textContent = info.name;
                bandTitle.style.color = info.color;
                bandDiv.appendChild(bandTitle);

                bandDiv.appendChild(this._createSlider('Threshold', `mbc-${key}-thresh`, -100, 0, 1, `audio.multibandComp.${key}.threshold`, 'dB', v => `${v.toFixed(0)} dB`).control);
                bandDiv.appendChild(this._createSlider('Ratio', `mbc-${key}-ratio`, 1, 20, 1, `audio.multibandComp.${key}.ratio`, ':1', v => `${v.toFixed(0)}:1`).control);
                bandDiv.appendChild(this._createSlider('Attack', `mbc-${key}-attack`, 0, 1, 0.001, `audio.multibandComp.${key}.attack`, 's', v => `${(v*1000).toFixed(0)} ms`).control);
                bandDiv.appendChild(this._createSlider('Release', `mbc-${key}-release`, 0.01, 1, 0.01, `audio.multibandComp.${key}.release`, 's', v => `${(v*1000).toFixed(0)} ms`).control);
                bandDiv.appendChild(this._createSlider('Makeup', `mbc-${key}-makeup`, 0, 24, 1, `audio.multibandComp.${key}.makeupGain`, 'dB', v => `${v.toFixed(0)} dB`).control);

                bandsContainer.appendChild(bandDiv);
            }

            const modalResetBtn = document.createElement('button');
            modalResetBtn.className = 'vsc-btn';
            modalResetBtn.textContent = '모든 밴드 초기화';
            modalResetBtn.style.alignSelf = 'center';
            modalResetBtn.onclick = () => {
            const defaultSettings = CONFIG.DEFAULT_MULTIBAND_COMP_SETTINGS;
            for (const bandKey of Object.keys(bandInfo)) {
                for (const [paramKey, paramValue] of Object.entries(defaultSettings[bandKey])) {
                    this.stateManager.set(`audio.multibandComp.${bandKey}.${paramKey}`, paramValue);
                }
            }
            };

            container.append(header, bandsContainer, modalResetBtn);
            modal.appendChild(container);
            this.modalShadowRoot.appendChild(modal);
        }

        _updateVolumeControlsState() {
            if (!this.shadowRoot) return;

            const isAuto = this.stateManager.get('audio.isLoudnessNormalizationEnabled');
            const isManual = this.stateManager.get('audio.isPreGainEnabled');

            const manualVolBtn = this.uiElements.manualVolBtn;
            const preGainSlider = this.uiElements.preGainSlider;

            if (manualVolBtn) manualVolBtn.disabled = isAuto;
            if (preGainSlider) preGainSlider.disabled = isAuto || !isManual;
        }


        async applyPreset(presetKey) {
            const isAgcEnabled = this.stateManager.get('audio.isAgcEnabled');

            if (!isAgcEnabled || !this.audioFXPlugin) {
                this._applyPresetSettings(presetKey);
                if (this.audioFXPlugin) {
                    this.stateManager.set('audio.activityCheckRequested', Date.now());
                }
                return;
            }

            try {
                const rmsBefore = await this.audioFXPlugin._getInstantRMS();
                this._applyPresetSettings(presetKey);

                await new Promise(resolve => setTimeout(resolve, CONFIG.UI_AGC_APPLY_DELAY));

                const rmsAfter = await this.audioFXPlugin._getInstantRMS();

                if (rmsBefore > 0.001 && rmsAfter > 0.001) {
                    const ratio = rmsBefore / rmsAfter;
                    const currentPreGain = this.stateManager.get('audio.preGain');
                    let compensatedGain = currentPreGain * ratio;
                    compensatedGain = Math.max(0.1, Math.min(compensatedGain, 4.0));

                    this.stateManager.set('audio.preGain', compensatedGain);
                    this.stateManager.set('audio.lastManualPreGain', compensatedGain);
                }
            } catch (error) {
                console.error("[VSC] Error applying preset with AGC:", error);
            } finally {
                this.stateManager.set('audio.activityCheckRequested', Date.now());
            }
        }


        _applyPresetSettings(presetKey) {
            const p = this.presetMap[presetKey];
            if (!p) return;

            this.stateManager.set('audio.audioInitialized', true);

            const newTargetLUFS = p.targetLUFS ?? CONFIG.LOUDNESS_TARGET;
            this.stateManager.set('audio.loudnessTarget', newTargetLUFS);

            const defaults = {
                isHpfEnabled: false, hpfHz: CONFIG.EFFECTS_HPF_FREQUENCY,
                isEqEnabled: false, eqSubBassGain: 0, eqBassGain: 0, eqMidGain: 0, eqTrebleGain: 0, eqPresenceGain: 0,
                bassBoostGain: CONFIG.DEFAULT_BASS_BOOST_GAIN, bassBoostFreq: 60, bassBoostQ: 1.0,
                isWideningEnabled: false, wideningFactor: 1.0, isAdaptiveWidthEnabled: false, adaptiveWidthFreq: CONFIG.DEFAULT_ADAPTIVE_WIDTH_FREQ,
                isReverbEnabled: false, reverbMix: CONFIG.DEFAULT_REVERB_MIX, stereoPan: 0,
                isPreGainEnabled: false, preGain: 1.0, isDeesserEnabled: false, deesserThreshold: CONFIG.DEFAULT_DEESSER_THRESHOLD, deesserFreq: CONFIG.DEFAULT_DEESSER_FREQ,
                isExciterEnabled: false, exciterAmount: 0, isParallelCompEnabled: false, parallelCompMix: 0,
                isLimiterEnabled: false, isMasteringSuiteEnabled: false, masteringTransientAmount: 0.2, masteringDrive: 0,
                isLoudnessNormalizationEnabled: false,
                isMultibandCompEnabled: CONFIG.DEFAULT_MULTIBAND_COMP_ENABLED,
                isDynamicEqEnabled: false,
            };

            const presetValues = {
                isHpfEnabled: p.hpf_enabled ?? defaults.isHpfEnabled, hpfHz: p.hpf_hz ?? defaults.hpfHz,
                isEqEnabled: p.eq_enabled ?? defaults.isEqEnabled, eqSubBassGain: p.eq_subBass ?? defaults.eqSubBassGain,
                eqBassGain: p.eq_bass ?? defaults.eqBassGain, eqMidGain: p.eq_mid ?? defaults.eqMidGain,
                eqTrebleGain: p.eq_treble ?? defaults.eqTrebleGain, eqPresenceGain: p.eq_presence ?? defaults.eqPresenceGain,
                bassBoostGain: p.bass_boost_gain ?? defaults.bassBoostGain,
                isWideningEnabled: p.widen_enabled ?? defaults.isWideningEnabled, wideningFactor: p.widen_factor ?? defaults.wideningFactor,
                isAdaptiveWidthEnabled: p.adaptive_enabled ?? defaults.isAdaptiveWidthEnabled, adaptiveWidthFreq: p.adaptive_width_freq ?? defaults.adaptiveWidthFreq,
                isReverbEnabled: p.reverb_enabled ?? defaults.isReverbEnabled, reverbMix: p.reverb_mix ?? defaults.reverbMix, stereoPan: p.pan_value ?? defaults.stereoPan,
                isPreGainEnabled: p.preGain_enabled ?? defaults.isPreGainEnabled, preGain: p.preGain_value ?? defaults.preGain,
                isDeesserEnabled: p.deesser_enabled ?? defaults.isDeesserEnabled, deesserThreshold: p.deesser_threshold ?? defaults.deesserThreshold, deesserFreq: p.deesser_freq ?? defaults.deesserFreq,
                isExciterEnabled: p.exciter_enabled ?? defaults.isExciterEnabled, exciterAmount: p.exciter_amount ?? defaults.exciterAmount,
                isParallelCompEnabled: p.parallel_comp_enabled ?? defaults.isParallelCompEnabled, parallelCompMix: p.parallel_comp_mix ?? defaults.parallelCompMix,
                isLimiterEnabled: p.limiter_enabled ?? defaults.isLimiterEnabled,
                isMasteringSuiteEnabled: p.mastering_suite_enabled ?? defaults.isMasteringSuiteEnabled, masteringTransientAmount: p.mastering_transient ?? defaults.masteringTransientAmount, masteringDrive: p.mastering_drive ?? defaults.masteringDrive,
                isLoudnessNormalizationEnabled: p.isLoudnessNormalizationEnabled ?? (presetKey === 'default' ? false : this.stateManager.get('audio.isLoudnessNormalizationEnabled')),
                isMultibandCompEnabled: p.multiband_enabled ?? defaults.isMultibandCompEnabled,
                isDynamicEqEnabled: p.smartEQ_enabled ?? defaults.isDynamicEqEnabled,
            };

            if (presetKey === 'default') {
                presetValues.isAgcEnabled = true;
                presetValues.isPreGainEnabled = false;
            }

            const isAgcActive = this.stateManager.get('audio.isAgcEnabled') || this.stateManager.get('audio.isLoudnessNormalizationEnabled');

            for (const key in presetValues) {
                if (isAgcActive && (key === 'isPreGainEnabled' || key === 'preGain')) {
                    continue;
                }
                this.stateManager.set(`audio.${key}`, presetValues[key]);
            }

            if (p.multiband_bands && Array.isArray(p.multiband_bands) && p.multiband_bands.length === 4) {
                const bandKeys = ['low', 'lowMid', 'highMid', 'high'];
                p.multiband_bands.forEach((bandData, index) => {
                    const key = bandKeys[index];
                    const newSettings = {
                        crossover: bandData.freqHigh,
                        threshold: bandData.threshold,
                        ratio: bandData.ratio,
                        attack: bandData.attack / 1000,
                        release: bandData.release / 1000,
                        makeupGain: bandData.makeup,
                    };
                    for (const [param, value] of Object.entries(newSettings)) {
                         this.stateManager.set(`audio.multibandComp.${key}.${param}`, value);
                    }
                });
            } else if (presetKey === 'default') {
                const defaultSettings = JSON.parse(JSON.stringify(CONFIG.DEFAULT_MULTIBAND_COMP_SETTINGS));
                for (const [key, settings] of Object.entries(defaultSettings)) {
                    for (const [param, value] of Object.entries(settings)) {
                        this.stateManager.set(`audio.multibandComp.${key}.${param}`, value);
                    }
                }
            }

            // [BUG FIX] Apply smartEQ_bands from preset to the state
            if (p.smartEQ_bands && Array.isArray(p.smartEQ_bands) && p.smartEQ_bands.length === 4) {
                const newBands = p.smartEQ_bands.map(band => ({
                    freq: band.frequency, // Map preset key 'frequency' to state key 'freq'
                    q: band.Q,            // Map preset key 'Q' to state key 'q'
                    threshold: band.threshold,
                    gain: band.gain
                }));
                this.stateManager.set('audio.dynamicEq.bands', newBands);
            }


            if (!isAgcActive) {
                this.stateManager.set('audio.lastManualPreGain', presetValues.preGain);
            }

            this.stateManager.set('audio.activePresetKey', presetKey);
        }

        attachDragAndDrop() {
            let pressTimer = null;

            const isInteractiveTarget = (e) => {
                for (const element of e.composedPath()) {
                    if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(element.tagName)) {
                        return true;
                    }
                }
                return false;
            };

            const onDragStart = (e) => {
                if (isInteractiveTarget(e)) return;

                pressTimer = setTimeout(() => {
                    if (this.globalContainer) this.globalContainer.style.display = 'none';
                    onDragEnd();
                }, 800);

                const pos = e.touches ? e.touches[0] : e;
                this.startPos = { x: pos.clientX, y: pos.clientY };
                const initialX = parseFloat(this.globalContainer.style.getPropertyValue('--vsc-translate-x')) || 0;
                const initialY = parseFloat(this.globalContainer.style.getPropertyValue('--vsc-translate-y')) || 0;
                this.currentPos = { x: initialX, y: initialY };

                this.isDragging = true;
                this.wasDragged = false;
                this.globalContainer.style.transition = 'none';

                document.addEventListener('mousemove', onDragMove, { passive: false });
                document.addEventListener('mouseup', onDragEnd, { passive: true });
                document.addEventListener('touchmove', onDragMove, { passive: false });
                document.addEventListener('touchend', onDragEnd, { passive: true });
            };

            const updatePosition = () => {
                if (!this.isDragging || !this.globalContainer) return;
                const newX = this.currentPos.x + this.delta.x;
                const newY = this.currentPos.y + this.delta.y;
                this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`);
                this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`);
                this.animationFrameId = null;
            };

            const onDragMove = (e) => {
                if (!this.isDragging) return;

                const pos = e.touches ? e.touches[0] : e;
                this.delta = { x: pos.clientX - this.startPos.x, y: pos.clientY - this.startPos.y };

                if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI_DRAG_THRESHOLD)) {
                    this.wasDragged = true;
                    clearTimeout(pressTimer);
                    if (e.cancelable) e.preventDefault();
                }

                if (this.wasDragged && this.animationFrameId === null) {
                    this.animationFrameId = requestAnimationFrame(updatePosition);
                }
            };

            const onDragEnd = () => {
                clearTimeout(pressTimer);
                if (!this.isDragging) return;

                if (this.animationFrameId) {
                    cancelAnimationFrame(this.animationFrameId);
                    this.animationFrameId = null;
                }

                if (this.wasDragged) {
                   this.currentPos.x += this.delta.x;
                   this.currentPos.y += this.delta.y;
                }

                this.isDragging = false;
                this.globalContainer.style.transition = '';

                document.removeEventListener('mousemove', onDragMove);
                document.removeEventListener('mouseup', onDragEnd);
                document.removeEventListener('touchmove', onDragMove);
                document.removeEventListener('touchend', onDragEnd);

                setTimeout(() => { this.wasDragged = false; }, 50);
            };

            this.triggerElement.addEventListener('mousedown', onDragStart);
            this.triggerElement.addEventListener('touchstart', onDragStart, { passive: false });
        }
    }

    // --- [ARCHITECTURE] SCRIPT INITIALIZATION ---
    function main() {
        const stateManager = new StateManager();
        const pluginManager = new PluginManager(stateManager);

        window.vscPluginManager = pluginManager;

        pluginManager.register(new UIPlugin());
        pluginManager.register(new CoreMediaPlugin());
        pluginManager.register(new SvgFilterPlugin());
        pluginManager.register(new AudioFXPlugin());
        pluginManager.register(new PlaybackControlPlugin());
        pluginManager.register(new LiveStreamPlugin());
        pluginManager.register(new MediaSessionPlugin());
        pluginManager.register(new NavigationPlugin(pluginManager));

        pluginManager.initAll();
    }

    // --- SCRIPT ENTRY POINT ---
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', main);
    } else {
        main();
    }

})();
