// ==UserScript==
// @name         Video_Image_Control (Safe Radius)
// @namespace    https://com/
// @version      117.20-SafeRadius
// @description  v117.20: [Visual] 물결 노이즈(Moiré) 완전 제거를 위해 샤프닝 반경을 안전 구간(1.0px/2.0px)으로 상향. 픽셀 노이즈는 무시하고 실제 디테일과 입체감만 강조하도록 튜닝.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;

    const CONFIG = {
        ENABLE_HLS_BOOST: true,
        HLS_MAX_BUFFER: 120,
        HLS_BACK_BUFFER: 60,
        DEFAULT_VIDEO_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 15 : 15,
        DEFAULT_VIDEO_FILTER_LEVEL_2: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 15 : 15,
        DEFAULT_IMAGE_FILTER_LEVEL: (/Mobi|Android|iPhone/i.test(navigator.userAgent)) ? 15 : 15,
        DEFAULT_SMART_LIMIT_LEVEL: 0,
        DEFAULT_AUTO_TONE_LEVEL: 0,
        DEBUG: false,
        DEFAULT_AUDIO_BASS: 0,
        AUDIO_BASS_MAX_DB: 6.5,
        AUDIO_BASS_FREQ: 90,
        DEFAULT_AUDIO_REVERB: 0,
        DEFAULT_AUDIO_PITCH: true,
        AUTODELAY_INTERVAL_NORMAL: 1000, AUTODELAY_INTERVAL_STABLE: 3000,
        AUTODELAY_STABLE_THRESHOLD: 100, AUTODELAY_STABLE_COUNT: 5,
        AUTODELAY_PID_KP: 0.0002, AUTODELAY_PID_KI: 0.00001, AUTODELAY_PID_KD: 0.0001,
        AUTODELAY_MIN_RATE: 1.0, AUTODELAY_MAX_RATE: 1.025,
        AUTODELAY_EMA_ALPHA: 0.2,
        MIN_BUFFER_HEALTH_SEC: 1.0,
        LIVE_JUMP_INTERVAL: 6000, LIVE_JUMP_END_THRESHOLD: 1.0,
        DEBOUNCE_DELAY: 300,
        SCAN_INTERVAL: 3000,
        MAX_RECURSION_DEPTH: 3,
        MAX_Z_INDEX: 2147483647,
        UI_DRAG_THRESHOLD: 5, UI_WARN_TIMEOUT: 10000,
        LIVE_STREAM_SITES: ['tv.naver.com', 'play.sooplive.co.kr', 'chzzk.naver.com', 'twitch.tv', 'kick.com', 'ok.ru', 'bigo.tv', 'pandalive.co.kr', 'chaturbate.com', 'stripchat.com', 'xhamsterlive.com', 'myavlive.com'],
        SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2],
        VIDEO_MIN_SIZE: 50,
        IMAGE_MIN_SIZE: 355,
        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: 0, DITHER_VALUE: 0, SMART_LIMIT: 0, AUTO_TONE: 0 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: 0, DITHER_VALUE: 0, SMART_LIMIT: 0, AUTO_TONE: 0 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', BLUR_STD_DEVIATION: '0', SHADOWS_VALUE: 0, HIGHLIGHTS_VALUE: 0, SATURATION_VALUE: 100, COLORTEMP_VALUE: 0 },
        TARGET_DELAYS: { "play.sooplive.co.kr": 2500, "chzzk.naver.com": 2500, "ok.ru": 2500 }, DEFAULT_TARGET_DELAY: 3000,
        UI_HIDDEN_CLASS_NAME: 'vsc-hidden',
    };

    const safeExec = (fn, label = '') => { try { fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), wait); }; };
    const throttle = (fn, limit) => { let inThrottle; return function(...args) { if (!inThrottle) { fn.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; };
    const requestIdle = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : (cb) => { const start = Date.now(); return setTimeout(() => { cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (Date.now() - start)) }); }, 1); };
    const cancelIdle = window.cancelIdleCallback ? window.cancelIdleCallback.bind(window) : (id) => clearTimeout(id);
    let idleCallbackId;
    const scheduleIdleTask = (task) => { if (idleCallbackId) cancelIdle(idleCallbackId); idleCallbackId = requestIdle(task, { timeout: 1000 }); };

    const _realmSheetCache = new WeakMap(); 
    const _injectedContexts = new WeakMap(); 

    function getSharedStyleSheetForView(view, cssText) {
        if (!view || !view.CSSStyleSheet) return null;
        let map = _realmSheetCache.get(view);
        if (!map) { map = new Map(); _realmSheetCache.set(view, map); }
        let sheet = map.get(cssText);
        if (!sheet) { 
            try {
                sheet = new view.CSSStyleSheet(); 
                sheet.replaceSync(cssText); 
                map.set(cssText, sheet); 
            } catch(e) { return null; }
        }
        return sheet;
    }

    function isInjected(context, type) {
        const set = _injectedContexts.get(context);
        return !!(set && set.has(type));
    }

    function markInjected(context, type) {
        let set = _injectedContexts.get(context);
        if (!set) { set = new Set(); _injectedContexts.set(context, set); }
        set.add(type);
    }

    function injectFiltersIntoContext(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        let root = element.getRootNode();
        const ownerDoc = element.ownerDocument;
        
        if (root === document && element.parentElement) { 
            const shadowRoots = window._shadowDomList_ || []; 
            for (const sRoot of shadowRoots) { if (sRoot.contains(element)) { root = sRoot; break; } } 
        }

        if (ownerDoc === document && root === document) return;

        const type = (manager === stateManager.filterManagers.video) ? 'video' : 'image';
        
        if (root instanceof ShadowRoot) {
            if (isInjected(root, type)) return;
        } else if (ownerDoc !== document) {
            if (isInjected(ownerDoc, type)) return;
        }

        const attr = `data-vsc-filters-injected-${type}`;
        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode();
        if (!svgNode || !styleNode) return;

        // Iframe Injection
        if (ownerDoc !== document && ownerDoc.body && ownerDoc.head && !ownerDoc.documentElement.hasAttribute(attr)) {
            const clonedSvg = svgNode.cloneNode(true);
            const clonedStyle = styleNode.cloneNode(true);
            
            ownerDoc.body.appendChild(clonedSvg);
            
            const view = ownerDoc.defaultView;
            const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
            
            if (sharedSheet && ('adoptedStyleSheets' in ownerDoc)) {
                 try {
                     const prev = ownerDoc.adoptedStyleSheets || [];
                     ownerDoc.adoptedStyleSheets = [...prev, sharedSheet];
                 } catch(e) {
                     ownerDoc.head.appendChild(clonedStyle); 
                 }
            } else {
                 ownerDoc.head.appendChild(clonedStyle);
            }
            
            manager.registerContext(clonedSvg);
            ownerDoc.documentElement.setAttribute(attr, 'true');
            markInjected(ownerDoc, type); 
            return;
        } 
        
        // ShadowRoot Injection
        if (root instanceof ShadowRoot) {
            const flag = type === 'video' ? '_vsc_video_filters_injected' : '_vsc_image_filters_injected';
            if (!root[flag]) {
                try {
                    const clonedSvg = svgNode.cloneNode(true);
                    const clonedStyle = styleNode.cloneNode(true);
                    
                    const view = root.ownerDocument ? root.ownerDocument.defaultView : null;
                    const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                    
                    if (sharedSheet && ('adoptedStyleSheets' in root)) { 
                        try {
                            const prev = root.adoptedStyleSheets || [];
                            root.adoptedStyleSheets = [...prev, sharedSheet]; 
                        } catch(e) {
                            root.appendChild(clonedStyle);
                        }
                    } else { 
                        root.appendChild(clonedStyle); 
                    }
                    root.appendChild(clonedSvg);
                    
                    manager.registerContext(clonedSvg);
                    root[flag] = true; 
                    if (root.host) root.host.setAttribute(attr, 'true');
                    markInjected(root, type); 
                } catch (e) { }
            }
        }
    }

    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    if (CONFIG.ENABLE_HLS_BOOST) {
        (function patchHlsClass() {
            function isCtor(v) { return typeof v === 'function'; }
            function protectGlobal(name, value) { try { delete window[name]; } catch {} Object.defineProperty(window, name, { value, writable: false, configurable: true, enumerable: false }); }
            function makePatchedHls(OriginalHls) {
                if (!OriginalHls || OriginalHls.__VSC_PATCHED__ || !isCtor(OriginalHls)) return OriginalHls;
                const overrides = { maxBufferLength: CONFIG.HLS_MAX_BUFFER, backBufferLength: CONFIG.HLS_BACK_BUFFER, maxMaxBufferLength: CONFIG.HLS_MAX_BUFFER * 2, startFragPrefetch: true };
                try { if (OriginalHls.DefaultConfig) Object.assign(OriginalHls.DefaultConfig, overrides); } catch {}
                class PatchedHls extends OriginalHls { constructor(userConfig = {}) { const enforced = Object.assign({}, overrides, userConfig); enforced.maxBufferLength = Math.max(enforced.maxBufferLength || 0, CONFIG.HLS_MAX_BUFFER); enforced.backBufferLength = Math.max(enforced.backBufferLength || 0, CONFIG.HLS_BACK_BUFFER); super(enforced); } }
                Object.getOwnPropertyNames(OriginalHls).forEach((name) => { if (['length', 'prototype', 'name', 'DefaultConfig'].includes(name)) return; try { Object.defineProperty(PatchedHls, name, Object.getOwnPropertyDescriptor(OriginalHls, name)); } catch {} });
                Object.defineProperty(PatchedHls, 'DefaultConfig', { get() { return OriginalHls.DefaultConfig; }, set(v) { OriginalHls.DefaultConfig = v; } });
                Object.defineProperty(PatchedHls, '__VSC_PATCHED__', { value: true });
                return PatchedHls;
            }
            if ('Hls' in window && isCtor(window.Hls)) { protectGlobal('Hls', makePatchedHls(window.Hls)); } else { let armed = true; Object.defineProperty(window, 'Hls', { configurable: true, enumerable: false, get() { return undefined; }, set(v) { if (!armed) return; armed = false; if (!isCtor(v)) { protectGlobal('Hls', v); return; } const Patched = makePatchedHls(v); protectGlobal('Hls', Patched); } }); }
        })();
    }

    (function aggressiveShadowHook() {
        if (window._hasAggressiveHook_) return;
        try {
            const originalAttachShadow = Element.prototype.attachShadow; window._shadowDomList_ = window._shadowDomList_ || [];
            Object.defineProperty(window, '_shadowDomList_', { value: window._shadowDomList_, enumerable: false, writable: true });
            Element.prototype.attachShadow = function (init) {
                const shadowRoot = originalAttachShadow.call(this, init);
                try { const cls = (this.className || '').toString(); const id = (this.id || '').toString(); if (cls.includes('turnstile') || id.includes('turnstile')) { return shadowRoot; } shadowRoot._vsc_pending_injection = true; window._shadowDomList_.push(shadowRoot); document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: shadowRoot } })); } catch (e) { }
                return shadowRoot;
            };
            window._hasAggressiveHook_ = true;
        } catch (e) { console.warn("[VSC] Hooking Failed:", e); }
    })();

    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null,
        taintedCache: new WeakMap(),
        currentSettings: { smartLimit: 0, autoTone: 0 }, currentSlope: 1.0, targetSlope: 1.0,
        currentAdaptiveGamma: 1.0, currentAdaptiveBright: 0, currentAdaptiveContrast: 0, frameSkipCounter: 0,
        hasRVFC: false,
        init() {
            if (this.canvas) return;
            this.canvas = document.createElement('canvas');
            this.canvas.width = 32;
            this.canvas.height = 32;
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        },
        start(video, settings) {
            if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
            const cachedSrc = this.taintedCache.get(video);
            const currentSrc = video.currentSrc || video.src;
            if (cachedSrc && cachedSrc === currentSrc) return;
            if (cachedSrc) this.taintedCache.delete(video);
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video;
            this.hasRVFC = 'requestVideoFrameCallback' in this.targetVideo;
            this.init(); this.isRunning = true; this.loop();
        },
        stop() { this.isRunning = false; if (this.handle && this.targetVideo && this.hasRVFC) { this.targetVideo.cancelVideoFrameCallback(this.handle); } this.targetVideo = null; },
        updateSettings(settings) { this.currentSettings = { ...this.currentSettings, ...settings }; const isActive = this.currentSettings.smartLimit > 0 || this.currentSettings.autoTone > 0; if (isActive && !this.isRunning && this.targetVideo) { this.isRunning = true; this.loop(); } else if (!isActive && this.isRunning) { this.stop(); this.notifyUpdate(1.0, { gamma: 1.0, bright: 0, contrast: 0 }, 0); } },
        loop() { if (!this.isRunning || !this.targetVideo) return; if (this.hasRVFC) { this.handle = this.targetVideo.requestVideoFrameCallback(() => { this.processFrame(); this.loop(); }); } else { this.processFrame(); setTimeout(() => this.loop(), 200); } },
        processFrame() {
            if (!this.targetVideo || this.targetVideo.paused || this.targetVideo.ended) return;
            if (this.currentSettings.smartLimit <= 0 && this.currentSettings.autoTone <= 0) { this.stop(); return; }
            const skipThreshold = this.hasRVFC ? 10 : 0;
            this.frameSkipCounter++; 
            if (this.frameSkipCounter < skipThreshold) return; 
            this.frameSkipCounter = 0;

            try {
                this.ctx.drawImage(this.targetVideo, 0, 0, 32, 32);
                const data = this.ctx.getImageData(0, 0, 32, 32).data;

                let totalLuma = 0;
                const len = data.length;
                for (let i = 0; i < len; i += 4) {
                    totalLuma += (data[i] * 0.2126 + data[i+1] * 0.7152 + data[i+2] * 0.0722);
                }
                const avgLuma = (totalLuma / (len / 4)) / 255;

                const ceiling = (100 - this.currentSettings.smartLimit) / 100;
                let calcSlope = (avgLuma > ceiling && avgLuma > 0.01) ? (ceiling / avgLuma) : 1.0;
                this.targetSlope = Math.max(0, Math.min(1.0, calcSlope));
                let targetAdaptiveGamma = 1.0; let targetAdaptiveBright = 0; let targetAdaptiveContrast = 0;
                const toneStrength = (this.currentSettings.autoTone || 0) / 100;
                if (toneStrength > 0) {
                    if (avgLuma < 0.25) { const factor = (0.25 - avgLuma) * 4; targetAdaptiveGamma = 1.0 + (0.5 * factor * toneStrength); targetAdaptiveBright = 15 * factor * toneStrength; targetAdaptiveContrast = -15 * factor * toneStrength; }
                    else if (avgLuma > 0.65) { const factor = (avgLuma - 0.65) * 2.8; targetAdaptiveGamma = 1.0 - (0.15 * factor * toneStrength); targetAdaptiveBright = -5 * factor * toneStrength; targetAdaptiveContrast = 15 * factor * toneStrength; }
                }
                const smooth = (curr, target) => { const diff = target - curr; return Math.abs(diff) > 0.01 ? curr + diff * 0.05 : curr; };
                this.currentSlope = smooth(this.currentSlope, this.targetSlope); this.currentAdaptiveGamma = smooth(this.currentAdaptiveGamma || 1.0, targetAdaptiveGamma); this.currentAdaptiveBright = smooth(this.currentAdaptiveBright || 0, targetAdaptiveBright); this.currentAdaptiveContrast = smooth(this.currentAdaptiveContrast || 0, targetAdaptiveContrast);
                this.notifyUpdate(this.currentSlope, { gamma: this.currentAdaptiveGamma, bright: this.currentAdaptiveBright, contrast: this.currentAdaptiveContrast }, avgLuma);
            } catch (e) {
                if (e.name === 'SecurityError') {
                    this.taintedCache.set(this.targetVideo, this.targetVideo.currentSrc || this.targetVideo.src);
                    this.notifyUpdate(1.0, { gamma: 1.0, bright: 0, contrast: 0 }, 0);
                    this.stop();
                }
            }
        },
        notifyUpdate(slope, autoParams, luma) { document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', { detail: { slope, autoParams: autoParams || { gamma: 1.0, bright: 0, contrast: 0 }, luma: luma } })); }
    };

    class StateManager {
        constructor() { this.state = {}; this.listeners = {}; this.filterManagers = { video: null, image: null }; }
        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            this.state = {
                app: { isInitialized: false, isMobile, scriptActive: false },
                media: { activeMedia: new Set(), processedMedia: new WeakSet(), activeImages: new Set(), processedImages: new WeakSet(), mediaListenerMap: new WeakMap(), currentlyVisibleMedia: null, visibilityChange: null },
                videoFilter: {
                    lastActiveSettings: null,
                    level: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, level2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2,
                    gamma: parseFloat(videoDefaults.GAMMA_VALUE), blur: parseFloat(videoDefaults.BLUR_STD_DEVIATION),
                    shadows: parseInt(videoDefaults.SHADOWS_VALUE, 10), highlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10),
                    saturation: parseInt(videoDefaults.SATURATION_VALUE, 10), colorTemp: parseInt(videoDefaults.COLORTEMP_VALUE || 0, 10),
                    dither: parseInt(videoDefaults.DITHER_VALUE || 0, 10), smartLimit: CONFIG.DEFAULT_SMART_LIMIT_LEVEL,
                    autoTone: CONFIG.DEFAULT_AUTO_TONE_LEVEL, activePreset: 'none',
                    activeProfile: 'none', profileStrength: 0.5
                },
                imageFilter: { lastActiveSettings: null, level: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, colorTemp: parseInt(CONFIG.IMAGE_FILTER_SETTINGS.COLORTEMP_VALUE || 0, 10) },
                audio: { bass: CONFIG.DEFAULT_AUDIO_BASS, reverb: CONFIG.DEFAULT_AUDIO_REVERB, pitch: CONFIG.DEFAULT_AUDIO_PITCH },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, lastUrl: location.href, warningMessage: null },
                playback: { currentRate: 1.0, targetRate: 1.0, isLive: false, jumpToLiveRequested: 0 },
                liveStream: { delayInfo: null, isRunning: false, resetRequested: null, isPinned: false },
                settings: { videoFilterLevel: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, videoFilterLevel2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2, imageFilterLevel: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, autoRefresh: true }
            };
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) { const keys = key.split('.'); let obj = this.state; for (let i = 0; i < keys.length - 1; i++) { if (obj === undefined) return; obj = obj[keys[i]]; } const finalKey = keys[keys.length - 1]; if (obj === undefined) return; if (obj[finalKey] !== value) { const oldValue = obj[finalKey]; obj[finalKey] = value; this.notify(key, value, oldValue); } }
        subscribe(key, callback) { if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback); return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); }; }
        notify(key, newValue, oldValue) { if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue)); let currentKey = key; while (currentKey.includes('.')) { const prefix = currentKey.substring(0, currentKey.lastIndexOf('.')); const wildcardKey = `${prefix}.*`; if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue)); currentKey = prefix; } }
    }
    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    class PluginManager { constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; } register(plugin) { this.plugins.push(plugin); } initAll() { this.stateManager.init(); this.plugins.forEach(plugin => safeExec(() => plugin.init(this.stateManager), `Plugin ${plugin.name} init`)); this.stateManager.set('app.isInitialized', true); this.stateManager.set('app.pluginsInitialized', true); } destroyAll() { this.plugins.forEach(plugin => safeExec(() => plugin.destroy(), `Plugin ${plugin.name} destroy`)); this.stateManager.set('app.isInitialized', false); } }

    class CoreMediaPlugin extends Plugin {
        constructor() {
            super('CoreMedia');
            this.mainObserver = null;
            this.intersectionObserver = null;
            this.maintenanceInterval = null;
            this.debouncedScanTask = debounce(this.scanAndApply.bind(this), CONFIG.DEBOUNCE_DELAY || 300);
            this.onAddShadowRoot = null;
            this._ioRatio = new Map();
        }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('app.pluginsInitialized', () => {
                this.ensureObservers(); this.scanAndApply();
                this.onAddShadowRoot = (e) => { if (e.detail && e.detail.shadowRoot) { this.scanSpecificRoot(e.detail.shadowRoot); } };
                document.addEventListener('addShadowRoot', this.onAddShadowRoot);
                if (this.maintenanceInterval) clearInterval(this.maintenanceInterval);
                this.maintenanceInterval = setInterval(() => { this.scanAndApply(); if (window._shadowDomList_) { window._shadowDomList_ = window._shadowDomList_.filter(r => r && r.host && r.host.isConnected); } }, CONFIG.SCAN_INTERVAL);
            });
        }
        destroy() { super.destroy(); if (this.mainObserver) { this.mainObserver.disconnect(); this.mainObserver = null; } if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; } if (this.maintenanceInterval) { clearInterval(this.maintenanceInterval); this.maintenanceInterval = null; } if (this.onAddShadowRoot) { document.removeEventListener('addShadowRoot', this.onAddShadowRoot); this.onAddShadowRoot = null; } }
        ensureObservers() {
            if (!this.mainObserver) { this.mainObserver = new MutationObserver(() => scheduleIdleTask(this.scanAndApply.bind(this))); const target = document.body || document.documentElement; this.mainObserver.observe(target, { childList: true, subtree: true }); }
            if (!this.intersectionObserver) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        e.target.dataset.isVisible = String(isVisible);
                        if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') { this.stateManager.set('media.visibilityChange', { target: e.target, isVisible }); }
                        if (e.target.tagName === 'VIDEO') { this._ioRatio.set(e.target, { isVisible, ratio: e.intersectionRatio }); }
                    });
                    let best = null, maxR = -1;
                    for(const [v, data] of this._ioRatio) {
                        if (!v.isConnected) { this._ioRatio.delete(v); continue; }
                        if (data.isVisible && data.ratio > maxR) { maxR = data.ratio; best = v; }
                    }
                    if (best) VideoAnalyzer.start(best); else VideoAnalyzer.stop();
                    if (this.stateManager.get('app.isMobile')) { this.stateManager.set('media.currentlyVisibleMedia', best); }
                }, { root: null, rootMargin: '0px', threshold: [0, 0.01, 0.5, 1.0] });
            }
        }
        scanAndApply() { this._processElements(this.findAllMedia.bind(this), this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this), 'media.activeMedia'); this._processElements(this.findAllImages.bind(this), this.attachImageListeners.bind(this), this.detachImageListeners.bind(this), 'media.activeImages'); }
        scanSpecificRoot(root) { if (!root) return; const mediaInRoot = this.findAllMedia(root, 0, true); const imagesInRoot = this.findAllImages(root, 0, true); mediaInRoot.forEach(el => { if(el.isConnected) { this.attachMediaListeners(el); } }); imagesInRoot.forEach(el => { if(el.isConnected) { this.attachImageListeners(el); } }); const currentMedia = this.stateManager.get('media.activeMedia'); const currentImages = this.stateManager.get('media.activeImages'); let mediaChanged = false; let imagesChanged = false; mediaInRoot.forEach(m => { if (!currentMedia.has(m)) { currentMedia.add(m); mediaChanged = true; }}); imagesInRoot.forEach(i => { if (!currentImages.has(i)) { currentImages.add(i); imagesChanged = true; }}); if (mediaChanged) this.stateManager.set('media.activeMedia', new Set(currentMedia)); if (imagesChanged) this.stateManager.set('media.activeImages', new Set(currentImages)); }
        _processElements(findAllFn, attachFn, detachFn, stateKey) { const allElements = findAllFn(); if (allElements.length > 0 && !this.stateManager.get('ui.globalContainer')) { this.stateManager.set('ui.createRequested', true); } const activeSet = this.stateManager.get(stateKey); const oldElements = new Set(activeSet); const newActiveSet = new Set(); allElements.forEach(el => { if (el.isConnected) { newActiveSet.add(el); attachFn(el); oldElements.delete(el); } }); oldElements.forEach(detachFn); if (newActiveSet.size !== activeSet.size || ![...newActiveSet].every(el => activeSet.has(el))) { this.stateManager.set(stateKey, newActiveSet); } }
        findAllMedia(root = document, depth = 0, skipShadowScan = false) {
            if (depth > CONFIG.MAX_RECURSION_DEPTH) return [];
            let media = new Set();
            const isValid = m => (m.offsetWidth >= CONFIG.VIDEO_MIN_SIZE || m.offsetHeight >= CONFIG.VIDEO_MIN_SIZE || m.videoWidth >= CONFIG.VIDEO_MIN_SIZE || m.videoHeight >= CONFIG.VIDEO_MIN_SIZE);
            root.querySelectorAll('video').forEach(m => isValid(m) && media.add(m));
            root.querySelectorAll('iframe').forEach(f => { try { if (f.src && f.src.includes('challenges.cloudflare.com')) return; if (f.contentDocument) { const frameMedia = this.findAllMedia(f.contentDocument, depth + 1, skipShadowScan); frameMedia.forEach(m => media.add(m)); } } catch (e) { } });
            if (!skipShadowScan) { (window._shadowDomList_ || []).forEach(shadowRoot => { try { shadowRoot.querySelectorAll('video').forEach(m => isValid(m) && media.add(m)); } catch (e) { } }); }
            return [...media];
        }
        findAllImages(root = document, depth = 0, skipShadowScan = false) { if (depth > CONFIG.MAX_RECURSION_DEPTH) return []; let images = new Set(); const isValid = i => (i.naturalWidth > CONFIG.IMAGE_MIN_SIZE && i.naturalHeight > CONFIG.IMAGE_MIN_SIZE) || (i.offsetWidth > CONFIG.IMAGE_MIN_SIZE && i.offsetHeight > CONFIG.IMAGE_MIN_SIZE); root.querySelectorAll('img').forEach(i => isValid(i) && images.add(i)); root.querySelectorAll('iframe').forEach(f => { try { if (f.src && f.src.includes('challenges.cloudflare.com')) return; if (f.contentDocument) { const frameImages = this.findAllImages(f.contentDocument, depth + 1, skipShadowScan); frameImages.forEach(i => images.add(i)); } } catch (e) { } }); if (!skipShadowScan) { (window._shadowDomList_ || []).forEach(shadowRoot => { try { shadowRoot.querySelectorAll('img').forEach(i => isValid(i) && images.add(i)); } catch (e) { } }); } return [...images]; }
        attachMediaListeners(media) { if (!media || this.stateManager.get('media.mediaListenerMap').has(media) || !this.intersectionObserver) return; media.dataset.isVisible = 'false'; if (this.stateManager.filterManagers.video) { injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager); } const listeners = { play: () => this.stateManager.set('playback.currentRate', media.playbackRate), ratechange: () => this.stateManager.set('playback.currentRate', media.playbackRate), }; for (const [evt, handler] of Object.entries(listeners)) { media.addEventListener(evt, handler); } this.stateManager.get('media.mediaListenerMap').set(media, listeners); this.stateManager.get('media.processedMedia').add(media); this.intersectionObserver.observe(media); }
        detachMediaListeners(media) { const listenerMap = this.stateManager.get('media.mediaListenerMap'); if (!listenerMap.has(media)) return; const listeners = listenerMap.get(media); for (const [evt, listener] of Object.entries(listeners)) { media.removeEventListener(evt, listener); } listenerMap.delete(media); if (this.intersectionObserver) { this.intersectionObserver.unobserve(media); this._ioRatio.delete(media); } this.stateManager.get('media.processedMedia').delete(media); }
        attachImageListeners(image) { if (!image || this.stateManager.get('media.processedImages').has(image) || !this.intersectionObserver) return; if (this.stateManager.filterManagers.image) { injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager); } this.stateManager.get('media.processedImages').add(image); this.intersectionObserver.observe(image); }
        detachImageListeners(image) { if (!this.stateManager.get('media.processedImages').has(image)) return; if (this.intersectionObserver) this.intersectionObserver.unobserve(image); this.stateManager.get('media.processedImages').delete(image); }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, contrast: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this._mediaStateRafId = null; }
        init(stateManager) {
            super.init(stateManager);
            const isMobile = this.stateManager.get('app.isMobile');
            this.filterManager = this._createManager({ settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', className: 'vsc-video-filter-active', isImage: false });
            this.imageFilterManager = this._createManager({ settings: CONFIG.IMAGE_FILTER_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', className: 'vsc-image-filter-active', isImage: true });
            this.filterManager.init(); this.imageFilterManager.init();
            this.stateManager.filterManagers.video = this.filterManager; this.stateManager.filterManagers.image = this.imageFilterManager;
            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.subscribe('imageFilter.level', this.applyAllImageFilters.bind(this));
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates());
            this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates());
            this.subscribe('app.scriptActive', () => this.updateMediaFilterStates());
            this.throttledUpdate = throttle((e) => {
                const { slope, autoParams } = e.detail;
                this.filterManager.updateSmartLimit(slope);
                const isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.002 || Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.1 || Math.abs(this.lastAutoParams.contrast - autoParams.contrast) > 0.1;
                if (isChanged) { this.lastAutoParams = autoParams; this.applyAllVideoFilters(); }
            }, 200);
            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
            this.applyAllVideoFilters(); this.applyAllImageFilters();
        }
        destroy() { super.destroy(); if (this.throttledUpdate) document.removeEventListener('vsc-smart-limit-update', this.throttledUpdate); if(this._rafId) cancelAnimationFrame(this._rafId); if(this._imageRafId) cancelAnimationFrame(this._imageRafId); if(this._mediaStateRafId) cancelAnimationFrame(this._mediaStateRafId); }
        _createManager(options) {
            class SvgFilterManager {
                constructor(options) { 
                    this._isInitialized = false; this._styleElement = null; this._svgNode = null; this._options = options; 
                    this._elementCache = new WeakMap(); 
                    this._activeFilterRoots = new Set(); 
                    this._globalToneCache = { key: null, table: null }; 
                }
                isInitialized() { return this._isInitialized; } getSvgNode() { return this._svgNode; } getStyleNode() { return this._styleElement; }
                init() { if (this._isInitialized) return; safeExec(() => { const { svgNode, styleElement } = this._createElements(); this._svgNode = svgNode; this._styleElement = styleElement; (document.head || document.documentElement).appendChild(styleElement); (document.body || document.documentElement).appendChild(svgNode); this._activeFilterRoots.add(this._svgNode); this._isInitialized = true; }, `${this.constructor.name}.init`); }
                registerContext(svgElement) {
                     this._activeFilterRoots.add(svgElement);
                }
                _createElements() {
                    const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
                    const { settings, svgId, styleId, className, isImage } = this._options;
                    const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`;
                    const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
                    const combinedFilter = createSvgElement('filter', { id: combinedFilterId, "color-interpolation-filters": "sRGB" });
                    const smartDim = createSvgElement('feComponentTransfer', { "data-vsc-id": "smart_dimming", in: "SourceGraphic", result: "dimmed_in" });
                    ['R', 'G', 'B'].forEach(c => smartDim.append(createSvgElement('feFunc' + c, { "data-vsc-id": "smart_dim_func", type: "linear", slope: "1", intercept: "0" })));
                    
                    const blurFine = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_fine", in: "dimmed_in", stdDeviation: "0", result: "blur_fine_out" });
                    const compFine = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_fine", operator: "arithmetic", in: "dimmed_in", in2: "blur_fine_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_fine" });
                    
                    const blurCoarse = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_coarse", in: "sharpened_fine", stdDeviation: "0", result: "blur_coarse_out" });
                    const compCoarse = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_coarse", operator: "arithmetic", in: "sharpened_fine", in2: "blur_coarse_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_final" });

                    let nextStageIn = "sharpened_final";
                    
                    if (isImage) {
                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: nextStageIn, result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                        // [Visual] Green Channel Control for True White Balance
                        colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                        combinedFilter.append(smartDim, blurFine, compFine, blurCoarse, compCoarse, colorTemp);
                    } else {
                        const profileMatrix = createSvgElement('feColorMatrix', { "data-vsc-id": "profile_matrix", in: nextStageIn, type: "matrix", values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 1 0", result: "profile_out" });
                        const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: "profile_out", type: "saturate", values: (settings.SATURATION_VALUE / 100).toString(), result: "saturate_out" });
                        const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })));
                        const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));

                        const stLumaToAlpha = createSvgElement('feColorMatrix', {
                            "data-vsc-id": "st_luma_to_alpha", in: "gamma_out", type: "matrix",
                            values: "0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.2126 0.7152 0.0722 0 0",
                            result: "st_luma_a"
                        });
                        const stShadowMaskInv = createSvgElement('feComponentTransfer', { "data-vsc-id": "st_shadow_mask_inv", in: "st_luma_a", result: "st_shadow_mask_raw" },
                            createSvgElement('feFuncA', { type: "linear", slope: "-1", intercept: "1" })
                        );
                        const stShadowMaskRefined = createSvgElement('feComponentTransfer', { "data-vsc-id": "st_shadow_mask_refined", in: "st_shadow_mask_raw", result: "st_shadow_mask_final" },
                             createSvgElement('feFuncA', { "data-vsc-id": "st_shadow_exp", type: "gamma", exponent: "2.5" })
                        );
                        const stHighlightMaskRefined = createSvgElement('feComponentTransfer', { "data-vsc-id": "st_highlight_mask_refined", in: "st_luma_a", result: "st_highlight_mask_final" },
                             createSvgElement('feFuncA', { "data-vsc-id": "st_highlight_exp", type: "gamma", exponent: "2.5" })
                        );
                        const stShadowFlood = createSvgElement('feFlood', { "data-vsc-id": "st_shadow_flood", "flood-color": "#000000", "flood-opacity": "0", result: "st_shadow_color" });
                        const stHighlightFlood = createSvgElement('feFlood', { "data-vsc-id": "st_highlight_flood", "flood-color": "#000000", "flood-opacity": "0", result: "st_highlight_color" });
                        const stShadowComp = createSvgElement('feComposite', { "data-vsc-id": "st_shadow_layer", in: "st_shadow_color", in2: "st_shadow_mask_final", operator: "in", result: "st_shadow_layer_out" });
                        const stHighlightComp = createSvgElement('feComposite', { "data-vsc-id": "st_highlight_layer", in: "st_highlight_color", in2: "st_highlight_mask_final", operator: "in", result: "st_highlight_layer_out" });
                        const stShadowBlend = createSvgElement('feBlend', { "data-vsc-id": "st_blend_shadows", in: "st_shadow_layer_out", in2: "tone_out", mode: "soft-light", result: "st_blended_shadows" });
                        const stHighlightBlend = createSvgElement('feBlend', { "data-vsc-id": "st_blend_highlights", in: "st_highlight_layer_out", in2: "st_blended_shadows", mode: "soft-light", result: "split_tone_out" });

                        const finalBlur = createSvgElement('feGaussianBlur', { "data-vsc-id": "final_blur", in: "split_tone_out", stdDeviation: settings.BLUR_STD_DEVIATION, result: "final_blur_out" });

                        const noise = createSvgElement('feTurbulence', { "data-vsc-id": "noise_gen", type: "fractalNoise", baseFrequency: "0.85", numOctaves: "3", stitchTiles: "stitch", result: "raw_noise" });
                        const grayNoise = createSvgElement('feColorMatrix', { "data-vsc-id": "noise_desat", in: "raw_noise", type: "matrix", values: "0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 1 0", result: "mono_noise" });
                        
                        const ditherBlend = createSvgElement('feComposite', { "data-vsc-id": "dither_blend", operator: "arithmetic",
                            in: "final_blur_out",
                            in2: "mono_noise", k1: "0", k2: "1", k3: "0", k4: "0", result: "dither_out"
                        });
                        
                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "dither_out", result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" })); // Green Control Added
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                        
                        combinedFilter.append(smartDim, blurFine, compFine, blurCoarse, compCoarse, profileMatrix, saturation, gamma, toneCurve, stLumaToAlpha, stShadowMaskInv, stShadowMaskRefined, stHighlightMaskRefined, stShadowFlood, stHighlightFlood, stShadowComp, stHighlightComp, stShadowBlend, stHighlightBlend, finalBlur, noise, grayNoise, ditherBlend, colorTemp);
                    }
                    svg.append(combinedFilter);
                    const style = document.createElement('style'); style.id = styleId; style.textContent = `.${className} { filter: url(#${combinedFilterId}) !important; } .vsc-gpu-accelerated { transform: translateZ(0); } .vsc-btn.analyzing { box-shadow: 0 0 5px #f39c12, 0 0 10px #f39c12 inset !important; }`;
                    return { svgNode: svg, styleElement: style };
                }
                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const { saturation, gamma, blur, sharpenLevel, shadows, highlights, colorTemp, dither, profile, profileStrength, contrast } = values;
                    
                    let currentToneTable = null;
                    const toneKey = (shadows !== undefined) ? `${(+shadows).toFixed(2)}_${(+highlights).toFixed(2)}_${(+contrast).toFixed(3)}` : null;
                    if (toneKey) {
                        if (this._globalToneCache.key !== toneKey) {
                            const genSigmoidTable = (sh, hi, contrast = 1.0) => {
                                const steps = 256; const vals = [];
                                const shOffset = (sh || 0) / 200; const hiOffset = (hi || 0) / 200;
                                const c = Number.isFinite(contrast) ? contrast : 1.0;
                                const cClamped = Math.max(0.5, Math.min(2.0, c));
                                const kMin = 1.2; const kScale = 16.0;
                                const k = Math.max(0.05, kMin + (cClamped - 1.0) * kScale);
                                const sigmoid = (x, k) => 1 / (1 + Math.exp(-k * (x - 0.5)));
                                const minVal = sigmoid(0, k); const maxVal = sigmoid(1, k);
                                for (let i = 0; i < steps; i++) {
                                    let x = i / (steps - 1);
                                    let y = (sigmoid(x, k) - minVal) / (maxVal - minVal);
                                    if (Math.abs(cClamped - 1.0) < 0.01) y = x;
                                    if (x < 0.5) { const w = Math.cos(Math.PI * x); y += shOffset * w; }
                                    else { const w = Math.cos(Math.PI * (1 - x)); y += hiOffset * w; }
                                    y = Math.max(0, Math.min(1, y));
                                    vals.push(y.toFixed(4));
                                }
                                return vals.join(' ');
                            };
                            this._globalToneCache.key = toneKey;
                            this._globalToneCache.table = genSigmoidTable(shadows, highlights, contrast);
                        }
                        currentToneTable = this._globalToneCache.table;
                    }

                    const isImage = this._options.isImage;

                    // [Optimization] Safe Set Iteration (Collect -> Delete)
                    const toRemove = [];

                    for (const rootNode of this._activeFilterRoots) {
                        if (!rootNode.isConnected) {
                            toRemove.push(rootNode);
                            continue;
                        }
                        let cache = this._elementCache.get(rootNode);
                        if (!cache) {
                            cache = {
                                blurFine: rootNode.querySelector('[data-vsc-id="sharpen_blur_fine"]'), compFine: rootNode.querySelector('[data-vsc-id="sharpen_comp_fine"]'), 
                                blurCoarse: rootNode.querySelector('[data-vsc-id="sharpen_blur_coarse"]'), compCoarse: rootNode.querySelector('[data-vsc-id="sharpen_comp_coarse"]'),
                                saturate: rootNode.querySelector('[data-vsc-id="saturate"]'), gammaFuncs: rootNode.querySelectorAll('[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB'), finalBlur: rootNode.querySelector('[data-vsc-id="final_blur"]'), toneCurveFuncs: rootNode.querySelectorAll('[data-vsc-id="tone_curve"] feFuncR, [data-vsc-id="tone_curve"] feFuncG, [data-vsc-id="tone_curve"] feFuncB'),
                                ctRed: rootNode.querySelector('[data-vsc-id="ct_red"]'), ctGreen: rootNode.querySelector('[data-vsc-id="ct_green"]'), ctBlue: rootNode.querySelector('[data-vsc-id="ct_blue"]'),
                                ditherBlend: rootNode.querySelector('[data-vsc-id="dither_blend"]'), noiseGen: rootNode.querySelector('[data-vsc-id="noise_gen"]'),
                                profileMatrix: rootNode.querySelector('[data-vsc-id="profile_matrix"]'), smartDimFuncs: rootNode.querySelectorAll('[data-vsc-id="smart_dim_func"]'),
                                shadowFlood: rootNode.querySelector('[data-vsc-id="st_shadow_flood"]'), highlightFlood: rootNode.querySelector('[data-vsc-id="st_highlight_flood"]'),
                                maskShadowFunc: rootNode.querySelector('[data-vsc-id="st_shadow_exp"]'), maskHighlightFunc: rootNode.querySelector('[data-vsc-id="st_highlight_exp"]'),
                                appliedToneKey: null 
                            }; this._elementCache.set(rootNode, cache);
                        }

                        if (sharpenLevel !== undefined) {
                            let strCoarse = 0;
                            let strFine = 0;

                            // [Visual] Image Mode -> Use FINE detail (Level 2 logic) to avoid halos
                            if (isImage) {
                                strFine = Math.min(4.0, sharpenLevel * 0.12);
                                strCoarse = 0; // Disable contour sharpening for images
                            } else {
                                // Video Mode -> Level 1 is Coarse (Contour), Level 2 is Fine (Detail)
                                // [Tweak] Coarse: 0.05 strength, Fine: 0.04 strength (Slightly reduced to avoid artifacts with larger radius)
                                strCoarse = Math.min(4.0, sharpenLevel * 0.05); 
                                strFine = (values.level2 !== undefined) ? Math.min(4.0, values.level2 * 0.04) : 0; 
                            }

                            if (strFine <= 0.01) { 
                                if (cache.blurFine) cache.blurFine.setAttribute('stdDeviation', "0");
                                if (cache.compFine) { cache.compFine.setAttribute('k2', "1"); cache.compFine.setAttribute('k3', "0"); } 
                            } else { 
                                // [Visual Fix] Radius 0.5 -> 1.0 (Safe Mode) to fully avoid grid interference
                                if (cache.blurFine) cache.blurFine.setAttribute('stdDeviation', "1.0");
                                if (cache.compFine) { cache.compFine.setAttribute('k2', (1 + strFine).toFixed(3)); cache.compFine.setAttribute('k3', (-strFine).toFixed(3)); } 
                            }

                            if (strCoarse <= 0.01) { 
                                if (cache.blurCoarse) cache.blurCoarse.setAttribute('stdDeviation', "0");
                                if (cache.compCoarse) { cache.compCoarse.setAttribute('k2', "1"); cache.compCoarse.setAttribute('k3', "0"); } 
                            } else { 
                                // [Visual Fix] Radius 0.85 -> 2.0 to act as "Clarity/Structure"
                                if (cache.blurCoarse) cache.blurCoarse.setAttribute('stdDeviation', "2.0");
                                if (cache.compCoarse) { cache.compCoarse.setAttribute('k2', (1 + strCoarse).toFixed(3)); cache.compCoarse.setAttribute('k3', (-strCoarse).toFixed(3)); } 
                            }
                        }

                        if (saturation !== undefined && cache.saturate) cache.saturate.setAttribute('values', (saturation / 100).toString());
                        if (gamma !== undefined && cache.gammaFuncs) { const exp = (1 / gamma).toString(); cache.gammaFuncs.forEach(el => el.setAttribute('exponent', exp)); }
                        if (blur !== undefined && cache.finalBlur) cache.finalBlur.setAttribute('stdDeviation', blur.toString());

                        if (currentToneTable && cache.toneCurveFuncs) {
                            if (cache.appliedToneKey !== toneKey) {
                                cache.appliedToneKey = toneKey;
                                cache.toneCurveFuncs.forEach(el => el.setAttribute('tableValues', currentToneTable));
                            }
                        }

                        // [Visual] RGB 3-Channel White Balance (High Precision Tuned)
                        if (colorTemp !== undefined && cache.ctBlue && cache.ctRed && cache.ctGreen) {
                            const t = colorTemp; 
                            const warm = Math.max(0, t);
                            const cool = Math.max(0, -t);
                            
                            // Coefficients lowered by ~50% for granular control over -25 to 25 range
                            // Cool: Delicate Red/Green Reduction
                            const rSlope = 1 + warm * 0.003 - cool * 0.005; 
                            const gSlope = 1 + warm * 0.002 - cool * 0.004;
                            const bSlope = 1 - warm * 0.006 + cool * 0.000; 
                            
                            const clamp = (v) => Math.max(0.7, Math.min(1.3, v));
                            
                            cache.ctRed.setAttribute('slope', clamp(rSlope).toFixed(3));
                            cache.ctGreen.setAttribute('slope', clamp(gSlope).toFixed(3));
                            cache.ctBlue.setAttribute('slope', clamp(bSlope).toFixed(3));
                        }

                        if (dither !== undefined && cache.ditherBlend) {
                             const n = dither / 100;
                             const intensity = n * n * 0.35;
                             const freq = (0.65 + n * 0.3).toFixed(3);

                             if (cache.noiseGen) cache.noiseGen.setAttribute('baseFrequency', freq);
                             cache.ditherBlend.setAttribute('k3', intensity.toFixed(3));
                             cache.ditherBlend.setAttribute('k4', (-0.5 * intensity).toFixed(3));
                        }

                        if ((profile !== undefined || profileStrength !== undefined) && cache.profileMatrix) {
                            const I = [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0];
                            const PRESET = {
                                none: I,
                                film: [0.99, 0.01, 0.00, 0, 0, 0.00, 1.00, 0.00, 0, 0, 0.00, 0.02, 0.98, 0, 0, 0.00, 0.00, 0.00, 1, 0],
                                teal: [0.995, 0.005, 0.00, 0, 0, 0.000, 1.000, 0.00, 0, 0, 0.000, 0.040, 0.96, 0, 0, 0.000, 0.000, 0.00, 1, 0],
                                anime: [1.015, -0.0075, -0.0075, 0, 0, -0.0075, 1.015, -0.0075, 0, 0, -0.0075, -0.0075, 1.015, 0, 0, 0.0000, 0.0000, 0.0000, 1, 0],
                            };
                            const clamp01 = (v) => Math.max(0, Math.min(1, v));
                            const lerp = (a, b, t) => a + (b - a) * t;
                            const key = (profile && PRESET[profile]) ? profile : 'none';
                            const target = PRESET[key];
                            const sRaw = (key === 'none') ? 0 : (profileStrength ?? 1);
                            const s = clamp01(Number(sRaw));
                            const out = I.map((v, i) => lerp(v, target[i], s));
                            cache.profileMatrix.setAttribute('values', out.map(n => n.toFixed(4)).join(' '));

                            const PROFILE_TONING = {
                                none:  { sColor: "#000000", sOp: 0, hColor: "#000000", hOp: 0, shExp: 2.5, hiExp: 2.5 },
                                film:  { sColor: "#002a3a", sOp: 0.60, hColor: "#ffaa55", hOp: 0.40, shExp: 3.5, hiExp: 3.5 },
                                teal:  { sColor: "#004455", sOp: 0.80, hColor: "#ff9900", hOp: 0.50, shExp: 2.5, hiExp: 2.5 },
                                anime: { sColor: "#1a0033", sOp: 0.20, hColor: "#ffffff", hOp: 0.10, shExp: 1.5, hiExp: 1.5 }
                            };
                            const toneParams = PROFILE_TONING[key] || PROFILE_TONING.none;
                            const isSplitToningActive = (key !== 'none' && s > 0);
                            
                            if (cache.finalBlur) {
                                const inputSource = isSplitToningActive ? "split_tone_out" : "tone_out";
                                if (cache.finalBlur.getAttribute('in') !== inputSource) {
                                    cache.finalBlur.setAttribute('in', inputSource);
                                }
                            }

                            if (cache.shadowFlood) {
                                cache.shadowFlood.setAttribute("flood-color", toneParams.sColor);
                                cache.shadowFlood.setAttribute("flood-opacity", (toneParams.sOp * s).toString());
                            }
                            if (cache.highlightFlood) {
                                cache.highlightFlood.setAttribute("flood-color", toneParams.hColor);
                                cache.highlightFlood.setAttribute("flood-opacity", (toneParams.hOp * s).toString());
                            }
                            if (cache.maskShadowFunc) cache.maskShadowFunc.setAttribute('exponent', toneParams.shExp.toString());
                            if (cache.maskHighlightFunc) cache.maskHighlightFunc.setAttribute('exponent', toneParams.hiExp.toString());
                        }
                    }
                    toRemove.forEach(r => this._activeFilterRoots.delete(r));
                }
                updateSmartLimit(slope) {
                    if (!this.isInitialized()) return;
                    // [Optimization] Collect then delete to avoid Set iterator issues during modification
                    const toRemove = [];
                    for (const rootNode of this._activeFilterRoots) {
                         if(!rootNode.isConnected) {
                             toRemove.push(rootNode);
                             continue;
                         }
                         let cache = this._elementCache.get(rootNode);
                         if (cache && cache.smartDimFuncs) { cache.smartDimFuncs.forEach(el => el.setAttribute('slope', slope.toFixed(3))); } 
                         else { rootNode.querySelectorAll(`[data-vsc-id="smart_dim_func"]`).forEach(el => el.setAttribute('slope', slope.toFixed(3))); }
                    }
                    toRemove.forEach(r => this._activeFilterRoots.delete(r));
                }
            }
            return new SvgFilterManager(options);
        }
        applyAllVideoFilters() {
            if (this._rafId) return;
            this._rafId = requestAnimationFrame(() => {
                this._rafId = null;
                this._applyAllVideoFiltersActual();
            });
        }
        _applyAllVideoFiltersActual() {
            if (!this.filterManager.isInitialized()) return;
            const vf = this.stateManager.get('videoFilter');

            const strength = (vf.profileStrength !== undefined) ? vf.profileStrength : 1.0;
            const lerp = (start, end, amt) => start + (end - start) * amt;

            const profile = vf.activeProfile;
            const PROFILE_PARAMS = {
              none:  { sat: 1.00, gamma: 1.00, contrast: 1.00 },
              film:  { sat: 0.95, gamma: 1.05, contrast: 1.35 },
              teal:  { sat: 1.00, gamma: 1.10, contrast: 1.25 },
              anime: { sat: 1.30, gamma: 1.25, contrast: 1.15 },
            };

            const params = PROFILE_PARAMS[profile] || PROFILE_PARAMS.none;

            const targetContrast = params.contrast !== undefined ? params.contrast : 1.0;
            const effectiveContrastScale = lerp(1.0, targetContrast, strength);

            const effectiveSatScale = lerp(1.0, params.sat, strength);
            const effectiveGammaScale = lerp(1.0, params.gamma, strength);

            const saturationFinal = Math.max(0, Math.min(200, vf.saturation * effectiveSatScale));
            const autoGamma = this.lastAutoParams.gamma || 1.0;
            const finalGamma = vf.gamma * effectiveGammaScale * autoGamma;

            const finalHighlights = vf.highlights + (this.lastAutoParams.bright || 0);
            const finalShadows = vf.shadows + (this.lastAutoParams.contrast || 0);

            const values = {
                saturation: saturationFinal,
                gamma: finalGamma,
                blur: vf.blur,
                sharpenLevel: vf.level,     
                level2: vf.level2,          
                shadows: finalShadows,
                highlights: finalHighlights,
                colorTemp: vf.colorTemp,
                dither: vf.dither,
                profile: vf.activeProfile,
                profileStrength: vf.profileStrength,
                contrast: effectiveContrastScale
            };
            this.filterManager.updateFilterValues(values);
            VideoAnalyzer.updateSettings({ smartLimit: vf.smartLimit, autoTone: vf.autoTone });
            this.updateMediaFilterStates();
        }
        applyAllImageFilters() { 
            if (this._imageRafId) return;
            this._imageRafId = requestAnimationFrame(() => {
                this._imageRafId = null;
                if (!this.imageFilterManager.isInitialized()) return; 
                const level = this.stateManager.get('imageFilter.level'); 
                const colorTemp = this.stateManager.get('imageFilter.colorTemp'); 
                const values = { sharpenLevel: level, colorTemp: colorTemp }; 
                this.imageFilterManager.updateFilterValues(values); 
                this.updateMediaFilterStates();
            });
        }
        updateMediaFilterStates() { 
            if (this._mediaStateRafId) return;
            this._mediaStateRafId = requestAnimationFrame(() => {
                this._mediaStateRafId = null;
                this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO') this._updateVideoFilterState(media); }); 
                this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); });
            });
        }
        _updateVideoFilterState(video) { const scriptActive = this.stateManager.get('app.scriptActive'); const vf = this.stateManager.get('videoFilter'); const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.blur > 0 || vf.shadows !== 0 || vf.highlights !== 0 || vf.colorTemp !== 0 || vf.dither > 0 || vf.smartLimit > 0 || vf.autoTone > 0 || vf.activeProfile !== 'none'; const isActive = scriptActive && video.dataset.isVisible !== 'false' && shouldApply; if (isActive) { if (video.style.willChange !== 'filter, transform') video.style.willChange = 'filter, transform'; } else { if (video.style.willChange) video.style.willChange = ''; } video.classList.toggle('vsc-video-filter-active', isActive); }
        _updateImageFilterState(image) { const scriptActive = this.stateManager.get('app.scriptActive'); const level = this.stateManager.get('imageFilter.level'); const colorTemp = this.stateManager.get('imageFilter.colorTemp'); const shouldApply = level > 0 || colorTemp !== 0; image.classList.toggle('vsc-image-filter-active', scriptActive && image.dataset.isVisible !== 'false' && shouldApply); }
    }

    class LiveStreamPlugin extends Plugin {
        constructor() { super('LiveStream'); this.video = null; this.avgDelay = null; this.intervalId = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL; }
        init(stateManager) { super.init(stateManager); this.subscribe('liveStream.isRunning', (isRunning) => { if (isRunning) this.start(); else this.stop(); }); this.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge()); this.subscribe('liveStream.resetRequested', () => { if (this.stateManager.get('liveStream.isRunning')) { this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; console.log('[VSC] Live stream delay meter reset.'); } }); if (CONFIG.LIVE_STREAM_SITES.some(d => location.href.includes(d))) this.stateManager.set('liveStream.isRunning', true); }
        destroy() { super.destroy(); this.stop(); }
        switchInterval(newInterval) { if (this.currentInterval === newInterval) return; clearInterval(this.intervalId); this.currentInterval = newInterval; this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        findVideo() { const visibleVideos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO' && m.dataset.isVisible === 'true'); if (visibleVideos.length === 0) return null; return visibleVideos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]; }
        calculateDelay(v) { if (!v) return null; if (typeof v.liveLatency === 'number' && v.liveLatency > 0) return v.liveLatency * 1000; if (v.buffered && v.buffered.length > 0) { try { const end = v.buffered.end(v.buffered.length - 1); if (v.currentTime > end) return 0; return Math.max(0, (end - v.currentTime) * 1000); } catch { return null; } } return null; }
        getSmoothPlaybackRate(currentDelay, targetDelay) { const error = currentDelay - targetDelay; this.pidIntegral += error; const derivative = error - this.lastError; this.lastError = error; let rateChange = CONFIG.AUTODELAY_PID_KP * error + CONFIG.AUTODELAY_PID_KI * this.pidIntegral + CONFIG.AUTODELAY_PID_KD * derivative; return Math.max(CONFIG.AUTODELAY_MIN_RATE, Math.min(1 + rateChange, CONFIG.AUTODELAY_MAX_RATE)); }
        checkAndAdjust() { if (Math.abs(this.stateManager.get('playback.targetRate') - 1.0) > 0.01) return; this.video = this.findVideo(); if (!this.video) return; const rawDelay = this.calculateDelay(this.video); if (rawDelay === null) { this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: null, rate: this.video.playbackRate }); return; } this.avgDelay = this.avgDelay === null ? rawDelay : CONFIG.AUTODELAY_EMA_ALPHA * rawDelay + (1 - CONFIG.AUTODELAY_EMA_ALPHA) * this.avgDelay; this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: rawDelay, rate: this.video.playbackRate }); const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY; const error = this.avgDelay - targetDelay; if (Math.abs(error) < CONFIG.AUTODELAY_STABLE_THRESHOLD) this.consecutiveStableChecks++; else { this.consecutiveStableChecks = 0; if (this.isStable) { this.isStable = false; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_NORMAL); } } if (this.consecutiveStableChecks >= CONFIG.AUTODELAY_STABLE_COUNT && !this.isStable) { this.isStable = true; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_STABLE); } let newRate; const bufferHealth = (this.video.buffered && this.video.buffered.length) ? (this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime) : 10; if ((this.avgDelay !== null && this.avgDelay <= targetDelay) || bufferHealth < CONFIG.MIN_BUFFER_HEALTH_SEC) { newRate = 1.0; this.pidIntegral = 0; this.lastError = 0; } else { newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay); } if (Math.abs(this.video.playbackRate - newRate) > 0.001) { this.video.playbackRate = newRate; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { const isLiveNow = this.avgDelay !== null && this.avgDelay < (CONFIG.DEFAULT_TARGET_DELAY + 500); liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080'; } }
        start() { if (this.intervalId) return; setTimeout(() => { this.stateManager.set('liveStream.delayInfo', { raw: null, avg: null, rate: 1.0 }); }, 0); this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        stop() { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { liveJumpBtn.style.boxShadow = ''; } this.stateManager.set('liveStream.delayInfo', null); this.video = null; this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL; }
        seekToLiveEdge() { const videos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO'); if (videos.length === 0) return; const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY; videos.forEach(v => { try { const seekableEnd = (v.seekable && v.seekable.length > 0) ? v.seekable.end(v.seekable.length - 1) : Infinity; const bufferedEnd = (v.buffered && v.buffered.length > 0) ? v.buffered.end(v.buffered.length - 1) : 0; const liveEdge = Math.min(seekableEnd, bufferedEnd); if (!isFinite(liveEdge)) return; const delayMs = (liveEdge - v.currentTime) * 1000; if (delayMs <= targetDelay) return; if (!v._lastLiveJump) v._lastLiveJump = 0; if (Date.now() - v._lastLiveJump < CONFIG.LIVE_JUMP_INTERVAL) return; if (liveEdge - v.currentTime < CONFIG.LIVE_JUMP_END_THRESHOLD) return; v._lastLiveJump = Date.now(); v.currentTime = liveEdge - 0.5; if (v.paused) v.play().catch(console.warn); } catch (e) { console.error('[VSC] seekToLiveEdge error:', e); } }); }
    }

    class PlaybackControlPlugin extends Plugin {
        init(stateManager) { super.init(stateManager); this.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate)); }
        setPlaybackRate(rate) { this.stateManager.get('media.activeMedia').forEach(media => { if (media.playbackRate !== rate) media.playbackRate = rate; }); }
    }

    class AudioEffectPlugin extends Plugin {
        constructor() {
            super('AudioEffect');
            this.ctx = null;
            this.targetVideo = null;
            this.effectsEnabled = false;
            this.nodeMap = new Map();
            this.nodes = { bypassGain: null, convolver: null, wetGain: null, masterGain: null, bassFilter: null, compressor: null, makeupGain: null };
        }
        init(stateManager) {
            super.init(stateManager);
            const unlock = async () => { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') await this.ctx.resume(); } catch {} };
            document.addEventListener('pointerdown', unlock, { capture: true, once: true });
            document.addEventListener('keydown', unlock, { capture: true, once: true });
            this.subscribe('audio.bass', () => this.updateAudioParams());
            this.subscribe('audio.reverb', () => this.updateAudioParams());
            this.subscribe('audio.pitch', () => this.updatePitchState());
            this.subscribe('media.activeMedia', (newSet) => this.handleMediaChanges(newSet));
        }
        destroy() {
            super.destroy();
            if (this.ctx && this.ctx.state !== 'closed') { this.ctx.close().catch(() => {}); this.ctx = null; }
            this.nodes = { bypassGain: null, convolver: null, wetGain: null, masterGain: null, bassFilter: null, compressor: null, makeupGain: null };
            this.nodeMap.clear();
        }
        async handleMediaChanges(activeMedia) {
             if (!this.ctx || this.ctx.state !== 'running') { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') await this.ctx.resume(); } catch(e) {} }
             if (!this.ctx || this.ctx.state !== 'running') return;

             this.ensureGlobalNodes();
             const currentVideos = Array.from(activeMedia).filter(m => m.tagName === 'VIDEO');
             for (const [video, nodes] of this.nodeMap.entries()) {
                 if (!video.isConnected) {
                     try {
                         nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
                         setTimeout(() => { try { nodes.source.disconnect(); nodes.gain.disconnect(); } catch(e) {} }, 200);
                     } catch(e) {}
                     this.nodeMap.delete(video);
                 } else if (!activeMedia.has(video)) {
                     try { nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); } catch(e) {}
                 }
             }

             let mainVideo = null; let maxArea = 0;
             currentVideos.forEach(v => { const area = v.clientWidth * v.clientHeight; if(area > maxArea) { maxArea = area; mainVideo = v; } });
             currentVideos.forEach(video => {
                 if (!this.nodeMap.has(video)) {
                     try {
                         const source = this.ctx.createMediaElementSource(video);
                         const individualGain = this.ctx.createGain();
                         individualGain.gain.value = 0;
                         source.connect(individualGain);
                         individualGain.connect(this.nodes.masterGain);
                         this.nodeMap.set(video, { source, gain: individualGain });
                     } catch(e) {}
                 }
             });
             const now = this.ctx.currentTime;
             currentVideos.forEach(video => {
                 const nodeData = this.nodeMap.get(video);
                 if(!nodeData) return;
                 const targetGain = (video === mainVideo) ? 1.0 : 0.0;
                 try { nodeData.gain.gain.cancelScheduledValues(now); nodeData.gain.gain.setTargetAtTime(targetGain, now, 0.1); } catch(e) {}
             });
             if (this.targetVideo !== mainVideo) { this.targetVideo = mainVideo; if(this.targetVideo) { this.updatePitchState(); this.updateAudioParams(); } }
        }
        ensureGlobalNodes() {
            if (this.nodes.masterGain) return;
            this.nodes.masterGain = this.ctx.createGain(); this.nodes.bypassGain = this.ctx.createGain(); this.nodes.effectInputGain = this.ctx.createGain();
            this.nodes.bassFilter = this.ctx.createBiquadFilter(); this.nodes.bassFilter.type = 'lowshelf'; this.nodes.bassFilter.frequency.value = CONFIG.AUDIO_BASS_FREQ; this.nodes.bassFilter.Q.value = 0.8;
            this.nodes.compressor = this.ctx.createDynamicsCompressor(); this.nodes.makeupGain = this.ctx.createGain();
            this.nodes.convolver = this.ctx.createConvolver(); this.nodes.convolver.buffer = this.makeImpulseResponse(2.2, 3.0); this.nodes.wetGain = this.ctx.createGain();
            this.nodes.masterGain.connect(this.nodes.bypassGain); this.nodes.bypassGain.connect(this.ctx.destination);
            this.nodes.masterGain.connect(this.nodes.effectInputGain);
            this.nodes.effectInputGain.connect(this.nodes.bassFilter); this.nodes.bassFilter.connect(this.nodes.compressor); this.nodes.compressor.connect(this.nodes.makeupGain); this.nodes.makeupGain.connect(this.ctx.destination);
            this.nodes.effectInputGain.connect(this.nodes.convolver); this.nodes.convolver.connect(this.nodes.wetGain); this.nodes.wetGain.connect(this.ctx.destination);
            this.nodes.bypassGain.gain.value = 1.0; this.nodes.effectInputGain.gain.value = 0.0;
        }
        smoothSet(param, value, timeConstant = 0.02) { if (!this.ctx || !param) return; const now = this.ctx.currentTime; try { param.cancelScheduledValues(now); param.setTargetAtTime(value, now, timeConstant); } catch (e) {} }
        updatePitchState() { if (!this.targetVideo) return; const preserve = this.stateManager.get('audio.pitch'); if ('preservesPitch' in this.targetVideo) this.targetVideo.preservesPitch = preserve; else if ('mozPreservesPitch' in this.targetVideo) this.targetVideo.mozPreservesPitch = preserve; else if ('webkitPreservesPitch' in this.targetVideo) this.targetVideo.webkitPreservesPitch = preserve; }
        async updateAudioParams() {
            const bass = this.stateManager.get('audio.bass') || 0; const reverb = this.stateManager.get('audio.reverb') || 0;
            if (!this.ctx || this.ctx.state !== 'running') return;
            this.ensureGlobalNodes();
            const isEffectActive = (bass > 0 || reverb > 0);
            this.effectsEnabled = isEffectActive;
            if (isEffectActive) {
                this.smoothSet(this.nodes.bypassGain.gain, 0.0); this.smoothSet(this.nodes.effectInputGain.gain, 1.0);
                this.smoothSet(this.nodes.bassFilter.gain, bass * CONFIG.AUDIO_BASS_MAX_DB);
                this.smoothSet(this.nodes.makeupGain.gain, 1.0 + (bass * 0.3));
                this.smoothSet(this.nodes.wetGain.gain, Math.max(0, Math.min(1, reverb)));
            } else { this.smoothSet(this.nodes.bypassGain.gain, 1.0); this.smoothSet(this.nodes.effectInputGain.gain, 0.0); }
        }
        makeImpulseResponse(durationSec, decay) { const rate = this.ctx.sampleRate; const length = rate * durationSec; const impulse = this.ctx.createBuffer(2, length, rate); const left = impulse.getChannelData(0); const right = impulse.getChannelData(1); for (let i = 0; i < length; i++) { const t = i / length; const amp = Math.pow(1 - t, decay); left[i] = (Math.random() * 2 - 1) * amp; right[i] = (Math.random() * 2 - 1) * amp; } return impulse; }
    }

    class NavigationPlugin extends Plugin {
        constructor(pluginManager) { super('Navigation'); this.pluginManager = pluginManager; this.spaNavigationHandler = debounce(this.handleNavigation.bind(this), 100); }
        init(stateManager) { super.init(stateManager); if (history._vscWrapped) return; history._vscWrapped = true; const wrapHistory = (type) => { const orig = history[type]; return (...args) => { const rv = orig.apply(history, args); this.spaNavigationHandler(); return rv; }; }; history.pushState = wrapHistory('pushState'); history.replaceState = wrapHistory('replaceState'); window.addEventListener('popstate', this.spaNavigationHandler); }
        destroy() { super.destroy(); window.removeEventListener('popstate', this.spaNavigationHandler); }
        handleNavigation() { const currentUrl = location.href; if (currentUrl === this.stateManager.get('ui.lastUrl')) return; this.stateManager.set('ui.lastUrl', currentUrl); console.log('[VSC] SPA Navigation Detected.'); const corePlugin = this.pluginManager.plugins.find(p => p.name === 'CoreMedia'); if (corePlugin) { corePlugin.scanAndApply(); [500, 1000, 2000].forEach(delay => { setTimeout(() => corePlugin.scanAndApply(), delay); }); } }
    }

    class UIPlugin extends Plugin {
        constructor() { super('UI'); this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null; this.hostElement = null; this.shadowRoot = null; this.fadeOutTimer = null; this.isDragging = false; this.wasDragged = false; this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 }; this.animationFrameId = null; this.delayMeterEl = null; this.speedButtons = []; this.uiElements = {}; this.modalHost = null; this.modalShadowRoot = null; this.uiState = { x: 0, y: 0 }; this.boundFullscreenChange = null; this.boundSmartLimitUpdate = null; }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('ui.createRequested', () => { if (!this.globalContainer) { this.createGlobalUI(); this.stateManager.set('ui.globalContainer', this.globalContainer); } });
            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            this.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info));
            this.subscribe('liveStream.isPinned', () => this.updateDelayMeterVisibility());
            this.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());
            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));
            const vscMessage = sessionStorage.getItem('vsc_message'); if (vscMessage) { this.showWarningMessage(vscMessage); sessionStorage.removeItem('vsc_message'); }
            this.boundFullscreenChange = () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } };
            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
        }
        destroy() {
            super.destroy();
            if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; }
            if (this.modalHost) { this.modalHost.remove(); this.modalHost = null; }
            if (this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; }
            if (this.boundFullscreenChange) document.removeEventListener('fullscreenchange', this.boundFullscreenChange);
            if (this.boundSmartLimitUpdate) document.removeEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);
        }
        showWarningMessage(message) { if (!message) return; let warningEl = document.getElementById('vsc-warning-bar'); if (warningEl) { warningEl.querySelector('span').textContent = message; warningEl.style.opacity = '1'; if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout); } else { warningEl = document.createElement('div'); warningEl.id = 'vsc-warning-bar'; Object.assign(warningEl.style, { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px', borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '15px', fontSize: '14px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.5s ease-in-out', maxWidth: '90%', }); const messageSpan = document.createElement('span'); messageSpan.textContent = message; const closeBtn = document.createElement('button'); Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' }); closeBtn.textContent = '×'; closeBtn.onclick = () => warningEl.style.opacity = '0'; warningEl.append(messageSpan, closeBtn); document.body.appendChild(warningEl); setTimeout(() => (warningEl.style.opacity = '1'), 100); } warningEl.hideTimeout = setTimeout(() => { warningEl.style.opacity = '0'; }, CONFIG.UI_WARN_TIMEOUT); }
        updateDelayMeterVisibility() {
            if (this.delayMeterEl) {
                const controlsVisible = this.stateManager.get('ui.areControlsVisible');
                const isPinned = this.stateManager.get('liveStream.isPinned');
                this.delayMeterEl.style.display = (controlsVisible || isPinned) ? 'flex' : 'none';
            }
        }
        updateDelayMeter(info) { if (!info && this.delayMeterEl && !this.stateManager.get('liveStream.isPinned')) { this.delayMeterEl.remove(); this.delayMeterEl = null; return; } if (info && !this.delayMeterEl && document.body) { this.delayMeterEl = document.createElement('div'); Object.assign(this.delayMeterEl.style, { position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }); const textSpan = document.createElement('span'); const pinBtn = document.createElement('button'); pinBtn.textContent = '📌'; pinBtn.title = '항상 표시'; Object.assign(pinBtn.style, { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '12px', padding: '0 2px' }); pinBtn.onclick = () => { const cur = this.stateManager.get('liveStream.isPinned'); this.stateManager.set('liveStream.isPinned', !cur); pinBtn.style.color = !cur ? '#f39c12' : '#fff'; }; const refreshBtn = document.createElement('button'); refreshBtn.textContent = '🔄'; refreshBtn.title = '딜레이 측정 초기화'; Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); refreshBtn.onclick = () => { this.stateManager.set('liveStream.resetRequested', Date.now()); if (textSpan) { textSpan.textContent = '딜레이 리셋 중...'; } }; const closeBtn = document.createElement('button'); closeBtn.textContent = '✖'; closeBtn.title = '닫기'; Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); closeBtn.onclick = () => { this.stateManager.set('liveStream.isRunning', false); this.stateManager.set('liveStream.isPinned', false); }; this.delayMeterEl.append(pinBtn, textSpan, refreshBtn, closeBtn); document.body.appendChild(this.delayMeterEl); this.updateDelayMeterVisibility(); } if (this.delayMeterEl) { const textSpan = this.delayMeterEl.querySelector('span'); if (textSpan) { if (info && info.raw === null && info.avg === null) { textSpan.textContent = '딜레이 측정 중...'; } else if (info) { textSpan.textContent = `딜레이: ${info.avg?.toFixed(0) || 'N/A'}ms / 현재: ${info.raw?.toFixed(0) || 'N/A'}ms / 배속: ${info.rate?.toFixed(3) || 'N/A'}x`; } } } }
        resetFadeTimer() { const container = this.uiElements.mainContainer; if (container) { clearTimeout(this.fadeOutTimer); container.style.opacity = '1'; } }
        startFadeSequence() { const container = this.uiElements.mainContainer; if (container) { container.querySelectorAll('.vsc-control-group.submenu-visible').forEach(g => g.classList.remove('submenu-visible')); container.style.opacity = '0.3'; } }
        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile'); this.globalContainer = document.createElement('div'); this.globalContainer.style.setProperty('--vsc-translate-x', '0px'); this.globalContainer.style.setProperty('--vsc-translate-y', '0px'); Object.assign(this.globalContainer.style, { position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%) translate(var(--vsc-translate-x), var(--vsc-translate-y))', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'flex-start', gap: '5px', WebkitTapHighlightColor: 'transparent' }); this.mainControlsContainer = document.createElement('div'); Object.assign(this.mainControlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }); this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡'; Object.assign(this.triggerElement.style, { width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none', fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', transition: 'box-shadow 0.3s ease-in-out, background-color 0.3s', order: '1', touchAction: 'none', }); this.triggerElement.addEventListener('click', (e) => { if (this.wasDragged) { e.stopPropagation(); return; } if (!this.stateManager.get('app.scriptActive')) { this.stateManager.set('app.scriptActive', true); } const isVisible = this.stateManager.get('ui.areControlsVisible'); this.stateManager.set('ui.areControlsVisible', !isVisible); }); this.speedButtonsContainer = document.createElement('div'); this.speedButtonsContainer.id = 'vsc-speed-buttons-container'; this.speedButtonsContainer.style.cssText = `display:none; flex-direction:column; gap:5px; align-items:center; background: transparent; border-radius: 0px; padding: 0px;`; this.attachDragAndDrop(); this.mainControlsContainer.appendChild(this.triggerElement); this.globalContainer.appendChild(this.mainControlsContainer); this.globalContainer.appendChild(this.speedButtonsContainer); document.body.appendChild(this.globalContainer);
        }
        onControlsVisibilityChange(isVisible) {
            if (!this.triggerElement) return;
            if (isVisible) { this.triggerElement.textContent = '🛑'; this.triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)'; const savedVideoSettings = this.stateManager.get('videoFilter.lastActiveSettings'); if (savedVideoSettings) { for (const key in savedVideoSettings) { this.stateManager.set(`videoFilter.${key}`, savedVideoSettings[key]); } this.stateManager.set('videoFilter.lastActiveSettings', null); } const savedImageSettings = this.stateManager.get('imageFilter.lastActiveSettings'); if (savedImageSettings) { this.stateManager.set('imageFilter.level', savedImageSettings.level); this.stateManager.set('imageFilter.lastActiveSettings', null); } }
            else { this.triggerElement.textContent = '⚡️'; this.triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)'; const videoState = this.stateManager.get('videoFilter'); const videoSettingsToSave = { level: videoState.level, level2: videoState.level2, gamma: videoState.gamma, blur: videoState.blur, shadows: videoState.shadows, highlights: videoState.highlights, saturation: videoState.saturation, colorTemp: videoState.colorTemp, dither: videoState.dither, smartLimit: videoState.smartLimit, autoTone: videoState.autoTone, activePreset: videoState.activePreset, activeProfile: videoState.activeProfile }; this.stateManager.set('videoFilter.lastActiveSettings', videoSettingsToSave); const imageState = this.stateManager.get('imageFilter'); this.stateManager.set('imageFilter.lastActiveSettings', { level: imageState.level }); }
            if (isVisible && !this.hostElement) { this.createControlsHost(); } if (this.hostElement) { this.hostElement.style.display = isVisible ? 'flex' : 'none'; } if (this.speedButtonsContainer) { const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO'); this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none'; } this.updateUIVisibility();
        }
        createControlsHost() { this.hostElement = document.createElement('div'); this.hostElement.style.order = '2'; this.stateManager.set('ui.hostElement', this.hostElement); this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' }); this.stateManager.set('ui.shadowRoot', this.shadowRoot); this.modalHost = document.createElement('div'); this.modalShadowRoot = this.modalHost.attachShadow({ mode: 'open' }); const currentRoot = document.fullscreenElement || document.body; currentRoot.appendChild(this.modalHost); this.renderAllControls(); this.mainControlsContainer.prepend(this.hostElement); }
        updateUIVisibility() { if (!this.shadowRoot) return; const controlsVisible = this.stateManager.get('ui.areControlsVisible'); const activeMedia = this.stateManager.get('media.activeMedia'); const activeImages = this.stateManager.get('media.activeImages'); const hasVideo = [...activeMedia].some(m => m.tagName === 'VIDEO'); const hasImage = activeImages.size > 0; if (this.speedButtonsContainer) { this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none'; } const setVisible = (element, visible) => { if (element) element.classList.toggle(CONFIG.UI_HIDDEN_CLASS_NAME, !visible); }; setVisible(this.uiElements.videoControls, hasVideo); setVisible(this.uiElements.imageControls, hasImage); }
        updateActiveSpeedButton(rate) { if (this.speedButtons.length === 0) return; this.speedButtons.forEach(b => { const speed = parseFloat(b.dataset.speed); if (speed) { const isActive = Math.abs(speed - rate) < 0.01; if (isActive) { b.style.background = 'rgba(231, 76, 60, 0.9)'; b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset'; } else { b.style.background = 'rgba(52, 152, 219, 0.7)'; b.style.boxShadow = ''; } } }); }
        _createControlGroup(id, icon, title, parent) { const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group'; const mainBtn = document.createElement('button'); mainBtn.className = 'vsc-btn vsc-btn-main'; mainBtn.textContent = icon; mainBtn.title = title; const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu'; group.append(mainBtn, subMenu); mainBtn.onclick = async (e) => { e.stopPropagation(); const isOpening = !group.classList.contains('submenu-visible'); if (this.shadowRoot) { this.shadowRoot.querySelectorAll('.vsc-control-group').forEach(g => g.classList.remove('submenu-visible')); } if (isOpening) { group.classList.add('submenu-visible'); } this.resetFadeTimer(); }; parent.appendChild(group); if (id === 'vsc-image-controls') this.uiElements.imageControls = group; if (id === 'vsc-video-controls') this.uiElements.videoControls = group; return subMenu; }
        _createSlider(label, id, min, max, step, stateKey, unit, formatFn) { const div = document.createElement('div'); div.className = 'slider-control'; const labelEl = document.createElement('label'); const span = document.createElement('span'); const updateText = (v) => { const val = parseFloat(v); if (isNaN(val)) return; span.textContent = formatFn ? formatFn(val) : `${val.toFixed(1)}${unit}`; }; labelEl.textContent = `${label}: `; labelEl.appendChild(span); const slider = document.createElement('input'); slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step; slider.value = this.stateManager.get(stateKey); const debouncedSetState = debounce((val) => { this.stateManager.set(stateKey, val); }, 50); slider.oninput = () => { const val = parseFloat(slider.value); updateText(val); if (stateKey.startsWith('videoFilter.')) { this.stateManager.set('videoFilter.activePreset', 'custom'); } debouncedSetState(val); }; this.subscribe(stateKey, (val) => { updateText(val); if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; } }); updateText(slider.value); div.append(labelEl, slider); return { control: div, slider: slider, formatFn: formatFn, unit: unit }; }
        renderAllControls() { if (this.shadowRoot.getElementById('vsc-main-container')) return; const style = document.createElement('style'); const isMobile = this.stateManager.get('app.isMobile'); style.textContent = `:host { pointer-events: none; } * { pointer-events: auto; -webkit-tap-highlight-color: transparent; } #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; opacity: 0.3; transition: opacity 0.3s; } #vsc-main-container:hover { opacity: 1; } #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap:5px;} .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; background: rgba(0,0,0,0.7); border-radius: 8px; } .${CONFIG.UI_HIDDEN_CLASS_NAME} { display: none !important; } .vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 40%; transform: translateY(-40%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.9); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '2px' : '3px'}; } #vsc-video-controls .vsc-submenu { width: ${isMobile ? '240px' : '300px'}; max-width: 80vw; } #vsc-image-controls .vsc-submenu { width: 260px; } .vsc-control-group.submenu-visible .vsc-submenu { display: flex; } .vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(${isMobile ? '11px, 1.8vmin, 13px' : '12px, 2vmin, 14px'}); white-space: nowrap; } .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; } .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; } .vsc-btn-main { font-size: clamp(${isMobile ? '14px, 2.5vmin, 16px' : '15px, 3vmin, 18px'}); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; background: none; } .slider-control { display: flex; flex-direction: column; gap: ${isMobile ? '2px' : '4px'}; } .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '12px' : '13px'}; color: white; align-items: center; } input[type=range] { width: 100%; margin: 0; } input[type=range]:disabled { opacity: 0.5; } .vsc-monitor { font-size: 10px; color: #aaa; margin-top: 5px; text-align: center; border-top: 1px solid #444; padding-top: 3px; }`; this.shadowRoot.appendChild(style); const mainContainer = document.createElement('div'); mainContainer.id = 'vsc-main-container'; this.uiElements.mainContainer = mainContainer; const controlsContainer = document.createElement('div'); controlsContainer.id = 'vsc-controls-container'; const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', controlsContainer); const videoProfileContainer = document.createElement('div'); videoProfileContainer.style.cssText = 'display: flex; gap: 4px; margin-bottom: 8px; width: 100%; border-bottom: 1px solid #555; padding-bottom: 4px;'; const createProfileBtn = (text, profileKey) => { const btn = document.createElement('button'); btn.className = 'vsc-btn'; btn.textContent = text; btn.onclick = () => { const current = this.stateManager.get('videoFilter.activeProfile'); this.stateManager.set('videoFilter.activeProfile', current === profileKey ? 'none' : profileKey); }; this.subscribe('videoFilter.activeProfile', (val) => { btn.classList.toggle('active', val === profileKey); }); return btn; }; const videoResetBtn = document.createElement('button'); videoResetBtn.className = 'vsc-btn'; videoResetBtn.textContent = '↺'; videoResetBtn.title = '전체 초기화'; videoResetBtn.onclick = () => { this.stateManager.set('videoFilter.level', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL); this.stateManager.set('videoFilter.level2', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL_2); this.stateManager.set('videoFilter.activePreset', 'reset'); }; videoProfileContainer.append(createProfileBtn('Film', 'film'), createProfileBtn('Teal', 'teal'), createProfileBtn('Anime', 'anime'), videoResetBtn); videoSubMenu.appendChild(videoProfileContainer); const videoSsharpBtn = document.createElement('button'); videoSsharpBtn.className = 'vsc-btn'; videoSsharpBtn.textContent = 'S'; videoSsharpBtn.dataset.presetKey = 'sharpS'; videoSsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 15); this.stateManager.set('videoFilter.level2', 15); this.stateManager.set('videoFilter.activePreset', 'sharpS'); }; const videoMsharpBtn = document.createElement('button'); videoMsharpBtn.className = 'vsc-btn'; videoMsharpBtn.textContent = 'M'; videoMsharpBtn.dataset.presetKey = 'sharpM'; videoMsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 30); this.stateManager.set('videoFilter.level2', 30); this.stateManager.set('videoFilter.activePreset', 'sharpM'); }; const videoLsharpBtn = document.createElement('button'); videoLsharpBtn.className = 'vsc-btn'; videoLsharpBtn.textContent = 'L'; videoLsharpBtn.dataset.presetKey = 'sharpL'; videoLsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 50); this.stateManager.set('videoFilter.level2', 50); this.stateManager.set('videoFilter.activePreset', 'sharpL'); }; const videoSsharpOFFBtn = document.createElement('button'); videoSsharpOFFBtn.className = 'vsc-btn'; videoSsharpOFFBtn.textContent = '끔'; videoSsharpOFFBtn.dataset.presetKey = 'sharpOFF'; videoSsharpOFFBtn.onclick = () => { this.stateManager.set('videoFilter.level', 0); this.stateManager.set('videoFilter.level2', 0); this.stateManager.set('videoFilter.activePreset', 'sharpOFF'); }; const mkBtn = (txt, key, onClick) => { const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = txt; b.dataset.presetKey = key; b.onclick = () => { onClick(); this.stateManager.set('videoFilter.activePreset', key); }; return b; }; const videoSBrightenBtn = mkBtn('S', 'brighten1', () => { this.stateManager.set('videoFilter.gamma', 1.04); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -1); this.stateManager.set('videoFilter.highlights', 5); }); const videoMBrightenBtn = mkBtn('M', 'brighten2', () => { this.stateManager.set('videoFilter.gamma', 1.08); this.stateManager.set('videoFilter.saturation', 101); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -2); this.stateManager.set('videoFilter.highlights', 10); }); const videoLBrightenBtn = mkBtn('L', 'brighten3', () => { this.stateManager.set('videoFilter.gamma', 1.12); this.stateManager.set('videoFilter.saturation', 102); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -3); this.stateManager.set('videoFilter.highlights', 15); }); const videoDSBrightenBtn = mkBtn('DS', 'brighten4', () => { this.stateManager.set('videoFilter.gamma', 1.02); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -2); this.stateManager.set('videoFilter.highlights', -2); }); const videoDMBrightenBtn = mkBtn('DM', 'brighten5', () => { this.stateManager.set('videoFilter.gamma', 1.04); this.stateManager.set('videoFilter.saturation', 101); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -4); this.stateManager.set('videoFilter.highlights', 5); }); const videoDLBrightenBtn = mkBtn('DL', 'brighten6', () => { this.stateManager.set('videoFilter.gamma', 1.06); this.stateManager.set('videoFilter.saturation', 102); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', -8); this.stateManager.set('videoFilter.highlights', 15); }); const videoBrightenoffBtn = mkBtn('끔', 'brightOFF', () => { this.stateManager.set('videoFilter.gamma', 1.00); this.stateManager.set('videoFilter.saturation', 100); this.stateManager.set('videoFilter.blur', 0); this.stateManager.set('videoFilter.shadows', 0); this.stateManager.set('videoFilter.highlights', 0); this.stateManager.set('videoFilter.colorTemp', 0); this.stateManager.set('videoFilter.profileStrength', 0.5); }); const videoButtonsContainer = document.createElement('div'); videoButtonsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; width: 100%; padding-bottom: 4px; border-bottom: 1px solid #555;'; const createLabel = (text) => { const span = document.createElement('span'); span.textContent = text; span.style.cssText = 'color: white; font-weight: bold; font-size: 12px; margin-right: 4px; white-space: nowrap; min-width: 30px; text-align: right; text-shadow: 1px 1px 1px rgba(0,0,0,0.8);'; return span; }; const videoBtnGroup1 = document.createElement('div'); videoBtnGroup1.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px;'; videoBtnGroup1.append(createLabel('샤프'), videoSsharpBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn); const pitchBtn = document.createElement('button'); pitchBtn.className = 'vsc-btn'; pitchBtn.textContent = '🎵'; pitchBtn.title = '음정 유지 (켜짐/꺼짐)'; pitchBtn.onclick = () => { const current = this.stateManager.get('audio.pitch'); this.stateManager.set('audio.pitch', !current); }; this.subscribe('audio.pitch', (v) => { pitchBtn.style.color = v ? '#fff' : '#e74c3c'; pitchBtn.style.textShadow = v ? '' : '0 0 5px red'; }); videoBtnGroup1.appendChild(pitchBtn); const videoBtnGroup3 = document.createElement('div'); videoBtnGroup3.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px; flex-wrap: nowrap; overflow-x: auto;'; videoBtnGroup3.append(createLabel('밝기'), videoSBrightenBtn, videoMBrightenBtn, videoLBrightenBtn, videoDSBrightenBtn, videoDMBrightenBtn, videoDLBrightenBtn, videoBrightenoffBtn); videoButtonsContainer.append(videoBtnGroup1, videoBtnGroup3); const videoButtons = [videoSsharpBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn, videoSBrightenBtn, videoMBrightenBtn, videoLBrightenBtn, videoDSBrightenBtn, videoDMBrightenBtn, videoDLBrightenBtn, videoBrightenoffBtn]; this.subscribe('videoFilter.activePreset', (activeKey) => { videoButtons.forEach(btn => { btn.classList.toggle('active', btn.dataset.presetKey === activeKey); }); }); videoSubMenu.appendChild(videoButtonsContainer); const gridContainer = document.createElement('div'); gridContainer.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;';

            gridContainer.append(this._createSlider('프로파일 강도', 'v-prof-strength', 0, 1, 0.05, 'videoFilter.profileStrength', '', v => `${Math.round(v*100)}%`).control, this._createSlider('자동밝기제한', 'v-smartlimit', 0, 50, 1, 'videoFilter.smartLimit', '%', v => v > 0 ? `${v.toFixed(0)}%` : '꺼짐').control, this._createSlider('자동톤매핑', 'v-autotone', 0, 100, 5, 'videoFilter.autoTone', '%', v => v > 0 ? `${v.toFixed(0)}%` : '꺼짐').control, this._createSlider('샤프(윤곽)', 'v-sharpen1', 0, 50, 1, 'videoFilter.level', '단계', v => `${v.toFixed(0)}단계`).control, this._createSlider('샤프(디테일)', 'v-sharpen2', 0, 50, 1, 'videoFilter.level2', '단계', v => `${v.toFixed(0)}단계`).control, this._createSlider('색온도', 'v-colortemp', -25, 25, 1, 'videoFilter.colorTemp', '', v => `${v.toFixed(0)}`).control, this._createSlider('필름그레인', 'v-dither', 0, 100, 5, 'videoFilter.dither', '', v => v === 0 ? '꺼짐' : (v <= 50 ? `디더 ${v}` : `그레인 ${v}`)).control, this._createSlider('블러', 'v-blur', 0, 2, 0.01, 'videoFilter.blur', '', v => v.toFixed(2)).control, this._createSlider('밝기(HDR)', 'v-highlights', -100, 100, 1, 'videoFilter.highlights', '', v => v.toFixed(0)).control, this._createSlider('대비(HDR)', 'v-shadows', -100, 100, 0.1, 'videoFilter.shadows', '', v => v.toFixed(1)).control, this._createSlider('감마', 'v-gamma', 1, 4.00, 0.01, 'videoFilter.gamma', '', v => v.toFixed(2)).control, this._createSlider('채도', 'v-saturation', 0, 200, 1, 'videoFilter.saturation', '%', v => `${v.toFixed(0)}%`).control, this._createSlider('베이스', 'a-bass', 0, 1, 0.05, 'audio.bass', '', v => v > 0 ? `+${(v*CONFIG.AUDIO_BASS_MAX_DB).toFixed(1)}dB` : 'OFF').control, this._createSlider('리버브', 'a-reverb', 0, 1, 0.05, 'audio.reverb', '', v => v > 0 ? `${(v*100).toFixed(0)}%` : 'OFF').control); videoSubMenu.appendChild(gridContainer);

            const statusDisplay = document.createElement('div'); statusDisplay.className = 'vsc-monitor';
            statusDisplay.textContent = 'Monitoring Off (Enable Auto-Limit/Tone)';
            videoSubMenu.appendChild(statusDisplay);

            const initialSmart = this.stateManager.get('videoFilter.smartLimit');
            const initialTone = this.stateManager.get('videoFilter.autoTone');
            if (initialSmart <= 0 && initialTone <= 0) {
                statusDisplay.textContent = 'Monitoring Off (Enable Auto-Limit/Tone)';
            } else {
                statusDisplay.textContent = 'Active... (Play video to see values)';
            }

            this.boundSmartLimitUpdate = (e) => {
                if (!videoSubMenu.parentElement.classList.contains('submenu-visible')) return;
                const { slope, autoParams, luma } = e.detail;
                statusDisplay.textContent = `Luma: ${luma ? luma.toFixed(2) : 'N/A'} | Gamma: ${autoParams.gamma.toFixed(2)}`;
            };
            document.addEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);

            const updateMonitorText = () => {
                const s = this.stateManager.get('videoFilter.smartLimit');
                const t = this.stateManager.get('videoFilter.autoTone');
                if (s <= 0 && t <= 0) {
                    statusDisplay.textContent = 'Monitoring Off (Enable Auto-Limit/Tone)';
                } else {
                    if (statusDisplay.textContent.includes('Monitoring Off')) {
                        statusDisplay.textContent = 'Active... (Play video to see values)';
                    }
                }
            };
            this.subscribe('videoFilter.smartLimit', updateMonitorText);
            this.subscribe('videoFilter.autoTone', updateMonitorText);

            const imageSubMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controlsContainer); imageSubMenu.appendChild(this._createSlider('샤프닝', 'i-sharpen', 0, 20, 1, 'imageFilter.level', '단계', v => v === 0 ? '꺼짐' : `${v.toFixed(0)}단계`).control); imageSubMenu.appendChild(this._createSlider('색온도', 'i-colortemp', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control); if (this.speedButtons.length === 0) { CONFIG.SPEED_PRESETS.forEach(speed => { const btn = document.createElement('button'); btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn'; Object.assign(btn.style, { background: 'rgba(52, 152, 219, 0.7)', color: 'white', width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)', padding: '0', transition: 'background-color 0.2s, box-shadow 0.2s' }); btn.onclick = () => this.stateManager.set('playback.targetRate', speed); this.speedButtonsContainer.appendChild(btn); this.speedButtons.push(btn); }); const isLiveJumpSite = CONFIG.LIVE_STREAM_SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d)); if (isLiveJumpSite) { const liveJumpBtn = document.createElement('button'); liveJumpBtn.textContent = '⚡'; liveJumpBtn.title = '실시간으로 이동'; liveJumpBtn.className = 'vsc-btn'; Object.assign(liveJumpBtn.style, { width: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', fontSize: this.stateManager.get('app.isMobile') ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', borderRadius: '50%', padding: '0', transition: 'box-shadow 0.3s' }); liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now()); this.speedButtonsContainer.appendChild(liveJumpBtn); } } mainContainer.appendChild(controlsContainer); this.shadowRoot.appendChild(mainContainer); this.updateActiveSpeedButton(this.stateManager.get('playback.currentRate'));
        }
        attachDragAndDrop() { let pressTimer = null; const isInteractiveTarget = (e) => { for (const element of e.composedPath()) { if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(element.tagName)) { return true; } } return false; }; const onDragStart = (e) => { if (isInteractiveTarget(e)) return; pressTimer = setTimeout(() => { if (this.globalContainer) { this.globalContainer.style.display = 'none'; setTimeout(() => { if (this.globalContainer) this.globalContainer.style.display = 'flex'; }, 5000); } onDragEnd(); }, 800); const pos = e.touches ? e.touches[0] : e; this.startPos = { x: pos.clientX, y: pos.clientY }; this.currentPos = { x: this.uiState.x, y: this.uiState.y }; this.isDragging = true; this.wasDragged = false; this.globalContainer.style.transition = 'none'; document.addEventListener('mousemove', onDragMove, { passive: false }); document.addEventListener('mouseup', onDragEnd, { passive: true }); document.addEventListener('touchmove', onDragMove, { passive: false }); document.addEventListener('touchend', onDragEnd, { passive: true }); }; const updatePosition = () => { if (!this.isDragging || !this.globalContainer) return; const newX = this.currentPos.x + this.delta.x; const newY = this.currentPos.y + this.delta.y; this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`); this.animationFrameId = null; }; const onDragMove = (e) => { if (!this.isDragging) return; const pos = e.touches ? e.touches[0] : e; this.delta = { x: pos.clientX - this.startPos.x, y: pos.clientY - this.startPos.y }; if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI_DRAG_THRESHOLD)) { this.wasDragged = true; clearTimeout(pressTimer); if (e.cancelable) e.preventDefault(); } if (this.wasDragged && this.animationFrameId === null) { this.animationFrameId = requestAnimationFrame(updatePosition); } }; const onDragEnd = () => { clearTimeout(pressTimer); if (!this.isDragging) return; if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; } if (this.wasDragged) { this.uiState.x += this.delta.x; this.uiState.y += this.delta.y; } this.isDragging = false; this.globalContainer.style.transition = ''; document.removeEventListener('mousemove', onDragMove); document.removeEventListener('mouseup', onDragEnd); document.removeEventListener('touchmove', onDragMove); document.removeEventListener('touchend', onDragEnd); setTimeout(() => { this.wasDragged = false; }, 50); }; this.triggerElement.addEventListener('mousedown', onDragStart); this.triggerElement.addEventListener('touchstart', onDragStart, { passive: false }); }
    }

    function main() { const stateManager = new StateManager(); const pluginManager = new PluginManager(stateManager); window.vscPluginManager = pluginManager; pluginManager.register(new UIPlugin()); pluginManager.register(new CoreMediaPlugin()); pluginManager.register(new SvgFilterPlugin()); pluginManager.register(new PlaybackControlPlugin()); pluginManager.register(new LiveStreamPlugin()); pluginManager.register(new NavigationPlugin(pluginManager)); pluginManager.register(new AudioEffectPlugin()); pluginManager.initAll(); }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', main); } else { main(); }
})();
