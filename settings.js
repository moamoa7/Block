// ==UserScript==
// @name         Video_Image_Control (Final & Fixed)
// @namespace    https://com/
// @version      98.3
// @description  오디오 프리셋 조정
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
        AUTODELAY_PID_KD: 0.0001, AUTODELAY_MIN_RATE: 1.0, AUTODELAY_MAX_RATE: 1.05, LIVE_JUMP_INTERVAL: 6000,
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
        TARGET_DELAYS: {"play.sooplive.co.kr": 2000, "chzzk.naver.com": 2000, "ok.ru": 2000 }, DEFAULT_TARGET_DELAY: 2500,
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
                    isAnalyzingLoudness: false, isDeesserEnabled: CONFIG.DEFAULT_DEESSER_ENABLED,
                    deesserThreshold: CONFIG.DEFAULT_DEESSER_THRESHOLD, deesserFreq: CONFIG.DEFAULT_DEESSER_FREQ,
                    isExciterEnabled: CONFIG.DEFAULT_EXCITER_ENABLED, exciterAmount: CONFIG.DEFAULT_EXCITER_AMOUNT,
                    isParallelCompEnabled: CONFIG.DEFAULT_PARALLEL_COMP_ENABLED, parallelCompMix: CONFIG.DEFAULT_PARALLEL_COMP_MIX,
                    isLimiterEnabled: CONFIG.DEFAULT_LIMITER_ENABLED, isMasteringSuiteEnabled: CONFIG.DEFAULT_MASTERING_SUITE_ENABLED,
                    masteringTransientAmount: 0.2, masteringDrive: 0,
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
        }

        notify(key, newValue, oldValue) {
            if (this.listeners[key]) {
                this.listeners[key].forEach(callback => callback(newValue, oldValue));
            }
            const prefix = key.substring(0, key.lastIndexOf('.'));
            if (prefix && this.listeners[`${prefix}.*`]) {
                this.listeners[`${prefix}.*`].forEach(callback => callback(key, newValue, oldValue));
            }
        }
    }

    // --- [ARCHITECTURE] BASE PLUGIN CLASS ---
    class Plugin {
        constructor(name) {
            this.name = name;
            this.stateManager = null;
        }
        init(stateManager) { this.stateManager = stateManager; }
        destroy() {}
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
            this.debouncedScanTask = debounce(this.scanAndApply.bind(this), CONFIG.DEBOUNCE_DELAY);
        }

        init(stateManager) {
            super.init(stateManager);
            this.stateManager.subscribe('app.pluginsInitialized', () => {
                this.ensureObservers();
                this.scanAndApply();
                document.addEventListener('addShadowRoot', this.debouncedScanTask);
                if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
                this.maintenanceInterval = setInterval(() => this.scanAndApply(), 2500);
            });
        }

        destroy() {
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

            this.stateManager.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.stateManager.subscribe('imageFilter.level', this.applyAllImageFilters.bind(this));
            this.stateManager.subscribe('media.visibilityChange', () => this.updateMediaFilterStates());
            this.stateManager.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates());

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
        }

        init(stateManager) {
            super.init(stateManager);
            this.stateManager.subscribe('audio.*', debounce(() => this.applyAudioEffectsToAllMedia(), 50));
            this.stateManager.subscribe('media.activeMedia', (newMediaSet, oldMediaSet) => {
                const added = [...newMediaSet].filter(x => !oldMediaSet.has(x));
                const removed = [...oldMediaSet].filter(x => !newMediaSet.has(x));
                if (this.stateManager.get('audio.audioInitialized')) {
                    added.forEach(media => this.ensureContextResumed(media));
                }
                removed.forEach(media => this.cleanupForMedia(media));
            });
            this.stateManager.subscribe('audio.audioInitialized', (isInitialized) => {
                if (isInitialized) {
                    const currentMedia = this.stateManager.get('media.activeMedia');
                    currentMedia.forEach(media => this.ensureContextResumed(media));
                }
            });

            // ▼▼▼ [수정] 'his' -> 'this' 로 변경 ▼▼▼
            this.stateManager.subscribe('audio.activityCheckRequested', () => {
                // 현재 활성화된 모든 미디어에 대해 오디오 활동 검사를 다시 실행합니다.
                this.stateManager.get('media.activeMedia').forEach(media => {
                    const nodes = this.stateManager.get('audio.audioContextMap').get(media);
                    if (nodes) {
                        // 기존 검사 상태를 초기화하여 checkAudioActivity가 다시 실행될 수 있도록 합니다.
                        this.audioActivityStatus.delete(media);
                        this.checkAudioActivity(media, nodes);
                        console.log('[VSC] Audio activity re-check requested.', media);
                    }
                });
            });

        }

        destroy() {
            this.stateManager.get('media.activeMedia').forEach(media => this.cleanupForMedia(media));
        }

        applyAudioEffectsToAllMedia() {
            if (!this.stateManager.get('audio.audioInitialized')) return;
            const sm = this.stateManager;
            const mediaToAffect = sm.get('app.isMobile') && sm.get('media.currentlyVisibleMedia') ?
                [sm.get('media.currentlyVisibleMedia')] : Array.from(sm.get('media.activeMedia'));
            mediaToAffect.forEach(media => {
                if(media) this.reconnectGraph(media)
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
            const nodes = { context, source, stereoPanner: context.createStereoPanner(), masterGain: context.createGain(), analyser: context.createAnalyser(), safetyLimiter: context.createDynamicsCompressor(), cumulativeLUFS: 0, lufsSampleCount: 0, band1_SubBass: context.createBiquadFilter(), band2_Bass: context.createBiquadFilter(), band3_Mid: context.createBiquadFilter(), band4_Treble: context.createBiquadFilter(), band5_Presence: context.createBiquadFilter(), gain1_SubBass: context.createGain(), gain2_Bass: context.createGain(), gain3_Mid: context.createGain(), gain4_Treble: context.createGain(), gain5_Presence: context.createGain(), merger: context.createGain(), reverbConvolver: context.createConvolver(), reverbWetGain: context.createGain(), reverbSum: context.createGain(), deesserBand: context.createBiquadFilter(), deesserCompressor: context.createDynamicsCompressor(), exciterHPF: context.createBiquadFilter(), exciter: context.createWaveShaper(), exciterPostGain: context.createGain(), parallelCompressor: context.createDynamicsCompressor(), parallelDry: context.createGain(), parallelWet: context.createGain(), limiter: context.createDynamicsCompressor(), masteringTransientShaper: context.createWaveShaper(), masteringLimiter1: context.createDynamicsCompressor(), masteringLimiter2: context.createDynamicsCompressor(), masteringLimiter3: context.createDynamicsCompressor() };
            try { nodes.reverbConvolver.buffer = this.createImpulseResponse(context); } catch (e) { console.error("[VSC] Failed to create reverb impulse response.", e); }
            nodes.safetyLimiter.threshold.value = -0.5; nodes.safetyLimiter.knee.value = 0; nodes.safetyLimiter.ratio.value = 20; nodes.safetyLimiter.attack.value = 0.001; nodes.safetyLimiter.release.value = 0.05;
            nodes.analyser.fftSize = 256;
            nodes.band1_SubBass.type = "lowpass"; nodes.band1_SubBass.frequency.value = 80; nodes.band2_Bass.type = "bandpass"; nodes.band2_Bass.frequency.value = 150; nodes.band2_Bass.Q.value = 1; nodes.band3_Mid.type = "bandpass"; nodes.band3_Mid.frequency.value = 1000; nodes.band3_Mid.Q.value = 1; nodes.band4_Treble.type = "bandpass"; nodes.band4_Treble.frequency.value = 4000; nodes.band4_Treble.Q.value = 1; nodes.band5_Presence.type = "highpass"; nodes.band5_Presence.frequency.value = 8000;
            this.stateManager.get('audio.audioContextMap').set(media, nodes);

            nodes.source.connect(nodes.masterGain);
            nodes.masterGain.connect(nodes.safetyLimiter);
            nodes.safetyLimiter.connect(nodes.analyser);
            nodes.safetyLimiter.connect(nodes.context.destination);
            return nodes;
        }

        reconnectGraph(media) {
            const nodes = this.stateManager.get('audio.audioContextMap').get(media);
            if (!nodes) return;
            const audioState = this.stateManager.get('audio');

            safeExec(() => {
                Object.values(nodes).forEach(node => { if (node && typeof node.disconnect === 'function' && node !== nodes.context) { try { node.disconnect(); } catch (e) { /* Ignore */ } } });
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

                if (audioState.isHpfEnabled) {
                    if (!nodes.hpf) nodes.hpf = nodes.context.createBiquadFilter();
                    nodes.hpf.type = 'highpass'; nodes.hpf.frequency.value = audioState.hpfHz;
                    lastNode = lastNode.connect(nodes.hpf);
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
            }
            return newNodes;
        }

        cleanupForMedia(media) {
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
            this.stateManager.subscribe('liveStream.isRunning', (isRunning) => {
                if(isRunning) {
                    this.start();
                } else {
                    this.stop();
                }
            });
            this.stateManager.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge());
            this.stateManager.subscribe('liveStream.resetRequested', () => {
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

        destroy() { this.stop(); }

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

            // ▼▼▼ [수정] 딜레이가 목표치 이하면 1배속으로 고정, 초과하면 PID 제어로 따라가는 로직 ▼▼▼
            let newRate;
            if (this.avgDelay !== null && this.avgDelay <= targetDelay) {
                newRate = 1.0;
                // 1배속으로 고정될 때 PID 제어기의 누적 오차(Integral)와 직전 오차(Error)를 초기화하여
                // 나중에 딜레이가 발생했을 때 급격하게 배속이 변하는 것을 방지합니다.
                this.pidIntegral = 0;
                this.lastError = 0;
            } else {
                // 딜레이가 목표치를 초과한 경우에만 속도를 조절합니다.
                newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay);
            }

            // 계산된 newRate를 비디오에 적용합니다.
            if (Math.abs(this.video.playbackRate - newRate) > 0.001) {
                this.video.playbackRate = newRate;
            }
            // ▲▲▲ 여기까지 수정 ▲▲▲

            const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child');
            if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) {
                const isLiveNow = this.avgDelay < (CONFIG.DEFAULT_TARGET_DELAY + 500); // 목표 딜레이 + 0.5초 이내면 라이브로 간주
                liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080'; // 라이브면 빨간색, 아니면 회색
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
            this.stateManager.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate));
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
            this.stateManager.subscribe('media.activeMedia', () => this.updateSession());
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
            this.startPos = { x: 0, y: 0 }; this.translatePos = { x: 0, y: 0 };
            this.delayMeterEl = null;
this.presetMap = {
  'default': { name: '기본값 (모든 효과 꺼짐)' },

  'basic_clear': {
    name: '✔ 기본 개선 (명료)',
    hpf_enabled: true, hpf_hz: 70,
    eq_enabled: true, eq_mid: 1.5, eq_treble: 1.2, eq_presence: 1.8,
    preGain_enabled: true, preGain_value: 1,
    mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 1.5,
  },

  'movie_immersive': {
    name: '🎬 영화/드라마 (몰입감)',
    hpf_enabled: true, hpf_hz: 60,
    eq_enabled: true, eq_subBass: 0.8, eq_bass: 0.6, eq_mid: 1.5, eq_treble: 1.2, eq_presence: 1.1,
    widen_enabled: true, widen_factor: 1.4,
    deesser_enabled: true, deesser_threshold: -28,
    parallel_comp_enabled: true, parallel_comp_mix: 10,
    mastering_suite_enabled: true, mastering_transient: 0.2, mastering_drive: 1,
    preGain_enabled: true, preGain_value: 0.9,
  },

  'action_blockbuster': {
    name: '💥 액션 블록버스터 (타격감)',
    hpf_enabled: true, hpf_hz: 55,
    eq_enabled: true, eq_subBass: 1.3, eq_bass: 1.0, eq_mid: -1, eq_treble: 1.1, eq_presence: 1.5,
    widen_enabled: true, widen_factor: 1.4,
    parallel_comp_enabled: true, parallel_comp_mix: 15,
    mastering_suite_enabled: true, mastering_transient: 0.4, mastering_drive: 2,
  },

  'concert_hall': {
    name: '🏟️ 라이브 콘서트 (현장감)',
    hpf_enabled: true, hpf_hz: 70,
    eq_enabled: true, eq_subBass: 0.8, eq_bass: 0.9, eq_mid: 0.8, eq_treble: 1, eq_presence: 1.1,
    widen_enabled: true, widen_factor: 1.35,
    preGain_enabled: true, preGain_value: 1.1,
    reverb_enabled: true, reverb_mix: 0.4,
    mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 2,
  },

  'music_dynamic': {
    name: '🎶 음악 (다이나믹 & 펀치감)',
    hpf_enabled: true, hpf_hz: 45,
    eq_enabled: true, eq_subBass: 1.1, eq_bass: 1.1, eq_mid: 1, eq_treble: 1, eq_presence: 1.8,
    widen_enabled: true, widen_factor: 1.25,
    exciter_enabled: true, exciter_amount: 8,
    mastering_suite_enabled: true, mastering_transient: 0.3, mastering_drive: 2.5,
  },

  'mastering_balanced': {
    name: '🔥 밸런스 마스터링 (고음질)',
    hpf_enabled: true, hpf_hz: 50,
    eq_enabled: true, eq_treble: 1.1, eq_presence: 1,
    widen_enabled: true, widen_factor: 1.2,
    exciter_enabled: true, exciter_amount: 8,
    mastering_suite_enabled: true, mastering_transient: 0.25, mastering_drive: 3,
    preGain_enabled: true, preGain_value: 1.1,
  },

  'vocal_clarity_pro': {
    name: '🎙️ 목소리 명료 (강의/뉴스)',
    hpf_enabled: true, hpf_hz: 120,
    eq_enabled: true, eq_subBass: -1.5, eq_bass: -0.8, eq_mid: 2.5, eq_treble: 1.8, eq_presence: 2.3,
    preGain_enabled: true, preGain_value: 1.0,
    deesser_enabled: true, deesser_threshold: -32,
    parallel_comp_enabled: true, parallel_comp_mix: 10,
    mastering_suite_enabled: true, mastering_transient: 0.15, mastering_drive: 1.2,
  },

  'gaming_pro': {
    name: '🎮 게이밍 (사운드 플레이)',
    hpf_enabled: true, hpf_hz: 55,
    eq_enabled: true, eq_subBass: -0.5, eq_mid: 2, eq_treble: 1.8, eq_presence: 2.2,
    widen_enabled: true, widen_factor: 1.15,
    preGain_enabled: true, preGain_value: 1.1,
    mastering_suite_enabled: true, mastering_transient: 0.4, mastering_drive: 2,
  },
};

        }

        init(stateManager) {
            super.init(stateManager);

            this.stateManager.subscribe('ui.createRequested', () => {
                if (!this.globalContainer) {
                    this.createGlobalUI();
                    this.stateManager.set('ui.globalContainer', this.globalContainer);
                }
            });

            this.stateManager.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.stateManager.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.stateManager.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.stateManager.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            this.stateManager.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info));
            this.stateManager.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.stateManager.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());

            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));

            // Check for a message from a previous session (e.g., after CORS refresh)
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
            });
        }

        destroy() {
            if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; }
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
            const container = this.shadowRoot?.getElementById('vsc-main-container');
            if (container) {
                clearTimeout(this.fadeOutTimer);
                container.style.opacity = '1';
                this.fadeOutTimer = setTimeout(() => this.startFadeSequence(), 10000);
            }
        }

        startFadeSequence() {
            const container = this.shadowRoot?.getElementById('vsc-main-container');
            if (container) {
                container.querySelectorAll('.vsc-control-group.submenu-visible').forEach(g => g.classList.remove('submenu-visible'));
                container.style.opacity = '0.3';
            }
        }

        createGlobalUI() {
    // ▼▼▼ [수정] isMobile 변수를 함수 맨 위에서 한 번만 선언합니다. ▼▼▼
    const isMobile = this.stateManager.get('app.isMobile');

    // 1. 가장 바깥 컨테이너: 이제 가로 정렬(row) 역할을 합니다.
    this.globalContainer = document.createElement('div');
    Object.assign(this.globalContainer.style, {
        position: 'fixed',
        // isMobile을 사용하여 위치 분기
        top: isMobile ? '50%' : '50%',
        right: '1vmin',
        transform: 'translateY(-50%)',
        zIndex: CONFIG.MAX_Z_INDEX,
        display: 'flex',
        alignItems: 'flex-start',
        gap: '5px',
        WebkitTapHighlightColor: 'transparent'
    });

    // 2. 새로운 '메인 컨트롤' 컨테이너: 이 안에서 아이콘들이 세로로 정렬됩니다.
    this.mainControlsContainer = document.createElement('div');
    Object.assign(this.mainControlsContainer.style, {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '5px'
    });

    // 3. 닫기/번개 아이콘 생성
    this.triggerElement = document.createElement('div');
    this.triggerElement.textContent = '⚡';
    // isMobile 변수는 위에서 이미 선언했으므로 여기서는 사용만 합니다.
    Object.assign(this.triggerElement.style, {
        width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
        height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
        background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex',
        alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none',
        fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
        transition: 'box-shadow 0.3s ease-in-out',
        order: '1'
    });
    this.triggerElement.addEventListener('click', (e) => {
        if (this.wasDragged) { e.stopPropagation(); return; }
        const isVisible = this.stateManager.get('ui.areControlsVisible');
        this.stateManager.set('ui.areControlsVisible', !isVisible);
    });

    // 4. 배속 버튼 컨테이너 생성
    this.speedButtonsContainer = document.createElement('div');
    this.speedButtonsContainer.id = 'vsc-speed-buttons-container';
    this.speedButtonsContainer.style.cssText = `
        display:none; flex-direction:column; gap:5px; align-items:center;
        background: transparent;
        border-radius: 0px; padding: 0px;
    `;

    // 5. 최종 조립
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
            this.renderAllControls();
            this.mainControlsContainer.prepend(this.hostElement); // globalContainer -> mainControlsContainer
        }

        updateUIVisibility() {
            if (!this.shadowRoot) return;
            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            if(this.speedButtonsContainer) {
                 const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO');
                 this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none';
            }

            const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO');
            const hasAudio = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'AUDIO');
            const hasImage = this.stateManager.get('media.activeImages').size > 0;
            const hasAnyMedia = hasVideo || hasAudio;

            const setDisplay = (id, visible) => { const el = this.shadowRoot.getElementById(id); if (el) el.style.display = visible ? 'flex' : 'none'; };
            setDisplay('vsc-video-controls', hasVideo);
            setDisplay('vsc-image-controls', hasImage);
            setDisplay('vsc-stereo-controls', hasAnyMedia);
        }

        updateActiveSpeedButton(rate) {
    if (!this.speedButtonsContainer) return;
    this.speedButtonsContainer.querySelectorAll('button').forEach(b => {
        const speed = parseFloat(b.dataset.speed);
        if (speed) {
            const isActive = Math.abs(speed - rate) < 0.01;

            if (isActive) {
                // ▼▼▼ [수정] 활성화된 버튼을 빨간색 계열로 변경 ▼▼▼
                b.style.background = 'rgba(231, 76, 60, 0.9)'; // 진한 빨간색 배경
                b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset'; // 빨간색 그림자
            } else {
                // 비활성화된 버튼 스타일 (원래 파란색)
                b.style.background = 'rgba(52, 152, 219, 0.7)';
                b.style.boxShadow = '';
            }
        }
    });
}

            renderAllControls() {
    // --- [UI 개선] --- 기존 96.5 버전의 UI 레이아웃과 스타일을 적용합니다.
    const isMobile = this.stateManager.get('app.isMobile');
    const style = document.createElement('style');
    style.textContent = `
        :host { pointer-events: none; } * { pointer-events: auto; -webkit-tap-highlight-color: transparent; }
        #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; opacity: 0.3; transition: opacity 0.3s; }
        #vsc-main-container:hover { opacity: 1; }
        #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap:5px;}
        .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; background: rgba(0,0,0,0.7); border-radius: 8px; }
        .vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 50%; transform: translateY(-50%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.7); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '4px' : 'clamp(6px, 1vmin, 9px)'}; }
        #vsc-stereo-controls .vsc-submenu { width: ${isMobile ? '380px' : '520px'}; max-width: 90vw; }
        #vsc-video-controls .vsc-submenu { width: ${isMobile ? '280px' : '320px'}; max-width: 80vw; }
        #vsc-image-controls .vsc-submenu { width: 100px; }
        .vsc-control-group.submenu-visible .vsc-submenu { display: flex; }

        /* ▼▼▼ [수정] .vsc-btn 스타일을 원래대로 되돌립니다 ▼▼▼ */
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
        .vsc-button-group { display: flex; gap: 8px; width: 100%; flex-wrap: wrap; }
        .vsc-divider { border-top: 1px solid #444; margin: 8px 0; }
        .vsc-select { background: rgba(0,0,0,0.5); color: white; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); font-size: clamp(12px, 2.2vmin, 14px); width: 100%; box-sizing: border-box; }
        /* --- [UI 개선] 96.5버전 스타일 추가 --- */
        /* --- [UI 개선] 96.5버전 스타일 추가 --- */
    .vsc-button-group > .vsc-btn { flex: 1; }
    .vsc-mastering-row { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; border-top: 1px solid #444; padding-top: 8px; }

    /* ▼▼▼ [수정] 아래 2줄을 수정 및 추가합니다. ▼▼▼ */
    .vsc-mastering-row > .vsc-btn { flex: 1; }
    .vsc-mastering-row > .slider-control { flex: 1; }
    /* ▲▲▲ 여기까지 ▲▲▲ */
    `;
    this.shadowRoot.appendChild(style);

    const mainContainer = document.createElement('div');
    mainContainer.id = 'vsc-main-container';

    const controlsContainer = document.createElement('div');
    controlsContainer.id = 'vsc-controls-container';

    const createControlGroup = (id, icon, title, parent) => {
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
        return subMenu;
    };

    const createSlider = (label, id, min, max, step, stateKey, unit, formatFn) => {
        const div = document.createElement('div'); div.className = 'slider-control';
        const labelEl = document.createElement('label'); const span = document.createElement('span');
        const updateText = (v) => { const val = parseFloat(v); if(isNaN(val)) return; span.textContent = formatFn ? formatFn(val) : `${val.toFixed(1)}${unit}`; };
        labelEl.textContent = `${label}: `; labelEl.appendChild(span);
        const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step;
        slider.value = this.stateManager.get(stateKey);
        slider.oninput = () => { const val = parseFloat(slider.value); this.stateManager.set(stateKey, val); };
        this.stateManager.subscribe(stateKey, (val) => { updateText(val); if(slider.value != val) slider.value = val; });
        updateText(slider.value);
        div.append(labelEl, slider);
        return { control: div, slider: slider };
    };

    const createToggleBtn = (id, text, stateKey) => {
        const btn = document.createElement('button'); btn.id = id; btn.textContent = text; btn.className = 'vsc-btn';
        btn.onclick = () => { this.stateManager.set(stateKey, !this.stateManager.get(stateKey)); };
        this.stateManager.subscribe(stateKey, (val) => btn.classList.toggle('active', val));
        btn.classList.toggle('active', this.stateManager.get(stateKey));
        return btn;
    };

    const createDivider = () => { const d = document.createElement('div'); d.className = 'vsc-divider'; return d; };

    const imageSubMenu = createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controlsContainer);
    const imageSelect = document.createElement('select'); imageSelect.className = 'vsc-select';
    [{ v: "0", t: "꺼짐" }, ...Array.from({ length: 20 }, (_, i) => ({ v: (i + 1).toString(), t: `${i + 1}단계` }))].forEach(opt => {
        const o = document.createElement('option'); o.value = opt.v; o.textContent = opt.t; imageSelect.appendChild(o);
    });
    imageSelect.onchange = () => this.stateManager.set('imageFilter.level', parseInt(imageSelect.value, 10));
    this.stateManager.subscribe('imageFilter.level', (val) => imageSelect.value = val);
    imageSelect.value = this.stateManager.get('imageFilter.level');
    imageSubMenu.appendChild(imageSelect);

    const videoSubMenu = createControlGroup('vsc-video-controls', '✨', '영상 필터', controlsContainer);
    const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
    const videoResetBtn = document.createElement('button'); videoResetBtn.className = 'vsc-btn'; videoResetBtn.textContent = '초기화';
    videoResetBtn.style.marginTop = '8px';

    // ▼▼▼ [수정] 샤프 방향 선택 메뉴를 생성하는 코드입니다. ▼▼▼
// ... renderAllControls() 함수 내부 ...
const createSelectControl = (labelText, options, changeHandler) => {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.alignItems = 'center';       // 세로 가운데 정렬
    div.style.justifyContent = 'space-between';
    div.style.gap = '8px';                 // 글자와 선택상자 사이 간격

    const label = document.createElement('label');
    label.textContent = labelText + ':';
    label.style.color = 'white';
    label.style.fontSize = isMobile ? '12px' : '13px';
    label.style.whiteSpace = 'nowrap';     // 줄바꿈 방지

    const select = document.createElement('select');
    select.className = 'vsc-select';
    options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt.value; o.textContent = opt.text;
        select.appendChild(o);
    });
    select.onchange = e => changeHandler(e.target.value);

    div.append(label, select);
    return div;
};

const sharpenDirOptions = [
    { value: '4-way', text: '4방향 (기본)' },
    { value: '8-way', text: '8방향 (강함)' }
];
const sharpenDirSelect = createSelectControl(
    '샤프 방향',
    sharpenDirOptions,
    (value) => this.stateManager.set('videoFilter.sharpenDirection', value)
);
// ▲▲▲ 여기까지 ▲▲▲

    videoResetBtn.onclick = () => {
        this.stateManager.set('videoFilter.level', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL);
        this.stateManager.set('videoFilter.level2', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2);
        this.stateManager.set('videoFilter.saturation', parseInt(videoDefaults.SATURATION_VALUE, 10));
        this.stateManager.set('videoFilter.gamma', parseFloat(videoDefaults.GAMMA_VALUE));
        this.stateManager.set('videoFilter.blur', parseFloat(videoDefaults.BLUR_STD_DEVIATION));
        this.stateManager.set('videoFilter.shadows', parseInt(videoDefaults.SHADOWS_VALUE, 10));
        this.stateManager.set('videoFilter.highlights', parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10));
    };
    videoSubMenu.append(
        createSlider('샤프(윤곽)', 'v-sharpen1', 0, 20, 1, 'videoFilter.level', '단계', v => `${v.toFixed(0)}단계`).control,
        createSlider('샤프(디테일)', 'v-sharpen2', 0, 20, 1, 'videoFilter.level2', '단계', v => `${v.toFixed(0)}단계`).control,

      // ▼▼▼ [수정] 생성된 샤프 방향 선택 메뉴를 여기에 추가합니다. ▼▼▼
    sharpenDirSelect,

        createSlider('채도', 'v-saturation', 0, 200, 1, 'videoFilter.saturation', '%', v => `${v.toFixed(0)}%`).control,
        createSlider('감마', 'v-gamma', 0.5, 1.5, 0.01, 'videoFilter.gamma', '', v => v.toFixed(2)).control,
        createSlider('블러', 'v-blur', 0, 1, 0.05, 'videoFilter.blur', '', v => v.toFixed(2)).control,
        createSlider('대비', 'v-shadows', -50, 50, 1, 'videoFilter.shadows', '', v => v.toFixed(0)).control,
        createSlider('밝기', 'v-highlights', -50, 50, 1, 'videoFilter.highlights', '', v => v.toFixed(0)).control,
        videoResetBtn
    );

    const audioSubMenu = createControlGroup('vsc-stereo-controls', '🎧', '사운드 필터', controlsContainer);
    const audioGrid = document.createElement('div'); audioGrid.className = 'vsc-audio-grid';
    const col1 = document.createElement('div'); col1.className = 'vsc-audio-column';
    const col2 = document.createElement('div'); col2.className = 'vsc-audio-column';
    const col3 = document.createElement('div'); col3.className = 'vsc-audio-column';

    const eqSliders = [
        createSlider('초저음', 'eq-sub', -12, 12, 1, 'audio.eqSubBassGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
        createSlider('저음', 'eq-bass', -12, 12, 1, 'audio.eqBassGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
        createSlider('중음', 'eq-mid', -12, 12, 1, 'audio.eqMidGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
        createSlider('고음', 'eq-treble', -12, 12, 1, 'audio.eqTrebleGain', 'dB', v => `${v.toFixed(0)}dB`).slider,
        createSlider('초고음', 'eq-pres', -12, 12, 1, 'audio.eqPresenceGain', 'dB', v => `${v.toFixed(0)}dB`).slider
    ];

    const hpfSlider = createSlider('주파수', 'hpf-freq', 20, 500, 5, 'audio.hpfHz', 'Hz', v => `${v.toFixed(0)}Hz`).slider;
    col1.append(
        createToggleBtn('eq-toggle', 'EQ', 'audio.isEqEnabled'),
        ...eqSliders.map(s => s.parentElement),
        createDivider(),
        createSlider('베이스 부스트', 'bass-boost', 0, 9, 0.5, 'audio.bassBoostGain', 'dB', v => `${v.toFixed(1)}dB`).control,
        createDivider(),
        createToggleBtn('hpf-toggle', 'HPF', 'audio.isHpfEnabled'),
        hpfSlider.parentElement
    );

    const deesserSliders = [
        createSlider('강도', 'deesser-thresh', -60, 0, 1, 'audio.deesserThreshold', 'dB', v => `${v.toFixed(0)}dB`).slider,
        createSlider('주파수', 'deesser-freq', 4000, 12000, 100, 'audio.deesserFreq', 'kHz', v => `${(v/1000).toFixed(1)}kHz`).slider
    ];
    const exciterSlider = createSlider('강도', 'exciter-amount', 0, 100, 1, 'audio.exciterAmount', '%', v => `${v.toFixed(0)}%`).slider;
    const pcompSlider = createSlider('믹스', 'pcomp-mix', 0, 100, 1, 'audio.parallelCompMix', '%', v => `${v.toFixed(0)}%`).slider;
    col2.append(
        createToggleBtn('deesser-toggle', '디에서', 'audio.isDeesserEnabled'), ...deesserSliders.map(s=>s.parentElement),
        createDivider(),
        createToggleBtn('exciter-toggle', '익사이터', 'audio.isExciterEnabled'), exciterSlider.parentElement,
        createDivider(),
        createToggleBtn('pcomp-toggle', '업컴프', 'audio.isParallelCompEnabled'), pcompSlider.parentElement
    );

    const preGainGroup = document.createElement('div');
    preGainGroup.className = 'vsc-button-group';
    preGainGroup.append(createToggleBtn('pre-gain-toggle', '볼륨', 'audio.isPreGainEnabled'));
    const autoVolBtn = document.createElement('button'); autoVolBtn.className = 'vsc-btn'; autoVolBtn.textContent = '자동';
    preGainGroup.appendChild(autoVolBtn);

    const widenSlider = createSlider('강도', 'widen-factor', 0, 3, 0.1, 'audio.wideningFactor', 'x').slider;
    const reverbSlider = createSlider('울림', 'reverb-mix', 0, 1, 0.05, 'audio.reverbMix', '', v => v.toFixed(2)).slider;
    const preGainSlider = createSlider('볼륨 크기', 'pre-gain-slider', 0, 4, 0.1, 'audio.preGain', 'x', v => v.toFixed(1)).slider;
    col3.append(
        createToggleBtn('widen-toggle', 'Virtualizer', 'audio.isWideningEnabled'), widenSlider.parentElement,
        createToggleBtn('adaptive-width-toggle', 'Bass Mono', 'audio.isAdaptiveWidthEnabled'),
        createDivider(),
        createToggleBtn('reverb-toggle', '리버브', 'audio.isReverbEnabled'), reverbSlider.parentElement,
        createDivider(),
        createSlider('Pan', 'pan', -1, 1, 0.1, 'audio.stereoPan', '', v => v.toFixed(1)).control,
        createDivider(),
        preGainGroup, preGainSlider.parentElement
    );

    const masteringContainer = document.createElement('div');
    masteringContainer.className = 'vsc-mastering-row';
    const masteringToggleBtn = createToggleBtn('mastering-toggle', '마스터링', 'audio.isMasteringSuiteEnabled');
    masteringToggleBtn.addEventListener('click', () => { this.stateManager.set('audio.isLimiterEnabled', false); });
    const transientSliderObj = createSlider('타격감', 'master-transient', 0, 100, 1, 'audio.masteringTransientAmount', '%', v => `${(v * 100).toFixed(0)}%`);
    const driveSliderObj = createSlider('음압', 'master-drive', 0, 12, 0.5, 'audio.masteringDrive', 'dB', v => `${v.toFixed(1)}dB`);
    masteringContainer.append(masteringToggleBtn, transientSliderObj.control, driveSliderObj.control);

    this.stateManager.subscribe('audio.masteringTransientAmount', val => {
        const slider = this.shadowRoot.getElementById('master-transient');
        const newSliderVal = val * 100;
        if (slider && slider.value != newSliderVal) slider.value = newSliderVal;
    });
    transientSliderObj.slider.oninput = (e) => this.stateManager.set('audio.masteringTransientAmount', parseFloat(e.target.value) / 100);

    const bottomControls = document.createElement('div');
    bottomControls.style.cssText = 'grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 1px solid #444; padding-top: 8px;';
    const presetSelect = document.createElement('select'); presetSelect.className = 'vsc-select';
    Object.entries(this.presetMap).forEach(([key, val]) => {
        const opt = document.createElement('option');
        opt.value = key; opt.textContent = val.name;
        presetSelect.appendChild(opt);
    });
    presetSelect.onchange = (e) => {
        this.applyPreset(e.target.value);
        this.stateManager.set('audio.activityCheckRequested', Date.now());
    };
    const resetBtn = document.createElement('button'); resetBtn.className = 'vsc-btn'; resetBtn.textContent = '초기화';
    resetBtn.onclick = () => {
        this.applyPreset('default');
        presetSelect.value = 'default';
        this.stateManager.set('audio.activityCheckRequested', Date.now());
    };
    bottomControls.append(presetSelect, resetBtn);
    audioGrid.append(col1, col2, col3, masteringContainer, bottomControls);
    audioSubMenu.appendChild(audioGrid);

    const setupSliderToggle = (stateKey, sliders) => {
        const update = (isEnabled) => sliders.forEach(s => { if(s) s.disabled = !isEnabled; });
        this.stateManager.subscribe(stateKey, update);
        update(this.stateManager.get(stateKey));
    };
    setupSliderToggle('audio.isEqEnabled', eqSliders);
    setupSliderToggle('audio.isDeesserEnabled', deesserSliders);
    setupSliderToggle('audio.isExciterEnabled', [exciterSlider]);
    setupSliderToggle('audio.isParallelCompEnabled', [pcompSlider]);
    setupSliderToggle('audio.isWideningEnabled', [widenSlider]);
    setupSliderToggle('audio.isReverbEnabled', [reverbSlider]);
    setupSliderToggle('audio.isPreGainEnabled', [preGainSlider]);
    setupSliderToggle('audio.isHpfEnabled', [hpfSlider]);
    setupSliderToggle('audio.isMasteringSuiteEnabled', [transientSliderObj.slider, driveSliderObj.slider]);

    while (this.speedButtonsContainer.firstChild) {
        this.speedButtonsContainer.removeChild(this.speedButtonsContainer.lastChild);
    }
    CONFIG.SPEED_PRESETS.forEach(speed => {
        const btn = document.createElement('button');
        btn.textContent = `${speed.toFixed(1)}x`;
        btn.dataset.speed = speed;
        btn.className = 'vsc-btn';

        // ▼▼▼ [수정] 배속 버튼에만 개별적으로 큰 크기와 파란 배경을 적용합니다 ▼▼▼
        Object.assign(btn.style, {
            background: 'rgba(52, 152, 219, 0.7)',
            color: 'white',
            width: 'clamp(30px, 6vmin, 40px)',
            height: 'clamp(20px, 4vmin, 30px)',
            fontSize: 'clamp(12px, 2vmin, 14px)',
            padding: '0'
        });

        btn.onclick = () => this.stateManager.set('playback.targetRate', speed);
        this.speedButtonsContainer.appendChild(btn);
    });
    if (CONFIG.LIVE_JUMP_WHITELIST.some(d => location.hostname.includes(d))) {
        const liveJumpBtn = document.createElement('button');
        liveJumpBtn.textContent = '⚡';
        liveJumpBtn.title = '실시간으로 이동';
        liveJumpBtn.className = 'vsc-btn';

        // ▼▼▼ [수정] 실시간 이동 버튼에도 개별적으로 큰 크기를 적용합니다 ▼▼▼
        Object.assign(liveJumpBtn.style, {
            width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
            height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
            fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
            borderRadius: '50%',
            padding: '0'
        });

        liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now());
        this.speedButtonsContainer.appendChild(liveJumpBtn);
    }

    mainContainer.appendChild(controlsContainer);
    this.shadowRoot.appendChild(mainContainer);
    this.updateActiveSpeedButton(this.stateManager.get('playback.currentRate'));
}

        applyPreset(presetKey) {
    const p = this.presetMap[presetKey];
    if (!p) return;

    this.stateManager.set('audio.audioInitialized', true);

    const defaults = {
        isHpfEnabled: false, hpfHz: CONFIG.EFFECTS_HPF_FREQUENCY,
        isEqEnabled: false, eqSubBassGain: 0, eqBassGain: 0, eqMidGain: 0, eqTrebleGain: 0, eqPresenceGain: 0,
        bassBoostGain: CONFIG.DEFAULT_BASS_BOOST_GAIN, bassBoostFreq: 60, bassBoostQ: 1.0,
        isWideningEnabled: false, wideningFactor: 1.0, isAdaptiveWidthEnabled: false, adaptiveWidthFreq: CONFIG.DEFAULT_ADAPTIVE_WIDTH_FREQ,
        isReverbEnabled: false, reverbMix: CONFIG.DEFAULT_REVERB_MIX, stereoPan: 0,
        isPreGainEnabled: false, preGain: 1.0, isDeesserEnabled: false, deesserThreshold: CONFIG.DEFAULT_DEESSER_THRESHOLD, deesserFreq: CONFIG.DEFAULT_DEESSER_FREQ,
        isExciterEnabled: false, exciterAmount: 0, isParallelCompEnabled: false, parallelCompMix: 0,
        isLimiterEnabled: false, isMasteringSuiteEnabled: false, masteringTransientAmount: 0.2, masteringDrive: 0,
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
        isMasteringSuiteEnabled: p.mastering_suite_enabled ?? defaults.isMasteringSuiteEnabled, masteringTransientAmount: p.mastering_transient ?? defaults.masteringTransientAmount, masteringDrive: p.mastering_drive ?? defaults.masteringDrive
    };

    for (const key in presetValues) {
        this.stateManager.set(`audio.${key}`, presetValues[key]);
    }
    this.stateManager.set('audio.lastManualPreGain', presetValues.preGain);
}

        attachDragAndDrop() {
    // ▼▼▼ [수정] 롱 프레스 감지를 위한 변수를 추가합니다. ▼▼▼
    let pressTimer = null;

    const onDragStart = (e) => {
        const trueTarget = e.composedPath()[0];
        if (trueTarget.closest('button, select, input')) return;

        // ▼▼▼ [수정] 롱 프레스 타이머를 시작합니다. ▼▼▼
        // 800ms (0.8초) 동안 누르고 있으면 UI가 사라집니다.
        pressTimer = setTimeout(() => {
            if (this.globalContainer) {
                this.globalContainer.style.display = 'none'; // UI 숨기기
            }
            // 롱 프레스가 발동되면 드래그 로직을 중단합니다.
            onDragEnd();
        }, 800);
        // ▲▲▲ 여기까지 ▲▲▲

        this.isDragging = true; this.wasDragged = false;
        const pos = e.touches ? e.touches[0] : e;
        this.startPos = { x: pos.clientX, y: pos.clientY };
        this.globalContainer.style.transition = 'none';
        document.addEventListener('mousemove', onDragMove, { passive: false });
        document.addEventListener('mouseup', onDragEnd, { passive: true });
        document.addEventListener('touchmove', onDragMove, { passive: false });
        document.addEventListener('touchend', onDragEnd, { passive: true });
    };

    const onDragMove = (e) => {
        if (!this.isDragging) return;
        e.preventDefault();
        const pos = e.touches ? e.touches[0] : e;
        const dX = pos.clientX - this.startPos.x, dY = pos.clientY - this.startPos.y;
        if (!this.wasDragged && (Math.abs(dX) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(dY) > CONFIG.UI_DRAG_THRESHOLD)) {
             this.wasDragged = true;
             // ▼▼▼ [수정] 드래그가 시작되면 롱 프레스 타이머를 취소합니다. ▼▼▼
             clearTimeout(pressTimer);
        }
        this.globalContainer.style.transform = `translateY(-50%) translate(${this.translatePos.x + dX}px, ${this.translatePos.y + dY}px)`;
    };

    const onDragEnd = () => {
        // ▼▼▼ [수정] 마우스/터치를 떼면 무조건 롱 프레스 타이머를 취소합니다. ▼▼▼
        clearTimeout(pressTimer);

        if (!this.isDragging) return;
        this.isDragging = false;
        const transform = this.globalContainer.style.transform;
        const matches = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
        if (matches) { this.translatePos.x = parseFloat(matches[1]); this.translatePos.y = parseFloat(matches[2]); }
        this.globalContainer.style.transition = '';
        document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd);
        document.removeEventListener('touchmove', onDragMove); document.removeEventListener('touchend', onDragEnd);
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
