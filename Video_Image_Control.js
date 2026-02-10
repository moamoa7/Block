// ==UserScript==
// @name        Video_Image_Control (v128.81 State Restore Fix)
// @namespace   https://com/
// @version     128.81
// @description v128.81: 샤프/노출 버튼 초기 상태(저장된 값) UI 반영 로직 복구, 상단 큰 버튼/그리드 정렬 유지.
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
    const MEDIA_EVENTS = ['loadedmetadata', 'playing', 'canplay', 'loadstart', 'loadeddata', 'emptied', 'durationchange', 'waiting'];
    
    // Constants
    const SELECTOR_MEDIA = 'video, img, iframe';
    const SELECTOR_VIDEO_IFRAME = 'video, iframe';

    // Flags
    const VSC_FLAG = Symbol('vsc_flags');
    const FLAG_OBSERVED = 1;
    const FLAG_VIDEO_INJ = 2;
    const FLAG_IMAGE_INJ = 4;

    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_HIGH_END = DEVICE_RAM >= 8;
    const IS_LOW_END = DEVICE_RAM < 4;

    // Config
    const CONFIG = {
        DEBUG: false,
        FLAGS: {
            HLS_BOOST: true,
            SHADOW_HOOK: true,
            AUDIO_EFFECT: true,
            LIVE_DELAY: true,
            GLOBAL_ATTR_OBS: true
        },
        HLS: {
            MAX_BUFFER: IS_HIGH_END ? 600 : (IS_LOW_END ? 30 : 120),
            BACK_BUFFER: IS_HIGH_END ? 300 : (IS_LOW_END ? 15 : 60),
        },
        FILTER: {
            VIDEO_DEFAULT_LEVEL: 15,
            IMAGE_DEFAULT_LEVEL: 15,
            DEFAULT_AUTO_EXPOSURE: false,
            DEFAULT_TARGET_LUMA: 0,
            DEFAULT_CLARITY: 0,
            DEFAULT_BRIGHTNESS: 0,
            DEFAULT_CONTRAST: 1.0,
            MIN_VIDEO_SIZE: 50,
            MIN_IMAGE_SIZE: 355,
            MOBILE_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 },
            DESKTOP_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 },
            IMAGE_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', SAT: 100, TEMP: 0 },
        },
        AUDIO: {
            DEFAULT_BASS: 0,
            BASS_MAX_DB: 6.5,
            BASS_FREQ: 90,
            DEFAULT_PITCH: true,
        },
        LIVE: {
            DELAY_INTERVAL_NORMAL: 1000,
            DELAY_INTERVAL_STABLE: 3000,
            STABLE_THRESHOLD: 100,
            STABLE_COUNT: 5,
            PID: { KP: 0.0002, KI: 0.00001, KD: 0.0001 },
            MIN_RATE: 1.0,
            MAX_RATE: 1.025,
            EMA_ALPHA: 0.2,
            MIN_BUFFER_HEALTH: 1.0,
            JUMP_INTERVAL: 6000,
            JUMP_THRESHOLD: 1.0,
            SITES: [
                'tv.naver.com','play.sooplive.co.kr','chzzk.naver.com','twitch.tv','kick.com','ok.ru','bigo.tv','pandalive.co.kr',
                'chaturbate.com','stripchat.com','xhamsterlive.com','myavlive.com'
            ],
            TARGET_DELAYS: { "play.sooplive.co.kr": 2500, "chzzk.naver.com": 2500, "ok.ru": 2500 },
            DEFAULT_TARGET_DELAY: 3000,
        },
        SCAN: {
            INTERVAL_TOP: 5000,
            INTERVAL_IFRAME: 2000,
            INTERVAL_MAX: 15000,
            MAX_DEPTH: 4,
            MUTATION_ATTRS: ['src', 'srcset', 'poster', 'style', 'class', 'data-src', 'data-srcset', 'data-lazy-src', 'data-url', 'data-href', 'type', 'loading', 'preload', 'srcdoc']
        },
        UI: {
            MAX_Z: 2147483647,
            DRAG_THRESHOLD: 5,
            WARN_TIMEOUT: 10000,
            HIDDEN_CLASS: 'vsc-hidden',
            SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2]
        }
    };

    const log = (...args) => { if (CONFIG.DEBUG) console.log('[VSC]', ...args); };

    // --- Helpers ---
    let _errCount = 0, _errWindowStart = Date.now();
    const safeGuard = (fn, label = '') => {
        const now = Date.now();
        if (now - _errWindowStart > 10000) { _errWindowStart = now; _errCount = 0; }
        if (_errCount > 30) return;
        try { return fn(); } catch(e) {
            _errCount++;
            if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e);
        }
    };

    const debounce = (fn, wait) => { let t; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; };
    const throttle = (fn, limit) => { let inThrottle; return function(...args) { if (!inThrottle) { fn.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; };
    
    const scheduleWork = (cb) => {
        const wrapped = () => safeGuard(cb, 'scheduleWork');
        if (window.scheduler && window.scheduler.postTask) return window.scheduler.postTask(wrapped, { priority: 'background' }).catch(e => { if(CONFIG.DEBUG) console.warn(e); });
        if (window.requestIdleCallback) return window.requestIdleCallback(wrapped, { timeout: 2000 });
        return setTimeout(wrapped, 1);
    };
    const requestIdle = scheduleWork;

    const setAttr = (el, name, val) => { if (!el) return; const strVal = String(val); if (el.getAttribute(name) !== strVal) el.setAttribute(name, strVal); };

    // --- Scanning Logic ---
    const dirtyRoots = new Set();
    let pendingScan = false;
    let _corePluginRef = null;

    const scheduleScan = (rootOrNull, immediate = false) => {
        if (immediate && _corePluginRef) {
            if (rootOrNull) safeGuard(() => _corePluginRef.scanSpecificRoot(rootOrNull), 'scanSpecificRoot');
            else safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
            return;
        }
        if (rootOrNull) {
            if (rootOrNull instanceof ShadowRoot) {
                if (rootOrNull.host && rootOrNull.host.isConnected) dirtyRoots.add(rootOrNull);
            } else if (rootOrNull.isConnected) {
                const tag = rootOrNull.nodeName;
                if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME') dirtyRoots.add(rootOrNull);
            }
        }
        if (pendingScan) return;
        pendingScan = true;

        scheduleWork(() => {
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
                for (const r of roots) if(r.isConnected || (r instanceof ShadowRoot && r.host && r.host.isConnected)) safeGuard(() => _corePluginRef.scanSpecificRoot(r), 'scanSpecificRoot');
            } else safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
        });
    };

    // --- CSS Injection ---
    const _realmSheetCache = new WeakMap();
    const _shadowRootCache = new WeakMap();
    const originalAttachShadow = Element.prototype.attachShadow;

    function getSharedStyleSheetForView(view, cssText) {
        if (!view || !view.CSSStyleSheet) return null;
        let map = _realmSheetCache.get(view);
        if (!map) { map = new Map(); _realmSheetCache.set(view, map); }
        let sheet = map.get(cssText);
        if (!sheet) {
            try { sheet = new view.CSSStyleSheet(); sheet.replaceSync(cssText); map.set(cssText, sheet); } 
            catch(e) { return null; }
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
            if (!cachedRoot || !cachedRoot.host || !cachedRoot.host.isConnected) {
                const shadowRoots = window._shadowDomList_ || [];
                for (const sRoot of shadowRoots) { if (sRoot.contains(element)) { root = sRoot; _shadowRootCache.set(element, sRoot); break; } }
            } else root = cachedRoot;
        }
        if (ownerDoc === document && root === document) return;
        const type = (manager === stateManager.filterManagers.video) ? 'video' : 'image';
        
        const attr = `data-vsc-filters-injected-${type}`;
        if (root instanceof ShadowRoot) { 
            if (root.host && root.host.hasAttribute(attr)) return; 
        } else if (ownerDoc && ownerDoc.documentElement.hasAttribute(attr)) return;

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
                return;
            }
        }
        if (root instanceof ShadowRoot) {
            let flags = (root[VSC_FLAG] | 0);
            const mask = type === 'video' ? FLAG_VIDEO_INJ : FLAG_IMAGE_INJ;
            if (!(flags & mask)) {
                try {
                    const clonedSvg = svgNode.cloneNode(true);
                    const view = root.ownerDocument ? root.ownerDocument.defaultView : (root.host ? root.host.ownerDocument.defaultView : null);
                    const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                    safelyAppendStyle(root, styleNode, sharedSheet);
                    root.appendChild(clonedSvg);
                    manager.registerContext(clonedSvg);
                    root[VSC_FLAG] = (flags | mask);
                    if (root.host) root.host.setAttribute(attr, 'true');
                } catch (e) { }
            }
        }
    }

    // --- HLS Boost ---
    if (CONFIG.FLAGS.HLS_BOOST) {
        (function patchHlsClass() {
            function isCtor(v) { return typeof v === 'function'; }
            function looksLikeHlsJs(H) { return !!(H && H.DefaultConfig && H.prototype && typeof H.prototype.loadSource === 'function'); }
            function protectGlobal(name, value) { try { const d = Object.getOwnPropertyDescriptor(window, name); if (d && !d.configurable) return; Object.defineProperty(window, name, { value, writable: true, configurable: true, enumerable: false }); } catch (e) {} }
            function makePatchedHls(OriginalHls) {
                if (!OriginalHls || OriginalHls.__VSC_PATCHED__ || !isCtor(OriginalHls)) return OriginalHls;
                if (!looksLikeHlsJs(OriginalHls)) return OriginalHls;
                const overrides = { maxBufferLength: CONFIG.HLS.MAX_BUFFER, backBufferLength: CONFIG.HLS.BACK_BUFFER, maxMaxBufferLength: CONFIG.HLS.MAX_BUFFER * 2, startFragPrefetch: true };
                try { if (OriginalHls.DefaultConfig) Object.assign(OriginalHls.DefaultConfig, overrides); } catch {}
                class PatchedHls extends OriginalHls {
                    constructor(userConfig = {}) {
                        try {
                            const enforced = Object.assign({}, overrides, userConfig);
                            enforced.maxBufferLength = Math.max(enforced.maxBufferLength || 0, CONFIG.HLS.MAX_BUFFER);
                            enforced.backBufferLength = Math.max(enforced.backBufferLength || 0, CONFIG.HLS.BACK_BUFFER);
                            super(enforced);
                        } catch(e) { super(userConfig); }
                    }
                }
                Object.getOwnPropertyNames(OriginalHls).forEach((name) => { if (['length', 'prototype', 'name', 'DefaultConfig'].includes(name)) return; try { Object.defineProperty(PatchedHls, name, Object.getOwnPropertyDescriptor(OriginalHls, name)); } catch {} });
                Object.defineProperty(PatchedHls, 'DefaultConfig', { get() { return OriginalHls.DefaultConfig; }, set(v) { OriginalHls.DefaultConfig = v; } });
                Object.defineProperty(PatchedHls, '__VSC_PATCHED__', { value: true });
                return PatchedHls;
            }
            if ('Hls' in window && isCtor(window.Hls)) { protectGlobal('Hls', makePatchedHls(window.Hls)); }
            else { let _hlsStorage = undefined; Object.defineProperty(window, 'Hls', { configurable: true, enumerable: false, get() { return _hlsStorage; }, set(v) { if (!isCtor(v)) { _hlsStorage = v; return; } _hlsStorage = makePatchedHls(v); } }); }
        })();
    }

    // --- Shadow Hook ---
    if (CONFIG.FLAGS.SHADOW_HOOK) {
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

    // --- Video Analyzer ---
    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null,
        taintedCache: new WeakMap(), taintedRetryCache: new WeakMap(),
        stateManager: null, currentSettings: { clarity: 0, autoExposure: false, targetLuma: 0 },
        currentAdaptiveGamma: 1.0, currentAdaptiveBright: 0, currentClarityComp: 0, currentShadowsAdj: 0, currentHighlightsAdj: 0,
        _lastClarityComp: 0, _lastShadowsAdj: 0, _lastHighlightsAdj: 0, frameSkipCounter: 0, dynamicSkipThreshold: 0,
        hasRVFC: false, lastAvgLuma: -1, _highMotion: false, _userBoostUntil: 0,
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
            this.handle = null; this.targetVideo = null; this.frameSkipCounter = 0;
            this.lastAvgLuma = -1; this._highMotion = false;
        },
        updateSettings(settings) {
            this.currentSettings = { ...this.currentSettings, ...settings };
            if (settings && (Object.prototype.hasOwnProperty.call(settings, 'targetLuma') || Object.prototype.hasOwnProperty.call(settings, 'autoExposure') || Object.prototype.hasOwnProperty.call(settings, 'clarity'))) {
                this.frameSkipCounter = 999; this._userBoostUntil = performance.now() + 800;
            }
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
            if (!this.targetVideo || this.targetVideo.paused || this.targetVideo.ended || document.hidden) { this.stop(); return; }
            if (this.targetVideo.readyState < 2) return;
            if (!this.ctx) return;
            const startTime = performance.now();
            const evValue = this.currentSettings.targetLuma || 0;
            const isAutoExp = this.currentSettings.autoExposure;

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
                let sum = 0, count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    sum += (data[i] * 54 + data[i+1] * 183 + data[i+2] * 19) >> 8;
                    count++;
                }
                const avgLuma = count > 0 ? (sum / count) / 255 : 0.5;
                if (this.lastAvgLuma >= 0) {
                    const delta = Math.abs(avgLuma - this.lastAvgLuma);
                    this._highMotion = (delta > 0.05);
                }
                this.lastAvgLuma = avgLuma;

                let targetAdaptiveGamma = 1.0, targetAdaptiveBright = 0, targetShadowsAdj = 0, targetHighlightsAdj = 0;
                if (isAutoExp) {
                    if (evValue !== 0) {
                        const u = evValue / 20;
                        const boostFactor = Math.tanh(u);
                        const headroom = 1.0 - Math.min(1.0, avgLuma + 0.3);
                        const floor = Math.max(0.0, avgLuma - 0.3);
                        let error = boostFactor * (boostFactor > 0 ? headroom : floor) * 0.15 * 4.0;
                        if (Math.abs(error) < 0.001) error = 0;
                        const correction = error * 6.0;
                        if (correction > 0) {
                            targetAdaptiveGamma += correction * 0.8; targetAdaptiveBright += correction * 4; targetShadowsAdj += correction * 5;
                        } else {
                            const absCorr = Math.abs(correction);
                            targetAdaptiveGamma -= absCorr * 0.8; targetAdaptiveBright -= absCorr * 5; targetHighlightsAdj += absCorr * 30;
                        }
                    }
                }
                if (evValue !== 0) {
                    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
                    targetAdaptiveGamma = clamp(targetAdaptiveGamma, 0.6, 2.0);
                    targetAdaptiveBright = clamp(targetAdaptiveBright, -40, 40);
                    targetShadowsAdj = clamp(targetShadowsAdj, -40, 40);
                    targetHighlightsAdj = clamp(targetHighlightsAdj, -20, 80);
                }
                let targetClarityComp = 0;
                if (this.currentSettings.clarity > 0) {
                    const intensity = this.currentSettings.clarity / 50;
                    const lumaFactor = Math.max(0.2, 1.0 - avgLuma);
                    let dampener = isAutoExp ? 0.6 : 1.0;
                    targetClarityComp = Math.min(10, (intensity * 12) * lumaFactor * dampener);
                }
                const smooth = (curr, target) => {
                    const diff = target - curr;
                    const userBoost = (this._userBoostUntil && startTime < this._userBoostUntil);
                    let speed = userBoost ? 0.25 : (this._highMotion ? 0.05 : 0.1);
                    return Math.abs(diff) > 0.01 ? curr + diff * speed : curr;
                };
                const now = performance.now();
                this.currentAdaptiveGamma = smooth(this.currentAdaptiveGamma || 1.0, targetAdaptiveGamma);
                this.currentAdaptiveBright = smooth(this.currentAdaptiveBright || 0, targetAdaptiveBright);
                this.currentClarityComp = smooth(this._lastClarityComp || 0, targetClarityComp);
                this.currentShadowsAdj = smooth(this._lastShadowsAdj || 0, targetShadowsAdj);
                this.currentHighlightsAdj = smooth(this._lastHighlightsAdj || 0, targetHighlightsAdj);
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

    // --- State Manager ---
    class StateManager {
        constructor() {
            this.state = {}; this.listeners = {}; this.filterManagers = { video: null, image: null }; this._saveTimer = null;
        }
        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.FILTER.MOBILE_SETTINGS : CONFIG.FILTER.DESKTOP_SETTINGS;
            const safeInt = (v, d=0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
            const safeFloat = (v, d=1.0) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
            const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

            this.state = {
                app: { isInitialized: false, isMobile, scriptActive: false },
                site: { isLiveSite: CONFIG.LIVE.SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d)) },
                media: { activeMedia: new Set(), activeImages: new Set(), mediaListenerMap: new WeakMap(), visibilityMap: new WeakMap(), currentlyVisibleMedia: null },
                videoFilter: { level: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, level2: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, gamma: parseFloat(videoDefaults.GAMMA), shadows: safeInt(videoDefaults.SHADOWS), highlights: safeInt(videoDefaults.HIGHLIGHTS), brightness: CONFIG.FILTER.DEFAULT_BRIGHTNESS, contrastAdj: CONFIG.FILTER.DEFAULT_CONTRAST, saturation: parseInt(videoDefaults.SAT, 10), colorTemp: safeInt(videoDefaults.TEMP), dither: safeInt(videoDefaults.DITHER), autoExposure: CONFIG.FILTER.DEFAULT_AUTO_EXPOSURE, targetLuma: CONFIG.FILTER.DEFAULT_TARGET_LUMA, clarity: CONFIG.FILTER.DEFAULT_CLARITY, activeSharpPreset: 'none' },
                imageFilter: { level: CONFIG.FILTER.IMAGE_DEFAULT_LEVEL, colorTemp: parseInt(CONFIG.FILTER.IMAGE_SETTINGS.TEMP || 0, 10) },
                audio: { bass: CONFIG.AUDIO.DEFAULT_BASS, pitch: CONFIG.AUDIO.DEFAULT_PITCH },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, lastUrl: location.href, warningMessage: null, createRequested: false },
                playback: { currentRate: 1.0, targetRate: 1.0, isLive: false, jumpToLiveRequested: 0 },
                liveStream: { delayInfo: null, isRunning: false, resetRequested: null, isPinned: false }
            };

            try {
                const saved = localStorage.getItem('vsc_settings');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (parsed.videoFilter) {
                        const vf = parsed.videoFilter;
                        const t = this.state.videoFilter;
                        t.gamma = clamp(safeFloat(vf.gamma, t.gamma), 0.6, 2.2);
                        t.level = clamp(safeInt(vf.level, t.level), 0, 50);
                        t.level2 = clamp(safeInt(vf.level2, t.level2), 0, 50);
                        t.autoExposure = !!vf.autoExposure;
                        t.targetLuma = clamp(safeInt(vf.targetLuma, t.targetLuma), -30, 30);
                        t.clarity = clamp(safeInt(vf.clarity, t.clarity), 0, 50);
                        t.activeSharpPreset = vf.activeSharpPreset || 'none';
                        t.colorTemp = clamp(safeInt(vf.colorTemp, t.colorTemp), -25, 25);
                        t.dither = clamp(safeInt(vf.dither, t.dither), 0, 100);
                        t.brightness = clamp(safeInt(vf.brightness, t.brightness), -40, 40);
                        t.shadows = clamp(safeInt(vf.shadows, t.shadows), -40, 40);
                        t.highlights = clamp(safeInt(vf.highlights, t.highlights), -80, 60);
                    }
                    if (parsed.audio) Object.assign(this.state.audio, parsed.audio);
                    if (parsed.playback) this.state.playback.targetRate = parsed.playback.targetRate || 1.0;
                    if (parsed.app) { if (parsed.app.scriptActive) this.state.app.scriptActive = true; }
                    if (parsed.ui) { if (parsed.ui.areControlsVisible) { this.state.ui.areControlsVisible = true; this.state.ui.createRequested = true; } }
                }
            } catch(e) {}
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) {
            const keys = key.split('.'); let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) { if (obj === undefined) return; obj = obj[keys[i]]; }
            const finalKey = keys[keys.length - 1]; if (obj === undefined) return;
            const oldValue = obj[finalKey];
            if (!Object.is(oldValue, value)) {
                obj[finalKey] = value;
                this.notify(key, value, oldValue);
                if (key.startsWith('videoFilter') || key.startsWith('audio') || key === 'playback.targetRate' || key === 'app.scriptActive' || key === 'ui.areControlsVisible') {
                    this._scheduleSave();
                }
            }
        }
        batchSet(prefix, obj) { for(const [k,v] of Object.entries(obj)) this.set(`${prefix}.${k}`, v); }
        subscribe(key, callback) { if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback); return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); }; }
        notify(key, newValue, oldValue) {
            if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue));
            let currentKey = key;
            while (currentKey.includes('.')) { const prefix = currentKey.substring(0, currentKey.lastIndexOf('.')); const wildcardKey = `${prefix}.*`; if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue)); currentKey = prefix; }
        }
        _scheduleSave() {
            if (this._saveTimer) clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => {
                try {
                    const toSave = {
                        videoFilter: this.state.videoFilter, audio: this.state.audio,
                        playback: { targetRate: this.state.playback.targetRate },
                        app: { scriptActive: this.state.app.scriptActive },
                        ui: { areControlsVisible: this.state.ui.areControlsVisible }
                    };
                    localStorage.setItem('vsc_settings', JSON.stringify(toSave));
                } catch(e) {}
            }, 500);
        }
    }

    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    class PluginManager { constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; } register(plugin) { this.plugins.push(plugin); } initAll() { this.stateManager.init(); this.plugins.forEach(plugin => safeGuard(() => plugin.init(this.stateManager), `Plugin ${plugin.name} init`)); this.stateManager.set('app.isInitialized', true); this.stateManager.set('app.pluginsInitialized', true); window.addEventListener('pagehide', () => { this.destroyAll(); }); document.addEventListener('visibilitychange', () => { if (document.hidden) VideoAnalyzer.stop(); else { const best = this.stateManager.get('media.currentlyVisibleMedia'); const vf = this.stateManager.get('videoFilter'); if (best && (vf.autoExposure || vf.clarity>0)) VideoAnalyzer.start(best, { autoExposure:vf.autoExposure, clarity:vf.clarity, targetLuma:vf.targetLuma }); } }); } destroyAll() { this.plugins.forEach(plugin => safeGuard(() => plugin.destroy(), `Plugin ${plugin.name} destroy`)); this.stateManager.set('app.isInitialized', false); } }

    class CoreMediaPlugin extends Plugin {
        constructor() {
            super('CoreMedia');
            this.mainObserver = null; this.intersectionObserver = null; this.scanTimerId = null; this.onAddShadowRoot = null;
            this.emptyScanCount = 0; this.baseScanInterval = IS_TOP ? CONFIG.SCAN.INTERVAL_TOP : CONFIG.SCAN.INTERVAL_IFRAME; this.currentScanInterval = this.baseScanInterval;
            this._seenIframes = new WeakSet(); this._observedImages = new WeakSet(); this._iframeBurstCooldown = new WeakMap(); this._iframeObservers = new Map(); this._iframeInternalObservers = new Map();
            this._lastImmediateScan = new WeakMap(); this._mediaAttributeObservers = new WeakMap(); this._globalAttrObs = null; this._didInitialShadowFullScan = false;
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
            this.subscribe('app.pluginsInitialized', () => { this.ensureObservers(); this.scanAndApply(); this.runStartupBoost(); 
            this.onAddShadowRoot = (e) => {
                if (e.detail && e.detail.shadowRoot) {
                    const sr = e.detail.shadowRoot;
                    let flags = sr[VSC_FLAG] | 0;
                    if (!(flags & FLAG_OBSERVED)) {
                        const smo = new MutationObserver(() => scheduleScan(sr));
                        smo.observe(sr, {childList:true, subtree:true});
                        sr[VSC_FLAG] = (flags | FLAG_OBSERVED);
                    }
                    this.scanSpecificRoot(sr);
                }
            }; document.addEventListener('addShadowRoot', this.onAddShadowRoot);
            document.addEventListener('load', (e) => { if (e.target && e.target.tagName === 'IMG') scheduleScan(e.target, true); }, CAPTURE_PASSIVE);
            MEDIA_EVENTS.forEach(evt => document.addEventListener(evt, this._onMediaEvent, CAPTURE_PASSIVE));
            this.scheduleNextScan();
            });
            this.subscribe('app.scriptActive', (active, old) => { 
                if (active && !old) { this.resetScanInterval(); scheduleScan(null, true); [250, 900, 2000].forEach(d => setTimeout(() => scheduleScan(null), d)); }
                this.updateGlobalAttrObs(active);
            });
            ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => document.addEventListener(evt, () => this.resetScanInterval(), { passive: true, capture: true }));
            if ('ResizeObserver' in window) {
                this._resizeObs = new ResizeObserver(throttle(entries => {
                    let needed = false;
                    for (const e of entries) { const t = e.target; if (t.tagName === 'VIDEO' || (t.tagName === 'IMG' && t.offsetHeight > 100)) needed = true; }
                    if (needed) scheduleScan(null);
                }, 200));
            }
            if (this.stateManager.get('app.scriptActive')) this.updateGlobalAttrObs(true);
        }
        updateGlobalAttrObs(active) {
            if (!CONFIG.FLAGS.GLOBAL_ATTR_OBS) return;
            if (active && !this._globalAttrObs) {
                this._globalAttrObs = new MutationObserver(throttle((ms) => {
                    for (const m of ms) {
                        const t = m.target;
                        if (!t) continue;
                        const tag = t.nodeName;
                        if (tag === 'SOURCE') { scheduleScan(t.parentNode, true); }
                        else if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME') { scheduleScan(t, true); }
                    }
                }, 150));
                this._globalAttrObs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['src', 'srcset', 'poster', 'data-src', 'data-srcset'] });
            } else if (!active && this._globalAttrObs) {
                this._globalAttrObs.disconnect(); this._globalAttrObs = null;
            }
        }
        runStartupBoost() {
            const times = [300, 1500, 5000, 15000];
            times.forEach(d => setTimeout(() => {
                const sm = this.stateManager;
                const hasAny = sm.get('media.activeMedia').size > 0 || sm.get('media.activeImages').size > 0 || document.querySelector('video, iframe, img');
                if (!hasAny || d <= 1500) scheduleScan(null, true);
            }, d));
        }
        destroy() { super.destroy(); _corePluginRef = null; if (this.mainObserver) { this.mainObserver.disconnect(); this.mainObserver = null; } if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; } if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scanTimerId = null; } if (this.onAddShadowRoot) { document.removeEventListener('addShadowRoot', this.onAddShadowRoot); this.onAddShadowRoot = null; } MEDIA_EVENTS.forEach(evt => document.removeEventListener(evt, this._onMediaEvent, CAPTURE_PASSIVE)); if (this._resizeObs) this._resizeObs.disconnect(); if(this._globalAttrObs) this._globalAttrObs.disconnect(); }
        ensureObservers() {
            if (!this.mainObserver) {
                const dirtySet = new Set();
                const mayContainMedia = (n) => {
                    if (!n || n.nodeType !== 1) return false;
                    const tag = n.nodeName;
                    if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME' || tag === 'SOURCE') return true;
                    return n.querySelector ? !!n.querySelector('video, iframe, img, source') : false;
                };
                const flushDirty = debounce(() => { if (dirtySet.size > 40) { dirtySet.clear(); scheduleScan(null); return; } for (const n of dirtySet) if (n.isConnected) this.scanSpecificRoot(n); dirtySet.clear(); }, 150);
                this.mainObserver = new MutationObserver((mutations) => {
                    if (mutations.length > 50) { scheduleScan(null); return; }
                    for(const m of mutations) {
                        if (m.type === 'childList') {
                            for(const n of m.addedNodes) {
                                if (n.nodeType === 1 && !n.closest('[data-vsc-internal]')) {
                                    if (n.nodeName === 'SOURCE') { const p = n.parentNode; if(p && p.nodeName === 'VIDEO') dirtySet.add(p); continue; }
                                    if (mayContainMedia(n)) dirtySet.add(n);
                                }
                            }
                        }
                    }
                    if (dirtySet.size > 0) flushDirty();
                });
                this.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
            }
            if (!this.intersectionObserver) {
                this.intersectionObserver = new IntersectionObserver(entries => {
                    const sm = this.stateManager;
                    const visMap = sm.get('media.visibilityMap'); let needsUpdate = false;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        if (visMap) visMap.set(e.target, isVisible);
                        if (e.target.tagName === 'VIDEO') { sm.set('media.visibilityChange', { target: e.target, isVisible }); needsUpdate = true; } 
                        else if (e.target.tagName === 'IMG') sm.set('media.visibilityChange', { target: e.target, isVisible });
                        if (!e.target.isConnected) this.intersectionObserver.unobserve(e.target);
                    });
                    if (needsUpdate && !document.hidden) {
                        const currentBest = sm.get('media.currentlyVisibleMedia');
                        const activeMedia = sm.get('media.activeMedia');
                        let bestCandidate = null; let maxScore = -1;
                        for (const m of activeMedia) {
                             if (m.tagName === 'VIDEO' && visMap.get(m)) {
                                 const area = (m.clientWidth||0) * (m.clientHeight||0);
                                 let score = area;
                                 if (!m.paused) score *= 2.0;
                                 if (m.readyState >= 2) score *= 1.2;
                                 if (!m.muted && m.volume > 0) score *= 1.2;
                                 if (document.pictureInPictureElement === m) score *= 3.0;
                                 if (score > maxScore) { maxScore = score; bestCandidate = m; }
                             }
                        }
                        if (bestCandidate && bestCandidate !== currentBest) {
                            sm.set('media.currentlyVisibleMedia', bestCandidate);
                            const vf = sm.get('videoFilter'); const active = sm.get('app.scriptActive');
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
                    if (window._shadowDomList_) window._shadowDomList_ = window._shadowDomList_.filter(r => r && r.host && r.host.isConnected);
                    const sm = this.stateManager;
                    const activeMedia = sm.get('media.activeMedia'); const activeImages = sm.get('media.activeImages');
                    const hasPotential = document.querySelector('video, iframe') || (IS_TOP && document.images && document.images.length > 0);
                    if (activeMedia.size > 0 || activeImages.size > 0 || hasPotential) { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; }
                    else { this.emptyScanCount++; if (this.emptyScanCount > 3) this.currentScanInterval = Math.min(CONFIG.SCAN.INTERVAL_MAX, this.currentScanInterval * 1.5); }
                    this.scheduleNextScan();
                });
            }, this.currentScanInterval);
        }
        resetScanInterval() { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scheduleNextScan(); } }
        scanAndApply() {
            const visited = new WeakSet();
            this._processAllElements(visited, !this._didInitialShadowFullScan);
            this._didInitialShadowFullScan = true;
        }
        _checkAndAdd(node, media, images) {
             if (node.tagName === 'VIDEO') {
                const isPotential = (node.src || node.currentSrc || node.srcObject || node.querySelector('source'));
                const sizeOk = (node.offsetWidth >= CONFIG.FILTER.MIN_VIDEO_SIZE || node.offsetHeight >= CONFIG.FILTER.MIN_VIDEO_SIZE || node.videoWidth >= CONFIG.FILTER.MIN_VIDEO_SIZE || node.videoHeight >= CONFIG.FILTER.MIN_VIDEO_SIZE);
                if (sizeOk || isPotential) media.add(node);
             } else if (node.tagName === 'IMG') {
                const wantImages = this.stateManager.get('ui.areControlsVisible') || (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);
                if (wantImages) {
                    const w = node.naturalWidth || node.offsetWidth || 0;
                    const h = node.naturalHeight || node.offsetHeight || 0;
                    if ((w >= CONFIG.FILTER.MIN_IMAGE_SIZE && h >= CONFIG.FILTER.MIN_IMAGE_SIZE) || (w * h >= 200000)) images.add(node);
                }
             } else if (node.tagName === 'IFRAME') { this._hookIframe(node); }
        }
        scanSpecificRoot(root) {
            if (!root) return;
            if (root.nodeType === 1 && (root.tagName === 'VIDEO' || root.tagName === 'IMG')) {
                const media = new Set(), images = new Set();
                this._checkAndAdd(root, media, images);
                this._applyToSets(media, images);
                return;
            }
            const visited = new WeakSet(); const { media, images } = this.findAllElements(root, 0, true, visited); this._applyToSets(media, images);
        }
        _applyToSets(mediaSet, imageSet) {
            const sm = this.stateManager;
            const currentMedia = sm.get('media.activeMedia'); const currentImages = sm.get('media.activeImages');
            let mediaChanged = false, imagesChanged = false;
            mediaSet.forEach(el => { 
                if(el.isConnected && this.attachMediaListeners(el)) { 
                    if (!currentMedia.has(el)) { currentMedia.add(el); mediaChanged = true; } 
                } 
            });
            imageSet.forEach(el => { 
                if(el.isConnected && this.attachImageListeners(el)) { 
                    if (!currentImages.has(el)) { currentImages.add(el); imagesChanged = true; } 
                } 
            });
            if (mediaChanged) sm.set('media.activeMedia', new Set(currentMedia)); 
            if (imagesChanged) sm.set('media.activeImages', new Set(currentImages));
            if ((mediaChanged || imagesChanged) && !sm.get('ui.globalContainer')) { sm.set('ui.createRequested', true); }
        }
        _processAllElements(visited, scanShadow = true) {
            const { media, images } = this.findAllElements(document, 0, !scanShadow, visited);
            if (!this.stateManager.get('ui.globalContainer')) {
                if (media.size > 0 || images.size > 0) { this.stateManager.set('ui.createRequested', true); } 
                else if (IS_TOP && document.images && document.images.length > 0) { this.stateManager.set('ui.createRequested', true); }
            }
            this._syncSet(media, 'media.activeMedia', this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this));
            this._syncSet(images, 'media.activeImages', this.attachImageListeners.bind(this), this.detachImageListeners.bind(this));
        }
        _syncSet(newSet, stateKey, attachFn, detachFn) {
            const activeSet = this.stateManager.get(stateKey); const oldElements = new Set(activeSet); const nextActiveSet = new Set(); let changed = false;
            newSet.forEach(el => { 
                if (el.isConnected) { 
                    if (attachFn(el)) { nextActiveSet.add(el); if (!activeSet.has(el)) changed = true; oldElements.delete(el); } 
                } 
            });
            if (oldElements.size > 0) { oldElements.forEach(detachFn); changed = true; }
            if (changed) this.stateManager.set(stateKey, nextActiveSet);
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
                    const internalMo = new MutationObserver((mutations) => { burstRescan(); });
                    internalMo.observe(doc.body, { childList: true, subtree: true });
                    this._iframeInternalObservers.set(frame, { doc, mo: internalMo });
                } catch {}
            };
            const onLoad = () => { burstRescan(); attachInternalObserver(); }; frame._vscOnLoad = onLoad;
            try { frame.addEventListener('load', onLoad, PASSIVE); } catch(e) {}
            const mo = new MutationObserver((ms) => { if (!frame.isConnected) return; for (const m of ms) if (m.type === 'attributes') { burstRescan(); break; } });
            try { mo.observe(frame, { attributes: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS }); this._iframeObservers.set(frame, mo); } catch {}
            attachInternalObserver();
        }
        findAllElements(root, depth, skipShadowScan, visited) {
            const media = new Set(); const images = new Set();
            if (!root) return { media, images }; if (depth > CONFIG.SCAN.MAX_DEPTH) return { media, images };
            const wantImages = this.stateManager.get('ui.areControlsVisible') || (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);

            if (root === document && wantImages) {
                const docImages = document.images;
                for (let i = 0; i < docImages.length; i++) {
                    const img = docImages[i];
                    const w = img.naturalWidth || img.offsetWidth || 0;
                    const h = img.naturalHeight || img.offsetHeight || 0;
                    if ((w >= CONFIG.FILTER.MIN_IMAGE_SIZE && h >= CONFIG.FILTER.MIN_IMAGE_SIZE) || (w*h >= 200000)) images.add(img);
                }
                const candidates = root.querySelectorAll(SELECTOR_VIDEO_IFRAME);
                candidates.forEach(el => this._checkAndAdd(el, media, images));
            } else {
                 const candidates = root.querySelectorAll(wantImages ? SELECTOR_MEDIA : SELECTOR_VIDEO_IFRAME);
                 candidates.forEach(el => this._checkAndAdd(el, media, images));
            }

            if (root === document) { const hasShadow = Array.isArray(window._shadowDomList_) && window._shadowDomList_.length > 0; if (!media.size && !images.size && !hasShadow) return { media, images }; }

            if (root.nodeType === 1) this._checkAndAdd(root, media, images);
            if (visited.has(root)) return { media, images }; visited.add(root);

            if (!skipShadowScan) {
                (window._shadowDomList_ || []).forEach(shadowRoot => {
                    let flags = shadowRoot[VSC_FLAG] | 0;
                    if (!(flags & FLAG_OBSERVED)) {
                        try {
                            const smo = new MutationObserver(() => scheduleScan(shadowRoot));
                            smo.observe(shadowRoot, {childList:true, subtree:true});
                            shadowRoot[VSC_FLAG] = (flags | FLAG_OBSERVED);
                        } catch(e) {}
                    }
                    try { const res = this.findAllElements(shadowRoot, depth + 1, true, visited); res.media.forEach(m => media.add(m)); res.images.forEach(i => images.add(i)); } catch (e) { }
                });
            }
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

            const ac = new AbortController();
            const signal = ac.signal;

            const handleRescan = throttle(() => this.resetScanInterval(), 250);
            media.addEventListener('loadedmetadata', handleRescan, { passive: true, signal });
            const updateRate = () => this.stateManager.set('playback.currentRate', media.playbackRate);
            media.addEventListener('play', updateRate, { passive: true, signal });
            media.addEventListener('ratechange', updateRate, { passive: true, signal });

            const onPlaying = () => {
                if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);
                const isVis = this.stateManager.get('media.visibilityMap').get(media);
                if (isVis) {
                    this.stateManager.set('media.currentlyVisibleMedia', media);
                    const vf = this.stateManager.get('videoFilter'); const active = this.stateManager.get('app.scriptActive');
                    if (active && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(media, { autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
                }
            };
            media.addEventListener('playing', onPlaying, { passive: true, signal });

            const attrMo = new MutationObserver((mutations) => {
                let triggered = false;
                for (const m of mutations) {
                    if (m.type === 'attributes') {
                        if (m.target === media && (m.attributeName === 'src' || m.attributeName === 'poster' || m.attributeName === 'data-src')) triggered = true;
                        if (m.target.nodeName === 'SOURCE' && m.attributeName === 'src') triggered = true;
                    }
                }
                if (triggered) scheduleScan(media, true);
            });
            attrMo.observe(media, { attributes: true, subtree: true, attributeFilter: ['src', 'poster', 'data-src', 'data-url'] });
            this._mediaAttributeObservers.set(media, attrMo);
            this.stateManager.get('media.mediaListenerMap').set(media, () => { ac.abort(); attrMo.disconnect(); });
            if (this._resizeObs) this._resizeObs.observe(media);
            return true;
        }
        detachMediaListeners(media) {
            const listenerMap = this.stateManager.get('media.mediaListenerMap'); if (!listenerMap.has(media)) return;
            if (media.getAttribute('data-vsc-controlled-by') === VSC_INSTANCE_ID) media.removeAttribute('data-vsc-controlled-by');
            const cleanup = listenerMap.get(media);
            if (typeof cleanup === 'function') cleanup();
            listenerMap.delete(media);
            try { this.intersectionObserver.unobserve(media); } catch(e) {}
            this._mediaAttributeObservers.delete(media);
            if (this._resizeObs) this._resizeObs.unobserve(media);
        }
        attachImageListeners(image) {
            if (!image || !this.intersectionObserver) return false;
            if (this.stateManager.filterManagers.image) injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager);
            const visMap = this.stateManager.get('media.visibilityMap'); if(visMap) visMap.set(image, false);
            if (!this._observedImages.has(image)) {
                try {
                    this.intersectionObserver.observe(image);
                    this._observedImages.add(image);
                    if (this._resizeObs) this._resizeObs.observe(image);
                } catch(e){ return false; }
            }
            return true;
        }
        detachImageListeners(image) {
            try { this.intersectionObserver.unobserve(image); } catch(e){}
            this._observedImages.delete(image);
            if (this._resizeObs) this._resizeObs.unobserve(image);
        }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, contrast: 0, clarityComp: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this._mediaStateRafId = null; }
        init(stateManager) {
            super.init(stateManager);
            const isMobile = this.stateManager.get('app.isMobile');
            this.filterManager = this._createManager({ settings: isMobile ? CONFIG.FILTER.MOBILE_SETTINGS : CONFIG.FILTER.DESKTOP_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', className: 'vsc-video-filter-active', isImage: false });
            this.imageFilterManager = this._createManager({ settings: CONFIG.FILTER.IMAGE_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', className: 'vsc-image-filter-active', isImage: true });
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
            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.subscribe('imageFilter.level', (val) => {
                 this.applyAllImageFilters();
                 if (val > 0) {
                     const core = window.vscPluginManager?.plugins?.find(p=>p.name==='CoreMedia');
                     if(core) core.scanAndApply();
                 }
            });
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates()); this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates()); this.subscribe('app.scriptActive', () => { this.updateMediaFilterStates(); });
            this.throttledUpdate = throttle((e) => {
                const { autoParams } = e.detail; const vf = this.stateManager.get('videoFilter'); const needAutoApply = vf.autoExposure || (vf.clarity > 0);
                const isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.002 || Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.1 || Math.abs((this.lastAutoParams.clarityComp||0) - (autoParams.clarityComp||0)) > 0.1 || Math.abs((this.lastAutoParams.shadowsAdj||0) - (autoParams.shadowsAdj||0)) > 0.1 || Math.abs((this.lastAutoParams.highlightsAdj||0) - (autoParams.highlightsAdj||0)) > 0.1;
                if (needAutoApply && isChanged) { this.lastAutoParams = autoParams; this.applyAllVideoFilters(); }
            }, 200);
            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
            if (this.stateManager.get('app.scriptActive')) { this.filterManager.init(); this.imageFilterManager.init(); this.applyAllVideoFilters(); this.applyAllImageFilters(); }
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
                    const style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = `.${className} { filter: url(#${combinedFilterId}) !important; transform: translateZ(0); }`;

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
                        const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: "luma_contrast_out", type: "saturate", values: (settings.SAT / 100).toString(), result: "saturate_out" });
                        const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA).toString() })));
                        const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));
                        const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "tone_out", result: "final_out" });
                        colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                        colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                        combinedFilter.append(clarityTransfer, blurFine, compFine, blurCoarse, compCoarse, grainNode, grainComp, lumaContrast, saturation, gamma, toneCurve, colorTemp);
                    }
                    svg.append(combinedFilter);
                    return { svgNode: svg, styleElement: style };
                }
                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const sig = values.gamma + values.sharpenLevel * 100 + values.level2 * 10000 + values.colorTemp * 1000000 + (values.autoExposure ? 1 : 0);
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

    class PlaybackControlPlugin extends Plugin {
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('playback.targetRate', (rate) => this.setPlaybackRate(rate));
            this.subscribe('media.activeMedia', () => { this.setPlaybackRate(this.stateManager.get('playback.targetRate')); });
            this.setPlaybackRate(this.stateManager.get('playback.targetRate'));
        }
        setPlaybackRate(rate) { this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO' && media.playbackRate !== rate) media.playbackRate = rate; }); }
    }

    class LiveStreamPlugin extends Plugin {
        constructor() { super('LiveStream'); this.video = null; this.avgDelay = null; this.intervalId = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.LIVE.DELAY_INTERVAL_NORMAL; }
        init(stateManager) {
            super.init(stateManager); if (!CONFIG.FLAGS.LIVE_DELAY) return;
            this.subscribe('liveStream.isRunning', (running) => { if (running) this.start(); else this.stop(); });
            this.subscribe('app.scriptActive', (active) => { const isLiveSite = CONFIG.LIVE.SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d)); if (active && isLiveSite) this.stateManager.set('liveStream.isRunning', true); else this.stateManager.set('liveStream.isRunning', false); });
            this.subscribe('playback.jumpToLiveRequested', () => this.seekToLiveEdge());
            this.subscribe('liveStream.resetRequested', () => { if (this.stateManager.get('liveStream.isRunning')) { this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; log('Live stream delay meter reset.'); } });
            if (this.stateManager.get('app.scriptActive') && CONFIG.LIVE.SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d))) { this.stateManager.set('liveStream.isRunning', true); }
        }
        destroy() { super.destroy(); this.stop(); }
        switchInterval(newInterval) { if (this.currentInterval === newInterval) return; clearInterval(this.intervalId); this.currentInterval = newInterval; this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        findVideo() { const visibleVideos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO' && this.stateManager.get('media.visibilityMap').get(m)); if (visibleVideos.length === 0) return null; return visibleVideos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0]; }
        calculateDelay(v) { 
            if (!v) return null; 
            if (typeof v.liveLatency === 'number' && v.liveLatency > 0) return v.liveLatency * 1000; 
            if (v.buffered && v.buffered.length > 0) { 
                try { const end = v.buffered.end(v.buffered.length - 1); if (v.currentTime > end) return 0; return Math.max(0, (end - v.currentTime) * 1000); } catch { return null; } 
            } 
            return null; 
        }
        getSmoothPlaybackRate(currentDelay, targetDelay) { const error = currentDelay - targetDelay; this.pidIntegral += error; this.pidIntegral = Math.max(-50000, Math.min(50000, this.pidIntegral)); const derivative = error - this.lastError; this.lastError = error; let rateChange = CONFIG.LIVE.PID.KP * error + CONFIG.LIVE.PID.KI * this.pidIntegral + CONFIG.LIVE.PID.KD * derivative; return Math.max(CONFIG.LIVE.MIN_RATE, Math.min(1 + rateChange, CONFIG.LIVE.MAX_RATE)); }
        checkAndAdjust() {
            if (!this.stateManager.get('app.scriptActive')) return; if (document.hidden) return; if (Math.abs(this.stateManager.get('playback.targetRate') - 1.0) > 0.01) return; this.video = this.findVideo(); if (!this.video) return; const rawDelay = this.calculateDelay(this.video); if (rawDelay === null) { this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: null, rate: this.video.playbackRate }); return; } this.avgDelay = this.avgDelay === null ? rawDelay : CONFIG.LIVE.EMA_ALPHA * rawDelay + (1 - CONFIG.LIVE.EMA_ALPHA) * this.avgDelay; this.stateManager.set('liveStream.delayInfo', { avg: this.avgDelay, raw: rawDelay, rate: this.video.playbackRate }); const targetDelay = CONFIG.LIVE.TARGET_DELAYS[location.hostname] || CONFIG.LIVE.DEFAULT_TARGET_DELAY; const error = this.avgDelay - targetDelay; if (Math.abs(error) < CONFIG.LIVE.STABLE_THRESHOLD) this.consecutiveStableChecks++; else { this.consecutiveStableChecks = 0; if (this.isStable) { this.isStable = false; this.switchInterval(CONFIG.LIVE.DELAY_INTERVAL_NORMAL); } } if (this.consecutiveStableChecks >= CONFIG.LIVE.STABLE_COUNT && !this.isStable) { this.isStable = true; this.switchInterval(CONFIG.LIVE.DELAY_INTERVAL_STABLE); } let newRate; const bufferHealth = (this.video.buffered && this.video.buffered.length) ? (this.video.buffered.end(this.video.buffered.length - 1) - this.video.currentTime) : 10; if ((this.avgDelay !== null && this.avgDelay <= targetDelay) || bufferHealth < CONFIG.LIVE.MIN_BUFFER_HEALTH) { newRate = 1.0; this.pidIntegral = 0; this.lastError = 0; } else { newRate = this.getSmoothPlaybackRate(this.avgDelay, targetDelay); } if (Math.abs(this.video.playbackRate - newRate) > 0.001) { this.video.playbackRate = newRate; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { const isLiveNow = this.avgDelay !== null && this.avgDelay < (CONFIG.LIVE.DEFAULT_TARGET_DELAY + 500); liveJumpBtn.style.boxShadow = isLiveNow ? '0 0 8px 2px #ff0000' : '0 0 8px 2px #808080'; } }
        start() { if (this.intervalId) return; setTimeout(() => { this.stateManager.set('liveStream.delayInfo', { raw: null, avg: null, rate: 1.0 }); }, 0); this.intervalId = setInterval(() => this.checkAndAdjust(), this.currentInterval); }
        stop() { if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; } const liveJumpBtn = this.stateManager.get('ui.globalContainer')?.querySelector('#vsc-speed-buttons-container button:last-child'); if (liveJumpBtn && liveJumpBtn.title.includes('실시간')) { liveJumpBtn.style.boxShadow = ''; } this.stateManager.set('liveStream.delayInfo', null); this.video = null; this.avgDelay = null; this.pidIntegral = 0; this.lastError = 0; this.consecutiveStableChecks = 0; this.isStable = false; this.currentInterval = CONFIG.LIVE.DELAY_INTERVAL_NORMAL; }
        seekToLiveEdge() { const videos = Array.from(this.stateManager.get('media.activeMedia')).filter(m => m.tagName === 'VIDEO'); if (videos.length === 0) return; const targetDelay = CONFIG.LIVE.TARGET_DELAYS[location.hostname] || CONFIG.LIVE.DEFAULT_TARGET_DELAY; videos.forEach(v => { try { const seekableEnd = (v.seekable && v.seekable.length > 0) ? v.seekable.end(v.seekable.length - 1) : Infinity; const bufferedEnd = (v.buffered && v.buffered.length > 0) ? v.buffered.end(v.buffered.length - 1) : 0; const liveEdge = Math.min(seekableEnd, bufferedEnd); if (!isFinite(liveEdge)) return; const delayMs = (liveEdge - v.currentTime) * 1000; if (delayMs <= targetDelay) return; if (!v._lastLiveJump) v._lastLiveJump = 0; if (Date.now() - v._lastLiveJump < CONFIG.LIVE.JUMP_INTERVAL) return; if (liveEdge - v.currentTime < CONFIG.LIVE.JUMP_THRESHOLD) return; v._lastLiveJump = Date.now(); v.currentTime = liveEdge - 0.5; if (v.paused) v.play().catch(console.warn); } catch (e) { log('seekToLiveEdge error:', e); } }); }
    }

    class AudioEffectPlugin extends Plugin {
        constructor() { super('AudioEffect'); this.ctx = null; this.targetVideo = null; this.effectsEnabled = false; this.nodeMap = new Map(); this.nodes = { bypassGain: null, masterGain: null, bassFilter: null, compressor: null, makeupGain: null, effectInputGain: null }; this.audioRetryCache = new WeakMap(); this.audioFailCount = new WeakMap(); this.audioPermanentExcluded = new WeakSet(); }
        init(stateManager) { super.init(stateManager); if (!CONFIG.FLAGS.AUDIO_EFFECT) return; const unlock = async () => { try { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') await this.ctx.resume(); } catch {} }; document.addEventListener('pointerdown', unlock, { capture: true, once: true }); document.addEventListener('keydown', unlock, { capture: true, once: true }); this.subscribe('audio.bass', () => this.updateAudioParams()); this.subscribe('audio.pitch', () => this.updatePitchState()); this.subscribe('media.activeMedia', (newSet) => this.handleMediaChanges(newSet)); this.subscribe('media.currentlyVisibleMedia', () => this.handleMediaChanges(this.stateManager.get('media.activeMedia'))); this.subscribe('app.scriptActive', (active) => { if (!active) this.disableEffects(); }); }
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
            if (this.nodes.masterGain) return; this.nodes.masterGain = this.ctx.createGain(); this.nodes.bypassGain = this.ctx.createGain(); this.nodes.effectInputGain = this.ctx.createGain(); this.nodes.bassFilter = this.ctx.createBiquadFilter(); this.nodes.bassFilter.type = 'lowshelf'; this.nodes.bassFilter.frequency.value = CONFIG.AUDIO.BASS_FREQ; this.nodes.bassFilter.Q.value = 0.8; this.nodes.compressor = this.ctx.createDynamicsCompressor(); this.nodes.makeupGain = this.ctx.createGain();
            this.nodes.masterGain.connect(this.nodes.bypassGain); this.nodes.bypassGain.connect(this.ctx.destination); this.nodes.masterGain.connect(this.nodes.effectInputGain); this.nodes.effectInputGain.connect(this.nodes.bassFilter); this.nodes.bassFilter.connect(this.nodes.compressor); this.nodes.compressor.connect(this.nodes.makeupGain); this.nodes.makeupGain.connect(this.ctx.destination); this.nodes.bypassGain.gain.value = 1.0; this.nodes.effectInputGain.gain.value = 0.0;
        }
        smoothSet(param, value, timeConstant = 0.02) { if (!this.ctx || !param) return; const now = this.ctx.currentTime; try { param.cancelScheduledValues(now); param.setTargetAtTime(value, now, timeConstant); } catch (e) {} }
        updatePitchState() { if (!this.targetVideo) return; const preserve = this.stateManager.get('audio.pitch'); if ('preservesPitch' in this.targetVideo) this.targetVideo.preservesPitch = preserve; else if ('mozPreservesPitch' in this.targetVideo) this.targetVideo.mozPreservesPitch = preserve; else if ('webkitPreservesPitch' in this.targetVideo) this.targetVideo.webkitPreservesPitch = preserve; }
        async updateAudioParams() {
            const bass = this.stateManager.get('audio.bass') || 0; if (bass > 0 && (!this.ctx || this.ctx.state !== 'running')) { if (!this.ctx) try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){} if (this.ctx && this.ctx.state === 'suspended') try { await this.ctx.resume(); } catch(e){} } if (!this.ctx || this.ctx.state !== 'running') return; this.ensureGlobalNodes();
            const isEffectActive = (bass > 0); this.effectsEnabled = isEffectActive;
            if (isEffectActive) { this.smoothSet(this.nodes.bypassGain.gain, 0.0); this.smoothSet(this.nodes.effectInputGain.gain, 1.0); this.smoothSet(this.nodes.bassFilter.gain, bass * CONFIG.AUDIO.BASS_MAX_DB); this.smoothSet(this.nodes.makeupGain.gain, 1.0 + (bass * 0.3)); }
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
            const createUI = () => { if (this.globalContainer) return; this.createGlobalUI(); this.stateManager.set('ui.globalContainer', this.globalContainer); this.stateManager.set('ui.createRequested', false); };
            const onCreateRequested = () => { if (document.body) createUI(); else document.addEventListener('DOMContentLoaded', createUI, { once: true }); };
            this.subscribe('ui.createRequested', (req) => { if(req) onCreateRequested(); }); if (this.stateManager.get('ui.createRequested')) onCreateRequested();
            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => this.updateActiveSpeedButton(rate));
            if (CONFIG.FLAGS.LIVE_DELAY) { this.subscribe('liveStream.delayInfo', info => this.updateDelayMeter(info)); this.subscribe('liveStream.isPinned', () => this.updateDelayMeterVisibility()); }
            this.subscribe('ui.warningMessage', msg => this.showWarningMessage(msg));
            this.subscribe('ui.areControlsVisible', () => this.updateDelayMeterVisibility());
            this.updateDelayMeter(this.stateManager.get('liveStream.delayInfo'));
            const vscMessage = sessionStorage.getItem('vsc_message'); if (vscMessage) { this.showWarningMessage(vscMessage); sessionStorage.removeItem('vsc_message'); }
            this.boundFullscreenChange = () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } };
            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
            const savedPos = sessionStorage.getItem('vsc_ui_pos'); if (savedPos) { try { const p = JSON.parse(savedPos); this.uiState = p; } catch {} }
        }
        destroy() { super.destroy(); if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; } if (this.delayMeterEl) { this.delayMeterEl.remove(); this.delayMeterEl = null; } if (this.boundFullscreenChange) document.removeEventListener('fullscreenchange', this.boundFullscreenChange); if (this.boundSmartLimitUpdate) document.removeEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate); }
        
        getStyles() {
            const isMobile = this.stateManager.get('app.isMobile');
            return `
                * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; } :host { font-family: sans-serif; } .vsc-hidden { display: none !important; }
                #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; }
                #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
                
                .vsc-control-group { 
                    display: flex; align-items: center; justify-content: flex-end; position: relative; 
                    background: rgba(0,0,0,0.7); border-radius: 8px; 
                    height: clamp(${isMobile ? '30px' : '32px'}, 6vmin, ${isMobile ? '40px' : '44px'}); 
                    width: clamp(${isMobile ? '30px' : '32px'}, 6vmin, ${isMobile ? '40px' : '44px'}); 
                }
                .vsc-btn { 
                    background: rgba(0,0,0,0.5); color: white; border-radius: 4px; border: none; 
                    padding: 6px 8px; cursor: pointer; white-space: nowrap; 
                    font-size: ${isMobile ? '13px' : '14px'}; transition: all 0.2s ease; 
                }
                .vsc-btn:hover { background: rgba(255,255,255,0.2); } .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; } .vsc-btn.active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; }
                .vsc-btn-main { 
                    width: 100%; height: 100%; padding: 0; background: none; 
                    font-size: ${isMobile ? '18px' : '20px'}; display: flex; align-items: center; justify-content: center; 
                }
                
                /* [v128.81] Top Buttons: Large & Bold & 50:50 Grid */
                .vsc-top-row {
                    display: grid;
                    grid-template-columns: 1fr 1fr; /* 50:50 Split */
                    gap: 8px;
                    width: 100%;
                    margin-bottom: 8px;
                }
                .vsc-btn-lg {
                    font-size: ${isMobile ? '15px' : '16px'} !important; 
                    font-weight: bold; 
                    height: 42px; /* Taller touch area */
                }

                /* [v128.79] Pop-Left & Vertical Center & Right Offset Fix */
                .vsc-submenu { 
                    display: none; flex-direction: column; 
                    position: fixed; /* Fixed to viewport */
                    top: 50%; transform: translateY(-50%); /* Vertical Center */
                    right: 100px; /* Offset from right edge */
                    
                    background: rgba(0,0,0,0.95); border-radius: 8px; padding: 10px; gap: 6px; 
                    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                }
                .vsc-control-group.submenu-visible .vsc-submenu { display: flex; }
                #vsc-video-controls .vsc-submenu { width: ${isMobile ? 'min(420px, 94vw)' : '340px'}; } 
                #vsc-image-controls .vsc-submenu { width: 280px; }
                
                /* The Alignment Grid */
                .vsc-align-grid {
                    display: grid;
                    grid-template-columns: 40px repeat(6, 1fr); /* Label + 6 slots */
                    gap: 4px;
                    align-items: center;
                    width: 100%;
                    margin-bottom: 8px;
                    border-bottom: 1px solid #555;
                    padding-bottom: 8px;
                }
                .vsc-align-grid .vsc-label {
                    grid-column: 1; text-align: right; margin-right: 5px; color: white; font-weight: bold; font-size: 13px;
                }
                
                .vsc-col { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-bottom: 10px; border-bottom: 1px solid #555; padding-bottom: 6px; }
                .vsc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; } 
                .vsc-hr { height: 1px; background: #555; width: 100%; margin: 4px 0; }
                .slider-control { display: flex; flex-direction: column; gap: 4px; } .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '13px' : '14px'}; color: white; } input[type=range] { width: 100%; margin: 0; cursor: pointer; }
                .vsc-monitor { font-size: 11px; color: #aaa; margin-top: 5px; text-align: center; border-top: 1px solid #444; padding-top: 3px; } .vsc-monitor.warn { color: #e74c3c; }
            `;
        }

        showWarningMessage(message) {
            if (!message || !document.body) return;
            let warningEl = document.getElementById('vsc-warning-bar');
            if (warningEl) { warningEl.querySelector('span').textContent = message; warningEl.style.opacity = '1'; if (warningEl.hideTimeout) clearTimeout(warningEl.hideTimeout); }
            else {
                warningEl = document.createElement('div'); warningEl.id = 'vsc-warning-bar';
                Object.assign(warningEl.style, { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', background: 'rgba(30, 30, 30, 0.9)', color: 'white', padding: '12px 20px', borderRadius: '8px', zIndex: CONFIG.UI.MAX_Z, display: 'flex', alignItems: 'center', gap: '15px', fontSize: '14px', boxShadow: '0 4px 10px rgba(0,0,0,0.3)', opacity: '0', transition: 'opacity 0.5s ease-in-out', maxWidth: '90%', });
                const messageSpan = document.createElement('span'); messageSpan.textContent = message;
                const closeBtn = document.createElement('button'); Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#aaa', fontSize: '20px', cursor: 'pointer', lineHeight: '1', padding: '0' }); closeBtn.textContent = '×'; closeBtn.onclick = () => warningEl.style.opacity = '0';
                warningEl.append(messageSpan, closeBtn); document.body.appendChild(warningEl); setTimeout(() => (warningEl.style.opacity = '1'), 100);
            }
            warningEl.hideTimeout = setTimeout(() => { warningEl.style.opacity = '0'; }, CONFIG.UI.WARN_TIMEOUT);
        }

        updateDelayMeterVisibility() {
            if (this.delayMeterEl) {
                const controlsVisible = this.stateManager.get('ui.areControlsVisible'); const isPinned = this.stateManager.get('liveStream.isPinned');
                this.delayMeterEl.style.display = (controlsVisible || isPinned) ? 'flex' : 'none';
            }
        }
        updateDelayMeter(info) {
            if (!CONFIG.FLAGS.LIVE_DELAY) return;
            if (!info && this.delayMeterEl && !this.stateManager.get('liveStream.isPinned')) { this.delayMeterEl.remove(); this.delayMeterEl = null; return; }
            if (info && !this.delayMeterEl && document.body) { this.delayMeterEl = document.createElement('div'); Object.assign(this.delayMeterEl.style, { position: 'fixed', bottom: '100px', right: '10px', zIndex: CONFIG.UI.MAX_Z - 1, background: 'rgba(0,0,0,.7)', color: '#fff', padding: '5px 10px', borderRadius: '5px', fontFamily: 'monospace', fontSize: '10pt', pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '10px' }); const textSpan = document.createElement('span'); const pinBtn = document.createElement('button'); pinBtn.textContent = '📌'; pinBtn.title = '항상 표시'; Object.assign(pinBtn.style, { background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '12px', padding: '0 2px' }); pinBtn.onclick = () => { const cur = this.stateManager.get('liveStream.isPinned'); this.stateManager.set('liveStream.isPinned', !cur); pinBtn.style.color = !cur ? '#f39c12' : '#fff'; }; const refreshBtn = document.createElement('button'); refreshBtn.textContent = '🔄'; refreshBtn.title = '딜레이 측정 초기화'; Object.assign(refreshBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); refreshBtn.onclick = () => { this.stateManager.set('liveStream.resetRequested', Date.now()); if (textSpan) { textSpan.textContent = '딜레이 리셋 중...'; } }; const closeBtn = document.createElement('button'); closeBtn.textContent = '✖'; closeBtn.title = '닫기'; Object.assign(closeBtn.style, { background: 'none', border: '1px solid white', color: 'white', borderRadius: '3px', cursor: 'pointer', padding: '2px 4px', fontSize: '12px' }); closeBtn.onclick = () => { this.stateManager.set('liveStream.isRunning', false); this.stateManager.set('liveStream.isPinned', false); }; this.delayMeterEl.append(pinBtn, textSpan, refreshBtn, closeBtn); document.body.appendChild(this.delayMeterEl); this.updateDelayMeterVisibility(); }
            if (this.delayMeterEl) { const textSpan = this.delayMeterEl.querySelector('span'); if (textSpan) { if (info && info.raw === null && info.avg === null) { textSpan.textContent = '딜레이 측정 중...'; } else if (info) { textSpan.textContent = `딜레이: ${info.avg?.toFixed(0) || 'N/A'}ms / 현재: ${info.raw?.toFixed(0) || 'N/A'}ms / 배속: ${info.rate?.toFixed(3) || 'N/A'}x`; } } }
        }

        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile');
            this.globalContainer = document.createElement('div');
            this.globalContainer.setAttribute('data-vsc-internal', '1');
            const tx = this.uiState.x || 0; const ty = this.uiState.y || 0;
            this.globalContainer.style.setProperty('--vsc-translate-x', `${tx}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${ty}px`);
            Object.assign(this.globalContainer.style, { position: 'fixed', top: '50%', right: '1vmin', zIndex: CONFIG.UI.MAX_Z, transform: 'translateY(-50%) translate(var(--vsc-translate-x), var(--vsc-translate-y))', display: 'flex', alignItems: 'flex-start', gap: '5px' });

            this.mainControlsContainer = document.createElement('div');
            this.mainControlsContainer.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:5px;';
            
            this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡';
            Object.assign(this.triggerElement.style, { width: isMobile ? '42px' : '48px', height: isMobile ? '42px' : '48px', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: isMobile ? '22px' : '24px', userSelect: 'none', touchAction: 'none', order: '1' });

            this.triggerElement.addEventListener('click', (e) => {
                if (this.wasDragged) { e.stopPropagation(); return; }
                const isVisible = this.stateManager.get('ui.areControlsVisible');
                if (_corePluginRef) { _corePluginRef.resetScanInterval(); scheduleScan(null, true); }
                this.stateManager.set('app.scriptActive', !isVisible);
                this.stateManager.set('ui.areControlsVisible', !isVisible);
            });

            const rescanTrigger = document.createElement('div'); rescanTrigger.textContent = '↻';
            Object.assign(rescanTrigger.style, { width: '34px', height: '34px', background: 'rgba(0,0,0,0.5)', color: 'white', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '18px', marginTop: '5px', order: '3' });
            rescanTrigger.addEventListener('click', () => { if (_corePluginRef) { _corePluginRef.resetScanInterval(); _corePluginRef.scanAndApply(); } });

            this.speedButtonsContainer = document.createElement('div'); this.speedButtonsContainer.id = 'vsc-speed-buttons-container'; this.speedButtonsContainer.style.cssText = 'display:none; flex-direction:column; gap:5px;';
            this.attachDragAndDrop();
            this.mainControlsContainer.append(this.triggerElement, rescanTrigger);
            this.globalContainer.append(this.mainControlsContainer, this.speedButtonsContainer);
            document.body.appendChild(this.globalContainer);
            
            CONFIG.UI.SPEED_PRESETS.forEach(speed => {
                const btn = document.createElement('button'); btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn';
                Object.assign(btn.style, { background: 'rgba(52, 152, 219, 0.7)', width: isMobile?'42px':'46px', height: isMobile?'32px':'36px', fontSize: isMobile ? '13px' : '14px' });
                btn.onclick = () => this.stateManager.set('playback.targetRate', speed);
                this.speedButtonsContainer.appendChild(btn); this.speedButtons.push(btn);
            });
            if (CONFIG.LIVE.SITES.some(d => location.hostname === d || location.hostname.endsWith('.' + d))) {
                const liveJumpBtn = document.createElement('button'); liveJumpBtn.textContent = '⚡'; liveJumpBtn.title = '실시간'; liveJumpBtn.className = 'vsc-btn';
                Object.assign(liveJumpBtn.style, { width: isMobile?'42px':'46px', height: isMobile?'42px':'46px', borderRadius: '50%', fontSize: '18px' });
                liveJumpBtn.onclick = () => this.stateManager.set('playback.jumpToLiveRequested', Date.now());
                this.speedButtonsContainer.appendChild(liveJumpBtn);
            }
        }
        onControlsVisibilityChange(isVisible) {
            if (!this.triggerElement) return;
            this.triggerElement.textContent = isVisible ? '🛑' : '⚡️';
            this.triggerElement.style.backgroundColor = isVisible ? 'rgba(200, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0.5)';
            if (isVisible && !this.hostElement) { this.createControlsHost(); } if (this.hostElement) { this.hostElement.style.display = isVisible ? 'flex' : 'none'; } if (this.speedButtonsContainer) { const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m.tagName === 'VIDEO'); this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none'; } this.updateUIVisibility();
        }
        updateUIVisibility() { if (!this.shadowRoot) return; const controlsVisible = this.stateManager.get('ui.areControlsVisible'); const activeMedia = this.stateManager.get('media.activeMedia'); const activeImages = this.stateManager.get('media.activeImages'); const hasVideo = [...activeMedia].some(m => m.tagName === 'VIDEO'); const hasImage = activeImages.size > 0; if (this.speedButtonsContainer) { this.speedButtonsContainer.style.display = hasVideo && controlsVisible ? 'flex' : 'none'; } const setVisible = (element, visible) => { if (element) element.classList.toggle(CONFIG.UI.HIDDEN_CLASS_NAME, !visible); }; setVisible(this.uiElements.videoControls, hasVideo); setVisible(this.uiElements.imageControls, hasImage); }
        updateActiveSpeedButton(rate) { if (this.speedButtons.length === 0) return; this.speedButtons.forEach(b => { const speed = parseFloat(b.dataset.speed); if (speed) { const isActive = Math.abs(speed - rate) < 0.01; if (isActive) { b.style.background = 'rgba(231, 76, 60, 0.9)'; b.style.boxShadow = '0 0 5px #e74c3c, 0 0 10px #e74c3c inset'; } else { b.style.background = 'rgba(52, 152, 219, 0.7)'; b.style.boxShadow = ''; } } }); }

        createControlsHost() {
            this.hostElement = document.createElement('div'); this.hostElement.style.order = '2'; this.hostElement.id = 'vsc-ui-host';
            this.stateManager.set('ui.hostElement', this.hostElement);
            this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
            this.stateManager.set('ui.shadowRoot', this.shadowRoot);
            const styleEl = document.createElement('style'); styleEl.textContent = this.getStyles(); this.shadowRoot.appendChild(styleEl);
            this.renderAllControls();
            this.mainControlsContainer.prepend(this.hostElement);
        }
        _createControlGroup(id, icon, title, parent) { 
            const group = document.createElement('div'); group.id = id; group.className = 'vsc-control-group'; 
            const mainBtn = document.createElement('button'); mainBtn.className = 'vsc-btn vsc-btn-main'; mainBtn.textContent = icon; mainBtn.title = title; 
            const subMenu = document.createElement('div'); subMenu.className = 'vsc-submenu'; 
            group.append(mainBtn, subMenu); 
            mainBtn.onclick = (e) => { e.stopPropagation(); const isOpening = !group.classList.contains('submenu-visible'); this.shadowRoot.querySelectorAll('.vsc-control-group').forEach(g => g.classList.remove('submenu-visible')); if (isOpening) group.classList.add('submenu-visible'); }; 
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
            slider.oninput = () => { const val = parseFloat(slider.value); updateText(val); if (stateKey.startsWith('videoFilter.')) { VideoAnalyzer._userBoostUntil = performance.now() + 500; if (stateKey.includes('level') || stateKey.includes('level2')) this.stateManager.set('videoFilter.activeSharpPreset', 'custom'); } debouncedSetState(val); };
            this.subscribe(stateKey, (val) => { updateText(val); if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; } });
            updateText(slider.value); div.append(labelEl, slider); return { control: div, slider: slider };
        }
        _buildVideoMenu(container) {
            const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', container);
            
            // [v128.81 Fix] Top Row - Perfect 50:50 Split Grid
            const topRow = document.createElement('div'); 
            topRow.className = 'vsc-top-row';
            
            const createToggle = (label, key) => { 
                const btn = document.createElement('button'); 
                btn.className = 'vsc-btn vsc-btn-lg'; // Using Large Class
                btn.textContent = label; 
                const render = (v) => { 
                    btn.style.color = v ? '#4cd137' : 'white'; 
                    btn.style.borderColor = v ? '#4cd137' : ''; 
                    btn.style.boxShadow = v ? '0 0 8px rgba(76, 209, 55, 0.4) inset' : '';
                }; 
                btn.onclick = () => this.stateManager.set(key, !this.stateManager.get(key)); 
                this.subscribe(key, render); render(this.stateManager.get(key)); 
                return btn; 
            };
            const videoResetBtn = document.createElement('button'); 
            videoResetBtn.className = 'vsc-btn vsc-btn-lg'; 
            videoResetBtn.textContent = '↺ 초기화'; 
            videoResetBtn.onclick = () => { this.stateManager.batchSet('videoFilter', { activeSharpPreset: 'none', level: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, level2: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, clarity: 0, autoExposure: false, targetLuma: 0, highlights: 0, shadows: 0, gamma: 1.0, saturation: 100, contrastAdj: 1.0, dither: 0, colorTemp: 0 }); };
            
            topRow.append(createToggle('자동노출', 'videoFilter.autoExposure'), videoResetBtn);

            // [v128.81 Fix] The Aligned Grid Table with Immediate State Update
            const gridTable = document.createElement('div'); gridTable.className = 'vsc-align-grid';
            
            // Row 1: Sharpen
            const shLabel = document.createElement('div'); shLabel.className = 'vsc-label'; shLabel.textContent = '샤프';
            const mkSharp = (txt, key, l1, l2) => { const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = txt; b.dataset.presetKey = key; b.onclick = () => { this.stateManager.batchSet('videoFilter', { level: l1, level2: l2, activeSharpPreset: key }); }; return b; };
            const sBtns = [mkSharp('S', 'sharpS', 5, 5), mkSharp('M', 'sharpM', 10, 10), mkSharp('L', 'sharpL', 15, 15), mkSharp('끔', 'sharpOFF', 0, 0)];
            const updateSharpState = (k) => { sBtns.forEach(b => b.classList.toggle('active', b.dataset.presetKey === k)); };
            this.subscribe('videoFilter.activeSharpPreset', updateSharpState);
            updateSharpState(this.stateManager.get('videoFilter.activeSharpPreset')); // Immediate Call
            
            // Row 2: Exposure
            const evLabel = document.createElement('div'); evLabel.className = 'vsc-label'; evLabel.textContent = '노출';
            const evBtns = [-15, -10, -5, 5, 10, 15].map(val => { const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = (val>0?'+':'')+val; b.dataset.evVal = val; b.onclick = () => { this.stateManager.batchSet('videoFilter', { targetLuma: val, autoExposure: true }); }; return b; });
            const updateEvUI = () => { const ae = this.stateManager.get('videoFilter.autoExposure'); const val = this.stateManager.get('videoFilter.targetLuma'); evBtns.forEach(b => { const m = ae && (parseInt(b.dataset.evVal) === val); b.style.color = m ? '#f39c12' : 'white'; b.style.boxShadow = m ? '0 0 5px #f39c12 inset' : ''; }); };
            this.subscribe('videoFilter.targetLuma', updateEvUI); this.subscribe('videoFilter.autoExposure', updateEvUI);
            updateEvUI(); // Immediate Call

            // Assemble Grid: Label, S, M, L, Off, (empty), (empty) | Label, -15, -10, -5, +5, +10, +15
            gridTable.append(shLabel, ...sBtns, document.createElement('div'), document.createElement('div')); 
            gridTable.append(evLabel, ...evBtns);

            const hr1 = document.createElement('div'); hr1.className = 'vsc-hr'; 
            videoSubMenu.append(topRow, hr1, gridTable);

            videoSubMenu.appendChild(this._createSlider('노출 보정 (EV)', 'v-target', -30, 30, 1, 'videoFilter.targetLuma', '', v => `${v > 0 ? '+' : ''}${v}`).control);
            
            const hr2 = document.createElement('div'); hr2.className = 'vsc-hr';
            videoSubMenu.appendChild(hr2);

            const grid = document.createElement('div'); grid.className = 'vsc-grid';
            grid.append(
                this._createSlider('샤프(윤곽)', 'v-sh1', 0, 50, 1, 'videoFilter.level', '단계', v => v.toFixed(0)).control, 
                this._createSlider('샤프(디테일)', 'v-sh2', 0, 50, 1, 'videoFilter.level2', '단계', v => v.toFixed(0)).control, 
                this._createSlider('명료도', 'v-cl', 0, 50, 1, 'videoFilter.clarity', '', v => v.toFixed(0)).control, 
                this._createSlider('색온도', 'v-ct', -25, 25, 1, 'videoFilter.colorTemp', '', v => v.toFixed(0)).control, 
                this._createSlider('그레인', 'v-dt', 0, 100, 5, 'videoFilter.dither', '', v => v.toFixed(0)).control, 
                this._createSlider('베이스', 'a-bs', 0, 1, 0.05, 'audio.bass', '', v => v>0 ? 'ON' : 'OFF').control
            );
            videoSubMenu.appendChild(grid);
            return videoSubMenu;
        }

        renderAllControls() {
            if (this.shadowRoot.querySelector('#vsc-main-container')) return;
            const main = document.createElement('div'); main.id = 'vsc-main-container';
            const controls = document.createElement('div'); controls.id = 'vsc-controls-container';
            const videoMenu = this._buildVideoMenu(controls);
            const monitor = document.createElement('div'); monitor.className = 'vsc-monitor'; monitor.textContent = 'Monitoring Off'; videoMenu.appendChild(monitor);
            this.boundSmartLimitUpdate = (e) => { if (!videoMenu.parentElement.classList.contains('submenu-visible')) return; const { autoParams, tainted } = e.detail; if (tainted) { monitor.textContent = 'CORS Blocked'; monitor.classList.add('warn'); } else { monitor.classList.remove('warn'); monitor.textContent = `Gamma: ${autoParams.gamma.toFixed(2)} | Bright: ${autoParams.bright.toFixed(0)}`; } };
            document.addEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);

            const imgMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controls);
            imgMenu.append(this._createSlider('샤프닝', 'i-sh', 0, 20, 1, 'imageFilter.level', '단계', v => v.toFixed(0)).control, this._createSlider('색온도', 'i-ct', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control);
            main.appendChild(controls); this.shadowRoot.appendChild(main);
        }
        attachDragAndDrop() {
            let lastDragEnd = 0;
            const onDragStart = (e) => { if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return; this.isDragging = true; this.wasDragged = false; this.delta = {x: 0, y: 0}; this.startPos = { x: e.clientX, y: e.clientY }; this.currentPos = { x: this.uiState.x, y: this.uiState.y }; this.globalContainer.style.transition = 'none'; this.triggerElement.setPointerCapture(e.pointerId); this.triggerElement.addEventListener('pointermove', onDragMove); this.triggerElement.addEventListener('pointerup', onDragEnd); this.triggerElement.addEventListener('pointercancel', onDragEnd); };
            const updatePosition = () => { if (!this.isDragging || !this.globalContainer) return; const newX = this.currentPos.x + this.delta.x; const newY = this.currentPos.y + this.delta.y; this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`); this.animationFrameId = null; };
            const onDragMove = (e) => { if (!this.isDragging) return; this.delta = { x: e.clientX - this.startPos.x, y: e.clientY - this.startPos.y }; if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI.DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI.DRAG_THRESHOLD)) { this.wasDragged = true; } if (this.wasDragged && this.animationFrameId === null) { this.animationFrameId = requestAnimationFrame(updatePosition); } };
            const onDragEnd = (e) => { if (!this.isDragging) return; if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; } const dx = this.delta?.x || 0; const dy = this.delta?.y || 0; if (this.wasDragged) { this.uiState.x += dx; this.uiState.y += dy; try { sessionStorage.setItem('vsc_ui_pos', JSON.stringify(this.uiState)); } catch {} lastDragEnd = Date.now(); } this.isDragging = false; this.globalContainer.style.transition = ''; this.triggerElement.removeEventListener('pointermove', onDragMove); this.triggerElement.removeEventListener('pointerup', onDragEnd); this.triggerElement.removeEventListener('pointercancel', onDragEnd); this.triggerElement.releasePointerCapture(e.pointerId); setTimeout(() => { this.wasDragged = false; }, 50); };
            this.triggerElement.addEventListener('pointerdown', onDragStart); this.triggerElement.addEventListener('click', (e) => { if (Date.now() - lastDragEnd < 400) { e.stopPropagation(); e.preventDefault(); } }, {capture:true});
        }
    }

    function main() {
        const stateManager = new StateManager();
        const pluginManager = new PluginManager(stateManager);
        window.vscPluginManager = pluginManager;
        pluginManager.register(new UIPlugin());
        if (IS_TOP) pluginManager.register(new NavigationPlugin(pluginManager));
        pluginManager.register(new CoreMediaPlugin());
        pluginManager.register(new SvgFilterPlugin());
        pluginManager.register(new PlaybackControlPlugin());
        pluginManager.register(new LiveStreamPlugin());
        pluginManager.register(new AudioEffectPlugin());
        pluginManager.initAll();
    }
    main();
})();
