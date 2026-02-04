// ==UserScript==
// @name         Video_Image_Control (Smart Monitor / Optimized)
// @namespace    https://com/
// @version      113.13-Optimized
// @description  v113.13 감마값의 출처(Auto/Manual)를 모니터에 명시하여 혼동 방지 (불필요 로직 제거판)
// @match        *://*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;

    // --- [ARCHITECTURE] CONFIGURATION & CONSTANTS ---
    const CONFIG = {
        DEFAULT_VIDEO_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 7 : 5,
        DEFAULT_VIDEO_FILTER_LEVEL_2: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 3 : 2,
        DEFAULT_IMAGE_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 15 : 5,
        DEFAULT_SMART_LIMIT_LEVEL: 0,
        DEFAULT_AUTO_TONE_LEVEL: 0,
        DEBUG: false,

        // Auto Delay
        AUTODELAY_INTERVAL_NORMAL: 1000, AUTODELAY_INTERVAL_STABLE: 3000,
        AUTODELAY_STABLE_THRESHOLD: 100, AUTODELAY_STABLE_COUNT: 5,
        AUTODELAY_PID_KP: 0.0002, AUTODELAY_PID_KI: 0.00001, AUTODELAY_PID_KD: 0.0001,
        AUTODELAY_MIN_RATE: 1.0, AUTODELAY_MAX_RATE: 1.025,
        AUTODELAY_EMA_ALPHA: 0.2,
        MIN_BUFFER_HEALTH_SEC: 1.0,
        LIVE_JUMP_INTERVAL: 6000, LIVE_JUMP_END_THRESHOLD: 1.0,

        // General
        DEBOUNCE_DELAY: 300, THROTTLE_DELAY: 100, MAX_Z_INDEX: 2147483647,
        SEEK_TIME_PERCENT: 0.05, SEEK_TIME_MAX_SEC: 15,
        IMAGE_MIN_SIZE: 355, VIDEO_MIN_SIZE: 0,
        SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2],
        UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_URLS: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com', 'stripchat.com', 'xhamsterlive.com', 'myavlive.com'],
        LIVE_JUMP_WHITELIST: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com', 'stripchat.com', 'xhamsterlive.com', 'myavlive.com'],

        // Filters
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: -7, DITHER_VALUE: 0, SMART_LIMIT: 0, AUTO_TONE: 0 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: -7, DITHER_VALUE: 0, SMART_LIMIT: 0, AUTO_TONE: 0 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: -7 },

        // [Optimized] SITE_METADATA_RULES Removed
        TARGET_DELAYS: { "play.sooplive.co.kr": 2500, "chzzk.naver.com": 2500, "ok.ru": 2500 }, DEFAULT_TARGET_DELAY: 3000,
        UI_HIDDEN_CLASS_NAME: 'vsc-hidden',
    };

    // --- UTILITY ---
    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) window.cancelIdleCallback(idleCallbackId); idleCallbackId = window.requestIdleCallback(task, { timeout: 1000 }); };

    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    // --- Shadow DOM Hook ---
    (function aggressiveShadowHook() {
        if (window._hasAggressiveHook_) return;
        try {
            const originalAttachShadow = Element.prototype.attachShadow;
            window._shadowDomList_ = window._shadowDomList_ || [];
            Element.prototype.attachShadow = function (init) {
                const shadowRoot = originalAttachShadow.call(this, init);
                try {
                    const cls = (this.className || '').toString();
                    const id = (this.id || '').toString();
                    if (cls.includes('turnstile') || id.includes('turnstile')) { return shadowRoot; }
                    shadowRoot._vsc_pending_injection = true;
                    window._shadowDomList_.push(shadowRoot);
                    document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: shadowRoot } }));
                } catch (e) { }
                return shadowRoot;
            };
            window._hasAggressiveHook_ = true;
        } catch (e) { console.warn("[VSC] Hooking Failed:", e); }
    })();

    // --- Video Analyzer (1x1 Pixel Optimized) ---
    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null,
        currentSettings: { smartLimit: 0, autoTone: 0 },
        currentSlope: 1.0, targetSlope: 1.0,
        currentAdaptiveGamma: 1.0, currentAdaptiveBright: 0, currentAdaptiveContrast: 0,
        frameSkipCounter: 0,

        init() {
            if (this.canvas) return;
            this.canvas = document.createElement('canvas');
            this.canvas.width = 1; this.canvas.height = 1; // 1x1 Optimized
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        },
        start(video, settings) {
            if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video;
            this.init();
            this.isRunning = true;
            this.loop();
        },
        stop() {
            this.isRunning = false;
            if (this.handle && this.targetVideo && 'cancelVideoFrameCallback' in this.targetVideo) {
                this.targetVideo.cancelVideoFrameCallback(this.handle);
            }
        },
        updateSettings(settings) {
            this.currentSettings = { ...this.currentSettings, ...settings };
            if (!this.isRunning && this.targetVideo) {
                this.isRunning = true;
                this.loop();
            }
        },
        loop() {
            if (!this.isRunning || !this.targetVideo) return;
            if ('requestVideoFrameCallback' in this.targetVideo) {
                this.handle = this.targetVideo.requestVideoFrameCallback(() => { this.processFrame(); this.loop(); });
            } else {
                this.processFrame(); setTimeout(() => this.loop(), 200);
            }
        },
        processFrame() {
            if (!this.targetVideo || this.targetVideo.paused || this.targetVideo.ended) return;

            this.frameSkipCounter++;
            if (this.frameSkipCounter < 10) return; // Skip frames for performance
            this.frameSkipCounter = 0;

            try {
                this.ctx.drawImage(this.targetVideo, 0, 0, 1, 1);
                const data = this.ctx.getImageData(0, 0, 1, 1).data;
                const avgLuma = (data[0] * 0.2126 + data[1] * 0.7152 + data[2] * 0.0722) / 255;

                if (this.currentSettings.smartLimit <= 0 && this.currentSettings.autoTone <= 0) {
                     this.currentSlope = 1.0;
                     this.currentAdaptiveGamma = 1.0;
                     this.currentAdaptiveBright = 0;
                     this.currentAdaptiveContrast = 0;
                     this.notifyUpdate(1.0, { gamma: 1.0, bright: 0, contrast: 0 }, avgLuma);
                     return;
                }

                const ceiling = (100 - this.currentSettings.smartLimit) / 100;
                let calcSlope = (avgLuma > ceiling && avgLuma > 0.01) ? (ceiling / avgLuma) : 1.0;
                this.targetSlope = Math.max(0, Math.min(1.0, calcSlope));

                let targetAdaptiveGamma = 1.0;
                let targetAdaptiveBright = 0;
                let targetAdaptiveContrast = 0;
                const toneStrength = (this.currentSettings.autoTone || 0) / 100;

                if (toneStrength > 0) {
                    if (avgLuma < 0.25) {
                        const factor = (0.25 - avgLuma) * 4;
                        targetAdaptiveGamma = 1.0 + (0.5 * factor * toneStrength);
                        targetAdaptiveBright = 15 * factor * toneStrength;
                        targetAdaptiveContrast = -15 * factor * toneStrength;
                    } else if (avgLuma > 0.65) {
                        const factor = (avgLuma - 0.65) * 2.8;
                        targetAdaptiveGamma = 1.0 - (0.15 * factor * toneStrength);
                        targetAdaptiveBright = -5 * factor * toneStrength;
                        targetAdaptiveContrast = 15 * factor * toneStrength;
                    }
                }

                const smooth = (curr, target) => {
                    const diff = target - curr;
                    return Math.abs(diff) > 0.01 ? curr + diff * 0.05 : curr;
                };

                this.currentSlope = smooth(this.currentSlope, this.targetSlope);
                this.currentAdaptiveGamma = smooth(this.currentAdaptiveGamma || 1.0, targetAdaptiveGamma);
                this.currentAdaptiveBright = smooth(this.currentAdaptiveBright || 0, targetAdaptiveBright);
                this.currentAdaptiveContrast = smooth(this.currentAdaptiveContrast || 0, targetAdaptiveContrast);

                this.notifyUpdate(this.currentSlope, {
                    gamma: this.currentAdaptiveGamma,
                    bright: this.currentAdaptiveBright,
                    contrast: this.currentAdaptiveContrast
                }, avgLuma);
            } catch (e) {}
        },
        notifyUpdate(slope, autoParams, luma) {
            document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', {
                detail: { slope, autoParams: autoParams || { gamma: 1.0, bright: 0, contrast: 0 }, luma: luma }
            }));
        }
    };

    class StateManager {
        constructor() {
            this.state = {};
            this.listeners = {};
            this.filterManagers = { video: null, image: null };
        }
        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            this.state = {
                app: { isInitialized: false, isMobile, scriptActive: false },
                media: { activeMedia: new Set(), processedMedia: new WeakSet(), activeImages: new Set(), processedImages: new WeakSet(), mediaListenerMap: new WeakMap(), currentlyVisibleMedia: null },
                videoFilter: {
                    lastActiveSettings: null,
                    level: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL,
                    level2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
                    gamma: parseFloat(videoDefaults.GAMMA_VALUE),
                    blur: parseFloat(videoDefaults.BLUR_STD_DEVIATION),
                    shadows: parseInt(videoDefaults.SHADOWS_VALUE, 10),
                    highlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10),
                    saturation: parseInt(videoDefaults.SATURATION_VALUE, 10),
                    colorTemp: parseInt(videoDefaults.COLORTEMP_VALUE || 0, 10),
                    dither: parseInt(videoDefaults.DITHER_VALUE || 0, 10),
                    smartLimit: CONFIG.DEFAULT_SMART_LIMIT_LEVEL,
                    autoTone: CONFIG.DEFAULT_AUTO_TONE_LEVEL,
                    activePreset: 'none'
                },
                imageFilter: {
                    lastActiveSettings: null,
                    level: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL,
                    colorTemp: parseInt(CONFIG.IMAGE_FILTER_SETTINGS.COLORTEMP_VALUE || 0, 10)
                },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, lastUrl: location.href, warningMessage: null },
                playback: { currentRate: 1.0, targetRate: 1.0, isLive: false, jumpToLiveRequested: 0 },
                liveStream: { delayInfo: null, isRunning: false, resetRequested: null },
                settings: { videoFilterLevel: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, videoFilterLevel2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2, imageFilterLevel: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, autoRefresh: true }
            };
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) {
            const keys = key.split('.'); let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) { if (obj === undefined) return; obj = obj[keys[i]]; }
            const finalKey = keys[keys.length - 1]; if (obj === undefined) return;
            if (obj[finalKey] !== value) { const oldValue = obj[finalKey]; obj[finalKey] = value; this.notify(key, value, oldValue); }
        }
        subscribe(key, callback) {
            if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback);
            return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); };
        }
        notify(key, newValue, oldValue) {
            if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue));
            let currentKey = key;
            while (currentKey.includes('.')) {
                const prefix = currentKey.substring(0, currentKey.lastIndexOf('.'));
                const wildcardKey = `${prefix}.*`;
                if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue));
                currentKey = prefix;
            }
        }
    }

    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    class PluginManager { constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; } register(plugin) { this.plugins.push(plugin); } initAll() { this.stateManager.init(); this.plugins.forEach(plugin => safeExec(() => plugin.init(this.stateManager), `Plugin ${plugin.name} init`)); this.stateManager.set('app.isInitialized', true); this.stateManager.set('app.pluginsInitialized', true); } destroyAll() { this.plugins.forEach(plugin => safeExec(() => plugin.destroy(), `Plugin ${plugin.name} destroy`)); this.stateManager.set('app.isInitialized', false); } }

    class CoreMediaPlugin extends Plugin {
        constructor() { super('CoreMedia'); this.mainObserver = null; this.intersectionObserver = null; this.maintenanceInterval = null; this.debouncedScanTask = debounce(this.scanAndApply.bind(this), CONFIG.DEBOUNCE_DELAY || 300); }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('app.pluginsInitialized', () => {
                this.ensureObservers(); this.scanAndApply();
                document.addEventListener('addShadowRoot', (e) => { this.scanAndApply(); });
                if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
                this.maintenanceInterval = setInterval(() => this.scanAndApply(), 1000);
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
            if (!this.mainObserver) { this.mainObserver = new MutationObserver(() => scheduleIdleTask(this.scanAndApply.bind(this))); const target = document.body || document.documentElement; this.mainObserver.observe(target, { childList: true, subtree: true }); }
            if (!this.intersectionObserver) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    let mostVisibleMedia = null; let maxRatio = -1;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        e.target.dataset.isVisible = String(isVisible);
                        if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') { this.stateManager.set('media.visibilityChange', { target: e.target, isVisible }); }
                        // [Optimized] Removed AUDIO check
                        if (isVisible && e.intersectionRatio > maxRatio && e.target.tagName === 'VIDEO') { maxRatio = e.intersectionRatio; mostVisibleMedia = e.target; }
                    });
                    if (mostVisibleMedia && mostVisibleMedia.tagName === 'VIDEO') {
                        VideoAnalyzer.start(mostVisibleMedia);
                    }
                    if (this.stateManager.get('app.isMobile')) { this.stateManager.set('media.currentlyVisibleMedia', mostVisibleMedia); }
                }, { root: null, rootMargin: '0px', threshold: [0, 0.01, 0.5, 1.0] });
            }
        }
        scanAndApply() { this._processElements(this.findAllMedia.bind(this), this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this), 'media.activeMedia'); this._processElements(this.findAllImages.bind(this), this.attachImageListeners.bind(this), this.detachImageListeners.bind(this), 'media.activeImages'); }
        _processElements(findAllFn, attachFn, detachFn, stateKey) {
            const allElements = findAllFn();
            if (allElements.length > 0 && !this.stateManager.get('ui.globalContainer')) { this.stateManager.set('ui.createRequested', true); }
            const activeSet = this.stateManager.get(stateKey); const oldElements = new Set(activeSet); const newActiveSet = new Set();
            allElements.forEach(el => { if (el.isConnected) { newActiveSet.add(el); attachFn(el); oldElements.delete(el); } });
            oldElements.forEach(detachFn);
            if (newActiveSet.size !== activeSet.size || ![...newActiveSet].every(el => activeSet.has(el))) { this.stateManager.set(stateKey, newActiveSet); }
        }
        findAllMedia(root = document) {
            let media = new Set(); const minSize = CONFIG.VIDEO_MIN_SIZE;
            // [Optimized] Removed AUDIO support
            const isValid = m => (m.offsetWidth >= minSize || m.offsetHeight >= minSize);
            root.querySelectorAll('video').forEach(m => isValid(m) && media.add(m));
            root.querySelectorAll('iframe').forEach(f => { try { if (f.src && f.src.includes('challenges.cloudflare.com')) return; if (f.contentDocument) { const frameMedia = this.findAllMedia(f.contentDocument); frameMedia.forEach(m => media.add(m)); } } catch (e) { } });
            (window._shadowDomList_ || []).forEach(shadowRoot => { try { shadowRoot.querySelectorAll('video').forEach(m => isValid(m) && media.add(m)); } catch (e) { } });
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false); let node;
            while (node = walker.nextNode()) { if (node.shadowRoot) { const shadowMedia = this.findAllMedia(node.shadowRoot); shadowMedia.forEach(m => media.add(m)); } }
            return [...media];
        }
        findAllImages(root = document) {
            let images = new Set(); const minSize = CONFIG.IMAGE_MIN_SIZE; const isValid = i => (i.naturalWidth > minSize && i.naturalHeight > minSize) || (i.offsetWidth > minSize && i.offsetHeight > minSize);
            root.querySelectorAll('img').forEach(i => isValid(i) && images.add(i));
            root.querySelectorAll('iframe').forEach(f => { try { if (f.src && f.src.includes('challenges.cloudflare.com')) return; if (f.contentDocument) { const frameImages = this.findAllImages(f.contentDocument); frameImages.forEach(i => images.add(i)); } } catch (e) { } });
            (window._shadowDomList_ || []).forEach(shadowRoot => { try { shadowRoot.querySelectorAll('img').forEach(i => isValid(i) && images.add(i)); } catch (e) { } });
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false); let node;
            while (node = walker.nextNode()) { if (node.shadowRoot) { const shadowImages = this.findAllImages(node.shadowRoot); shadowImages.forEach(i => images.add(i)); } }
            return [...images];
        }
        attachMediaListeners(media) {
            if (!media || this.stateManager.get('media.processedMedia').has(media) || !this.intersectionObserver) return;
            if (this.stateManager.filterManagers.video) { injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager); }
            const listeners = { play: () => this.stateManager.set('playback.currentRate', media.playbackRate), ratechange: () => this.stateManager.set('playback.currentRate', media.playbackRate), };
            for (const [evt, handler] of Object.entries(listeners)) { media.addEventListener(evt, handler); }
            this.stateManager.get('media.mediaListenerMap').set(media, listeners);
            this.stateManager.get('media.processedMedia').add(media);
            this.intersectionObserver.observe(media);
        }
        detachMediaListeners(media) {
            const listenerMap = this.stateManager.get('media.mediaListenerMap'); if (!listenerMap.has(media)) return;
            const listeners = listenerMap.get(media); for (const [evt, listener] of Object.entries(listeners)) { media.removeEventListener(evt, listener); }
            listenerMap.delete(media); if (this.intersectionObserver) this.intersectionObserver.unobserve(media);
        }
        attachImageListeners(image) {
            if (!image || this.stateManager.get('media.processedImages').has(image) || !this.intersectionObserver) return;
            if (this.stateManager.filterManagers.image) { injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager); }
            this.stateManager.get('media.processedImages').add(image); this.intersectionObserver.observe(image);
        }
        detachImageListeners(image) { if (!this.stateManager.get('media.processedImages').has(image)) return; if (this.intersectionObserver) this.intersectionObserver.unobserve(image); }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, contrast: 0 }; }
        init(stateManager) {
            super.init(stateManager);
            const isMobile = this.stateManager.get('app.isMobile');
            this.filterManager = this._createManager({
                settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS,
                svgId: 'vsc-video-svg-filters',
                styleId: 'vsc-video-styles',
                className: 'vsc-video-filter-active',
                isImage: false
            });
            this.imageFilterManager = this._createManager({
                settings: CONFIG.IMAGE_FILTER_SETTINGS,
                svgId: 'vsc-image-svg-filters',
                styleId: 'vsc-image-styles',
                className: 'vsc-image-filter-active',
                isImage: true
            });

            this.filterManager.init(); this.imageFilterManager.init();
            this.stateManager.filterManagers.video = this.filterManager; this.stateManager.filterManagers.image = this.imageFilterManager;

            this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO') injectFiltersIntoContext(media, this.filterManager, this.stateManager); });
            this.stateManager.get('media.activeImages').forEach(image => { injectFiltersIntoContext(image, this.imageFilterManager, this.stateManager); });

            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.subscribe('imageFilter.level', this.applyAllImageFilters.bind(this));
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates());
            this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates());
            this.subscribe('app.scriptActive', () => this.updateMediaFilterStates());

            document.addEventListener('vsc-smart-limit-update', (e) => {
                const { slope, autoParams } = e.detail;
                this.filterManager.updateSmartLimit(slope);
                const isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.002 || Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.1 || Math.abs(this.lastAutoParams.contrast - autoParams.contrast) > 0.1;
                if (isChanged) {
                    this.lastAutoParams = autoParams;
                    this.applyAllVideoFilters();
                }
            });

            this.applyAllVideoFilters(); this.applyAllImageFilters();
        }

        _createManager(options) {
            class SvgFilterManager {
                #isInitialized = false; #styleElement = null; #svgNode = null; #options;
                constructor(options) { this.#options = options; }
                isInitialized() { return this.#isInitialized; }
                getSvgNode() { return this.#svgNode; }
                getStyleNode() { return this.#styleElement; }

                init() {
                    if (this.#isInitialized) return;
                    safeExec(() => {
                        const { svgNode, styleElement } = this.#createElements();
                        this.#svgNode = svgNode; this.#styleElement = styleElement;
                        (document.head || document.documentElement).appendChild(styleElement);
                        (document.body || document.documentElement).appendChild(svgNode);
                        this.#isInitialized = true;
                    }, `${this.constructor.name}.init`);
                }

                #createElements() {
                    const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
                    const { settings, svgId, styleId, className, isImage } = this.#options;
                    const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`;

                    const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
                    const combinedFilter = createSvgElement('filter', { id: combinedFilterId, "color-interpolation-filters": "sRGB" });

                    const smartDim = createSvgElement('feComponentTransfer', { "data-vsc-id": "smart_dimming", in: "SourceGraphic", result: "dimmed_in" });
                    ['R', 'G', 'B'].forEach(c => smartDim.append(createSvgElement('feFunc' + c, { "data-vsc-id": "smart_dim_func", type: "linear", slope: "1", intercept: "0" })));

                    const blurNode = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur", in: "dimmed_in", stdDeviation: "0", result: "blur_for_sharpen" });
                    const compositeNode = createSvgElement('feComposite', { "data-vsc-id": "sharpen_composite", operator: "arithmetic", in: "dimmed_in", in2: "blur_for_sharpen", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_base" });
                    const erosion = createSvgElement('feMorphology', { "data-vsc-id": "halo_erode", operator: "erode", radius: "1", in: "dimmed_in", result: "eroded_source" });

                    let nextStageIn = "sharpened_base";

                    if (isImage) {
                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: nextStageIn, result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { type: "identity" }));
                        colorTemp.append(createSvgElement('feFuncG', { type: "identity" }));
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                        combinedFilter.append(smartDim, blurNode, compositeNode, erosion, colorTemp);
                    } else {
                        const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: nextStageIn, type: "saturate", values: (settings.SATURATION_VALUE / 100).toString(), result: "saturate_out" });
                        const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })));
                        const linear = createSvgElement('feComponentTransfer', { "data-vsc-id": "linear", in: "gamma_out", result: "linear_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'linear', slope: "1", intercept: "0" })));

                        const noise = createSvgElement('feTurbulence', { type: "turbulence", baseFrequency: "0.65", numOctaves: "2", stitchTiles: "stitch", result: "raw_noise" });
                        const ditherComposite = createSvgElement('feComposite', { "data-vsc-id": "dither_blend", operator: "arithmetic", in: "linear_out", in2: "raw_noise", k1: "0", k2: "1", k3: "0", k4: "0", result: "dither_out" });

                        const finalBlur = createSvgElement('feGaussianBlur', { "data-vsc-id": "final_blur", in: "dither_out", stdDeviation: settings.BLUR_STD_DEVIATION, result: "final_blur_out" });

                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "final_blur_out", result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { type: "identity" }));
                        colorTemp.append(createSvgElement('feFuncG', { type: "identity" }));
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));

                        combinedFilter.append(smartDim, blurNode, compositeNode, erosion, saturation, gamma, linear, noise, ditherComposite, finalBlur, colorTemp);
                    }

                    svg.append(combinedFilter);
                    const style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = `.${className} { filter: url(#${combinedFilterId}) !important; } .vsc-gpu-accelerated { transform: translateZ(0); } .vsc-btn.analyzing { box-shadow: 0 0 5px #f39c12, 0 0 10px #f39c12 inset !important; }`;
                    return { svgNode: svg, styleElement: style };
                }

                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const { saturation, gamma, blur, sharpenLevel, shadows, highlights, colorTemp, dither } = values;

                    const rootNodes = [this.#svgNode, ...document.querySelectorAll(`iframe`)].map(n => n.tagName === 'IFRAME' ? (n.contentDocument ? n.contentDocument.querySelector(`#${this.#options.svgId}`) : null) : n).filter(n => n);
                    (window._shadowDomList_ || []).forEach(r => { try { const s = r.querySelector(`#${this.#options.svgId}`); if (s) rootNodes.push(s); } catch (e) { } });

                    rootNodes.forEach(rootNode => {
                        if (!rootNode) return;
                        const setAttr = (sel, attr, val) => rootNode.querySelectorAll(sel).forEach(el => el.setAttribute(attr, val));

                        if (sharpenLevel !== undefined) {
                            const strength = sharpenLevel * 0.2;
                            if (strength <= 0) {
                                setAttr(`[data-vsc-id="sharpen_blur"]`, 'stdDeviation', "0");
                                setAttr(`[data-vsc-id="sharpen_composite"]`, 'k2', "1");
                                setAttr(`[data-vsc-id="sharpen_composite"]`, 'k3', "0");
                            } else {
                                setAttr(`[data-vsc-id="sharpen_blur"]`, 'stdDeviation', "0.5");
                                const k2 = 1 + strength;
                                const k3 = -strength;
                                setAttr(`[data-vsc-id="sharpen_composite"]`, 'k2', k2.toFixed(3));
                                setAttr(`[data-vsc-id="sharpen_composite"]`, 'k3', k3.toFixed(3));
                            }
                        }
                        if (saturation !== undefined) setAttr(`[data-vsc-id="saturate"]`, 'values', (saturation / 100).toString());
                        if (gamma !== undefined) { const exp = (1 / gamma).toString(); setAttr(`[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB`, 'exponent', exp); }
                        if (blur !== undefined) setAttr(`[data-vsc-id="final_blur"]`, 'stdDeviation', blur.toString());
                        if (shadows !== undefined || highlights !== undefined) {
                            const slope = (1 + (highlights ?? 0) / 100).toString();
                            const intercept = ((shadows ?? 0) / 200).toString();
                            setAttr(`[data-vsc-id="linear"] feFuncR, [data-vsc-id="linear"] feFuncG, [data-vsc-id="linear"] feFuncB`, 'slope', slope);
                            setAttr(`[data-vsc-id="linear"] feFuncR, [data-vsc-id="linear"] feFuncG, [data-vsc-id="linear"] feFuncB`, 'intercept', intercept);
                        }
                        if (colorTemp !== undefined) { const slope = 1 - (colorTemp / 200); setAttr(`[data-vsc-id="ct_blue"]`, 'slope', slope.toString()); }
                        if (dither !== undefined) { const k3 = (dither / 500).toString(); setAttr(`[data-vsc-id="dither_blend"]`, 'k3', k3); }
                    });
                }

                updateSmartLimit(slope) {
                    if (!this.isInitialized()) return;
                    const rootNodes = [this.#svgNode];
                    (window._shadowDomList_ || []).forEach(r => { try { const s = r.querySelector(`#${this.#options.svgId}`); if (s) rootNodes.push(s); } catch (e) { } });

                    rootNodes.forEach(rootNode => {
                        if (!rootNode) return;
                        rootNode.querySelectorAll(`[data-vsc-id="smart_dim_func"]`).forEach(el => el.setAttribute('slope', slope.toFixed(3)));
                    });
                }
            }
            return new SvgFilterManager(options);
        }

        applyAllVideoFilters() {
            if (!this.filterManager.isInitialized()) return;
            const vf = this.stateManager.get('videoFilter');
            const totalSharpen = (vf.level || 0) + (vf.level2 || 0) * 0.5;

            const autoGamma = this.lastAutoParams.gamma || 1.0;
            const finalGamma = vf.gamma * autoGamma;
            const finalHighlights = vf.highlights + (this.lastAutoParams.bright || 0);
            const finalShadows = vf.shadows + (this.lastAutoParams.contrast || 0);

            const values = { saturation: vf.saturation, gamma: finalGamma, blur: vf.blur, sharpenLevel: totalSharpen, shadows: finalShadows, highlights: finalHighlights, colorTemp: vf.colorTemp, dither: vf.dither };
            this.filterManager.updateFilterValues(values);
            VideoAnalyzer.updateSettings({ smartLimit: vf.smartLimit, autoTone: vf.autoTone });
            this.updateMediaFilterStates();
        }

        applyAllImageFilters() {
            if (!this.imageFilterManager.isInitialized()) return;
            const level = this.stateManager.get('imageFilter.level');
            const colorTemp = this.stateManager.get('imageFilter.colorTemp');
            const values = { sharpenLevel: level, colorTemp: colorTemp };
            this.imageFilterManager.updateFilterValues(values);
            this.updateMediaFilterStates();
        }

        updateMediaFilterStates() { this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO') this._updateVideoFilterState(media); }); this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); }); }

        _updateVideoFilterState(video) {
            const scriptActive = this.stateManager.get('app.scriptActive');
            const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.blur > 0 || vf.shadows !== 0 || vf.highlights !== 0 || vf.colorTemp !== 0 || vf.dither > 0 || vf.smartLimit > 0 || vf.autoTone > 0;
            const isActive = scriptActive && video.dataset.isVisible !== 'false' && shouldApply;
            if (isActive) { if (video.style.willChange !== 'filter, transform') video.style.willChange = 'filter, transform'; }
            else { if (video.style.willChange) video.style.willChange = ''; }
            video.classList.toggle('vsc-video-filter-active', isActive);
        }

        _updateImageFilterState(image) {
            const scriptActive = this.stateManager.get('app.scriptActive');
            const level = this.stateManager.get('imageFilter.level');
            const colorTemp = this.stateManager.get('imageFilter.colorTemp');
            const shouldApply = level > 0 || colorTemp !== 0;
            image.classList.toggle('vsc-image-filter-active', scriptActive && image.dataset.isVisible !== 'false' && shouldApply);
        }
    }

    function injectFiltersIntoContext(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        let root = element.getRootNode(); const ownerDoc = element.ownerDocument;
        if (root === document && element.parentElement) { const shadowRoots = window._shadowDomList_ || []; for (const sRoot of shadowRoots) { if (sRoot.contains(element)) { root = sRoot; break; } } }
        const attr = `data-vsc-filters-injected-${manager === (element.tagName.toUpperCase() === 'VIDEO' ? stateManager.filterManagers.video : stateManager.filterManagers.image) ? 'video' : 'image'}`;
        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode();
        if (!svgNode || !styleNode) return;
        if (ownerDoc !== document && ownerDoc.body && !ownerDoc.documentElement.hasAttribute(attr)) { ownerDoc.body.appendChild(svgNode.cloneNode(true)); ownerDoc.head.appendChild(styleNode.cloneNode(true)); ownerDoc.documentElement.setAttribute(attr, 'true'); }
        else if ((root instanceof ShadowRoot) && !root._vsc_filters_injected) { try { root.appendChild(styleNode.cloneNode(true)); root.appendChild(svgNode.cloneNode(true)); root._vsc_filters_injected = true; if (root.host) root.host.setAttribute(attr, 'true'); } catch (e) { } }
    }

    class LiveStreamPlugin extends Plugin {
        constructor() { super('LiveStream'); this.video = null; this.avgDelay = null; this.intervalId = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL; }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('liveStream.isRunning', (isRunning) => { if (isRunning) this.start(); else this.stop(); });
            this.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge());
            this.subscribe('liveStream.resetRequested', () => { if (this.stateManager.get('liveStream.isRunning')) { this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; console.log('[VSC] Live stream delay meter reset.'); } });
            if (CONFIG.LIVE_STREAM_URLS.some(d => location.href.includes(d))) this.stateManager.set('liveStream.isRunning', true);
        }
        destroy() { super.destroy(); this.stop(); }
        switchInterval(newInterval) { if (this.currentInterval === newInterval) return; clearInterval(this.intervalId); this.currentInterval = newInterval; this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        findVideo() { const visibleVideos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO' && m.dataset.isVisible === 'true'); if (visibleVideos.length === 0) return null; return visibleVideos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]; }
        calculateDelay(v) { if (!v) return null; if (typeof v.liveLatency === 'number' && v.liveLatency > 0) return v.liveLatency * 1000; if (v.buffered && v.buffered.length > 0) { try { const end = v.buffered.end(v.buffered.length - 1); if (v.currentTime > end) return 0; return Math.max(0, (end - v.currentTime) * 1000); } catch { return null; } } return null; }
        getSmoothPlaybackRate(currentDelay, targetDelay) { const error = currentDelay - targetDelay; this.pidIntegral += error; const derivative = error - this.lastError; this.lastError = error; let rateChange = CONFIG.AUTODELAY_PID_KP * error + CONFIG.AUTODELAY_PID_KI * this.pidIntegral + CONFIG.AUTODELAY_PID_KD * derivative; return Math.max(CONFIG.AUTODELAY_MIN_RATE, Math.min(1 + rateChange, CONFIG.AUTODELAY_MAX_RATE)); }
        checkAndAdjust() {
            this.video = this.findVideo();
            if (!this.video) return;
            const rawDelay = this.calculateDelay(this.video);
            if (rawDelay === null) { this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: null, rate: this.video.playbackRate }); return; }
            this.avgDelay = this.avgDelay === null ? rawDelay : CONFIG.AUTODELAY_EMA_ALPHA * rawDelay + (1 - CONFIG.AUTODELAY_EMA_ALPHA) * this.avgDelay;
            this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: rawDelay, rate: this.video.playbackRate });
            const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY;
            const error = this.avgDelay - targetDelay;
            if (Math.abs(error) < CONFIG.AUTODELAY_STABLE_THRESHOLD) this.consecutiveStableChecks++;
            else { this.consecutiveStableChecks = 0; if (this.isStable) { this.isStable = false; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_NORMAL); } }
            if (this.consecutiveStableChecks >= CONFIG.AUTODELAY_STABLE_COUNT && !this.isStable) { this.isStable = true; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_STABLE); }

            let newRate;
            const bufferHealth = (this.video.buffered && this.video.buffered.length) ? (this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime) : 10;
            if ((this.avgDelay !== null && this.avgDelay <= targetDelay) || bufferHealth < CONFIG.MIN_BUFFER_HEALTH_SEC) {
                newRate = 1.0; this.pidIntegral = 0; this.lastError = 0;
            } else {
                newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay);
            }
            if (Math.abs(this.video.playbackRate - newRate) > 0.001) { this.video.playbackRate = newRate; }

            const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child');
            if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { const isLiveNow = this.avgDelay !== null && this.avgDelay < (CONFIG.DEFAULT_TARGET_DELAY + 500); liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080'; }
        }
        start() { if (this.intervalId) return; setTimeout(() => { this.stateManager.set('liveStream.delayInfo', { raw: null, avg: null, rate: 1.0 }); }, 0); this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        stop() {
            if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
            const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child');
            if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { liveJumpBtn.style.boxShadow = ''; }
            this.stateManager.set('liveStream.delayInfo', null);
            this.video = null; this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL;
        }
        seekToLiveEdge() { const videos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO'); if (videos.length === 0) return; const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY; videos.forEach(v => { try { const seekableEnd = (v.seekable && v.seekable.length > 0) ? v.seekable.end(v.seekable.length - 1) : Infinity; const bufferedEnd = (v.buffered && v.buffered.length > 0) ? v.buffered.end(v.buffered.length - 1) : 0; const liveEdge = Math.min(seekableEnd, bufferedEnd); if (!isFinite(liveEdge)) return; const delayMs = (liveEdge - v.currentTime) * 1000; if (delayMs <= targetDelay) return; if (!v._lastLiveJump) v._lastLiveJump = 0; if (Date.now() - v._lastLiveJump < CONFIG.LIVE_JUMP_INTERVAL) return; if (liveEdge - v.currentTime < CONFIG.LIVE_JUMP_END_THRESHOLD) return; v._lastLiveJump = Date.now(); v.currentTime = liveEdge - 0.5; if (v.paused) v.play().catch(console.warn); } catch (e) { console.error('[VSC] seekToLiveEdge error:', e); } }); }
    }

    class PlaybackControlPlugin extends Plugin {
        init(stateManager) { super.init(stateManager); this.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate)); }
        setPlaybackRate(rate) { this.stateManager.get('media.activeMedia').forEach(media => { if (media.playbackRate !== rate) media.playbackRate = rate; }); }
    }

    // [Optimized] MediaSessionPlugin Removed

    class NavigationPlugin extends Plugin {
        constructor(pluginManager) { super('Navigation'); this.pluginManager = pluginManager; this.spaNavigationHandler = debounce(this.handleNavigation.bind(this), 500); this.urlCheckInterval = null; }
        init(stateManager) {
            super.init(stateManager);
            if(this.urlCheckInterval) clearInterval(this.urlCheckInterval);
            this.urlCheckInterval = setInterval(() => {
                const currentUrl = location.href;
                const lastUrl = this.stateManager.get('ui.lastUrl');
                if (currentUrl !== lastUrl) {
                    this.handleNavigation();
                }
            }, 500);
        }
        destroy() {
            super.destroy();
            if(this.urlCheckInterval) clearInterval(this.urlCheckInterval);
        }
        handleNavigation() {
            this.stateManager.set('ui.lastUrl', location.href);
            console.log('[VSC] SPA Navigation Detected. Soft Resetting...');
            this.stateManager.get('media.activeMedia').clear();
            const corePlugin = this.pluginManager.plugins.find(p => p.name === 'CoreMediaPlugin');
            if (corePlugin) {
                corePlugin.scanAndApply();
                [500, 1000, 2000, 3000, 5000].forEach(delay => {
                    setTimeout(() => corePlugin.scanAndApply(), delay);
                });
            }
        }
    }

    class UIPlugin extends Plugin {
        constructor() { super('UI'); this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null; this.hostElement = null; this.shadowRoot = null; this.fadeOutTimer = null; this.isDragging = false; this.wasDragged = false; this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 }; this.animationFrameId = null; this.delayMeterEl = null; this.speedButtons = []; this.uiElements = {}; this.modalHost = null; this.modalShadowRoot = null; this.uiState = { x: 0, y: 0 }; }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('ui.createRequested', () => { if (!this.globalContainer) { this.createGlobalUI(); this.stateManager.set('ui.globalContainer', this.globalContainer); } });
            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            this.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info));
            this.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());
            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));
            const vscMessage = sessionStorage.getItem('vsc_message'); if (vscMessage) { this.showWarningMessage(vscMessage); sessionStorage.removeItem('vsc_message'); }
            document.addEventListener('fullscreenchange', () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } });
        }
        destroy() { super.destroy(); if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; } if (this.modalHost) { this.modalHost.remove(); this.modalHost = null; } if (this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; } }
        showWarningMessage(message) {
            if (!message) return; let warningEl = document.getElementById('vsc-warning-bar');
            if (warningEl) { warningEl.querySelector('span').textContent = message; warningEl.style.opacity = '1'; if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout); }
            else {
                warningEl = document.createElement('div'); warningEl.id = 'vsc-warning-bar';
                Object.assign(warningEl.style, { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px', borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '15px', fontSize: '14px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.5s ease-in-out', maxWidth: '90%', });
                const messageSpan = document.createElement('span'); messageSpan.textContent = message; const closeBtn = document.createElement('button'); Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' }); closeBtn.textContent = '×'; closeBtn.onclick = () => warningEl.style.opacity = '0'; warningEl.append(messageSpan, closeBtn); document.body.appendChild(warningEl); setTimeout(() => (warningEl.style.opacity = '1'), 100);
            }
            warningEl.hideTimeout = setTimeout(() => { warningEl.style.opacity = '0'; }, CONFIG.UI_WARN_TIMEOUT);
        }
        updateDelayMeterVisibility() { if (this.delayMeterEl) { const controlsVisible = this.stateManager.get('ui.areControlsVisible'); this.delayMeterEl.style.display = controlsVisible ? 'flex' : 'none'; } }
        updateDelayMeter(info) {
            if (!info && this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; return; }
            if (info && !this.delayMeterEl && document.body) {
                this.delayMeterEl = document.createElement('div');
                Object.assign(this.delayMeterEl.style, { position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px' });
                const textSpan = document.createElement('span'); const refreshBtn = document.createElement('button'); refreshBtn.textContent = '🔄'; refreshBtn.title = '딜레이 측정 초기화'; Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); refreshBtn.onclick = () => { this.stateManager.set('liveStream.resetRequested', Date.now()); if (textSpan) { textSpan.textContent = '딜레이 리셋 중...'; } }; const closeBtn = document.createElement('button'); closeBtn.textContent = '✖'; closeBtn.title = '닫기'; Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); closeBtn.onclick = () => { this.stateManager.set('liveStream.isRunning', false); }; this.delayMeterEl.append(textSpan, refreshBtn, closeBtn); document.body.appendChild(this.delayMeterEl); this.updateDelayMeterVisibility();
            }
            if (this.delayMeterEl) { const textSpan = this.delayMeterEl.querySelector('span'); if (textSpan) { if (info.raw === null && info.avg === null) { textSpan.textContent = '딜레이 측정 중...'; } else { textSpan.textContent = `딜레이: ${info.avg?.toFixed(0) || 'N/A'}ms / 현재: ${info.raw?.toFixed(0) || 'N/A'}ms / 배속: ${info.rate?.toFixed(3) || 'N/A'}x`; } } }
        }
        resetFadeTimer() { const container = this.uiElements.mainContainer; if (container) { clearTimeout(this.fadeOutTimer); container.style.opacity = '1'; } }
        startFadeSequence() { const container = this.uiElements.mainContainer; if (container) { container.querySelectorAll('.vsc-control-group.submenu-visible').forEach(g => g.classList.remove('submenu-visible')); container.style.opacity = '0.3'; } }
        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile');
            this.globalContainer = document.createElement('div');
            this.globalContainer.style.setProperty('--vsc-translate-x', '0px'); this.globalContainer.style.setProperty('--vsc-translate-y', '0px');
            // [Fix] Centering and Layout
            Object.assign(this.globalContainer.style, { position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%) translate(var(--vsc-translate-x), var(--vsc-translate-y))', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'flex-start', gap: '5px', WebkitTapHighlightColor: 'transparent' });
            this.mainControlsContainer = document.createElement('div');
            Object.assign(this.mainControlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' });
            this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡';
            Object.assign(this.triggerElement.style, { width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none', fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', transition: 'box-shadow 0.3s ease-in-out, background-color 0.3s', order: '1', touchAction: 'none', });
            this.triggerElement.addEventListener('click', (e) => { if (this.wasDragged) { e.stopPropagation(); return; } if (!this.stateManager.get('app.scriptActive')) { this.stateManager.set('app.scriptActive', true); } const isVisible = this.stateManager.get('ui.areControlsVisible'); this.stateManager.set('ui.areControlsVisible', !isVisible); });
            this.speedButtonsContainer = document.createElement('div'); this.speedButtonsContainer.id = 'vsc-speed-buttons-container'; this.speedButtonsContainer.style.cssText = `display:none; flex-direction:column; gap:5px; align-items:center; background: transparent; border-radius: 0px; padding: 0px;`;
            this.attachDragAndDrop(); this.mainControlsContainer.appendChild(this.triggerElement); this.globalContainer.appendChild(this.mainControlsContainer); this.globalContainer.appendChild(this.speedButtonsContainer); document.body.appendChild(this.globalContainer);
        }
        onControlsVisibilityChange(isVisible) {
            if (!this.triggerElement) return;
            if (isVisible) {
                this.triggerElement.textContent = '🛑'; this.triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                const savedVideoSettings = this.stateManager.get('videoFilter.lastActiveSettings');
                if (savedVideoSettings) { for (const key in savedVideoSettings) { this.stateManager.set(`videoFilter.${key}`, savedVideoSettings[key]); } this.stateManager.set('videoFilter.lastActiveSettings', null); }
                const savedImageSettings = this.stateManager.get('imageFilter.lastActiveSettings');
                if (savedImageSettings) { this.stateManager.set('imageFilter.level', savedImageSettings.level); this.stateManager.set('imageFilter.lastActiveSettings', null); }
            } else {
                this.triggerElement.textContent = '⚡️'; this.triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
                const videoState = this.stateManager.get('videoFilter');
                const videoSettingsToSave = { level: videoState.level, level2: videoState.level2, gamma: videoState.gamma, blur: videoState.blur, shadows: videoState.shadows, highlights: videoState.highlights, saturation: videoState.saturation, colorTemp: videoState.colorTemp, dither: videoState.dither, smartLimit: videoState.smartLimit, autoTone: videoState.autoTone, sharpenDirection: videoState.sharpenDirection, activePreset: videoState.activePreset };
                this.stateManager.set('videoFilter.lastActiveSettings', videoSettingsToSave);
                const imageState = this.stateManager.get('imageFilter');
                this.stateManager.set('imageFilter.lastActiveSettings', { level: imageState.level });
            }
            if (isVisible && !this.hostElement) { this.createControlsHost(); }
            if (this.hostElement) { this.hostElement.style.display = isVisible ? 'flex' : 'none'; }
            if (this.speedButtonsContainer) { const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO'); this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none'; }
            this.updateUIVisibility();
        }
        createControlsHost() {
            this.hostElement = document.createElement('div'); this.hostElement.style.order = '2'; this.stateManager.set('ui.hostElement', this.hostElement);
            this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' }); this.stateManager.set('ui.shadowRoot', this.shadowRoot);
            this.modalHost = document.createElement('div'); this.modalShadowRoot = this.modalHost.attachShadow({ mode: 'open' });
            const currentRoot = document.fullscreenElement || document.body; currentRoot.appendChild(this.modalHost);
            this.renderAllControls(); this.mainControlsContainer.prepend(this.hostElement);
        }
        updateUIVisibility() {
            if (!this.shadowRoot) return;
            const controlsVisible = this.stateManager.get('ui.areControlsVisible'); const activeMedia = this.stateManager.get('media.activeMedia'); const activeImages = this.stateManager.get('media.activeImages');
            const hasVideo = [...activeMedia].some(m => m.tagName === 'VIDEO'); const hasImage = activeImages.size > 0;
            if (this.speedButtonsContainer) { this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none'; }
            const setVisible = (element, visible) => { if (element) element.classList.toggle(CONFIG.UI_HIDDEN_CLASS_NAME, !visible); };
            setVisible(this.uiElements.videoControls, hasVideo); setVisible(this.uiElements.imageControls, hasImage);
        }
        updateActiveSpeedButton(rate) { if (this.speedButtons.length === 0) return; this.speedButtons.forEach(b => { const speed = parseFloat(b.dataset.speed); if (speed) { const isActive = Math.abs(speed - rate) < 0.01; if (isActive) { b.style.background = 'rgba(231, 76, 60, 0.9)'; b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset'; } else { b.style.background = 'rgba(52, 152, 219, 0.7)'; b.style.boxShadow = ''; } } }); }
        _createControlGroup(id, icon, title, parent) {
            const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group';
            const mainBtn = document.createElement('button'); mainBtn.className = 'vsc-btn vsc-btn-main'; mainBtn.textContent = icon; mainBtn.title = title;
            const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu';
            group.append(mainBtn, subMenu);
            mainBtn.onclick = async (e) => { e.stopPropagation(); const isOpening = !group.classList.contains('submenu-visible'); if (this.shadowRoot) { this.shadowRoot.querySelectorAll('.vsc-control-group').forEach(g => g.classList.remove('submenu-visible')); } if (isOpening) { group.classList.add('submenu-visible'); } this.resetFadeTimer(); };
            parent.appendChild(group);
            if (id === 'vsc-image-controls') this.uiElements.imageControls = group; if (id === 'vsc-video-controls') this.uiElements.videoControls = group;
            return subMenu;
        }
        _createSlider(label, id, min, max, step, stateKey, unit, formatFn) {
            const div = document.createElement('div'); div.className = 'slider-control';
            const labelEl = document.createElement('label'); const span = document.createElement('span');
            const updateText = (v) => { const val = parseFloat(v); if (isNaN(val)) return; span.textContent = formatFn ? formatFn(val) : `${val.toFixed(1)}${unit}`; };
            labelEl.textContent = `${label}: `; labelEl.appendChild(span);
            const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step; slider.value = this.stateManager.get(stateKey);
            const debouncedSetState = debounce((val) => { this.stateManager.set(stateKey, val); }, 50);
            slider.oninput = () => { const val = parseFloat(slider.value); updateText(val); if (stateKey.startsWith('videoFilter.')) { this.stateManager.set('videoFilter.activePreset', 'custom'); } debouncedSetState(val); };
            this.subscribe(stateKey, (val) => { updateText(val); if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; } });
            updateText(slider.value); div.append(labelEl, slider);
            return { control: div, slider: slider, formatFn: formatFn, unit: unit };
        }
        _createSelectControl(labelText, options, stateKey) {
            const div = document.createElement('div'); div.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 8px;';
            const label = document.createElement('label'); label.textContent = labelText + ':'; label.style.cssText = `color: white; font-size: ${this.stateManager.get('app.isMobile') ? '12px' : '13px'}; white-space: nowrap;`;
            const select = document.createElement('select'); select.className = 'vsc-select';
            options.forEach(opt => { const o = document.createElement('option'); o.value = opt.value; o.textContent = opt.text; select.appendChild(o); });
            select.onchange = (e) => this.stateManager.set(stateKey, e.target.value);
            this.subscribe(stateKey, (val) => { if (select.value !== val) { select.value = val; } });
            select.value = this.stateManager.get(stateKey); div.append(label, select); return div;
        }
        renderAllControls() {
            if (this.shadowRoot.getElementById('vsc-main-container')) return;
            const style = document.createElement('style'); const isMobile = this.stateManager.get('app.isMobile');
            style.textContent = `:host { pointer-events: none; } * { pointer-events: auto; -webkit-tap-highlight-color: transparent; } #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; opacity: 0.3; transition: opacity 0.3s; } #vsc-main-container:hover { opacity: 1; } #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap:5px;} .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; background: rgba(0,0,0,0.7); border-radius: 8px; } .${CONFIG.UI_HIDDEN_CLASS_NAME} { display: none !important; } .vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 40%; transform: translateY(-40%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.9); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '2px' : '3px'}; } #vsc-video-controls .vsc-submenu { width: ${isMobile ? '240px' : '300px'}; max-width: 80vw; } #vsc-image-controls .vsc-submenu { width: 260px; } .vsc-control-group.submenu-visible .vsc-submenu { display: flex; } .vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(${isMobile ? '11px, 1.8vmin, 13px' : '12px, 2vmin, 14px'}); white-space: nowrap; } .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; } .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; } .vsc-btn-main { font-size: clamp(${isMobile ? '14px, 2.5vmin, 16px' : '15px, 3vmin, 18px'}); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; background: none; } .slider-control { display: flex; flex-direction: column; gap: ${isMobile ? '2px' : '4px'}; } .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '12px' : '13px'}; color: white; align-items: center; } input[type=range] { width: 100%; margin: 0; } input[type=range]:disabled { opacity: 0.5; } .vsc-select { background: rgba(0,0,0,0.8); color: white !important; border: 1px solid #666; border-radius: clamp(4px, 0.8vmin, 6px); padding: 0 5px !important; font-size: 14px !important; height: 30px !important; line-height: 30px !important; width: 100%; box-sizing: border-box; } .vsc-select option { background: #000; color: white; } .vsc-monitor { font-size: 10px; color: #aaa; margin-top: 5px; text-align: center; border-top: 1px solid #444; padding-top: 3px; }`;
            this.shadowRoot.appendChild(style);
            const mainContainer = document.createElement('div'); mainContainer.id = 'vsc-main-container'; this.uiElements.mainContainer = mainContainer;
            const controlsContainer = document.createElement('div'); controlsContainer.id = 'vsc-controls-container';

            const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', controlsContainer);

            const videoResetBtn = document.createElement('button');
            videoResetBtn.className = 'vsc-btn';
            videoResetBtn.textContent = 'S';
            videoResetBtn.dataset.presetKey = 'reset';
            videoResetBtn.onclick = () => { this.stateManager.set('videoFilter.level', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL); this.stateManager.set('videoFilter.level2', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2); this.stateManager.set('videoFilter.activePreset', 'reset'); };

            const videoMsharpBtn = document.createElement('button');
            videoMsharpBtn.className = 'vsc-btn';
            videoMsharpBtn.textContent = 'M';
            videoMsharpBtn.dataset.presetKey = 'sharpM';
            videoMsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 15); this.stateManager.set('videoFilter.level2', 7); this.stateManager.set('videoFilter.activePreset', 'sharpM'); };

            const videoLsharpBtn = document.createElement('button');
            videoLsharpBtn.className = 'vsc-btn';
            videoLsharpBtn.textContent = 'L';
            videoLsharpBtn.dataset.presetKey = 'sharpL';
            videoLsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 30); this.stateManager.set('videoFilter.level2', 15); this.stateManager.set('videoFilter.activePreset', 'sharpL'); };

            const videoSsharpOFFBtn = document.createElement('button');
            videoSsharpOFFBtn.className = 'vsc-btn';
            videoSsharpOFFBtn.textContent = '끔';
            videoSsharpOFFBtn.dataset.presetKey = 'sharpOFF';
            videoSsharpOFFBtn.onclick = () => { this.stateManager.set('videoFilter.level', 0); this.stateManager.set('videoFilter.level2', 0); this.stateManager.set('videoFilter.activePreset', 'sharpOFF'); };

            const videoSBrightenBtn = document.createElement('button');
            videoSBrightenBtn.className = 'vsc-btn';
            videoSBrightenBtn.textContent = 'S';
            videoSBrightenBtn.dataset.presetKey = 'brighten1';
            videoSBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.00); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -3.0); this.stateManager.set('videoFilter.highlights', 3); this.stateManager.set('videoFilter.activePreset', 'brighten1'); };

            const videoMBrightenBtn = document.createElement('button');
            videoMBrightenBtn.className = 'vsc-btn';
            videoMBrightenBtn.textContent = 'M';
            videoMBrightenBtn.dataset.presetKey = 'brighten2';
            videoMBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.10); this.stateManager.set('videoFilter.saturation', 102); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -5.0); this.stateManager.set('videoFilter.highlights', 5); this.stateManager.set('videoFilter.activePreset', 'brighten2'); };

            const videoLBrightenBtn = document.createElement('button');
            videoLBrightenBtn.className = 'vsc-btn';
            videoLBrightenBtn.textContent = 'L';
            videoLBrightenBtn.dataset.presetKey = 'brighten3';
            videoLBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.20); this.stateManager.set('videoFilter.saturation', 104); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -7.0); this.stateManager.set('videoFilter.highlights', 7); this.stateManager.set('videoFilter.activePreset', 'brighten3'); };

            const videoBrightenoffBtn = document.createElement('button');
            videoBrightenoffBtn.className = 'vsc-btn';
            videoBrightenoffBtn.textContent = '끔';
            videoBrightenoffBtn.dataset.presetKey = 'brightOFF';
            videoBrightenoffBtn.onclick = () => {
                this.stateManager.set('videoFilter.gamma', 1.00);
                this.stateManager.set('videoFilter.saturation', 100);
                this.stateManager.set('videoFilter.blur', 0);
                this.stateManager.set('videoFilter.shadows', 0);
                this.stateManager.set('videoFilter.highlights', 0);
                this.stateManager.set('videoFilter.colorTemp', -7);
                this.stateManager.set('videoFilter.activePreset', 'brightOFF');
            };

            const videoXSBrightenBtn = document.createElement('button');
            videoXSBrightenBtn.className = 'vsc-btn';
            videoXSBrightenBtn.textContent = 'S';
            videoXSBrightenBtn.dataset.presetKey = 'brightenX1';
            videoXSBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.05); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -1); this.stateManager.set('videoFilter.highlights', 2); this.stateManager.set('videoFilter.activePreset', 'brightenX1'); };

            const videoXMBrightenBtn = document.createElement('button');
            videoXMBrightenBtn.className = 'vsc-btn';
            videoXMBrightenBtn.textContent = 'M';
            videoXMBrightenBtn.dataset.presetKey = 'brightenX2';
            videoXMBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.07); this.stateManager.set('videoFilter.saturation', 101); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -2); this.stateManager.set('videoFilter.highlights', 4); this.stateManager.set('videoFilter.activePreset', 'brightenX2'); };

            const videoXLBrightenBtn = document.createElement('button');
            videoXLBrightenBtn.className = 'vsc-btn';
            videoXLBrightenBtn.textContent = 'L';
            videoXLBrightenBtn.dataset.presetKey = 'brightenX3';
            videoXLBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.09); this.stateManager.set('videoFilter.saturation', 102); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -4); this.stateManager.set('videoFilter.highlights', 8); this.stateManager.set('videoFilter.activePreset', 'brightenX3'); };

            const videoXXLBrightenBtn = document.createElement('button');
            videoXXLBrightenBtn.className = 'vsc-btn';
            videoXXLBrightenBtn.textContent = 'DS';
            videoXXLBrightenBtn.dataset.presetKey = 'brightenX4';
            videoXXLBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.10); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -6.4); this.stateManager.set('videoFilter.highlights', 4); this.stateManager.set('videoFilter.activePreset', 'brightenX4'); };

            const videoXXLLBrightenBtn = document.createElement('button');
            videoXXLLBrightenBtn.className = 'vsc-btn';
            videoXXLLBrightenBtn.textContent = 'DM';
            videoXXLLBrightenBtn.dataset.presetKey = 'brightenX5';
            videoXXLLBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.20); this.stateManager.set('videoFilter.saturation', 101); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -12.8); this.stateManager.set('videoFilter.highlights', 8); this.stateManager.set('videoFilter.activePreset', 'brightenX5'); };

            const videoXXLLLBrightenBtn = document.createElement('button');
            videoXXLLLBrightenBtn.className = 'vsc-btn';
            videoXXLLLBrightenBtn.textContent = 'DL';
            videoXXLLLBrightenBtn.dataset.presetKey = 'brightenX6';
            videoXXLLLBrightenBtn.onclick = () => { this.stateManager.set('videoFilter.gamma', 1.30); this.stateManager.set('videoFilter.saturation', 102); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -19.2); this.stateManager.set('videoFilter.highlights', 12); this.stateManager.set('videoFilter.activePreset', 'brightenX6'); };

            const videoButtonsContainer = document.createElement('div');
            videoButtonsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; width: 100%; padding-bottom: 4px; border-bottom: 1px solid #555;';

            const createLabel = (text) => {
                const span = document.createElement('span');
                span.textContent = text;
                span.style.cssText = 'color: white; font-weight: bold; font-size: 12px; margin-right: 4px; white-space: nowrap; min-width: 30px; text-align: right; text-shadow: 1px 1px 1px rgba(0,0,0,0.8);';
                return span;
            };

            const videoBtnGroup1 = document.createElement('div');
            videoBtnGroup1.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px;';
            videoBtnGroup1.append(createLabel('샤프'), videoResetBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn);

            const videoBtnGroup3 = document.createElement('div');
            videoBtnGroup3.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px;';
            videoBtnGroup3.append(createLabel('밝기'), videoXSBrightenBtn, videoXMBrightenBtn, videoXLBrightenBtn, videoXXLBrightenBtn, videoXXLLBrightenBtn, videoXXLLLBrightenBtn, videoBrightenoffBtn);

            videoButtonsContainer.append(videoBtnGroup1, videoBtnGroup3);

            const videoButtons = [videoResetBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn, videoSBrightenBtn, videoMBrightenBtn, videoLBrightenBtn, videoBrightenoffBtn, videoXSBrightenBtn, videoXMBrightenBtn, videoXLBrightenBtn, videoXXLBrightenBtn, videoXXLLBrightenBtn, videoXXLLLBrightenBtn];
            this.subscribe('videoFilter.activePreset', (activeKey) => { videoButtons.forEach(btn => { btn.classList.toggle('active', btn.dataset.presetKey === activeKey); }); });

            videoSubMenu.appendChild(videoButtonsContainer);

            const gridContainer = document.createElement('div');
            gridContainer.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;';

            gridContainer.append(
                this._createSlider('자동밝기제한', 'v-smartlimit', 0, 50, 1, 'videoFilter.smartLimit', '%', v => v > 0 ? `${v.toFixed(0)}%` : '꺼짐').control,
                this._createSlider('자동톤매핑', 'v-autotone', 0, 100, 5, 'videoFilter.autoTone', '%', v => v > 0 ? `${v.toFixed(0)}%` : '꺼짐').control,
                this._createSlider('샤프(윤곽)', 'v-sharpen1', 0, 50, 1, 'videoFilter.level', '단계', v => `${v.toFixed(0)}단계`).control,
                this._createSlider('샤프(디테일)', 'v-sharpen2', 0, 50, 1, 'videoFilter.level2', '단계', v => `${v.toFixed(0)}단계`).control,
                this._createSlider('색온도', 'v-colortemp', -15, 4, 1, 'videoFilter.colorTemp', '', v => `${v.toFixed(0)}%`).control,
                this._createSlider('디더링', 'v-dither', 0, 50, 5, 'videoFilter.dither', '', v => `${v.toFixed(0)}%`).control,
                this._createSlider('블러', 'v-blur', 0, 2, 0.01, 'videoFilter.blur', '', v => v.toFixed(2)).control,
                this._createSlider('밝기', 'v-highlights', -100, 100, 1, 'videoFilter.highlights', '', v => v.toFixed(0)).control,
                this._createSlider('대비', 'v-shadows', -100, 100, 0.1, 'videoFilter.shadows', '', v => v.toFixed(1)).control,
                this._createSlider('감마', 'v-gamma', 1, 4.00, 0.01, 'videoFilter.gamma', '', v => v.toFixed(2)).control,
                this._createSlider('채도', 'v-saturation', 0, 200, 1, 'videoFilter.saturation', '%', v => `${v.toFixed(0)}%`).control
            );
            videoSubMenu.appendChild(gridContainer);

            const statusDisplay = document.createElement('div');
            statusDisplay.className = 'vsc-monitor';
            statusDisplay.textContent = 'Waiting for video...';
            videoSubMenu.appendChild(statusDisplay);

            document.addEventListener('vsc-smart-limit-update', (e) => {
                if (!videoSubMenu.parentElement.classList.contains('submenu-visible')) return;
                const { slope, autoParams, luma } = e.detail;
                const isLimitOff = this.stateManager.get('videoFilter.smartLimit') <= 0;
                const limitDisplay = isLimitOff ? '(Off)' : (slope < 1.0 ? ((1.0 - slope) * 100).toFixed(0) + '%' : '0%');

                const isAutoToneOn = this.stateManager.get('videoFilter.autoTone') > 0;
                let gammaState = '';
                if (isAutoToneOn) {
                    gammaState = '(Auto)';
                } else if (this.stateManager.get('videoFilter.gamma') !== 1.00) {
                    gammaState = '(Manual)';
                } else {
                    gammaState = '(Off)';
                }

                statusDisplay.textContent = `Luma: ${luma ? luma.toFixed(2) : 'N/A'} | Gamma: ${autoParams.gamma.toFixed(2)} ${gammaState} | Limit: ${limitDisplay}`;
            });


            const imageSubMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controlsContainer);
            imageSubMenu.appendChild(
                this._createSlider('샤프닝', 'i-sharpen', 0, 20, 1, 'imageFilter.level', '단계', v => v === 0 ? '꺼짐' : `${v.toFixed(0)}단계`).control
            );
            imageSubMenu.appendChild(
                this._createSlider('색온도', 'i-colortemp', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control
            );

            if (this.speedButtons.length === 0) { CONFIG.SPEED_PRESETS.forEach(speed => { const btn = document.createElement('button'); btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn'; Object.assign(btn.style, { background: 'rgba(52, 152, 219, 0.7)', color: 'white', width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)', padding: '0', transition: 'background-color 0.2s, box-shadow 0.2s' }); btn.onclick = () => this.stateManager.set('playback.targetRate', speed); this.speedButtonsContainer.appendChild(btn); this.speedButtons.push(btn); }); const isLiveJumpSite = CONFIG.LIVE_JUMP_WHITELIST.some(d => location.hostname === d || location.hostname.endsWith('.' + d)); if (isLiveJumpSite) { const liveJumpBtn = document.createElement('button'); liveJumpBtn.textContent = '⚡'; liveJumpBtn.title = '실시간으로 이동'; liveJumpBtn.className = 'vsc-btn'; Object.assign(liveJumpBtn.style, { width: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', fontSize: this.stateManager.get('app.isMobile') ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', borderRadius: '50%', padding: '0', transition: 'box-shadow 0.3s' }); liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now()); this.speedButtonsContainer.appendChild(liveJumpBtn); } }
            mainContainer.appendChild(controlsContainer); this.shadowRoot.appendChild(mainContainer); this.updateActiveSpeedButton(this.stateManager.get('playback.currentRate'));
        }
        attachDragAndDrop() {
            let pressTimer = null;
            const isInteractiveTarget = (e) => { for (const element of e.composedPath()) { if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(element.tagName)) { return true; } } return false; };
            const onDragStart = (e) => {
                if (isInteractiveTarget(e)) return;
                pressTimer = setTimeout(() => { if (this.globalContainer) this.globalContainer.style.display = 'none'; onDragEnd(); }, 800);
                const pos = e.touches ? e.touches[0] : e;
                this.startPos = { x: pos.clientX, y: pos.clientY };
                this.currentPos = { x: this.uiState.x, y: this.uiState.y };
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
                    this.uiState.x += this.delta.x;
                    this.uiState.y += this.delta.y;
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

    function main() {
        const stateManager = new StateManager();
        const pluginManager = new PluginManager(stateManager);
        window.vscPluginManager = pluginManager;
        pluginManager.register(new UIPlugin());
        pluginManager.register(new CoreMediaPlugin());
        pluginManager.register(new SvgFilterPlugin());
        pluginManager.register(new PlaybackControlPlugin());
        pluginManager.register(new LiveStreamPlugin());
        // [Optimized] MediaSessionPlugin registration Removed
        pluginManager.register(new NavigationPlugin(pluginManager));
        pluginManager.initAll();
    }

    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', main); } else { main(); }
})();
