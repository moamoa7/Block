// ==UserScript==
// @name        Video_Image_Control (Lite v130.71 Fix)
// @namespace   https://com/
// @version     130.71
// @description v130.71: Fixed ReferenceError (Class Ordering), WebWorker AE, Audio Compressor.
// @match       *://*/*
// @exclude     *://*.google.com/recaptcha/*
// @exclude     *://*.hcaptcha.com/*
// @exclude     *://*.arkoselabs.com/*
// @exclude     *://accounts.google.com/*
// @exclude     *://*.stripe.com/*
// @exclude     *://*.paypal.com/*
// @exclude     *://challenges.cloudflare.com/*
// @exclude     *://*.cloudflare.com/cdn-cgi/*
// @run-at      document-start
// @grant       none
// ==/UserScript==

(function () {
    'use strict';

    // 1. Boot Guard
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com')) return;
    if (window.__VSC_BOOT_GUARD__) return;
    Object.defineProperty(window, '__VSC_BOOT_GUARD__', { value: true, configurable: false, writable: false });

    const IS_TOP = window === window.top;
    let _corePluginRef = null;

    // 2. Constants & Configuration
    const VSC_INSTANCE_ID = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
    
    const MEDIA_EVENTS = [
        'play', 'playing', 'pause', 'loadedmetadata', 'loadeddata', 
        'canplay', 'canplaythrough', 'seeking', 'seeked', 'emptied', 'ratechange', 'durationchange'
    ];

    // Device detection
    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_HIGH_END = DEVICE_RAM >= 8;
    const IS_LOW_END = DEVICE_RAM < 4;

    const CONFIG = {
        DEBUG: false,
        FLAGS: { GLOBAL_ATTR_OBS: true },
        FILTER: {
            VIDEO_DEFAULT_LEVEL: 15, VIDEO_DEFAULT_LEVEL2: 6, IMAGE_DEFAULT_LEVEL: 15,
            DEFAULT_AUTO_EXPOSURE: false, DEFAULT_TARGET_LUMA: 0, DEFAULT_CLARITY: 0,
            DEFAULT_BRIGHTNESS: 0, DEFAULT_CONTRAST: 1.0, MIN_VIDEO_SIZE: 50, MIN_IMAGE_SIZE: 200,
            MOBILE_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 },
            DESKTOP_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 },
            IMAGE_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', SAT: 100, TEMP: 0 },
        },
        AUDIO: {
            THRESHOLD: -50, KNEE: 40, RATIO: 12, ATTACK: 0, RELEASE: 0.25, BOOST_DB: 6
        },
        SCAN: {
            INTERVAL_TOP: 5000, INTERVAL_IFRAME: 2000, INTERVAL_MAX: 15000,
            MAX_DEPTH: IS_HIGH_END ? 8 : (IS_LOW_END ? 4 : 6),
            MUTATION_ATTRS: ['src', 'srcset', 'poster', 'data-src', 'data-srcset', 'data-url', 'data-original', 'data-video-src', 'data-poster', 'type', 'loading', 'data-lazy-src', 'data-lazy', 'data-bg', 'data-background', 'aria-src', 'data-file', 'data-mp4', 'data-hls', 'data-stream', 'data-video', 'data-video-url', 'data-stream-url', 'data-player-src', 'data-m3u8', 'data-mpd', 'href']
        },
        UI: { MAX_Z: 2147483647, DRAG_THRESHOLD: 5, HIDDEN_CLASS: 'vsc-hidden', SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2] }
    };

    const BASE_SEL = 'video, iframe, canvas, source';
    const FILTER_TARGET_SEL = 'video, img, iframe, canvas';
    const SEL = { 
        MEDIA: `${BASE_SEL}, img`, 
        FILTER_TARGET: FILTER_TARGET_SEL,
        NOIMG_TARGET: 'video, iframe, canvas' 
    };
    
    const VSC_FLAG = Symbol('vsc_flags');
    const FLAG_OBSERVED = 1, FLAG_VIDEO_INJ = 2, FLAG_IMAGE_INJ = 4;

    const Utils = {
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        safeInt: (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
        fastHash: (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); },
        setAttr: (el, name, val) => { if (!el) return; if (val == null) { if (el.hasAttribute(name)) el.removeAttribute(name); return; } const s = String(val); if (el.getAttribute(name) !== s) el.setAttribute(name, s); },
        isShadowRoot: (n) => !!n && n.nodeType === 11 && !!n.host
    };

    // --- Core Helpers ---
    const log = (...args) => { if (CONFIG.DEBUG) console.log('[VSC]', ...args); };
    const safeGuard = (fn, label = '') => { try { return fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; };
    const throttle = (fn, limit) => { let inThrottle; return function (...args) { if (!inThrottle) { fn.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; };
    const scheduleWork = (cb) => {
        const wrapped = (deadline) => { try { cb(deadline); } catch (e) { if (CONFIG.DEBUG) console.error(e); } };
        if (window.requestIdleCallback) return window.requestIdleCallback(wrapped, { timeout: 1000 });
        return setTimeout(() => wrapped({ timeRemaining: () => 1, didTimeout: true }), 1);
    };
    const P = (signal) => ({ passive: true, signal });
    const CP = (signal) => ({ capture: true, passive: true, signal });
    const on = (target, type, listener, options) => target.addEventListener(type, listener, options);

    // --- Worker Logic (Inline Blob) ---
    const workerBlob = new Blob([`
        self.onmessage = function(e) {
            const { data, width, height, type, bandH, step } = e.data;
            if (type === 'analyze') {
                const size = width;
                const blackTh = 18;
                let topBlack = 0, botBlack = 0;
                
                for (let y = 0; y < bandH; y += step) {
                    for (let x = 0; x < size; x += step) {
                        const i = (y * size + x) * 4;
                        if (((data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8) < blackTh) topBlack++;
                    }
                }
                for (let y = size - bandH; y < size; y += step) {
                    for (let x = 0; x < size; x += step) {
                        const i = (y * size + x) * 4;
                        if (((data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8) < blackTh) botBlack++;
                    }
                }
                
                const pixelCount = ((bandH * size) / (step * step)); 
                const topRatio = topBlack / pixelCount;
                const botRatio = botBlack / pixelCount;
                const barsNow = (topRatio > 0.65 && botRatio > 0.65);
                
                const hist = new Uint16Array(256);
                let validCount = 0;
                
                const startY = barsNow ? Math.floor(size * 0.15) : 0;
                const endY = barsNow ? Math.floor(size * 0.85) : Math.floor(size * 0.88); 
                
                for (let y = startY; y < endY; y+=step) {
                    for (let x = 4; x < size - 4; x+=step) {
                        const i = (y * size + x) * 4;
                        const luma = (data[i] * 54 + data[i+1] * 183 + data[i+2] * 19) >> 8;
                        hist[luma]++;
                        validCount++;
                    }
                }
                
                let p10 = 0, p50 = 0, p90 = 0;
                if (validCount > 0) {
                    let sum = 0;
                    const t10 = validCount * 0.10;
                    const t50 = validCount * 0.50;
                    const t90 = validCount * 0.90;
                    for (let i = 0; i < 256; i++) {
                        sum += hist[i];
                        if (p10 === 0 && sum >= t10) p10 = i / 255;
                        if (p50 === 0 && sum >= t50) p50 = i / 255;
                        if (p90 === 0 && sum >= t90) p90 = i / 255;
                    }
                } else {
                    p10=0.1; p50=0.5; p90=0.9;
                }
                
                self.postMessage({ type: 'result', p10, p50, p90, barsNow });
            }
        };
    `], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);

    // --- Shadow DOM & Detection Logic ---
    const dirtyRoots = new Set();
    let _scanRaf = null;
    let _lastFullScanTime = 0;
    
    const _localShadowRoots = [];
    const _localShadowSet = new WeakSet();

    const registerShadowRoot = (sr) => {
        if (!sr) return;
        if (!_localShadowSet.has(sr)) {
            _localShadowSet.add(sr);
            _localShadowRoots.push(sr);
            if (_corePluginRef) _corePluginRef.scanSpecificRoot(sr);
        }
    };

    let _didCollectOpenSR = false;
    function collectOpenShadowRootsOnce(limit = 3000) {
        if (_didCollectOpenSR) return;
        _didCollectOpenSR = true;
        const run = () => {
            try {
                if (!document.documentElement) return;
                if (document.documentElement.childElementCount > 5000) limit = 1000;
                
                if (_localShadowRoots.length > 200) return;

                const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n, i = 0;
                while ((n = walker.nextNode()) && i < limit) {
                    if (n.shadowRoot) registerShadowRoot(n.shadowRoot);
                    i++;
                }
            } catch (e) {}
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
        else run();
    }

    const isGoodScanRoot = (n) => {
        if (!n || n.nodeType !== 1 || !n.isConnected) return false;
        const tag = n.nodeName;
        if (tag === 'HTML' || tag === 'BODY' || tag === 'HEAD') return false;
        if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME' || tag === 'CANVAS') return true;
        if (n.childElementCount > 0 && n.querySelector) return !!n.querySelector(SEL.FILTER_TARGET);
        return false;
    };

    const scheduleScan = (rootOrNull, immediate = false) => {
        if (Utils.isShadowRoot(rootOrNull)) registerShadowRoot(rootOrNull);

        if (immediate && _corePluginRef) {
            safeGuard(() => {
                if (rootOrNull) _corePluginRef.scanSpecificRoot(rootOrNull);
                else _corePluginRef.scanAndApply();
            }, 'immediateScan');
            return;
        }

        if (rootOrNull) {
             if (Utils.isShadowRoot(rootOrNull)) { if (rootOrNull.host && rootOrNull.host.isConnected) dirtyRoots.add(rootOrNull); }
             else if (rootOrNull.isConnected) {
                 const tag = rootOrNull.nodeName;
                 if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME' || tag === 'CANVAS') dirtyRoots.add(rootOrNull);
                 else if (isGoodScanRoot(rootOrNull)) dirtyRoots.add(rootOrNull);
             }
        }
        if (_scanRaf) return;
        _scanRaf = requestAnimationFrame(() => {
            _scanRaf = null;
            scheduleWork(() => {
                if (!_corePluginRef) return;
                if (dirtyRoots.size > 0) {
                    const now = Date.now();
                    if (dirtyRoots.size > (IS_LOW_END ? 60 : 40) && (now - _lastFullScanTime > 1500)) {
                        dirtyRoots.clear(); _lastFullScanTime = now;
                        safeGuard(() => _corePluginRef.scanAndApply(), 'scanAndApply');
                    }
                    else {
                        const roots = [...dirtyRoots]; dirtyRoots.clear();
                        for (const r of roots) if (r.isConnected || (Utils.isShadowRoot(r) && r.host && r.host.isConnected)) safeGuard(() => _corePluginRef.scanSpecificRoot(r), 'scanSpecificRoot');
                    }
                }
                safeGuard(() => _corePluginRef.tick(), 'tick');
            });
        });
    };

    const triggerBurstScan = (delay = 200) => {
        if(_corePluginRef) {
            _corePluginRef.resetScanInterval();
            scheduleScan(null, true);
            [delay, delay * 4, delay * 8].forEach(d => setTimeout(() => scheduleScan(null), d));
        }
    };

    let _sensCache = { t: 0, v: false };
    let _sensitiveLockUntil = performance.now() + 2000;
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _sensitiveLockUntil = 0; }, 1000), { once: true });
    } else {
         setTimeout(() => { _sensitiveLockUntil = 0; }, 1000);
    }

    const isSensitiveUrl = () => {
        const url = location.href.toLowerCase();
        return /(login|signin|auth|account|member|session|checkout|payment|bank|verify|secure)/i.test(url);
    };

    const isSensitiveContext = () => {
        const now = Date.now();
        if (now - _sensCache.t < 300) return _sensCache.v;
        if (performance.now() < _sensitiveLockUntil && isSensitiveUrl()) { _sensCache = { t: now, v: true }; return true; }
        if (!document.documentElement) return false;
        let result = false;
        if (isSensitiveUrl()) {
            try { if (document.querySelector('input[type="password"], input[name*="otp"], input[name*="cvc"]')) result = true; } catch(e) {}
        }
        _sensCache = { t: now, v: result };
        return result;
    };

    let _hasVideoCache = { t: 0, v: false };
    const hasRealVideoCached = () => {
        const now = Date.now();
        if (now - _hasVideoCache.t < 500) return _hasVideoCache.v;
        let found = false;
        const isValid = (el) => {
            if (!el) return false;
            if (el.tagName === 'CANVAS') {
                try {
                    const r = el.getBoundingClientRect();
                    if (r.width < 200 || r.height < 150) return false;
                    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
                    return true;
                } catch(e) { return false; }
            }
            if (el.tagName === 'IFRAME') return true;
            return !!el.src || !!el.currentSrc || (el.offsetWidth > 0 && el.offsetHeight > 0) || !!el.getAttribute('data-src');
        };
        const vids = document.getElementsByTagName('video');
        for (let i = 0; i < vids.length; i++) { if (vids[i].isConnected && isValid(vids[i])) { found = true; break; } }
        
        if (!found && document.getElementsByTagName('iframe').length > 0) found = true;
        
        if (!found && _localShadowRoots.length > 0) {
            const cap = Math.min(_localShadowRoots.length, 50);
            for (let i = 0; i < cap; i++) {
                const sr = _localShadowRoots[i];
                if (!sr) continue;
                try {
                    const v = sr.querySelector ? sr.querySelector('video, iframe, canvas') : null;
                    if (v && isValid(v)) { found = true; break; }
                } catch(e) {}
            }
        }
        _hasVideoCache = { t: now, v: found };
        return found;
    };

    // --- Hook Logic ---
    const ORIGINALS = {
        defineProperty: Object.defineProperty,
        defineProperties: Object.defineProperties,
        attachShadow: Element.prototype.attachShadow,
        mediaLoad: HTMLMediaElement.prototype.load,
    };
    const _prevInlineStyle = new WeakMap();
    const _realmSheetCache = new WeakMap();
    const _shadowRootCache = new WeakMap();
    let _hooksActive = false;
    let _shadowHookActive = false;
    const VSC_SR_MO = Symbol('vsc_sr_mo');

    const enableShadowHook = () => {
        if (_shadowHookActive || isSensitiveContext()) return;
        try {
            Element.prototype.attachShadow = function (init) {
                const shadowRoot = ORIGINALS.attachShadow.call(this, init);
                try {
                    if (this.id === 'vsc-ui-host') return shadowRoot;
                    if (shadowRoot) {
                        registerShadowRoot(shadowRoot);
                        requestAnimationFrame(() => {
                            document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: shadowRoot } }));
                        });
                    }
                } catch (e) {}
                return shadowRoot;
            };
            _shadowHookActive = true;
        } catch(e) {}
    };

    safeGuard(() => {
        if (!isSensitiveContext()) {
            enableShadowHook();
            collectOpenShadowRootsOnce();
        }
    }, "earlyShadowHook");

    const patchDescriptorSafely = (d) => { if (!d) return; const isAccessor = ('get' in d) || ('set' in d); if (!isAccessor && d.writable === false) d.writable = true; };
    const enablePropertyHooks = () => {
        if (_hooksActive || isSensitiveContext()) return;
        if (document.visibilityState === 'hidden') return;

        const protectKeys = ['playbackRate', 'currentTime', 'volume', 'muted', 'onratechange'];
        const isMediaEl = (o) => o && o.nodeType === 1 && (o.tagName === 'VIDEO' || o.tagName === 'AUDIO');
        const safeDefineProperty = function (obj, key, descriptor) {
            if (isMediaEl(obj) && protectKeys.includes(key) && descriptor) {
                const patched = { ...descriptor }; patchDescriptorSafely(patched);
                try { return ORIGINALS.defineProperty.call(this, obj, key, patched); } catch (e) { return ORIGINALS.defineProperty.call(this, obj, key, descriptor); }
            }
            return ORIGINALS.defineProperty.call(this, obj, key, descriptor);
        };
        const safeDefineProperties = function (obj, props) {
             if (isMediaEl(obj) && props) {
                const patchedProps = { ...props };
                for (const k in patchedProps) {
                    if (protectKeys.includes(k) && patchedProps[k]) {
                        const patched = { ...patchedProps[k] }; patchDescriptorSafely(patched); patchedProps[k] = patched;
                    }
                }
                try { return ORIGINALS.defineProperties.call(this, obj, patchedProps); } catch (e) { return ORIGINALS.defineProperties.call(this, obj, props); }
            }
            return ORIGINALS.defineProperties.call(this, obj, props);
        };
        Object.defineProperty = safeDefineProperty; Object.defineProperties = safeDefineProperties;
        _hooksActive = true;
    };
    
    const disableAllHooks = () => {
        if (_hooksActive) { Object.defineProperty = ORIGINALS.defineProperty; Object.defineProperties = ORIGINALS.defineProperties; _hooksActive = false; }
        HTMLMediaElement.prototype.load = ORIGINALS.mediaLoad;
        
        if (_shadowHookActive && isSensitiveContext()) {
            try { Element.prototype.attachShadow = ORIGINALS.attachShadow; } catch {}
            _shadowHookActive = false;
        }
    };

    if (window.hasOwnProperty('__VideoSpeedControlInitialized')) return;
    Object.defineProperty(window, '__VideoSpeedControlInitialized', { value: true, writable: false });

    try {
        if (!isSensitiveContext()) {
            const origLoad = HTMLMediaElement.prototype.load;
            HTMLMediaElement.prototype.load = function (...args) {
                try { if (_corePluginRef && !isSensitiveContext()) scheduleScan(this, true); } catch { }
                return origLoad.apply(this, args);
            };
        }
    } catch { }

    function getSharedStyleSheetForView(view, cssText) {
        if (!view || !view.CSSStyleSheet) return null;
        let map = _realmSheetCache.get(view);
        if (!map) { map = new Map(); _realmSheetCache.set(view, map); }
        const key = Utils.fastHash(cssText);
        let sheet = map.get(key);
        if (!sheet) { try { sheet = new view.CSSStyleSheet(); sheet.replaceSync(cssText); map.set(key, sheet); } catch (e) { return null; } }
        return sheet;
    }

    function whenDocReady(doc, cb) {
        if (!doc) return;
        if (doc.body && (doc.readyState === 'complete' || doc.readyState === 'interactive')) cb();
        else doc.addEventListener('DOMContentLoaded', () => { if (doc.body) cb(); else setTimeout(cb, 100); }, { once: true });
    }

    // --- Global Context Injection ---
    function injectFiltersIntoContext(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        let root = element.getRootNode();
        const ownerDoc = element.ownerDocument;
        if (root === document && element.parentElement) {
            let cachedRoot = _shadowRootCache.get(element);
            if (!cachedRoot || !cachedRoot.host || !cachedRoot.host.isConnected) {
                for (const sRoot of _localShadowRoots) { if (sRoot.contains(element)) { root = sRoot; _shadowRootCache.set(element, sRoot); break; } }
            } else root = cachedRoot;
        }
        if (ownerDoc === document && root === document) return;
        const type = (manager === stateManager.filterManagers.video) ? 'video' : 'image';
        const attr = `data-vsc-filters-injected-${type}`;

        const styleId = manager.getStyleNode().id;
        const svgId = manager.getSvgNode().id;
        const targetRoot = (root instanceof ShadowRoot) ? root : document.head;

        if (Utils.isShadowRoot(root)) {
            if (root.host && root.host.hasAttribute(attr)) {
                if (root.getElementById(styleId)) return;
            }
        } else if (ownerDoc && ownerDoc.documentElement.hasAttribute(attr)) {
             if (ownerDoc.getElementById(styleId)) return;
        }

        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode();
        if (!svgNode || !styleNode) return;

        const safelyAppendStyle = (targetRoot, styleEl, sharedSheet) => {
            let appended = false;
            if (sharedSheet && ('adoptedStyleSheets' in targetRoot)) {
                try {
                    const sheets = targetRoot.adoptedStyleSheets;
                    if (!sheets.includes(sharedSheet)) targetRoot.adoptedStyleSheets = [...sheets, sharedSheet];
                    appended = true;
                } catch (e) { }
            }
            if (!appended) {
                if (!targetRoot.querySelector(`#${styleEl.id}`)) {
                    const container = (targetRoot === ownerDoc) ? targetRoot.head : targetRoot;
                    if (container) container.appendChild(styleEl.cloneNode(true));
                }
            }
        };

        if (ownerDoc !== document) {
            if (!ownerDoc.body) { whenDocReady(ownerDoc, () => injectFiltersIntoContext(element, manager, stateManager)); return; }
            if (!ownerDoc.getElementById(svgNode.id)) {
                const clonedSvg = svgNode.cloneNode(true);
                ownerDoc.body.appendChild(clonedSvg);
                manager.registerContext(clonedSvg);
            }
            const view = ownerDoc.defaultView;
            const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
            safelyAppendStyle(ownerDoc, styleNode, sharedSheet);
            ownerDoc.documentElement.setAttribute(attr, 'true');
            return;
        }
        if (Utils.isShadowRoot(root)) {
            let flags = (root[VSC_FLAG] | 0);
            const mask = type === 'video' ? FLAG_VIDEO_INJ : FLAG_IMAGE_INJ;
            try {
                if (!root.getElementById(svgNode.id)) {
                     const clonedSvg = svgNode.cloneNode(true);
                     root.appendChild(clonedSvg);
                     manager.registerContext(clonedSvg);
                }
                const view = root.ownerDocument ? root.ownerDocument.defaultView : (root.host ? root.host.ownerDocument.defaultView : null);
                const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                safelyAppendStyle(root, styleNode, sharedSheet);
                root[VSC_FLAG] = (flags | mask);
                if (root.host) root.host.setAttribute(attr, 'true');
            } catch (e) { }
        }
    }

    // --- State Manager ---
    class StateManager {
        constructor() {
            this.state = {}; this.listeners = {}; this.filterManagers = { video: null, image: null };
        }
        init() {
            const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
            const videoDefaults = isMobile ? CONFIG.FILTER.MOBILE_SETTINGS : CONFIG.FILTER.DESKTOP_SETTINGS;
            const safeInt = Utils.safeInt;

            this.state = {
                app: { isInitialized: false, isMobile, scriptActive: false },
                media: { activeMedia: new Set(), activeImages: new Set(), activeIframes: new Set(), mediaListenerMap: new WeakMap(), visibilityMap: new WeakMap(), currentlyVisibleMedia: null },
                videoFilter: { level: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, level2: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL2, gamma: parseFloat(videoDefaults.GAMMA), shadows: safeInt(videoDefaults.SHADOWS), highlights: safeInt(videoDefaults.HIGHLIGHTS), brightness: CONFIG.FILTER.DEFAULT_BRIGHTNESS, contrastAdj: CONFIG.FILTER.DEFAULT_CONTRAST, saturation: parseInt(videoDefaults.SAT, 10), colorTemp: safeInt(videoDefaults.TEMP), dither: safeInt(videoDefaults.DITHER), autoExposure: CONFIG.FILTER.DEFAULT_AUTO_EXPOSURE, targetLuma: CONFIG.FILTER.DEFAULT_TARGET_LUMA, clarity: CONFIG.FILTER.DEFAULT_CLARITY, activeSharpPreset: 'none' },
                imageFilter: { level: CONFIG.FILTER.IMAGE_DEFAULT_LEVEL, colorTemp: parseInt(CONFIG.FILTER.IMAGE_SETTINGS.TEMP || 0, 10) },
                audio: { enabled: false, boost: 0 },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, warningMessage: null, createRequested: false, hideUntilReload: false },
                playback: { currentRate: 1.0, targetRate: 1.0 }
            };
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) {
            const keys = key.split('.'); let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) {
                if (obj === undefined) return;
                obj = obj[keys[i]];
            }
            const finalKey = keys[keys.length - 1]; if (obj === undefined) return;
            const oldValue = obj[finalKey];
            if (!Object.is(oldValue, value)) {
                obj[finalKey] = value;
                this.notify(key, value, oldValue);
            }
        }
        batchSet(prefix, obj) { for (const [k, v] of Object.entries(obj)) this.set(`${prefix}.${k}`, v); }
        subscribe(key, callback) { if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback); return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); }; }
        notify(key, newValue, oldValue) {
            if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue));
            let currentKey = key;
            while (currentKey.includes('.')) { const prefix = currentKey.substring(0, currentKey.lastIndexOf('.')); const wildcardKey = `${prefix}.*`; if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue)); currentKey = prefix; }
        }
    }

    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null,
        stateManager: null, currentSettings: { clarity: 0, autoExposure: false, targetLuma: 0 },
        currentAdaptiveGamma: 1.0, currentAdaptiveBright: 0, currentClarityComp: 0, currentShadowsAdj: 0, currentHighlightsAdj: 0,
        _lastClarityComp: 0, _lastShadowsAdj: 0, _lastHighlightsAdj: 0, frameSkipCounter: 0, dynamicSkipThreshold: 0,
        hasRVFC: false, lastAvgLuma: -1, _highMotion: false, _userBoostUntil: 0, _stopTimeout: null,
        _hist: null, _evAggressiveUntil: 0, _lbConf: 0, _aeBlockedUntil: 0, _roiP50History: [],
        _rois: [],
        taintedResources: new WeakSet(),
        _worker: null,

        init(stateManager) {
            this.stateManager = stateManager;
            if (!this.canvas) {
                if (typeof OffscreenCanvas !== 'undefined') {
                    this.canvas = new OffscreenCanvas(32, 32);
                } else {
                    this.canvas = document.createElement('canvas');
                }
                const size = IS_HIGH_END ? 48 : (IS_LOW_END ? 16 : 32);
                this.canvas.width = size; this.canvas.height = size;
            }
            if (!this.ctx) {
                this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
                if (this.ctx) this.ctx.imageSmoothingEnabled = false;
            }
            if (!this._worker) {
                this._worker = new Worker(workerUrl);
                this._worker.onmessage = this._handleWorkerMessage.bind(this);
            }
            this._roiP50History = [0.5, 0.5, 0.5];
        },
        _handleWorkerMessage(e) {
            const { type, p10, p50, p90, barsNow } = e.data;
            if (type === 'result') {
                this._processAnalysisResult(p10, p50, p90, barsNow);
            }
        },
        _pickBestVideoNow() {
            const pip = document.pictureInPictureElement;
            if (pip && pip.isConnected && pip.tagName === 'VIDEO') return pip;
            const fs = document.fullscreenElement;
            if (fs) {
                const v = (fs.tagName === 'VIDEO') ? fs : fs.querySelector?.('video');
                if (v && v.isConnected) return v;
            }
            const sm = this.stateManager;
            let v = sm ? sm.get('media.currentlyVisibleMedia') : null;
            if (v && v.isConnected && v.tagName === 'VIDEO') return v;
            return document.querySelector('video');
        },
        _kickImmediateAnalyze() {
            const run = () => { try { if (!this.targetVideo || !this.ctx) return; this.processFrame(true); } catch {} };
            try { queueMicrotask(run); } catch { setTimeout(run, 0); }
            requestAnimationFrame(run);
        },
        start(video, settings) {
            if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null; }
            if (!this.ctx || !this.canvas) this.init(this.stateManager);
            if (!this.ctx) return;
            if (this.isRunning && this.targetVideo && this.targetVideo !== video) this.stop();
            if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExposure = this.currentSettings.autoExposure;
            if (!isClarityActive && !isAutoExposure) { if (this.isRunning) this.stop(); return; }
            if (this.taintedResources.has(video)) {
                this.notifyUpdate({ gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }, 0, video, true);
                return;
            }
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video;
            this.hasRVFC = 'requestVideoFrameCallback' in this.targetVideo;
            if (!this.canvas) this.init(this.stateManager);
            this.isRunning = true; this.loop();
        },
        stop() {
            this.isRunning = false;
            if (this.handle && this.targetVideo && this.hasRVFC) { try { this.targetVideo.cancelVideoFrameCallback(this.handle); } catch { } }
            this.handle = null; this.targetVideo = null; this.frameSkipCounter = 0;
            this.lastAvgLuma = -1; this._highMotion = false; this._lbConf = 0;
        },
        updateSettings(settings) {
            const prev = this.currentSettings;
            this.currentSettings = { ...this.currentSettings, ...settings };
            const now = performance.now();
            const evChanged = settings && Object.prototype.hasOwnProperty.call(settings, 'targetLuma') && settings.targetLuma !== prev.targetLuma;
            const aeTurnedOn = settings && Object.prototype.hasOwnProperty.call(settings, 'autoExposure') && settings.autoExposure && !prev.autoExposure;

            if (settings && (Object.prototype.hasOwnProperty.call(settings, 'targetLuma') || Object.prototype.hasOwnProperty.call(settings, 'autoExposure') || Object.prototype.hasOwnProperty.call(settings, 'clarity'))) {
                this.frameSkipCounter = 999;
                this._userBoostUntil = now + 1500;
                if (evChanged || aeTurnedOn) {
                    this._evAggressiveUntil = now + 800;
                    this.dynamicSkipThreshold = 0;
                }
            }
             if (settings && Object.prototype.hasOwnProperty.call(settings, 'autoExposure') && !settings.autoExposure) {
                this._evAggressiveUntil = 0;
            }
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExposure = this.currentSettings.autoExposure;
            if (isClarityActive || isAutoExposure) {
                const best = this._pickBestVideoNow();
                if (best) {
                    this.start(best, {
                        autoExposure: this.currentSettings.autoExposure,
                        clarity: this.currentSettings.clarity,
                        targetLuma: this.currentSettings.targetLuma
                    });
                }
                if (evChanged || aeTurnedOn) {
                    this._kickImmediateAnalyze();
                }
            } else if (!isClarityActive && !isAutoExposure && this.isRunning) {
                this.stop();
                this.notifyUpdate({ gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }, 0);
            }
        },
        loop() {
            if (!this.isRunning || !this.targetVideo) return;
            const cb = () => { try { this.processFrame(); } catch (e) { if (CONFIG.DEBUG) console.warn(e); } this.loop(); };
            if (this.hasRVFC) this.handle = this.targetVideo.requestVideoFrameCallback(cb);
            else {
                this.processFrame();
                const delay = (this.targetVideo.paused || document.hidden) ? 500 : (this.dynamicSkipThreshold > 5 ? 150 : 80);
                setTimeout(() => this.loop(), delay);
            }
        },
        processFrame(allowPausedOnce = false) {
            if (!this.targetVideo || this.targetVideo.ended) { this.stop(); return; }
            if (document.hidden) return;
            if (this.targetVideo.paused && !allowPausedOnce) {
                if (!this._stopTimeout) this._stopTimeout = setTimeout(() => this.stop(), 2000);
                return;
            }
            if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null; }
            if (this.targetVideo.readyState < 2) return;
            if (!this.ctx) return;
            if (this.taintedResources.has(this.targetVideo)) return;

            const startTime = performance.now();
            const aggressive = (this._evAggressiveUntil && startTime < this._evAggressiveUntil);

            let baseThreshold = this.hasRVFC ? 10 : 0;
            if (this._highMotion) baseThreshold = this.hasRVFC ? 6 : 3;
            if (aggressive) baseThreshold = 0;

            const effectiveThreshold = baseThreshold + (this.dynamicSkipThreshold || 0);
            this.frameSkipCounter++;
            if (this.frameSkipCounter < effectiveThreshold) return;
            this.frameSkipCounter = 0;

            try {
                const size = this.canvas.width;
                this.ctx.drawImage(this.targetVideo, 0, 0, size, size);
                const imageData = this.ctx.getImageData(0, 0, size, size);
                
                const step = IS_LOW_END ? 3 : 2;
                const bandH = Math.max(1, Math.floor(size * 0.10));

                this._worker.postMessage({
                    type: 'analyze',
                    data: imageData.data,
                    width: size,
                    height: size,
                    bandH: bandH,
                    step: step
                }, [imageData.data.buffer]);

            } catch (e) {
                if (e.name === 'SecurityError') {
                    try {
                        this.canvas.width = this.canvas.width;
                        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
                        if (this.ctx) this.ctx.imageSmoothingEnabled = false;
                    } catch {}

                    this.taintedResources.add(this.targetVideo);
                    const next = this._pickBestVideoNow();
                    if (next && next !== this.targetVideo && !this.taintedResources.has(next)) {
                         this.targetVideo = next;
                         this.hasRVFC = 'requestVideoFrameCallback' in next;
                         this._kickImmediateAnalyze();
                         return;
                    }
                    this.stop();
                    this.notifyUpdate({ gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }, 0, this.targetVideo, true);
                }
            }
            const duration = performance.now() - startTime;
            if (duration > 4.0) this.dynamicSkipThreshold = Math.min(30, (this.dynamicSkipThreshold || 0) + 1);
            else if (duration < 1.0 && this.dynamicSkipThreshold > 0) this.dynamicSkipThreshold = Math.max(0, this.dynamicSkipThreshold - 1);
        },
        _processAnalysisResult(p10, p50, p90, barsNow) {
            const aggressive = (this._evAggressiveUntil && performance.now() < this._evAggressiveUntil);
            
            this._lbConf = Utils.clamp((this._lbConf || 0) * 0.9 + (barsNow ? 0.12 : -0.08), 0, 1);
            
            let contrastFactor = 1.0;
            if ((p90 - p10) < 0.1) contrastFactor = 0.3;
            
            const isHighContrast = (p90 > 0.9 && p10 < 0.1);

            const currentLuma = p50;
            if (this.lastAvgLuma >= 0) {
                const delta = Math.abs(currentLuma - this.lastAvgLuma);
                if (this._highMotion) {
                    if (delta < 0.06) this._highMotion = false;
                } else {
                    if (delta > 0.10) this._highMotion = true;
                }
                
                if (delta > 0.25) {
                     this.currentAdaptiveGamma = 1.0; this.currentAdaptiveBright = 0;
                     this._evAggressiveUntil = performance.now() + (isHighContrast ? 200 : 500);
                } else if (delta > 0.15) {
                    this._userBoostUntil = performance.now() + 300;
                }
            }
            this.lastAvgLuma = currentLuma;

            let targetAdaptiveGamma = 1.0, targetAdaptiveBright = 0, targetShadowsAdj = 0, targetHighlightsAdj = 0;
            const evValue = this.currentSettings.targetLuma || 0;
            const isAutoExp = this.currentSettings.autoExposure;

            if (isAutoExp) {
                const u = evValue / 20;
                const boostFactor = Math.tanh(u);
                const headroom = Math.max(0.0, 1.0 - p90);
                const floor = Math.max(0.1, p10);

                const spread = (p90 - p10);
                let baseTarget = 0.35;
                if (p50 < 0.18) baseTarget = 0.38;
                else if (p50 > 0.55) baseTarget = 0.33;
                
                const targetMid = Utils.clamp(baseTarget + (spread < 0.12 ? 0.03 : 0.0), 0.33, 0.40);

                let error = 0;
                if (evValue === 0) {
                    error = (targetMid - p50) * 0.35;
                } else {
                    error = boostFactor * (boostFactor > 0 ? headroom : floor) * 0.5;
                }

                if (Math.abs(error) < 0.001) error = 0;
                const correction = error * 5.0 * contrastFactor;

                if (correction > 0) {
                    const safeGammaBoost = (p90 > 0.9) ? 0.4 : 0.8;
                    targetAdaptiveGamma += correction * safeGammaBoost;
                    targetAdaptiveBright += correction * 4;
                    if (!isHighContrast) targetShadowsAdj += correction * 5;
                } else {
                    const absCorr = Math.abs(correction);
                    const safeGammaCut = (p10 < 0.1) ? 0.3 : 0.6;
                    targetAdaptiveGamma -= absCorr * safeGammaCut;
                    targetAdaptiveBright -= absCorr * 3;
                    if (!isHighContrast) targetHighlightsAdj += absCorr * 10;
                }
                
                if (this.dynamicSkipThreshold > 12) {
                    targetAdaptiveBright = Utils.clamp(targetAdaptiveBright, -25, 25);
                } else {
                    targetAdaptiveBright = Utils.clamp(targetAdaptiveBright, -40, 40);
                }
                
                targetAdaptiveGamma = Utils.clamp(targetAdaptiveGamma, 0.6, 2.0);
                targetShadowsAdj = Utils.clamp(targetShadowsAdj, -40, 40);
                targetHighlightsAdj = Utils.clamp(targetHighlightsAdj, -20, 80);
            }

            let targetClarityComp = 0;
            if (this.currentSettings.clarity > 0) {
                const intensity = this.currentSettings.clarity / 50;
                const maxLumaFactor = (isAutoExp && evValue < 0) ? 0.5 : 0.7;
                const lumaFactor = Math.max(0.2, maxLumaFactor - p50);
                let dampener = isAutoExp ? (evValue < 0 ? 0.4 : 0.6) : 1.0;
                targetClarityComp = Math.min(10, (intensity * 10) * lumaFactor * dampener);
            }

            const smooth = (curr, target) => {
                if (aggressive && !isHighContrast) {
                    const diff = target - curr;
                    return curr + diff * 0.2; 
                }
                const diff = target - curr;
                let speed = (this._userBoostUntil && performance.now() < this._userBoostUntil) ? 0.35 : (this._highMotion ? 0.05 : 0.1);
                if (isHighContrast) speed *= 0.5;
                if (Math.abs(diff) < 0.005) return curr;
                return curr + diff * speed;
            };

            this.currentAdaptiveGamma = smooth(this.currentAdaptiveGamma || 1.0, targetAdaptiveGamma);
            this.currentAdaptiveBright = smooth(this.currentAdaptiveBright || 0, targetAdaptiveBright);
            this.currentClarityComp = smooth(this._lastClarityComp || 0, targetClarityComp);
            this.currentShadowsAdj = smooth(this._lastShadowsAdj || 0, targetShadowsAdj);
            this.currentHighlightsAdj = smooth(this._lastHighlightsAdj || 0, targetHighlightsAdj);

            this._lastClarityComp = this.currentClarityComp;
            this._lastShadowsAdj = this.currentShadowsAdj;
            this._lastHighlightsAdj = this.currentHighlightsAdj;

            this.notifyUpdate({ gamma: this.currentAdaptiveGamma, bright: this.currentAdaptiveBright, clarityComp: this.currentClarityComp, shadowsAdj: this.currentShadowsAdj, highlightsAdj: this.currentHighlightsAdj }, p50, this.targetVideo, false);
        },
        notifyUpdate(autoParams, luma, videoInfo, tainted = false) {
            document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', { detail: { autoParams, luma, tainted, videoInfo } }));
        }
    };

    // [Fix: Order] Class Plugin must be defined before AudioController
    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; this._ac = new AbortController(); } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; this._ac.abort(); } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    
    class PluginManager {
        constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; }
        register(plugin) { this.plugins.push(plugin); }
        initAll() {
            this.stateManager.init();
            this.plugins.forEach(p => p.init(this.stateManager));
            this.stateManager.set('app.isInitialized', true);
            this.stateManager.set('app.pluginsInitialized', true);
            window.addEventListener('pagehide', (e) => { if (!e.persisted) this.destroyAll(); });
        }
        destroyAll() { this.plugins.forEach(p => p.destroy()); }
    }

    // --- Audio Controller ---
    class AudioController extends Plugin {
        constructor() {
            super('Audio');
            this.ctx = null;
            this.compressor = null;
            this.gain = null;
            this.source = null;
            this.targetMedia = null;
            this.initialized = false;
        }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('audio.enabled', (enabled) => this.toggle(enabled));
            this.subscribe('audio.boost', (val) => this.setBoost(val));
            this.subscribe('media.currentlyVisibleMedia', (media) => {
                if (this.stateManager.get('audio.enabled')) this.attach(media);
            });
        }
        toggle(enabled) {
            if (enabled) {
                const media = this.stateManager.get('media.currentlyVisibleMedia');
                if (media) this.attach(media);
            } else {
                this.detach();
            }
        }
        setBoost(val) {
            if (this.gain) {
                const boost = Math.pow(10, val / 20);
                this.gain.gain.setTargetAtTime(boost, this.ctx.currentTime, 0.1);
            }
        }
        attach(media) {
            if (!media || media.tagName !== 'VIDEO') return;
            if (this.targetMedia === media && this.initialized) return;
            
            this.detach();
            this.targetMedia = media;
            
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!this.ctx) this.ctx = new AudioContext();
                
                if (this.ctx.state === 'suspended') this.ctx.resume();

                if (!media._vscSource) {
                    try {
                        media._vscSource = this.ctx.createMediaElementSource(media);
                    } catch(e) {
                        return; 
                    }
                }
                this.source = media._vscSource;
                
                this.compressor = this.ctx.createDynamicsCompressor();
                this.compressor.threshold.value = CONFIG.AUDIO.THRESHOLD;
                this.compressor.knee.value = CONFIG.AUDIO.KNEE;
                this.compressor.ratio.value = CONFIG.AUDIO.RATIO;
                this.compressor.attack.value = CONFIG.AUDIO.ATTACK;
                this.compressor.release.value = CONFIG.AUDIO.RELEASE;

                this.gain = this.ctx.createGain();
                const boost = Math.pow(10, this.stateManager.get('audio.boost') / 20);
                this.gain.gain.value = boost;

                this.source.disconnect();
                this.source.connect(this.compressor);
                this.compressor.connect(this.gain);
                this.gain.connect(this.ctx.destination);
                
                this.initialized = true;
            } catch (e) {
                log('Audio attach failed', e);
            }
        }
        detach() {
            if (this.initialized && this.source) {
                try {
                    this.source.disconnect();
                    this.source.connect(this.ctx.destination);
                } catch(e) {}
            }
            this.initialized = false;
            this.targetMedia = null;
        }
    }

    class CoreMediaPlugin extends Plugin {
        constructor() {
            super('CoreMedia');
            this.mainObserver = null; this.intersectionObserver = null; this.scanTimerId = null;
            this.emptyScanCount = 0; this.baseScanInterval = IS_TOP ? CONFIG.SCAN.INTERVAL_TOP : CONFIG.SCAN.INTERVAL_IFRAME; this.currentScanInterval = this.baseScanInterval;
            this._seenIframes = new WeakSet(); this._observedImages = new WeakSet(); this._iframeBurstCooldown = new WeakMap(); this._iframeObservers = new Map(); this._iframeInternalObservers = new Map();
            this._lastImmediateScan = new WeakMap(); this._mediaAttributeObservers = new WeakMap(); this._globalAttrObs = null; this._didInitialShadowFullScan = false;
            this._visibleVideos = new Set();
            this._intersectionRatios = new WeakMap();
            this._domDirty = true;
            this._mutationCounter = 0;
            this._isBackoffMode = false;
            this._backoffInterval = null;
            this._historyOrig = null;
            this._lastShadowPrune = 0;
            this._lastAttrObsProbe = 0;
            this._lastSensitive = null;
            this._updateHooksState = null;
        }
        init(stateManager) {
            super.init(stateManager); _corePluginRef = this; VideoAnalyzer.init(stateManager);

            if (!this._historyOrig) {
                this._historyOrig = { pushState: history.pushState, replaceState: history.replaceState };
                ['pushState', 'replaceState'].forEach(fn => {
                    const orig = this._historyOrig[fn];
                    history[fn] = function (...args) {
                        const r = orig.apply(this, args);
                        try { triggerBurstScan(250); } catch { }
                        return r;
                    };
                });
            }
            on(window, 'popstate', () => triggerBurstScan(250), P(this._ac.signal));
            on(window, 'hashchange', () => triggerBurstScan(250), P(this._ac.signal));

            on(document, 'visibilitychange', () => {
                try { this._updateHooksState?.(); } catch {}
                if (document.hidden) { try { VideoAnalyzer.stop(); } catch {} }
            }, P(this._ac.signal));

            this._backoffInterval = setInterval(() => {
                if (this._mutationCounter > 60) {
                    if (!this._isBackoffMode) { this._isBackoffMode = true; log("Backoff Mode ON"); }
                } else {
                    if (this._isBackoffMode) { this._isBackoffMode = false; scheduleScan(null); }
                }
                this._mutationCounter = 0;
            }, 1000);

            const updateHooksState = () => {
                const active = this.stateManager.get('app.scriptActive');
                const hasActiveVideo = (this.stateManager.get('media.activeMedia')?.size || 0) > 0;
                const hasVideo = hasActiveVideo || hasRealVideoCached();
                const sensitive = isSensitiveContext();

                if (!sensitive) enableShadowHook();

                if (active && hasVideo && !sensitive && document.visibilityState === 'visible') {
                    enablePropertyHooks();
                } else {
                    if (!active || sensitive) disableAllHooks();
                }
            };
            this._updateHooksState = updateHooksState;

            this.subscribe('app.pluginsInitialized', () => safeGuard(() => {
                this.ensureObservers(); this.scanAndApply(); this.runStartupBoost();
                on(document, 'addShadowRoot', (e) => {
                    if (e.detail && e.detail.shadowRoot) {
                        this._domDirty = true;
                        const sr = e.detail.shadowRoot;
                        if (!sr[VSC_SR_MO]) {
                            const isHeavy = (_localShadowRoots.length > 300);
                            const config = isHeavy ? { childList: true, subtree: true } : { childList: true, subtree: true, attributes: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS };
                            const smo = new MutationObserver(() => scheduleScan(sr));
                            smo.observe(sr, config);
                            sr[VSC_SR_MO] = smo;
                        }
                        this.scanSpecificRoot(sr);
                    }
                }, P(this._ac.signal));
                on(document, 'load', (e) => {
                    const t = e.target;
                    if (t && t.tagName === 'IMG') {
                        const wantImages = this.stateManager.get('ui.areControlsVisible') || (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);
                        if (wantImages) {
                            if (t.decode) t.decode().then(() => scheduleScan(t, true)).catch(() => scheduleScan(t, true));
                            else scheduleScan(t, true);
                        }
                    }
                }, CP(this._ac.signal));
                MEDIA_EVENTS.forEach(evt => on(document, evt, (e) => {
                    const t = e.target;
                    if (t && t.tagName === 'VIDEO') {
                        const now = performance.now(); const last = this._lastImmediateScan.get(t) || 0;
                        if (now - last > 120) { this._lastImmediateScan.set(t, now); scheduleScan(t, true); }
                    }
                }, CP(this._ac.signal)));

                on(document, 'vsc-media-played', (e) => {
                    if (e.detail && e.detail.target) {
                        this.stateManager.set('media.lastInteractedVideo', { el: e.detail.target, ts: Date.now() });
                    }
                }, P(this._ac.signal));

                on(document, 'pointerdown', (e) => {
                    const path = e.composedPath ? e.composedPath() : [];
                    const vid = path.find(n => n && n.tagName === 'VIDEO') || (e.target && e.target.closest && e.target.closest('video'));
                    if (vid) {
                        this.stateManager.set('media.lastInteractedVideo', { el: vid, ts: Date.now() });
                    }
                }, { capture: true, passive: true, signal: this._ac.signal });

                const fsChange = () => {
                    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
                    if (fsEl) {
                        const vid = (fsEl.tagName === 'VIDEO') ? fsEl : fsEl.querySelector('video');
                        if (vid) {
                            this.stateManager.set('media.currentlyVisibleMedia', vid);
                            this.stateManager.set('media.lastInteractedVideo', { el: vid, ts: Date.now() });
                        }
                    }
                };
                on(document, 'fullscreenchange', fsChange, P(this._ac.signal));
                on(document, 'webkitfullscreenchange', fsChange, P(this._ac.signal));

                this.scheduleNextScan();
            }, 'CoreMedia pluginsInitialized'));

            this.subscribe('app.scriptActive', (active, old) => {
                updateHooksState();
                if (active && !old) {
                    collectOpenShadowRootsOnce();
                    triggerBurstScan(250);
                }
                this.updateGlobalAttrObs(active);
            });
            this.subscribe('videoFilter.autoExposure', () => this.updateGlobalAttrObs(this.stateManager.get('app.scriptActive')));
            this.subscribe('videoFilter.clarity', () => this.updateGlobalAttrObs(this.stateManager.get('app.scriptActive')));

            this.subscribe('media.activeMedia', () => updateHooksState());
            updateHooksState();

            const throttledReset = throttle(() => this.resetScanInterval(), 300);
            ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => on(document, evt, throttledReset, CP(this._ac.signal)));

            if ('ResizeObserver' in window) {
                this._resizeObs = new ResizeObserver(throttle(entries => {
                    let needed = false;
                    for (const e of entries) {
                        const t = e.target;
                        if (t.tagName === 'VIDEO') needed = true;
                        if (t.tagName === 'VIDEO' && e.contentRect.width > 50) needed = true;
                        else if (t.tagName === 'IMG' && e.contentRect.height > 100) needed = true;
                    }
                    if (needed) scheduleScan(null);
                }, 200));
            }
            if (this.stateManager.get('app.scriptActive')) this.updateGlobalAttrObs(true);
        }
        updateGlobalAttrObs(active) {
            if (!CONFIG.FLAGS.GLOBAL_ATTR_OBS) return;
            const sm = this.stateManager;
            const controlsVisible = sm.get('ui.areControlsVisible');
            const aeActive = sm.get('videoFilter.autoExposure') || sm.get('videoFilter.clarity') > 0;
            
            const shouldRun = active && (controlsVisible || aeActive);

            if (shouldRun && !this._globalAttrObs) {
                this._globalAttrObs = new MutationObserver(throttle((ms) => {
                    let dirty = false;
                    for (const m of ms) {
                        const t = m.target;
                        if (!t) continue;
                        const tag = t.nodeName;
                        if (tag === 'SOURCE') {
                            scheduleScan(t.parentNode, true); dirty = true;
                            if (t.parentNode && t.parentNode.tagName === 'PICTURE') dirty = true;
                        }
                        else if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME') { scheduleScan(t, true); dirty = true; }
                    }
                    if (dirty) this._domDirty = true;
                }, 150));
                this._globalAttrObs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS });
            } else if (!shouldRun && this._globalAttrObs) {
                this._globalAttrObs.disconnect(); this._globalAttrObs = null;
            }
        }
        runStartupBoost() {
            const aggressiveScan = () => {
                const sm = this.stateManager;
                const hasAny = sm.get('media.activeMedia').size > 0 || sm.get('media.activeImages').size > 0 || document.querySelector(SEL.FILTER_TARGET);
                if (!hasAny) {
                    scheduleScan(null, true);
                    if (performance.now() < 10000) setTimeout(aggressiveScan, 1000);
                }
            };
            const times = [300, 1500, 5000];
            times.forEach(d => setTimeout(aggressiveScan, d));
        }
        destroy() {
            super.destroy(); _corePluginRef = null;
            if (this._historyOrig) {
                history.pushState = this._historyOrig.pushState;
                history.replaceState = this._historyOrig.replaceState;
                this._historyOrig = null;
            }
            if (this.mainObserver) { this.mainObserver.disconnect(); this.mainObserver = null; }
            if (this.intersectionObserver) { this.intersectionObserver.disconnect(); this.intersectionObserver = null; }
            if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scanTimerId = null; }
            if (this._resizeObs) this._resizeObs.disconnect();
            if (this._globalAttrObs) this._globalAttrObs.disconnect();
            if (this._backoffInterval) clearInterval(this._backoffInterval);
        }
        _pruneDisconnected() {
            const sm = this.stateManager;
            const curMedia = sm.get('media.activeMedia');
            if (curMedia && curMedia.size) {
                let changed = false; const next = new Set();
                for (const v of curMedia) { if (v && v.isConnected) next.add(v); else { this.detachMediaListeners(v); changed = true; } }
                if (changed) sm.set('media.activeMedia', next);
            }
            const curImages = sm.get('media.activeImages');
            if (curImages && curImages.size) {
                let changed = false; const next = new Set();
                for (const img of curImages) { if (img && img.isConnected) next.add(img); else { this.detachImageListeners(img); changed = true; } }
                if (changed) sm.set('media.activeImages', next);
            }
            const curIframes = sm.get('media.activeIframes');
            if (curIframes && curIframes.size) {
                let changed = false; const next = new Set();
                for (const iframe of curIframes) { if (iframe && iframe.isConnected) next.add(iframe); else { changed = true; } }
                if (changed) sm.set('media.activeIframes', next);
            }
        }
        tick() {
            if (this._domDirty) { this._domDirty = false; scheduleScan(null); }
            const nowSens = isSensitiveContext();
            if (this._lastSensitive !== nowSens) {
                this._lastSensitive = nowSens;
                try { this._updateHooksState?.(); } catch {}
            }
            this._cleanupDeadIframes();
            this._pruneDisconnected();
            
            if (_localShadowRoots.length > 0 && Date.now() - this._lastShadowPrune > 15000) {
                this._lastShadowPrune = Date.now();
                let i = _localShadowRoots.length;
                while (i--) {
                     const r = _localShadowRoots[i];
                     const alive = r && r.host && r.host.isConnected;
                     if (!alive) {
                         if (r?.[VSC_SR_MO]) { try { r[VSC_SR_MO].disconnect(); } catch {} r[VSC_SR_MO] = null; }
                         _localShadowRoots.splice(i, 1);
                         _localShadowSet.delete(r);
                     }
                }
            }
            
            if (this.stateManager.get('app.scriptActive') && !this._globalAttrObs) {
                const now = Date.now();
                if (!this._lastAttrObsProbe || now - this._lastAttrObsProbe > 8000) {
                    this._lastAttrObsProbe = now;
                    this.updateGlobalAttrObs(true);
                }
            }

            const sm = this.stateManager;
            const activeMedia = sm.get('media.activeMedia'); const activeImages = sm.get('media.activeImages');
            const hasPotential = document.getElementsByTagName('video').length > 0 || document.getElementsByTagName('iframe').length > 0 || (sm.get('ui.areControlsVisible') && document.images.length > 0);

            if ((activeMedia && activeMedia.size > 0) || (activeImages && activeImages.size > 0) || hasPotential) {
                this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval;
            } else {
                this.emptyScanCount++; if (this.emptyScanCount > 3) this.currentScanInterval = Math.min(CONFIG.SCAN.INTERVAL_MAX, this.currentScanInterval * 1.5);
            }
            this.scheduleNextScan();
        }
        ensureObservers() {
            if (!this.mainObserver) {
                const dirtySet = new Set();
                const mayContainMedia = (n) => {
                    if (!n || n.nodeType !== 1) return false;
                    const tag = n.nodeName;
                    if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME' || tag === 'SOURCE' || tag === 'CANVAS') return true;
                    if (n.childElementCount > 0 && n.querySelector) {
                         return !!n.querySelector(SEL.MEDIA);
                    }
                    return false;
                };
                const flushDirty = debounce(() => {
                    if (dirtySet.size > 0) {
                        this._domDirty = true;
                        for (const n of dirtySet) scheduleScan(n);
                        if (dirtySet.size > 50) scheduleScan(null);
                        dirtySet.clear();
                    }
                }, 150);

                this.mainObserver = new MutationObserver((mutations) => {
                    this._mutationCounter += mutations.length;
                    if (this._isBackoffMode) {
                        let critical = false;
                        for (const m of mutations) {
                             if (m.addedNodes.length > 0) {
                                 for (const n of m.addedNodes) {
                                     if (n.nodeType === 1 && mayContainMedia(n)) { critical = true; break; }
                                 }
                             }
                             if (critical) break;
                        }
                        if (critical) { this._domDirty = true; scheduleScan(null); }
                        return;
                    }
                    let dirty = false;
                    if (mutations.length > 50) { this._domDirty = true; scheduleScan(null); return; }
                    for (const m of mutations) {
                        if (m.type === 'childList') {
                            for (const n of m.addedNodes) {
                                if (n.nodeType === 11) {
                                    for (let c = n.firstChild; c; c = c.nextSibling) {
                                        if (c.nodeType === 1 && mayContainMedia(c)) { dirtySet.add(c); dirty = true; }
                                    }
                                    continue;
                                }
                                if (n.nodeType === 1 && !n.closest('[data-vsc-internal]')) {
                                    if (n.nodeName === 'SOURCE') { const p = n.parentNode; if (p && p.nodeName === 'VIDEO') { dirtySet.add(p); dirty = true; } continue; }
                                    if (mayContainMedia(n)) { dirtySet.add(n); dirty = true; }
                                }
                            }
                        }
                    }
                    if (dirty) flushDirty();
                });

                if (document.body) this.mainObserver.observe(document.body, { childList: true, subtree: true });
                else {
                    this.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
                    window.addEventListener('DOMContentLoaded', () => {
                        this.mainObserver.disconnect();
                        if (document.body) this.mainObserver.observe(document.body, { childList: true, subtree: true });
                    });
                }
            }
            if (!this.intersectionObserver) {
                const thresholdConfig = IS_LOW_END ? [0, 0.2, 0.6] : [0, 0.25, 0.5, 0.75, 1.0];

                this.intersectionObserver = new IntersectionObserver(entries => {
                    const sm = this.stateManager;
                    const visMap = sm.get('media.visibilityMap'); let needsUpdate = false;
                    entries.forEach(e => {
                        const pipEl = document.pictureInPictureElement;
                        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
                        const isVisible = (e.isIntersecting && e.intersectionRatio > 0) || (pipEl === e.target) || (fsEl && (fsEl === e.target || fsEl.contains(e.target)));
                        if (visMap) visMap.set(e.target, isVisible);
                        this._intersectionRatios.set(e.target, e.intersectionRatio);

                        if (e.target.tagName === 'IFRAME' || e.target.tagName === 'CANVAS') {
                            if (visMap) visMap.set(e.target, isVisible);
                            sm.set('media.visibilityChange', { target: e.target, isVisible });
                        }
                        else if (e.target.tagName === 'VIDEO') {
                            if (isVisible) this._visibleVideos.add(e.target); else this._visibleVideos.delete(e.target);
                            sm.set('media.visibilityChange', { target: e.target, isVisible });
                            needsUpdate = true;
                        }
                        else if (e.target.tagName === 'IMG') sm.set('media.visibilityChange', { target: e.target, isVisible });

                        if (!e.target.isConnected) { this.intersectionObserver.unobserve(e.target); this._visibleVideos.delete(e.target); }
                    });
                    if (needsUpdate && !document.hidden) {
                        if (this._centerCalcTimer) clearTimeout(this._centerCalcTimer);
                        this._centerCalcTimer = setTimeout(() => {
                            if (this._visibleVideos.size === 0) return;
                            const currentBest = sm.get('media.currentlyVisibleMedia');
                            const lastInteracted = sm.get('media.lastInteractedVideo');
                            let bestCandidate = null; let maxScore = -1;
                            const cx = window.innerWidth / 2; const cy = window.innerHeight / 2;
                            let centerEl = null;

                            if (this._visibleVideos.size > 1) {
                                try { const stack = document.elementsFromPoint(cx, cy); for (const el of stack) { if (el && !el.closest('[data-vsc-internal]')) { centerEl = el; break; } } } catch {}
                            }

                            for (const m of this._visibleVideos) {
                                if (m.tagName === 'VIDEO') {
                                    const area = (m.clientWidth || 0) * (m.clientHeight || 0); let score = area;
                                    if (!m.paused) score *= 2.5;
                                    if ('requestVideoFrameCallback' in m && !m.paused) score *= 1.2;

                                    if (m.readyState >= 3) score *= 1.5; if (!m.muted && m.volume > 0) score *= 1.2;
                                    if (m.ended) score *= 0.5; if (document.pictureInPictureElement === m) score *= 3.0;
                                    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
                                    if (fsEl && (fsEl === m || fsEl.contains(m))) score *= 4.0;
                                    if (m.loop && m.muted && m.autoplay && !m.controls) score *= 0.6;
                                    if (m.controls) score *= 1.2;

                                    if (lastInteracted && lastInteracted.el === m && (Date.now() - lastInteracted.ts < 30000)) { score *= 4.0; }

                                    const ratio = this._intersectionRatios.get(m) || 0; score *= (0.5 + ratio * 0.5);
                                    if (centerEl && (m === centerEl || m.contains(centerEl) || centerEl.contains(m))) { score *= 2.0; } else { const rect = m.getBoundingClientRect(); const mx = rect.left + rect.width / 2; const my = rect.top + rect.height / 2; const dist = Math.hypot(mx - cx, my - cy); const maxDist = Math.hypot(cx, cy) || 1; score *= (1.2 - Math.min(1.0, dist / maxDist)); }
                                    if (score > maxScore) { maxScore = score; bestCandidate = m; }
                                }
                            }
                            if (bestCandidate && bestCandidate !== currentBest) {
                                if (currentBest && currentBest !== bestCandidate) VideoAnalyzer.stop();
                                sm.set('media.currentlyVisibleMedia', bestCandidate);

                                if (this._changeTimer) clearTimeout(this._changeTimer);
                                this._changeTimer = setTimeout(() => {
                                    const vf = sm.get('videoFilter'); const active = sm.get('app.scriptActive');
                                    if (active && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(bestCandidate, { autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
                                }, 200);
                            }
                        }, 150);
                    }
                }, { root: null, rootMargin: '0px', threshold: thresholdConfig });
            }
        }
        scheduleNextScan() {
            if (this.scanTimerId) clearTimeout(this.scanTimerId);
            this.scanTimerId = setTimeout(() => {
                if (document.hidden) { this.currentScanInterval = this.baseScanInterval; this.scheduleNextScan(); return; }
                const wrapped = () => safeGuard(() => { this.tick(); }, 'tick');
                if (window.requestIdleCallback) window.requestIdleCallback(wrapped, { timeout: 1000 }); else setTimeout(wrapped, 1);
            }, this.currentScanInterval);
        }
        resetScanInterval() { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scheduleNextScan(); } }
        scanAndApply() { const visited = new WeakSet(); this._processAllElements(visited, !this._didInitialShadowFullScan); this._didInitialShadowFullScan = true; }
        _checkAndAdd(node, media, images, iframes) {
            if (node.tagName === 'VIDEO') {
                const vw = node.videoWidth || 0;
                const vh = node.videoHeight || 0;
                const cw = node.clientWidth || 0;
                const ch = node.clientHeight || 0;

                let sizeOk = (vw >= CONFIG.FILTER.MIN_VIDEO_SIZE || vh >= CONFIG.FILTER.MIN_VIDEO_SIZE) ||
                             (cw >= CONFIG.FILTER.MIN_VIDEO_SIZE || ch >= CONFIG.FILTER.MIN_VIDEO_SIZE);

                if (!sizeOk) {
                    const ow = node.offsetWidth || 0;
                    const oh = node.offsetHeight || 0;
                    sizeOk = (ow >= CONFIG.FILTER.MIN_VIDEO_SIZE || oh >= CONFIG.FILTER.MIN_VIDEO_SIZE);
                }
                const isPotential = (node.src || node.currentSrc || node.srcObject || node.querySelector('source') || node.getAttribute('data-src') || node.getAttribute('data-video-src') || node.getAttribute('data-url'));
                const isPlayableHidden = !sizeOk && (node.duration > 0 || node.readyState >= 1);
                if (sizeOk || isPotential || isPlayableHidden) media.add(node);
            } else if (node.tagName === 'IMG') {
                const wantImages = this.stateManager.get('ui.areControlsVisible') || (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);
                if (wantImages) {
                    const w = node.naturalWidth || node.offsetWidth || 0; const h = node.naturalHeight || node.offsetHeight || 0;
                    if ((w >= CONFIG.FILTER.MIN_IMAGE_SIZE && h >= CONFIG.FILTER.MIN_IMAGE_SIZE) || (w * h >= 200000)) images.add(node);
                }
            } else if (node.tagName === 'IFRAME') {
                this._hookIframe(node);
                iframes.add(node);
            } else if (node.tagName === 'CANVAS') {
                iframes.add(node);
            }
            else if (node.tagName === 'SOURCE' && node.parentNode && node.parentNode.tagName === 'VIDEO') { media.add(node.parentNode); }
        }
        scanSpecificRoot(root) {
            if (!root) return;
            if (root.nodeType === 1 && (root.tagName === 'VIDEO' || root.tagName === 'IMG')) {
                const media = new Set(), images = new Set(), iframes = new Set();
                this._checkAndAdd(root, media, images, iframes);
                this._applyToSets(media, images, iframes);
                return;
            }
            const visited = new WeakSet(); const { media, images, iframes } = this.findAllElements(root, 0, true, visited); this._applyToSets(media, images, iframes);
        }
        _applyToSets(mediaSet, imageSet, iframeSet) {
            const sm = this.stateManager;
            const currentMedia = new Set(sm.get('media.activeMedia')); const currentImages = new Set(sm.get('media.activeImages')); const currentIframes = new Set(sm.get('media.activeIframes'));
            let mediaChanged = false, imagesChanged = false, iframesChanged = false;

            for (const el of mediaSet) {
                if (el.isConnected && this.attachMediaListeners(el)) { if (!currentMedia.has(el)) { currentMedia.add(el); mediaChanged = true; } }
            }
            for (const el of imageSet) {
                if (el.isConnected && this.attachImageListeners(el)) { if (!currentImages.has(el)) { currentImages.add(el); imagesChanged = true; } }
            }
             for (const el of iframeSet) {
                if (el.isConnected && this.attachIframeListeners(el)) { if (!currentIframes.has(el)) { currentIframes.add(el); iframesChanged = true; } }
            }

            if (mediaChanged) sm.set('media.activeMedia', currentMedia);
            if (imagesChanged) sm.set('media.activeImages', currentImages);
            if (iframesChanged) sm.set('media.activeIframes', currentIframes);

            if ((mediaChanged || currentMedia.size > 0 || currentImages.size > 0) && !sm.get('ui.globalContainer')) { sm.set('ui.createRequested', true); }
        }
        _processAllElements(visited, scanShadow = true) {
            const { media, images, iframes } = this.findAllElements(document, 0, !scanShadow, visited);
            this._syncSet(media, 'media.activeMedia', this.attachMediaListeners.bind(this), this.detachMediaListeners.bind(this));
            this._syncSet(images, 'media.activeImages', this.attachImageListeners.bind(this), this.detachImageListeners.bind(this));

             const activeSet = this.stateManager.get('media.activeIframes') || new Set();
             const nextActiveSet = new Set(iframes);
             let changed = false;
             for (const oldEl of activeSet) { if(oldEl && oldEl.isConnected) nextActiveSet.add(oldEl); else { changed = true; } }
             for (const el of nextActiveSet) { if (this.attachIframeListeners(el)) { if(!activeSet.has(el)) changed = true; } }

             if (changed || activeSet.size !== nextActiveSet.size) this.stateManager.set('media.activeIframes', nextActiveSet);

            const sm = this.stateManager;
            if (!sm.get('ui.globalContainer')) { if (sm.get('media.activeMedia').size > 0 || sm.get('media.activeImages').size > 0) { sm.set('ui.createRequested', true); } }
        }
        _syncSet(newSet, stateKey, attachFn, detachFn) {
            const activeSet = this.stateManager.get(stateKey);
            const nextActiveSet = new Set(newSet);
            let changed = false;
            if (activeSet) {
                for (const oldEl of activeSet) {
                    if (oldEl && oldEl.isConnected) { nextActiveSet.add(oldEl); }
                    else { detachFn(oldEl); changed = true; }
                }
            }
            for (const el of nextActiveSet) {
                if (el.isConnected) {
                    if (attachFn(el)) { if (!activeSet || !activeSet.has(el)) changed = true; }
                }
            }
            if (changed || (activeSet && activeSet.size !== nextActiveSet.size)) {
                this.stateManager.set(stateKey, nextActiveSet);
            }
        }
        _cleanupDeadIframes() {
            for (const [frame, mo] of this._iframeObservers) {
                if (!frame || !frame.isConnected) {
                    try { mo.disconnect(); } catch { } this._iframeObservers.delete(frame);
                    const internal = this._iframeInternalObservers.get(frame);
                    if (internal && internal.mo) { try { internal.mo.disconnect(); } catch { } }
                    this._iframeInternalObservers.delete(frame);
                    try { frame.removeEventListener('load', frame._vscOnLoad, { passive: true }); } catch { }
                }
            }
        }
        _hookIframe(frame) {
            if (!frame || this._seenIframes.has(frame)) return; this._seenIframes.add(frame); if (this._iframeObservers.has(frame)) return;
            const burstRescan = () => {
                const now = Date.now(); const last = this._iframeBurstCooldown.get(frame) || 0;
                if (now - last < 1500) return; this._iframeBurstCooldown.set(frame, now);
                triggerBurstScan(200);
            };
            const attachInternalObserver = () => {
                try {
                    const doc = frame.contentDocument; if (!doc || !doc.body) return;
                    this.scanSpecificRoot(doc.body);
                    const prev = this._iframeInternalObservers.get(frame); if (prev && prev.doc === doc) return;
                    if (prev && prev.mo) { try { prev.mo.disconnect(); } catch { } }
                    const internalMo = new MutationObserver((mutations) => { burstRescan(); this._domDirty = true; });
                    internalMo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS });
                    this._iframeInternalObservers.set(frame, { doc, mo: internalMo });
                } catch { }
            };
            const onLoad = () => { burstRescan(); attachInternalObserver(); }; frame._vscOnLoad = onLoad;
            try { frame.addEventListener('load', onLoad, { passive: true }); } catch (e) { }
            const mo = new MutationObserver((ms) => { if (!frame.isConnected) return; for (const m of ms) if (m.type === 'attributes') { burstRescan(); this._domDirty = true; break; } });
            try { mo.observe(frame, { attributes: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS }); this._iframeObservers.set(frame, mo); } catch { }
            attachInternalObserver();
        }
        findAllElements(root, depth, skipShadowScan, visited) {
            const media = new Set(); const images = new Set(); const iframes = new Set();
            if (!root) return { media, images, iframes }; if (depth > CONFIG.SCAN.MAX_DEPTH) return { media, images, iframes };
            const wantImages = this.stateManager.get('ui.areControlsVisible') || (this.stateManager.get('imageFilter.level') > 0 || this.stateManager.get('imageFilter.colorTemp') !== 0);
            if (root === document) {
                const hasShadow = _localShadowRoots.length > 0;
                if (!document.querySelector('video, iframe, canvas, img, source') && !hasShadow) return { media, images, iframes };

                const docVideos = document.getElementsByTagName('video'); for (let i = 0; i < docVideos.length; i++) this._checkAndAdd(docVideos[i], media, images, iframes);
                if (wantImages) {
                    const docImages = document.images; for (let i = 0; i < docImages.length; i++) {
                        const img = docImages[i]; const w = img.naturalWidth || img.offsetWidth || 0; const h = img.naturalHeight || img.offsetHeight || 0;
                        if ((w >= CONFIG.FILTER.MIN_IMAGE_SIZE && h >= CONFIG.FILTER.MIN_IMAGE_SIZE) || (w * h >= 200000)) images.add(img);
                    }
                }
                const docIframes = document.getElementsByTagName('iframe'); for (let i = 0; i < docIframes.length; i++) this._checkAndAdd(docIframes[i], media, images, iframes);
                const docCanvas = document.getElementsByTagName('canvas'); for (let i = 0; i < docCanvas.length; i++) this._checkAndAdd(docCanvas[i], media, images, iframes);
            } else {
                const candidates = root.querySelectorAll(wantImages ? SEL.MEDIA : SEL.NOIMG_TARGET);
                candidates.forEach(el => this._checkAndAdd(el, media, images, iframes));
            }
            if (root === document) { const hasShadow = _localShadowRoots.length > 0; if (!media.size && !images.size && !hasShadow) return { media, images, iframes }; }
            if (root.nodeType === 1) this._checkAndAdd(root, media, images, iframes);
            if (visited.has(root)) return { media, images, iframes }; visited.add(root);

            if (!skipShadowScan && root === document) {
                _localShadowRoots.forEach(shadowRoot => {
                    let flags = shadowRoot[VSC_FLAG] | 0;
                    if (!(flags & FLAG_OBSERVED)) {
                        try {
                            const isHeavy = (_localShadowRoots.length > 300);
                            const config = isHeavy ? { childList: true, subtree: true } : { childList: true, subtree: true, attributes: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS };
                            const smo = new MutationObserver(() => scheduleScan(shadowRoot));
                            smo.observe(shadowRoot, config);
                            shadowRoot[VSC_FLAG] = (flags | FLAG_OBSERVED);
                            shadowRoot[VSC_SR_MO] = smo;
                        } catch (e) { }
                    }
                    try {
                        const res = this.findAllElements(shadowRoot, depth + 1, true, visited);
                        res.media.forEach(m => media.add(m));
                        res.images.forEach(i => images.add(i));
                        res.iframes.forEach(f => iframes.add(f));
                    } catch (e) { }
                });
            }
            return { media, images, iframes };
        }
        attachMediaListeners(media) {
            const owner = media.getAttribute('data-vsc-controlled-by');
            if (owner && owner !== VSC_INSTANCE_ID) return false;
            if (this.stateManager.get('media.mediaListenerMap').has(media)) return true;
            try { this.intersectionObserver.observe(media); } catch (e) { return false; }
            media.setAttribute('data-vsc-controlled-by', VSC_INSTANCE_ID);
            const rect = media.getBoundingClientRect ? media.getBoundingClientRect() : null;
            const isVisible = !!rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
            const visMap = this.stateManager.get('media.visibilityMap');
            if (visMap) visMap.set(media, isVisible);
            if (isVisible) this._visibleVideos.add(media);
            if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);
            const ac = new AbortController(); const signal = ac.signal;
            const handleRescan = throttle(() => this.resetScanInterval(), 250);
            on(media, 'loadedmetadata', handleRescan, P(signal)); on(media, 'loadeddata', handleRescan, P(signal));
            const updateRate = () => this.stateManager.set('playback.currentRate', media.playbackRate);
            on(media, 'play', updateRate, P(signal)); on(media, 'ratechange', updateRate, P(signal));
            const enforceRate = throttle(() => {
                if (!this.stateManager.get('app.scriptActive')) return;
                const target = this.stateManager.get('playback.targetRate');
                if (Math.abs((media.playbackRate || 1) - target) > 0.01) { try { media.playbackRate = target; } catch { } }
            }, 250);
            on(media, 'ratechange', enforceRate, P(signal)); on(media, 'play', enforceRate, P(signal));
            const onPiP = () => { const visMap = this.stateManager.get('media.visibilityMap'); if (visMap) visMap.set(media, true); this.stateManager.set('media.currentlyVisibleMedia', media); };
            on(media, 'enterpictureinpicture', onPiP, P(signal));
            const onPlaying = () => {
                if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);
                const isVis = this.stateManager.get('media.visibilityMap').get(media);
                if (isVis) {
                    this.stateManager.set('media.currentlyVisibleMedia', media);
                    const vf = this.stateManager.get('videoFilter'); const active = this.stateManager.get('app.scriptActive');
                    if (active && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(media, { autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
                }
            };
            on(media, 'playing', onPlaying, P(signal));

            on(media, 'loadedmetadata', () => VideoAnalyzer.taintedResources.delete(media), P(signal));

            const attrMo = new MutationObserver((mutations) => {
                let triggered = false;
                for (const m of mutations) {
                    if (m.type === 'attributes') {
                        if (m.target === media && (m.attributeName === 'src' || m.attributeName === 'poster' || m.attributeName === 'data-src')) {
                            VideoAnalyzer.taintedResources.delete(media);
                            triggered = true;
                        }
                        if (m.target.nodeName === 'SOURCE' && m.attributeName === 'src') {
                            VideoAnalyzer.taintedResources.delete(media);
                            triggered = true;
                        }
                    }
                }
                if (triggered) scheduleScan(media, true);
            });
            const isGlobalWatching = CONFIG.FLAGS.GLOBAL_ATTR_OBS && this.stateManager.get('app.scriptActive');
            const inShadow = (() => { const rn = media.getRootNode?.(); return rn && rn.nodeType === 11 && rn.host; })();
            attrMo.observe(media, { attributes: true, subtree: !isGlobalWatching || inShadow || !!media.querySelector('source'), attributeFilter: ['src', 'poster', 'data-src', 'data-url'] });
            this._mediaAttributeObservers.set(media, attrMo);
            this.stateManager.get('media.mediaListenerMap').set(media, () => { ac.abort(); attrMo.disconnect(); });
            if (this._resizeObs) this._resizeObs.observe(media);
            return true;
        }
        detachMediaListeners(media) {
            const listenerMap = this.stateManager.get('media.mediaListenerMap'); if (!listenerMap.has(media)) return;
            if (media.getAttribute('data-vsc-controlled-by') === VSC_INSTANCE_ID) media.removeAttribute('data-vsc-controlled-by');
            const cleanup = listenerMap.get(media); if (typeof cleanup === 'function') cleanup();
            listenerMap.delete(media);
            try { this.intersectionObserver.unobserve(media); } catch (e) { }
            this._visibleVideos.delete(media); this._mediaAttributeObservers.delete(media);
            if (this._resizeObs) this._resizeObs.unobserve(media);
        }
        attachImageListeners(image) {
            if (!image || !this.intersectionObserver) return false;
            if (this.stateManager.filterManagers.image) injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager);
            const visMap = this.stateManager.get('media.visibilityMap'); if (visMap) visMap.set(image, false);
            if (!this._observedImages.has(image)) {
                try { this.intersectionObserver.observe(image); this._observedImages.add(image); if (this._resizeObs) this._resizeObs.observe(image); } catch (e) { return false; }
            }
            return true;
        }
        detachImageListeners(image) { try { this.intersectionObserver.unobserve(image); } catch (e) { } this._observedImages.delete(image); if (this._resizeObs) this._resizeObs.unobserve(image); }
        attachIframeListeners(iframe) {
            if (!iframe || !this.intersectionObserver) return false;
            if (this.stateManager.filterManagers.video) {
                injectFiltersIntoContext(iframe, this.stateManager.filterManagers.video, this.stateManager);
            }
            const visMap = this.stateManager.get('media.visibilityMap');
            const rect = iframe.getBoundingClientRect();
            const isVisible = rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
            if (visMap) visMap.set(iframe, isVisible);

            try { this.intersectionObserver.observe(iframe); } catch(e) { return false; }
            return true;
        }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this._mediaStateRafId = null; }
        init(stateManager) {
            super.init(stateManager); const isMobile = this.stateManager.get('app.isMobile');
            this.filterManager = this._createManager({ settings: isMobile ? CONFIG.FILTER.MOBILE_SETTINGS : CONFIG.FILTER.DESKTOP_SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', className: 'vsc-video-filter-active', isImage: false });
            this.imageFilterManager = this._createManager({ settings: CONFIG.FILTER.IMAGE_SETTINGS, svgId: 'vsc-image-svg-filters', styleId: 'vsc-image-styles', className: 'vsc-image-filter-active', isImage: true });
            this.filterManager.init(); this.imageFilterManager.init();
            this.stateManager.filterManagers.video = this.filterManager; this.stateManager.filterManagers.image = this.imageFilterManager;
            this.subscribe('app.scriptActive', (active) => {
                if (active) {
                    this.filterManager.init(); this.imageFilterManager.init();
                    const sm = this.stateManager; const activeMedia = sm.get('media.activeMedia'); const activeImages = sm.get('media.activeImages');
                    if (activeMedia.size > 0) activeMedia.forEach(m => { if (!m.isConnected) return; injectFiltersIntoContext(m, this.filterManager, sm); this._updateVideoFilterState(m); });
                    if (activeImages.size > 0) activeImages.forEach(i => { if (!i.isConnected) return; injectFiltersIntoContext(i, this.imageFilterManager, sm); this._updateImageFilterState(i); });
                    this.applyAllVideoFilters(); this.applyAllImageFilters();
                } else { this.applyAllVideoFilters(); this.applyAllImageFilters(); }
            });
            this.subscribe('videoFilter.*', this.applyAllVideoFilters.bind(this));
            this.subscribe('videoFilter.autoExposure', (on, old) => { if (on && !old) { this.lastAutoParams = { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }; this.applyAllVideoFilters(); } });
            this.subscribe('videoFilter.targetLuma', () => { if (this.stateManager.get('videoFilter.autoExposure')) { this.lastAutoParams = { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }; this.applyAllVideoFilters(); } });
            this.subscribe('imageFilter.level', (val) => { this.applyAllImageFilters(); if (val > 0) { const core = window.vscPluginManager?.plugins?.find(p => p.name === 'CoreMedia'); if (core) core.scanAndApply(); } });
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visibilityChange', () => this.updateMediaFilterStates()); this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates()); this.subscribe('app.scriptActive', () => { this.updateMediaFilterStates(); });
            this.throttledUpdate = throttle((e) => {
                const { autoParams, videoInfo } = e.detail; 
                const currentMedia = this.stateManager.get('media.currentlyVisibleMedia');
                if (videoInfo && videoInfo !== currentMedia) return;

                const vf = this.stateManager.get('videoFilter'); const needAutoApply = vf.autoExposure || (vf.clarity > 0);
                const isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.002 || Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.1 || Math.abs((this.lastAutoParams.clarityComp || 0) - (autoParams.clarityComp || 0)) > 0.1 || Math.abs((this.lastAutoParams.shadowsAdj || 0) - (autoParams.shadowsAdj || 0)) > 0.1 || Math.abs((this.lastAutoParams.highlightsAdj || 0) - (autoParams.highlightsAdj || 0)) > 0.1;
                if (needAutoApply && isChanged) { this.lastAutoParams = autoParams; this.applyAllVideoFilters(); }
            }, 100);
            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
            if (this.stateManager.get('app.scriptActive')) { this.filterManager.init(); this.imageFilterManager.init(); this.applyAllVideoFilters(); this.applyAllImageFilters(); }

            this._pruneTimer = setInterval(() => {
                if (this.filterManager) this.filterManager.prune();
                if (this.imageFilterManager) this.imageFilterManager.prune();
            }, 10000);
        }
        destroy() { super.destroy(); if (this.throttledUpdate) document.removeEventListener('vsc-smart-limit-update', this.throttledUpdate); if (this._rafId) cancelAnimationFrame(this._rafId); if (this._imageRafId) cancelAnimationFrame(this._imageRafId); if (this._mediaStateRafId) cancelAnimationFrame(this._mediaStateRafId); if (this._pruneTimer) { clearInterval(this._pruneTimer); this._pruneTimer = null; } }

        setInlineFilter(el, filterCss) {
            if (!_prevInlineStyle.has(el)) {
                _prevInlineStyle.set(el, {
                    filter: el.style.filter || '',
                    webkitFilter: el.style.webkitFilter || '',
                });
            }
            el.style.setProperty('filter', filterCss, 'important');
            el.style.setProperty('-webkit-filter', filterCss, 'important');
            el.dataset.vscInlineFilter = '1';
        }

        restoreInlineFilter(el) {
            if (el.dataset.vscInlineFilter !== '1') return;
            const prev = _prevInlineStyle.get(el);
            if (prev) {
                el.style.filter = prev.filter;
                el.style.webkitFilter = prev.webkitFilter;
                _prevInlineStyle.delete(el);
            } else {
                el.style.removeProperty('filter');
                el.style.removeProperty('-webkit-filter');
            }
            delete el.dataset.vscInlineFilter;
        }

        _createManager(options) {
            class SvgFilterManager {
                constructor(options) { this._isInitialized = false; this._styleElement = null; this._svgNode = null; this._options = options; this._elementCache = new WeakMap(); this._activeFilterRoots = new Set(); this._globalToneCache = { key: null, table: null }; this._lastValues = null; this._clarityTableCache = new Map(); }
                isInitialized() { return this._isInitialized; } getSvgNode() { return this._svgNode; } getStyleNode() { return this._styleElement; }
                init() { if (this._isInitialized) return; safeGuard(() => {
                    const { svgNode, styleElement } = this._createElements();
                    this._svgNode = svgNode; this._styleElement = styleElement;
                    const container = document.body || document.documentElement;
                    if (container) container.appendChild(svgNode);
                    (document.head || document.documentElement).appendChild(styleElement);
                    this._activeFilterRoots.add(this._svgNode);
                    this._isInitialized = true;
                }, `${this.constructor.name}.init`); }
                registerContext(svgElement) { this._activeFilterRoots.add(svgElement); }
                prune() {
                    for (const root of this._activeFilterRoots) {
                        if (!root || !root.isConnected) {
                            this._activeFilterRoots.delete(root);
                            this._elementCache.delete(root);
                        }
                    }
                }
                _createElements() {
                    const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
                    const { settings, svgId, styleId, className, isImage } = this._options;
                    const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`; const combinedFilterNoGrainId = `${settings.SHARPEN_ID}_combined_filter_nograin`;
                    const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
                    const style = document.createElement('style'); style.id = styleId;
                    const cssContent = ` .${className} { filter: url(#${combinedFilterId}) !important; } .${className}.no-grain { filter: url(#${combinedFilterNoGrainId}) !important; } `;
                    style.textContent = cssContent;
                    const buildChain = (id, includeGrain) => {
                        const filter = createSvgElement('filter', { id: id, "color-interpolation-filters": "sRGB" });
                        const clarityTransfer = createSvgElement('feComponentTransfer', { "data-vsc-id": "clarity_transfer", in: "SourceGraphic", result: "clarity_out" });
                        ['R', 'G', 'B'].forEach(c => clarityTransfer.append(createSvgElement('feFunc' + c, { "data-vsc-id": "clarity_func", type: "table", tableValues: "0 1" })));
                        const blurFine = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_fine", in: "clarity_out", stdDeviation: "0", result: "blur_fine_out" });
                        const compFine = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_fine", operator: "arithmetic", in: "clarity_out", in2: "blur_fine_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_fine" });
                        const blurCoarse = createSvgElement('feGaussianBlur', { "data-vsc-id": "sharpen_blur_coarse", in: "sharpened_fine", stdDeviation: "0", result: "blur_coarse_out" });
                        const compCoarse = createSvgElement('feComposite', { "data-vsc-id": "sharpen_comp_coarse", operator: "arithmetic", in: "sharpened_fine", in2: "blur_coarse_out", k1: "0", k2: "1", k3: "0", k4: "0", result: "sharpened_final" });
                        filter.append(clarityTransfer, blurFine, compFine, blurCoarse, compCoarse);
                        let lastOut = "sharpened_final";
                        if (includeGrain) {
                            const grainNode = createSvgElement('feTurbulence', { "data-vsc-id": "grain_gen", type: "fractalNoise", baseFrequency: "0.80", numOctaves: "1", stitchTiles: "noStitch", result: "grain_noise" });
                            const grainComp = createSvgElement('feComposite', { "data-vsc-id": "grain_comp", operator: "arithmetic", in: "sharpened_final", in2: "grain_noise", k1: "0", k2: "1", k3: "0", k4: "0", result: "grained_out" });
                            filter.append(grainNode, grainComp); lastOut = "grained_out";
                        }
                        if (isImage) {
                            const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: lastOut, result: "final_out" });
                            colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                            filter.append(colorTemp);
                        } else {
                            const lumaContrast = createSvgElement('feColorMatrix', { "data-vsc-id": "luma_contrast_matrix", in: lastOut, type: "matrix", values: "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0", result: "luma_contrast_out" });
                            const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: "luma_contrast_out", type: "saturate", values: (settings.SAT / 100).toString(), result: "saturate_out" });
                            const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "saturate_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA).toString() })));
                            const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));
                            const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "tone_out", result: "final_out" });
                            colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                            filter.append(lumaContrast, saturation, gamma, toneCurve, colorTemp);
                        }
                        return filter;
                    };
                    svg.append(buildChain(combinedFilterId, true)); svg.append(buildChain(combinedFilterNoGrainId, false));
                    return { svgNode: svg, styleElement: style };
                }
                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const v = (val) => (val === undefined || val === null) ? 0 : Number(val);
                    const sig = [v(values.gamma), v(values.sharpenLevel), v(values.level2), v(values.colorTemp), v(values.saturation), v(values.shadows), v(values.highlights), v(values.brightness), v(values.contrastAdj), v(values.dither), v(values.clarity), values.autoExposure ? 1 : 0].join('|');
                    if (this._lastValues === sig) return; this._lastValues = sig;
                    const { saturation, gamma, sharpenLevel, level2, shadows, highlights, brightness, contrastAdj, colorTemp, dither, clarity } = values;
                    let currentToneTable = null; const contrastSafe = (contrastAdj == null) ? 1.0 : Number(contrastAdj);
                    const toneKey = (shadows !== undefined) ? `${(+shadows).toFixed(2)}_${(+highlights).toFixed(2)}_${(+brightness || 0).toFixed(2)}_${(+contrastSafe || 1).toFixed(3)}` : null;
                    if (toneKey) {
                        if (this._globalToneCache.key !== toneKey) {
                            const genSCurveTable = (sh, hi, br = 0, contrast = 1.0) => {
                                const steps = 256; const vals = []; const clamp = Utils.clamp; const smoothstep = (t) => t * t * (3 - 2 * t);
                                const shN = clamp((sh || 0) / 100, -1, 1); const hiN = clamp((hi || 0) / 100, -1, 1); const b = clamp((br || 0) / 100, -1, 1) * 0.12; const c = clamp(Number(contrast || 1.0), 0.8, 1.4);
                                const toe = clamp(0.20 + shN * 0.10, 0.05, 0.40); const shoulder = clamp(0.70 - hiN * 0.10, 0.55, 0.92); const toeStrength = 0.18 + 0.22 * Math.abs(shN); const shoulderStrength = 0.08 + 0.18 * Math.abs(hiN);
                                for (let i = 0; i < steps; i++) {
                                    let x = i / (steps - 1); let y = x; y = clamp(y + b, 0, 1); y = clamp(0.5 + (y - 0.5) * c, 0, 1);
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
                                blurFine: rootNode.querySelectorAll('[data-vsc-id="sharpen_blur_fine"]'), compFine: rootNode.querySelectorAll('[data-vsc-id="sharpen_comp_fine"]'), blurCoarse: rootNode.querySelectorAll('[data-vsc-id="sharpen_blur_coarse"]'), compCoarse: rootNode.querySelectorAll('[data-vsc-id="sharpen_comp_coarse"]'), saturate: rootNode.querySelectorAll('[data-vsc-id="saturate"]'),
                                gammaFuncs: rootNode.querySelectorAll('[data-vsc-id="gamma"] feFuncR, [data-vsc-id="gamma"] feFuncG, [data-vsc-id="gamma"] feFuncB'), toneCurveFuncs: rootNode.querySelectorAll('[data-vsc-id="tone_curve"] feFuncR, [data-vsc-id="tone_curve"] feFuncG, [data-vsc-id="tone_curve"] feFuncB'),
                                ctRed: rootNode.querySelectorAll('[data-vsc-id="ct_red"]'), ctGreen: rootNode.querySelectorAll('[data-vsc-id="ct_green"]'), ctBlue: rootNode.querySelectorAll('[data-vsc-id="ct_blue"]'), lumaContrastMatrix: rootNode.querySelectorAll('[data-vsc-id="luma_contrast_matrix"]'), clarityFuncs: rootNode.querySelectorAll('[data-vsc-id="clarity_func"]'), grainComp: rootNode.querySelector('[data-vsc-id="grain_comp"]'), appliedToneKey: null
                            }; this._elementCache.set(rootNode, cache);
                        }
                        if (clarity !== undefined && cache.clarityFuncs) {
                            let tableVal = this._clarityTableCache.get(clarity);
                            if (!tableVal) { const strength = clarity / 50; const steps = 64; const vals = []; for (let i = 0; i < steps; i++) { let x = i / (steps - 1); let smooth = x * x * (3 - 2 * x); let y = x * (1 - strength) + smooth * strength; vals.push(Math.round(y * 10000) / 10000); } tableVal = vals.join(' '); this._clarityTableCache.set(clarity, tableVal); }
                            cache.clarityFuncs.forEach(el => { Utils.setAttr(el, 'tableValues', tableVal); });
                        }
                        if (sharpenLevel !== undefined) {
                            let strCoarse = 0; let strFine = 0;
                            if (isImage) { strFine = Math.min(4.0, sharpenLevel * 0.12); strCoarse = 0; } else { strCoarse = Math.min(3.0, sharpenLevel * 0.05); strFine = (values.level2 !== undefined) ? Math.min(3.0, values.level2 * 0.06) : 0; }
                            const sCurve = (x) => x * x * (3 - 2 * x); const fineProgress = Math.min(1, strFine / 3.0); const fineSigma = 0.5 - (sCurve(fineProgress) * 0.3); const fineK = sCurve(fineProgress) * 3.5; const coarseProgress = Math.min(1, strCoarse / 3.0); const coarseSigma = 1.5 - (sCurve(coarseProgress) * 0.8); const coarseK = sCurve(coarseProgress) * 2.0; const safeFineK = Math.min(6.0, fineK); const safeCoarseK = Math.min(4.0, coarseK);
                            if (strFine <= 0.01) { cache.blurFine.forEach(el => Utils.setAttr(el, 'stdDeviation', "0")); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { cache.blurFine.forEach(el => Utils.setAttr(el, 'stdDeviation', fineSigma.toFixed(2))); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeFineK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeFineK).toFixed(3)); }); }
                            if (strCoarse <= 0.01) { cache.blurCoarse.forEach(el => Utils.setAttr(el, 'stdDeviation', "0")); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { cache.blurCoarse.forEach(el => Utils.setAttr(el, 'stdDeviation', coarseSigma.toFixed(2))); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeCoarseK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeCoarseK).toFixed(3)); }); }
                        }
                        if (dither !== undefined && cache.grainComp) { const val = dither / 100; const amount = val * 0.25; Utils.setAttr(cache.grainComp, 'k3', amount.toFixed(3)); }
                        if (saturation !== undefined && cache.saturate) cache.saturate.forEach(el => Utils.setAttr(el, 'values', (saturation / 100).toString()));
                        if (gamma !== undefined && cache.gammaFuncs) { const exp = (1 / gamma).toString(); cache.gammaFuncs.forEach(el => Utils.setAttr(el, 'exponent', exp)); }
                        if (currentToneTable && cache.toneCurveFuncs) { if (cache.appliedToneKey !== toneKey) { cache.appliedToneKey = toneKey; cache.toneCurveFuncs.forEach(el => Utils.setAttr(el, 'tableValues', currentToneTable)); } }
                        if (contrastSafe !== undefined && cache.lumaContrastMatrix) { const cAmount = (contrastSafe - 1.0) * 0.9; const r = 0.2126 * cAmount; const g = 0.7152 * cAmount; const b = 0.0722 * cAmount; const mVals = [1 + r, g, b, 0, 0, r, 1 + g, b, 0, 0, r, g, 1 + b, 0, 0, 0, 0, 0, 1, 0].join(' '); cache.lumaContrastMatrix.forEach(el => Utils.setAttr(el, 'values', mVals)); }
                        if (colorTemp !== undefined && cache.ctBlue && cache.ctRed && cache.ctGreen) { const t = colorTemp; const warm = Math.max(0, t); const cool = Math.max(0, -t); const rSlope = 1 + warm * 0.003 - cool * 0.005; const gSlope = 1 + warm * 0.002 - cool * 0.004; const bSlope = 1 - warm * 0.006 + cool * 0.000; const clamp = Utils.clamp; const rs = clamp(rSlope, 0.7, 1.3).toFixed(3); const gs = clamp(gSlope, 0.7, 1.3).toFixed(3); const bs = clamp(bSlope, 0.7, 1.3).toFixed(3); cache.ctRed.forEach(el => Utils.setAttr(el, 'slope', rs)); cache.ctGreen.forEach(el => Utils.setAttr(el, 'slope', gs)); cache.ctBlue.forEach(el => Utils.setAttr(el, 'slope', bs)); }
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
            let auto = this.lastAutoParams || { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 };
            if (!vf.autoExposure) { auto = { ...auto, gamma: 1.0, bright: 0, shadowsAdj: 0, highlightsAdj: 0 }; }
            
            const finalGamma = Utils.clamp(vf.gamma * (auto.gamma || 1.0), 0.6, 2.2);
            const finalBrightness = vf.brightness + (auto.bright || 0) + (auto.clarityComp || 0); const finalContrastAdj = vf.contrastAdj; const finalHighlights = vf.highlights + (auto.highlightsAdj || 0); const finalShadows = vf.shadows + (auto.shadowsAdj || 0);
            
            let autoSharpLevel2 = vf.level2; 
            if (vf.clarity > 0) { autoSharpLevel2 += Math.min(5, vf.clarity * 0.15); }
            if (VideoAnalyzer._highMotion) autoSharpLevel2 *= 0.7;

            const values = { saturation: vf.saturation, gamma: finalGamma, blur: 0, sharpenLevel: vf.level, level2: autoSharpLevel2, shadows: finalShadows, highlights: finalHighlights, brightness: finalBrightness, contrastAdj: finalContrastAdj, colorTemp: vf.colorTemp, dither: vf.dither, clarity: vf.clarity, autoExposure: vf.autoExposure, targetLuma: vf.targetLuma };
            this.filterManager.updateFilterValues(values); VideoAnalyzer.updateSettings({ autoExposure: vf.autoExposure, clarity: vf.clarity, targetLuma: vf.targetLuma });
            this.updateMediaFilterStates();
        }
        applyAllImageFilters() { if (this._imageRafId) return; this._imageRafId = requestAnimationFrame(() => { this._imageRafId = null; if (!this.imageFilterManager.isInitialized()) return; const active = this.stateManager.get('app.scriptActive'); const level = active ? this.stateManager.get('imageFilter.level') : 0; const colorTemp = active ? this.stateManager.get('imageFilter.colorTemp') : 0; const values = { sharpenLevel: level, colorTemp: colorTemp }; this.imageFilterManager.updateFilterValues(values); this.updateMediaFilterStates(); }); }
        updateMediaFilterStates() { if (this._mediaStateRafId) return; this._mediaStateRafId = requestAnimationFrame(() => { this._mediaStateRafId = null; this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO') this._updateVideoFilterState(media); }); this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); }); this.stateManager.get('media.activeIframes').forEach(iframe => { this._updateVideoFilterState(iframe); }); }); }
        
        _getFilterCheckTs(el) {
            if (!this._filterCheckMap) this._filterCheckMap = new WeakMap();
            return this._filterCheckMap.get(el) || 0;
        }
        _setFilterCheckTs(el, ts) {
            if (!this._filterCheckMap) this._filterCheckMap = new WeakMap();
            this._filterCheckMap.set(el, ts);
        }

        _updateVideoFilterState(video) {
            const scriptActive = this.stateManager.get('app.scriptActive'); const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.shadows !== 0 || vf.highlights !== 0 || vf.brightness !== 0 || Math.abs(vf.contrastAdj - 1.0) > 0.001 || vf.colorTemp !== 0 || vf.dither > 0 || vf.autoExposure > 0 || vf.clarity !== 0;
            const isVis = this.stateManager.get('media.visibilityMap').get(video); const isActive = scriptActive && isVis && shouldApply;

            if (isActive) {
                injectFiltersIntoContext(video, this.filterManager, this.stateManager);
                if (video.style.willChange !== 'filter, transform') video.style.willChange = 'filter, transform';
            } else {
                if (video.style.willChange) video.style.willChange = '';
            }

            const filterId = this.filterManager._options.settings.SHARPEN_ID + '_combined_filter';
            const filterCss = `url("#${filterId}")`;

            if (isActive) {
                video.classList.add('vsc-video-filter-active');
                
                requestAnimationFrame(() => {
                    const now = performance.now();
                    const last = this._getFilterCheckTs(video);
                    if (now - last < 1200) return; 
                    this._setFilterCheckTs(video, now);

                    const cs = window.getComputedStyle(video);
                    const currentFilter = (cs.filter || '') + (cs.webkitFilter || '');
                    if (!currentFilter.includes(filterId)) {
                        this.setInlineFilter(video, filterCss);
                    } else {
                        this.restoreInlineFilter(video);
                    }
                });
            } else {
                video.classList.remove('vsc-video-filter-active');
                this.restoreInlineFilter(video);
            }

            if (vf.dither === 0) video.classList.add('no-grain');
            else video.classList.remove('no-grain');
        }
        _updateImageFilterState(image) {
            const scriptActive = this.stateManager.get('app.scriptActive'); if (!scriptActive) { image.classList.remove('vsc-image-filter-active'); return; }
            const level = this.stateManager.get('imageFilter.level'); const colorTemp = this.stateManager.get('imageFilter.colorTemp');
            const shouldApply = level > 0 || colorTemp !== 0; const isVis = this.stateManager.get('media.visibilityMap').get(image); const isActive = isVis && shouldApply;

            if (isActive) injectFiltersIntoContext(image, this.imageFilterManager, this.stateManager);

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
        setPlaybackRate(rate) {
            this.stateManager.get('media.activeMedia').forEach(media => {
                if (media.tagName !== 'VIDEO') return;
                if (Math.abs((media.playbackRate || 1) - rate) < 0.01) return;
                try { media.playbackRate = rate; } catch { }
            });
        }
    }

    class UIPlugin extends Plugin {
        constructor() { super('UI'); this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null; this.hostElement = null; this.shadowRoot = null; this.isDragging = false; this.wasDragged = false; this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 }; this.animationFrameId = null; this.speedButtons = []; this.uiElements = {}; this.uiState = { x: 0, y: 0 }; this.boundFullscreenChange = null; this.boundSmartLimitUpdate = null; this.delta = { x: 0, y: 0 }; this.toastEl = null; this.pressTimer = null; this._longPressTriggered = false; }
        init(stateManager) {
            super.init(stateManager);

            const createUI = () => { if (this.globalContainer) return; this.createGlobalUI(); this.stateManager.set('ui.globalContainer', this.globalContainer); this.stateManager.set('ui.createRequested', false); };
            const onCreateRequested = () => { if (document.body) createUI(); else document.addEventListener('DOMContentLoaded', createUI, { once: true }); };
            this.subscribe('ui.createRequested', (req) => { if (req) onCreateRequested(); }); if (this.stateManager.get('ui.createRequested')) onCreateRequested();
            this.subscribe('ui.areControlsVisible', isVisible => this.onControlsVisibilityChange(isVisible));
            this.subscribe('media.activeMedia', () => this.updateUIVisibility());
            this.subscribe('media.activeImages', () => this.updateUIVisibility());
            this.subscribe('media.activeIframes', () => this.updateUIVisibility());
            this.subscribe('playback.currentRate', rate => {
                this.updateActiveSpeedButton(rate);
                this.showToast(`${rate.toFixed(2)}x`);
            });
            this.subscribe('ui.warningMessage', msg => this.showToast(msg));
            this.subscribe('ui.areControlsVisible', () => { this.updateTriggerStyle(); });
            this.subscribe('app.scriptActive', () => this.updateTriggerStyle());
            const vscMessage = sessionStorage.getItem('vsc_message'); if (vscMessage) { this.showToast(vscMessage); sessionStorage.removeItem('vsc_message'); }
            this.boundFullscreenChange = () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } };
            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
            const savedPos = sessionStorage.getItem('vsc_ui_pos'); if (savedPos) { try { const p = JSON.parse(savedPos); this.uiState = p; } catch { } }
        }
        destroy() { super.destroy(); if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; } if (this.boundFullscreenChange) document.removeEventListener('fullscreenchange', this.boundFullscreenChange); if (this.boundSmartLimitUpdate) document.removeEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate); }

        getStyles() {
            if (this._cachedStyles) return this._cachedStyles;
            const isMobile = this.stateManager.get('app.isMobile');
            this._cachedStyles = `
                :host { font-family: sans-serif; --vsc-bg-dark: rgba(0,0,0,0.7); --vsc-bg-btn: rgba(0,0,0,0.5); --vsc-bg-accent: rgba(52, 152, 219, 0.7); --vsc-bg-warn: rgba(231, 76, 60, 0.9); --vsc-bg-active: rgba(76, 209, 55, 0.4); --vsc-text: white; --vsc-text-accent: #f39c12; --vsc-text-active: #4cd137; --vsc-border: #555; }
                * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; } .vsc-hidden { display: none !important; }
                #vsc-main-container { display: flex; flex-direction: row-reverse; align-items: flex-start; } #vsc-controls-container { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
                .vsc-control-group { display: flex; align-items: center; justify-content: flex-end; position: relative; background: var(--vsc-bg-dark); border-radius: 8px; height: clamp(${isMobile ? '30px' : '32px'}, 6vmin, ${isMobile ? '40px' : '44px'}); width: clamp(${isMobile ? '30px' : '32px'}, 6vmin, ${isMobile ? '40px' : '44px'}); }
                .vsc-btn { background: var(--vsc-bg-btn); color: var(--vsc-text); border-radius: 4px; border: none; padding: 6px 8px; cursor: pointer; white-space: nowrap; font-size: ${isMobile ? '13px' : '14px'}; transition: all 0.2s ease; }
                .vsc-btn:hover { background: rgba(255,255,255,0.2); } .vsc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
                .vsc-btn.active, .vsc-btn.vsc-speed-active { box-shadow: 0 0 5px #3498db, 0 0 10px #3498db inset; border-color: #3498db; }
                .vsc-btn.vsc-speed-active { background: var(--vsc-bg-warn) !important; box-shadow: 0 0 5px #e74c3c, 0 0 10px #e74c3c inset !important; border-color: #e74c3c; }
                .vsc-btn-main { width: 100%; height: 100%; padding: 0; background: none; font-size: ${isMobile ? '18px' : '20px'}; display: flex; align-items: center; justify-content: center; }
                .vsc-top-row { display: flex; gap: 8px; width: 100%; margin-bottom: 8px; flex-wrap: wrap; } .vsc-top-row .vsc-btn { flex: 1; } .vsc-btn-lg { font-size: ${isMobile ? '13px' : '14px'} !important; font-weight: bold; height: 36px; }
                .vsc-submenu { display: none; flex-direction: column; position: fixed; top: 50%; transform: translateY(-50%); right: 100px; background: rgba(0,0,0,0.95); border-radius: 8px; padding: 10px; gap: 6px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
                .vsc-control-group.submenu-visible .vsc-submenu { display: flex; } #vsc-video-controls .vsc-submenu { width: ${isMobile ? 'min(420px, 94vw)' : '340px'}; } #vsc-image-controls .vsc-submenu { width: 280px; }
                .vsc-align-grid { display: grid; grid-template-columns: 40px repeat(6, 1fr); gap: 4px; align-items: center; width: 100%; margin-bottom: 8px; border-bottom: 1px solid var(--vsc-border); padding-bottom: 8px; } .vsc-align-grid .vsc-label { grid-column: 1; text-align: right; margin-right: 5px; color: var(--vsc-text); font-weight: bold; font-size: 13px; }
                .vsc-col { display: flex; flex-direction: column; gap: 6px; width: 100%; margin-bottom: 10px; border-bottom: 1px solid var(--vsc-border); padding-bottom: 6px; } .vsc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; width: 100%; } .vsc-hr { height: 1px; background: var(--vsc-border); width: 100%; margin: 4px 0; }
                .slider-control { display: flex; flex-direction: column; gap: 4px; } .slider-control label { display: flex; justify-content: space-between; font-size: ${isMobile ? '13px' : '14px'}; color: var(--vsc-text); } input[type=range] { width: 100%; margin: 0; cursor: pointer; }
                .vsc-monitor { font-size: 11px; color: #aaa; margin-top: 5px; text-align: center; border-top: 1px solid #444; padding-top: 3px; } .vsc-monitor.warn { color: #e74c3c; font-weight: bold; }
                /* UI styles moved to CSS */
                .vsc-trigger { width: ${isMobile ? '42px' : '48px'}; height: ${isMobile ? '42px' : '48px'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: ${isMobile ? '22px' : '24px'}; user-select: none; touch-action: none; order: 1; transition: background 0.3s; }
                .vsc-rescan { width: 34px; height: 34px; background: var(--vsc-bg-btn); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; margin-top: 5px; order: 3; }
                #vsc-global-container { position: fixed; top: 50%; right: 1vmin; z-index: ${CONFIG.UI.MAX_Z}; transform: translateY(-50%) translate(var(--vsc-translate-x, 0), var(--vsc-translate-y, 0)); display: flex; align-items: flex-start; gap: 5px; }
            `;
            return this._cachedStyles;
        }

        showToast(msg) {
            if (!msg) return;
            if (!this.toastEl && document.body) {
                this.toastEl = document.createElement('div');
                Object.assign(this.toastEl.style, { position: 'fixed', bottom: '15%', left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.7)', color: 'white', padding: '8px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold', pointerEvents: 'none', opacity: '0', transition: 'opacity 0.3s', zIndex: CONFIG.UI.MAX_Z });
                document.body.appendChild(this.toastEl);
            }
            if (this.toastEl) {
                this.toastEl.textContent = msg; this.toastEl.style.opacity = '1'; clearTimeout(this._toastTimer); this._toastTimer = setTimeout(() => { this.toastEl.style.opacity = '0'; }, 1500);
            }
        }

        createGlobalUI() {
            const isMobile = this.stateManager.get('app.isMobile');
            this.globalContainer = document.createElement('div');
            this.globalContainer.id = 'vsc-global-container'; // Use ID for CSS styling
            this.globalContainer.setAttribute('data-vsc-internal', '1');
            const tx = this.uiState.x || 0; const ty = this.uiState.y || 0;
            this.globalContainer.style.setProperty('--vsc-translate-x', `${tx}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${ty}px`);
            
            const vars = { '--vsc-bg-dark': 'rgba(0,0,0,0.7)', '--vsc-bg-btn': 'rgba(0,0,0,0.5)', '--vsc-bg-accent': 'rgba(52, 152, 219, 0.7)', '--vsc-bg-warn': 'rgba(231, 76, 60, 0.9)', '--vsc-bg-active': 'rgba(76, 209, 55, 0.4)', '--vsc-text': 'white', '--vsc-text-accent': '#f39c12', '--vsc-text-active': '#4cd137', '--vsc-border': '#555' };
            for (const [k, v] of Object.entries(vars)) this.globalContainer.style.setProperty(k, v);
            
            this.mainControlsContainer = document.createElement('div'); this.mainControlsContainer.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:5px;';
            this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡';
            this.triggerElement.className = 'vsc-trigger';

            this.triggerElement.addEventListener('click', (e) => {
                if (this.wasDragged || this._longPressTriggered) {
                    e.stopPropagation(); e.preventDefault();
                    this._longPressTriggered = false;
                    return;
                }
                const isVisible = this.stateManager.get('ui.areControlsVisible');
                triggerBurstScan();
                if (isVisible) {
                    this.stateManager.set('ui.areControlsVisible', false);
                } else {
                    this.stateManager.set('app.scriptActive', true);
                    this.stateManager.set('ui.areControlsVisible', true);
                    const ensureMediaSoon = (count) => {
                        const sm = this.stateManager;
                        if (!sm.get('app.scriptActive')) return;
                        const hasMediaState = sm.get('media.activeMedia').size > 0 || sm.get('media.activeImages').size > 0 || sm.get('media.activeIframes').size > 0;
                        const hasMediaDom = !!document.querySelector('video, iframe') || hasRealVideoCached();
                        if (hasMediaState || hasMediaDom) return;
                        if (count > 0) {
                            triggerBurstScan(250);
                            setTimeout(() => ensureMediaSoon(count - 1), 900);
                        } else {
                            this.showToast('미디어를 아직 못 찾았어요 (로딩 지연/iframe/CORS일 수 있음)');
                        }
                    };
                    setTimeout(() => ensureMediaSoon(10), 500);
                }
            });

            const rescanTrigger = document.createElement('div'); rescanTrigger.textContent = '↻';
            rescanTrigger.className = 'vsc-rescan';
            rescanTrigger.addEventListener('click', () => { if (window.vscPluginManager) { const core = window.vscPluginManager.plugins.find(p => p.name === 'CoreMedia'); if(core) { core.resetScanInterval(); core.scanAndApply(); } } });
            this.speedButtonsContainer = document.createElement('div'); this.speedButtonsContainer.id = 'vsc-speed-buttons-container'; this.speedButtonsContainer.style.cssText = 'display:none; flex-direction:column; gap:5px;';
            this.attachDragAndDrop();
            this.mainControlsContainer.append(this.triggerElement, rescanTrigger);
            this.globalContainer.append(this.mainControlsContainer, this.speedButtonsContainer);
            document.body.appendChild(this.globalContainer);
            CONFIG.UI.SPEED_PRESETS.forEach(speed => {
                const btn = document.createElement('button'); btn.textContent = `${speed.toFixed(1)}x`; btn.dataset.speed = speed; btn.className = 'vsc-btn';
                Object.assign(btn.style, { background: 'var(--vsc-bg-accent)', width: isMobile ? '42px' : '46px', height: isMobile ? '32px' : '36px', fontSize: isMobile ? '13px' : '14px' });
                btn.onclick = () => this.stateManager.set('playback.targetRate', speed);
                this.speedButtonsContainer.appendChild(btn); this.speedButtons.push(btn);
            });

            const globalStyle = document.createElement('style');
            globalStyle.textContent = this.getStyles().replace(':host', '#vsc-global-container, #vsc-ui-host');
            document.head.appendChild(globalStyle);

            this.startBootGate();
        }

        startBootGate() {
            this.globalContainer.style.display = 'none';
            let checks = 0;
            const check = () => {
                checks++;
                const hasMedia = this.stateManager.get('media.activeMedia').size > 0 ||
                                 this.stateManager.get('media.activeIframes').size > 0 ||
                                 hasRealVideoCached();

                if (hasMedia) {
                    this.globalContainer.style.display = 'flex';
                } else if (checks < 30) {
                     setTimeout(check, 500);
                } else {
                    this.globalContainer.style.display = 'none';
                }
            };
            check();
        }

        updateTriggerStyle() {
            if (!this.triggerElement) return;
            const isVisible = this.stateManager.get('ui.areControlsVisible');
            if (isVisible) {
                this.triggerElement.textContent = '🛑';
                this.triggerElement.style.backgroundColor = 'rgba(231, 76, 60, 0.9)';
            } else {
                this.triggerElement.textContent = '⚡';
                this.triggerElement.style.backgroundColor = 'var(--vsc-bg-btn)';
            }
        }

        onControlsVisibilityChange(isVisible) {
            if (isVisible) {
                if (!this.globalContainer || !this.mainControlsContainer) { if (document.body) { this.createGlobalUI(); } else { this.stateManager.set('ui.createRequested', true); return; } }
                if (!this.hostElement && this.mainControlsContainer) { this.createControlsHost(); }
            }
            if (this.hostElement) { this.hostElement.style.display = isVisible ? 'flex' : 'none'; }
            if (this.speedButtonsContainer) {
                const hasVideo =
                    [...this.stateManager.get('media.activeMedia')].some(m => m && m.tagName === 'VIDEO') ||
                    !!document.querySelector('video, iframe') ||
                    hasRealVideoCached();

                this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none';
            }
            this.updateUIVisibility();
        }
        updateUIVisibility() {
            if (this.stateManager.get('ui.hideUntilReload')) {
                if (this.globalContainer) this.globalContainer.style.display = 'none';
                return;
            }

            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            const activeMedia = this.stateManager.get('media.activeMedia') || new Set(); const activeImages = this.stateManager.get('media.activeImages') || new Set(); const activeIframes = this.stateManager.get('media.activeIframes') || new Set();
            const hasLocalVideo = [...activeMedia].some(m => m && m.tagName === 'VIDEO'); const hasLocalImage = activeImages.size > 0; const hasIframe = activeIframes.size > 0;
            const hasDomVideo = !!document.querySelector('video, iframe') || hasRealVideoCached();
            const hasAnyVideo = hasLocalVideo || hasIframe || hasDomVideo;
            const hasAny = hasAnyVideo || hasLocalImage;

            if (this.globalContainer) {
                if (controlsVisible || hasAny) {
                    this.globalContainer.style.display = 'flex';
                }
            }
            if (this.speedButtonsContainer) { this.speedButtonsContainer.style.display = controlsVisible && hasAnyVideo ? 'flex' : 'none'; }
            if (!this.shadowRoot) return;
            const setVisible = (element, visible) => { if (element) element.classList.toggle(CONFIG.UI.HIDDEN_CLASS, !visible); };
            setVisible(this.uiElements.videoControls, hasAnyVideo); setVisible(this.uiElements.imageControls, hasLocalImage);
        }
        updateActiveSpeedButton(rate) {
            if (this.speedButtons.length === 0) return;
            this.speedButtons.forEach(b => {
                const speed = parseFloat(b.dataset.speed);
                if (speed) {
                    const isActive = Math.abs(speed - rate) < 0.01;
                    b.classList.toggle('vsc-speed-active', isActive);
                    if(!isActive) b.style.background = 'var(--vsc-bg-accent)';
                }
            });
        }
        createControlsHost() {
            if (!this.mainControlsContainer) return;
            this.hostElement = document.createElement('div'); this.hostElement.style.order = '2'; this.hostElement.id = 'vsc-ui-host';
            this.stateManager.set('ui.hostElement', this.hostElement);
            this.shadowRoot = this.hostElement.attachShadow({ mode: 'open' });
            this.stateManager.set('ui.shadowRoot', this.shadowRoot);
            const styleEl = document.createElement('style');
            styleEl.textContent = this.getStyles();
            this.shadowRoot.appendChild(styleEl); this.renderAllControls(); this.mainControlsContainer.prepend(this.hostElement);
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
            slider.oninput = () => {
                const val = parseFloat(slider.value); updateText(val);
                if (stateKey.startsWith('videoFilter.')) { VideoAnalyzer._userBoostUntil = performance.now() + 500; if (stateKey.includes('level') || stateKey.includes('level2')) this.stateManager.set('videoFilter.activeSharpPreset', 'custom'); }
                if (stateKey === 'videoFilter.targetLuma') { triggerBurstScan(); }
                this.showToast(`${label}: ${formatFn ? formatFn(val) : val + unit}`);
                debouncedSetState(val);
            };
            this.subscribe(stateKey, (val) => { updateText(val); if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; } });
            updateText(slider.value); div.append(labelEl, slider); return { control: div, slider: slider };
        }
        _buildVideoMenu(container) {
            const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', container);
            const topRow = document.createElement('div'); topRow.className = 'vsc-top-row';
            const createToggle = (label, key) => {
                const btn = document.createElement('button'); btn.className = 'vsc-btn vsc-btn-lg'; btn.textContent = label;
                const render = (v) => { btn.classList.toggle('active', !!v); };
                btn.onclick = () => this.stateManager.set(key, !this.stateManager.get(key)); this.subscribe(key, render); render(this.stateManager.get(key)); return btn;
            };
            const powerBtn = document.createElement('button'); powerBtn.className = 'vsc-btn vsc-btn-lg'; powerBtn.textContent = '⏸︎'; powerBtn.title = '전체 기능 끄기';
            Object.assign(powerBtn.style, { width: '40px', flex: '0 0 40px', color: '#e74c3c' });
            powerBtn.onclick = () => { this.stateManager.set('app.scriptActive', false); this.stateManager.set('ui.areControlsVisible', false); this.showToast('Script OFF'); };
            topRow.append(powerBtn); topRow.append(createToggle('📸 자동', 'videoFilter.autoExposure'));
            
            // Audio Toggle
            topRow.append(createToggle('🔊 부스트', 'audio.enabled'));

            const videoResetBtn = document.createElement('button'); videoResetBtn.className = 'vsc-btn vsc-btn-lg'; videoResetBtn.textContent = '↺'; videoResetBtn.title = '필터 초기화';
            Object.assign(videoResetBtn.style, { width: '40px', flex: '0 0 40px' });
            videoResetBtn.onclick = () => { this.stateManager.batchSet('videoFilter', { activeSharpPreset: 'none', level: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, level2: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL2, clarity: 0, autoExposure: false, targetLuma: 0, highlights: 0, shadows: 0, gamma: 1.0, saturation: 100, contrastAdj: 1.0, dither: 0, colorTemp: 0 }); };
            topRow.append(videoResetBtn);
            const gridTable = document.createElement('div'); gridTable.className = 'vsc-align-grid';
            const PRESET_CONFIG = [{ type: 'sharp', label: '샤프', items: [{ txt: 'S', key: 'sharpS', l1: 8, l2: 3 }, { txt: 'M', key: 'sharpM', l1: 15, l2: 6 }, { txt: 'L', key: 'sharpL', l1: 25, l2: 10 }, { txt: '끔', key: 'sharpOFF', l1: 0, l2: 0 }] }, { type: 'ev', label: '노출', items: [-10, -5, 0, 5, 10, 15].map(v => ({ txt: (v > 0 ? '+' : '') + v, val: v })) }];
            PRESET_CONFIG.forEach(cfg => {
                const label = document.createElement('div'); label.className = 'vsc-label'; label.textContent = cfg.label; gridTable.appendChild(label);
                if (cfg.type === 'sharp') {
                    cfg.items.forEach(it => {
                        const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = it.txt; b.dataset.presetKey = it.key;
                        b.onclick = () => { this.stateManager.batchSet('videoFilter', { level: it.l1, level2: it.l2, activeSharpPreset: it.key }); };
                        gridTable.appendChild(b);
                    });
                    const updateSharp = (k) => { gridTable.querySelectorAll(`button[data-preset-key]`).forEach(b => b.classList.toggle('active', b.dataset.presetKey === k)); };
                    this.subscribe('videoFilter.activeSharpPreset', updateSharp); updateSharp(this.stateManager.get('videoFilter.activeSharpPreset'));
                    gridTable.append(document.createElement('div'), document.createElement('div'));
                } else if (cfg.type === 'ev') {
                    cfg.items.forEach(it => {
                        const b = document.createElement('button'); b.className = 'vsc-btn'; b.textContent = it.txt; b.dataset.evVal = it.val;
                        b.onclick = () => { this.stateManager.batchSet('videoFilter', { targetLuma: it.val, autoExposure: true }); triggerBurstScan(); }; gridTable.appendChild(b);
                    });
                    const updateEv = () => { const ae = this.stateManager.get('videoFilter.autoExposure'); const tv = this.stateManager.get('videoFilter.targetLuma'); gridTable.querySelectorAll(`button[data-ev-val]`).forEach(b => { const m = ae && (parseInt(b.dataset.evVal) === tv); b.classList.toggle('active', m); }); };
                    this.subscribe('videoFilter.targetLuma', updateEv); this.subscribe('videoFilter.autoExposure', updateEv); updateEv();
                }
            });
            videoSubMenu.append(topRow, document.createElement('div'), gridTable);
            const SLIDER_CONFIG = [{ label: '노출 보정 (EV)', id: 'v-target', min: -30, max: 30, step: 1, key: 'videoFilter.targetLuma', unit: '', fmt: v => `${v > 0 ? '+' : ''}${v}` }, { label: '샤프(윤곽)', id: 'v-sh1', min: 0, max: 50, step: 1, key: 'videoFilter.level', unit: '단계', fmt: v => v.toFixed(0) }, { label: '샤프(디테일)', id: 'v-sh2', min: 0, max: 50, step: 1, key: 'videoFilter.level2', unit: '단계', fmt: v => v.toFixed(0) }, { label: '명료도', id: 'v-cl', min: 0, max: 50, step: 1, key: 'videoFilter.clarity', unit: '', fmt: v => v.toFixed(0) }, { label: '색온도', id: 'v-ct', min: -25, max: 25, step: 1, key: 'videoFilter.colorTemp', unit: '', fmt: v => v.toFixed(0) }, { label: '그레인', id: 'v-dt', min: 0, max: 100, step: 5, key: 'videoFilter.dither', unit: '', fmt: v => v.toFixed(0) }];
            videoSubMenu.appendChild(this._createSlider(SLIDER_CONFIG[0].label, SLIDER_CONFIG[0].id, SLIDER_CONFIG[0].min, SLIDER_CONFIG[0].max, SLIDER_CONFIG[0].step, SLIDER_CONFIG[0].key, SLIDER_CONFIG[0].unit, SLIDER_CONFIG[0].fmt).control);
            
            const grid = document.createElement('div'); grid.className = 'vsc-grid';
            SLIDER_CONFIG.slice(1).forEach(cfg => { grid.appendChild(this._createSlider(cfg.label, cfg.id, cfg.min, cfg.max, cfg.step, cfg.key, cfg.unit, cfg.fmt).control); });
            videoSubMenu.appendChild(grid); return videoSubMenu;
        }
        renderAllControls() {
            if (this.shadowRoot.querySelector('#vsc-main-container')) return;
            const main = document.createElement('div'); main.id = 'vsc-main-container';
            const controls = document.createElement('div'); controls.id = 'vsc-controls-container';
            const videoMenu = this._buildVideoMenu(controls);
            const monitor = document.createElement('div'); monitor.className = 'vsc-monitor'; monitor.textContent = 'Monitoring Off'; videoMenu.appendChild(monitor);
            this.boundSmartLimitUpdate = (e) => {
                if (!videoMenu.parentElement.classList.contains('submenu-visible')) return;
                const { autoParams, tainted } = e.detail;
                if (tainted) { monitor.textContent = '🔒 보안(CORS) 제한됨'; monitor.classList.add('warn'); }
                else { monitor.textContent = `Gamma: ${autoParams.gamma.toFixed(2)} | Bright: ${autoParams.bright.toFixed(0)}`; monitor.classList.remove('warn'); }
            };
            document.addEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);
            const imgMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controls);
            imgMenu.append(this._createSlider('샤프닝', 'i-sh', 0, 20, 1, 'imageFilter.level', '단계', v => v.toFixed(0)).control, this._createSlider('색온도', 'i-ct', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control);
            main.appendChild(controls); this.shadowRoot.appendChild(main);
        }
        attachDragAndDrop() {
            let lastDragEnd = 0;
            const onDragStart = (e) => {
                if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
                this.isDragging = true; this.wasDragged = false;
                this._longPressTriggered = false;
                this.delta = { x: 0, y: 0 }; this.startPos = { x: e.clientX, y: e.clientY };
                this.currentPos = { x: this.uiState.x, y: this.uiState.y };
                this.globalContainer.style.transition = 'none';
                try { this.triggerElement.setPointerCapture(e.pointerId); } catch(err){}
                this.triggerElement.addEventListener('pointermove', onDragMove);
                this.triggerElement.addEventListener('pointerup', onDragEnd);
                this.triggerElement.addEventListener('pointercancel', onDragEnd);

                if (this.pressTimer) clearTimeout(this.pressTimer);
                this.pressTimer = setTimeout(() => {
                    if (!this.wasDragged) {
                        this._longPressTriggered = true;
                        this.stateManager.set('ui.areControlsVisible', false);
                        this.stateManager.set('app.scriptActive', false);
                        this.stateManager.set('ui.hideUntilReload', true);
                        this.globalContainer.style.display = 'none';
                    }
                }, 1000);
            };
            const updatePosition = () => { if (!this.isDragging || !this.globalContainer) return; const newX = this.currentPos.x + this.delta.x; const newY = this.currentPos.y + this.delta.y; this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`); this.animationFrameId = null; };
            const onDragMove = (e) => {
                if (!this.isDragging) return;
                this.delta = { x: e.clientX - this.startPos.x, y: e.clientY - this.startPos.y };
                if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI.DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI.DRAG_THRESHOLD)) {
                    this.wasDragged = true;
                    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
                }
                if (this.wasDragged && this.animationFrameId === null) { this.animationFrameId = requestAnimationFrame(updatePosition); }
            };
            const onDragEnd = (e) => {
                if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
                if (!this.isDragging) return;
                if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; }
                const dx = this.delta?.x || 0; const dy = this.delta?.y || 0;
                if (this.wasDragged) {
                    this.uiState.x += dx; this.uiState.y += dy;
                    try { sessionStorage.setItem('vsc_ui_pos', JSON.stringify(this.uiState)); } catch { }
                    lastDragEnd = Date.now();
                }
                this.isDragging = false; this.globalContainer.style.transition = '';
                this.triggerElement.removeEventListener('pointermove', onDragMove);
                this.triggerElement.removeEventListener('pointerup', onDragEnd);
                this.triggerElement.removeEventListener('pointercancel', onDragEnd);
                try { this.triggerElement.releasePointerCapture(e.pointerId); } catch(err){}
                setTimeout(() => { this.wasDragged = false; }, 50);
            };
            this.triggerElement.addEventListener('pointerdown', onDragStart);
            this.triggerElement.addEventListener('click', (e) => { if (Date.now() - lastDragEnd < 400 || this._longPressTriggered) { e.stopPropagation(); e.preventDefault(); } }, { capture: true });
        }
    }

    function main() {
        if (window.__VSC_ENGINE_STARTED) return;
        window.__VSC_ENGINE_STARTED = true;
        const stateManager = new StateManager();
        const pluginManager = new PluginManager(stateManager);
        window.vscPluginManager = pluginManager;
        pluginManager.register(new UIPlugin());
        pluginManager.register(new CoreMediaPlugin());
        pluginManager.register(new SvgFilterPlugin());
        pluginManager.register(new PlaybackControlPlugin());
        pluginManager.register(new AudioController());
        pluginManager.initAll();
    }

    main();
})();
