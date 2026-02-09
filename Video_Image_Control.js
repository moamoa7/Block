// ==UserScript==
// @name        Video_Image_Control (v128.41 Solid & Clear)
// @namespace   https://com/
// @version     128.41
// @description v128.41: UI 투명도 1.0 고정(흐림 제거), 메모리 누수 완벽 차단, Source 태그 감지 추가, O(n) 최적화 탐색, 스캔 로직 강화.
// @match       *://*/*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
    'use strict';

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    const VSC_INSTANCE_ID = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
    const IS_TOP = window === window.top;
    const PASSIVE = { passive: true };
    const CAPTURE_PASSIVE = { capture: true, passive: true };
    const originalAttachShadow = Element.prototype.attachShadow;

    // Device Capability Check
    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_HIGH_END = DEVICE_RAM >= 8;
    const IS_LOW_END = DEVICE_RAM < 4;

    const CONFIG = {
        DEBUG: false,
        ENABLE_HLS_BOOST: true,
        ENABLE_SHADOW_HOOK: true,
        ENABLE_AUDIO_EFFECT: true,
        ENABLE_LIVE_DELAY: true,

        HLS_MAX_BUFFER: IS_HIGH_END ? 600 : (IS_LOW_END ? 30 : 120),
        HLS_BACK_BUFFER: IS_HIGH_END ? 300 : (IS_LOW_END ? 15 : 60),

        DEFAULT_VIDEO_FILTER_LEVEL: 15,
        DEFAULT_IMAGE_FILTER_LEVEL: 15,

        DEFAULT_AUTO_EXPOSURE: false,
        DEFAULT_TARGET_LUMA: 0,
        DEFAULT_CLARITY: 0,

        DEFAULT_BRIGHTNESS: 0,
        DEFAULT_CONTRAST_ADJ: 1.0,

        DEFAULT_AUDIO_BASS: 0,
        AUDIO_BASS_MAX_DB: 6.5,
        AUDIO_BASS_FREQ: 90,
        DEFAULT_AUDIO_PITCH: true,

        AUTODELAY_INTERVAL_NORMAL: 1000,
        AUTODELAY_INTERVAL_STABLE: 3000,
        AUTODELAY_STABLE_THRESHOLD: 100,
        AUTODELAY_STABLE_COUNT: 5,
        AUTODELAY_PID_KP: 0.0002,
        AUTODELAY_PID_KI: 0.00001,
        AUTODELAY_PID_KD: 0.0001,
        AUTODELAY_MIN_RATE: 1.0,
        AUTODELAY_MAX_RATE: 1.025,
        AUTODELAY_EMA_ALPHA: 0.2,

        MIN_BUFFER_HEALTH_SEC: 1.0,
        LIVE_JUMP_INTERVAL: 6000,
        LIVE_JUMP_END_THRESHOLD: 1.0,

        SCAN_INTERVAL_BASE_TOP: 5000,
        SCAN_INTERVAL_BASE_IFRAME: 2000,
        SCAN_INTERVAL_MAX: 15000,

        MAX_Z_INDEX: 2147483647,
        UI_DRAG_THRESHOLD: 5,
        UI_WARN_TIMEOUT: 10000,

        LIVE_STREAM_SITES: [
            'tv.naver.com','play.sooplive.co.kr','chzzk.naver.com','twitch.tv','kick.com','ok.ru','bigo.tv','pandalive.co.kr',
            'chaturbate.com','stripchat.com','xhamsterlive.com','myavlive.com'
        ],

        SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2],

        VIDEO_MIN_SIZE: 50,
        IMAGE_MIN_SIZE: 355,
        MAX_RECURSION_DEPTH: 4,

        MOBILE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', SATURATION_VALUE: 100, COLORTEMP_VALUE: 0, DITHER_VALUE: 0, CLARITY: 0 },
        DESKTOP_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'SharpenDynamic', SATURATION_VALUE: 100, COLORTEMP_VALUE: 0, DITHER_VALUE: 0, CLARITY: 0 },
        IMAGE_FILTER_SETTINGS: { GAMMA_VALUE: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', SATURATION_VALUE: 100, COLORTEMP_VALUE: 0 },

        UI_HIDDEN_CLASS_NAME: 'vsc-hidden',
        MUTATION_ATTR_FILTER: ['src', 'srcset', 'poster', 'style', 'class', 'data-src', 'data-srcset', 'data-lazy-src', 'data-url', 'data-href', 'type', 'loading', 'preload']
    };

    const MEDIA_EVENTS = ['loadedmetadata', 'playing', 'canplay', 'loadstart', 'loadeddata', 'emptied', 'durationchange', 'waiting'];

    const log = (...args) => { if (CONFIG.DEBUG) console.log('[VSC]', ...args); };

    let _errCount = 0, _errWindowStart = Date.now();
    const safeGuard = (fn, label = '') => {
        const now = Date.now();
        if (now - _errWindowStart > 10000) { _errWindowStart = now; _errCount = 0; }
        if (_errCount > 30) return;
        try { fn(); } catch(e) {
            _errCount++;
            if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e);
        }
    };

    const debounce = (fn, wait) => {
        let t;
        return function(...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    };
    const throttle = (fn, limit) => {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                fn.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    };

    const requestIdle = window.requestIdleCallback
        ? window.requestIdleCallback.bind(window)
        : (cb) => { const start = Date.now(); return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (Date.now() - start)) }), 50); };

    const dirtyRoots = new Set();
    let pendingScan = false;
    let _corePluginRef = null;

    const scheduleScan = (rootOrNull, immediate = false) => {
        if (immediate && _corePluginRef) {
            if (rootOrNull) safeGuard(() => _corePluginRef.scanSpecificRoot(rootOrNull), 'scanSpecificRoot');
            else safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
            return;
        }
        if (rootOrNull) dirtyRoots.add(rootOrNull);
        if (pendingScan) return;
        pendingScan = true;
        requestIdle(() => {
            pendingScan = false;
            if (!_corePluginRef) return;
            if (dirtyRoots.size > 40) {
                dirtyRoots.clear();
                safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
                return;
            }
            const roots = [...dirtyRoots];
            dirtyRoots.clear();
            if (roots.length > 0) {
                for (const r of roots) if(r.isConnected) safeGuard(() => _corePluginRef.scanSpecificRoot(r), 'scanSpecificRoot');
            } else safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
        }, { timeout: 1000 });
    };

    const setAttr = (el, name, val) => {
        if (!el) return;
        const strVal = String(val);
        if (el.getAttribute(name) !== strVal) el.setAttribute(name, strVal);
    };

    const _realmSheetCache = new WeakMap();
    const _injectedContexts = new WeakMap();
    const _shadowRootCache = new WeakMap();

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

    function whenDocReady(doc, cb) {
        if (!doc) return;
        if (doc.body && (doc.readyState === 'complete' || doc.readyState === 'interactive')) cb();
        else doc.addEventListener('DOMContentLoaded', () => { if (doc.body) cb(); else setTimeout(cb, 100); }, { once: true });
    }

    function injectFiltersIntoContext(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        let root = element.getRootNode();
        const ownerDoc = element.ownerDocument;
        if (root === document && element.parentElement) {
            let cachedRoot = _shadowRootCache.get(element);
            if (!cachedRoot) {
                const shadowRoots = window._shadowDomList_ || [];
                for (const sRoot of shadowRoots) { if (sRoot.contains(element)) { root = sRoot; _shadowRootCache.set(element, sRoot); break; } }
            } else root = cachedRoot;
        }
        if (ownerDoc === document && root === document) return;
        const type = (manager === stateManager.filterManagers.video) ? 'video' : 'image';
        const contextKey = root instanceof ShadowRoot ? root : ownerDoc;
        let injectedSet = _injectedContexts.get(contextKey);
        if (injectedSet && injectedSet.has(type)) return;
        const attr = `data-vsc-filters-injected-${type}`;
        if (root instanceof ShadowRoot) { if (root.host && root.host.hasAttribute(attr)) return; } 
        else if (ownerDoc && ownerDoc.documentElement.hasAttribute(attr)) return;
        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode();
        if (!svgNode || !styleNode) return;
        const safelyAppendStyle = (targetRoot, styleEl, sharedSheet) => {
            let appended = false;
            if (sharedSheet && ('adoptedStyleSheets' in targetRoot)) {
                try {
                    const sheets = targetRoot.adoptedStyleSheets;
                    if (!sheets.includes(sharedSheet)) targetRoot.adoptedStyleSheets = [...sheets, sharedSheet];
                    appended = true;
                } catch(e) { }
            }
            if (!appended) {
                const styleId = styleEl.id;
                if (!targetRoot.querySelector(`#${styleId}`)) {
                     const container = (targetRoot === ownerDoc) ? targetRoot.head : targetRoot;
                     if(container) container.appendChild(styleEl.cloneNode(true));
                }
            }
        };
        if (ownerDoc !== document) {
            if (!ownerDoc.body) { whenDocReady(ownerDoc, () => injectFiltersIntoContext(element, manager, stateManager)); return; }
            if (ownerDoc.body && ownerDoc.head && !ownerDoc.documentElement.hasAttribute(attr)) {
                const clonedSvg = svgNode.cloneNode(true);
                ownerDoc.body.appendChild(clonedSvg);
                const view = ownerDoc.defaultView;
                const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                safelyAppendStyle(ownerDoc, styleNode, sharedSheet);
                manager.registerContext(clonedSvg);
                ownerDoc.documentElement.setAttribute(attr, 'true');
                if(!injectedSet) { injectedSet = new Set(); _injectedContexts.set(contextKey, injectedSet); }
                injectedSet.add(type);
                return;
            }
        }
        if (root instanceof ShadowRoot) {
            const flag = type === 'video' ? '_vsc_video_filters_injected' : '_vsc_image_filters_injected';
            if (!root[flag]) {
                try {
                    const clonedSvg = svgNode.cloneNode(true);
                    const view = root.ownerDocument ? root.ownerDocument.defaultView : null;
                    const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                    safelyAppendStyle(root, styleNode, sharedSheet);
                    root.appendChild(clonedSvg);
                    manager.registerContext(clonedSvg);
                    root[flag] = true;
                    if (root.host) root.host.setAttribute(attr, 'true');
                    if(!injectedSet) { injectedSet = new Set(); _injectedContexts.set(contextKey, injectedSet); }
                    injectedSet.add(type);
                } catch (e) { }
            }
        }
    }

    if (CONFIG.ENABLE_HLS_BOOST) {
        (function patchHlsClass() {
            function isCtor(v) { return typeof v === 'function'; }
            function looksLikeHlsJs(H) { return !!(H && H.DefaultConfig && H.prototype && typeof H.prototype.loadSource === 'function'); }
            function protectGlobal(name, value) { try { const d = Object.getOwnPropertyDescriptor(window, name); if (d && !d.configurable) return; Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false }); } catch (e) {} }
            function makePatchedHls(OriginalHls) {
                if (!OriginalHls || OriginalHls.__VSC_PATCHED__ || !isCtor(OriginalHls)) return OriginalHls;
                if (!looksLikeHlsJs(OriginalHls)) return OriginalHls;
                const overrides = { maxBufferLength: CONFIG.HLS_MAX_BUFFER, backBufferLength: CONFIG.HLS_BACK_BUFFER, maxMaxBufferLength: CONFIG.HLS_MAX_BUFFER * 2, startFragPrefetch: true };
                try { if (OriginalHls.DefaultConfig) Object.assign(OriginalHls.DefaultConfig, overrides); } catch {}
                class PatchedHls extends OriginalHls { constructor(userConfig = {}) { try { const enforced = Object.assign({}, overrides, userConfig); enforced.maxBufferLength = Math.max(enforced.maxBufferLength || 0, CONFIG.HLS_MAX_BUFFER); enforced.backBufferLength = Math.max(enforced.backBufferLength || 0, CONFIG.HLS_BACK_BUFFER); super(enforced); } catch(e) { super(userConfig); } } }
                Object.getOwnPropertyNames(OriginalHls).forEach((name) => { if (['length', 'prototype', 'name', 'DefaultConfig'].includes(name)) return; try { Object.defineProperty(PatchedHls, name, Object.getOwnPropertyDescriptor(OriginalHls, name)); } catch {} });
                Object.defineProperty(PatchedHls, 'DefaultConfig', { get() { return OriginalHls.DefaultConfig; }, set(v) { OriginalHls.DefaultConfig = v; } });
                Object.defineProperty(PatchedHls, '__VSC_PATCHED__', { value: true });
                return PatchedHls;
            }
            if ('Hls' in window && isCtor(window.Hls)) { protectGlobal('Hls', makePatchedHls(window.Hls)); }
            else { let _hlsStorage = undefined; Object.defineProperty(window, 'Hls', { configurable: true, enumerable: false, get() { return _hlsStorage; }, set(v) { if (!isCtor(v)) { _hlsStorage = v; return; } _hlsStorage = makePatchedHls(v); } }); }
        })();
    }

    if (CONFIG.ENABLE_SHADOW_HOOK) {
        (function aggressiveShadowHook() {
            if (window._hasAggressiveHook_) return;
            try {
                window._shadowDomList_ = window._shadowDomList_ || [];
                window._shadowDomSet_ = window._shadowDomSet_ || new WeakSet();
                Object.defineProperty(window, '_shadowDomList_', { value: window._shadowDomList_, enumerable: false, writable: true, configurable: true });
                Element.prototype.attachShadow = function (init) {
                    const shadowRoot = originalAttachShadow.call(this, init);
                    try {
                        const cls = (this.className || '').toString().toLowerCase();
                        const id = (this.id || '').toString().toLowerCase();
                        if (id === 'vsc-ui-host') return shadowRoot;
                        if (cls.includes('turnstile') || id.includes('turnstile') || cls.includes('stripe') || id.includes('stripe') || cls.includes('recaptcha') || id.includes('recaptcha') || cls.includes('g-recaptcha')) return shadowRoot;
                        if (!window._shadowDomSet_.has(shadowRoot)) {
                            window._shadowDomSet_.add(shadowRoot);
                            const list = window._shadowDomList_;
                            if (Array.isArray(list) && list.length > 200) { let w = 0; for (let i = 0; i < list.length; i++) { const r = list[i]; if (r && r.host && r.host.isConnected) list[w++] = r; } list.length = w; }
                            list.push(shadowRoot);
                        }
                        document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: shadowRoot } }));
                    } catch (e) { }
                    return shadowRoot;
                };
                Element.prototype.attachShadow.toString = function() { return originalAttachShadow.toString(); };
                window._hasAggressiveHook_ = true;
            } catch (e) { log("Hooking Failed", e); }
        })();
    }

    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null,
        taintedCache: new WeakMap(),
        taintedRetryCache: new WeakMap(),
        stateManager: null,
        currentSettings: { clarity: 0, autoExposure: false, targetLuma: 0 },
        currentAdaptiveGamma: 1.0, currentAdaptiveBright: 0,
        currentClarityComp: 0, currentShadowsAdj: 0, currentHighlightsAdj: 0,
        _lastClarityComp: 0, _lastShadowsAdj: 0, _lastHighlightsAdj: 0,
        frameSkipCounter: 0,
        dynamicSkipThreshold: 0,
        hasRVFC: false,
        lastAvgLuma: -1,
        _highMotion: false,
        _histBuffer: new Uint16Array(256),
        _userBoostUntil: 0,
        init(stateManager) {
            this.stateManager = stateManager;
            if (this.canvas) return;
            this.canvas = document.createElement('canvas');
            const size = IS_LOW_END ? 16 : 32;
            this.canvas.width = size; this.canvas.height = size;
            this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        },
        start(video, settings) {
            if (!this.ctx && this.canvas) this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
            if (!this.ctx) return;
            if (this.isRunning && this.targetVideo && this.targetVideo !== video) this.stop();
            if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExposure = this.currentSettings.autoExposure;
            if (!isClarityActive && !isAutoExposure) { if (this.isRunning) this.stop(); return; }
            const cachedSrc = this.taintedCache.get(video);
            const currentSrcKey = (video.currentSrc || video.src) + '|' + video.videoWidth + 'x' + video.videoHeight;
            if (cachedSrc && cachedSrc === currentSrcKey) { const lastTry = this.taintedRetryCache.get(video) || 0; if (Date.now() - lastTry < 30000) return; }
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video;
            this.hasRVFC = 'requestVideoFrameCallback' in this.targetVideo;
            if (!this.canvas) this.init(this.stateManager);
            this.isRunning = true; this.loop();
        },
        stop() {
            this.isRunning = false;
            if (this.handle && this.targetVideo && this.hasRVFC) { try { this.targetVideo.cancelVideoFrameCallback(this.handle); } catch {} }
            this.handle = null; this.targetVideo = null; this.frameSkipCounter = 0; this.lastAvgLuma = -1; this._highMotion = false; this._lastClarityComp = 0; this._lastShadowsAdj = 0; this._lastHighlightsAdj = 0;
        },
        updateSettings(settings) {
            this.currentSettings = { ...this.currentSettings, ...settings };
            if (settings && (Object.prototype.hasOwnProperty.call(settings, 'targetLuma') || Object.prototype.hasOwnProperty.call(settings, 'autoExposure') || Object.prototype.hasOwnProperty.call(settings, 'clarity'))) { this.frameSkipCounter = 999; this._userBoostUntil = performance.now() + 800; }
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExposure = this.currentSettings.autoExposure;
            if ((isClarityActive || isAutoExposure) && !this.isRunning) {
                 const best = this.stateManager ? this.stateManager.get('media.currentlyVisibleMedia') : null;
                 if (best) this.start(best);
            } else if (!isClarityActive && !isAutoExposure && this.isRunning) {
                this.stop();
                this.notifyUpdate({ gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }, 0);
            }
        },
        loop() {
            if (!this.isRunning || !this.targetVideo) return;
            const cb = () => { try { this.processFrame(); } catch (e) { if(CONFIG.DEBUG) console.warn(e); } this.loop(); };
            if (this.hasRVFC) this.handle = this.targetVideo.requestVideoFrameCallback(cb);
            else { this.processFrame(); setTimeout(() => this.loop(), 200); }
        },
        processFrame() {
            if (!this.targetVideo || this.targetVideo.paused || this.targetVideo.ended) { this.stop(); return; }
            if (document.hidden) return;
            if (this.targetVideo.readyState < 2) return;
            if (!this.ctx) return;
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExp = this.currentSettings.autoExposure;
            if (!isClarityActive && !isAutoExp) { this.stop(); return; }
            const startTime = performance.now();
            const evValue = this.currentSettings.targetLuma || 0;
            if (isAutoExp && evValue === 0) {
                 this.currentAdaptiveGamma = 1.0; this.currentAdaptiveBright = 0; this.currentShadowsAdj = 0; this.currentHighlightsAdj = 0;
            }
            let baseThreshold = this.hasRVFC ? 15 : 0;
            if (this._highMotion) baseThreshold = this.hasRVFC ? 8 : 4;
            const effectiveThreshold = baseThreshold + (this.dynamicSkipThreshold || 0);
            this.frameSkipCounter++;
            if (this.frameSkipCounter < effectiveThreshold) return;
            this.frameSkipCounter = 0;
            try {
                const size = this.canvas.width;
                this.ctx.drawImage(this.targetVideo, 0, 0, size, size);
                const data = this.ctx.getImageData(0, 0, size, size).data;
                const hist = this._histBuffer;
                hist.fill(0);
                const wR = 0.2126, wG = 0.7152, wB = 0.0722;
                for (let i = 0; i < data.length; i += 4) {
                    const l = (data[i] * wR + data[i+1] * wG + data[i+2] * wB) | 0;
                    hist[l]++;
                }
                let acc = 0, cnt = 0;
                let cum = 0;
                const total = size * size;
                let p05 = 0, p95 = 0, p99 = 0;
                let found05 = false, found95 = false, found99 = false;
                for (let b = 0; b < 256; b++) {
                    const n = hist[b];
                    acc += b * n; cnt += n; cum += n;
                    if (!found05 && cum >= total * 0.05) { p05 = b / 255; found05 = true; }
                    if (!found95 && cum >= total * 0.95) { p95 = b / 255; found95 = true; }
                    if (!found99 && cum >= total * 0.99) { p99 = b / 255; found99 = true; }
                }
                const avgLuma = cnt > 0 ? (acc / cnt) / 255 : 0.5;
                if (this.lastAvgLuma >= 0) {
                    const delta = Math.abs(avgLuma - this.lastAvgLuma);
                    this._highMotion = (delta > 0.05);
                }
                this.lastAvgLuma = avgLuma;
                let targetAdaptiveGamma = 1.0; let targetAdaptiveBright = 0; let targetShadowsAdj = 0; let targetHighlightsAdj = 0;
                if (isAutoExp) {
                    if (evValue === 0) {
                        targetAdaptiveGamma = 1.0; targetAdaptiveBright = 0; targetShadowsAdj = 0; targetHighlightsAdj = 0;
                        this.currentAdaptiveGamma = 1.0; this.currentAdaptiveBright = 0;
                    } else {
                        const boostFactor = evValue / 40; 
                        let dynamicTarget;
                        if (boostFactor >= 0) {
                            const protection = Math.max(0.3, 1.0 - avgLuma); 
                            dynamicTarget = avgLuma * (1.0 + (boostFactor * protection));
                            dynamicTarget = Math.min(0.98, dynamicTarget);
                        } else {
                            const protection = Math.min(1.0, 0.3 + avgLuma * 2.0); 
                            dynamicTarget = avgLuma * (1.0 + (boostFactor * protection));
                            dynamicTarget = Math.max(0.01, dynamicTarget);
                        }
                        if (avgLuma < 0.02) dynamicTarget = avgLuma;
                        let error = dynamicTarget - avgLuma;
                        if (Math.abs(error) < 0.001) error = 0;
                        const correction = error * 5.0;
                        if (correction > 0) {
                            targetAdaptiveGamma += correction * 0.8; targetAdaptiveBright += correction * 4; targetShadowsAdj += correction * 3; 
                        } else {
                            const absCorr = Math.abs(correction);
                            targetAdaptiveGamma -= absCorr * 0.8; targetAdaptiveBright -= absCorr * 4; targetHighlightsAdj += absCorr * 30;
                        }
                    }
                }
                if (evValue !== 0) {
                    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
                    targetAdaptiveGamma = clamp(targetAdaptiveGamma, 0.6, 2.0);
                    targetAdaptiveBright = clamp(targetAdaptiveBright, -40, 40);
                    targetShadowsAdj = clamp(targetShadowsAdj, -40, 40);
                    targetHighlightsAdj = clamp(targetHighlightsAdj, -80, 60);
                }
                let targetClarityComp = 0;
                if (isClarityActive) {
                    const intensity = this.currentSettings.clarity / 50;
                    const lumaFactor = Math.max(0.2, 1.0 - avgLuma);
                    let dampener = isAutoExp ? 0.6 : 1.0;
                    targetClarityComp = Math.min(10, (intensity * 12) * lumaFactor * dampener);
                }
                const smooth = (curr, target, time) => {
                    if (evValue === 0 && isAutoExp) return target;
                    const diff = target - curr;
                    const userBoost = (this._userBoostUntil && time < this._userBoostUntil);
                    let speed = userBoost ? 0.25 : (this._highMotion ? 0.05 : 0.1);
                    return Math.abs(diff) > 0.01 ? curr + diff * speed : curr;
                };
                const now = performance.now();
                this.currentAdaptiveGamma = smooth(this.currentAdaptiveGamma || 1.0, targetAdaptiveGamma, now);
                this.currentAdaptiveBright = smooth(this.currentAdaptiveBright || 0, targetAdaptiveBright, now);
                this.currentClarityComp = smooth(this._lastClarityComp || 0, targetClarityComp, now);
                this.currentShadowsAdj = smooth(this._lastShadowsAdj || 0, targetShadowsAdj, now);
                this.currentHighlightsAdj = smooth(this._lastHighlightsAdj || 0, targetHighlightsAdj, now);
                this._lastClarityComp = this.currentClarityComp;
                this._lastShadowsAdj = this.currentShadowsAdj;
                this._lastHighlightsAdj = this.currentHighlightsAdj;
                this.notifyUpdate({ gamma: this.currentAdaptiveGamma, bright: this.currentAdaptiveBright, clarityComp: this.currentClarityComp, shadowsAdj: this.currentShadowsAdj, highlightsAdj: this.currentHighlightsAdj }, avgLuma, this.targetVideo);
            } catch (e) {
                if (e.name === 'SecurityError') {
                    const key = (this.targetVideo.currentSrc || this.targetVideo.src) + '|' + this.targetVideo.videoWidth + 'x' + this.targetVideo.videoHeight;
                    this.taintedCache.set(this.targetVideo, key);
                    this.taintedRetryCache.set(this.targetVideo, Date.now());
                    if (this.stateManager && this.stateManager.set) this.stateManager.set('ui.warningMessage', '보안(CORS) 제한으로 자동노출 불가. 수동 설정을 이용하세요.');
                    document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', { detail: { autoParams: { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }, luma: 0, tainted: true, videoInfo: this.targetVideo } }));
                    this.stop();
                }
            }
            const duration = performance.now() - startTime;
            if (duration > 4.0) this.dynamicSkipThreshold = Math.min(30, (this.dynamicSkipThreshold || 0) + 2);
            else if (duration < 1.0 && this.dynamicSkipThreshold > 0) this.dynamicSkipThreshold = Math.max(0, this.dynamicSkipThreshold - 1);
        },
        notifyUpdate(autoParams, luma, videoInfo) {
            document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', { detail: { autoParams, luma, tainted: false, videoInfo } }));
        }
    };

    class StateManager {
        constructor() { this.state = {}; this.listeners = {}; this.filterManagers = { video: null, image: null }; }
        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS;
            this.state = {
                app: { isInitialized: false, isMobile, scriptActive: false },
                media: { activeMedia: new Set(), activeImages: new Set(), mediaListenerMap: new WeakMap(), visibilityMap: new WeakMap(), currentlyVisibleMedia: null, visibilityChange: null },
                videoFilter: { lastActiveSettings: null, level: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, level2: CONFIG.DEFAULT_VIDEO_FILTER_LEVEL, gamma: parseFloat(videoDefaults.GAMMA_VALUE), shadows: parseInt(videoDefaults.SHADOWS_VALUE, 10), highlights: parseInt(videoDefaults.HIGHLIGHTS_VALUE, 10), brightness: CONFIG.DEFAULT_BRIGHTNESS, contrastAdj: CONFIG.DEFAULT_CONTRAST_ADJ, saturation: parseInt(videoDefaults.SATURATION_VALUE, 10), colorTemp: parseInt(videoDefaults.COLORTEMP_VALUE || 0, 10), dither: parseInt(videoDefaults.DITHER_VALUE || 0, 10), autoExposure: CONFIG.DEFAULT_AUTO_EXPOSURE, targetLuma: CONFIG.DEFAULT_TARGET_LUMA, clarity: CONFIG.DEFAULT_CLARITY, activeSharpPreset: 'none' },
                imageFilter: { lastActiveSettings: null, level: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, level2: CONFIG.DEFAULT_IMAGE_FILTER_LEVEL, colorTemp: parseInt(CONFIG.IMAGE_FILTER_SETTINGS.COLORTEMP_VALUE || 0, 10) },
                audio: { bass: CONFIG.DEFAULT_AUDIO_BASS, pitch: CONFIG.DEFAULT_AUDIO_PITCH },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, lastUrl: location.href, warningMessage: null, createRequested: false },
                playback: { currentRate: 1.0, targetRate: 1.0, isLive: false, jumpToLiveRequested: 0 },
                liveStream: { delayInfo: null, isRunning: false, resetRequested: null, isPinned: false }
            };
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) {
            const keys = key.split('.'); let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) { if (obj === undefined) return; obj = obj[keys[i]]; }
            const finalKey = keys[keys.length - 1]; if (obj === undefined) return;
            const oldValue = obj[finalKey];
            if (!Object.is(oldValue, value)) { obj[finalKey] = value; this.notify(key, value, oldValue); }
        }
        subscribe(key, callback) { if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback); return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); }; }
        notify(key, newValue, oldValue) {
            if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue));
            let currentKey = key;
            while (currentKey.includes('.')) { const prefix = currentKey.substring(0, currentKey.lastIndexOf('.')); const wildcardKey = `${prefix}.*`; if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue)); currentKey = prefix; }
        }
    }

    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    class PluginManager { constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; } register(plugin) { this.plugins.push(plugin); } initAll() { this.stateManager.init(); this.plugins.forEach(plugin => safeGuard(() => plugin.init(this.stateManager), `Plugin ${plugin.name} init`)); this.stateManager.set('app.isInitialized', true); this.stateManager.set('app.pluginsInitialized', true); window.addEventListener('pagehide', () => { this.destroyAll(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) VideoAnalyzer.stop(); else { const best = this.stateManager.get('media.currentlyVisibleMedia'); const vf = this.stateManager.get('videoFilter'); if (best && (vf.autoExposure || vf.clarity>0)) VideoAnalyzer.start(best, { autoExposure:vf.autoExposure, clarity:vf.clarity, targetLuma:vf.targetLuma }); } }); } destroyAll() { this.plugins.forEach(plugin => safeGuard(() => plugin.destroy(), `Plugin ${plugin.name} destroy`)); this.stateManager.set('app.isInitialized', false); } }

    class CoreMediaPlugin extends Plugin {
        constructor() {
            super('CoreMedia');
            this.mainObserver = null; this.intersectionObserver = null; this.scanTimerId = null; this.onAddShadowRoot = null; this._ioRatio = new Map();
            this.emptyScanCount = 0; this.baseScanInterval = IS_TOP ? CONFIG.SCAN_INTERVAL_BASE_TOP : CONFIG.SCAN_INTERVAL_BASE_IFRAME; this.currentScanInterval = this.baseScanInterval;
            this._seenIframes = new WeakSet(); this._observedImages = new WeakSet(); this._iframeBurstCooldown = new WeakMap(); this._iframeObservers = new Map(); this._iframeInternalObservers = new Map(); 
            this._lastImmediateScan = new WeakMap();
            this._onMediaEvent = (e) => {
                const t = e.target;
                if (t && t.tagName === 'VIDEO') {
                    const now = performance.now(); const last = this._lastImmediateScan.get(t) || 0;
                    if (now - last > 120) { this._lastImmediateScan.set(t, now); scheduleScan(t, true); }
                }
            };
        }
        init(stateManager) {
            super.init(stateManager); _corePluginRef = this; VideoAnalyzer.init(stateManager);
            this.subscribe('app.pluginsInitialized', () => { this.ensureObservers(); this.scanAndApply(); this.runStartupBoost(); this.onAddShadowRoot = (e) => { if (e.detail && e.detail.shadowRoot) this.scanSpecificRoot(e.detail.shadowRoot); }; document.addEventListener('addShadowRoot', this.onAddShadowRoot); MEDIA_EVENTS.forEach(evt => document.addEventListener(evt, this._onMediaEvent, CAPTURE_PASSIVE)); this.scheduleNextScan(); });
            this.subscribe('app.scriptActive', (active, old) => { if (active && !old) { this.resetScanInterval(); scheduleScan(null, true); [250, 900, 2000].forEach(d => setTimeout(() => scheduleScan(null), d)); } });
            ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => document.addEventListener(evt, () => this.resetScanInterval(), { passive: true, capture: true }));
        }
        runStartupBoost() { [300, 800, 1500, 3000, 5000, 10000, 15000].forEach(d => setTimeout(() => scheduleScan(null, true), d)); }
        destroy() { super.destroy(); _corePluginRef = null; if (this.mainObserver) { this.mainObserver.disconnect(); this.mainObserver = null; } if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; } if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scanTimerId = null; } if (this.onAddShadowRoot) { document.removeEventListener('addShadowRoot', this.onAddShadowRoot); this.onAddShadowRoot = null; } MEDIA_EVENTS.forEach(evt => document.removeEventListener(evt, this._onMediaEvent, CAPTURE_PASSIVE)); }
        ensureObservers() {
            if (!this.mainObserver) {
                const dirtySet = new Set();
                const flushDirty = debounce(() => { if (dirtySet.size > 40) { dirtySet.clear(); scheduleScan(null); return; } for (const n of dirtySet) if (n.isConnected) this.scanSpecificRoot(n); dirtySet.clear(); }, 150);
                this.mainObserver = new MutationObserver((mutations) => {
                    if (mutations.length > 50) { scheduleScan(null); return; }
                    for(const m of mutations) {
                        if (m.type === 'attributes') {
                            const t = m.target;
                            if (t.closest && t.closest('[data-vsc-internal]')) continue;
                            const tag = t.nodeName;
                            // [v128.41] Fix: Source Tag Detection
                            if (tag === 'SOURCE') { const p = t.parentNode; if (p && p.nodeName === 'VIDEO') dirtySet.add(p); continue; }
                            if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME') dirtySet.add(t);
                        } else if (m.addedNodes.length > 0) {
                            for(const n of m.addedNodes) {
                                if (n.nodeType === 1) {
                                    if (n.closest && n.closest('[data-vsc-internal]')) continue;
                                    if (n.nodeName === 'SOURCE') { const p = n.parentNode; if (p && p.nodeName === 'VIDEO') dirtySet.add(p); } else dirtySet.add(n);
                                }
                            }
                        }
                    }
                    if (dirtySet.size > 0) flushDirty();
                });
                this.mainObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: CONFIG.MUTATION_ATTR_FILTER });
            }
            if (!this.intersectionObserver) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    const visMap = this.stateManager.get('media.visibilityMap'); let needsUpdate = false;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        if (visMap) visMap.set(e.target, isVisible);
                        if (e.target.tagName === 'VIDEO') { 
                            this._ioRatio.set(e.target, e.intersectionRatio); // [v128.41] Fix: Map Population
                            this.stateManager.set('media.visibilityChange', { target: e.target, isVisible }); needsUpdate = true; 
                        } else if (e.target.tagName === 'IMG') this.stateManager.set('media.visibilityChange', { target: e.target, isVisible });
                        if (!e.target.isConnected) { if (e.target.tagName === 'VIDEO') this._ioRatio.delete(e.target); this.intersectionObserver.unobserve(e.target); }
                    });
                    if (needsUpdate && !document.hidden) {
                        const currentBest = this.stateManager.get('media.currentlyVisibleMedia');
                        const activeMedia = this.stateManager.get('media.activeMedia');
                        // [v128.41] Optimization: O(n) Search
                        let bestCandidate = null; let maxArea = -1;
                        for (const m of activeMedia) {
                             if (m.tagName === 'VIDEO' && visMap.get(m)) {
                                 const area = (m.clientWidth||0) * (m.clientHeight||0);
                                 if (area > maxArea) { maxArea = area; bestCandidate = m; }
                             }
                        }
                        if (bestCandidate && bestCandidate !== currentBest) {
                            this.stateManager.set('media.currentlyVisibleMedia', bestCandidate);
                            const vf = this.stateManager.get('videoFilter'); const active = this.stateManager.get('app.scriptActive');
                            if (active && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(bestCandidate, { autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
                        }
                    }
                }, { root: null, rootMargin: '0px', threshold: [0, 0.1, 0.5] });
            }
        }
        scheduleNextScan() {
            if (this.scanTimerId) clearTimeout(this.scanTimerId);
            this.scanTimerId = setTimeout(() => {
                if (document.hidden) { this.currentScanInterval = this.baseScanInterval; this.scheduleNextScan(); return; }
                scheduleScan(null);
                requestIdle(() => {
                    this._cleanupDeadIframes();
                    for (const [v] of this._ioRatio) if (!v || !v.isConnected) this._ioRatio.delete(v);
                    if (window._shadowDomList_) window._shadowDomList_ = window._shadowDomList_.filter(r => r && r.host && r.host.isConnected);
                    const activeMedia = this.stateManager.get('media.activeMedia'); const activeImages = this.stateManager.get('media.activeImages');
                    if (activeMedia.size > 0 || activeImages.size > 0) { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; } 
                    else { this.emptyScanCount++; if (this.emptyScanCount > 3) this.currentScanInterval = Math.min(CONFIG.SCAN_INTERVAL_MAX, this.currentScanInterval * 1.5); }
                    this.scheduleNextScan();
                });
            }, this.currentScanInterval);
        }
        resetScanInterval() { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scheduleNextScan(); } }
        scanAndApply() { const visited = new WeakSet(); this._processAllElements(visited); }
        scanSpecificRoot(root) {
            if (!root) return;
            if (root.nodeType === 1 && (root.tagName === 'VIDEO' || root.tagName === 'IMG')) {
                const mediaSet = new Set(); const imageSet = new Set();
                if (root.tagName === 'VIDEO') mediaSet.add(root); else imageSet.add(root);
                this._applyToSets(mediaSet, imageSet); return;
            }
            const visited = new WeakSet(); const { media, images } = this.findAllElements(root, 0, true, visited); this._applyToSets(media, images);
        }
        _applyToSets(mediaSet, imageSet) {
            const currentMedia = this.stateManager.get('media.activeMedia'); const currentImages = this.stateManager.get('media.activeImages');
            let mediaChanged = false, imagesChanged = false;
            mediaSet.forEach(el => { if(el.isConnected && this.attachMediaListeners(el)) { if (!currentMedia.has(el)) { currentMedia.add(el); mediaChanged = true; } } });
            imageSet.forEach(el => { if(el.isConnected && this.attachImageListeners(el)) { if (!currentImages.has(el)) { currentImages.add(el); imagesChanged = true; } } });
            if (mediaChanged) this.stateManager.set('media.activeMedia', new Set(currentMedia)); if (imagesChanged) this.stateManager.set('media.activeImages', new Set(currentImages));
        }
        _processAllElements(visited) {
            const { media, images } = this.findAllElements(document, 0, false, visited);
            if ((media.size > 0 || images.size > 0) && !this.stateManager.get('ui.globalContainer')) this.stateManager.set('ui.createRequested', true);
            this._syncSet(media, 'media.activeMedia', this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this));
            this._syncSet(images, 'media.activeImages', this.attachImageListeners.bind(this), this.detachImageListeners.bind(this));
        }
        _syncSet(newSet, stateKey, attachFn, detachFn) {
            const activeSet = this.stateManager.get(stateKey); const oldElements = new Set(activeSet); const nextActiveSet = new Set();
            newSet.forEach(el => { if (el.isConnected) { if (attachFn(el)) { nextActiveSet.add(el); oldElements.delete(el); } } });
            oldElements.forEach(detachFn);
            if (nextActiveSet.size !== activeSet.size || ![...nextActiveSet].every(el => activeSet.has(el))) this.stateManager.set(stateKey, nextActiveSet);
        }
        _cleanupDeadIframes() {
            for (const [frame, mo] of this._iframeObservers) {
                if (!frame || !frame.isConnected) {
                    try { mo.disconnect(); } catch {} this._iframeObservers.delete(frame);
                    const internal = this._iframeInternalObservers.get(frame);
                    if (internal && internal.mo) { try { internal.mo.disconnect(); } catch {} }
                    this._iframeInternalObservers.delete(frame);
                    try { frame.removeEventListener('load', frame._vscOnLoad, PASSIVE); } catch {}
                }
            }
        }
        _hookIframe(frame) {
            if (!frame || this._seenIframes.has(frame)) return; this._seenIframes.add(frame); if (this._iframeObservers.has(frame)) return;
            const burstRescan = () => {
                const now = Date.now(); const last = this._iframeBurstCooldown.get(frame) || 0;
                if (now - last < 1500) return; this._iframeBurstCooldown.set(frame, now); this.resetScanInterval(); [200, 800, 2000].forEach(d => setTimeout(() => scheduleScan(null), d));
            };
            const attachInternalObserver = () => {
                try {
                    const doc = frame.contentDocument; if (!doc || !doc.body) return;
                    const prev = this._iframeInternalObservers.get(frame); if (prev && prev.doc === doc) return;
                    if (prev && prev.mo) { try { prev.mo.disconnect(); } catch {} }
                    const internalMo = new MutationObserver(() => burstRescan());
                    internalMo.observe(doc.body, { childList: true, subtree: true });
                    this._iframeInternalObservers.set(frame, { doc, mo: internalMo });
                } catch {}
            };
            const onLoad = () => { burstRescan(); attachInternalObserver(); }; frame._vscOnLoad = onLoad;
            try { frame.addEventListener('load', onLoad, PASSIVE); } catch(e) {}
            const mo = new MutationObserver((ms) => { if (!frame.isConnected) return; for (const m of ms) if (m.type === 'attributes') { burstRescan(); break; } });
            try { mo.observe(frame, { attributes: true, attributeFilter: CONFIG.MUTATION_ATTR_FILTER }); this._iframeObservers.set(frame, mo); } catch {}
            attachInternalObserver();
        }
        findAllElements(root, depth, skipShadowScan, visited) {
            const media = new Set(); const images = new Set();
            if (!root) return { media, images }; if (depth > CONFIG.MAX_RECURSION_DEPTH) return { media, images };
            const wantImages = this.stateManager.get('app.scriptActive') && (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);
            const selector = wantImages ? 'video, img, iframe' : 'video, iframe';
            const candidates = root.querySelectorAll(selector);
            if (root === document) { const hasShadow = Array.isArray(window._shadowDomList_) && window._shadowDomList_.length > 0; if (!candidates.length && !hasShadow) return { media, images }; } else { if (!candidates.length) return { media, images }; }
            if (root.nodeType === 1) {
                 if (root.tagName === 'VIDEO') { if (root.offsetWidth >= CONFIG.VIDEO_MIN_SIZE || root.offsetHeight >= CONFIG.VIDEO_MIN_SIZE || root.videoWidth >= CONFIG.VIDEO_MIN_SIZE || root.videoHeight >= CONFIG.VIDEO_MIN_SIZE) media.add(root); }
                 else if (root.tagName === 'IMG' && wantImages) { if ((root.naturalWidth > CONFIG.IMAGE_MIN_SIZE && root.naturalHeight > CONFIG.IMAGE_MIN_SIZE) || (root.offsetWidth > CONFIG.IMAGE_MIN_SIZE && root.offsetHeight > CONFIG.IMAGE_MIN_SIZE)) images.add(root); }
                 else if (root.tagName === 'IFRAME') this._hookIframe(root);
            }
            if (visited.has(root)) return { media, images }; visited.add(root);
            candidates.forEach(el => {
                if (el.tagName === 'VIDEO') { const isPotential = (el.src || el.currentSrc || el.querySelector('source')); const sizeOk = (el.offsetWidth >= CONFIG.VIDEO_MIN_SIZE || el.offsetHeight >= CONFIG.VIDEO_MIN_SIZE); if (sizeOk || isPotential) media.add(el); }
                else if (el.tagName === 'IMG') { if ((el.naturalWidth > CONFIG.IMAGE_MIN_SIZE && el.naturalHeight > CONFIG.IMAGE_MIN_SIZE) || (el.offsetWidth > CONFIG.IMAGE_MIN_SIZE && el.offsetHeight > CONFIG.IMAGE_MIN_SIZE)) images.add(el); }
                else if (el.tagName === 'IFRAME') { this._hookIframe(el); try { if (el.contentDocument) { const res = this.findAllElements(el.contentDocument, depth + 1, skipShadowScan, visited); res.media.forEach(m => media.add(m)); res.images.forEach(i => images.add(i)); } } catch (e) {} }
            });
            if (!skipShadowScan) { (window._shadowDomList_ || []).forEach(shadowRoot => { try { const res = this.findAllElements(shadowRoot, depth + 1, true, visited); res.media.forEach(m => media.add(m)); res.images.forEach(i => images.add(i)); } catch (e) { } }); }
            return { media, images };
        }
        attachMediaListeners(media) {
            const owner = media.getAttribute('data-vsc-controlled-by');
            if (owner && owner !== VSC_INSTANCE_ID) return false;
            if (this.stateManager.get('media.mediaListenerMap').has(media)) return true;
            try { this.intersectionObserver.observe(media); } catch(e) { return false; }
            media.setAttribute('data-vsc-controlled-by', VSC_INSTANCE_ID);
            const visMap = this.stateManager.get('media.visibilityMap'); if(visMap) visMap.set(media, false);
            if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);
            const handleRescan = throttle(() => this.resetScanInterval(), 250);
            MEDIA_EVENTS.forEach(evt => media.addEventListener(evt, handleRescan, PASSIVE));
            const updateRate = () => this.stateManager.set('playback.currentRate', media.playbackRate);
            media.addEventListener('play', updateRate, PASSIVE); media.addEventListener('ratechange', updateRate, PASSIVE);
            
            // [v128.41] Fix (1-A): Named playing handler for proper cleanup
            const onPlaying = () => {
                if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);
                const isVis = this.stateManager.get('media.visibilityMap').get(media);
                if (isVis) {
                    this.stateManager.set('media.currentlyVisibleMedia', media);
                    const vf = this.stateManager.get('videoFilter'); const active = this.stateManager.get('app.scriptActive');
                    if (active && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(media, { autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
                }
            };
            media.addEventListener('playing', onPlaying, PASSIVE);

            const cleanup = () => {
                MEDIA_EVENTS.forEach(evt => media.removeEventListener(evt, handleRescan, PASSIVE));
                media.removeEventListener('play', updateRate, PASSIVE); media.removeEventListener('ratechange', updateRate, PASSIVE);
                media.removeEventListener('playing', onPlaying, PASSIVE); // Cleaned
            };
            this.stateManager.get('media.mediaListenerMap').set(media, cleanup);
            return true;
        }
        detachMediaListeners(media) {
            const listenerMap = this.stateManager.get('media.mediaListenerMap'); if (!listenerMap.has(media)) return;
            if (media.getAttribute('data-vsc-controlled-by') === VSC_INSTANCE_ID) media.removeAttribute('data-vsc-controlled-by');
            const cleanup = listenerMap.get(media); if (typeof cleanup === 'function') cleanup();
            listenerMap.delete(media); try { this.intersectionObserver.unobserve(media); } catch(e) {} this._ioRatio.delete(media);
        }
        attachImageListeners(image) {
            if (!image || !this.intersectionObserver) return false;
            if (this.stateManager.filterManagers.image) injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager);
            const visMap = this.stateManager.get('media.visibilityMap'); if(visMap) visMap.set(image, false);
            if (!this._observedImages.has(image)) { try { this.intersectionObserver.observe(image); this._observedImages.add(image); } catch(e){} }
            return true;
        }
        detachImageListeners(image) { try { this.intersectionObserver.unobserve(image); } catch(e){} this._observedImages.delete(image); }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, contrast: 0, clarityComp: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this._mediaStateRafId = null; }
        init(stateManager) {
            super.init(stateManager);
            const isMobile = this.stateManager.get('app.isMobile');
            this.filterManager = this._createManager({ settings: isMobile ? CONFIG.MOBILE_FILTER_SETTINGS : CONFIG.DESKTOP_FILTER_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', className: 'vsc-video-filter-active', isImage: false });
            this.imageFilterManager = this._createManager({ settings: CONFIG.IMAGE_FILTER_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', className: 'vsc-image-filter-active', isImage: true });
            this.subscribe('app.scriptActive', (active) => {
                if(active) {
                    this.filterManager.init(); this.imageFilterManager.init();
                    const sm = this.stateManager; const activeMedia = sm.get('media.activeMedia'); const activeImages = sm.get('media.activeImages');
                    if (activeMedia.size > 0) activeMedia.forEach(m => { if (!m.isConnected) return; injectFiltersIntoContext(m, this.filterManager, sm); this._updateVideoFilterState(m); });
                    if (activeImages.size > 0) activeImages.forEach(i => { if (!i.isConnected) return; injectFiltersIntoContext(i, this.imageFilterManager, sm); this._updateImageFilterState(i); });
                    this.applyAllVideoFilters(); this.applyAllImageFilters();
                } else { this.applyAllVideoFilters(); this.applyAllImageFilters(); }
            });
            this.stateManager.filterManagers.video = this.filterManager; this.stateManager.filterManagers.image = this.imageFilterManager;
            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this)); this.subscribe('imageFilter.level', this.applyAllImageFilters.bind(this)); this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates()); this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates()); this.subscribe('app.scriptActive', () => { this.updateMediaFilterStates(); });
            this.throttledUpdate = throttle((e) => {
                const { autoParams } = e.detail; const vf = this.stateManager.get('videoFilter'); const needAutoApply = vf.autoExposure || (vf.clarity > 0);
                const isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.002 || Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.1 || Math.abs((this.lastAutoParams.clarityComp||0) - (autoParams.clarityComp||0)) > 0.1 || Math.abs((this.lastAutoParams.shadowsAdj||0) - (autoParams.shadowsAdj||0)) > 0.1 || Math.abs((this.lastAutoParams.highlightsAdj||0) - (autoParams.highlightsAdj||0)) > 0.1;
                if (needAutoApply && isChanged) { this.lastAutoParams = autoParams; this.applyAllVideoFilters(); }
            }, 200);
            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
        }
        destroy() { super.destroy(); if (this.throttledUpdate) document.removeEventListener('vsc-smart-limit-update', this.throttledUpdate); if(this._rafId) cancelAnimationFrame(this._rafId); if(this._imageRafId) cancelAnimationFrame(this._imageRafId); if(this._mediaStateRafId) cancelAnimationFrame(this._mediaStateRafId); }
        _createManager(options) {
            class SvgFilterManager {
                constructor(options) { this._isInitialized = false; this._styleElement = null; this._svgNode = null; this._options = options; this._elementCache = new WeakMap(); this._activeFilterRoots = new Set(); this._globalToneCache = { key: null, table: null }; this._lastValues = null; this._clarityTableCache = new Map(); }
                isInitialized() { return this._isInitialized; } getSvgNode() { return this._svgNode; } getStyleNode() { return this._styleElement; }
                init() { if (this._isInitialized) return; safeGuard(() => { const { svgNode, styleElement } = this._createElements(); this._svgNode = svgNode; this._styleElement = styleElement; (document.head || document.documentElement).appendChild(styleElement); (document.body || document.documentElement).appendChild(svgNode); this._activeFilterRoots.add(this._svgNode); this._isInitialized = true; }, `${this.constructor.name}.init`); }
                registerContext(svgElement) { this._activeFilterRoots.add(svgElement); }
                _createElements() {
                    const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
                    const { settings, svgId, styleId, className, isImage } = this._options;
                    const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`;
                    const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
                    const combinedFilter = createSvgElement('filter', { id: combinedFilterId, "color-interpolation-filters": "sRGB" });
                    const clarityTransfer = createSvgElement('feComponentTransfer', { "data-vsc-id": "clarity_transfer", in: "SourceGraphic", result: "clarity_out" });
                    ['R', 'G', 'B'].forEach(c => clarityTransfer.append(createSvgElement('feFunc' + c, { "data-vsc-id": "clarity_func", type: "table", tableValues: "0 1" })));
                    const blurFine = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_fine", in: "clarity_out", stdDeviation: "0", result: "blur_fine_out" });
                    const compFine = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_fine", operator: "arithmetic", in: "clarity_out", in2: "blur_fine_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_fine" });
                    const blurCoarse = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_coarse", in: "sharpened_fine", stdDeviation: "0", result: "blur_coarse_out" });
                    const compCoarse = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_coarse", operator: "arithmetic", in: "sharpened_fine", in2: "blur_coarse_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_final" });
                    const grainNode = createSvgElement('feTurbulence', { "data-vsc-id": "grain_gen", type: "fractalNoise", baseFrequency: "0.80", numOctaves: "1", stitchTiles: "noStitch", result: "grain_noise" });
                    const grainComp = createSvgElement('feComposite', { "data-vsc-id": "grain_comp", operator: "arithmetic", in: "sharpened_final", in2: "grain_noise", k1: "0", k2: "1", k3: "0", k4: "0", result: "grained_out" });
                    if (isImage) {
                         const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "grained_out", result: "final_out" });
                         colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                         colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                         colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                         combinedFilter.append(clarityTransfer, blurFine, compFine, blurCoarse, compCoarse, grainNode, grainComp, colorTemp);
                    } else {
                        const lumaContrast = createSvgElement('feColorMatrix', { "data-vsc-id": "luma_contrast_matrix", in: "grained_out", type: "matrix", values: "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0", result: "luma_contrast_out" });
                        const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: "luma_contrast_out", type: "saturate", values: (settings.SATURATION_VALUE / 100).toString(), result: "saturate_out" });
                        const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA_VALUE).toString() })));
                        const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));
                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "tone_out", result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                        combinedFilter.append(clarityTransfer, blurFine, compFine, blurCoarse, compCoarse, grainNode, grainComp, lumaContrast, saturation, gamma, toneCurve, colorTemp);
                    }
                    svg.append(combinedFilter);
                    const style = document.createElement('style'); style.id = styleId; style.textContent = `.${className} { filter: url(#${combinedFilterId}) !important; }`;
                    return { svgNode: svg, styleElement: style };
                }
                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const sig = `${values.gamma}|${values.sharpenLevel}|${values.level2}|${values.shadows}|${values.highlights}|${values.brightness}|${values.contrastAdj}|${values.colorTemp}|${values.dither}|${values.clarity}|${values.autoExposure}|${values.targetLuma}`;
                    if (this._lastValues === sig) return; this._lastValues = sig;
                    const { saturation, gamma, sharpenLevel, level2, shadows, highlights, brightness, contrastAdj, colorTemp, dither, clarity } = values;
                    let currentToneTable = null; const contrastSafe = (contrastAdj == null) ? 1.0 : Number(contrastAdj);
                    const toneKey = (shadows !== undefined) ? `${(+shadows).toFixed(2)}_${(+highlights).toFixed(2)}_${(+brightness || 0).toFixed(2)}_${(+contrastSafe || 1).toFixed(3)}` : null;
                    if (toneKey) {
                        if (this._globalToneCache.key !== toneKey) {
                            const genSCurveTable = (sh, hi, br = 0, contrast = 1.0) => {
                                const steps = 256; const vals = []; const clamp = (n, min, max) => Math.min(max, Math.max(min, n)); const smoothstep = (t) => t * t * (3 - 2 * t);
                                const shN = clamp((sh || 0) / 100, -1, 1); const hiN = clamp((hi || 0) / 100, -1, 1);
                                const b = clamp((br || 0) / 100, -1, 1) * 0.12; const c = clamp(Number(contrast || 1.0), 0.8, 1.4);
                                const toe = clamp(0.20 + shN * 0.10, 0.05, 0.40); const shoulder = clamp(0.70 - hiN * 0.10, 0.55, 0.92);
                                const toeStrength = 0.18 + 0.22 * Math.abs(shN); const shoulderStrength = 0.08 + 0.18 * Math.abs(hiN);
                                for (let i = 0; i < steps; i++) {
                                    let x = i / (steps - 1); let y = x;
                                    y = clamp(y + b, 0, 1); y = clamp(0.5 + (y - 0.5) * c, 0, 1);
                                    if (shN !== 0 && y < toe) { const t = clamp(y / Math.max(1e-6, toe), 0, 1); const ss = smoothstep(t); const dir = Math.sign(shN); y = y + dir * (toe - y) * toeStrength * (1 - ss); }
                                    if (hiN !== 0 && y > shoulder) { const t = clamp((y - shoulder) / Math.max(1e-6, (1 - shoulder)), 0, 1); const ss = smoothstep(t); const dir = Math.sign(hiN); y = y - dir * shoulderStrength * ss * t; }
                                    vals.push(Math.round(clamp(y, 0, 1) * 10000) / 10000);
                                }
                                return vals.join(' ');
                            };
                            this._globalToneCache.key = toneKey; this._globalToneCache.table = genSCurveTable(shadows, highlights, brightness || 0, contrastSafe || 1.0);
                        }
                        currentToneTable = this._globalToneCache.table;
                    }
                    const isImage = this._options.isImage; const dead = [];
                    for (const rootNode of this._activeFilterRoots) {
                        if (!rootNode || !rootNode.isConnected) { dead.push(rootNode); continue; }
                        let cache = this._elementCache.get(rootNode);
                        if (!cache) {
                            cache = {
                                blurFine: rootNode.querySelector('[data-vsc-id="sharpen_blur_fine"]'), compFine: rootNode.querySelector('[data-vsc-id="sharpen_comp_fine"]'),
                                blurCoarse: rootNode.querySelector('[data-vsc-id="sharpen_blur_coarse"]'), compCoarse: rootNode.querySelector('[data-vsc-id="sharpen_comp_coarse"]'),
                                saturate: rootNode.querySelector('[data-vsc-id="saturate"]'), gammaFuncs: rootNode.querySelectorAll('[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB'), toneCurveFuncs: rootNode.querySelectorAll('[data-vsc-id="tone_curve"] feFuncR, [data-vsc-id="tone_curve"] feFuncG, [data-vsc-id="tone_curve"] feFuncB'),
                                ctRed: rootNode.querySelector('[data-vsc-id="ct_red"]'), ctGreen: rootNode.querySelector('[data-vsc-id="ct_green"]'), ctBlue: rootNode.querySelector('[data-vsc-id="ct_blue"]'),
                                lumaContrastMatrix: rootNode.querySelector('[data-vsc-id="luma_contrast_matrix"]'), clarityFuncs: rootNode.querySelectorAll('[data-vsc-id="clarity_func"]'), grainComp: rootNode.querySelector('[data-vsc-id="grain_comp"]'), appliedToneKey: null
                            }; this._elementCache.set(rootNode, cache);
                        }
                        if (clarity !== undefined && cache.clarityFuncs) {
                             let tableVal = this._clarityTableCache.get(clarity);
                             if (!tableVal) {
                                 const strength = clarity / 50; const steps = 64; const vals = [];
                                 for(let i=0; i<steps; i++) { let x = i/(steps-1); let smooth = x*x*(3 - 2*x); let y = x * (1 - strength) + smooth * strength; vals.push(Math.round(y * 10000) / 10000); }
                                 tableVal = vals.join(' '); this._clarityTableCache.set(clarity, tableVal);
                             }
                             cache.clarityFuncs.forEach(el => { setAttr(el, 'tableValues', tableVal); });
                        }
                        if (sharpenLevel !== undefined) {
                            let strCoarse = 0; let strFine = 0;
                            if (isImage) { strFine = Math.min(4.0, sharpenLevel * 0.12); strCoarse = 0; }
                            else { strCoarse = Math.min(3.0, sharpenLevel * 0.05); strFine = (values.level2 !== undefined) ? Math.min(3.0, values.level2 * 0.06) : 0; }
                            const sCurve = (x) => x * x * (3 - 2 * x);
                            const fineProgress = Math.min(1, strFine / 3.0); const fineSigma = 0.5 - (sCurve(fineProgress) * 0.3); const fineK = sCurve(fineProgress) * 3.5;
                            const coarseProgress = Math.min(1, strCoarse / 3.0); const coarseSigma = 1.5 - (sCurve(coarseProgress) * 0.8); const coarseK = sCurve(coarseProgress) * 2.0;
                            const safeFineK = Math.min(6.0, fineK); const safeCoarseK = Math.min(4.0, coarseK);
                            if (strFine <= 0.01) { setAttr(cache.blurFine, 'stdDeviation', "0"); if (cache.compFine) { setAttr(cache.compFine, 'k2', "1"); setAttr(cache.compFine, 'k3', "0"); } }
                            else { setAttr(cache.blurFine, 'stdDeviation', fineSigma.toFixed(2)); if (cache.compFine) { setAttr(cache.compFine, 'k2', (1 + safeFineK).toFixed(3)); setAttr(cache.compFine, 'k3', (-safeFineK).toFixed(3)); } }
                            if (strCoarse <= 0.01) { setAttr(cache.blurCoarse, 'stdDeviation', "0"); if (cache.compCoarse) { setAttr(cache.compCoarse, 'k2', "1"); setAttr(cache.compCoarse, 'k3', "0"); } }
                            else { setAttr(cache.blurCoarse, 'stdDeviation', coarseSigma.toFixed(2)); if (cache.compCoarse) { setAttr(cache.compCoarse, 'k2', (1 + safeCoarseK).toFixed(3)); setAttr(cache.compCoarse, 'k3', (-safeCoarseK).toFixed(3)); } }
                        }
                        if (dither !== undefined && cache.grainComp) { const val = dither / 100; const amount = val * 0.25; setAttr(cache.grainComp, 'k3', amount.toFixed(3)); }
                        if (saturation !== undefined && cache.saturate) setAttr(cache.saturate, 'values', (saturation / 100).toString());
                        if (gamma !== undefined && cache.gammaFuncs) { const exp = (1 / gamma).toString(); cache.gammaFuncs.forEach(el => setAttr(el, 'exponent', exp)); }
                        if (currentToneTable && cache.toneCurveFuncs) { if (cache.appliedToneKey !== toneKey) { cache.appliedToneKey = toneKey; cache.toneCurveFuncs.forEach(el => setAttr(el, 'tableValues', currentToneTable)); } }
                        if (contrastSafe !== undefined && cache.lumaContrastMatrix) {
                            const cAmount = (contrastSafe - 1.0) * 0.9; const r = 0.2126 * cAmount; const g = 0.7152 * cAmount; const b = 0.0722 * cAmount;
                            const mVals = [1+r, g, b, 0, 0, r, 1+g, b, 0, 0, r, g, 1+b, 0, 0, 0, 0, 0, 1, 0].join(' '); setAttr(cache.lumaContrastMatrix, 'values', mVals);
                        }
                        if (colorTemp !== undefined && cache.ctBlue && cache.ctRed && cache.ctGreen) {
                            const t = colorTemp; const warm = Math.max(0, t); const cool = Math.max(0, -t);
                            const rSlope = 1 + warm * 0.003 - cool * 0.005; const gSlope = 1 + warm * 0.002 - cool * 0.004; const bSlope = 1 - warm * 0.006 + cool * 0.000;
                            const clamp = (v) => Math.max(0.7, Math.min(1.3, v));
                            setAttr(cache.ctRed, 'slope', clamp(rSlope).toFixed(3)); setAttr(cache.ctGreen, 'slope', clamp(gSlope).toFixed(3)); setAttr(cache.ctBlue, 'slope', clamp(bSlope).toFixed(3));
                        }
                    }
                    dead.forEach(node => this._activeFilterRoots.delete(node));
                }
            }
            return new SvgFilterManager(options);
        }
        applyAllVideoFilters() { if (this._rafId) return; this._rafId = requestAnimationFrame(() => { this._rafId = null; this._applyAllVideoFiltersActual(); }); }
        _applyAllVideoFiltersActual() {
            if (!this.filterManager.isInitialized()) return;
            if (!this.stateManager.get('app.scriptActive')) {
                 this.filterManager.updateFilterValues({ saturation: 100, gamma: 1.0, blur: 0, sharpenLevel: 0, level2: 0, shadows: 0, highlights: 0, brightness: 0, contrastAdj: 1.0, colorTemp: 0, dither: 0, clarity: 0, autoExposure: 0 });
                 VideoAnalyzer.stop(); this.updateMediaFilterStates(); return;
            }
            const vf = this.stateManager.get('videoFilter');
            let auto = this.lastAutoParams || { gamma: 1.0, bright: 0, contrast: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 };
            if (!vf.autoExposure) { auto = { ...auto, gamma: 1.0, bright: 0, contrast: 0, shadowsAdj: 0, highlightsAdj: 0 }; }
            const finalGamma = vf.gamma * (auto.gamma || 1.0); const finalBrightness = vf.brightness + (auto.bright || 0) + (auto.clarityComp || 0); const finalContrastAdj = vf.contrastAdj; const finalHighlights = vf.highlights + (auto.highlightsAdj || 0); const finalShadows = vf.shadows + (auto.shadowsAdj || 0);
            let autoSharpLevel2 = vf.level2; if (vf.clarity > 0) { autoSharpLevel2 += Math.min(5, vf.clarity * 0.15); }
            const values = { saturation: vf.saturation, gamma: finalGamma, blur: 0, sharpenLevel: vf.level, level2: autoSharpLevel2, shadows: finalShadows, highlights: finalHighlights, brightness: finalBrightness, contrastAdj: finalContrastAdj, colorTemp: vf.colorTemp, dither: vf.dither, clarity: vf.clarity, autoExposure: vf.autoExposure, targetLuma: vf.targetLuma };
            this.filterManager.updateFilterValues(values); VideoAnalyzer.updateSettings({ autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
            this.updateMediaFilterStates();
        }
        applyAllImageFilters() { if (this._imageRafId) return; this._imageRafId = requestAnimationFrame(() => { this._imageRafId = null; if (!this.imageFilterManager.isInitialized()) return; const active = this.stateManager.get('app.scriptActive'); const level = active ? this.stateManager.get('imageFilter.level') : 0; const colorTemp = active ? this.stateManager.get('imageFilter.colorTemp') : 0; const values = { sharpenLevel: level, colorTemp: colorTemp }; this.imageFilterManager.updateFilterValues(values); this.updateMediaFilterStates(); }); }
        updateMediaFilterStates() { if (this._mediaStateRafId) return; this._mediaStateRafId = requestAnimationFrame(() => { this._mediaStateRafId = null; this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO') this._updateVideoFilterState(media); }); this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); }); }); }
        _updateVideoFilterState(video) {
            const scriptActive = this.stateManager.get('app.scriptActive'); const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.shadows !== 0 || vf.highlights !== 0 || vf.brightness !== 0 || Math.abs(vf.contrastAdj - 1.0) > 0.001 || vf.colorTemp !== 0 || vf.dither > 0 || vf.autoExposure > 0 || vf.clarity !== 0;
            const isVis = this.stateManager.get('media.visibilityMap').get(video);
            const isActive = scriptActive && isVis && shouldApply;
            if (isActive) { if (video.style.willChange !== 'filter, transform') video.style.willChange = 'filter, transform'; } else { if (video.style.willChange) video.style.willChange = ''; }
            video.classList.toggle('vsc-video-filter-active', isActive);
        }
        _updateImageFilterState(image) {
            const scriptActive = this.stateManager.get('app.scriptActive'); if (!scriptActive) { image.classList.remove('vsc-image-filter-active'); return; }
            const level = this.stateManager.get('imageFilter.level'); const colorTemp = this.stateManager.get('imageFilter.colorTemp');
            const shouldApply = level > 0 || colorTemp !== 0;
            const isVis = this.stateManager.get('media.visibilityMap').get(image);
            const isActive = isVis && shouldApply;
            image.classList.toggle('vsc-image-filter-active', isActive);
        }
    }

    class LiveStreamPlugin extends Plugin {
        constructor() { super('LiveStream'); this.video = null; this.avgDelay = null; this.intervalId = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL; }
        init(stateManager) {
            super.init(stateManager); if (!CONFIG.ENABLE_LIVE_DELAY) return;
            this.subscribe('liveStream.isRunning', (running) => { if (running) this.start(); else this.stop(); });
            this.subscribe('app.scriptActive', (active) => { const isLiveSite = CONFIG.LIVE_STREAM_SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d)); if (active && isLiveSite) this.stateManager.set('liveStream.isRunning', true); else this.stateManager.set('liveStream.isRunning', false); });
            this.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge());
            this.subscribe('liveStream.resetRequested', () => { if (this.stateManager.get('liveStream.isRunning')) { this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; log('Live stream delay meter reset.'); } });
            if (this.stateManager.get('app.scriptActive') && CONFIG.LIVE_STREAM_SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d))) { this.stateManager.set('liveStream.isRunning', true); }
        }
        destroy() { super.destroy(); this.stop(); }
        switchInterval(newInterval) { if (this.currentInterval === newInterval) return; clearInterval(this.intervalId); this.currentInterval = newInterval; this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        findVideo() { const visibleVideos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO' && this.stateManager.get('media.visibilityMap').get(m)); if (visibleVideos.length === 0) return null; return visibleVideos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]; }
        calculateDelay(v) { if (!v) return null; if (typeof v.liveLatency === 'number' && v.liveLatency > 0) return v.liveLatency * 1000; if (v.buffered && v.buffered.length > 0) { try { const end = v.buffered.end(v.buffered.length - 1); if (v.currentTime > end) return 0; return Math.max(0, (end - v.currentTime) * 1000); } catch { return null; } } return null; }
        getSmoothPlaybackRate(currentDelay, targetDelay) { const error = currentDelay - targetDelay; this.pidIntegral += error; this.pidIntegral = Math.max(-50000, Math.min(50000, this.pidIntegral)); const derivative = error - this.lastError; this.lastError = error; let rateChange = CONFIG.AUTODELAY_PID_KP * error + CONFIG.AUTODELAY_PID_KI * this.pidIntegral + CONFIG.AUTODELAY_PID_KD * derivative; return Math.max(CONFIG.AUTODELAY_MIN_RATE, Math.min(1 + rateChange, CONFIG.AUTODELAY_MAX_RATE)); }
        checkAndAdjust() {
            if (!this.stateManager.get('app.scriptActive')) return; if (document.hidden) return; if (Math.abs(this.stateManager.get('playback.targetRate') - 1.0) > 0.01) return; this.video = this.findVideo(); if (!this.video) return; const rawDelay = this.calculateDelay(this.video); if (rawDelay === null) { this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: null, rate: this.video.playbackRate }); return; } this.avgDelay = this.avgDelay === null ? rawDelay : CONFIG.AUTODELAY_EMA_ALPHA * rawDelay + (1 - CONFIG.AUTODELAY_EMA_ALPHA) * this.avgDelay; this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: rawDelay, rate: this.video.playbackRate }); const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY; const error = this.avgDelay - targetDelay; if (Math.abs(error) < CONFIG.AUTODELAY_STABLE_THRESHOLD) this.consecutiveStableChecks++; else { this.consecutiveStableChecks = 0; if (this.isStable) { this.isStable = false; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_NORMAL); } } if (this.consecutiveStableChecks >= CONFIG.AUTODELAY_STABLE_COUNT && !this.isStable) { this.isStable = true; this.switchInterval(CONFIG.AUTODELAY_INTERVAL_STABLE); } let newRate; const bufferHealth = (this.video.buffered && this.video.buffered.length) ? (this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime) : 10; if ((this.avgDelay !== null && this.avgDelay <= targetDelay) || bufferHealth < CONFIG.MIN_BUFFER_HEALTH_SEC) { newRate = 1.0; this.pidIntegral = 0; this.lastError = 0; } else { newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay); } if (Math.abs(this.video.playbackRate - newRate) > 0.001) { this.video.playbackRate = newRate; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { const isLiveNow = this.avgDelay !== null && this.avgDelay < (CONFIG.DEFAULT_TARGET_DELAY + 500); liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080'; } }
        start() { if (this.intervalId) return; setTimeout(() => { this.stateManager.set('liveStream.delayInfo', { raw: null, avg: null, rate: 1.0 }); }, 0); this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        stop() { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { liveJumpBtn.style.boxShadow = ''; } this.stateManager.set('liveStream.delayInfo', null); this.video = null; this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.AUTODELAY_INTERVAL_NORMAL; }
        seekToLiveEdge() { const videos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO'); if (videos.length === 0) return; const targetDelay = CONFIG.TARGET_DELAYS[location.hostname] || CONFIG.DEFAULT_TARGET_DELAY; videos.forEach(v => { try { const seekableEnd = (v.seekable && v.seekable.length > 0) ? v.seekable.end(v.seekable.length - 1) : Infinity; const bufferedEnd = (v.buffered && v.buffered.length > 0) ? v.buffered.end(v.buffered.length - 1) : 0; const liveEdge = Math.min(seekableEnd, bufferedEnd); if (!isFinite(liveEdge)) return; const delayMs = (liveEdge - v.currentTime) * 1000; if (delayMs <= targetDelay) return; if (!v._lastLiveJump) v._lastLiveJump = 0; if (Date.now() - v._lastLiveJump < CONFIG.LIVE_JUMP_INTERVAL) return; if (liveEdge - v.currentTime < CONFIG.LIVE_JUMP_END_THRESHOLD) return; v._lastLiveJump = Date.now(); v.currentTime = liveEdge - 0.5; if (v.paused) v.play().catch(console.warn); } catch (e) { log('seekToLiveEdge error:', e); } }); }
    }

    class PlaybackControlPlugin extends Plugin {
        init(stateManager) { super.init(stateManager); this.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate)); }
        setPlaybackRate(rate) { this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO' && media.playbackRate !== rate) media.playbackRate = rate; }); }
    }

    class AudioEffectPlugin extends Plugin {
        constructor() { super('AudioEffect'); this.ctx = null; this.targetVideo = null; this.effectsEnabled = false; this.nodeMap = new Map(); this.nodes = { bypassGain: null, masterGain: null, bassFilter: null, compressor: null, makeupGain: null, effectInputGain: null }; this.audioRetryCache = new WeakMap(); this.audioFailCount = new WeakMap(); this.audioPermanentExcluded = new WeakSet(); }
        init(stateManager) { super.init(stateManager); if (!CONFIG.ENABLE_AUDIO_EFFECT) return; const unlock = async () => { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') await this.ctx.resume(); } catch {} }; document.addEventListener('pointerdown', unlock, { capture: true, once: true }); document.addEventListener('keydown', unlock, { capture: true, once: true }); this.subscribe('audio.bass', () => this.updateAudioParams()); this.subscribe('audio.pitch', () => this.updatePitchState()); this.subscribe('media.activeMedia', (newSet) => this.handleMediaChanges(newSet)); this.subscribe('media.currentlyVisibleMedia', () => this.handleMediaChanges(this.stateManager.get('media.activeMedia'))); this.subscribe('app.scriptActive', (active) => { if (!active) this.disableEffects(); }); }
        destroy() { super.destroy(); if (this.ctx && this.ctx.state !== 'closed') { this.ctx.close().catch(() => {}); this.ctx = null; } this.nodes = { bypassGain: null, masterGain: null, bassFilter: null, compressor: null, makeupGain: null, effectInputGain: null }; this.nodeMap.clear(); }
        disableEffects() { if (!this.ctx) return; if (this.nodes.bypassGain) this.smoothSet(this.nodes.bypassGain.gain, 1.0); if (this.nodes.effectInputGain) this.smoothSet(this.nodes.effectInputGain.gain, 0.0); }
        async handleMediaChanges(activeMedia) {
             if (!this.stateManager.get('app.scriptActive')) return; const bass = this.stateManager.get('audio.bass') || 0; if (bass <= 0) { this.disableEffects(); return; }
             if (!this.ctx || this.ctx.state !== 'running') { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') await this.ctx.resume(); } catch(e) {} } if (!this.ctx || this.ctx.state !== 'running') return; this.ensureGlobalNodes();
             const currentVideos = Array.from(activeMedia).filter(m => m.tagName === 'VIDEO');
             for (const [video, nodes] of this.nodeMap.entries()) { if (!video.isConnected) { try { nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); setTimeout(() => { try { nodes.source.disconnect(); nodes.gain.disconnect(); } catch(e) {} }, 200); } catch(e) {} this.nodeMap.delete(video); } else if (!activeMedia.has(video)) { try { nodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); } catch(e) {} } }
             const mainVideo = this.stateManager.get('media.currentlyVisibleMedia');
             currentVideos.forEach(video => {
                 if (this.audioPermanentExcluded.has(video)) return; const rec = this.audioRetryCache.get(video); if (rec && (Date.now() - rec.ts < 10000)) return;
                 const currentSrc = video.currentSrc || video.src; const cached = this.nodeMap.get(video);
                 if (cached) { if (cached.src !== currentSrc) cached.src = currentSrc; } else { try { const source = this.ctx.createMediaElementSource(video); const individualGain = this.ctx.createGain(); individualGain.gain.value = 0; source.connect(individualGain); individualGain.connect(this.nodes.masterGain); this.nodeMap.set(video, { source, gain: individualGain, src: currentSrc }); } catch(e) { const fails = (this.audioFailCount.get(video) || 0) + 1; this.audioFailCount.set(video, fails); if (fails > 3) this.audioPermanentExcluded.add(video); else this.audioRetryCache.set(video, { ts: Date.now(), count: fails }); } }
             });
             const now = this.ctx.currentTime;
             currentVideos.forEach(video => { const nodeData = this.nodeMap.get(video); if(!nodeData) return; const targetGain = (video === mainVideo) ? 1.0 : 0.0; try { nodeData.gain.gain.cancelScheduledValues(now); nodeData.gain.gain.setTargetAtTime(targetGain, now, 0.1); } catch(e) {} });
             if (this.targetVideo !== mainVideo) { this.targetVideo = mainVideo; if(this.targetVideo) { this.updatePitchState(); this.updateAudioParams(); } }
        }
        ensureGlobalNodes() {
            if (this.nodes.masterGain) return; this.nodes.masterGain = this.ctx.createGain(); this.nodes.bypassGain = this.ctx.createGain(); this.nodes.effectInputGain = this.ctx.createGain(); this.nodes.bassFilter = this.ctx.createBiquadFilter(); this.nodes.bassFilter.type = 'lowshelf'; this.nodes.bassFilter.frequency.value = CONFIG.AUDIO_BASS_FREQ; this.nodes.bassFilter.Q.value = 0.8; this.nodes.compressor = this.ctx.createDynamicsCompressor(); this.nodes.makeupGain = this.ctx.createGain();
            this.nodes.masterGain.connect(this.nodes.bypassGain); this.nodes.bypassGain.connect(this.ctx.destination); this.nodes.masterGain.connect(this.nodes.effectInputGain); this.nodes.effectInputGain.connect(this.nodes.bassFilter); this.nodes.bassFilter.connect(this.nodes.compressor); this.nodes.compressor.connect(this.nodes.makeupGain); this.nodes.makeupGain.connect(this.ctx.destination); this.nodes.bypassGain.gain.value = 1.0; this.nodes.effectInputGain.gain.value = 0.0;
        }
        smoothSet(param, value, timeConstant = 0.02) { if (!this.ctx || !param) return; const now = this.ctx.currentTime; try { param.cancelScheduledValues(now); param.setTargetAtTime(value, now, timeConstant); } catch (e) {} }
        updatePitchState() { if (!this.targetVideo) return; const preserve = this.stateManager.get('audio.pitch'); if ('preservesPitch' in this.targetVideo) this.targetVideo.preservesPitch = preserve; else if ('mozPreservesPitch' in this.targetVideo) this.targetVideo.mozPreservesPitch = preserve; else if ('webkitPreservesPitch' in this.targetVideo) this.targetVideo.webkitPreservesPitch = preserve; }
        async updateAudioParams() {
            const bass = this.stateManager.get('audio.bass') || 0; if (bass > 0 && (!this.ctx || this.ctx.state !== 'running')) { if (!this.ctx) try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){} if (this.ctx && this.ctx.state === 'suspended') try { await this.ctx.resume(); } catch(e){} } if (!this.ctx || this.ctx.state !== 'running') return; this.ensureGlobalNodes();
            const isEffectActive = (bass > 0); this.effectsEnabled = isEffectActive;
            if (isEffectActive) { this.smoothSet(this.nodes.bypassGain.gain, 0.0); this.smoothSet(this.nodes.effectInputGain.gain, 1.0); this.smoothSet(this.nodes.bassFilter.gain, bass * CONFIG.AUDIO_BASS_MAX_DB); this.smoothSet(this.nodes.makeupGain.gain, 1.0 + (bass * 0.3)); } 
            else { this.smoothSet(this.nodes.bypassGain.gain, 1.0); this.smoothSet(this.nodes.effectInputGain.gain, 0.0); }
        }
    }

    class NavigationPlugin extends Plugin {
        constructor(pluginManager) { super('Navigation'); this.pluginManager = pluginManager; this.spaNavigationHandler = debounce(this.handleNavigation.bind(this), 100); }
        init(stateManager) { super.init(stateManager); if (history._vscWrapped) return; history._vscWrapped = true; const wrapHistory = (type) => { const orig = history[type]; return (...args) => { const rv = orig.apply(history, args); this.spaNavigationHandler(); return rv; }; }; history.pushState = wrapHistory('pushState'); history.replaceState = wrapHistory('replaceState'); window.addEventListener('popstate', this.spaNavigationHandler); }
        destroy() { super.destroy(); window.removeEventListener('popstate', this.spaNavigationHandler); }
        handleNavigation() { const currentUrl = location.href; if (currentUrl === this.stateManager.get('ui.lastUrl')) return; this.stateManager.set('ui.lastUrl', currentUrl); log('SPA Navigation Detected.'); const corePlugin = this.pluginManager.plugins.find(p => p.name === 'CoreMedia'); if (corePlugin) { corePlugin.scanAndApply(); [500, 1000, 2000].forEach(delay => { setTimeout(() => corePlugin.scanAndApply(), delay); }); } }
    }

    class UIPlugin extends Plugin {
        constructor() { super('UI'); this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null; this.hostElement = null; this.shadowRoot = null; this.isDragging = false; this.wasDragged = false; this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 }; this.animationFrameId = null; this.delayMeterEl = null; this.speedButtons = []; this.uiElements = {}; this.uiState = { x: 0, y: 0 }; this.boundFullscreenChange = null; this.boundSmartLimitUpdate = null; this.delta = {x:0, y:0}; }
        init(stateManager) {
            super.init(stateManager);
            
            const createUI = () => {
                if (this.globalContainer) return;
                this.createGlobalUI();
                this.stateManager.set('ui.globalContainer', this.globalContainer);
            };

            const onCreateRequested = () => {
                if (document.body) createUI();
                else document.addEventListener('DOMContentLoaded', createUI, { once: true });
            };

            this.subscribe('ui.createRequested', onCreateRequested);
            if (this.stateManager.get('ui.createRequested')) onCreateRequested();

            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            if (CONFIG.ENABLE_LIVE_DELAY) {
                this.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info));
                this.subscribe('liveStream.isPinned', () => this.updateDelayMeterVisibility());
            }
            this.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());
            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));
            const vscMessage = sessionStorage.getItem('vsc_message'); if (vscMessage) { this.showWarningMessage(vscMessage); sessionStorage.removeItem('vsc_message'); }
            this.boundFullscreenChange = () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } };
            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
            const savedPos = sessionStorage.getItem('vsc_ui_pos');
            if (savedPos) { try { const p = JSON.parse(savedPos); this.uiState = p; } catch {} }
        }
        destroy() {
            super.destroy();
            if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; }
            if (this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; }
            if (this.boundFullscreenChange) document.removeEventListener('fullscreenchange', this.boundFullscreenChange);
            if (this.boundSmartLimitUpdate) document.removeEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);
        }
        showWarningMessage(message) { 
            if (!message || !document.body) return;
            let warningEl = document.getElementById('vsc-warning-bar'); 
            if (warningEl) { warningEl.querySelector('span').textContent = message; warningEl.style.opacity = '1'; if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout); } 
            else { 
                warningEl = document.createElement('div'); warningEl.id = 'vsc-warning-bar'; 
                Object.assign(warningEl.style, { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px', borderRadius: '8px', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'center', gap: '15px', fontSize: '14px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.5s ease-in-out', maxWidth: '90%', }); 
                const messageSpan = document.createElement('span'); messageSpan.textContent = message; 
                const closeBtn = document.createElement('button'); Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' }); closeBtn.textContent = '×'; closeBtn.onclick = () => warningEl.style.opacity = '0'; 
                warningEl.append(messageSpan, closeBtn); 
                document.body.appendChild(warningEl); 
                setTimeout(() => (warningEl.style.opacity = '1'), 100); 
            } 
            warningEl.hideTimeout = setTimeout(() => { warningEl.style.opacity = '0'; }, CONFIG.UI_WARN_TIMEOUT); 
        }
        updateDelayMeterVisibility() {
            if (this.delayMeterEl) {
                const controlsVisible = this.stateManager.get('ui.areControlsVisible');
                const isPinned = this.stateManager.get('liveStream.isPinned');
                this.delayMeterEl.style.display = (controlsVisible || isPinned) ? 'flex' : 'none';
            }
        }
        updateDelayMeter(info) { 
            if (!CONFIG.ENABLE_LIVE_DELAY) return;
            if (!info && this.delayMeterEl && !this.stateManager.get('liveStream.isPinned')) { this.delayMeterEl.remove(); this.delayMeterEl = null; return; } 
            if (info && !this.delayMeterEl && document.body) { this.delayMeterEl = document.createElement('div'); Object.assign(this.delayMeterEl.style, { position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.MAX_Z_INDEX - 1, background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }); const textSpan = document.createElement('span'); const pinBtn = document.createElement('button'); pinBtn.textContent = '📌'; pinBtn.title = '항상 표시'; Object.assign(pinBtn.style, { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '12px', padding: '0 2px' }); pinBtn.onclick = () => { const cur = this.stateManager.get('liveStream.isPinned'); this.stateManager.set('liveStream.isPinned', !cur); pinBtn.style.color = !cur ? '#f39c12' : '#fff'; }; const refreshBtn = document.createElement('button'); refreshBtn.textContent = '🔄'; refreshBtn.title = '딜레이 측정 초기화'; Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); refreshBtn.onclick = () => { this.stateManager.set('liveStream.resetRequested', Date.now()); if (textSpan) { textSpan.textContent = '딜레이 리셋 중...'; } }; const closeBtn = document.createElement('button'); closeBtn.textContent = '✖'; closeBtn.title = '닫기'; Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); closeBtn.onclick = () => { this.stateManager.set('liveStream.isRunning', false); this.stateManager.set('liveStream.isPinned', false); }; this.delayMeterEl.append(pinBtn, textSpan, refreshBtn, closeBtn); document.body.appendChild(this.delayMeterEl); this.updateDelayMeterVisibility(); } 
            if (this.delayMeterEl) { const textSpan = this.delayMeterEl.querySelector('span'); if (textSpan) { if (info && info.raw === null && info.avg === null) { textSpan.textContent = '딜레이 측정 중...'; } else if (info) { textSpan.textContent = `딜레이: ${info.avg?.toFixed(0) || 'N/A'}ms / 현재: ${info.raw?.toFixed(0) || 'N/A'}ms / 배속: ${info.rate?.toFixed(3) || 'N/A'}x`; } } } 
        }
        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile'); this.globalContainer = document.createElement('div');
            // Mark container for MutationObserver to ignore
            this.globalContainer.setAttribute('data-vsc-internal', '1');
            
            const tx = this.uiState.x || 0; const ty = this.uiState.y || 0;
            this.globalContainer.style.setProperty('--vsc-translate-x', `${tx}px`);
            this.globalContainer.style.setProperty('--vsc-translate-y', `${ty}px`);
            Object.assign(this.globalContainer.style, { position: 'fixed', top: '50%', right: '1vmin', transform: 'translateY(-50%) translate(var(--vsc-translate-x), var(--vsc-translate-y))', zIndex: CONFIG.MAX_Z_INDEX, display: 'flex', alignItems: 'flex-start', gap: '5px', WebkitTapHighlightColor: 'transparent' }); this.mainControlsContainer = document.createElement('div'); Object.assign(this.mainControlsContainer.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '5px' }); this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡'; Object.assign(this.triggerElement.style, { width: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none', fontSize: isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', transition: 'box-shadow 0.3s ease-in-out, background-color 0.3s', order: '1', touchAction: 'none', });
            this.triggerElement.addEventListener('click', (e) => {
                if (this.wasDragged) { e.stopPropagation(); return; }
                const isVisible = this.stateManager.get('ui.areControlsVisible');
                if (_corePluginRef) { _corePluginRef.resetScanInterval(); scheduleScan(null, true); } // [v128.41] Ref: Direct core reference + immediate scan on click
                if (!isVisible) {
                    this.stateManager.set('app.scriptActive', true);
                    this.stateManager.set('ui.areControlsVisible', true);
                } else {
                    this.stateManager.set('app.scriptActive', false);
                    this.stateManager.set('ui.areControlsVisible', false);
                }
            });

            const rescanTrigger = document.createElement('div');
            rescanTrigger.textContent = '↻';
            rescanTrigger.title = '강제 재스캔 (영상을 못 찾을 때)';
            Object.assign(rescanTrigger.style, { width: isMobile ? 'clamp(24px, 5vmin, 30px)' : 'clamp(26px, 5.5vmin, 34px)', height: isMobile ? 'clamp(24px, 5vmin, 30px)' : 'clamp(26px, 5.5vmin, 34px)', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', userSelect: 'none', fontSize: isMobile ? 'clamp(14px, 3vmin, 18px)' : 'clamp(16px, 3.5vmin, 20px)', marginTop: '5px', order: '3' });
            rescanTrigger.addEventListener('click', (e) => {
                if (_corePluginRef) {
                    _corePluginRef.resetScanInterval();
                    _corePluginRef.scanAndApply();
                    rescanTrigger.style.background = '#2ecc71';
                    setTimeout(() => rescanTrigger.style.background = 'rgba(0,0,0,0.5)', 500);
                }
            });

            this.speedButtonsContainer = document.createElement('div');
            this.speedButtonsContainer.id = 'vsc-speed-buttons-container';
            this.speedButtonsContainer.style.cssText = `display:none; flex-direction:column; gap:5px; align-items:center; background: transparent; border-radius: 0px; padding: 0px;`;
            this.attachDragAndDrop();
            this.mainControlsContainer.appendChild(this.triggerElement);
            this.mainControlsContainer.appendChild(rescanTrigger);
            this.globalContainer.appendChild(this.mainControlsContainer);
            this.globalContainer.appendChild(this.speedButtonsContainer);
            document.body.appendChild(this.globalContainer);
        }
        onControlsVisibilityChange(isVisible) {
            if (!this.triggerElement) return;
            if (isVisible) {
                this.triggerElement.textContent = '🛑';
                this.triggerElement.style.backgroundColor = 'rgba(200, 0, 0, 0.5)';
                const savedVideoSettings = this.stateManager.get('videoFilter.lastActiveSettings');
                if (savedVideoSettings) { for (const key in savedVideoSettings) { this.stateManager.set(`videoFilter.${key}`, savedVideoSettings[key]); } this.stateManager.set('videoFilter.lastActiveSettings', null); }
                const savedImageSettings = this.stateManager.get('imageFilter.lastActiveSettings');
                if (savedImageSettings) { this.stateManager.set('imageFilter.level', savedImageSettings.level); this.stateManager.set('imageFilter.lastActiveSettings', null); }
            }
            else {
                this.triggerElement.textContent = '⚡️';
                this.triggerElement.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
                const videoState = this.stateManager.get('videoFilter');
                const videoSettingsToSave = {
                    level: videoState.level, level2: videoState.level2, gamma: videoState.gamma, 
                    shadows: videoState.shadows, highlights: videoState.highlights, brightness: videoState.brightness,
                    contrastAdj: videoState.contrastAdj, saturation: videoState.saturation, colorTemp: videoState.colorTemp,
                    dither: videoState.dither, autoExposure: videoState.autoExposure,
                    activeSharpPreset: videoState.activeSharpPreset, clarity: videoState.clarity
                };
                this.stateManager.set('videoFilter.lastActiveSettings', videoSettingsToSave);
                const imageState = this.stateManager.get('imageFilter');
                this.stateManager.set('imageFilter.lastActiveSettings', { level: imageState.level });
            }
            if (isVisible && !this.hostElement) { this.createControlsHost(); } if (this.hostElement) { this.hostElement.style.display = isVisible ? 'flex' : 'none'; } if (this.speedButtonsContainer) { const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO'); this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none'; } this.updateUIVisibility();
        }
        createControlsHost() {
            this.hostElement = document.createElement('div');
            this.hostElement.style.order = '2';
            this.hostElement.id = 'vsc-ui-host';
            this.stateManager.set('ui.hostElement', this.hostElement);
            this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
            this.stateManager.set('ui.shadowRoot', this.shadowRoot);
            this.renderAllControls();
            this.mainControlsContainer.prepend(this.hostElement);
        }
        updateUIVisibility() { if (!this.shadowRoot) return; const controlsVisible = this.stateManager.get('ui.areControlsVisible'); const activeMedia = this.stateManager.get('media.activeMedia'); const activeImages = this.stateManager.get('media.activeImages'); const hasVideo = [...activeMedia].some(m => m.tagName === 'VIDEO'); const hasImage = activeImages.size > 0; if (this.speedButtonsContainer) { this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none'; } const setVisible = (element, visible) => { if (element) element.classList.toggle(CONFIG.UI_HIDDEN_CLASS_NAME, !visible); }; setVisible(this.uiElements.videoControls, hasVideo); setVisible(this.uiElements.imageControls, hasImage); }
        updateActiveSpeedButton(rate) { if (this.speedButtons.length === 0) return; this.speedButtons.forEach(b => { const speed = parseFloat(b.dataset.speed); if (speed) { const isActive = Math.abs(speed - rate) < 0.01; if (isActive) { b.style.background = 'rgba(231, 76, 60, 0.9)'; b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset'; } else { b.style.background = 'rgba(52, 152, 219, 0.7)'; b.style.boxShadow = ''; } } }); }
        _createControlGroup(id, icon, title, parent) { const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group'; const mainBtn = document.createElement('button'); mainBtn.className = 'vsc-btn vsc-btn-main'; mainBtn.textContent = icon; mainBtn.title = title; const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu'; group.append(mainBtn, subMenu); mainBtn.onclick = async (e) => { e.stopPropagation(); const isOpening = !group.classList.contains('submenu-visible'); if (this.shadowRoot) { this.shadowRoot.querySelectorAll('.vsc-control-group').forEach(g => g.classList.remove('submenu-visible')); } if (isOpening) { group.classList.add('submenu-visible'); } }; parent.appendChild(group); if (id === 'vsc-image-controls') this.uiElements.imageControls = group; if (id === 'vsc-video-controls') this.uiElements.videoControls = group; return subMenu; }
        _createSlider(label, id, min, max, step, stateKey, unit, formatFn) {
            const div = document.createElement('div'); div.className = 'slider-control';
            const labelEl = document.createElement('label');
            const span = document.createElement('span');
            const updateText = (v) => { const val = parseFloat(v); if (isNaN(val)) return; span.textContent = formatFn ? formatFn(val) : `${val.toFixed(1)}${unit}`; };
            labelEl.textContent = `${label}: `; labelEl.appendChild(span);
            const slider = document.createElement('input');
            slider.type = 'range'; slider.id = id; slider.min = min; slider.max = max; slider.step = step;
            slider.value = this.stateManager.get(stateKey);

            const debouncedSetState = debounce((val) => { this.stateManager.set(stateKey, val); }, 50);

            slider.oninput = () => {
                const val = parseFloat(slider.value);
                updateText(val);

                if (stateKey.startsWith('videoFilter.')) {
                    VideoAnalyzer._userBoostUntil = performance.now() + 500;
                    if (stateKey.includes('level') || stateKey.includes('level2')) {
                        this.stateManager.set('videoFilter.activeSharpPreset', 'custom');
                    }
                }
                debouncedSetState(val);
            };

            this.subscribe(stateKey, (val) => {
                updateText(val);
                if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; }
            });
            updateText(slider.value);
            div.append(labelEl, slider);
            return { control: div, slider: slider, formatFn: formatFn, unit: unit };
        }
        renderAllControls() {
            if (this.shadowRoot.querySelector('#vsc-main-container')) return;
            // [v128.41] Fix: Removed opacity: 0.3, hover transition, and pointer-events: none
            const style = document.createElement('style'); const isMobile = this.stateManager.get('app.isMobile'); style.textContent = `* { -webkit-tap-highlight-color: transparent; } #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; } #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap:5px;} .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; height: clamp(${isMobile ? '24px, 4.8vmin, 30px' : '26px, 5.5vmin, 32px'}); width: clamp(${isMobile ? '26px, 5.2vmin, 32px' : '28px, 6vmin, 34px'}); position: relative; background: rgba(0,0,0,0.7); border-radius: 8px; } .${CONFIG.UI_HIDDEN_CLASS_NAME} { display: none !important; } .vsc-submenu { display: none; flex-direction: column; position: absolute; right: 100%; top: 40%; transform: translateY(-40%); margin-right: clamp(5px, 1vmin, 8px); background: rgba(0,0,0,0.9); border-radius: clamp(4px, 0.8vmin, 6px); padding: ${isMobile ? '6px' : 'clamp(8px, 1.5vmin, 12px)'}; gap: ${isMobile ? '2px' : '3px'}; } #vsc-video-controls .vsc-submenu { width: ${isMobile ? '240px' : '300px'}; max-width: 80vw; } #vsc-image-controls .vsc-submenu { width: 260px; } .vsc-control-group.submenu-visible .vsc-submenu { display: flex; } .vsc-btn { background: rgba(0,0,0,0.5); color: white; border-radius: clamp(4px, 0.8vmin, 6px); border:none; padding: clamp(4px, 0.8vmin, 6px) clamp(6px, 1.2vmin, 8px); cursor:pointer; font-size: clamp(${isMobile ? '11px, 1.8vmin, 13px' : '12px, 2vmin, 14px'}); white-space: nowrap; } .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; } .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; } .vsc-btn-main { font-size: clamp(${isMobile ? '14px, 2.5vmin, 16px' : '15px, 3vmin, 18px'}); padding: 0; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; box-sizing: border-box; background: none; } .slider-control { display: flex; flex-direction: column; gap: ${isMobile ? '2px' : '4px'}; } .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '12px' : '13px'}; color: white; align-items: center; } input[type=range] { width: 100%; margin: 0; } input[type=range]:disabled { opacity: 0.5; } .vsc-monitor { font-size: 10px; color: #aaa; margin-top: 5px; text-align: center; border-top: 1px solid #444; padding-top: 3px; }`; this.shadowRoot.appendChild(style); const mainContainer = document.createElement('div'); mainContainer.id = 'vsc-main-container'; this.uiElements.mainContainer = mainContainer; const controlsContainer = document.createElement('div'); controlsContainer.id = 'vsc-controls-container'; const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', controlsContainer);

            const videoButtonsContainer = document.createElement('div'); 
            videoButtonsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; width: 100%; padding-bottom: 4px; border-bottom: 1px solid #555;';
            const createLabel = (text) => { const span = document.createElement('span'); span.textContent = text; span.style.cssText = 'color: white; font-weight: bold; font-size: 12px; margin-right: 4px; white-space: nowrap; min-width: 30px; text-align: right; text-shadow: 1px 1px 1px rgba(0,0,0,0.8);'; return span; };

            const topRow = document.createElement('div'); 
            topRow.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px; margin-bottom: 2px;';
            
            const createToggle = (label, key) => {
                const btn = document.createElement('button'); btn.className = 'vsc-btn'; btn.textContent = label;
                btn.style.flex = '1';
                btn.onclick = () => this.stateManager.set(key, !this.stateManager.get(key));
                this.subscribe(key, v => {
                    btn.style.color = v ? '#4cd137' : 'white';
                    btn.style.borderColor = v ? '#4cd137' : '';
                });
                return btn;
            };

            const videoResetBtn = document.createElement('button'); 
            videoResetBtn.className = 'vsc-btn'; 
            videoResetBtn.textContent = '↺ 초기화'; 
            videoResetBtn.style.flex = '1';
            videoResetBtn.onclick = () => {
                this.stateManager.set('videoFilter.activeSharpPreset', 'none');
                this.stateManager.set('videoFilter.level', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL);
                this.stateManager.set('videoFilter.level2', CONFIG.DEFAULT_VIDEO_FILTER_LEVEL);
                this.stateManager.set('videoFilter.clarity', 0);
                this.stateManager.set('videoFilter.autoExposure', false);
                this.stateManager.set('videoFilter.targetLuma', 0);
                this.stateManager.set('videoFilter.highlights', 0);
                this.stateManager.set('videoFilter.shadows', 0);
                this.stateManager.set('videoFilter.gamma', 1.0);
                this.stateManager.set('videoFilter.saturation', 100);
                this.stateManager.set('videoFilter.contrastAdj', 1.0);
                this.stateManager.set('videoFilter.dither', 0);
                this.stateManager.set('videoFilter.colorTemp', 0);
            };
            
            topRow.append(createToggle('자동노출', 'videoFilter.autoExposure'), videoResetBtn);

            const hr1 = document.createElement('div'); hr1.style.cssText = 'height: 1px; background: #555; width: 100%; margin: 2px 0;';

            const videoSsharpBtn = document.createElement('button'); videoSsharpBtn.className = 'vsc-btn'; videoSsharpBtn.textContent = 'S'; videoSsharpBtn.dataset.presetKey = 'sharpS';
            videoSsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 5); this.stateManager.set('videoFilter.level2', 5); this.stateManager.set('videoFilter.activeSharpPreset', 'sharpS'); };
            const videoMsharpBtn = document.createElement('button'); videoMsharpBtn.className = 'vsc-btn'; videoMsharpBtn.textContent = 'M'; videoMsharpBtn.dataset.presetKey = 'sharpM';
            videoMsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 10); this.stateManager.set('videoFilter.level2', 10); this.stateManager.set('videoFilter.activeSharpPreset', 'sharpM'); };
            const videoLsharpBtn = document.createElement('button'); videoLsharpBtn.className = 'vsc-btn'; videoLsharpBtn.textContent = 'L'; videoLsharpBtn.dataset.presetKey = 'sharpL';
            videoLsharpBtn.onclick = () => { this.stateManager.set('videoFilter.level', 15); this.stateManager.set('videoFilter.level2', 15); this.stateManager.set('videoFilter.activeSharpPreset', 'sharpL'); };
            const videoSsharpOFFBtn = document.createElement('button'); videoSsharpOFFBtn.className = 'vsc-btn'; videoSsharpOFFBtn.textContent = '끔'; videoSsharpOFFBtn.dataset.presetKey = 'sharpOFF';
            videoSsharpOFFBtn.onclick = () => { this.stateManager.set('videoFilter.level', 0); this.stateManager.set('videoFilter.level2', 0); this.stateManager.set('videoFilter.activeSharpPreset', 'sharpOFF'); };

            const videoBtnGroup1 = document.createElement('div'); videoBtnGroup1.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 6px;';
            videoBtnGroup1.append(createLabel('샤프'), videoSsharpBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn);

            const mkEVBtn = (txt, val) => {
                const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = txt;
                b.onclick = () => {
                    this.stateManager.set('videoFilter.targetLuma', val);
                    this.stateManager.set('videoFilter.autoExposure', true);
                };
                return b;
            };
            const evGroup = document.createElement('div'); evGroup.style.cssText = 'display: flex; align-items: center; justify-content: flex-start; gap: 4px; flex-wrap: nowrap; overflow-x: auto;';
            evGroup.append(createLabel('노출'), 
                mkEVBtn('-15', -15), mkEVBtn('-10', -10), mkEVBtn('-5', -5),
                mkEVBtn('+5', 5), mkEVBtn('+10', 10), mkEVBtn('+15', 15)
            );

            const hr2 = document.createElement('div'); hr2.style.cssText = 'height: 1px; background: #555; width: 100%; margin: 2px 0;';

            const evSliderWrapper = document.createElement('div');
            evSliderWrapper.style.cssText = 'margin-bottom: 8px;';
            evSliderWrapper.appendChild(this._createSlider('노출 보정 (EV)', 'v-target', -30, 30, 1, 'videoFilter.targetLuma', '', v => `${v > 0 ? '+' : ''}${v}`).control);

            videoButtonsContainer.append(topRow, hr1, videoBtnGroup1, evGroup, hr2, evSliderWrapper);
            
            const sharpButtons = [videoSsharpBtn, videoMsharpBtn, videoLsharpBtn, videoSsharpOFFBtn];
            this.subscribe('videoFilter.activeSharpPreset', (activeKey) => { sharpButtons.forEach(btn => { btn.classList.toggle('active', btn.dataset.presetKey === activeKey); }); });
            videoSubMenu.appendChild(videoButtonsContainer);

            const gridContainer = document.createElement('div'); 
            gridContainer.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%;';
            gridContainer.append(
                this._createSlider('샤프(윤곽)', 'v-sharpen1', 0, 50, 1, 'videoFilter.level', '단계', v => `${v.toFixed(0)}단계`).control,
                this._createSlider('샤프(디테일)', 'v-sharpen2', 0, 50, 1, 'videoFilter.level2', '단계', v => `${v.toFixed(0)}단계`).control,
                this._createSlider('명료도(질감)', 'v-clarity', 0, 50, 1, 'videoFilter.clarity', '', v => `${v.toFixed(0)}`).control,
                this._createSlider('색온도', 'v-colortemp', -25, 25, 1, 'videoFilter.colorTemp', '', v => `${v.toFixed(0)}`).control,
                this._createSlider('필름그레인', 'v-dither', 0, 100, 5, 'videoFilter.dither', '', v => v === 0 ? '꺼짐' : (v <= 50 ? `디더 ${v}` : `그레인 ${v}`)).control,
                this._createSlider('베이스', 'a-bass', 0, 1, 0.05, 'audio.bass', '', v => v > 0 ? `+${(v*CONFIG.AUDIO_BASS_MAX_DB).toFixed(1)}dB` : 'OFF').control
            );
            videoSubMenu.appendChild(gridContainer);

            const statusDisplay = document.createElement('div'); statusDisplay.className = 'vsc-monitor';
            statusDisplay.textContent = 'Monitoring Off';
            videoSubMenu.appendChild(statusDisplay);

            this.boundSmartLimitUpdate = (e) => {
                if (!videoSubMenu.parentElement.classList.contains('submenu-visible')) return;
                const { autoParams, luma, tainted, videoInfo } = e.detail;
                const lumaText = (typeof luma === 'number') ? luma.toFixed(2) : 'N/A';
                if (tainted) { statusDisplay.textContent = 'CORS BLOCKED (Auto-Exposure Disabled)'; statusDisplay.style.color = '#e74c3c'; }
                else {
                    const comp = autoParams.clarityComp ? ` | C-Comp:+${autoParams.clarityComp.toFixed(1)}` : '';
                    let resInfo = ''; if (videoInfo && videoInfo.videoWidth) resInfo = `${videoInfo.videoWidth}x${videoInfo.videoHeight} | `;
                    statusDisplay.textContent = `${resInfo}Luma: ${lumaText} | Gamma: ${autoParams.gamma.toFixed(2)}${comp}`;
                    statusDisplay.style.color = '#aaa';
                }
            };
            document.addEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);

            const updateMonitorText = () => {
                const c = this.stateManager.get('videoFilter.clarity'); const e = this.stateManager.get('videoFilter.autoExposure');
                if (!c && !e) { statusDisplay.textContent = 'Monitoring Off (Enable Auto-Exp/Clarity)'; }
                else { if (statusDisplay.textContent.includes('Monitoring Off')) statusDisplay.textContent = 'Active... (Play video to see values)'; }
            };
            this.subscribe('videoFilter.clarity', updateMonitorText); this.subscribe('videoFilter.autoExposure', updateMonitorText);

            const imageSubMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controlsContainer); imageSubMenu.appendChild(this._createSlider('샤프닝', 'i-sharpen', 0, 20, 1, 'imageFilter.level', '단계', v => v === 0 ? '꺼짐' : `${v.toFixed(0)}단계`).control); imageSubMenu.appendChild(this._createSlider('색온도', 'i-colortemp', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control); if (this.speedButtons.length === 0) { CONFIG.SPEED_PRESETS.forEach(speed => { const btn = document.createElement('button'); btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn'; Object.assign(btn.style, { background: 'rgba(52, 152, 219, 0.7)', color: 'white', width: 'clamp(30px, 6vmin, 40px)', height: 'clamp(20px, 4vmin, 30px)', fontSize: 'clamp(12px, 2vmin, 14px)', padding: '0', transition: 'background-color 0.2s, box-shadow 0.2s' }); btn.onclick = () => this.stateManager.set('playback.targetRate', speed); this.speedButtonsContainer.appendChild(btn); this.speedButtons.push(btn); }); const isLiveJumpSite = CONFIG.LIVE_STREAM_SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d)); if (isLiveJumpSite) { const liveJumpBtn = document.createElement('button'); liveJumpBtn.textContent = '⚡'; liveJumpBtn.title = '실시간으로 이동'; liveJumpBtn.className = 'vsc-btn'; Object.assign(liveJumpBtn.style, { width: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', height: this.stateManager.get('app.isMobile') ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)', fontSize: this.stateManager.get('app.isMobile') ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)', borderRadius: '50%', padding: '0', transition: 'box-shadow 0.3s' }); liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now()); this.speedButtonsContainer.appendChild(liveJumpBtn); } } mainContainer.appendChild(controlsContainer); this.shadowRoot.appendChild(mainContainer); this.updateActiveSpeedButton(this.stateManager.get('playback.currentRate'));
        }
        // [v128.41] Optimization (3-B): Simplified Pointer Events
        attachDragAndDrop() { 
            const onDragStart = (e) => { 
                if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
                this.isDragging = true; this.wasDragged = false; this.delta = {x: 0, y: 0}; 
                this.startPos = { x: e.clientX, y: e.clientY }; this.currentPos = { x: this.uiState.x, y: this.uiState.y }; 
                this.globalContainer.style.transition = 'none'; 
                this.triggerElement.setPointerCapture(e.pointerId);
                this.triggerElement.addEventListener('pointermove', onDragMove); 
                this.triggerElement.addEventListener('pointerup', onDragEnd); 
            }; 
            const updatePosition = () => { if (!this.isDragging || !this.globalContainer) return; const newX = this.currentPos.x + this.delta.x; const newY = this.currentPos.y + this.delta.y; this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`); this.animationFrameId = null; }; 
            const onDragMove = (e) => { if (!this.isDragging) return; this.delta = { x: e.clientX - this.startPos.x, y: e.clientY - this.startPos.y }; if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI_DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI_DRAG_THRESHOLD)) { this.wasDragged = true; } if (this.wasDragged && this.animationFrameId === null) { this.animationFrameId = requestAnimationFrame(updatePosition); } }; 
            const onDragEnd = (e) => { if (!this.isDragging) return; if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; } const dx = this.delta?.x || 0; const dy = this.delta?.y || 0; if (this.wasDragged) { this.uiState.x += dx; this.uiState.y += dy; try { sessionStorage.setItem('vsc_ui_pos', JSON.stringify(this.uiState)); } catch {} } this.isDragging = false; this.globalContainer.style.transition = ''; this.triggerElement.removeEventListener('pointermove', onDragMove); this.triggerElement.removeEventListener('pointerup', onDragEnd); this.triggerElement.releasePointerCapture(e.pointerId); setTimeout(() => { this.wasDragged = false; }, 50); }; 
            this.triggerElement.addEventListener('pointerdown', onDragStart); 
        }
    }

    function main() {
        const stateManager = new StateManager();
        const pluginManager = new PluginManager(stateManager);
        window.vscPluginManager = pluginManager;

        pluginManager.register(new UIPlugin());

        if (IS_TOP) {
            pluginManager.register(new NavigationPlugin(pluginManager));
        }

        pluginManager.register(new CoreMediaPlugin());
        pluginManager.register(new SvgFilterPlugin());
        pluginManager.register(new PlaybackControlPlugin());
        pluginManager.register(new LiveStreamPlugin());
        pluginManager.register(new AudioEffectPlugin());

        pluginManager.initAll();
    }
    if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', main); } else { main(); }
})();
