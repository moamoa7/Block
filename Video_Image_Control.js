// ==UserScript==
// @name        Video_Image_Control (v132.0.46 Optimized)
// @namespace   https://com/
// @version     132.0.46
// @description v132.0.46: Removed global hooking (Stable), Smart Low-Key/Subtitle AE logic, Refined small player detection.
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
    if (window.__VSC_ENGINE_STARTED) return;
    
    const IS_TOP = window === window.top;
    let _corePluginRef = null;

    // 2. Constants & Configuration
    const VSC_INSTANCE_ID = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
    const VSC_AUDIO_SRC = Symbol('vsc_audio_src');
    const VSC_PINNED = { el: null, until: 0 };

    const MEDIA_EVENTS = ['play', 'playing', 'pause', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'emptied', 'ratechange', 'durationchange'];
    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_HIGH_END = DEVICE_RAM >= 8;
    const IS_LOW_END = DEVICE_RAM < 4;
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_DATA_SAVER = navigator.connection && (navigator.connection.saveData || navigator.connection.effectiveType === '2g');

    const DEFAULT_SETTINGS = { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 };

    // [v46] Intelligent "Minimal Intervention" AE Constants
    const MIN_AE = {
        STRENGTH: IS_MOBILE ? 0.28 : 0.30,
        STRENGTH_DARK: IS_MOBILE ? 0.30 : 0.32,
        MID_OK_MIN: IS_MOBILE ? 0.14 : 0.16,
        MID_OK_MAX: 1.0,
        P98_CLIP: 0.985,
        CLIP_FRAC_LIMIT: 0.004, 
        MAX_UP_EV: IS_MOBILE ? 0.14 : 0.18,      
        MAX_UP_EV_DARK: IS_MOBILE ? 0.24 : 0.33, // [v46] Boosted for PC Dark scenes
        MAX_DOWN_EV: 0,
        DEAD_OUT: 0.08,
        DEAD_IN: 0.04,
        // [v46] Low-Key Protection Thresholds
        LOWKEY_STDDEV: IS_MOBILE ? 0.20 : 0.22,
        LOWKEY_P10: 0.10
    };

    const CONFIG = {
        DEBUG: false,
        FLAGS: { GLOBAL_ATTR_OBS: true },
        FILTER: {
            VIDEO_DEFAULT_LEVEL: 0, VIDEO_DEFAULT_LEVEL2: 0, IMAGE_DEFAULT_LEVEL: 15,
            DEFAULT_AUTO_EXPOSURE: false, DEFAULT_CLARITY: 0,
            DEFAULT_BRIGHTNESS: 0, DEFAULT_CONTRAST: 1.0,
            SETTINGS: DEFAULT_SETTINGS,
            IMAGE_SETTINGS: { GAMMA: 1.00, SHARPEN_ID: 'ImageSharpenDynamic', SAT: 100, TEMP: 0 },
        },
        AUDIO: { THRESHOLD: -50, KNEE: 40, RATIO: 12, ATTACK: 0, RELEASE: 0.25 },
        SCAN: {
            INTERVAL_TOP: 5000, INTERVAL_IFRAME: 2000, INTERVAL_MAX: 15000, INTERVAL_IDLE: 15000,
            MAX_DEPTH: IS_HIGH_END ? 8 : (IS_LOW_END ? 4 : 6),
            MUTATION_ATTRS: ['src', 'srcset', 'poster', 'data-src', 'data-srcset', 'data-url', 'data-original', 'data-video-src', 'data-poster', 'type', 'loading', 'data-lazy-src', 'data-lazy', 'data-bg', 'data-background', 'aria-src', 'data-file', 'data-mp4', 'data-hls', 'data-stream', 'data-video', 'data-video-url', 'data-stream-url', 'data-player-src', 'data-m3u8', 'data-mpd']
        },
        UI: { MAX_Z: 2147483647, DRAG_THRESHOLD: 5, HIDDEN_CLASS: 'vsc-hidden', SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2] }
    };

    const SEL = { FILTER_TARGET: 'video, img, iframe, canvas' };

    const Utils = {
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        safeInt: (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
        fastHash: (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); },
        setAttr: (el, name, val) => { if (!el) return; if (val == null) { if (el.hasAttribute(name)) el.removeAttribute(name); return; } const s = String(val); if (el.getAttribute(name) !== s) el.setAttribute(name, s); },
        isShadowRoot: (n) => !!n && n.nodeType === 11 && !!n.host,
        safeGetItem: (k) => { try { return localStorage.getItem(k); } catch(e) { return null; } },
        safeSetItem: (k, v) => { try { localStorage.setItem(k, v); } catch(e) {} },
        safeRemoveItem: (k) => { try { localStorage.removeItem(k); } catch(e) {} },
        median5: (a) => {
            const b = a.slice();
            b.sort((x,y) => x - y);
            return b[Math.floor(b.length/2)] || 0;
        },
        getByTag: (root, tag) => {
            if (!root) return [];
            if (root.getElementsByTagName) return root.getElementsByTagName(tag);
            if (root.querySelectorAll) return root.querySelectorAll(tag);
            return [];
        }
    };

    const safeGuard = (fn, label = '') => { try { return fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; };
    const throttle = (fn, limit) => { let inThrottle; return function (...args) { if (!inThrottle) { fn.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; };
    const rIC = window.requestIdleCallback || (cb => setTimeout(() => cb({ timeRemaining: () => 1, didTimeout: true }), 1));
    const scheduleWork = (cb) => rIC((d) => { try { cb(d); } catch (e) { if (CONFIG.DEBUG) console.error(e); } }, { timeout: 1000 });

    const P = (signal) => ({ passive: true, signal });
    const CP = (signal) => ({ capture: true, passive: true, signal });
    const on = (target, type, listener, options) => { try { target.addEventListener(type, listener, options); } catch(e){} };

    const WORKER_CODE = `
        const hist = new Uint16Array(256);
        self.onmessage = function(e) {
            const { fid, vid, buf, width, type, step } = e.data;
            if (type === 'analyze') {
                let data = null;
                if (buf) { try { data = new Uint8ClampedArray(buf); } catch(e) {} } else if (e.data.data) { try { data = new Uint8ClampedArray(e.data.data); } catch(e) {} }
                if (!data) return;
                hist.fill(0);
                const size = width;

                let validCount = 0;
                let sumR = 0, sumG = 0, sumB = 0;
                let sumLuma = 0;
                let sumLumaSq = 0;

                let topLuma = 0, botLuma = 0;
                const checkRow = (sy, ey) => {
                    let s = 0, c = 0;
                    for(let y=sy; y<ey; y+=step) {
                        for(let x=0; x<size; x+=step) {
                             const i = (y*size+x)*4;
                             s += (data[i]*54+data[i+1]*183+data[i+2]*19)>>8; c++;
                        }
                    }
                    return c > 0 ? s/c : 0;
                };

                const barH = Math.floor(size * 0.12);
                topLuma = checkRow(0, 3);
                botLuma = checkRow(size-3, size);

                let startY = 0, endY = size;
                if (topLuma < 15) startY = barH;
                if (botLuma < 15) endY = size - barH;

                for (let y = startY; y < endY; y+=step) {
                    for (let x = 0; x < size; x+=step) {
                        const i = (y * size + x) * 4;
                        const r = data[i];
                        const g = data[i+1];
                        const b = data[i+2];
                        const luma = (r*54 + g*183 + b*19) >> 8;

                        hist[luma]++;
                        validCount++;

                        sumR += r; sumG += g; sumB += b;
                        sumLuma += luma;
                        sumLumaSq += luma * luma;
                    }
                }

                let p10 = -1, p50 = -1, p55 = -1, p90 = -1, p98 = -1;
                let clipFrac = 0;

                let avgR = 0, avgG = 0, avgB = 0, avgLuma = 0, stdDev = 0;
                if (validCount > 0) {
                    const inv = 1 / validCount;
                    avgR = (sumR * inv) / 255;
                    avgG = (sumG * inv) / 255;
                    avgB = (sumB * inv) / 255;
                    avgLuma = (sumLuma * inv) / 255;

                    const meanSq = (sumLumaSq * inv) / (255*255);
                    const variance = meanSq - (avgLuma * avgLuma);
                    stdDev = Math.sqrt(Math.max(0, variance));
                    
                    clipFrac = (hist[253] + hist[254] + hist[255]) * inv;

                    let sum = 0;
                    const t10 = validCount * 0.10, t50 = validCount * 0.50, t55 = validCount * 0.55, t90 = validCount * 0.90, t98 = validCount * 0.98;
                    for (let i = 0; i < 256; i++) {
                        sum += hist[i];
                        if (p10 < 0 && sum >= t10) p10 = i / 255;
                        if (p50 < 0 && sum >= t50) p50 = i / 255;
                        if (p55 < 0 && sum >= t55) p55 = i / 255;
                        if (p90 < 0 && sum >= t90) p90 = i / 255;
                        if (p98 < 0 && sum >= t98) p98 = i / 255;
                    }
                }
                if (p10 < 0) p10 = 0.1; if (p50 < 0) p50 = 0.5; if (p55 < 0) p55 = 0.55; if (p90 < 0) p90 = 0.9; if (p98 < 0) p98 = 0.98;

                self.postMessage({ type: 'result', fid, vid, p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, validCount });
            }
        };
    `;

    // --- Shadow DOM & Detection ---
    const dirtyRoots = new Set();
    let _scanRaf = null, _lastFullScanTime = 0;
    let _fullScanQueued = false;
    const _localShadowRoots = [], _localShadowSet = new Set();
    const VSC_SR_MO = Symbol('vsc_sr_mo');

    const registerShadowRoot = (sr) => {
        if (!sr) return;
        if (!_localShadowSet.has(sr)) {
            _localShadowSet.add(sr); _localShadowRoots.push(sr);
            if (!sr[VSC_SR_MO]) {
                const mo = new MutationObserver(throttle(() => scheduleScan(sr), IS_MOBILE ? 200 : 120));
                try { mo.observe(sr, { childList: true, subtree: true }); sr[VSC_SR_MO] = mo; } catch {}
            }
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
                const startTime = performance.now();
                const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n, i = 0;
                while ((n = walker.nextNode()) && i < limit) {
                    if (n.shadowRoot) registerShadowRoot(n.shadowRoot);
                    i++;
                    if (i % 50 === 0 && performance.now() - startTime > 10) break;
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

    let _lastRootish = 0;
    const scheduleScan = (rootOrNull, immediate = false) => {
        if (Utils.isShadowRoot(rootOrNull)) registerShadowRoot(rootOrNull);
        
        if (immediate && _corePluginRef) {
            if (rootOrNull) {
                safeGuard(() => _corePluginRef.scanSpecificRoot(rootOrNull), 'immediateScanRoot');
            } else {
                if (_fullScanQueued) return;
                _fullScanQueued = true;
                requestAnimationFrame(() => {
                    _fullScanQueued = false;
                    safeGuard(() => _corePluginRef.scanAndApply(), 'immediateScanFull');
                });
            }
            return;
        }

        if (rootOrNull) {
            if (rootOrNull.nodeType === 1) {
                const tag = rootOrNull.nodeName;
                if (tag !== 'VIDEO' && tag !== 'IMG' && tag !== 'IFRAME' && tag !== 'CANVAS') {
                    const now = performance.now();
                    if (now - _lastRootish < 200) rootOrNull = null;
                    _lastRootish = now;
                }
            }
            if (rootOrNull) {
                if (Utils.isShadowRoot(rootOrNull)) { if (rootOrNull.host && rootOrNull.host.isConnected) dirtyRoots.add(rootOrNull); }
                else if (rootOrNull.isConnected) {
                    const tag = rootOrNull.nodeName;
                    if (tag === 'VIDEO' || tag === 'IMG' || tag === 'IFRAME' || tag === 'CANVAS') dirtyRoots.add(rootOrNull);
                    else if (isGoodScanRoot(rootOrNull)) dirtyRoots.add(rootOrNull);
                }
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
                    } else {
                        const roots = [...dirtyRoots]; dirtyRoots.clear();
                        for (const r of roots) if (r.isConnected || (Utils.isShadowRoot(r) && r.host && r.host.isConnected)) safeGuard(() => _corePluginRef.scanSpecificRoot(r), 'scanSpecificRoot');
                    }
                }
                safeGuard(() => _corePluginRef.tick(), 'tick');
            });
        });
    };

    let _lastBurstTime = 0;
    const triggerBurstScan = (delay = 200) => {
        const now = Date.now();
        if (now - _lastBurstTime < 250) return;
        _lastBurstTime = now;
        if(_corePluginRef) { _corePluginRef.resetScanInterval(); scheduleScan(null, true); [delay, delay * 4, delay * 8].forEach(d => setTimeout(() => scheduleScan(null), d)); }
    };

    let _sensCache = { t: 0, v: false };
    let _sensitiveLockUntil = performance.now() + 2000;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _sensitiveLockUntil = 0; }, 1000), { once: true });
    else setTimeout(() => { _sensitiveLockUntil = 0; }, 1000);

    const SENSITIVE_KEYWORDS = ['checkout', 'payment', 'bank', 'kakaobank', 'toss'];
    const isSensitiveUrl = () => { return SENSITIVE_KEYWORDS.some(kw => location.href.toLowerCase().includes(kw)); };

    const isSensitiveContext = () => {
        const now = Date.now();
        if (now - _sensCache.t < 300) return _sensCache.v;
        if (performance.now() < _sensitiveLockUntil && isSensitiveUrl()) { _sensCache = { t: now, v: true }; return true; }
        if (!document.documentElement) return false;
        let result = isSensitiveUrl();
        if (!result) {
            const u = location.href.toLowerCase();
            if (u.includes('verify')) {
                try { if (document.querySelector('input[type="password"], input[name*="otp"], input[name*="cvc"]')) result = true; } catch(e) {}
            } else {
                try { if (document.querySelector('input[type="password"], input[name*="cvc"]')) result = true; } catch(e) {}
            }
        }
        _sensCache = { t: now, v: result };
        return result;
    };

    let _hasVideoCache = { t: 0, v: false, req: 0 };
    const hasRealVideoCached = () => {
        const now = Date.now();
        if (now - _hasVideoCache.t < 500) return _hasVideoCache.v;

        if (!_hasVideoCache.req) {
            _hasVideoCache.req = requestAnimationFrame(() => {
                 _hasVideoCache.req = 0;
                 let found = false;
                 const isValid = (el) => {
                     if (!el) return false;
                     if (el.tagName === 'CANVAS') {
                         try { const r = el.getBoundingClientRect(); return r.width >= 200 && r.height >= 150 && r.bottom > 0 && r.top < innerHeight; } catch(e) { return false; }
                     }
                     if (el.tagName === 'IFRAME') return true;
                     return !!el.src || !!el.currentSrc || !!el.srcObject || !!el.querySelector('source') || !!el.getAttribute('data-src') || !!el.getAttribute('data-video-src');
                 };
                 const vids = document.getElementsByTagName('video');
                 for (let i = 0; i < vids.length; i++) { if (vids[i].isConnected && isValid(vids[i])) { found = true; break; } }
                 if (!found) {
                     const ifs = document.getElementsByTagName('iframe');
                     const max = IS_LOW_END ? 60 : 200;
                     for (let i=0; i<ifs.length && i<max; i++) {
                         if (ifs[i].offsetWidth === 0 && ifs[i].offsetHeight === 0) continue;
                         // [v45] Relaxed iframe size check (120 -> 80)
                         const r = ifs[i].getBoundingClientRect?.();
                         if (r && r.width >= 80 && r.height >= 80 && r.bottom > 0 && r.top < innerHeight) { found = true; break; }
                     }
                 }
                 if (!found && _localShadowRoots.length > 0) {
                     const cap = Math.min(_localShadowRoots.length, 50);
                     for (let i = 0; i < cap; i++) {
                         const sr = _localShadowRoots[i];
                         if (!sr) continue;
                         try { const v = sr.querySelector ? sr.querySelector('video, iframe, canvas') : null; if (v && isValid(v)) { found = true; break; } } catch(e) {}
                     }
                 }
                 _hasVideoCache = { t: Date.now(), v: found, req: 0 };
            });
        }
        return _hasVideoCache.v;
    };

    const ORIGINALS = { defineProperty: Object.defineProperty, defineProperties: Object.defineProperties, attachShadow: Element.prototype.attachShadow };
    const _prevInlineStyle = new WeakMap();
    const _realmSheetCache = new WeakMap();
    const _shadowRootCache = new WeakMap();
    let _shadowHookActive = false;

    // [v46] Replaced global hooking with targeted lock relaxation
    const PROTECT_KEYS = ['playbackRate', 'currentTime', 'volume', 'muted', 'onratechange'];
    function relaxMediaLocks(el) {
        if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
        for (const k of PROTECT_KEYS) {
            try {
                const d = Object.getOwnPropertyDescriptor(el, k);
                if (!d) continue;
                if (d.configurable === false) continue;
                if ('writable' in d && d.writable === false) {
                    Object.defineProperty(el, k, { ...d, writable: true });
                }
            } catch {}
        }
    }

    safeGuard(() => {
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
            try { this._vscLastPlay = Date.now(); } catch (e) {}
            // [v46] Targeted unlock on play
            try { relaxMediaLocks(this); } catch(e) {}
            
            try {
                 if (_corePluginRef && _corePluginRef.stateManager.get('app.scriptActive') && !isSensitiveContext()) {
                     _corePluginRef.scheduleNextScan();
                     VSC_PINNED.el = this;
                     VSC_PINNED.until = Date.now() + 10000;
                     if (this.getBoundingClientRect().width > 100 && _corePluginRef.stateManager) {
                         _corePluginRef.stateManager.set('media.currentlyVisibleMedia', this);
                     }
                 }
            } catch (e) {}
            return origPlay.apply(this, args);
        };
    }, "playHook");

    const enableShadowHook = () => {
        if (_shadowHookActive || isSensitiveContext()) return;
        try {
            Element.prototype.attachShadow = function (init) {
                if (this.id === 'vsc-ui-host') return ORIGINALS.attachShadow.call(this, init);
                const shadowRoot = ORIGINALS.attachShadow.call(this, init);
                try {
                    if (shadowRoot) { registerShadowRoot(shadowRoot); requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('addShadowRoot', { detail: { shadowRoot: shadowRoot } }))); }
                } catch (e) {}
                return shadowRoot;
            };
            _shadowHookActive = true;
        } catch(e) {}
    };

    safeGuard(() => { if (!isSensitiveContext()) { enableShadowHook(); collectOpenShadowRootsOnce(); } }, "earlyShadowHook");

    function getSharedStyleSheetForView(view, cssText) {
        if (!view || !view.CSSStyleSheet) return null;
        let map = _realmSheetCache.get(view); if (!map) { map = new Map(); _realmSheetCache.set(view, map); }
        const key = Utils.fastHash(cssText); let sheet = map.get(key);
        if (!sheet) { try { sheet = new view.CSSStyleSheet(); sheet.replaceSync(cssText); map.set(key, sheet); } catch (e) { return null; } }
        return sheet;
    }

    function injectFiltersIntoContext(element, manager, stateManager) {
        if (!manager || !manager.isInitialized() || !stateManager) return;
        let root = element.getRootNode(); const ownerDoc = element.ownerDocument;
        if (root === document && element.parentElement) {
            let cachedRoot = _shadowRootCache.get(element);
            if (!cachedRoot || !cachedRoot.host || !cachedRoot.host.isConnected) { for (const sRoot of _localShadowRoots) { if (sRoot.contains(element)) { root = sRoot; _shadowRootCache.set(element, sRoot); break; } } } else root = cachedRoot;
        }
        if (ownerDoc === document && root === document) return;
        const type = (manager === stateManager.filterManagers.video) ? 'video' : 'image';
        const attr = `data-vsc-filters-injected-${type}`;
        const styleId = manager.getStyleNode().id; const svgId = manager.getSvgNode().id;
        const targetRoot = (root instanceof ShadowRoot) ? root : document.head;

        if (Utils.isShadowRoot(root)) { if (root.host && root.host.hasAttribute(attr)) { if (root.getElementById(styleId)) return; } }
        else if (ownerDoc && ownerDoc.documentElement.hasAttribute(attr)) { if (ownerDoc.getElementById(styleId)) return; }

        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode(); if (!svgNode || !styleNode) return;
        const safelyAppendStyle = (targetRoot, styleEl, sharedSheet) => {
            let appended = false;
            if (sharedSheet && ('adoptedStyleSheets' in targetRoot)) { try { const sheets = targetRoot.adoptedStyleSheets; if (!sheets.includes(sharedSheet)) targetRoot.adoptedStyleSheets = [...sheets, sharedSheet]; appended = true; } catch (e) { } }
            if (!appended) { if (!targetRoot.querySelector(`#${styleEl.id}`)) { const container = (targetRoot === ownerDoc) ? targetRoot.head : targetRoot; if (container) container.appendChild(styleEl.cloneNode(true)); } }
        };

        if (ownerDoc !== document) {
            if (!ownerDoc.body) { setTimeout(() => injectFiltersIntoContext(element, manager, stateManager), 100); return; }
            if (!ownerDoc.getElementById(svgNode.id)) { const clonedSvg = svgNode.cloneNode(true); ownerDoc.body.appendChild(clonedSvg); manager.registerContext(clonedSvg); }
            const view = ownerDoc.defaultView; const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
            safelyAppendStyle(ownerDoc, styleNode, sharedSheet); ownerDoc.documentElement.setAttribute(attr, 'true');
            return;
        }
        if (Utils.isShadowRoot(root)) {
            try {
                if (!root.getElementById(svgNode.id)) { const clonedSvg = svgNode.cloneNode(true); root.appendChild(clonedSvg); manager.registerContext(clonedSvg); }
                const view = root.ownerDocument ? root.ownerDocument.defaultView : (root.host ? root.host.ownerDocument.defaultView : null);
                const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
                safelyAppendStyle(root, styleNode, sharedSheet); if (root.host) root.host.setAttribute(attr, 'true');
            } catch (e) { }
        }
    }

    // --- State Manager ---
    class StateManager {
        constructor() { this.state = {}; this.listeners = {}; this.filterManagers = { video: null, image: null }; }
        init() {
            const videoDefaults = CONFIG.FILTER.SETTINGS;
            const safeInt = Utils.safeInt;
            this.state = {
                app: { isInitialized: false, isMobile: IS_MOBILE, scriptActive: true },
                media: { activeMedia: new Set(), activeImages: new Set(), activeIframes: new Set(), mediaListenerMap: new WeakMap(), visibilityMap: new WeakMap(), currentlyVisibleMedia: null, visTick: 0 },
                videoFilter: { level: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL, level2: CONFIG.FILTER.VIDEO_DEFAULT_LEVEL2, gamma: parseFloat(videoDefaults.GAMMA), shadows: safeInt(videoDefaults.SHADOWS), highlights: safeInt(videoDefaults.HIGHLIGHTS), brightness: CONFIG.FILTER.DEFAULT_BRIGHTNESS, contrastAdj: CONFIG.FILTER.DEFAULT_CONTRAST, saturation: parseInt(videoDefaults.SAT, 10), colorTemp: safeInt(videoDefaults.TEMP), dither: safeInt(videoDefaults.DITHER), autoExposure: CONFIG.FILTER.DEFAULT_AUTO_EXPOSURE, clarity: CONFIG.FILTER.DEFAULT_CLARITY, activeSharpPreset: 'none' },
                imageFilter: { level: CONFIG.FILTER.IMAGE_DEFAULT_LEVEL, colorTemp: parseInt(CONFIG.FILTER.IMAGE_SETTINGS.TEMP || 0, 10) },
                audio: { enabled: false, boost: 6 },
                ui: { shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null, warningMessage: null, createRequested: true, hideUntilReload: false },
                playback: { currentRate: 1.0, targetRate: 1.0 }
            };
        }
        get(key) { return key.split('.').reduce((o, i) => (o ? o[i] : undefined), this.state); }
        set(key, value) {
            const keys = key.split('.'); let obj = this.state;
            for (let i = 0; i < keys.length - 1; i++) { if (obj === undefined) return; obj = obj[keys[i]]; }
            const finalKey = keys[keys.length - 1]; if (obj === undefined) return; const oldValue = obj[finalKey];
            if (!Object.is(oldValue, value)) { obj[finalKey] = value; this.notify(key, value, oldValue); }
        }
        batchSet(prefix, obj) { for (const [k, v] of Object.entries(obj)) this.set(`${prefix}.${k}`, v); }
        subscribe(key, callback) { if (!this.listeners[key]) this.listeners[key] = []; this.listeners[key].push(callback); return () => { this.listeners[key] = this.listeners[key].filter(cb => cb !== callback); }; }
        notify(key, newValue, oldValue) {
            if (this.listeners[key]) this.listeners[key].forEach(callback => callback(newValue, oldValue));
            let currentKey = key; while (currentKey.includes('.')) { const prefix = currentKey.substring(0, currentKey.lastIndexOf('.')); const wildcardKey = `${prefix}.*`; if (this.listeners[wildcardKey]) this.listeners[wildcardKey].forEach(callback => callback(key, newValue, oldValue)); currentKey = prefix; }
        }
    }

    const VideoAnalyzer = {
        canvas: null, ctx: null, handle: null, isRunning: false, targetVideo: null, stateManager: null, currentSettings: { clarity: 0, autoExposure: false },
        currentLinearGain: 1.0,
        _lastClarityComp: 0, frameSkipCounter: 0, dynamicSkipThreshold: 0, hasRVFC: false, lastAvgLuma: -1, _highMotion: false, _evAggressiveUntil: 0, _roiP50History: [], taintedResources: new WeakSet(), _worker: null, _workerUrl: null, _rvfcCb: null, _frameId: 0, _videoIds: new WeakMap(), _lowMotionFrames: 0, _lowMotionSkip: 0, _workerBusy: false, _workerLastSent: 0, _workerStallCount: 0, _lastAppliedFid: 0, _hist: new Uint16Array(256), _p10Ema: -1, _p90Ema: -1,
        _aeActive: false, _lastKick: 0, _workerCooldown: 0, _workerRetryCount: 0,
        _lastFrameStats: null,
        _lastNoWorkerAnalyze: 0,

        ensureStateManager(sm) { if (!this.stateManager && sm) this.stateManager = sm; },
        init(stateManager) {
            this.ensureStateManager(stateManager);
            if (!this.canvas) {
                if (typeof OffscreenCanvas !== 'undefined') this.canvas = new OffscreenCanvas(32, 32);
                else this.canvas = document.createElement('canvas');
                const size = (IS_LOW_END && !IS_HIGH_END) ? 24 : (IS_HIGH_END ? 48 : 24);
                this.canvas.width = size; this.canvas.height = size;
            }
            if (!this.ctx) {
                const opts = { willReadFrequently: true, alpha: false };
                try { opts.desynchronized = true; } catch(e){}
                this.ctx = this.canvas.getContext('2d', opts);
                if (this.ctx) this.ctx.imageSmoothingEnabled = false;
            }
            if (!this._worker && !this._workerUrl) {
                try {
                    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
                    this._workerUrl = URL.createObjectURL(blob);
                    this._worker = new Worker(this._workerUrl);
                    this._worker.onmessage = this._handleWorkerMessage.bind(this);
                    this._worker.onerror = () => { this._workerBusy = false; };
                    this._worker.onmessageerror = () => { this._workerBusy = false; };
                } catch (e) {
                    if (this._workerUrl) { try { URL.revokeObjectURL(this._workerUrl); } catch {} }
                    this._workerUrl = null; this._worker = null;
                }
            }
            this._roiP50History = []; this._p10Ema = -1; this._p90Ema = -1;
            this._workerCooldown = 0;
            this._lastFrameStats = null;
        },
        _getVideoId(v) { if (!this._videoIds.has(v)) this._videoIds.set(v, Math.random().toString(36).slice(2)); return this._videoIds.get(v); },
        _handleWorkerMessage(e) {
            this._workerBusy = false; this._workerLastSent = 0;
            const { type, fid, vid, p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, validCount } = e.data;
            if (type !== 'result' || !this.targetVideo || vid !== this._getVideoId(this.targetVideo)) return;
            if (!this._lastAppliedFid) this._lastAppliedFid = 0; if (fid < this._lastAppliedFid) return;
            this._lastAppliedFid = fid;
            this._processAnalysisResult(p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, validCount);
        },
        _analyzeFallback(imageData, width, height, step) {
             const data = imageData.data;
             const size = width;

             const checkRow = (sy, ey) => {
                 let s = 0, c = 0;
                 for (let y = sy; y < ey; y += step) {
                     for (let x = 0; x < size; x += step) {
                         const i = (y * size + x) * 4;
                         s += (data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8;
                         c++;
                     }
                 }
                 return c ? (s / c) : 0;
             };

             const barH = Math.floor(size * 0.12);
             const topLuma = checkRow(0, 3);
             const botLuma = checkRow(size - 3, size);

             let startY = 0, endY = size;
             if (topLuma < 15) startY = barH;
             if (botLuma < 15) endY = size - barH;

             let sumLuma = 0, sumLumaSq = 0;
             let count = 0;
             let hist = this._hist;
             hist.fill(0);

             for (let y = startY; y < endY; y += step) {
                 for (let x = 0; x < size; x += step) {
                     const i = (y * size + x) * 4;
                     const luma = (data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8;
                     sumLuma += luma;
                     sumLumaSq += luma * luma;
                     hist[luma]++;
                     count++;
                 }
             }
             
             let avgLuma = 0.5, stdDev = 0.1, clipFrac = 0;
             if (count > 0) {
                 const inv = 1 / count;
                 avgLuma = (sumLuma * inv) / 255;
                 const meanSq = (sumLumaSq * inv) / (255 * 255);
                 const variance = meanSq - (avgLuma * avgLuma);
                 stdDev = Math.sqrt(Math.max(0, variance)); 
                 clipFrac = (hist[253] + hist[254] + hist[255]) * inv;
             }

             let p10 = -1, p50 = -1, p90 = -1, p98 = -1;
             let sum = 0;
             const t10 = count * 0.1, t50 = count * 0.5, t90 = count * 0.9, t98 = count * 0.98;

             for(let i=0; i<256; i++) {
                 sum += hist[i];
                 if(p10<0 && sum>=t10) p10 = i/255;
                 if(p50<0 && sum>=t50) p50 = i/255;
                 if(p90<0 && sum>=t90) p90 = i/255;
                 if(p98<0 && sum>=t98) p98 = i/255;
             }
             if(p10<0) p10=0.1; if(p50<0) p50=0.5; if(p90<0) p90=0.9; if(p98<0) p98=0.98;

             this._processAnalysisResult(p10, p50, p50, p90, p98, avgLuma, stdDev, 0.33, 0.33, 0.33, clipFrac, count);
        },

        _pickBestVideoNow() {
            if (VSC_PINNED.el && VSC_PINNED.el.isConnected && Date.now() < VSC_PINNED.until) {
                if (VSC_PINNED.el.tagName === 'VIDEO' || VSC_PINNED.el.tagName === 'CANVAS') return VSC_PINNED.el;
                if (VSC_PINNED.el.tagName === 'IFRAME') {
                    try {
                        const doc = VSC_PINNED.el.contentDocument;
                        const inner = doc?.querySelector?.('video, canvas');
                        if (inner && inner.isConnected) return inner;
                    } catch {}
                }
            }

            const sm = this.stateManager;
            let candidates = sm ? [...(sm.get('media.activeMedia') || [])] : [];

            if (candidates.length === 0) {
                candidates = Array.from(document.querySelectorAll('video, canvas'));
            } else {
                 candidates = [...new Set(candidates)];
            }

            const visMap = sm?.get('media.visibilityMap');
            const visibleCandidates = candidates.filter(v => visMap ? visMap.get(v) !== false : true);
            const pool = visibleCandidates.length > 0 ? visibleCandidates : candidates;

            let best = null, maxScore = -Infinity;
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const now = Date.now();
            const screenArea = window.innerWidth * window.innerHeight;

            for(let i=0; i<pool.length; i++) {
                const c = pool[i]; if (!c.isConnected) continue;
                const rect = c.getBoundingClientRect(); if (rect.width > 10 && rect.height > 10) {
                    let score = rect.width * rect.height;
                    const area = rect.width * rect.height;
                    
                    // [v46] Enhanced Small Player Detection
                    // Penalty reduced (0.25) if interacted, helping detection in complex sites
                    const isHot = (c.tagName === 'VIDEO' && (!c.paused || (c._vscLastPlay && now - c._vscLastPlay < 15000)));
                    if (area < screenArea * 0.06 && !isHot && document.pictureInPictureElement !== c) {
                         score *= 0.25; 
                    }

                    const isBig = area > screenArea * 0.12;

                    if (c.tagName === 'VIDEO') {
                        if (!c.paused) score *= 2.0;
                        if (c.readyState >= 3) score *= 1.5;
                        if (c.src || c.srcObject) score *= 1.2;
                        if (!c.muted && c.volume > 0) score *= 1.5;
                        if (c._vscLastPlay && now - c._vscLastPlay < 15000) score *= 3.0; 
                        if (c.duration && !isNaN(c.duration) && c.duration < 2) score *= 0.1;
                        if (document.fullscreenElement === c || document.pictureInPictureElement === c) score *= 3.0;
                        if (isBig) score *= 1.5;
                    } else { 
                        score *= 0.5;
                    }

                    const dist = Math.min(2e6, (rect.x + rect.width/2 - cx)**2 + (rect.y + rect.height/2 - cy)**2);
                    score -= dist * 0.0002;

                    if (score > maxScore) { maxScore = score; best = c; }
                }
            }
            return best;
        },
        _kickImmediateAnalyze() {
            const now = performance.now();
            if (this._lastKick && now - this._lastKick < 60) return;
            this._lastKick = now;
            requestAnimationFrame(() => { try { if (this.targetVideo && this.ctx) this.processFrame(true); } catch {} });
        },
        start(video, settings) {
            if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null; }
            if (!this.ctx || !this.canvas) this.init(this.stateManager);
            if (!this.ctx) return;

            if (this.targetVideo && this.targetVideo !== video) {
                this.currentLinearGain = 1.0;
                this._lastAppliedFid = 0;
                this._frameId = 0;
                this._roiP50History = [];
                this._p10Ema = -1;
                this._p90Ema = -1;
                this._aeActive = false;
                this._workerCooldown = 0;
                this._lastFrameStats = null;
            }

            if (this.isRunning && this.targetVideo !== video) this.stop();
            if (settings) this.currentSettings = { ...this.currentSettings, ...settings };
            const isClarityActive = this.currentSettings.clarity > 0;
            const isAutoExposure = this.currentSettings.autoExposure;
            if (!isClarityActive && !isAutoExposure) { if (this.isRunning) this.stop(); return; }
            if (this.taintedResources.has(video)) {
                this.notifyUpdate({ linearGain: 1.0, tainted: true }, 0, video, true);
                return;
            }
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video; this.hasRVFC = (video.tagName === 'VIDEO' && 'requestVideoFrameCallback' in video);
            if (this.canvas) {
                const vw = video.videoWidth || video.width || video.clientWidth || 0;
                let targetSize = (vw > 640 && IS_HIGH_END) ? 48 : (IS_LOW_END ? 24 : 32);
                if (IS_MOBILE) targetSize = 24;
                if (IS_DATA_SAVER) targetSize = 24; 
                if (this.canvas.width !== targetSize) { this.canvas.width = targetSize; this.canvas.height = targetSize; }
            }
            if (!this._worker && !this._workerUrl) this.init(this.stateManager);
            this.isRunning = true; this._roiP50History = []; this._p10Ema = -1; this._p90Ema = -1; this._lowMotionSkip = 0;

            this.notifyUpdate({
                linearGain: this.currentLinearGain
            }, 0.5, this.targetVideo, false);

            // [v46] Apply lock relaxation on new video start
            try { relaxMediaLocks(video); } catch(e) {}

            this.loop();
        },
        stop() {
            this.isRunning = false;
            if (this.hasRVFC && this.targetVideo && this.handle) { try { this.targetVideo.cancelVideoFrameCallback(this.handle); } catch { } }
            this.handle = null; this._rvfcCb = null; 
            this.targetVideo = null; this.frameSkipCounter = 0; this.lastAvgLuma = -1; this._highMotion = false;
            this._roiP50History = []; this._p10Ema = -1; this._p90Ema = -1;
        },
        updateSettings(settings) {
            const prev = this.currentSettings; this.currentSettings = { ...this.currentSettings, ...settings };
            const now = performance.now();
            const aeTurnedOn = settings && Object.prototype.hasOwnProperty.call(settings, 'autoExposure') && settings.autoExposure && !prev.autoExposure;
            if (settings && (Object.prototype.hasOwnProperty.call(settings, 'autoExposure') || Object.prototype.hasOwnProperty.call(settings, 'clarity'))) {
                this.frameSkipCounter = 999;
                if (aeTurnedOn) { this._evAggressiveUntil = now + 800; this.dynamicSkipThreshold = 0; this._lowMotionFrames = 0; }
            }
            if (settings && Object.prototype.hasOwnProperty.call(settings, 'autoExposure') && !settings.autoExposure) { this._evAggressiveUntil = 0; }
            const isClarityActive = this.currentSettings.clarity > 0; const isAutoExposure = this.currentSettings.autoExposure;

            if (isClarityActive || isAutoExposure) {
                if (this.isRunning && this.targetVideo && this.targetVideo.isConnected) {
                       if (aeTurnedOn) this._kickImmediateAnalyze();
                       return;
                }
                const best = this._pickBestVideoNow();
                if (best) { this.start(best, { autoExposure: this.currentSettings.autoExposure, clarity: this.currentSettings.clarity }); }
            } else if (!isClarityActive && !isAutoExposure && this.isRunning) {
                this.stop(); this.notifyUpdate({ linearGain: 1.0 }, 0);
            }
        },
        loop() {
            if (!this.isRunning || !this.targetVideo) return;
            if (this.hasRVFC) {
                if (!this._rvfcCb) {
                    this._rvfcCb = () => {
                        if (!this.isRunning || !this.targetVideo) return;
                        if (document.hidden) {
                             setTimeout(() => { if (this.isRunning) this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb); }, 500);
                             return;
                        }
                        try { this.processFrame(); } catch (e) { if (CONFIG.DEBUG) console.warn(e); }
                        this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb);
                    };
                }
                this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb);
            } else {
                this.processFrame();
                const delay = (this.targetVideo.paused || document.hidden) ? 500 : (this.dynamicSkipThreshold > 5 ? 150 : 80);
                setTimeout(() => this.loop(), delay);
            }
        },
        processFrame(allowPausedOnce = false) {
            if (!this.targetVideo) { this.stop(); return; }
            if (this.targetVideo.tagName === 'VIDEO' && this.targetVideo.ended) { this.stop(); return; }
            if (document.hidden) return;
            if (this.targetVideo.tagName === 'VIDEO' && this.targetVideo.paused && !allowPausedOnce) { if (!this._stopTimeout) this._stopTimeout = setTimeout(() => this.stop(), 2000); return; }
            if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null; }
            if (this.targetVideo.tagName === 'VIDEO' && this.targetVideo.readyState < 2) return;
            if (!this.ctx) return;
            if (this.taintedResources.has(this.targetVideo)) return;

            const visMap = this.stateManager.get('media.visibilityMap');
            const isVis = visMap ? visMap.get(this.targetVideo) : true;

            if (!document.fullscreenElement && !document.pictureInPictureElement) {
                const rect = this.targetVideo.getBoundingClientRect();
                const screenArea = window.innerWidth * window.innerHeight;
                if (rect.width * rect.height < screenArea * 0.12 && isVis === false) return;
            }

            if (this._lowMotionFrames > 60) {
                 this._lowMotionSkip++;
                 const isIdle = !this._aeActive;
                 const skipRate = isIdle ? 12 : 5;
                 if (this._lowMotionSkip % skipRate !== 0) return;
            } else { this._lowMotionSkip = 0; }

            if (this._workerCooldown > 0) {
                if (performance.now() < this._workerCooldown) return;
                this._workerCooldown = 0;
            }

            if (!this._worker) {
                 const now = performance.now();
                 if (now - (this._lastNoWorkerAnalyze||0) < 250) return;
                 this._lastNoWorkerAnalyze = now;
            }

            if (this._worker && this._workerBusy) {
                 const now = performance.now();
                 if (this._workerLastSent > 0 && now - this._workerLastSent > 1200) {
                     this._workerStallCount = (this._workerStallCount || 0) + 1;
                     this._workerBusy = false; this._workerLastSent = 0;
                     if (this._workerStallCount >= 3) {
                         try { this._worker.terminate(); } catch {}
                         this._worker = null; if (this._workerUrl) URL.revokeObjectURL(this._workerUrl); this._workerUrl = null;
                         this._workerStallCount = 0;
                         this._workerRetryCount = (this._workerRetryCount || 0) + 1;
                         this._workerCooldown = performance.now() + Math.min(30000, 3000 * this._workerRetryCount);
                         this.init(this.stateManager);
                         return;
                     }
                 } else {
                     const isAggressive = (this._evAggressiveUntil && now < this._evAggressiveUntil);
                     if (!isAggressive) return;
                 }
            } else {
                if (this._workerRetryCount > 0 && Math.random() < 0.05) this._workerRetryCount = 0;
            }

            const startTime = performance.now();
            const aggressive = (this._evAggressiveUntil && startTime < this._evAggressiveUntil);
            let baseThreshold = this.hasRVFC ? 10 : 0;
            if (this._highMotion) baseThreshold = this.hasRVFC ? 6 : 3;
            if (aggressive) baseThreshold = 0;

            let effectiveThreshold = baseThreshold + (this.dynamicSkipThreshold || 0);
            
            if (IS_DATA_SAVER && !aggressive) effectiveThreshold += 5;
            
            // [v46] Smart Throttling for Mobile
            if (IS_MOBILE && !aggressive) {
                if (!this._aeActive) effectiveThreshold += 2;
                if (this._lastFrameStats && this._lastFrameStats.stdDev > 0.15) effectiveThreshold += 2;
                if (this._lowMotionFrames > 30) effectiveThreshold += 3;
            }

            this.frameSkipCounter++;
            if (this.frameSkipCounter < effectiveThreshold) return;
            this.frameSkipCounter = 0;

            try {
                const size = this.canvas.width;
                this.ctx.drawImage(this.targetVideo, 0, 0, size, size);
                const imageData = this.ctx.getImageData(0, 0, size, size);
                // [v45] Force step 2 on mobile to save CPU
                const step = IS_MOBILE ? 2 : ((size <= 32) ? 1 : 2);
                const fid = ++this._frameId;
                const vid = this._getVideoId(this.targetVideo);

                if (this._worker) {
                        this._workerBusy = true; this._workerLastSent = performance.now();
                        const buf = imageData.data.buffer;
                        const msg = { type: 'analyze', fid, vid, buf, width: size, step };
                        try { this._worker.postMessage(msg, [buf]); }
                        catch(err) {
                            this._workerBusy = false; this._workerLastSent = 0;
                            let safeData = imageData;
                            if (!safeData.data || safeData.data.byteLength === 0) {
                                safeData = this.ctx.getImageData(0, 0, size, size);
                            }
                            this._analyzeFallback(safeData, size, size, step);
                        }
                } else {
                    this._analyzeFallback(imageData, size, size, step);
                }
            } catch (e) {
                if (e.name === 'SecurityError') {
                    this.taintedResources.add(this.targetVideo);
                    const next = this._pickBestVideoNow();
                    if (next && next !== this.targetVideo && !this.taintedResources.has(next)) {
                         this.targetVideo = next; this.hasRVFC = (next.tagName === 'VIDEO' && 'requestVideoFrameCallback' in next); this._kickImmediateAnalyze(); return;
                    }
                    const taintedVideo = this.targetVideo;
                    this.stop();
                    this.notifyUpdate({ linearGain: 1.0, tainted: true }, 0, taintedVideo, true);
                } else {
                    const next = this._pickBestVideoNow();
                    if(next && next !== this.targetVideo) {
                        this.targetVideo = next; this.hasRVFC = (next.tagName === 'VIDEO' && 'requestVideoFrameCallback' in next); this._kickImmediateAnalyze(); return;
                    }
                    this.stop();
                }
            }
            const duration = performance.now() - startTime;
            if (duration > 4.0) this.dynamicSkipThreshold = Math.min(30, (this.dynamicSkipThreshold || 0) + 1);
            else if (duration < 1.0 && this.dynamicSkipThreshold > 0) this.dynamicSkipThreshold = Math.max(0, this.dynamicSkipThreshold - 1);
        },
        _processAnalysisResult(p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac = 0, validCount = 100) {

            const currStats = { luma: avgLuma, r: avgR, g: avgG, b: avgB, stdDev };
            let isCut = false;
            if (this._lastFrameStats) {
                const dL = Math.abs(currStats.luma - this._lastFrameStats.luma);
                const currRB = currStats.r - currStats.b;
                const lastRB = this._lastFrameStats.r - this._lastFrameStats.b;
                const dC = Math.abs(currRB - lastRB);

                if ((dL + dC * 0.8) > 0.15) isCut = true;
            }
            this._lastFrameStats = currStats;

            if (isCut) {
                this._evAggressiveUntil = performance.now() + 800;
                this._lowMotionFrames = 0;
            }

            const aggressive = (this._evAggressiveUntil && performance.now() < this._evAggressiveUntil);

            const mid = Number.isFinite(p55) ? p55 : p50;
            this._roiP50History.push(mid);

            if (this._roiP50History.length > 5) this._roiP50History.shift();
            const p50m = Utils.median5(this._roiP50History);

            this._p10Ema = (this._p10Ema < 0) ? p10 : (p10 * 0.2 + this._p10Ema * 0.8);
            this._p90Ema = (this._p90Ema < 0) ? p90 : (p90 * 0.2 + this._p90Ema * 0.8);
            
            const currentLuma = p50m;
            if (this.lastAvgLuma >= 0) {
                const delta = Math.abs(currentLuma - this.lastAvgLuma);
                if (delta < 0.003) this._lowMotionFrames++; else this._lowMotionFrames = 0;
                if (this._highMotion) { if (delta < 0.06) this._highMotion = false; } else { if (delta > 0.10) this._highMotion = true; }
            }
            this.lastAvgLuma = currentLuma;

            let targetLinearGain = 1.0;
            const isAutoExp = this.currentSettings.autoExposure;
            let tempBaseDown = 0.06;

            // [v35] Minimal Intervention Mode (AE = Safety Guard)
            if (isAutoExp) {
                const aeStr = MIN_AE.STRENGTH;

                // [v44] Dynamic Clip Limit based on pixel count to handle noise
                const minClipPixels = 3;
                const dynamicClipLimit = Math.max(MIN_AE.CLIP_FRAC_LIMIT, (validCount > 0 ? minClipPixels / validCount : 0));
                
                // [v46] Smart Low-Key & Subtitle Protection
                // If ClipFrac is small, it might be subtitles, so don't block entirely unless p98 is also extreme.
                const highlightSmall = clipFrac < dynamicClipLimit * 0.6;
                
                const isLowKey = (stdDev > MIN_AE.LOWKEY_STDDEV && p10 > MIN_AE.LOWKEY_P10) || 
                                 (p90 > 0.82) || 
                                 (p98 > 0.92 && !highlightSmall);

                const midTooDark = p50m < MIN_AE.MID_OK_MIN;
                
                // 1. Check clip risk
                const clipRisk = (p98 >= MIN_AE.P98_CLIP && !highlightSmall) || (clipFrac > dynamicClipLimit);
                
                if (clipRisk) {
                    targetLinearGain = 1.0;
                    this._aeActive = false;
                    tempBaseDown = 0.25; 
                } 
                else if (midTooDark && !isLowKey) {
                    // 3. Intervention required
                    const safeCurrent = Math.max(0.02, p50m);
                    let targetMid = 0.34;
                    if (avgLuma > 0.8) targetMid = 0.32;
                    else if (avgLuma > 0.6) targetMid = 0.34;

                    targetMid = Math.max(0.34, MIN_AE.MID_OK_MIN);

                    let baseEV = Math.log2(targetMid / safeCurrent);

                    let maxUp = MIN_AE.MAX_UP_EV;
                    const headroomEV = Math.log2(0.98 / Math.max(0.01, p98));
                    
                    if (p50m < 0.08 && headroomEV > 0.6 && stdDev < 0.18) {
                         maxUp = Math.min(MIN_AE.MAX_UP_EV_DARK, headroomEV * 0.75);
                    } else if (p50m < 0.14 && headroomEV > 0.4) {
                         maxUp = Math.min(MIN_AE.MAX_UP_EV_DARK * 0.9, headroomEV * 0.6);
                    }

                    let currentAeStr = aeStr;
                    if (p50m < 0.08) currentAeStr = MIN_AE.STRENGTH_DARK;

                    let autoEV = Utils.clamp(baseEV * currentAeStr, MIN_AE.MAX_DOWN_EV, maxUp);

                    let rawEV = autoEV;

                    // [Safety Cap] P98 hard limit
                    if (p98 > 0.01) {
                        const maxSafeGain = 0.99 / p98;
                        const maxSafeEV = Math.log2(maxSafeGain);
                        if (rawEV > maxSafeEV) rawEV = Math.min(rawEV, maxSafeEV);
                    }

                    if (this._aeActive == null) this._aeActive = false;
                    const th = this._aeActive ? MIN_AE.DEAD_IN : MIN_AE.DEAD_OUT;

                    if (Math.abs(rawEV) < th) {
                        rawEV = 0;
                        this._aeActive = false;
                    } else {
                        this._aeActive = true;
                    }

                    rawEV = Utils.clamp(rawEV, MIN_AE.MAX_DOWN_EV, maxUp);
                    
                    if (stdDev < 0.05) {
                        const damping = 0.95; 
                        rawEV *= damping;
                    }
                    if (this._highMotion && !aggressive) rawEV *= 0.8;

                    targetLinearGain = Math.pow(2, rawEV);
                } else {
                    targetLinearGain = 1.0;
                    this._aeActive = false;
                }
            }

            const smooth = (curr, target, upSpeed, downSpeed) => {
                const diff = target - curr;
                if (Math.abs(diff) < 0.002) return target;
                return curr + diff * (diff > 0 ? upSpeed : downSpeed);
            };

            const baseUp = aggressive ? 0.20 : 0.02;
            const baseDown = aggressive ? 0.20 : tempBaseDown;

            const currentEV = Math.log2(this.currentLinearGain || 1.0);
            const targetEV = Math.log2(targetLinearGain);
            const nextEV = smooth(currentEV, targetEV, baseUp, baseDown);
            this.currentLinearGain = Math.pow(2, nextEV);

            if (Math.abs(this.currentLinearGain - 1.0) < 0.01 && !aggressive) this.currentLinearGain = 1.0;

            this.notifyUpdate({
                linearGain: this.currentLinearGain,
                tainted: false
            }, p50m, this.targetVideo, false);
        },
        notifyUpdate(autoParams, luma, videoInfo, tainted = false) {
            document.dispatchEvent(new CustomEvent('vsc-smart-limit-update', { detail: { autoParams, luma, tainted, videoInfo, aeActive: this._aeActive } }));
        }
    };

    class Plugin { constructor(name) { this.name = name; this.stateManager = null; this.subscriptions = []; this._ac = new AbortController(); } init(stateManager) { this.stateManager = stateManager; } destroy() { this.subscriptions.forEach(unsubscribe => unsubscribe()); this.subscriptions = []; this._ac.abort(); } subscribe(key, callback) { this.subscriptions.push(this.stateManager.subscribe(key, callback)); } }
    class PluginManager {
        constructor(stateManager) { this.plugins = []; this.stateManager = stateManager; }
        register(plugin) { this.plugins.push(plugin); }
        initAll() { this.stateManager.init(); this.plugins.forEach(p => p.init(this.stateManager)); this.stateManager.set('app.isInitialized', true); this.stateManager.set('app.pluginsInitialized', true); window.addEventListener('pagehide', (e) => { if (!e.persisted) this.destroyAll(); }); }
        destroyAll() { this.plugins.forEach(p => p.destroy()); }
    }

    class AudioController extends Plugin {
        constructor() { super('Audio'); this.ctx = null; this.compressor = null; this.dryGain = null; this.wetGain = null; this.source = null; this.targetMedia = null; }
        init(stateManager) {
            super.init(stateManager);
            this.subscribe('audio.enabled', (enabled) => this.toggle(enabled));
            this.subscribe('audio.boost', (val) => this.setBoost(val));
            this.subscribe('media.currentlyVisibleMedia', (media) => { if (this.stateManager.get('audio.enabled')) this.attach(media); });
        }
        toggle(enabled) {
            if (enabled) {
                const media = this.stateManager.get('media.currentlyVisibleMedia');
                if (media) this.attach(media);
                this.updateMix(true);
            } else {
                this.updateMix(false);
            }
        }
        setBoost(val) {
            if (this.wetGain && this.ctx) {
                if (this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});
                const boost = Math.pow(10, val / 20);
                this.wetGain.gain.setTargetAtTime(boost, this.ctx.currentTime, 0.05);
            }
        }
        updateMix(enabled) {
            if (!this.ctx || !this.dryGain || !this.wetGain) return;
            if (this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});
            const t = this.ctx.currentTime;
            this.dryGain.gain.setTargetAtTime(enabled ? 0 : 1, t, 0.05);
            this.wetGain.gain.setTargetAtTime(enabled ? Math.pow(10, this.stateManager.get('audio.boost') / 20) : 0, t, 0.05);
        }
        attach(media) {
            if (!media || media.tagName !== 'VIDEO') return;
            if (this.targetMedia === media && this.source) { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{}); return; }

            this.targetMedia = media;
            try {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (!this.ctx) {
                    this.ctx = new AudioContext();
                    this.compressor = this.ctx.createDynamicsCompressor();
                    Object.assign(this.compressor.threshold, { value: CONFIG.AUDIO.THRESHOLD });
                    Object.assign(this.compressor.knee, { value: CONFIG.AUDIO.KNEE });
                    Object.assign(this.compressor.ratio, { value: CONFIG.AUDIO.RATIO });
                    Object.assign(this.compressor.attack, { value: CONFIG.AUDIO.ATTACK });
                    Object.assign(this.compressor.release, { value: CONFIG.AUDIO.RELEASE });

                    this.dryGain = this.ctx.createGain();
                    this.dryGain.gain.value = 1;
                    this.dryGain.connect(this.ctx.destination);

                    this.wetGain = this.ctx.createGain();
                    this.wetGain.gain.value = 0;
                    this.compressor.connect(this.wetGain);
                    this.wetGain.connect(this.ctx.destination);
                }

                if (this.ctx.state === 'suspended') this.ctx.resume().catch(()=>{});

                if (!media[VSC_AUDIO_SRC]) { try { media[VSC_AUDIO_SRC] = this.ctx.createMediaElementSource(media); } catch(e) { return; } }
                this.source = media[VSC_AUDIO_SRC];

                try { this.source.disconnect(); } catch (e) {}
                this.source.connect(this.dryGain);
                this.source.connect(this.compressor);

                this.updateMix(this.stateManager.get('audio.enabled'));
            } catch (e) {}
        }
        detach() {
            if (this.source) { try { this.source.disconnect(); } catch(e) {} }
            this.source = null;
            this.targetMedia = null;
            if (this.dryGain) this.dryGain.gain.value = 1;
            if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
        }
    }

    class CoreMediaPlugin extends Plugin {
        constructor() { super('CoreMedia'); this.mainObserver = null; this.intersectionObserver = null; this.scanTimerId = null; this.emptyScanCount = 0; this.baseScanInterval = IS_TOP ? CONFIG.SCAN.INTERVAL_TOP : CONFIG.SCAN.INTERVAL_IFRAME; this.currentScanInterval = this.baseScanInterval; this._seenIframes = new WeakSet(); this._observedImages = new WeakSet();
        this._lastImmediateScan = new WeakMap(); this._globalAttrObs = null; this._didInitialShadowFullScan = false; this._visibleVideos = new Set(); this._domDirty = true; this._mutationCounter = 0; this._isBackoffMode = false; this._backoffInterval = null; this._historyOrig = null; this._lastShadowPrune = 0; this._lastAttrObsProbe = 0; this._lastSensitive = null; this._updateHooksState = null; this.lastInteractedMedia = null;
        this._shadowScanIndex = 0;
        this._iframeDocCache = new WeakMap();
        }

        _tryGetIframeDoc(fr) {
             const now = performance.now();
             const c = this._iframeDocCache.get(fr);
             if (c && (now - c.t) < 3000) return c.ok ? c.doc : null;
             let doc = null, ok = false;
             try { doc = fr.contentDocument; ok = !!doc; } catch {}
             this._iframeDocCache.set(fr, { t: now, ok, doc });
             return ok ? doc : null;
        }

        init(stateManager) {
            super.init(stateManager); this.ensureObservers(); _corePluginRef = this; VideoAnalyzer.ensureStateManager(stateManager);
            if (!this._historyOrig) {
                this._historyOrig = { pushState: history.pushState, replaceState: history.replaceState };
                ['pushState', 'replaceState'].forEach(fn => { const orig = this._historyOrig[fn]; history[fn] = function (...args) { const r = orig.apply(this, args); try { triggerBurstScan(250); } catch { } return r; }; });
            }
            on(window, 'popstate', () => triggerBurstScan(250), P(this._ac.signal)); on(window, 'hashchange', () => triggerBurstScan(250), P(this._ac.signal));
            const stopAnalyzer = () => { try { VideoAnalyzer.stop(); } catch {} };
            on(document, 'visibilitychange', () => { try { this._updateHooksState?.(); } catch {} if (document.hidden) stopAnalyzer(); }, P(this._ac.signal));
            on(window, 'pagehide', stopAnalyzer, P(this._ac.signal));
            on(window, 'blur', stopAnalyzer, P(this._ac.signal));
            
            // [v46] BFCache fix: Ensure state refresh
            on(window, 'pageshow', (e) => {
                if (e.persisted) { 
                    try { 
                        triggerBurstScan(150); 
                        if (this.stateManager.get('videoFilter.autoExposure')) VideoAnalyzer._kickImmediateAnalyze();
                    } catch {} 
                }
            }, P(this._ac.signal));

            // [v41] Improved resilience for dynamically loaded content
            on(document, 'readystatechange', () => {
                if (document.readyState === 'interactive' || document.readyState === 'complete') triggerBurstScan(200);
            }, P(this._ac.signal));

            on(document, 'pointerdown', (e) => {
                let target = e.target;
                while(target && target !== document) {
                    if (target.tagName === 'VIDEO' || target.tagName === 'IFRAME') {
                        this.lastInteractedMedia = target;
                        VSC_PINNED.el = target;
                        VSC_PINNED.until = Date.now() + 15000;
                        return;
                    }
                    target = target.parentElement;
                }
            }, CP(this._ac.signal));

            // v132.0.13: Promote to active on play
            on(document, 'play', (e) => {
                const t = e.target;
                if (t && t.tagName === 'VIDEO') {
                    this.lastInteractedMedia = t;
                    t._vscLastPlay = Date.now();
                    if (t.getBoundingClientRect().width > 100) this.stateManager.set('media.currentlyVisibleMedia', t);
                    // [v44] Kick analyzer on play
                    if (this.stateManager.get('videoFilter.autoExposure')) VideoAnalyzer._kickImmediateAnalyze();
                }
            }, CP(this._ac.signal));
            
            // [v44] Additional triggers
            ['seeked', 'loadedmetadata'].forEach(evt => {
                on(document, evt, (e) => {
                    if (e.target && e.target.tagName === 'VIDEO' && this.stateManager.get('videoFilter.autoExposure')) {
                        VideoAnalyzer._kickImmediateAnalyze();
                    }
                }, CP(this._ac.signal));
            });

            this._backoffInterval = setInterval(() => { if (this._mutationCounter > 80) { if (!this._isBackoffMode) { this._isBackoffMode = true; } } else { if (this._isBackoffMode) { this._isBackoffMode = false; scheduleScan(null); } } this._mutationCounter = 0; }, 1000);

            this.mainObserver = new MutationObserver((mutations) => {
                this._mutationCounter += mutations.length;
                if (this._mutationCounter > 80) { this._domDirty = true; return; }

                let sawMediaNode = false;
                // [v43] Backoff sampling optimization
                if (this._isBackoffMode && Math.random() > 0.1) return;

                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        if (n && n.nodeType === 1) { // v132.0.10: Check nodeType
                            if (n.nodeName === 'VIDEO' || n.nodeName === 'IFRAME') { sawMediaNode = true; scheduleScan(n, true); break; } // v132.0.13: Break early
                            else if (n.querySelector?.('video, iframe')) { sawMediaNode = true; scheduleScan(n, true); break; }
                        }
                    }
                    if (sawMediaNode) break;
                }
                if (sawMediaNode) this._domDirty = true;
                if (mutations.length > 50 || this._isBackoffMode) { this._domDirty = true; return; }
                let dirty = false;
                for (const m of mutations) { if (m.addedNodes.length > 0) { dirty = true; break; } }
                if (dirty) this._domDirty = true;
            });

            if (document.documentElement) {
                this.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
            } else {
                document.addEventListener('DOMContentLoaded', () => {
                    this.mainObserver.observe(document.documentElement, { childList: true, subtree: true });
                }, { once: true });
            }

            const updateHooksState = () => {
                const active = this.stateManager.get('app.scriptActive');
                const hasPlaying = [...(this.stateManager.get('media.activeMedia')||[])].some(v => v && v.tagName==='VIDEO' && !v.paused && v.readyState>=2);
                const sensitive = isSensitiveContext();
                if (!sensitive) enableShadowHook();
                if (active && hasPlaying && !sensitive && document.visibilityState === 'visible') enablePropertyHooks(); else if (!active || sensitive) disableAllHooks();
            };
            this._updateHooksState = updateHooksState;
            this.subscribe('app.pluginsInitialized', () => safeGuard(() => {
                this.scanAndApply(); this.runStartupBoost();
                on(document, 'addShadowRoot', (e) => { if (e.detail && e.detail.shadowRoot) { this._domDirty = true; registerShadowRoot(e.detail.shadowRoot); } }, P(this._ac.signal));
                on(document, 'load', (e) => { const t = e.target; if (t && t.tagName === 'IMG') { if (this.stateManager.get('ui.areControlsVisible')) scheduleScan(t, true); } }, CP(this._ac.signal));
                MEDIA_EVENTS.forEach(evt => on(document, evt, (e) => { const t = e.target; if (t && t.tagName === 'VIDEO') { const now = performance.now(); const last = this._lastImmediateScan.get(t) || 0; if (now - last > 120) { this._lastImmediateScan.set(t, now); scheduleScan(t, true); } } }, CP(this._ac.signal)));
                this.scheduleNextScan();
            }, 'CoreMedia pluginsInitialized'));
            this.subscribe('app.scriptActive', (active) => { updateHooksState(); if (active) { collectOpenShadowRootsOnce(); triggerBurstScan(250); } this.updateGlobalAttrObs(active); });
            this.subscribe('videoFilter.autoExposure', () => this.updateGlobalAttrObs(this.stateManager.get('app.scriptActive')));
            this.subscribe('media.activeMedia', () => updateHooksState()); updateHooksState();
            const throttledReset = throttle(() => this.resetScanInterval(), 300); ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(evt => on(document, evt, throttledReset, CP(this._ac.signal)));
            if ('ResizeObserver' in window) { this._resizeObs = new ResizeObserver(throttle(entries => { for (const e of entries) { if (e.target.tagName === 'VIDEO' || e.target.tagName === 'IMG') scheduleScan(null); } }, 200)); }
            if (this.stateManager.get('app.scriptActive')) this.updateGlobalAttrObs(true);
        }
        updateGlobalAttrObs(active) {
            if (!CONFIG.FLAGS.GLOBAL_ATTR_OBS) return;
            const sm = this.stateManager;
            // [v42] Optimization: Only enable global obs if absolutely needed
            const reallyNeeded = active && (sm.get('ui.areControlsVisible') || (sm.get('videoFilter.autoExposure') && !document.hidden && sm.get('media.currentlyVisibleMedia')));

            if (reallyNeeded && !this._globalAttrObs) {
                this._globalAttrObs = new MutationObserver(throttle((ms) => { let dirty = false; for (const m of ms) { if (m.target && ['VIDEO','IMG','IFRAME','SOURCE'].includes(m.target.nodeName)) { dirty = true; break; } } if (dirty) { this._domDirty = true; } }, IS_MOBILE ? 300 : 200));
                this._globalAttrObs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS });
            } else if (!reallyNeeded && this._globalAttrObs) { this._globalAttrObs.disconnect(); this._globalAttrObs = null; }
        }
        runStartupBoost() { const aggressiveScan = () => { if (this.stateManager.get('media.activeMedia').size === 0) scheduleScan(null, true); }; [300, 1500, 5000].forEach(d => setTimeout(aggressiveScan, d)); }
        destroy() {
            super.destroy(); _corePluginRef = null; if (VideoAnalyzer._worker) { VideoAnalyzer._worker.terminate(); VideoAnalyzer._worker = null; } if (VideoAnalyzer._workerUrl) URL.revokeObjectURL(VideoAnalyzer._workerUrl);
            if (this._historyOrig) { history.pushState = this._historyOrig.pushState; history.replaceState = this._historyOrig.replaceState; this._historyOrig = null; }
            if (this.mainObserver) this.mainObserver.disconnect(); if (this.intersectionObserver) this.intersectionObserver.disconnect();
            if (this.scanTimerId) clearTimeout(this.scanTimerId); if (this._resizeObs) this._resizeObs.disconnect(); if (this._globalAttrObs) this._globalAttrObs.disconnect();
            if (this._backoffInterval) clearInterval(this._backoffInterval);
            disableAllHooks();
        }
        tick() {
            if (this._domDirty) { this._domDirty = false; scheduleScan(null); }
            const nowSens = isSensitiveContext(); if (this._lastSensitive !== nowSens) { this._lastSensitive = nowSens; try { this._updateHooksState?.(); } catch {} }
            this._pruneDisconnected();
            if (_localShadowRoots.length > 0 && Date.now() - this._lastShadowPrune > 15000) {
                this._lastShadowPrune = Date.now();
                let i = _localShadowRoots.length; while (i--) { const r = _localShadowRoots[i]; if (!r || !r.host || !r.host.isConnected) {
                    if (r[VSC_SR_MO]) r[VSC_SR_MO].disconnect();
                    _localShadowRoots.splice(i, 1);
                    _localShadowSet.delete(r);
                } }
            }
            if (this.stateManager.get('app.scriptActive') && !this._globalAttrObs) { const now = Date.now(); if (!this._lastAttrObsProbe || now - this._lastAttrObsProbe > 8000) { this._lastAttrObsProbe = now; this.updateGlobalAttrObs(true); } }
            const sm = this.stateManager; const hasPotential = document.getElementsByTagName('video').length > 0 || document.getElementsByTagName('iframe').length > 0;
            if (!sm.get('app.scriptActive') && !sm.get('ui.areControlsVisible')) {
                this.currentScanInterval = 15000;
            } else if ((sm.get('media.activeMedia').size > 0) || hasPotential) {
                this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval;
            } else {
                this.emptyScanCount++; if (this.emptyScanCount > 3) this.currentScanInterval = Math.min(CONFIG.SCAN.INTERVAL_MAX, this.currentScanInterval * 1.5);
            }
            this.scheduleNextScan();
        }
        ensureObservers() {
            if (!this.intersectionObserver) {
                const margin = IS_MOBILE ? '80px 0px 120px 0px' : '200px 0px 200px 0px'; // [v43] Mobile optimization
                this.intersectionObserver = new IntersectionObserver(entries => {
                    let needsUpdate = false;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        if (this.stateManager.get('media.visibilityMap')) this.stateManager.get('media.visibilityMap').set(e.target, isVisible);
                        if (e.target.tagName === 'VIDEO') { if (isVisible) this._visibleVideos.add(e.target); else this._visibleVideos.delete(e.target); needsUpdate = true; }
                    });
                    if (needsUpdate) {
                         // [v38] Update visTick to force filter update
                         const t = this.stateManager.get('media.visTick') || 0;
                         this.stateManager.set('media.visTick', t + 1);

                         if (!document.hidden) {
                             if (this._centerCalcTimer) clearTimeout(this._centerCalcTimer);
                             this._centerCalcTimer = setTimeout(() => {
                                 if (this._visibleVideos.size === 0) return;
                                 const currentBest = this.stateManager.get('media.currentlyVisibleMedia');
                                 const newBest = VideoAnalyzer._pickBestVideoNow();
                                 if (newBest && newBest !== currentBest) {
                                     if (currentBest) VideoAnalyzer.stop();
                                     this.stateManager.set('media.currentlyVisibleMedia', newBest);
                                     const vf = this.stateManager.get('videoFilter');
                                     if (this.stateManager.get('app.scriptActive') && (vf.autoExposure || vf.clarity > 0)) VideoAnalyzer.start(newBest, { autoExposure: vf.autoExposure, clarity: vf.clarity });
                                 }
                             }, 300);
                         }
                    }
                }, { threshold: [0, 0.25, 0.5], rootMargin: margin });
            }
        }
        scheduleNextScan() { if (this.scanTimerId) clearTimeout(this.scanTimerId); this.scanTimerId = setTimeout(() => { if (document.hidden) { this.currentScanInterval = this.baseScanInterval; this.scheduleNextScan(); return; } safeGuard(() => { this.tick(); }, 'tick'); }, this.currentScanInterval); }
        resetScanInterval() { this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval; if (this.scanTimerId) { clearTimeout(this.scanTimerId); this.scheduleNextScan(); } }
        scanAndApply() {
            this.ensureObservers();
            this._processAllElements(!this._didInitialShadowFullScan);
            this._didInitialShadowFullScan = true;
        }
        _processAllElements(skipShadowScan = false) {
             const r = this.findAllElements(document, 0, skipShadowScan);
             this._applyToSets(r.media, r.images, r.iframes);
        }
        _checkAndAdd(node, media, images, iframes) {
             if (node.tagName === 'VIDEO') media.add(node);
             else if (node.tagName === 'CANVAS') {
                 if (node.width > 150 && node.height > 100) media.add(node);
             }
             else if (node.tagName === 'IMG') { if (this.stateManager.get('ui.areControlsVisible')) images.add(node); }
             else if (node.tagName === 'IFRAME') { this._hookIframe(node); iframes.add(node); }
             else if (node.tagName === 'SOURCE' && node.parentNode && node.parentNode.tagName === 'VIDEO') media.add(node.parentNode);
        }
        findAllElements(root, depth, skipShadowScan) {
            const media = new Set(), images = new Set(), iframes = new Set();
            if (!root || depth > CONFIG.SCAN.MAX_DEPTH) return { media, images, iframes };

            // [v44] Use getByTag for ShadowRoot compatibility
            const videos = Utils.getByTag(root, 'video');
            for (let i = 0; i < videos.length; i++) this._checkAndAdd(videos[i], media, images, iframes);

            const canvases = Utils.getByTag(root, 'canvas');
            for (let i = 0; i < canvases.length; i++) this._checkAndAdd(canvases[i], media, images, iframes);

            const frames = Utils.getByTag(root, 'iframe');
            for (let i = 0; i < frames.length; i++) this._checkAndAdd(frames[i], media, images, iframes);

            for (let i = 0; i < frames.length; i++) {
                // v132.0.12: Smart Iframe Cache
                const doc = this._tryGetIframeDoc(frames[i]);
                if (doc) {
                    const r = this.findAllElements(doc, depth + 1, true);
                    r.media.forEach(m => media.add(m));
                }
            }

            if (this.stateManager.get('ui.areControlsVisible')) {
                const imgs = Utils.getByTag(root, 'img');
                for (let i = 0; i < imgs.length; i++) this._checkAndAdd(imgs[i], media, images, iframes);
            }

            if (!skipShadowScan) {
                const BATCH_SIZE = 20;
                const total = _localShadowRoots.length;
                for (let i = 0; i < BATCH_SIZE && i < total; i++) {
                    const idx = (this._shadowScanIndex + i) % total;
                    const sr = _localShadowRoots[idx];
                    if (sr) {
                         try { const r = this.findAllElements(sr, depth + 1, true); r.media.forEach(m => media.add(m)); r.images.forEach(i => images.add(i)); r.iframes.forEach(f => iframes.add(f)); } catch(e){}
                    }
                }
                this._shadowScanIndex = (this._shadowScanIndex + BATCH_SIZE) % total;
            }
            return { media, images, iframes };
        }
        scanSpecificRoot(root) {
            this.ensureObservers();
            const media = new Set(), images = new Set(), iframes = new Set();
            if (root.nodeType === 1 && (root.tagName === 'VIDEO' || root.tagName === 'IMG')) this._checkAndAdd(root, media, images, iframes);
            else { const r = this.findAllElements(root, 0, true); r.media.forEach(m=>media.add(m)); r.images.forEach(i=>images.add(i)); r.iframes.forEach(f=>iframes.add(f)); }
            this._applyToSets(media, images, iframes);
        }
        _applyToSets(mediaSet, imageSet, iframeSet) {
             const sm = this.stateManager;
             const curM = new Set(sm.get('media.activeMedia')), curI = new Set(sm.get('media.activeImages')), curF = new Set(sm.get('media.activeIframes'));
             let ch = false;
             mediaSet.forEach(m => { if (m.isConnected && this.attachMediaListeners(m) && !curM.has(m)) { curM.add(m); ch = true; } });
             imageSet.forEach(i => { if (i.isConnected && this.attachImageListeners(i) && !curI.has(i)) { curI.add(i); ch = true; } });
             iframeSet.forEach(f => { if (f.isConnected && this.attachIframeListeners(f) && !curF.has(f)) { curF.add(f); ch = true; } });
             if (ch) { sm.set('media.activeMedia', curM); sm.set('media.activeImages', curI); sm.set('media.activeIframes', curF); if (!sm.get('ui.globalContainer')) sm.set('ui.createRequested', true); }
        }
        _hookIframe(frame) {
            if (!frame || this._seenIframes.has(frame)) return; this._seenIframes.add(frame);
            const onLoad = () => { triggerBurstScan(200); };
            try { frame.addEventListener('load', onLoad, { passive: true }); } catch (e) { }
        }
        attachMediaListeners(media) {
            // v132.0.10: Robust re-attach check
            const owner = media.getAttribute('data-vsc-controlled-by');
            if (owner && owner !== VSC_INSTANCE_ID) return false;

            try { this.intersectionObserver.observe(media); } catch (e) { return false; }
            media.setAttribute('data-vsc-controlled-by', VSC_INSTANCE_ID);
            if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);

            if (media.tagName === 'VIDEO') {
                const attrMo = new MutationObserver(debounce((mutations) => {
                    for(const m of mutations) if(m.type==='attributes') { VideoAnalyzer.taintedResources.delete(media); scheduleScan(media, true); }
                }, 100));
                const hasSource = !!media.querySelector('source');
                attrMo.observe(media, { attributes: true, subtree: hasSource, attributeFilter: ['src', 'poster', 'data-src'] });
                this.stateManager.get('media.mediaListenerMap').set(media, () => { attrMo.disconnect(); });
            }

            if (this._resizeObs) this._resizeObs.observe(media);
            // [v46] Relax locks on attach
            relaxMediaLocks(media);
            return true;
        }
        detachMediaListeners(media) {
             const listenerMap = this.stateManager.get('media.mediaListenerMap');
             const cleanup = listenerMap.get(media); if (cleanup) cleanup(); listenerMap.delete(media);
             try { this.intersectionObserver.unobserve(media); } catch (e) { } this._visibleVideos.delete(media);
             if (this._resizeObs) this._resizeObs.unobserve(media);
             try { media.removeAttribute('data-vsc-controlled-by'); } catch {}
        }
        attachImageListeners(image) {
             if (!image || !this.intersectionObserver) return false;
             if (image.naturalWidth > 0 && image.naturalWidth < 32) return false;

             if (this.stateManager.filterManagers.image) injectFiltersIntoContext(image, this.stateManager.filterManagers.image, this.stateManager);
             if (!this._observedImages.has(image)) { try { this.intersectionObserver.observe(image); this._observedImages.add(image); if (this._resizeObs) this._resizeObs.observe(image); } catch (e) { return false; } }
             return true;
        }
        attachIframeListeners(iframe) {
            if (!iframe || !this.intersectionObserver) return false;
            if (this.stateManager.filterManagers.video) injectFiltersIntoContext(iframe, this.stateManager.filterManagers.video, this.stateManager);
            try { this.intersectionObserver.observe(iframe); } catch(e) { return false; }
            return true;
        }
        _pruneDisconnected() {
             const sm = this.stateManager;
             const prune = (key, detachFn) => {
                 const set = sm.get(key); if(!set) return; let ch = false; const next = new Set();
                 for(const el of set) { if(el && el.isConnected) next.add(el); else { if(detachFn) detachFn(el); ch = true; } }
                 if(ch) sm.set(key, next);
             };
             prune('media.activeMedia', this.detachMediaListeners.bind(this));
             prune('media.activeImages', (img) => {
                 try { this.intersectionObserver.unobserve(img); } catch {}
                 if(this._resizeObs) this._resizeObs.unobserve(img);
                 this._observedImages.delete(img);
             });
             prune('media.activeIframes', (fr) => {
                 try { this.intersectionObserver.unobserve(fr); } catch {}
             });
        }
    }

    class SvgFilterPlugin extends Plugin {
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this._mediaStateRafId = null; this.isGlobalBypass = false; }
        init(stateManager) {
            super.init(stateManager);
            this.filterManager = this._createManager({ settings: CONFIG.FILTER.SETTINGS, svgId: 'vsc-video-svg-filters', styleId: 'vsc-video-styles', className: 'vsc-video-filter-active', isImage: false });
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
            // videoFilter.targetLuma removed
            this.subscribe('imageFilter.level', (val) => { this.applyAllImageFilters(); if (val > 0) { const core = window.vscPluginManager?.plugins?.find(p => p.name === 'CoreMedia'); if (core) core.scanAndApply(); } });
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            // [v38] Changed subscription key to visTick
            this.subscribe('media.visTick', () => this.updateMediaFilterStates());
            this.subscribe('ui.areControlsVisible', () => this.updateMediaFilterStates()); this.subscribe('app.scriptActive', () => { this.updateMediaFilterStates(); });

            this.throttledUpdate = throttle((e) => {
                const { autoParams, videoInfo, aeActive } = e.detail;
                const currentMedia = this.stateManager.get('media.currentlyVisibleMedia');
                if (videoInfo && videoInfo !== currentMedia) return;

                const vf = this.stateManager.get('videoFilter');
                if (!vf.autoExposure && vf.clarity <= 0) return;

                let isChanged = false;
                if (vf.autoExposure) {
                    isChanged = Math.abs(this.lastAutoParams.gamma - autoParams.gamma) > 0.003 ||
                                Math.abs(this.lastAutoParams.bright - autoParams.bright) > 0.2 ||
                                Math.abs((this.lastAutoParams.linearGain || 1.0) - (autoParams.linearGain || 1.0)) > 0.01;
                }
                if (!isChanged && vf.clarity > 0) {
                    isChanged = Math.abs(this.lastAutoParams.clarityComp - autoParams.clarityComp) > 0.2;
                }

                this.lastAutoParams = autoParams;
                this.lastAutoParams.aeActive = aeActive;
                this.applyAllVideoFilters();

            }, 100);

            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
            if (this.stateManager.get('app.scriptActive')) { this.filterManager.init(); this.imageFilterManager.init(); this.applyAllVideoFilters(); this.applyAllImageFilters(); }

            this._pruneTimer = setInterval(() => {
                if (document.hidden) return; // [v43] Suspend interval
                if (this.filterManager) this.filterManager.prune();
                if (this.imageFilterManager) this.imageFilterManager.prune();
                const v = this.stateManager.get('media.currentlyVisibleMedia');
                if (v && v.isConnected) this._updateVideoFilterState(v);
            }, 3000);
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
                constructor(options) { this._isInitialized = false; this._styleElement = null; this._svgNode = null; this._options = options; this._elementCache = new WeakMap(); this._activeFilterRoots = new Set(); this._globalToneCache = { key: null, table: null }; this._gainTableCache = new Map(); this._lastValues = null; this._clarityTableCache = new Map(); }
                isInitialized() { return this._isInitialized; } getSvgNode() { return this._svgNode; } getStyleNode() { return this._styleElement; }
                init() { if (this._isInitialized) return; safeGuard(() => {
                    const { svgNode, styleElement } = this._createElements();
                    this._svgNode = svgNode; this._styleElement = styleElement;
                    const container = document.body || document.documentElement;
                    if (container) container.appendChild(svgNode);
                    else { document.addEventListener('DOMContentLoaded', () => { document.body.appendChild(svgNode); }); }
                    (document.head || document.documentElement).appendChild(styleElement);
                    this._activeFilterRoots.add(this._svgNode);
                    this._isInitialized = true;
                }, `${this.constructor.name}.init`); }
                registerContext(svgElement) { this._activeFilterRoots.add(svgElement); }

                // v132.0.13: Safe Prune (No delete while iterating)
                prune() {
                    const dead = [];
                    for (const root of this._activeFilterRoots) {
                        if (!root || !root.isConnected) dead.push(root);
                    }
                    dead.forEach(root => {
                        this._activeFilterRoots.delete(root);
                        this._elementCache.delete(root);
                    });
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
                        if (includeGrain && !isImage) {
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

                            // v132.0.28: Integrated Gain+Rolloff Node
                            const linearExp = createSvgElement('feComponentTransfer', { "data-vsc-id": "linear_exposure", in: "saturate_out", result: "linear_out" });
                            ['R','G','B'].forEach(c => linearExp.append(createSvgElement('feFunc'+c, { "data-vsc-id": "exposure_func", type:"table", tableValues:"0 1" }))); // Use tableValues instead of slope

                            const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "linear_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA).toString() })));
                            const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));
                            const colorTemp = createSvgElement('feComponentTransfer', { "data-vsc-id": "post_colortemp", in: "tone_out", result: "final_out" });
                            colorTemp.append(createSvgElement('feFuncR', { "data-vsc-id": "ct_red", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncG', { "data-vsc-id": "ct_green", type: "linear", slope: "1", intercept: "0" }));
                            colorTemp.append(createSvgElement('feFuncB', { "data-vsc-id": "ct_blue", type: "linear", slope: "1", intercept: "0" }));
                            filter.append(lumaContrast, saturation, linearExp, gamma, toneCurve, colorTemp);
                        }
                        return filter;
                    };
                    svg.append(buildChain(combinedFilterId, true));
                    if (!isImage) svg.append(buildChain(combinedFilterNoGrainId, false));
                    return { svgNode: svg, styleElement: style };
                }
                updateFilterValues(values) {
                    if (!this.isInitialized()) return;
                    const v = (val) => (val === undefined || val === null) ? 0 : Number(val);
                    // [v32] Optimization: Quantize gain for cache key
                    const gain = (values.linearGain == null) ? 1.0 : Number(values.linearGain);
                    const gainQ = Math.round(gain * 100) / 100;
                    const sig = [v(values.gamma), v(values.sharpenLevel), v(values.level2), v(values.colorTemp), v(values.saturation), v(values.shadows), v(values.highlights), v(values.brightness), v(values.contrastAdj), v(values.dither), v(values.clarity), gainQ, values.autoExposure ? 1 : 0].join('|');
                    if (this._lastValues === sig) return; this._lastValues = sig;

                    const { saturation, gamma, sharpenLevel, level2, shadows, highlights, brightness, contrastAdj, colorTemp, dither, clarity } = values;
                    let currentToneTable = null; const contrastSafe = (contrastAdj == null) ? 1.0 : Number(contrastAdj);
                    const toneKey = (shadows !== undefined) ? `${(+shadows).toFixed(2)}_${(+highlights).toFixed(2)}_${(+brightness || 0).toFixed(2)}_${(+contrastSafe || 1).toFixed(3)}` : null;
                    if (toneKey) {
                        if (this._globalToneCache.key !== toneKey) {
                            const genSCurveTable = (sh, hi, br = 0, contrast = 1.0) => {
                                const steps = 256; const vals = []; const clamp = Utils.clamp; const smoothstep = (t) => t * t * (3 - 2 * t);
                                const shN = clamp((sh || 0) / 100, -1, 1); const hiN = clamp((hi || 0) / 100, -1, 1); const b = clamp((br || 0) / 100, -1, 1) * 0.12; const c = clamp(Number(contrast || 1.0), 0.8, 1.4);
                                const toe = clamp(0.20 + shN * 0.10, 0.05, 0.40);
                                const shoulder = clamp(0.82 - hiN * 0.06, 0.70, 0.95);
                                const toeStrength = 0.18 + 0.22 * Math.abs(shN); const shoulderStrength = 0.08 + 0.18 * Math.abs(hiN);
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
                                ctRed: rootNode.querySelectorAll('[data-vsc-id="ct_red"]'), ctGreen: rootNode.querySelectorAll('[data-vsc-id="ct_green"]'), ctBlue: rootNode.querySelectorAll('[data-vsc-id="ct_blue"]'), lumaContrastMatrix: rootNode.querySelectorAll('[data-vsc-id="luma_contrast_matrix"]'), clarityFuncs: rootNode.querySelectorAll('[data-vsc-id="clarity_func"]'), grainComp: rootNode.querySelector('[data-vsc-id="grain_comp"]'),
                                exposureFuncs: rootNode.querySelectorAll('[data-vsc-id="exposure_func"]'),
                                appliedToneKey: null
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
                            if (IS_MOBILE) strFine *= 0.8;
                            const sCurve = (x) => x * x * (3 - 2 * x); const fineProgress = Math.min(1, strFine / 3.0); const fineSigma = 0.5 - (sCurve(fineProgress) * 0.3); const fineK = sCurve(fineProgress) * 3.5; const coarseProgress = Math.min(1, strCoarse / 3.0); const coarseSigma = 1.5 - (sCurve(coarseProgress) * 0.8); const coarseK = sCurve(coarseProgress) * 2.0; const safeFineK = Math.min(6.0, fineK); const safeCoarseK = Math.min(4.0, coarseK);
                            if (strFine <= 0.01) { cache.blurFine.forEach(el => Utils.setAttr(el, 'stdDeviation', "0")); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { cache.blurFine.forEach(el => Utils.setAttr(el, 'stdDeviation', fineSigma.toFixed(2))); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeFineK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeFineK).toFixed(3)); }); }
                            if (strCoarse <= 0.01) { cache.blurCoarse.forEach(el => Utils.setAttr(el, 'stdDeviation', "0")); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { cache.blurCoarse.forEach(el => Utils.setAttr(el, 'stdDeviation', coarseSigma.toFixed(2))); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeCoarseK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeCoarseK).toFixed(3)); }); }
                        }
                        if (dither !== undefined && cache.grainComp) { const val = dither / 100; const amount = val * 0.25; Utils.setAttr(cache.grainComp, 'k3', amount.toFixed(3)); }
                        if (saturation !== undefined && cache.saturate) cache.saturate.forEach(el => Utils.setAttr(el, 'values', (saturation / 100).toString()));

                        // [v33] Optimized Unified Gain+Rolloff Table Construction with Caching & SQRT Knee
                        if (cache.exposureFuncs) {
                            const gainKey = `gain_${gainQ.toFixed(2)}`;
                            let tableVal = this._gainTableCache.get(gainKey);

                            if (!tableVal) {
                                if (Math.abs(gainQ - 1.0) < 0.01) {
                                    tableVal = "0 1";
                                } else if (gainQ <= 1.0) {
                                    tableVal = `0 ${gainQ.toFixed(4)}`;
                                } else {
                                    // [v33] SQRT-based Knee for Softer Rolloff
                                    const steps = 256;
                                    const vals = [];
                                    const knee = Utils.clamp(0.80 / Math.sqrt(gainQ), 0.45, 0.80); // Softer knee
                                    for (let i = 0; i < steps; i++) {
                                        let x = i / (steps - 1);
                                        let y;
                                        if (x < knee) {
                                            y = x * gainQ;
                                        } else {
                                            // Smooth transition to 1.0
                                            const t = (x - knee) / (1 - knee);
                                            const y_start = knee * gainQ;
                                            const headroom = 1.0 - y_start;
                                            const smoothT = t * (2 - t); // Quadratic ease-out
                                            y = y_start + headroom * smoothT;
                                        }
                                        vals.push(Math.round(Utils.clamp(y, 0, 1) * 10000) / 10000);
                                    }
                                    tableVal = vals.join(' ');
                                }
                                this._gainTableCache.set(gainKey, tableVal);
                            }
                            cache.exposureFuncs.forEach(el => Utils.setAttr(el, 'tableValues', tableVal));
                        }

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
                // v132.0.13: Explicit reset
                this.filterManager.updateFilterValues({ saturation: 100, gamma: 1.0, blur: 0, sharpenLevel: 0, level2: 0, shadows: 0, highlights: 0, brightness: 0, contrastAdj: 1.0, colorTemp: 0, dither: 0, clarity: 0, linearGain: 1.0, autoExposure: 0 });
                VideoAnalyzer.stop(); this.updateMediaFilterStates(); return;
            }
            const vf = this.stateManager.get('videoFilter');
            const auto = this.lastAutoParams || { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 };

            const aeOn = !!vf.autoExposure;
            const clOn = (vf.clarity > 0);

            const autoGain = aeOn ? (auto.linearGain || 1.0) : 1.0;
            const autoGamma = aeOn ? (auto.gamma || 1.0) : 1.0;
            const autoBright = aeOn ? (auto.bright || 0) : 0;
            const autoShadows = aeOn ? (auto.shadowsAdj || 0) : 0;
            const autoHighlights = aeOn ? (auto.highlightsAdj || 0) : 0;

            const clarityComp = clOn ? (auto.clarityComp || 0) : 0;

            const finalGamma = Utils.clamp(vf.gamma * autoGamma, 0.5, 2.5);
            let finalBrightness = vf.brightness + autoBright + clarityComp;
            let finalShadows = vf.shadows + autoShadows;
            let finalHighlights = vf.highlights + autoHighlights;
            let finalContrastAdj = vf.contrastAdj;
            let finalSaturation = vf.saturation;

            // --- [v132.0.35 Simplified Gain Logic] ---
            const totalGain = (autoGain || 1.0); // AE Only. No manual gain.

            // [v34] Use local variables, DO NOT mutate state directly
            let effectiveClarity = vf.clarity;
            let autoSharpLevel2 = vf.level2;
            if (effectiveClarity > 0) { autoSharpLevel2 += Math.min(5, effectiveClarity * 0.15); }
            if (VideoAnalyzer._highMotion) autoSharpLevel2 *= 0.7;

            // [Bonus: High-Gain Clarity/Sharp Dampening]
            if (totalGain > 1.05) {
                // v34: Removed automatic damping of Clarity/Sharpness to respect user settings ("Minimal Intervention")
                // Only touch highlights/sat/shadows if strictly necessary
                const boostFactor = totalGain - 1.0;

                // [v34] Conditional Secondary Adjustments (P90 Gate)
                // Use VideoAnalyzer._p90Ema directly if available
                const currentP90 = (typeof VideoAnalyzer !== 'undefined' && VideoAnalyzer._p90Ema) ? VideoAnalyzer._p90Ema : 0;
                // Gate: 0 if no highlights, 1 if highlights > 0.85
                const p90Gate = Utils.clamp((currentP90 - 0.85) / 0.10, 0, 1);

                // Use '+=' because in this script logic, positive highlights = dampening/recovery (darken).
                finalHighlights += (boostFactor * 12) * p90Gate;
                finalSaturation -= Math.min(4, boostFactor * 4) * p90Gate;
                // Minimize shadow crush
                finalShadows -= (boostFactor * 0.3) * p90Gate;
            }
            // ------------------------------------

            const v = this.stateManager.get('media.currentlyVisibleMedia');
            if (v && v.tagName === 'VIDEO') {
                const vw = v.videoWidth || 0, vh = v.videoHeight || 0;
                const cw = v.clientWidth || 0, ch = v.clientHeight || 0;
                if (vw && vh && cw && ch) {
                    const sx = cw / vw; const sy = ch / vh; const scale = Math.max(sx, sy);
                    let off = 0; if (scale > 1.15) off = (scale - 1.15) * 8; else if (scale < 0.90) off = -(0.90 - scale) * 6;
                    off = Math.max(-6, Math.min(6, off));
                    if (IS_MOBILE) off *= 0.7;
                    autoSharpLevel2 = Utils.clamp(autoSharpLevel2 + off, 0, IS_MOBILE ? 18 : 30);
                }
            }

            const isUserNeutral = vf.level === 0 && vf.level2 === 0 &&
                                  Math.abs(vf.gamma - 1.0) < 0.001 &&
                                  vf.brightness === 0 &&
                                  Math.abs(vf.contrastAdj - 1.0) < 0.001 &&
                                  vf.saturation === 100 &&
                                  vf.shadows === 0 && vf.highlights === 0 &&
                                  vf.colorTemp === 0 && vf.dither === 0 &&
                                  vf.clarity === 0;

            const isAutoNeutral = !vf.autoExposure || (
                Math.abs((auto.linearGain || 1.0) - 1.0) < 0.002 &&
                Math.abs((auto.gamma || 1.0) - 1.0) < 0.002 &&
                Math.abs((auto.bright || 0)) < 0.5
            );

            this.isGlobalBypass = isUserNeutral && isAutoNeutral;

            // [v41] Stop Analyzer if bypass (CPU Saver)
            if (this.isGlobalBypass) {
                if (!vf.autoExposure && vf.clarity <= 0) {
                     VideoAnalyzer.stop();
                }
            }

            const values = {
                saturation: finalSaturation,
                gamma: finalGamma,
                blur: 0,
                sharpenLevel: vf.level,
                level2: autoSharpLevel2,
                shadows: finalShadows,
                highlights: finalHighlights,
                brightness: finalBrightness,
                contrastAdj: finalContrastAdj,
                colorTemp: vf.colorTemp,
                dither: vf.dither,
                clarity: effectiveClarity, // Use effective value
                autoExposure: vf.autoExposure,
                linearGain: totalGain
            };
            this.filterManager.updateFilterValues(values);
            // Pass effectiveClarity to analyzer for consistent logic
            VideoAnalyzer.updateSettings({ autoExposure: vf.autoExposure, clarity: effectiveClarity });
            this.updateMediaFilterStates();
        }
        applyAllImageFilters() { if (this._imageRafId) return; this._imageRafId = requestAnimationFrame(() => { this._imageRafId = null; if (!this.imageFilterManager.isInitialized()) return; const active = this.stateManager.get('app.scriptActive'); const level = active ? this.stateManager.get('imageFilter.level') : 0; const colorTemp = active ? this.stateManager.get('imageFilter.colorTemp') : 0; let scaleFactor = IS_MOBILE ? 0.8 : 1.0; const values = { sharpenLevel: level * scaleFactor, colorTemp: colorTemp }; this.imageFilterManager.updateFilterValues(values); this.updateMediaFilterStates(); }); }
        updateMediaFilterStates() { if (this._mediaStateRafId) return; this._mediaStateRafId = requestAnimationFrame(() => { this._mediaStateRafId = null; this.stateManager.get('media.activeMedia').forEach(media => { if (media.tagName === 'VIDEO' || media.tagName === 'CANVAS') this._updateVideoFilterState(media); }); this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); }); this.stateManager.get('media.activeIframes').forEach(iframe => { this._updateVideoFilterState(iframe); }); }); }

        _getFilterCheckTs(el) { if (!this._filterCheckMap) this._filterCheckMap = new WeakMap(); return this._filterCheckMap.get(el) || 0; }
        _setFilterCheckTs(el, ts) { if (!this._filterCheckMap) this._filterCheckMap = new WeakMap(); this._filterCheckMap.set(el, ts); }

        _updateVideoFilterState(video) {
            const scriptActive = this.stateManager.get('app.scriptActive'); const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.shadows !== 0 || vf.highlights !== 0 || vf.brightness !== 0 || Math.abs(vf.contrastAdj - 1.0) > 0.001 || vf.colorTemp !== 0 || vf.dither > 0 || vf.autoExposure > 0 || vf.clarity !== 0;
            const isVisRaw = this.stateManager.get('media.visibilityMap').get(video);
            const isVis = (isVisRaw !== false);
            // v132.0.13: Bypass logic
            const isActive = scriptActive && isVis && shouldApply && !this.isGlobalBypass;

            if (isActive) {
                injectFiltersIntoContext(video, this.filterManager, this.stateManager);
                if (video === this.stateManager.get('media.currentlyVisibleMedia')) { if (video.style.willChange !== 'filter, transform') video.style.willChange = 'filter, transform'; } else { if (video.style.willChange) video.style.willChange = ''; }
            } else { if (video.style.willChange) video.style.willChange = ''; }

            const sid = this.filterManager._options.settings.SHARPEN_ID;
            const useNoGrain = (vf.dither === 0);
            const filterId = useNoGrain ? `${sid}_combined_filter_nograin` : `${sid}_combined_filter`;
            const filterCss = `url("#${filterId}")`;

            if (isActive) {
                video.classList.add('vsc-video-filter-active');
                requestAnimationFrame(() => {
                    const now = performance.now(); const last = this._getFilterCheckTs(video); if (now - last < 1200) return; this._setFilterCheckTs(video, now);

                    // [v38] Optimization: Skip check if video not visible
                    if (!isVis) return;

                    const cs = window.getComputedStyle(video);

                    const norm = (s) => (s || '').replace(/\s+/g,'').replace(/"/g,'');
                    const currentFilter = norm(cs.filter) + norm(cs.webkitFilter);
                    const targetFilter = norm(filterCss);

                    if (!currentFilter.includes(targetFilter) && !currentFilter.includes('combined_filter')) {
                        this.setInlineFilter(video, filterCss);
                    } else {
                        this.restoreInlineFilter(video);
                    }

                    setTimeout(() => {
                        if (!video.isConnected) return;
                        if (video.dataset.vscInlineFilter !== '1') {
                            const cs2 = window.getComputedStyle(video);
                            const cur2 = norm(cs2.filter) + norm(cs2.webkitFilter);
                            if (!cur2.includes(targetFilter) && !cur2.includes('combined_filter')) this.setInlineFilter(video, filterCss);
                        }
                    }, 400);
                });
            } else {
                video.classList.remove('vsc-video-filter-active');
                this.restoreInlineFilter(video);
            }

            if (useNoGrain) video.classList.add('no-grain'); else video.classList.remove('no-grain');
        }
        _updateImageFilterState(image) {
            const scriptActive = this.stateManager.get('app.scriptActive'); if (!scriptActive) { image.classList.remove('vsc-image-filter-active'); return; }
            const level = this.stateManager.get('imageFilter.level'); const colorTemp = this.stateManager.get('imageFilter.colorTemp');
            const shouldApply = level > 0 || colorTemp !== 0;
            const isVisRaw = this.stateManager.get('media.visibilityMap').get(image);
            const isVis = (isVisRaw !== false);
            const isActive = isVis && shouldApply;
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
            on(document, 'ratechange', (e) => {
                const v = e.target;
                if (v && v.tagName === 'VIDEO') {
                    const cur = this.stateManager.get('playback.currentRate');
                    if (Math.abs(v.playbackRate - cur) > 0.05) {
                        this.stateManager.set('playback.currentRate', v.playbackRate);
                    }
                }
            }, CP(this._ac.signal));
        }
        setPlaybackRate(rate) {
            this.stateManager.get('media.activeMedia').forEach(media => {
                if (media.tagName !== 'VIDEO') return;
                if (Math.abs((media.playbackRate || 1) - rate) < 0.01) return;
                try { media.playbackRate = rate; } catch { }
            });
            this.stateManager.set('playback.currentRate', rate);
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
            this.subscribe('playback.currentRate', rate => { this.updateActiveSpeedButton(rate); this.showToast(`${rate.toFixed(2)}x`); });
            this.subscribe('ui.warningMessage', msg => this.showToast(msg));
            this.subscribe('ui.areControlsVisible', () => { this.updateTriggerStyle(); });
            this.subscribe('app.scriptActive', () => this.updateTriggerStyle());

            const vscMessage = Utils.safeGetItem('vsc_message'); if (vscMessage) { this.showToast(vscMessage); Utils.safeRemoveItem('vsc_message'); }
            this.boundFullscreenChange = () => { const fullscreenRoot = document.fullscreenElement || document.body; if (this.globalContainer && this.globalContainer.parentElement !== fullscreenRoot) { fullscreenRoot.appendChild(this.globalContainer); } };
            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
            const savedPos = Utils.safeGetItem('vsc_ui_pos'); if (savedPos) { try { const p = JSON.parse(savedPos); this.uiState = p; } catch { } }
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
            this.globalContainer.id = 'vsc-global-container';
            this.globalContainer.setAttribute('data-vsc-internal', '1');
            const tx = this.uiState.x || 0; const ty = this.uiState.y || 0;
            this.globalContainer.style.setProperty('--vsc-translate-x', `${tx}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${ty}px`);

            const vars = { '--vsc-bg-dark': 'rgba(0,0,0,0.7)', '--vsc-bg-btn': 'rgba(0,0,0,0.5)', '--vsc-bg-accent': 'rgba(52, 152, 219, 0.7)', '--vsc-bg-warn': 'rgba(231, 76, 60, 0.9)', '--vsc-bg-active': 'rgba(76, 209, 55, 0.4)', '--vsc-text': 'white', '--vsc-text-accent': '#f39c12', '--vsc-text-active': '#4cd137', '--vsc-border': '#555' };
            for (const [k, v] of Object.entries(vars)) this.globalContainer.style.setProperty(k, v);

            this.mainControlsContainer = document.createElement('div'); this.mainControlsContainer.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:5px;';
            this.triggerElement = document.createElement('div'); this.triggerElement.textContent = '⚡';
            this.triggerElement.className = 'vsc-trigger';

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

            // [v41] Prevent duplicate style injection
            if (!document.getElementById('vsc-global-style')) {
                const globalStyle = document.createElement('style');
                globalStyle.id = 'vsc-global-style';
                globalStyle.textContent = this.getStyles().replace(':host', '#vsc-global-container, #vsc-ui-host');
                document.head.appendChild(globalStyle);
            }

            this.startBootGate();
        }

        startBootGate() {
            this.globalContainer.style.display = 'flex';
            this.globalContainer.style.opacity = '0.5';
            let checks = 0;
            const check = () => {
                checks++;
                const hasMedia = this.stateManager.get('media.activeMedia').size > 0 || this.stateManager.get('media.activeIframes').size > 0 || hasRealVideoCached();
                if (hasMedia) { this.globalContainer.style.opacity = '1'; }
                else if (checks < 20) { setTimeout(check, 500); }
                else { this.globalContainer.style.opacity = '0.5'; }
            };
            check();
        }

        updateTriggerStyle() {
            if (!this.triggerElement) return;
            const isVisible = this.stateManager.get('ui.areControlsVisible');
            if (isVisible) {
                this.triggerElement.textContent = '🛑';
                this.triggerElement.style.backgroundColor = 'rgba(231, 76, 60, 0.9)';
                if(this.globalContainer) this.globalContainer.style.opacity = '1';
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
                const hasVideo = [...this.stateManager.get('media.activeMedia')].some(m => m && m.tagName === 'VIDEO') || !!document.querySelector('video, iframe') || hasRealVideoCached();
                this.speedButtonsContainer.style.display = isVisible && hasVideo ? 'flex' : 'none';
            }
            this.updateUIVisibility();
        }
        updateUIVisibility() {
            if (this.stateManager.get('ui.hideUntilReload')) { if (this.globalContainer) this.globalContainer.style.display = 'none'; return; }
            const controlsVisible = this.stateManager.get('ui.areControlsVisible');
            const activeMedia = this.stateManager.get('media.activeMedia') || new Set(); const activeImages = this.stateManager.get('media.activeImages') || new Set(); const activeIframes = this.stateManager.get('media.activeIframes') || new Set();
            const hasLocalVideo = [...activeMedia].some(m => m && m.tagName === 'VIDEO'); const hasLocalImage = activeImages.size > 0; const hasIframe = activeIframes.size > 0;
            const hasDomVideo = !!document.querySelector('video, iframe') || hasRealVideoCached();
            const hasAnyVideo = hasLocalVideo || hasIframe || hasDomVideo; const hasAny = hasAnyVideo || hasLocalImage;

            if (this.globalContainer) {
                this.globalContainer.style.display = 'flex';
                if (controlsVisible || hasAny) this.globalContainer.style.opacity = '1';
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
            this.shadowRoot.appendChild(styleEl);

            // v132.0.23: Restored renderAllControls call AND restored its definition below
            this.renderAllControls();

            this.mainControlsContainer.prepend(this.hostElement);
        }

        // v132.0.23: Restored Missing Function
        renderAllControls() {
            if (this.shadowRoot.querySelector('#vsc-main-container')) return;
            const main = document.createElement('div'); main.id = 'vsc-main-container';
            const controls = document.createElement('div'); controls.id = 'vsc-controls-container';
            const videoMenu = this._buildVideoMenu(controls);
            const monitor = document.createElement('div'); monitor.className = 'vsc-monitor'; monitor.textContent = 'Monitoring Off'; videoMenu.appendChild(monitor);
            this.boundSmartLimitUpdate = (e) => {
                const { autoParams, tainted, aeActive } = e.detail;
                // [v42] Taint Toast
                if (tainted && !this._lastTaintToast) {
                     this.showToast('⚠️ 보안(CORS) 제한됨: AE 불가');
                     this._lastTaintToast = true;
                }
                if (!videoMenu.parentElement.classList.contains('submenu-visible')) return;
                
                if (tainted) { monitor.textContent = '🔒 보안(CORS) 제한됨'; monitor.classList.add('warn'); }
                else {
                    const evVal = Math.log2(autoParams.linearGain || 1.0).toFixed(2);
                    const activeMark = aeActive ? '(Auto)' : '(Safe)';
                    monitor.textContent = `${activeMark} EV: ${evVal > 0 ? '+' : ''}${evVal} | Linear: ${(autoParams.linearGain || 1.0).toFixed(2)}`;
                    monitor.classList.remove('warn');
                    this._lastTaintToast = false;
                }
            };
            document.addEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);
            const imgMenu = this._createControlGroup('vsc-image-controls', '🎨', '이미지 필터', controls);
            imgMenu.append(this._createSlider('샤프닝', 'i-sh', 0, 20, 1, 'imageFilter.level', '단계', v => v.toFixed(0)).control, this._createSlider('색온도', 'i-ct', -7, 4, 1, 'imageFilter.colorTemp', '', v => v.toFixed(0)).control);
            main.appendChild(controls); this.shadowRoot.appendChild(main);
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
                if (stateKey.startsWith('videoFilter.')) { if (stateKey.includes('level') || stateKey.includes('level2')) this.stateManager.set('videoFilter.activeSharpPreset', 'custom'); }
                // if (stateKey === 'videoFilter.targetLuma') { triggerBurstScan(); } // Removed in v36
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
                btn.onclick = () => {
                    const next = !this.stateManager.get(key);
                    this.stateManager.set(key, next);
                    // [v35] Trigger instant scan when AE is toggled on
                    if (key === 'videoFilter.autoExposure' && next) triggerBurstScan(200);
                };
                this.subscribe(key, render); render(this.stateManager.get(key)); return btn;
            };
            const powerBtn = document.createElement('button'); powerBtn.className = 'vsc-btn vsc-btn-lg'; powerBtn.textContent = '⏸︎'; powerBtn.title = '전체 기능 끄기';
            Object.assign(powerBtn.style, { width: '40px', flex: '0 0 40px', color: '#e74c3c' });
            powerBtn.onclick = () => { this.stateManager.set('app.scriptActive', false); this.stateManager.set('ui.areControlsVisible', false); this.showToast('Script OFF'); };
            topRow.append(powerBtn); topRow.append(createToggle('📸 자동 (AE)', 'videoFilter.autoExposure'));
            topRow.append(createToggle('🔊 부스트', 'audio.enabled'));

            const videoResetBtn = document.createElement('button'); videoResetBtn.className = 'vsc-btn vsc-btn-lg'; videoResetBtn.textContent = '↺'; videoResetBtn.title = '필터 초기화';
            Object.assign(videoResetBtn.style, { width: '40px', flex: '0 0 40px' });
            videoResetBtn.onclick = () => {
                // [v35] Simplified Reset
                this.stateManager.batchSet('videoFilter', { activeSharpPreset: 'none', level: 0, level2: 0, clarity: 0, autoExposure: false, gamma: 1.0, contrastAdj: 1.0, brightness: 0, saturation: 100, highlights: 0, shadows: 0, dither: 0, colorTemp: 0 });
                this.stateManager.set('audio.enabled', false); this.stateManager.set('audio.boost', 6); this.showToast('필터 및 오디오 초기화됨');
            };
            topRow.append(videoResetBtn);
            videoSubMenu.append(topRow);

            // [v36] Restored Sharpness Presets
            const presetContainer = document.createElement('div');
            presetContainer.className = 'vsc-align-grid';

            const label = document.createElement('div');
            label.className = 'vsc-label';
            label.textContent = '샤프';
            presetContainer.appendChild(label);

            const sharpPresets = [
                { txt: 'S', key: 'sharpS', l1: 8, l2: 3 },
                { txt: 'M', key: 'sharpM', l1: 15, l2: 6 },
                { txt: 'L', key: 'sharpL', l1: 25, l2: 10 },
                { txt: 'XL', key: 'sharpXL', l1: 35, l2: 15 },
                { txt: '끔', key: 'sharpOFF', l1: 0, l2: 0 }
            ];

            sharpPresets.forEach(it => {
                const b = document.createElement('button');
                b.className = 'vsc-btn';
                b.textContent = it.txt;
                b.dataset.presetKey = it.key;
                b.onclick = () => {
                    this.stateManager.batchSet('videoFilter', {
                        level: it.l1,
                        level2: it.l2,
                        activeSharpPreset: it.key
                    });
                };
                presetContainer.appendChild(b);
            });

            const updateSharp = (k) => {
                 presetContainer.querySelectorAll('button[data-preset-key]').forEach(b => {
                     b.classList.toggle('active', b.dataset.presetKey === k);
                 });
            };
            this.subscribe('videoFilter.activeSharpPreset', updateSharp);
            updateSharp(this.stateManager.get('videoFilter.activeSharpPreset'));

            videoSubMenu.appendChild(presetContainer);

            // [v35] Simplified Slider Grid (No tabs)
            const SLIDER_CONFIG = [
                { label: '감마 (Gamma)', id: 'v-gamma', min: 0.5, max: 2.5, step: 0.05, key: 'videoFilter.gamma', unit: '', fmt: v => v.toFixed(2) },
                { label: '대비 (Contrast)', id: 'v-contrast', min: 0.5, max: 2.0, step: 0.05, key: 'videoFilter.contrastAdj', unit: '', fmt: v => v.toFixed(2) },
                { label: '밝기 (Bright)', id: 'v-bright', min: -50, max: 50, step: 1, key: 'videoFilter.brightness', unit: '', fmt: v => v.toFixed(0) },
                { label: '채도 (Sat)', id: 'v-sat', min: 0, max: 200, step: 5, key: 'videoFilter.saturation', unit: '%', fmt: v => v.toFixed(0) },
                { label: '샤프(윤곽)', id: 'v-sh1', min: 0, max: 50, step: 1, key: 'videoFilter.level', unit: '단계', fmt: v => v.toFixed(0) },
                { label: '샤프(디테일)', id: 'v-sh2', min: 0, max: 50, step: 1, key: 'videoFilter.level2', unit: '단계', fmt: v => v.toFixed(0) },
                { label: '명료도', id: 'v-cl', min: 0, max: 50, step: 5, key: 'videoFilter.clarity', unit: '', fmt: v => v.toFixed(0) },
                { label: '색온도', id: 'v-ct', min: -25, max: 25, step: 1, key: 'videoFilter.colorTemp', unit: '', fmt: v => v.toFixed(0) },
                { label: '그레인', id: 'v-dt', min: 0, max: 100, step: 5, key: 'videoFilter.dither', unit: '', fmt: v => v.toFixed(0) }
            ];

            const grid = document.createElement('div'); grid.className = 'vsc-grid';
            SLIDER_CONFIG.forEach(cfg => { grid.appendChild(this._createSlider(cfg.label, cfg.id, cfg.min, cfg.max, cfg.step, cfg.key, cfg.unit, cfg.fmt).control); });
            grid.appendChild(this._createSlider('오디오증폭', 'a-boost', 0, 12, 1, 'audio.boost', 'dB', v => `+${v}`).control);
            videoSubMenu.append(grid);

            return videoSubMenu;
        }
        attachDragAndDrop() {
            let lastDragEnd = 0;
            const stopDrag = () => {
                this.isDragging = false; this.globalContainer.style.transition = '';
                this.triggerElement.removeEventListener('pointermove', this._onDragMove);
                this.triggerElement.removeEventListener('pointerup', this._onDragEnd);
                this.triggerElement.removeEventListener('pointercancel', this._onDragEnd);
                document.removeEventListener('mousemove', this._onDragMove);
                document.removeEventListener('mouseup', this._onDragEnd);
                document.removeEventListener('touchmove', this._onDragMove);
                document.removeEventListener('touchend', this._onDragEnd);
                document.removeEventListener('touchcancel', this._onDragEnd);
            };

            const onPointerDown = (e) => {
                if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
                this.isDragging = true; this.wasDragged = false;
                this._longPressTriggered = false;
                if (this.pressTimer) clearTimeout(this.pressTimer);

                this.pressTimer = setTimeout(() => {
                    if (this.isDragging && !this.wasDragged) {
                        this._longPressTriggered = true;
                        this.stateManager.set('app.scriptActive', false);
                        this.stateManager.set('ui.areControlsVisible', false);
                        this.showToast('Script OFF (Long Press)');
                        this.updateTriggerStyle();
                        stopDrag();
                    }
                }, 800);

                this.delta = { x: 0, y: 0 }; this.startPos = { x: e.clientX, y: e.clientY };
                if (e.type === 'touchstart') { this.startPos = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
                this.currentPos = { x: this.uiState.x, y: this.uiState.y };
                this.globalContainer.style.transition = 'none';
                try { this.triggerElement.setPointerCapture(e.pointerId); } catch(err){}

                if (e.type === 'pointerdown') {
                    this.triggerElement.addEventListener('pointermove', this._onDragMove);
                    this.triggerElement.addEventListener('pointerup', this._onDragEnd);
                    this.triggerElement.addEventListener('pointercancel', this._onDragEnd);
                } else if (e.type === 'touchstart') {
                    document.addEventListener('touchmove', this._onDragMove, { passive: false });
                    document.addEventListener('touchend', this._onDragEnd);
                    document.addEventListener('touchcancel', this._onDragEnd);
                } else {
                    document.addEventListener('mousemove', this._onDragMove);
                    document.addEventListener('mouseup', this._onDragEnd);
                }
            };

            const updatePosition = () => { if (!this.isDragging || !this.globalContainer) return; const newX = this.currentPos.x + this.delta.x; const newY = this.currentPos.y + this.delta.y; this.globalContainer.style.setProperty('--vsc-translate-x', `${newX}px`); this.globalContainer.style.setProperty('--vsc-translate-y', `${newY}px`); this.animationFrameId = null; };

            this._onDragMove = (e) => {
                if (!this.isDragging) return;
                let cx = e.clientX, cy = e.clientY;
                if (e.type === 'touchmove') { cx = e.touches[0].clientX; cy = e.touches[0].clientY; e.preventDefault(); }

                this.delta = { x: cx - this.startPos.x, y: cy - this.startPos.y };
                if (!this.wasDragged && (Math.abs(this.delta.x) > CONFIG.UI.DRAG_THRESHOLD || Math.abs(this.delta.y) > CONFIG.UI.DRAG_THRESHOLD)) {
                    this.wasDragged = true;
                    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
                }
                if (this.wasDragged && this.animationFrameId === null) { this.animationFrameId = requestAnimationFrame(updatePosition); }
            };

            this._onDragEnd = (e) => {
                if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
                if (!this.isDragging && !this._longPressTriggered) return;

                if (this.animationFrameId) { cancelAnimationFrame(this.animationFrameId); this.animationFrameId = null; }
                const dx = this.delta?.x || 0; const dy = this.delta?.y || 0;
                if (this.wasDragged) {
                    this.uiState.x += dx; this.uiState.y += dy;
                    Utils.safeSetItem('vsc_ui_pos', JSON.stringify(this.uiState));
                    lastDragEnd = Date.now();
                } else if (!this._longPressTriggered) {
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
                            if (count > 0) { triggerBurstScan(250); setTimeout(() => ensureMediaSoon(count - 1), 900); }
                            else { this.showToast('미디어를 아직 못 찾았어요 (로딩 지연/iframe/CORS일 수 있음)'); }
                        };
                        setTimeout(() => ensureMediaSoon(10), 500);
                    }
                }
                stopDrag();
                try { this.triggerElement.releasePointerCapture(e.pointerId); } catch(err){}
                setTimeout(() => { this.wasDragged = false; }, 50);
            };

            if (window.PointerEvent) {
                this.triggerElement.addEventListener('pointerdown', onPointerDown);
            } else {
                this.triggerElement.addEventListener('mousedown', onPointerDown);
                this.triggerElement.addEventListener('touchstart', onPointerDown, { passive: false });
            }

            this.triggerElement.addEventListener('click', (e) => {
                if (Date.now() - lastDragEnd < 400 || this._longPressTriggered) {
                    e.stopPropagation(); e.preventDefault();
                }
            }, { capture: true });
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
