// ==UserScript==
// @name        Video_Image_Control (v132.0.89 Optimized-Refined)
// @namespace   https://github.com/
// @version     132.0.89
// @description v132.0.89: Advanced AE Proxy(p50/p10), Smart Tone Mapping, Child UI Destroy Fix
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
    const VSC_BOOT_KEY = '__VSC_BOOT_LOCK__';
    if (window[VSC_BOOT_KEY]) return;
    try {
        Object.defineProperty(window, VSC_BOOT_KEY, { value: true, writable: false });
    } catch (e) {
        window[VSC_BOOT_KEY] = true;
    }

    const IS_TOP = window === window.top;
    let _corePluginRef = null;

    // 2. Constants & Configuration
    const VSC_INSTANCE_ID = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : Math.random().toString(36).slice(2);
    const VSC_AUDIO_SRC = Symbol('vsc_audio_src');
    const VSC_PINNED = { el: null, until: 0 };
    const VSC_MSG = 'vsc-ctrl-v1';

    const MEDIA_EVENTS = ['play', 'playing', 'pause', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'seeking', 'seeked', 'emptied', 'ratechange', 'durationchange'];
    const DEVICE_RAM = navigator.deviceMemory || 4;
    const IS_HIGH_END = DEVICE_RAM >= 8;
    const IS_LOW_END = DEVICE_RAM < 4;
    const IS_MOBILE = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const IS_DATA_SAVER = navigator.connection && (navigator.connection.saveData || navigator.connection.effectiveType === '2g');

    const MEDIA_TAGS = new Set(['VIDEO', 'CANVAS', 'IFRAME']);
    const SCAN_TAGS = new Set(['VIDEO', 'IMG', 'IFRAME', 'CANVAS']);

    const DEFAULT_SETTINGS = { GAMMA: 1.00, SHARPEN_ID: 'SharpenDynamic', SAT: 100, SHADOWS: 0, HIGHLIGHTS: 0, TEMP: 0, DITHER: 0, CLARITY: 0 };

    const MIN_AE = {
        STRENGTH: IS_MOBILE ? 0.24 : 0.28,
        STRENGTH_DARK: IS_MOBILE ? 0.28 : 0.32,
        MID_OK_MIN: IS_MOBILE ? 0.14 : 0.16,
        MID_OK_MAX: 1.0,
        P98_CLIP: 0.985,
        CLIP_FRAC_LIMIT: 0.004,
        MAX_UP_EV: IS_MOBILE ? 0.14 : 0.18,
        MAX_UP_EV_DARK: IS_MOBILE ? 0.30 : 0.34,
        MAX_UP_EV_EXTRA: IS_MOBILE ? 0.28 : 0.35,
        MAX_DOWN_EV: 0,
        DEAD_OUT: IS_MOBILE ? 0.12 : 0.10,
        DEAD_IN: 0.04,
        LOWKEY_STDDEV: IS_MOBILE ? 0.20 : 0.24,
        LOWKEY_P10: 0.10,
        TAU_UP: 950,
        TAU_DOWN: 900,
        TAU_AGGRESSIVE: 200,
        TARGET_MID_BASE: IS_MOBILE ? 0.26 : 0.30
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
            SECONDARY_ADJ: true
        },
        AUDIO: { THRESHOLD: -50, KNEE: 40, RATIO: 12, ATTACK: 0, RELEASE: 0.25 },
        SCAN: {
            INTERVAL_TOP: 5000, INTERVAL_IFRAME: 2000, INTERVAL_MAX: 15000,
            MAX_DEPTH: IS_HIGH_END ? 8 : (IS_LOW_END ? 4 : 6),
            MUTATION_ATTRS: ['src', 'srcset', 'poster', 'data-src', 'data-srcset', 'data-url', 'data-original', 'data-video-src', 'data-poster', 'type', 'loading', 'data-lazy-src', 'data-lazy', 'data-bg', 'data-background', 'aria-src', 'data-file', 'data-mp4', 'data-hls', 'data-stream', 'data-video', 'data-video-url', 'data-stream-url', 'data-player-src', 'data-m3u8', 'data-mpd']
        },
        UI: { MAX_Z: 2147483647, HIDDEN_CLASS: 'vsc-hidden', SPEED_PRESETS: [5.0, 3.0, 2.0, 1.5, 1.2, 1.0, 0.5, 0.2] }
    };

    const SEL = { FILTER_TARGET: 'video, img, iframe, canvas' };

    const _vscVp = () => {
        const vv = window.visualViewport;
        return { w: vv ? vv.width : window.innerWidth, h: vv ? vv.height : window.innerHeight };
    };

    const isChildFullscreenLikely = () => {
        const fe = document.fullscreenElement || document.webkitFullscreenElement;
        if (fe) return true;

        if (window !== window.top) {
            const { w: vw, h: vh } = _vscVp();
            let sw = screen.availWidth || screen.width || 0;
            let sh = screen.availHeight || screen.height || 0;
            if (!sw || !sh || sw < 100 || sh < 100) return false;

            const vLand = vw > vh;
            const sLand = sw > sh;
            if (vLand !== sLand) [sw, sh] = [sh, sw];

            const edgeTh = IS_MOBILE ? 0.80 : 0.85;
            const areaTh = IS_MOBILE ? 0.70 : 0.78;

            const fillsEdge = (vw >= sw * edgeTh) && (vh >= sh * edgeTh);
            const fillsArea = ((vw * vh) / (sw * sh)) >= areaTh;

            return fillsEdge || fillsArea;
        }
        return false;
    };

    const Utils = {
        clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
        safeInt: (v, d = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; },
        fastHash: (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); },
        setAttr: (el, name, val) => { if (!el) return; if (val == null) { if (el.hasAttribute(name)) el.removeAttribute(name); return; } const s = String(val); if (el.getAttribute(name) !== s) el.setAttribute(name, s); },
        setAttrAll: (nodeList, name, val) => { if (!nodeList) return; for (const el of nodeList) Utils.setAttr(el, name, val); },
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
        },
        qById: (root, id) => {
            try {
                const safe = (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/[^a-zA-Z0-9\-_]/g, '\\$&');
                return root && root.querySelector ? root.querySelector(`#${safe}`) : null;
            } catch { return null; }
        },
        mergeFilter: (existing, injected) => {
            const e = (existing || '').trim();
            const i = (injected || '').trim();
            if (!e) return i;
            if (!i) return e;
            const cleaned = e
                .replace(/brightness\([^)]+\)/g, '')
                .replace(/contrast\([^)]+\)/g, '')
                .replace(/saturate\([^)]+\)/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            return (cleaned ? cleaned + ' ' : '') + i;
        },
        ensureDomReady: () => {
            if (document.head && document.body) return Promise.resolve();
            return new Promise(res => {
                const onReady = () => {
                    if (document.head && document.body) {
                        document.removeEventListener('DOMContentLoaded', onReady, true);
                        res();
                    }
                };
                document.addEventListener('DOMContentLoaded', onReady, true);
                if (document.readyState === 'interactive' || document.readyState === 'complete') onReady();
            });
        }
    };

    const safeGuard = (fn, label = '') => { try { return fn(); } catch (e) { if (CONFIG.DEBUG) console.error(`[VSC] Error in ${label}:`, e); } };
    const debounce = (fn, wait) => { let t; return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); }; };
    const throttle = (fn, limit) => { let inThrottle; return function (...args) { if (!inThrottle) { fn.apply(this, args); inThrottle = true; setTimeout(() => inThrottle = false, limit); } }; };
    const rIC = window.requestIdleCallback || (cb => setTimeout(() => cb({ timeRemaining: () => 1, didTimeout: true }), IS_MOBILE ? 16 : 4));
    const scheduleWork = (cb) => rIC((d) => { try { cb(d); } catch (e) { if (CONFIG.DEBUG) console.error(e); } }, { timeout: 1000 });

    const on = (target, type, listener, options) => { try { target.addEventListener(type, listener, options); } catch(e){} };
    const P = (signal) => ({ passive: true, signal });
    const CP = (signal) => ({ capture: true, passive: true, signal });

    // Helper to safely access VideoAnalyzer to prevent runtime crash
    const VA = () => (typeof VideoAnalyzer !== 'undefined' ? VideoAnalyzer : null);

    const WORKER_CODE = `
        const hist = new Uint16Array(256);
        self.onmessage = function(e) {
            const { fid, vid, buf, width, height, type, step } = e.data;
            if (type === 'analyze') {
                let data = null;
                if (buf) { try { data = new Uint8ClampedArray(buf); } catch(e) {} } else if (e.data.data) { try { data = new Uint8ClampedArray(e.data.data); } catch(e) {} }
                if (!data) return;
                hist.fill(0);

                const w = width;
                const h = height || width;

                let validCount = 0;
                let sumR = 0, sumG = 0, sumB = 0;
                let sumLuma = 0;
                let sumLumaSq = 0;
                let sumMaxMin = 0;

                const checkRow = (sy, ey) => {
                    let s = 0, c = 0;
                    for(let y=sy; y<ey; y+=step) {
                        for(let x=0; x<w; x+=step) {
                             const i = (y*w+x)*4;
                             s += (data[i]*54+data[i+1]*183+data[i+2]*19)>>8; c++;
                        }
                    }
                    return c > 0 ? (s/c)/255.0 : 0;
                };

                const barH = Math.floor(h * 0.12);
                const topLuma = checkRow(0, 3);
                const botLuma = checkRow(h-3, h);
                const BLK = 15.0 / 255.0;

                let startY = 0, endY = h;
                if (topLuma < BLK) startY = barH;

                if (botLuma < BLK) {
                    endY = h - barH;
                } else if ((botLuma - topLuma) > 0.15 && botLuma > 0.20) {
                     endY = h - Math.floor(h * 0.20);
                }

                const bottomStart = h - Math.floor(h * 0.20);
                let botClipCount = 0;
                let botTotalCount = 0;

                for (let y = startY; y < endY; y+=step) {
                    const isBottom = y >= bottomStart;
                    for (let x = 0; x < w; x+=step) {
                        const i = (y * w + x) * 4;
                        const r = data[i];
                        const g = data[i+1];
                        const b = data[i+2];
                        const luma = (r*54 + g*183 + b*19) >> 8;

                        hist[luma]++;
                        validCount++;

                        if (isBottom) {
                            botTotalCount++;
                            if (luma >= 253) botClipCount++;
                        }

                        sumR += r; sumG += g; sumB += b;
                        sumLuma += luma;
                        sumLumaSq += luma * luma;

                        let max = r; if (g > max) max = g; if (b > max) max = b;
                        let min = r; if (g < min) min = g; if (b < min) min = b;
                        sumMaxMin += (max - min);
                    }
                }

                let p10 = -1, p50 = -1, p55 = -1, p90 = -1, p98 = -1;
                let clipFrac = 0;
                let clipFracBottom = (botTotalCount > 0) ? (botClipCount / botTotalCount) : 0;

                let avgR = 0, avgG = 0, avgB = 0, avgLuma = 0, stdDev = 0, avgSat = 0;
                if (validCount > 0) {
                    const inv = 1 / validCount;
                    avgR = (sumR * inv) / 255;
                    avgG = (sumG * inv) / 255;
                    avgB = (sumB * inv) / 255;
                    avgLuma = (sumLuma * inv) / 255;
                    avgSat = (sumMaxMin * inv) / 255;

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

                self.postMessage({ type: 'result', fid, vid, p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, clipFracBottom, validCount, avgSat });
            }
        };
    `;

    const dirtyRoots = new Set();
    let _scanRaf = null, _lastFullScanTime = 0;
    let _fullScanQueued = false;
    let _lastBackoffScan = 0;
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
                const approxCount = document.all ? document.all.length : document.getElementsByTagName('*').length;
                if (approxCount > 8000) limit = 300;
                else if (approxCount > 3000) limit = 800;

                if (_localShadowRoots.length > 200) return;
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
        if (SCAN_TAGS.has(n.nodeName)) return true;
        if (n.nodeName === 'HTML' || n.nodeName === 'BODY' || n.nodeName === 'HEAD') return false;
        if (n.childElementCount > 0 && n.querySelector) return !!n.querySelector(SEL.FILTER_TARGET);
        return false;
    };

    let _lastRootish = 0;
    const scheduleScan = (rootOrNull, immediate = false, isUserAction = false) => {
        if (Utils.isShadowRoot(rootOrNull)) registerShadowRoot(rootOrNull);

        if (immediate && _corePluginRef) {
            if (_corePluginRef._isBackoffMode && !isUserAction) {
                const now = Date.now();
                if (now - _lastBackoffScan > 1800) {
                    _lastBackoffScan = now;
                } else {
                    return;
                }
            }

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
                if (!SCAN_TAGS.has(rootOrNull.nodeName)) {
                      const hasMediaQuick = rootOrNull.querySelector?.('video,iframe,canvas');
                      if (!hasMediaQuick) {
                        const now = performance.now();
                        if (now - _lastRootish < 200) rootOrNull = null;
                        _lastRootish = now;
                      }
                }
            }
            if (rootOrNull) {
                if (Utils.isShadowRoot(rootOrNull)) { if (rootOrNull.host && rootOrNull.host.isConnected) dirtyRoots.add(rootOrNull); }
                else if (rootOrNull.isConnected) {
                    if (SCAN_TAGS.has(rootOrNull.nodeName)) dirtyRoots.add(rootOrNull);
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
        if(_corePluginRef) {
            _corePluginRef.resetScanInterval();
            scheduleScan(null, true, true);
            [delay, delay * 4, delay * 8].forEach(d => setTimeout(() => scheduleScan(null), d));
        }
    };

    let _sensCache = { t: 0, v: false };
    let _sensitiveLockUntil = performance.now() + 2000;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _sensitiveLockUntil = 0; }, 1000), { once: true });
    else setTimeout(() => { _sensitiveLockUntil = 0; }, 1000);

    const SENSITIVE_KEYWORDS = ['checkout', 'payment', 'bank', 'kakaobank', 'toss'];
    const isSensitiveUrl = () => { return SENSITIVE_KEYWORDS.some(kw => location.href.toLowerCase().includes(kw)); };

    const isSensitiveContext = () => {
        const now = Date.now();
        const ttl = _sensCache.v ? 300 : (IS_MOBILE ? 450 : 800);
        if (now - _sensCache.t < ttl) return _sensCache.v;

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
                 if (_corePluginRef && _corePluginRef._hasDomVideo !== undefined) {
                     found = _corePluginRef._hasDomVideo;
                 } else {
                     const vids = document.getElementsByTagName('video');
                     if (vids.length > 0) found = true;
                     else {
                         const ifs = document.getElementsByTagName('iframe');
                         if (ifs.length > 0) found = true;
                     }
                 }
                 _hasVideoCache = { t: Date.now(), v: found, req: 0 };
            });
        }
        return _hasVideoCache.v;
    };

    const ORIGINALS = { attachShadow: Element.prototype.attachShadow };
    const _prevInlineStyle = new WeakMap();
    const _realmSheetCache = new WeakMap();
    const _shadowRootCache = new WeakMap();
    let _shadowHookActive = false;

    const PROTECT_KEYS = ['playbackRate', 'currentTime', 'volume', 'muted', 'onratechange'];

    function relaxMediaLocks(el) {
        if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
        try {
            for (const k of PROTECT_KEYS) {
                let proto = el;
                let desc = null;
                while (proto) {
                    desc = Object.getOwnPropertyDescriptor(proto, k);
                    if (desc) break;
                    proto = Object.getPrototypeOf(proto);
                }
                if (desc && desc.configurable && desc.writable === false) {
                    Object.defineProperty(el, k, { ...desc, writable: true });
                }
            }
        } catch(e) {}
    }

    safeGuard(() => {
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function (...args) {
            try { this._vscLastPlay = Date.now(); } catch (e) {}
            try { relaxMediaLocks(this); } catch(e) {}

            try {
                 if (_corePluginRef && _corePluginRef.stateManager.get('app.scriptActive') && !isSensitiveContext()) {
                     triggerBurstScan(150);
                     VSC_PINNED.el = this;
                     VSC_PINNED.until = Date.now() + 10000;
                     if (this.getBoundingClientRect().width > 100 && _corePluginRef.stateManager) {
                         _corePluginRef.stateManager.set('media.currentlyVisibleMedia', this);
                     }
                     const va = VA();
                     if (_corePluginRef.stateManager.get('videoFilter.autoExposure') && va) va._kickImmediateAnalyze();
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
                let shadowRoot;
                try {
                        shadowRoot = ORIGINALS.attachShadow.call(this, init);
                } catch(e) { throw e; }

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

        if (Utils.isShadowRoot(root)) { if (root.host && root.host.hasAttribute(attr)) { if (Utils.qById(root, styleId)) return; } }
        else if (ownerDoc && ownerDoc.documentElement.hasAttribute(attr)) { if (Utils.qById(ownerDoc, styleId)) return; }

        const svgNode = manager.getSvgNode(); const styleNode = manager.getStyleNode(); if (!svgNode || !styleNode) return;

        const safelyAppendStyle = (targetRoot, styleEl, sharedSheet) => {
            let appended = false;
            if (sharedSheet && ('adoptedStyleSheets' in targetRoot)) {
                try {
                    const sheets = targetRoot.adoptedStyleSheets || [];
                    if (!sheets.includes(sharedSheet)) {
                        targetRoot.adoptedStyleSheets = [...sheets, sharedSheet];
                    }
                    appended = true;
                } catch (e) { }
            }
            if (!appended) {
                if (!Utils.qById(targetRoot, styleEl.id)) {
                    const container = (targetRoot === ownerDoc) ? targetRoot.head : targetRoot;
                    if (container) container.appendChild(styleEl.cloneNode(true));
                }
            }
        };

        if (ownerDoc !== document) {
            if (!ownerDoc.body) { setTimeout(() => injectFiltersIntoContext(element, manager, stateManager), 100); return; }
            if (!Utils.qById(ownerDoc, svgNode.id)) { const clonedSvg = svgNode.cloneNode(true); ownerDoc.body.appendChild(clonedSvg); manager.registerContext(clonedSvg); }
            const view = ownerDoc.defaultView; const sharedSheet = view ? getSharedStyleSheetForView(view, styleNode.textContent) : null;
            safelyAppendStyle(ownerDoc, styleNode, sharedSheet); ownerDoc.documentElement.setAttribute(attr, 'true');
            return;
        }
        if (Utils.isShadowRoot(root)) {
            try {
                if (!Utils.qById(root, svgNode.id)) { const clonedSvg = svgNode.cloneNode(true); root.appendChild(clonedSvg); manager.registerContext(clonedSvg); }
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
                ui: {
                    shadowRoot: null, hostElement: null, areControlsVisible: false, globalContainer: null,
                    createRequested: IS_TOP,
                    hideUntilReload: false,
                    forceChildUIUntil: 0
                },
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
        currentLinearGain: 1.0, lastApplyTime: 0,
        frameSkipCounter: 0, dynamicSkipThreshold: 0, hasRVFC: false, lastAvgLuma: -1, _highMotion: false, _evAggressiveUntil: 0, _aeHoldUntil: 0,
        _roiP50History: [], taintedResources: new WeakSet(), _worker: null, _workerUrl: null, _rvfcCb: null, _frameId: 0, _videoIds: new WeakMap(), _lowMotionFrames: 0, _lowMotionSkip: 0, _workerBusy: false, _workerLastSent: 0, _workerStallCount: 0, _lastAppliedFid: 0, _hist: new Uint16Array(256), _p10Ema: -1, _p90Ema: -1,
        _aeActive: false, _lastKick: 0, _workerCooldown: 0, _workerRetryCount: 0, _workerSuccessCount: 0,
        _lastFrameStats: null,
        _lastNoWorkerAnalyze: 0,

        ensureStateManager(sm) { if (!this.stateManager && sm) this.stateManager = sm; },
        init(stateManager) {
            this.ensureStateManager(stateManager);
            if (!this.canvas) {
                let oc = null;
                try { if (typeof OffscreenCanvas !== 'undefined') { oc = new OffscreenCanvas(32, 32); if (!oc.getContext) oc = null; } } catch { oc = null; }
                this.canvas = oc || document.createElement('canvas');
                let size = (IS_LOW_END && !IS_HIGH_END) ? 24 : (IS_HIGH_END ? 48 : 24);
                if (IS_MOBILE) size = 24;
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
            this.lastApplyTime = performance.now();
        },
        _getVideoId(v) { if (!this._videoIds.has(v)) this._videoIds.set(v, Math.random().toString(36).slice(2)); return this._videoIds.get(v); },
        _handleWorkerMessage(e) {
            this._workerBusy = false; this._workerLastSent = 0;
            const { type, fid, vid, p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, clipFracBottom, validCount, avgSat } = e.data;
            if (type !== 'result' || !this.targetVideo || vid !== this._getVideoId(this.targetVideo)) return;
            if (!this._lastAppliedFid) this._lastAppliedFid = 0; if (fid < this._lastAppliedFid) return;

            this._workerSuccessCount++;
            if (this._workerSuccessCount > 3) {
                this._workerRetryCount = 0;
                this._workerSuccessCount = 0;
            }

            this._lastAppliedFid = fid;
            this._processAnalysisResult(p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac, clipFracBottom, validCount, avgSat);
        },
        _analyzeFallback(imageData, width, height, step) {
             const data = imageData.data;
             const w = width; const h = height;

             const checkRow = (sy, ey) => {
                 let s = 0, c = 0;
                 for (let y = sy; y < ey; y += step) {
                     for (let x = 0; x < w; x += step) {
                         const i = (y * w + x) * 4;
                         s += (data[i]*54 + data[i+1]*183 + data[i+2]*19) >> 8;
                         c++;
                     }
                 }
                 return c > 0 ? (s/c)/255.0 : 0;
             };

             const barH = Math.floor(h * 0.12);
             const topLuma = checkRow(0, 3);
             const botLuma = checkRow(h - 3, h);
             const BLK = 15.0/255.0;

             let startY = 0, endY = h;
             if (topLuma < BLK) startY = barH;

             if (botLuma < BLK) {
                 endY = h - barH;
             } else if ((botLuma - topLuma) > 0.15 && botLuma > 0.20) {
                 endY = h - Math.floor(h * 0.20);
             }

             let sumLuma = 0, sumLumaSq = 0;
             let count = 0;
             let hist = this._hist;
             hist.fill(0);

             for (let y = startY; y < endY; y += step) {
                 for (let x = 0; x < w; x += step) {
                     const i = (y * w + x) * 4;
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

             this._processAnalysisResult(p10, p50, p50, p90, p98, avgLuma, stdDev, 0.33, 0.33, 0.33, clipFrac, 0, count, 0.5);
        },

        _pickBestVideoNow() {
            let candidates = [];
            const activeMedia = this.stateManager?.get('media.activeMedia');
            if (activeMedia && activeMedia.size > 0) {
                candidates = [...activeMedia];
            } else {
                const docVideos = document.querySelectorAll('video, canvas, iframe');
                candidates = [...docVideos];
            }

            if (VSC_PINNED.el && VSC_PINNED.el.isConnected && Date.now() < VSC_PINNED.until) {
                if (MEDIA_TAGS.has(VSC_PINNED.el.tagName)) return VSC_PINNED.el;
            }

            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            let bestAny = null, maxScoreAny = -Infinity;
            let bestVideo = null, maxScoreVideo = -Infinity;

            const now = Date.now();
            const screenArea = window.innerWidth * window.innerHeight;

            for(const c of candidates) {
                if (!c.isConnected) continue;
                const rect = c.getBoundingClientRect();
                if (rect.width < 10 || rect.height < 10) continue;
                if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;

                let score = rect.width * rect.height;
                const area = rect.width * rect.height;
                const isVideo = c.tagName === 'VIDEO';
                const isIframe = c.tagName === 'IFRAME';

                const isHot = (isVideo && (!c.paused || (c._vscLastPlay && now - c._vscLastPlay < 15000)));

                if (area < screenArea * 0.06 && !isHot && document.pictureInPictureElement !== c) {
                     score *= 0.5;
                }

                if (isVideo) {
                    if (!c.paused) score *= 2.5;
                    if (c.readyState >= 3) score *= 1.5;
                    if (c.src || c.srcObject) score *= 1.2;
                    if (!c.muted && c.volume > 0) score *= 2.0;
                    if (c._vscLastPlay && now - c._vscLastPlay < 15000) score *= 3.0;
                    if (c.duration && !isNaN(c.duration) && c.duration < 2) score *= 0.1;
                    if (document.fullscreenElement === c) score *= 3.0;
                } else if (isIframe) {
                    if (area > screenArea * 0.2) score *= 1.5;
                    if (c === document.activeElement) score *= 2.0;
                } else {
                    score *= 0.5;
                }

                const dist = Math.min(2e6, (rect.x + rect.width/2 - cx)**2 + (rect.y + rect.height/2 - cy)**2);
                score -= dist * 0.0001;

                if (score > maxScoreAny) { maxScoreAny = score; bestAny = c; }
                if (isVideo && score > maxScoreVideo) { maxScoreVideo = score; bestVideo = c; }
            }

            if (bestVideo && maxScoreVideo > maxScoreAny * 0.85) return bestVideo;

            return bestAny;
        },
        _kickImmediateAnalyze() {
            const now = performance.now();
            if (this._lastKick && now - this._lastKick < 60) return;
            this._lastKick = now;
            requestAnimationFrame(() => { try { if (this.targetVideo && this.ctx) this.processFrame(true); } catch {} });
        },
        start(video, settings) {
            if (!video || !MEDIA_TAGS.has(video.tagName)) return;

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

            const isAutoExposure = !!this.currentSettings.autoExposure;
            if (!isAutoExposure) {
                if (this.isRunning) this.stop();
                return;
            }

            if (this.taintedResources.has(video)) {
                this.notifyUpdate({ linearGain: 1.0, tainted: true }, 0, video, true);
                return;
            }
            if (this.isRunning && this.targetVideo === video) return;
            this.targetVideo = video;
            this.hasRVFC = (video.tagName === 'VIDEO' && 'requestVideoFrameCallback' in video);

            if (video.tagName === 'IFRAME') {
                 this.taintedResources.add(video);
                 this.notifyUpdate({ linearGain: 1.0, tainted: true }, 0, video, true);
                 return;
            }

            if (this.canvas) {
                const vw = video.videoWidth || video.width || video.clientWidth || 0;
                let targetSize = (vw > 640 && IS_HIGH_END) ? 48 : (IS_LOW_END ? 24 : 32);
                if (IS_MOBILE) {
                    targetSize = (document.fullscreenElement === video) ? 32 : 24;
                }
                if (IS_DATA_SAVER) targetSize = 24;
                if (this.canvas.width !== targetSize) { this.canvas.width = targetSize; this.canvas.height = targetSize; }
            }
            if (!this._worker && !this._workerUrl) this.init(this.stateManager);
            this.isRunning = true; this._roiP50History = []; this._p10Ema = -1; this._p90Ema = -1; this._lowMotionSkip = 0;

            this.notifyUpdate({
                linearGain: this.currentLinearGain
            }, 0.5, this.targetVideo, false);

            try { relaxMediaLocks(video); } catch(e) {}
            this.loop();
        },
        stop() {
            this.isRunning = false;

            if (this._stopTimeout) {
                clearTimeout(this._stopTimeout);
                this._stopTimeout = null;
            }

            if (this.hasRVFC && this.targetVideo && this.handle) { try { this.targetVideo.cancelVideoFrameCallback(this.handle); } catch { } }
            this.handle = null; this._rvfcCb = null;
            this.targetVideo = null; this.frameSkipCounter = 0; this.lastAvgLuma = -1; this._highMotion = false;
            this._roiP50History = []; this._p10Ema = -1; this._p90Ema = -1;

            this._workerBusy = false;
            this._workerLastSent = 0;
            this._aeHoldUntil = 0;
            this._evAggressiveUntil = 0;
            this._aeActive = false;
        },
        updateSettings(settings) {
            const next = { ...this.currentSettings, ...settings };
            const prev = this.currentSettings;
            this.currentSettings = next;
            const now = performance.now();

            const isAutoExposure = !!next.autoExposure;

            if (!isAutoExposure) {
                if (this.isRunning) this.stop();
                this.notifyUpdate({ linearGain: 1.0 }, 0);
                return;
            }

            const aeTurnedOn = next.autoExposure && !prev.autoExposure;
            if (aeTurnedOn) {
                this.frameSkipCounter = 999;
                this._evAggressiveUntil = now + 1500;
                this.dynamicSkipThreshold = 0;
                this._lowMotionFrames = 0;

                const best = this._pickBestVideoNow();
                if (best) {
                    this.start(best, { autoExposure: next.autoExposure, clarity: next.clarity });
                } else {
                    const findAndStart = (count) => {
                        if (!this.currentSettings.autoExposure || this.isRunning) return;
                        const v = this._pickBestVideoNow();
                        if (v) this.start(v, { autoExposure: next.autoExposure, clarity: next.clarity });
                        else if (count > 0) setTimeout(() => findAndStart(count - 1), 200);
                    };
                    findAndStart(10);
                }
                this._kickImmediateAnalyze();
            }
            if (!next.autoExposure && prev.autoExposure) { this._evAggressiveUntil = 0; }

            if (isAutoExposure) {
                if (this.isRunning && this.targetVideo && this.targetVideo.isConnected) {
                        if (aeTurnedOn) this._kickImmediateAnalyze();
                        return;
                }
                const best = this._pickBestVideoNow();
                if (best) { this.start(best, { autoExposure: next.autoExposure, clarity: next.clarity }); }
            }
        },
        loop() {
            if (!this.isRunning || !this.targetVideo) return;

            if (document.hidden) {
                setTimeout(() => { if (this.isRunning) this.loop(); }, 1000);
                return;
            }

            if (this.hasRVFC) {
                if (!this._rvfcCb) {
                    this._rvfcCb = () => {
                        if (!this.isRunning || !this.targetVideo || document.hidden) {
                             setTimeout(() => { if (this.isRunning && !document.hidden) this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb); }, 500);
                             return;
                        }
                        try { this.processFrame(); } catch (e) { if (CONFIG.DEBUG) console.warn(e); }
                        this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb);
                    };
                }
                this.handle = this.targetVideo.requestVideoFrameCallback(this._rvfcCb);
            } else {
                this.processFrame();
                const delay = (this.targetVideo.paused) ? 500 : (this.dynamicSkipThreshold > 5 ? 150 : 80);
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
                 if (this._workerLastSent > 0 && now - this._workerLastSent > 1500) {
                     this._workerStallCount = (this._workerStallCount || 0) + 1;
                     this._workerBusy = false; this._workerLastSent = 0;
                     const stallLimit = (IS_MOBILE || IS_DATA_SAVER) ? 3 : 2;
                     if (this._workerStallCount >= stallLimit) {
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

            if (IS_MOBILE && !aggressive) {
                if (!this._aeActive || Math.abs(this.currentLinearGain - 1.0) < 0.02) effectiveThreshold += 3;
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
                const step = IS_MOBILE ? 2 : ((size <= 32) ? 1 : 2);
                const finalStep = aggressive ? step + 1 : step;

                const fid = ++this._frameId;
                const vid = this._getVideoId(this.targetVideo);

                if (this._worker) {
                        this._workerBusy = true; this._workerLastSent = performance.now();
                        const buf = imageData.data.buffer;
                        const msg = { type: 'analyze', fid, vid, buf, width: size, height: size, step: finalStep };
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
        _processAnalysisResult(p10, p50, p55, p90, p98, avgLuma, stdDev, avgR, avgG, avgB, clipFrac = 0, clipFracBottom = 0, validCount = 100, avgSat = 0.5) {

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

            const now = performance.now();

            if (isCut) {
                this._evAggressiveUntil = now + 800;
                this._lowMotionFrames = 0;
            }

            const aggressive = (this._evAggressiveUntil && now < this._evAggressiveUntil);

            if (isCut || (this._aeHoldUntil && now < this._aeHoldUntil)) {
                if (isCut) this._aeHoldUntil = now + 600;
            }

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

            if (!aggressive && !this._aeActive && Math.abs(this.currentLinearGain - 1.0) < 0.01 && this._lowMotionFrames > 30) {
                const cap = IS_MOBILE ? 40 : 55;
                this.dynamicSkipThreshold = Math.min(cap, (this.dynamicSkipThreshold || 0) + 2);
            } else {
                this.dynamicSkipThreshold = Math.max(0, (this.dynamicSkipThreshold || 0) - 3);
            }

            let targetLinearGain = 1.0;
            const isAutoExp = this.currentSettings.autoExposure;

            if (isAutoExp) {
                const aeStr = MIN_AE.STRENGTH;
                const minClipPixels = (validCount < 220) ? 2 : 5;
                const dynamicClipLimit = Math.max(MIN_AE.CLIP_FRAC_LIMIT, (validCount > 0 ? minClipPixels / validCount : 0));

                const highlightSmall = clipFrac < dynamicClipLimit * 0.7;

                const isLowKey = ((stdDev > MIN_AE.LOWKEY_STDDEV && p10 > MIN_AE.LOWKEY_P10) && p50m < 0.20) ||
                                 ((p90 > 0.82) && p50m < 0.18) ||
                                 ((p98 > 0.92 && !highlightSmall) && p50m < 0.20);

                const lowContrastDark = (stdDev < 0.06 && p50m < 0.14 && p98 < 0.70);

                const effectiveMidMin = (p50m < 0.10 && !IS_MOBILE) ? 0.18 : MIN_AE.MID_OK_MIN;
                const midTooDark = p50m < effectiveMidMin;

                const subtitleLikely = (clipFracBottom > dynamicClipLimit * 1.5) && (p98 > 0.96) && (p50m < 0.22) && (stdDev > 0.06) && (highlightSmall || p90 < 0.75);

                const clipRisk = ((p98 >= MIN_AE.P98_CLIP && !highlightSmall) || (clipFrac > dynamicClipLimit)) && !subtitleLikely;

                if (clipRisk) {
                    targetLinearGain = 1.0;
                    this._aeActive = false;
                    this._aeHoldUntil = 0;
                }
                else if (midTooDark && !isLowKey) {
                    let allowNudge = false;
                    if (lowContrastDark && p50m < 0.10 && p98 < 0.60 && clipFrac < dynamicClipLimit) {
                        allowNudge = true;
                    }

                    if (!lowContrastDark || allowNudge) {
                        const safeCurrent = Math.max(0.02, p50m);
                        let targetMid = MIN_AE.TARGET_MID_BASE;

                        if (p50m < 0.08) targetMid = 0.32;

                        let baseEV = Math.log2(targetMid / safeCurrent);

                        let maxUp = MIN_AE.MAX_UP_EV;
                        const headroomEV = Math.log2(0.98 / Math.max(0.01, p98));

                        if (p50m < 0.08 && headroomEV > 0.6 && stdDev < 0.18) {
                             maxUp = Math.min(MIN_AE.MAX_UP_EV_EXTRA, headroomEV * 0.75);
                        } else if (p50m < 0.14 && headroomEV > 0.4) {
                             maxUp = Math.min(MIN_AE.MAX_UP_EV_DARK, headroomEV * 0.6);
                        }

                        if (allowNudge) {
                            maxUp = Math.min(maxUp, 0.10);
                        }

                        let currentAeStr = aeStr;
                        if (p50m < 0.08) currentAeStr = MIN_AE.STRENGTH_DARK;

                        let autoEV = Utils.clamp(baseEV * currentAeStr, MIN_AE.MAX_DOWN_EV, maxUp);

                        let rawEV = autoEV;

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
                } else {
                    targetLinearGain = 1.0;
                    this._aeActive = false;
                }
            }

            if (this._aeHoldUntil && now < this._aeHoldUntil && !aggressive) {
                 targetLinearGain = this.currentLinearGain || 1.0;
            }

            const dt = now - (this.lastApplyTime || now);
            this.lastApplyTime = now;

            const currentEV = Math.log2(this.currentLinearGain || 1.0);
            const targetEV = Math.log2(targetLinearGain);
            const diff = targetEV - currentEV;

            let tau = (diff > 0) ? MIN_AE.TAU_UP : MIN_AE.TAU_DOWN;
            if (aggressive) tau = MIN_AE.TAU_AGGRESSIVE;
            if (targetLinearGain === 1.0 && this._aeActive === false) tau = 250;

            const alpha = 1 - Math.exp(-dt / tau);
            const nextEV = currentEV + diff * alpha;

            this.currentLinearGain = Math.pow(2, nextEV);

            if (Math.abs(this.currentLinearGain - 1.0) < 0.01 && !aggressive) this.currentLinearGain = 1.0;

            const hiGate = Utils.clamp((this._p90Ema - 0.84) / 0.10, 0, 1);
            const shNeed = Utils.clamp((0.10 - this._p10Ema) / 0.10, 0, 1);
            const shadowsAdj = Math.round(shNeed * (IS_MOBILE ? 10 : 12) * (1 - hiGate));
            const highlightsAdj = Math.round(hiGate * (IS_MOBILE ? 8 : 10));

            this.notifyUpdate({
                linearGain: this.currentLinearGain,
                shadowsAdj: shadowsAdj,
                highlightsAdj: highlightsAdj,
                colorfulness: avgSat,
                autoGamma: 1.0, // Initial defaults
                autoBright: 0,
                autoShadows: shadowsAdj,
                autoHighlights: highlightsAdj,
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

            if (this.source) { try { this.source.disconnect(); } catch(e) {} this.source = null; }

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
        this._lastBackoffForceScan = 0;
        this._playDetectTimer = 0;
        this._cachedHasPotential = false;
        this._hasDomVideo = false;
        }

        _tryGetIframeDoc(fr) {
             const now = performance.now();
             const c = this._iframeDocCache.get(fr);
             if (c && (now - c.t) < 3000) return c.ok ? c.doc : null;

             if (fr.contentWindow) {
                 try {
                     if (fr.contentWindow[VSC_BOOT_KEY]) return null;
                 } catch (e) {}
             }

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
            const stopAnalyzer = () => { try { const va=VA(); if(va) va.stop(); } catch {} };
            on(document, 'visibilitychange', () => {
                try { this._updateHooksState?.(); } catch {}
                if (document.hidden) stopAnalyzer();
                else if (this.stateManager.get('videoFilter.autoExposure')) { const va=VA(); if(va) va._kickImmediateAnalyze(); }
            }, P(this._ac.signal));

            on(window, 'pagehide', stopAnalyzer, P(this._ac.signal));
            on(window, 'blur', stopAnalyzer, P(this._ac.signal));

            on(window, 'pageshow', (e) => {
                if (e.persisted) {
                    try {
                        triggerBurstScan(150);
                        if (this.stateManager.get('videoFilter.autoExposure')) { const va=VA(); if(va) va._kickImmediateAnalyze(); }
                    } catch {}
                }
            }, P(this._ac.signal));

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

            on(document, 'keydown', (e) => {
                if (e.code === 'Space' || e.key === ' ' || e.key === 'k') {
                      triggerBurstScan(50);
                }
            }, CP(this._ac.signal));

            on(document, 'play', (e) => {
                const t = e.target;
                if (t && t.tagName === 'VIDEO') {
                    this.lastInteractedMedia = t;
                    t._vscLastPlay = Date.now();
                    this.updateGlobalAttrObs(true);
                    clearTimeout(this._playDetectTimer);
                    this._playDetectTimer = setTimeout(() => this.updateGlobalAttrObs(this.stateManager.get('app.scriptActive')), 5000);
                    if (t.getBoundingClientRect().width > 100) this.stateManager.set('media.currentlyVisibleMedia', t);
                    if (this.stateManager.get('videoFilter.autoExposure')) { const va=VA(); if(va) va._kickImmediateAnalyze(); }
                }
            }, CP(this._ac.signal));

            ['seeked', 'loadedmetadata'].forEach(evt => {
                on(document, evt, (e) => {
                    if (e.target && e.target.tagName === 'VIDEO' && this.stateManager.get('videoFilter.autoExposure')) {
                        const va = VA();
                        if (va) { va._aeHoldUntil = performance.now() + 800; va._kickImmediateAnalyze(); }
                    }
                }, CP(this._ac.signal));
            });

            on(document, 'fullscreenchange', () => {
                 if (this.stateManager.get('videoFilter.autoExposure') && document.fullscreenElement) {
                      const va = VA();
                      if (va) { va._evAggressiveUntil = performance.now() + 800; va._kickImmediateAnalyze(); }
                 }
            }, P(this._ac.signal));

            this._backoffInterval = setInterval(() => { if (this._mutationCounter > 100) { if (!this._isBackoffMode) { this._isBackoffMode = true; } } else { if (this._isBackoffMode) { this._isBackoffMode = false; scheduleScan(null); } } this._mutationCounter = 0; }, 1000);

            this.mainObserver = new MutationObserver((mutations) => {
                this._mutationCounter += mutations.length;
                this._domDirty = true;

                let sawMedia = false;
                const cap = Math.min(25, mutations.length);
                for (let i = 0; i < cap; i++) {
                      const m = mutations[i];
                      for (const n of m.addedNodes || []) {
                          if (n && n.nodeType === 1) {
                              if (n.tagName === 'VIDEO' || n.tagName === 'IFRAME' || n.tagName === 'CANVAS') { sawMedia = true; break; }
                              if (n.querySelector?.('video,iframe,canvas')) { sawMedia = true; break; }
                          }
                      }
                      if (sawMedia) break;
                }
                if (sawMedia) {
                      this._hasDomVideo = true;
                      scheduleScan(null, true);
                }

                if (this._isBackoffMode) {
                      const cap = Math.min(8, mutations.length);
                      for(let i=0; i<cap; i++) {
                          const m = mutations[i];
                          for(const n of (m.addedNodes||[])) {
                              if(n && n.nodeType===1) {
                                  if(MEDIA_TAGS.has(n.nodeName) || n.querySelector?.('video,iframe,canvas')) {
                                       scheduleScan(n, true);
                                       return;
                                  }
                              }
                          }
                      }
                }

                if (this._mutationCounter > 100) {
                    if (sawMedia) scheduleScan(null, true);
                    return;
                }

                if (mutations.length > 50) { this._domDirty = true; return; }
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
                const sensitive = isSensitiveContext();
                if (!sensitive) enableShadowHook();
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
            if ('ResizeObserver' in window) { this._resizeObs = new ResizeObserver(throttle(entries => { for (const e of entries) { if (SCAN_TAGS.has(e.target.tagName)) scheduleScan(null); } }, 200)); }
            if (this.stateManager.get('app.scriptActive')) this.updateGlobalAttrObs(true);
        }
        updateGlobalAttrObs(active) {
            if (!CONFIG.FLAGS.GLOBAL_ATTR_OBS) return;
            const sm = this.stateManager;
            const reallyNeeded = active && (sm.get('ui.areControlsVisible') || (sm.get('videoFilter.autoExposure') && !document.hidden && sm.get('media.currentlyVisibleMedia')));

            if (reallyNeeded && !this._globalAttrObs) {
                this._globalAttrObs = new MutationObserver(throttle((ms) => { let dirty = false; for (const m of ms) { if (m.target && SCAN_TAGS.has(m.target.nodeName)) { dirty = true; break; } } if (dirty) { this._domDirty = true; } }, IS_MOBILE ? 300 : 200));
                this._globalAttrObs.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: CONFIG.SCAN.MUTATION_ATTRS });
            } else if (!reallyNeeded && this._globalAttrObs) { this._globalAttrObs.disconnect(); this._globalAttrObs = null; }
        }
        runStartupBoost() { const aggressiveScan = () => { if (this.stateManager.get('media.activeMedia').size === 0) scheduleScan(null, true); }; [300, 1500, 5000].forEach(d => setTimeout(aggressiveScan, d)); }
        destroy() {
            super.destroy(); _corePluginRef = null;
            const va = VA();
            if (va) {
                if (va._worker) { va._worker.terminate(); va._worker = null; }
                if (va._workerUrl) URL.revokeObjectURL(va._workerUrl);
            }
            if (this._historyOrig) { history.pushState = this._historyOrig.pushState; history.replaceState = this._historyOrig.replaceState; this._historyOrig = null; }
            if (this.mainObserver) this.mainObserver.disconnect(); if (this.intersectionObserver) this.intersectionObserver.disconnect();
            if (this.scanTimerId) clearTimeout(this.scanTimerId); if (this._resizeObs) this._resizeObs.disconnect(); if (this._globalAttrObs) this._globalAttrObs.disconnect();
            if (this._backoffInterval) clearInterval(this._backoffInterval);

            try {
                if (_shadowHookActive && ORIGINALS.attachShadow) {
                    Element.prototype.attachShadow = ORIGINALS.attachShadow;
                    _shadowHookActive = false;
                }
            } catch {}
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
            const sm = this.stateManager;

            const activeSize = sm.get('media.activeMedia').size;
            if (this._domDirty || activeSize === 0) {
                 this._cachedHasPotential = activeSize > 0 || document.getElementsByTagName('video').length > 0 || document.getElementsByTagName('iframe').length > 0;
                 this._hasDomVideo = this._cachedHasPotential;
            }

            if (!sm.get('app.scriptActive') && !sm.get('ui.areControlsVisible')) {
                this.currentScanInterval = 15000;
            } else if (this._cachedHasPotential) {
                this.emptyScanCount = 0; this.currentScanInterval = this.baseScanInterval;
            } else {
                this.emptyScanCount++; if (this.emptyScanCount > 3) this.currentScanInterval = Math.min(CONFIG.SCAN.INTERVAL_MAX, this.currentScanInterval * 1.5);
            }
            this.scheduleNextScan();
        }
        ensureObservers() {
            if (!this.intersectionObserver) {
                const margin = IS_MOBILE ? '80px 0px 120px 0px' : '200px 0px 200px 0px';
                this.intersectionObserver = new IntersectionObserver(entries => {
                    let needsUpdate = false;
                    entries.forEach(e => {
                        const isVisible = e.isIntersecting && e.intersectionRatio > 0;
                        if (this.stateManager.get('media.visibilityMap')) this.stateManager.get('media.visibilityMap').set(e.target, isVisible);
                        if (e.target.tagName === 'VIDEO') { if (isVisible) this._visibleVideos.add(e.target); else this._visibleVideos.delete(e.target); needsUpdate = true; }
                    });
                    if (needsUpdate) {
                         const t = this.stateManager.get('media.visTick') || 0;
                         this.stateManager.set('media.visTick', t + 1);

                         if (!document.hidden) {
                             if (this._centerCalcTimer) clearTimeout(this._centerCalcTimer);
                             this._centerCalcTimer = setTimeout(() => {
                                 if (this._visibleVideos.size === 0) return;
                                 const currentBest = this.stateManager.get('media.currentlyVisibleMedia');
                                 const va = VA();
                                 if (va) {
                                     const newBest = va._pickBestVideoNow();
                                     if (newBest && newBest !== currentBest) {
                                         if (currentBest) va.stop();
                                         this.stateManager.set('media.currentlyVisibleMedia', newBest);
                                         const vf = this.stateManager.get('videoFilter');
                                         if (this.stateManager.get('app.scriptActive') && (vf.autoExposure || vf.clarity > 0)) va.start(newBest, { autoExposure: vf.autoExposure, clarity: vf.clarity });
                                     }
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

            const videos = Utils.getByTag(root, 'video');
            for (let i = 0; i < videos.length; i++) this._checkAndAdd(videos[i], media, images, iframes);

            const canvases = Utils.getByTag(root, 'canvas');
            for (let i = 0; i < canvases.length; i++) this._checkAndAdd(canvases[i], media, images, iframes);

            const frames = Utils.getByTag(root, 'iframe');
            for (let i = 0; i < frames.length; i++) this._checkAndAdd(frames[i], media, images, iframes);

            for (let i = 0; i < frames.length; i++) {
                const r = frames[i].getBoundingClientRect ? frames[i].getBoundingClientRect() : null;
                const margin = IS_MOBILE ? 700 : 300;
                if (r && (r.bottom < -margin || r.top > window.innerHeight + margin)) continue;

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
                if (total > 0) {
                    for (let i = 0; i < BATCH_SIZE && i < total; i++) {
                        const idx = (this._shadowScanIndex + i) % total;
                        const sr = _localShadowRoots[idx];
                        if (sr) {
                             try { const r = this.findAllElements(sr, depth + 1, true); r.media.forEach(m => media.add(m)); r.images.forEach(i => images.add(i)); r.iframes.forEach(f => iframes.add(f)); } catch(e){}
                        }
                    }
                    this._shadowScanIndex = (this._shadowScanIndex + BATCH_SIZE) % total;
                } else {
                    this._shadowScanIndex = 0;
                }
            }
            return { media, images, iframes };
        }
        scanSpecificRoot(root) {
            this.ensureObservers();
            const media = new Set(), images = new Set(), iframes = new Set();
            if (root.nodeType === 1 && SCAN_TAGS.has(root.tagName)) this._checkAndAdd(root, media, images, iframes);
            else { const r = this.findAllElements(root, 0, true); r.media.forEach(m=>media.add(m)); r.images.forEach(i=>images.add(i)); r.iframes.forEach(f=>iframes.add(f)); }
            this._applyToSets(media, images, iframes);
        }
        _applyToSets(mediaSet, imageSet, iframeSet) {
             const sm = this.stateManager;
             const curM = sm.get('media.activeMedia');
             const curI = sm.get('media.activeImages');
             const curF = sm.get('media.activeIframes');

             let nextM = curM, nextI = curI, nextF = curF;
             let changed = false;

             for (const m of mediaSet) {
                 if (!m.isConnected) continue;
                 if (!this.attachMediaListeners(m)) continue;
                 if (!curM.has(m)) {
                     if (nextM === curM) nextM = new Set(curM);
                     nextM.add(m); changed = true;
                 }
             }

             for (const i of imageSet) {
                 if (!i.isConnected) continue;
                 if (!this.attachImageListeners(i)) continue;
                 if (!curI.has(i)) {
                     if (nextI === curI) nextI = new Set(curI);
                     nextI.add(i); changed = true;
                 }
             }

             for (const f of iframeSet) {
                 if (!f.isConnected) continue;
                 if (!this.attachIframeListeners(f)) continue;
                 if (!curF.has(f)) {
                     if (nextF === curF) nextF = new Set(curF);
                     nextF.add(f); changed = true;
                 }
             }

             if (changed) {
                 if (nextM !== curM) sm.set('media.activeMedia', nextM);
                 if (nextI !== curI) sm.set('media.activeImages', nextI);
                 if (nextF !== curF) sm.set('media.activeIframes', nextF);
                 if (!sm.get('ui.globalContainer')) {
                     const allowUI = IS_TOP;
                     if (allowUI) sm.set('ui.createRequested', true);
                 }
             }
        }
        _hookIframe(frame) {
            if (!frame || this._seenIframes.has(frame)) return; this._seenIframes.add(frame);
            const onLoad = () => { triggerBurstScan(200); };
            try { frame.addEventListener('load', onLoad, { passive: true }); } catch (e) { }
        }
        attachMediaListeners(media) {
            const owner = media.getAttribute('data-vsc-controlled-by');
            if (owner && owner !== VSC_INSTANCE_ID) return false;

            try { this.intersectionObserver.observe(media); } catch (e) { return false; }
            media.setAttribute('data-vsc-controlled-by', VSC_INSTANCE_ID);
            if (this.stateManager.filterManagers.video) injectFiltersIntoContext(media, this.stateManager.filterManagers.video, this.stateManager);

            if (media.tagName === 'VIDEO') {
                const attrMo = new MutationObserver(debounce((mutations) => {
                    for(const m of mutations) if(m.type==='attributes') { const va=VA(); if(va) { va.taintedResources.delete(media); } scheduleScan(media, true); }
                }, 100));
                attrMo.observe(media, { attributes: true, subtree: true, attributeFilter: ['src', 'poster', 'data-src'] });
                this.stateManager.get('media.mediaListenerMap').set(media, () => { attrMo.disconnect(); });
            }

            if (this._resizeObs) this._resizeObs.observe(media);
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
        constructor() { super('SvgFilter'); this.filterManager = null; this.imageFilterManager = null; this.lastAutoParams = { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0 }; this.throttledUpdate = null; this._rafId = null; this._imageRafId = null; this.isGlobalBypass = false; this._aeEma = null; this._aeLastT = 0; }
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
            this.subscribe('imageFilter.level', (val) => { this.applyAllImageFilters(); if (val > 0) { const core = window.vscPluginManager?.plugins?.find(p => p.name === 'CoreMedia'); if (core) core.scanAndApply(); } });
            this.subscribe('imageFilter.colorTemp', this.applyAllImageFilters.bind(this));
            this.subscribe('media.visTick', () => this.applyAllVideoFilters());
            this.subscribe('ui.areControlsVisible', () => this.applyAllVideoFilters()); this.subscribe('app.scriptActive', () => { this.applyAllVideoFilters(); });

            this.throttledUpdate = throttle((e) => {
                const { autoParams, videoInfo, aeActive, colorfulness } = e.detail;
                const currentMedia = this.stateManager.get('media.currentlyVisibleMedia');
                if (videoInfo && videoInfo !== currentMedia) return;

                const vf = this.stateManager.get('videoFilter');
                if (!vf.autoExposure && vf.clarity <= 0) return;

                let isChanged = false;
                if (vf.autoExposure) {
                    const prevGain = this.lastAutoParams.linearGain || 1.0;
                    const nextGain = autoParams.linearGain || 1.0;
                    const prevAe = !!this.lastAutoParams.aeActive;
                    const nextAe = !!aeActive;
                    isChanged = (Math.abs(nextGain - prevGain) > 0.002) || (prevAe !== nextAe);
                }

                const aeFlip = (this.lastAutoParams.aeActive !== aeActive);
                if (vf.autoExposure && !isChanged && !aeFlip && vf.clarity <= 0) return;

                const applyDeadband = (next, prev, eps) => (prev == null || Math.abs(next - prev) >= eps) ? next : prev;

                this.lastAutoParams = {
                    ...this.lastAutoParams,
                    linearGain: autoParams.linearGain ?? 1.0,
                    gamma: applyDeadband(autoParams.gamma ?? 1.0, this.lastAutoParams.gamma, 0.02),
                    bright: applyDeadband(autoParams.bright ?? 0, this.lastAutoParams.bright, 0.8),
                    shadowsAdj: applyDeadband(autoParams.shadowsAdj ?? 0, this.lastAutoParams.shadowsAdj, 1.0),
                    highlightsAdj: applyDeadband(autoParams.highlightsAdj ?? 0, this.lastAutoParams.highlightsAdj, 1.0),
                    aeActive: aeActive,
                    colorfulness: colorfulness ?? 0.5,
                    // [v132.0.89] Pass auto signal for proxy
                    autoGamma: autoParams.autoGamma,
                    autoBright: autoParams.autoBright,
                    autoShadows: autoParams.autoShadows,
                    autoHighlights: autoParams.autoHighlights
                };

                this.applyAllVideoFilters();
            }, 100);

            document.addEventListener('vsc-smart-limit-update', this.throttledUpdate);
            if (this.stateManager.get('app.scriptActive')) { this.filterManager.init(); this.imageFilterManager.init(); this.applyAllVideoFilters(); this.applyAllImageFilters(); }
        }
        destroy() { super.destroy(); if (this.throttledUpdate) document.removeEventListener('vsc-smart-limit-update', this.throttledUpdate); if (this._rafId) cancelAnimationFrame(this._rafId); if (this._imageRafId) cancelAnimationFrame(this._imageRafId); }

        setInlineFilter(el, filterCss) {
            if (!el || el.nodeType !== 1) return;
            if (el.dataset.vscPrevFilter === undefined) {
                el.dataset.vscPrevFilter = el.style.getPropertyValue('filter') || '';
                el.dataset.vscPrevWebkitFilter = el.style.getPropertyValue('-webkit-filter') || '';
            }
            el.style.setProperty('filter', filterCss, 'important');
            el.style.setProperty('-webkit-filter', filterCss, 'important');
            el.dataset.vscInlineFilter = '1';
        }

        restoreInlineFilter(el) {
            if (!el || el.nodeType !== 1) return;
            const prev = el.dataset.vscPrevFilter;
            const prevW = el.dataset.vscPrevWebkitFilter;
            if (prev !== undefined) el.style.setProperty('filter', prev);
            else el.style.removeProperty('filter');
            if (prevW !== undefined) el.style.setProperty('-webkit-filter', prevW);
            else el.style.removeProperty('-webkit-filter');
            delete el.dataset.vscPrevFilter;
            delete el.dataset.vscPrevWebkitFilter;
            delete el.dataset.vscInlineFilter;
        }

        _scheduleRaf(slotKey, fn) {
            if (this[slotKey]) return;
            this[slotKey] = requestAnimationFrame(() => {
                this[slotKey] = null;
                fn();
            });
        }

        _createManager(options) {
            const INSTANCE = VSC_INSTANCE_ID;
            options.svgId = `${options.svgId}-${INSTANCE}`;
            options.styleId = `${options.styleId}-${INSTANCE}`;

            class SvgFilterManager {
                constructor(options) { this._isInitialized = false; this._styleElement = null; this._svgNode = null; this._options = options; this._elementCache = new WeakMap(); this._activeFilterRoots = new Set(); this._globalToneCache = { key: null, table: null }; this._gainTableCache = new Map(); this._lastValues = null; this._clarityTableCache = new Map(); this._pruneTimer = null; this._pending = null; this._raf = 0; }
                isInitialized() { return this._isInitialized; } getSvgNode() { return this._svgNode; } getStyleNode() { return this._styleElement; }
                init() { if (this._isInitialized) return; safeGuard(() => {
                    const { svgId, styleId } = this._options;
                    const oldSvg = document.getElementById(svgId); if(oldSvg) oldSvg.remove();
                    const oldStyle = document.getElementById(styleId); if(oldStyle) oldStyle.remove();

                    Utils.ensureDomReady().then(() => {
                        if (this._isInitialized) return;
                        const { svgNode, styleElement } = this._createElements();
                        this._svgNode = svgNode; this._styleElement = styleElement;
                        document.body.appendChild(svgNode);
                        document.head.appendChild(styleElement);
                        this._activeFilterRoots.add(this._svgNode);
                        this._isInitialized = true;

                        if (!this._pruneTimer) {
                            this._pruneTimer = setInterval(() => this.prune(), 4000);
                            window.addEventListener('pagehide', () => { try { clearInterval(this._pruneTimer); } catch {} this._pruneTimer = null; }, { once: true });
                        }
                    });
                }, `${this.constructor.name}.init`); }
                registerContext(svgElement) { this._activeFilterRoots.add(svgElement); }

                prune() {
                    const dead = [];
                    for (const root of this._activeFilterRoots) {
                        if (!root || !root.isConnected) dead.push(root);
                    }
                    dead.forEach(root => {
                        this._activeFilterRoots.delete(root);
                        if (root && typeof root === 'object') this._elementCache.delete(root);
                    });
                }

                requestUpdate(values) {
                    this._pending = values;
                    if (this._raf) return;
                    this._raf = requestAnimationFrame(() => {
                        this._raf = 0;
                        const v = this._pending;
                        this._pending = null;
                        if (v) this.updateFilterValues(v);
                    });
                }

                _createElements() {
                    const createSvgElement = (tag, attr, ...children) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attr) el.setAttribute(k, attr[k]); el.append(...children); return el; };
                    const { settings, svgId, styleId, className, isImage } = this._options;
                    const combinedFilterId = `${settings.SHARPEN_ID}_combined_filter`; const combinedFilterNoGrainId = `${settings.SHARPEN_ID}_combined_filter_nograin`;
                    const svg = createSvgElement('svg', { id: svgId, style: 'display:none;position:absolute;width:0;height:0;' });
                    svg.dataset.vscInstance = VSC_INSTANCE_ID;

                    const style = document.createElement('style'); style.id = styleId;
                    style.dataset.vscInstance = VSC_INSTANCE_ID;
                    style.textContent = ` .${className} {} .${className}.no-grain {} `;

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

                        const createFuncGroup = (idBase, { inId = lastOut, resultId = idBase + "_out", type='linear', slope='1', intercept='0', tableValues=null } = {}) => {
                            const group = createSvgElement('feComponentTransfer', { "data-vsc-id": idBase, in: inId, result: resultId });
                            const rid = (idBase === 'post_colortemp') ? 'ct_red'   : `${idBase}_func`;
                            const gid = (idBase === 'post_colortemp') ? 'ct_green' : `${idBase}_func`;
                            const bid = (idBase === 'post_colortemp') ? 'ct_blue'  : `${idBase}_func`;
                            const make = (chId) => {
                                const attrs = { "data-vsc-id": chId, type };
                                if (type === 'linear') { attrs.slope = slope; attrs.intercept = intercept; }
                                if (type === 'table')  { attrs.tableValues = tableValues || "0 1"; }
                                return attrs;
                            };
                            group.append(createSvgElement('feFuncR', make(rid)));
                            group.append(createSvgElement('feFuncG', make(gid)));
                            group.append(createSvgElement('feFuncB', make(bid)));
                            return group;
                        };

                        if (isImage) {
                            const colorTemp = createFuncGroup("post_colortemp", { inId: lastOut });
                            filter.append(colorTemp);
                        } else {
                            const lumaContrast = createSvgElement('feColorMatrix', { "data-vsc-id": "luma_contrast_matrix", in: lastOut, type: "matrix", values: "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0", result: "luma_contrast_out" });
                            const saturation = createSvgElement('feColorMatrix', { "data-vsc-id": "saturate", in: "luma_contrast_out", type: "saturate", values: (settings.SAT / 100).toString(), result: "saturate_out" });
                            const exposure = createFuncGroup("exposure", { inId: "saturate_out", resultId: "linear_out", type: "table" });
                            const gamma = createSvgElement('feComponentTransfer', { "data-vsc-id": "gamma", in: "linear_out", result: "gamma_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'gamma', exponent: (1 / settings.GAMMA).toString() })));
                            const toneCurve = createSvgElement('feComponentTransfer', { "data-vsc-id": "tone_curve", in: "gamma_out", result: "tone_out" }, ...['R', 'G', 'B'].map(ch => createSvgElement(`feFunc${ch}`, { type: 'table', tableValues: "0 1" })));
                            const colorTemp = createFuncGroup("post_colortemp", { inId: "tone_out" });
                            filter.append(lumaContrast, saturation, exposure, gamma, toneCurve, colorTemp);
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
                    const gain = (values.linearGain == null) ? 1.0 : Number(values.linearGain);
                    const gainQ = Math.round(gain * 100);

                    const q = (x, step) => Math.round((Number(x) || 0) / step) * step;
                    const bQ = q(values.brightness, 0.5);
                    const cQ = q(values.contrastAdj, 0.02);
                    const shQ = q(values.shadows, 1);
                    const hiQ = q(values.highlights, 1);
                    const satQ = q(values.saturation, 1);
                    const tempQ = q(values.colorTemp, 1);
                    const gamQ = q(values.gamma, 0.02);

                    const sigStr = `${gamQ}|${v(values.sharpenLevel)}|${v(values.level2)}|${tempQ}|${satQ}|${shQ}|${hiQ}|${bQ}|${cQ}|${v(values.dither)}|${v(values.clarity)}|${gainQ}|${values.autoExposure?1:0}`;
                    const sig = Utils.fastHash(sigStr);

                    if (this._lastValues === sig) return; this._lastValues = sig;

                    const { saturation, gamma, sharpenLevel, level2, shadows, highlights, brightness, contrastAdj, colorTemp, dither, clarity } = values;
                    let currentToneTable = null; const contrastSafe = (contrastAdj == null) ? 1.0 : Number(contrastAdj);
                    const toneKey = (shadows !== undefined) ? `${shQ}_${hiQ}_${bQ}` : null;
                    if (toneKey) {
                        if (this._globalToneCache.key !== toneKey) {
                            const genSCurveTable = (sh, hi, br = 0) => {
                                const steps = 256; const vals = []; const clamp = Utils.clamp; const smoothstep = (t) => t * t * (3 - 2 * t);
                                const shN = clamp((sh || 0) / 100, -1, 1); const hiN = clamp((hi || 0) / 100, -1, 1); const b = clamp((br || 0) / 100, -1, 1) * 0.12;
                                const toe = clamp(0.20 + shN * 0.10, 0.05, 0.40);
                                const shoulder = clamp(0.82 - hiN * 0.06, 0.70, 0.95);
                                const toeStrength = 0.18 + 0.22 * Math.abs(shN); const shoulderStrength = 0.08 + 0.18 * Math.abs(hiN);
                                for (let i = 0; i < steps; i++) {
                                    let x = i / (steps - 1); let y = x; y = clamp(y + b, 0, 1);
                                    if (shN !== 0 && y < toe) { const t = clamp(y / Math.max(1e-6, toe), 0, 1); const ss = smoothstep(t); const dir = Math.sign(shN); y = y + dir * (toe - y) * toeStrength * (1 - ss); }
                                    if (hiN !== 0 && y > shoulder) { const t = clamp((y - shoulder) / Math.max(1e-6, (1 - shoulder)), 0, 1); const ss = smoothstep(t); const dir = Math.sign(hiN); y = y - dir * shoulderStrength * ss * t; }
                                    vals.push(Math.round(clamp(y, 0, 1) * 10000) / 10000);
                                }
                                return vals.join(' ');
                            };
                            this._globalToneCache.key = toneKey; this._globalToneCache.table = genSCurveTable(shadows, highlights, brightness || 0);
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
                                appliedToneKey: null,
                                last: { sat: null, gamma: null, contrastQ: null }
                            }; this._elementCache.set(rootNode, cache);
                        }
                        if (clarity !== undefined && cache.clarityFuncs) {
                            let tableVal = this._clarityTableCache.get(clarity);
                            if (!tableVal) {
                                const strength = clarity / 50; const steps = 64; const vals = [];
                                for (let i = 0; i < steps; i++) { let x = i / (steps - 1); let smooth = x * x * (3 - 2 * x); let y = x * (1 - strength) + smooth * strength; vals.push(Math.round(y * 10000) / 10000); }
                                tableVal = vals.join(' ');
                                if (this._clarityTableCache.size > 64) this._clarityTableCache.clear();
                                this._clarityTableCache.set(clarity, tableVal);
                            }
                            Utils.setAttrAll(cache.clarityFuncs, 'tableValues', tableVal);
                        }
                        if (sharpenLevel !== undefined) {
                            let strCoarse = 0; let strFine = 0;
                            if (isImage) { strFine = Math.min(4.0, sharpenLevel * 0.12); strCoarse = 0; } else { strCoarse = Math.min(3.0, sharpenLevel * 0.05); strFine = (values.level2 !== undefined) ? Math.min(3.0, values.level2 * 0.06) : 0; }
                            if (IS_MOBILE) strFine *= 0.8;
                            const sCurve = (x) => x * x * (3 - 2 * x); const fineProgress = Math.min(1, strFine / 3.0); const fineSigma = 0.5 - (sCurve(fineProgress) * 0.3); const fineK = sCurve(fineProgress) * 3.5; const coarseProgress = Math.min(1, strCoarse / 3.0); const coarseSigma = 1.5 - (sCurve(coarseProgress) * 0.8); const coarseK = sCurve(coarseProgress) * 2.0; const safeFineK = Math.min(6.0, fineK); const safeCoarseK = Math.min(4.0, coarseK);
                            if (strFine <= 0.01) { Utils.setAttrAll(cache.blurFine, 'stdDeviation', "0"); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { Utils.setAttrAll(cache.blurFine, 'stdDeviation', fineSigma.toFixed(2)); cache.compFine.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeFineK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeFineK).toFixed(3)); }); }
                            if (strCoarse <= 0.01) { Utils.setAttrAll(cache.blurCoarse, 'stdDeviation', "0"); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', "1"); Utils.setAttr(el, 'k3', "0"); }); } else { Utils.setAttrAll(cache.blurCoarse, 'stdDeviation', coarseSigma.toFixed(2)); cache.compCoarse.forEach(el => { Utils.setAttr(el, 'k2', (1 + safeCoarseK).toFixed(3)); Utils.setAttr(el, 'k3', (-safeCoarseK).toFixed(3)); }); }
                        }
                        if (dither !== undefined && cache.grainComp) { const val = dither / 100; const amount = val * 0.25; Utils.setAttr(cache.grainComp, 'k3', amount.toFixed(3)); }
                        if (saturation !== undefined && cache.saturate) {
                            const satVal = (saturation / 100);
                            if (cache.last.sat !== satVal) {
                                cache.last.sat = satVal;
                                Utils.setAttrAll(cache.saturate, 'values', satVal.toString());
                            }
                        }

                        if (cache.exposureFuncs) {
                            const gainKey = gainQ;
                            let tableVal = this._gainTableCache.get(gainKey);
                            if (!tableVal) {
                                const realGain = gainQ / 100;
                                if (Math.abs(realGain - 1.0) < 0.01) {
                                    tableVal = "0 1";
                                } else {
                                    const steps = 256;
                                    const vals = [];
                                    for (let i = 0; i < steps; i++) {
                                        const x = i / (steps - 1);
                                        const y = (x * realGain) / (1 + (realGain - 1) * x);
                                        vals.push(Math.round(Utils.clamp(y, 0, 1) * 10000) / 10000);
                                    }
                                    tableVal = vals.join(' ');
                                }
                                if (this._gainTableCache.size > 96) this._gainTableCache.clear();
                                this._gainTableCache.set(gainKey, tableVal);
                            }
                            Utils.setAttrAll(cache.exposureFuncs, 'tableValues', tableVal);
                        }

                        if (gamma !== undefined && cache.gammaFuncs) {
                            const exp = (1 / gamma);
                            if (cache.last.gamma !== exp) {
                                cache.last.gamma = exp;
                                Utils.setAttrAll(cache.gammaFuncs, 'exponent', exp.toString());
                            }
                        }
                        if (currentToneTable && cache.toneCurveFuncs) { if (cache.appliedToneKey !== toneKey) { cache.appliedToneKey = toneKey; Utils.setAttrAll(cache.toneCurveFuncs, 'tableValues', currentToneTable); } }
                        const cQ2 = Math.round(contrastSafe * 200) / 200;
                        if (contrastSafe !== undefined && cache.lumaContrastMatrix && cache.last.contrastQ !== cQ2) {
                            cache.last.contrastQ = cQ2;
                            const cAmount = (cQ2 - 1.0) * 0.9;
                            const r = 0.2126 * cAmount, g = 0.7152 * cAmount, b = 0.0722 * cAmount;
                            const mVals = [1 + r, g, b, 0, 0, r, 1 + g, b, 0, 0, r, g, 1 + b, 0, 0, 0, 0, 0, 1, 0].join(' ');
                            Utils.setAttrAll(cache.lumaContrastMatrix, 'values', mVals);
                        }
                        if (colorTemp !== undefined && cache.ctBlue && cache.ctRed && cache.ctGreen) { const t = colorTemp; const warm = Math.max(0, t); const cool = Math.max(0, -t); const rSlope = 1 + warm * 0.003 - cool * 0.005; const gSlope = 1 + warm * 0.002 - cool * 0.004; const bSlope = 1 - warm * 0.006 + cool * 0.000; const clamp = Utils.clamp; const rs = clamp(rSlope, 0.7, 1.3).toFixed(3); const gs = clamp(gSlope, 0.7, 1.3).toFixed(3); const bs = clamp(bSlope, 0.7, 1.3).toFixed(3); Utils.setAttrAll(cache.ctRed, 'slope', rs); Utils.setAttrAll(cache.ctGreen, 'slope', gs); Utils.setAttrAll(cache.ctBlue, 'slope', bs); }
                    }
                    dead.forEach(node => this._activeFilterRoots.delete(node));
                }
            }
            return new SvgFilterManager(options);
        }
        applyAllVideoFilters() { this._scheduleRaf('_rafId', () => { this._applyAllVideoFiltersActual(); this.stateManager.get('media.activeMedia').forEach(media => { if (MEDIA_TAGS.has(media.tagName)) this._updateVideoFilterState(media); }); this.stateManager.get('media.activeIframes').forEach(iframe => { this._updateVideoFilterState(iframe); }); }); }

        _approxP50P10FromAuto({ p90, totalGain, autoGamma, autoBright, autoShadows, autoHighlights }) {
            const clamp = Utils.clamp;
            const tg = Math.max(1.0, totalGain || 1.0);
            const ev = Math.log2(tg);
            const ev01 = clamp(ev / 1.5, 0, 1);
            const p90v = clamp(p90 || 0, 0, 1);

            const bN = clamp((Number(autoBright) || 0) / 12, -1, 1);
            const gN = clamp(((Number(autoGamma) || 1.0) - 1.0) / 0.35, -1, 1);
            const shN = clamp((Number(autoShadows) || 0) / 18, -1, 1);
            const hiN = clamp((Number(autoHighlights) || 0) / 18, -1, 1);

            const midDark = clamp(0.50 * gN + 0.30 * bN + 0.25 * shN - 0.20 * hiN, -1, 1);
            const lowDark = clamp(0.65 * shN + 0.25 * bN + 0.20 * gN, -1, 1);

            let baseOff50 = 0.30 - 0.10 * ev01;
            let baseOff10 = 0.62 - 0.14 * ev01;

            let off50 = baseOff50 + 0.10 * midDark;
            let off10 = baseOff10 + 0.16 * lowDark;

            off50 = clamp(off50, 0.12, 0.55);
            off10 = clamp(off10, 0.30, 0.92);

            if (off10 < off50 + 0.18) off10 = off50 + 0.18;

            const p50 = clamp(p90v - off50, 0, 1);
            const p10 = clamp(p90v - off10, 0, 1);

            return { p50, p10 };
        }

        _computeAeTuning({ totalGain, p90, p50, p10, colorfulness }) {
            const clamp = Utils.clamp;
            const smooth01 = (t) => t * t * (3 - 2 * t);

            const tg = Math.max(1.0, totalGain || 1.0);
            const ev = Math.log2(tg);
            const ev01 = clamp(ev / 1.5, 0, 1);

            const gainGate = smooth01(clamp((tg - 1.05) / 0.30, 0, 1));

            const p90v = clamp(p90 || 0, 0, 1);
            const p50v = clamp((p50 ?? (p90v - 0.30)), 0, 1);
            const p10v = clamp((p10 ?? (p90v - 0.62)), 0, 1);

            const hiBase = smooth01(clamp((p90v - 0.82) / 0.10, 0, 1));
            const midBright = smooth01(clamp(((p50v - 0.62) / 0.12), 0, 1));
            const hiGate = clamp(hiBase * (0.65 + 0.35 * midBright), 0, 1);

            // [v132.0.89] Smart gates
            const midGate = smooth01(clamp((p50v - 0.62) / 0.12, 0, 1));
            const darkGate = smooth01(clamp((0.18 - p10v) / 0.12, 0, 1));

            const cf = (colorfulness === undefined) ? 0.5 : colorfulness;
            const lowColorGate = smooth01(clamp((0.32 - cf) / 0.18, 0, 1));

            const highlightRecover = ev01 * (IS_MOBILE ? 6.5 : 8.0) * gainGate * hiGate;
            const shadowLift = ev01 * (IS_MOBILE ? 3.8 : 5.3) * gainGate * darkGate * (1 - hiGate * 0.35);
            const contrastBoost = ev01 * (IS_MOBILE ? 0.040 : 0.060) * gainGate * (1 - hiGate) * (1 - midGate * 0.45);
            const satBoost = lowColorGate * gainGate * (IS_MOBILE ? 1.0 : 1.6);
            const gammaPull = ev01 * gainGate * (IS_MOBILE ? 0.040 : 0.055) * (1 - midGate * 0.55);

            return { contrastBoost, highlightRecover, shadowLift, satBoost, gammaPull, hiGate, gainGate };
        }

        _smoothAe(target) {
            const now = performance.now();
            const last = this._aeLastT || now;
            const dt = Math.max(0, now - last);
            this._aeLastT = now;

            const tau = 180;
            const a = 1 - Math.exp(-dt / tau);

            if (!this._aeEma) this._aeEma = { ...target };
            const s = this._aeEma;
            const lerp = (p, q) => p + (q - p) * a;

            const smoothKeys = ['gamma','brightness','shadows','highlights','contrastAdj','saturation','level2','linearGain'];
            for (const k of smoothKeys) s[k] = lerp(s[k] ?? target[k], target[k]);

            s.sharpenLevel = target.sharpenLevel;
            s.colorTemp = target.colorTemp;
            s.dither = target.dither;
            s.clarity = target.clarity;
            s.autoExposure = target.autoExposure;
            s.blur = target.blur;

            return s;
        }

        _applyAllVideoFiltersActual() {
            if (!this.filterManager.isInitialized()) return;
            if (!this.stateManager.get('app.scriptActive')) {
                this.filterManager.requestUpdate({ saturation: 100, gamma: 1.0, blur: 0, sharpenLevel: 0, level2: 0, shadows: 0, highlights: 0, brightness: 0, contrastAdj: 1.0, colorTemp: 0, dither: 0, clarity: 0, linearGain: 1.0, autoExposure: 0 });
                const va = VA(); if(va) va.stop();
                return;
            }
            const vf = this.stateManager.get('videoFilter');
            const auto = this.lastAutoParams || { gamma: 1.0, bright: 0, clarityComp: 0, shadowsAdj: 0, highlightsAdj: 0, linearGain: 1.0 };

            const aeOn = !!vf.autoExposure;
            const totalGain = aeOn ? (auto.linearGain || 1.0) : 1.0;
            const autoGamma = aeOn ? (auto.gamma || 1.0) : 1.0;
            const autoBright = aeOn ? (auto.bright || 0) : 0;
            const autoShadows = aeOn ? (auto.shadowsAdj || 0) : 0;
            const autoHighlights = aeOn ? (auto.highlightsAdj || 0) : 0;

            let finalGamma = Utils.clamp(vf.gamma * autoGamma, 0.5, 2.5);
            let finalBrightness = vf.brightness + autoBright;
            let finalShadows = vf.shadows + autoShadows;
            let finalHighlights = vf.highlights + autoHighlights;
            let finalContrastAdj = vf.contrastAdj;
            let finalSaturation = vf.saturation;

            const va = VA();

            if (totalGain > 1.0) {
                const p90 = (va && va._p90Ema > 0) ? va._p90Ema : 0;
                // [v132.0.89] Proxy P50/P10 from Auto Signals
                const { p50, p10 } = this._approxP50P10FromAuto({
                    p90,
                    totalGain,
                    autoGamma: auto.autoGamma,
                    autoBright: auto.autoBright,
                    autoShadows: auto.autoShadows,
                    autoHighlights: auto.autoHighlights
                });
                
                const tune = this._computeAeTuning({ totalGain, p90, p50, p10, colorfulness: auto.colorfulness });

                finalContrastAdj += tune.contrastBoost;
                finalSaturation += tune.satBoost;

                const userHi = vf.highlights || 0;
                const userSh = vf.shadows || 0;
                const userHiGate = Utils.clamp(1 - Math.abs(userHi) / 30, 0.35, 1);
                const userShGate = Utils.clamp(1 - Math.abs(userSh) / 30, 0.35, 1);

                finalHighlights += tune.highlightRecover * userHiGate;
                
                // [v132.0.89] Limit shadow lift
                const maxLift = IS_MOBILE ? 10 : 14;
                finalShadows += Utils.clamp(tune.shadowLift, -maxLift, maxLift) * userShGate;

                finalGamma = Utils.clamp(finalGamma * (1 - tune.gammaPull), 0.5, 2.5);
            }

            let effectiveClarity = vf.clarity;
            let autoSharpLevel2 = vf.level2;
            
            if (effectiveClarity > 0) {
                const headroom = Utils.clamp(1 - (vf.level2 / 30), 0.25, 1.0);
                autoSharpLevel2 += Math.min(5, effectiveClarity * 0.15) * headroom;
            }
            
            if (va && va._highMotion) autoSharpLevel2 *= 0.7;

            if (totalGain > 1.02) {
                const p90 = (va && va._p90Ema > 0) ? va._p90Ema : 0;
                if (p90 > 0.88) {
                    autoSharpLevel2 *= 0.85;
                    effectiveClarity = Math.round(effectiveClarity * 0.85);
                }
            }

            if (CONFIG.FILTER.SECONDARY_ADJ && totalGain > 1.05) {
                const boostFactor = totalGain - 1.0;
                const currentP90 = (va && va._p90Ema) ? va._p90Ema : 0;
                const p90Gate = Utils.clamp((currentP90 - 0.85) / 0.10, 0, 1);
                finalHighlights += (boostFactor * 12) * p90Gate;
                finalShadows -= (boostFactor * 0.3) * p90Gate;
            }

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
                Math.abs((auto.bright || 0)) < 0.5 &&
                Math.abs((auto.shadowsAdj || 0)) < 0.5 &&
                Math.abs((auto.highlightsAdj || 0)) < 0.5
            );

            this.isGlobalBypass = isUserNeutral && isAutoNeutral;

            if (this.isGlobalBypass) {
                if (!vf.autoExposure && vf.clarity <= 0) {
                     if(va) va.stop();
                }
            }

            let dither = vf.dither;
            if (IS_MOBILE) {
                if (totalGain > 1.25) autoSharpLevel2 = Math.min(autoSharpLevel2, 12);
                if (totalGain > 1.35) dither = Math.min(dither, 50);
            }

            finalContrastAdj = Utils.clamp(finalContrastAdj, 0.85, 1.35);
            finalSaturation  = Utils.clamp(finalSaturation, 85, 135);
            finalHighlights  = Utils.clamp(finalHighlights, -35, 35);
            finalShadows     = Utils.clamp(finalShadows, -35, 35);
            finalBrightness  = Utils.clamp(finalBrightness, -25, 25);

            const target = {
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
                dither: dither,
                clarity: effectiveClarity,
                autoExposure: vf.autoExposure,
                linearGain: totalGain
            };

            const smoothed = this._smoothAe(target);
            this.filterManager.requestUpdate(smoothed);

            if(va) va.updateSettings({ autoExposure: vf.autoExposure, clarity: effectiveClarity });
        }
        applyAllImageFilters() {
            this._scheduleRaf('_imageRafId', () => {
                if (!this.imageFilterManager.isInitialized()) return;
                const active = this.stateManager.get('app.scriptActive');
                const level = active ? this.stateManager.get('imageFilter.level') : 0;
                const colorTemp = active ? this.stateManager.get('imageFilter.colorTemp') : 0;
                let scaleFactor = IS_MOBILE ? 0.8 : 1.0;
                this.imageFilterManager.requestUpdate({ sharpenLevel: level * scaleFactor, colorTemp: colorTemp });
                this.stateManager.get('media.activeImages').forEach(image => { this._updateImageFilterState(image); });
            });
        }

        _getFilterCheckTs(el) { if (!this._filterCheckMap) this._filterCheckMap = new WeakMap(); return this._filterCheckMap.get(el) || 0; }
        _setFilterCheckTs(el, ts) { if (!this._filterCheckMap) this._filterCheckMap = new WeakMap(); this._filterCheckMap.set(el, ts); }

        _updateVideoFilterState(video) {
            const scriptActive = this.stateManager.get('app.scriptActive'); const vf = this.stateManager.get('videoFilter');
            const shouldApply = vf.level > 0 || vf.level2 > 0 || Math.abs(vf.saturation - 100) > 0.1 || Math.abs(vf.gamma - 1.0) > 0.001 || vf.shadows !== 0 || vf.highlights !== 0 || vf.brightness !== 0 || Math.abs(vf.contrastAdj - 1.0) > 0.001 || vf.colorTemp !== 0 || vf.dither > 0 || vf.autoExposure > 0 || vf.clarity !== 0;
            const isVisRaw = this.stateManager.get('media.visibilityMap').get(video);
            const isVis = (isVisRaw !== false);

            const isIframe = video.tagName === 'IFRAME';
            if (isIframe && scriptActive && isVis && shouldApply && !this.isGlobalBypass) {
                let isSameOrigin = false;
                try { isSameOrigin = !!video.contentDocument; } catch {}

                if (!isSameOrigin) {
                    const gain = this.lastAutoParams?.linearGain || 1.0;
                    const sat = vf.saturation / 100;
                    const con = vf.contrastAdj;
                    const bri = 1.0 + (vf.brightness / 100) + (gain - 1.0) * 0.75;

                    const cssFilter = `brightness(${Math.max(0, bri).toFixed(3)}) contrast(${Math.max(0, con).toFixed(3)}) saturate(${Math.max(0, sat).toFixed(3)})`;
                    this.setInlineFilter(video, cssFilter);
                    video.classList.add('vsc-video-filter-active');
                    if (vf.dither === 0) video.classList.add('no-grain');
                    else video.classList.remove('no-grain');
                    return;
                }
            }

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
                this.setInlineFilter(video, filterCss);
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
        constructor() { super('UI'); this.globalContainer = null; this.triggerElement = null; this.speedButtonsContainer = null; this.hostElement = null; this.shadowRoot = null; this.isDragging = false; this.wasDragged = false; this.startPos = { x: 0, y: 0 }; this.currentPos = { x: 0, y: 0 }; this.animationFrameId = null; this.speedButtons = []; this.uiElements = {}; this.uiState = { x: 0, y: 0 }; this.boundFullscreenChange = null; this.boundSmartLimitUpdate = null; this.delta = { x: 0, y: 0 }; this.toastEl = null; this.pressTimer = null; this._longPressTriggered = false;
        this.boundChildFullscreenChange = null;
        this._fsHintUntil = 0;
        this._lastFsIframe = null;
        this._localSuppressedUntil = 0;
        }
        init(stateManager) {
            super.init(stateManager);
            const createUI = (force = false) => {
                if (this.globalContainer) return;
                this.createGlobalUI(force);
                if (this.globalContainer) {
                    this.stateManager.set('ui.globalContainer', this.globalContainer);
                    this.stateManager.set('ui.createRequested', false);
                    this.updateUIVisibility();
                } else {
                    setTimeout(() => this.stateManager.set('ui.createRequested', true), 200);
                }
            };
            const onCreateRequested = () => { if (document.body) createUI(); else document.addEventListener('DOMContentLoaded', () => createUI(), { once: true }); };
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

            this._onForceUi = () => {
                this._fsHintUntil = Date.now() + 6000;
                if (!this.globalContainer) this.createGlobalUI(true);
                this.updateUIVisibility();
            };
            window.addEventListener('vsc-force-ui', this._onForceUi, { signal: this._ac.signal });

            this._onHideUi = () => {
                if (IS_TOP) return;
                this._fsHintUntil = 0;
                this._localSuppressedUntil = Date.now() + 3000;
                this._hideLocalUi({ destroy: true });
            };
            window.addEventListener('vsc-hide-ui', this._onHideUi, { signal: this._ac.signal });

            const postBurst = (frame, type) => {
                let n = 0;
                const tick = () => {
                    if (!frame || !frame.isConnected) return;
                    if (n++ > 10) return;
                    try { frame.contentWindow?.postMessage({ ch: VSC_MSG, type }, '*'); } catch {}
                    setTimeout(tick, 250);
                };
                tick();
            };

            this.boundFullscreenChange = () => {
                const fe = document.fullscreenElement || document.webkitFullscreenElement;

                // Iframe fullscreen entered
                if (fe && fe.tagName === 'IFRAME') {
                     this._lastFsIframe = fe;
                     postBurst(fe, 'force-ui');
                     if (this.globalContainer) this.globalContainer.style.display = 'none';
                     return;
                }

                // Iframe fullscreen exited (or general exit)
                if (!fe && this._lastFsIframe) {
                    postBurst(this._lastFsIframe, 'hide-ui');
                    this._lastFsIframe = null;
                }

                if (this.globalContainer) this.globalContainer.style.display = 'flex';
                if (fe && !this.globalContainer) this.createGlobalUI(true);

                const fullscreenRoot = fe || document.body;
                if (this.globalContainer && fullscreenRoot) {
                    fullscreenRoot.appendChild(this.globalContainer);
                    requestAnimationFrame(() => {
                        if (fullscreenRoot.isConnected) fullscreenRoot.appendChild(this.globalContainer);
                    });
                }
                this.updateUIVisibility();
            };

            document.addEventListener('fullscreenchange', this.boundFullscreenChange);
            document.addEventListener('webkitbeginfullscreen', (e) => {
                this._fsHintUntil = Date.now() + 6000;
                if (!this.globalContainer) this.createGlobalUI(true);
                this.updateUIVisibility();
            }, true);
            document.addEventListener('webkitendfullscreen', (e) => {
                this.updateUIVisibility();
            }, true);

            const savedPos = Utils.safeGetItem('vsc_ui_pos'); if (savedPos) { try { const p = JSON.parse(savedPos); this.uiState = p; } catch { } }

            if (!IS_TOP) {
                const onMaybeFs = debounce(() => {
                    if (!this.globalContainer && isChildFullscreenLikely()) {
                        this.stateManager.set('ui.createRequested', true);
                    }
                    this.updateUIVisibility();
                }, 120);
                window.addEventListener('resize', onMaybeFs, { passive: true, signal: this._ac.signal });
                if (window.visualViewport) {
                    window.visualViewport.addEventListener('resize', onMaybeFs, { passive: true, signal: this._ac.signal });
                }

                const kickVisibilityProbe = () => {
                    if(this._probeTimer) return;
                    this._probeTimer = setTimeout(() => {
                        this._probeTimer = null;
                        this.updateUIVisibility();
                    }, 200);
                };
                document.addEventListener('keydown', kickVisibilityProbe, { passive: true, signal: this._ac.signal });
                document.addEventListener('play', kickVisibilityProbe, { capture: true, passive: true, signal: this._ac.signal });
            }
        }
        destroy() { super.destroy(); if (this.globalContainer) { this.globalContainer.remove(); this.globalContainer = null; } if (this.boundFullscreenChange) document.removeEventListener('fullscreenchange', this.boundFullscreenChange); if (this.boundSmartLimitUpdate) document.removeEventListener('vsc-smart-limit-update', this.boundSmartLimitUpdate);
        if (this._onForceUi) window.removeEventListener('vsc-force-ui', this._onForceUi);
        if (this._onHideUi) window.removeEventListener('vsc-hide-ui', this._onHideUi);
        }

        _hideLocalUi({ destroy = false } = {}) {
            if (this.hostElement) this.hostElement.style.display = 'none';
            if (this.speedButtonsContainer) this.speedButtonsContainer.style.display = 'none';
            if (this.globalContainer) {
                if (destroy) {
                    this.globalContainer.remove();
                    this.globalContainer = null;
                    this.hostElement = null;
                    this.shadowRoot = null;
                    this.uiElements = {};
                } else {
                    this.globalContainer.style.display = 'none';
                }
            }
        }

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
                .vsc-trigger { width: ${isMobile ? '42px' : '48px'}; height: ${isMobile ? '42px' : '48px'}; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: ${isMobile ? '22px' : '24px'}; user-select: none; touch-action: none; order: 1; transition: background 0.3s; text-shadow: 0 0 4px rgba(0,0,0,0.8); }
                .vsc-rescan { width: 34px; height: 34px; background: var(--vsc-bg-btn); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 18px; margin-top: 5px; order: 3; }
                #vsc-global-container { position: fixed; top: 50%; right: 1vmin; z-index: ${CONFIG.UI.MAX_Z} !important; transform: translateY(-50%) translate(var(--vsc-translate-x, 0), var(--vsc-translate-y, 0)); display: flex; align-items: flex-start; gap: 5px; pointer-events: auto; }
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

        _isFsHint() {
             return !IS_TOP && ((this._fsHintUntil || 0) > Date.now());
        }

        createGlobalUI(force = false) {
            // [v132.0.89] Child constraint: only create on force/hint
            if (!IS_TOP && !force && !this._isFsHint()) return;

            if (this.globalContainer) return;

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
            this.triggerElement.style.backgroundColor = 'transparent';

            const rescanTrigger = document.createElement('div'); rescanTrigger.textContent = '↻';
            this.rescanTrigger = rescanTrigger;
            this.rescanTrigger.className = 'vsc-rescan';
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

            if (!document.getElementById('vsc-global-style')) {
                const globalStyle = document.createElement('style');
                globalStyle.id = 'vsc-global-style';
                globalStyle.textContent = this.getStyles().replace(':host', '#vsc-global-container, #vsc-ui-host');
                document.head.appendChild(globalStyle);
            }

            this.startBootGate();
        }

        startBootGate() {
            if (!IS_TOP && !isChildFullscreenLikely() && !this._isFsHint()) {
                if (this.globalContainer) {
                    this.globalContainer.style.display = 'none';
                    this.globalContainer.style.opacity = '0';
                }
                return;
            }

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
            const isActive = this.stateManager.get('app.scriptActive');
            if (isVisible) {
                this.triggerElement.textContent = '🛑';
                this.triggerElement.style.backgroundColor = 'rgba(231, 76, 60, 0.9)';
                if(this.globalContainer) this.globalContainer.style.opacity = '1';
            } else {
                this.triggerElement.textContent = '⚡';
                this.triggerElement.style.backgroundColor = 'transparent';
                if(this.globalContainer) this.globalContainer.style.opacity = isActive ? '1' : '0.2';
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
            if (this.stateManager.get('ui.hideUntilReload')) {
                if (this.globalContainer) this.globalContainer.style.display = 'none';
                return;
            }

            if (this._uiVisRaf) return;
            this._uiVisRaf = requestAnimationFrame(() => {
                this._uiVisRaf = null;
                this._updateUIVisibilityActual();
            });
        }
        _updateUIVisibilityActual() {
             if (!IS_TOP && (this._localSuppressedUntil || 0) > Date.now()) {
                 if (this.globalContainer) this.globalContainer.style.display = 'none';
                 return;
             }

             const wasHidden = this.globalContainer && this.globalContainer.style.display === 'none';
             const fsHint = this._isFsHint();

             if (!IS_TOP && !fsHint) {
                  const anyVideoFs = () => {
                      const cur = this.stateManager.get('media.currentlyVisibleMedia');
                      if (cur && cur.tagName === 'VIDEO' && cur.webkitDisplayingFullscreen) return true;
                      const activeMedia = this.stateManager.get('media.activeMedia') || new Set();
                      for (const m of activeMedia) {
                          if (m && m.tagName === 'VIDEO' && m.webkitDisplayingFullscreen) return true;
                      }
                      return false;
                  };
                  const isRealFullscreen = document.fullscreenElement || document.webkitFullscreenElement || anyVideoFs();

                  if (isChildFullscreenLikely() && !this.globalContainer) {
                      this.stateManager.set('ui.createRequested', true);
                  }

                  if (!isRealFullscreen && !isChildFullscreenLikely()) {
                      if (this.globalContainer) this.globalContainer.style.display = 'none';
                      return;
                  }
             }

             const controlsVisible = this.stateManager.get('ui.areControlsVisible');
             const activeMedia = this.stateManager.get('media.activeMedia') || new Set(); const activeImages = this.stateManager.get('media.activeImages') || new Set(); const activeIframes = this.stateManager.get('media.activeIframes') || new Set();
             const hasLocalVideo = [...activeMedia].some(m => m && m.tagName === 'VIDEO'); const hasLocalImage = activeImages.size > 0; const hasIframe = activeIframes.size > 0;
             const hasDomVideo = !!document.querySelector('video, iframe') || hasRealVideoCached();
             const hasAnyVideo = hasLocalVideo || hasIframe || hasDomVideo; const hasAny = hasAnyVideo || hasLocalImage;

             if (this.globalContainer) {
                 const shouldShow = IS_TOP ? (controlsVisible || hasAny) : (controlsVisible || (fsHint && hasAny));
                 this.globalContainer.style.display = shouldShow ? 'flex' : 'none';

                 if (wasHidden || this.globalContainer.style.opacity === '0') {
                     this.startBootGate();
                     this.updateTriggerStyle();
                 }

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

            this.renderAllControls();

            this.mainControlsContainer.prepend(this.hostElement);
        }

        renderAllControls() {
            if (this.shadowRoot.querySelector('#vsc-main-container')) return;
            const main = document.createElement('div'); main.id = 'vsc-main-container';
            const controls = document.createElement('div'); controls.id = 'vsc-controls-container';
            const videoMenu = this._buildVideoMenu(controls);
            const monitor = document.createElement('div'); monitor.className = 'vsc-monitor'; monitor.textContent = 'Monitoring Off'; videoMenu.appendChild(monitor);
            this.boundSmartLimitUpdate = (e) => {
                const { autoParams, tainted, aeActive } = e.detail;
                if (tainted && !this._lastTaintToast) {
                      this.showToast('⚠️ 보안(CORS) 제한됨: CSS Fallback 적용');
                      this._lastTaintToast = true;
                }
                if (!videoMenu.parentElement.classList.contains('submenu-visible')) return;

                if (tainted) { monitor.textContent = '🔒 보안(CORS) 제한됨 (CSS모드)'; monitor.classList.add('warn'); }
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
                this.showToast(`${label}: ${formatFn ? formatFn(val) : val + unit}`);
                debouncedSetState(val);
            };
            this.subscribe(stateKey, (val) => { updateText(val); if (Math.abs(parseFloat(slider.value) - val) > (step / 2 || 0.001)) { slider.value = val; } });
            updateText(slider.value); div.append(labelEl, slider); return { control: div, slider: slider };
        }
        _buildVideoMenu(container) {
            const videoSubMenu = this._createControlGroup('vsc-video-controls', '🎬', '영상 필터', container);

            const topRow = document.createElement('div');
            topRow.className = 'vsc-top-row';
            topRow.style.cssText = 'margin: 0; padding: 6px 0; gap: 4px; display: flex; align-items: center;';

            const createToggle = (label, key) => {
                const btn = document.createElement('button');
                btn.className = 'vsc-btn vsc-btn-lg';
                btn.textContent = label;
                btn.style.height = '30px';
                btn.style.padding = '0 4px';
                const render = (v) => { btn.classList.toggle('active', !!v); };
                btn.onclick = () => {
                    const next = !this.stateManager.get(key);
                    this.stateManager.set(key, next);
                    if (key === 'videoFilter.autoExposure' && next) triggerBurstScan(200);
                };
                this.subscribe(key, render); render(this.stateManager.get(key)); return btn;
            };

            const powerBtn = document.createElement('button');
            powerBtn.className = 'vsc-btn vsc-btn-lg';
            powerBtn.textContent = '⏸︎';
            Object.assign(powerBtn.style, { width: '36px', height: '30px', flex: '0 0 36px', color: '#e74c3c', padding: '0' });
            powerBtn.onclick = () => { this.stateManager.set('app.scriptActive', false); this.stateManager.set('ui.areControlsVisible', false); this.showToast('Script OFF'); };

            topRow.append(powerBtn);
            topRow.append(createToggle('📸 자동', 'videoFilter.autoExposure'));
            topRow.append(createToggle('🔊 부스트', 'audio.enabled'));

            const videoResetBtn = document.createElement('button');
            videoResetBtn.className = 'vsc-btn vsc-btn-lg';
            videoResetBtn.textContent = '↺';
            Object.assign(videoResetBtn.style, { width: '36px', height: '30px', flex: '0 0 36px', padding: '0' });
            videoResetBtn.onclick = () => {
                this.stateManager.batchSet('videoFilter', { activeSharpPreset: 'none', activeBrightPreset: 'brOFF', level: 0, level2: 0, clarity: 0, autoExposure: false, gamma: 1.0, contrastAdj: 1.0, brightness: 0, saturation: 100, highlights: 0, shadows: 0, dither: 0, colorTemp: 0 });
                this.stateManager.set('audio.enabled', false); this.stateManager.set('audio.boost', 6); this.showToast('필터 초기화');
            };
            topRow.append(videoResetBtn);
            videoSubMenu.append(topRow);

            const lineStyle = '1px solid var(--vsc-border)';
            const gridBase = `display: grid; grid-template-columns: 40px repeat(7, 1fr); gap: 2px; align-items: center; width: 100%; color: #eee; margin: 0; padding: 6px 0;`;

            const presetContainer = document.createElement('div');
            presetContainer.style.cssText = gridBase + `border-top: ${lineStyle};`;

            const label = document.createElement('div');
            label.className = 'vsc-label';
            label.textContent = '샤프';
            Object.assign(label.style, { color: '#eee', fontSize: '13px', fontWeight: 'bold', minWidth: '40px', whiteSpace: 'nowrap' });
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
                b.style.padding = '4px 0';
                b.style.width = '100%';
                b.onclick = () => { this.stateManager.batchSet('videoFilter', { level: it.l1, level2: it.l2, activeSharpPreset: it.key }); };
                presetContainer.appendChild(b);
            });
            for(let i=0; i < (7 - sharpPresets.length); i++) presetContainer.appendChild(document.createElement('div'));

            const updateSharp = (k) => {
                 presetContainer.querySelectorAll('button[data-preset-key]').forEach(b => {
                     b.classList.toggle('active', b.dataset.presetKey === k);
                 });
            };
            this.subscribe('videoFilter.activeSharpPreset', updateSharp);
            updateSharp(this.stateManager.get('videoFilter.activeSharpPreset'));

            videoSubMenu.appendChild(presetContainer);

            const brightPresetContainer = document.createElement('div');
            brightPresetContainer.style.cssText = gridBase + `border-bottom: ${lineStyle};`;

            const brightLabel = document.createElement('div');
            brightLabel.className = 'vsc-label';
            brightLabel.textContent = '밝기';
            Object.assign(brightLabel.style, { color: '#eee', fontSize: '13px', fontWeight: 'bold', minWidth: '40px', whiteSpace: 'nowrap' });
            brightPresetContainer.appendChild(brightLabel);

            const brightPresets = [
                { txt: 'S',  g: 1.00, b: 2,  c: 1.00, s: 100, key: 'brS' },
                { txt: 'M',  g: 1.10, b: 4,  c: 1.00, s: 102, key: 'brM' },
                { txt: 'L',  g: 1.20, b: 6,  c: 1.00, s: 104, key: 'brL' },
                { txt: 'DS', g: 1.00, b: 3.6,  c: 1.02, s: 100, key: 'brDS' },
                { txt: 'DM', g: 1.15, b: 7.2,  c: 1.04, s: 101, key: 'brDM' },
                { txt: 'DL', g: 1.30, b: 10.8,  c: 1.06, s: 102, key: 'brDL' },
                { txt: '끔', g: 1.00, b: 0,  c: 1.00, s: 100, key: 'brOFF' }
            ];

            brightPresets.forEach(it => {
                const b = document.createElement('button');
                b.className = 'vsc-btn';
                b.textContent = it.txt;
                b.dataset.brightKey = it.key;
                b.style.padding = '4px 0';
                b.style.width = '100%';
                b.onclick = () => {
                    this.stateManager.batchSet('videoFilter', {
                        gamma: it.g,
                        brightness: it.b,
                        contrastAdj: it.c,
                        saturation: it.s,
                        activeBrightPreset: it.key
                    });
                    this.showToast(`밝기: ${it.txt}`);
                };
                brightPresetContainer.appendChild(b);
            });

            const updateBright = (k) => {
                 brightPresetContainer.querySelectorAll('button[data-bright-key]').forEach(b => {
                     b.classList.toggle('active', b.dataset.brightKey === k);
                 });
            };
            this.subscribe('videoFilter.activeBrightPreset', updateBright);
            updateBright(this.stateManager.get('videoFilter.activeBrightPreset') || 'brOFF');

            videoSubMenu.appendChild(brightPresetContainer);

            const grid = document.createElement('div');
            grid.className = 'vsc-grid';
            grid.style.marginTop = '8px';

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

            SLIDER_CONFIG.forEach(cfg => {
                grid.appendChild(this._createSlider(cfg.label, cfg.id, cfg.min, cfg.max, cfg.step, cfg.key, cfg.unit, cfg.fmt).control);
            });
            grid.appendChild(this._createSlider('오디오증폭', 'a-boost', 0, 12, 1, 'audio.boost', 'dB', v => `+${v}`).control);

            videoSubMenu.append(grid);

            return videoSubMenu;
        }
        attachDragAndDrop() {
            let lastDragEnd = 0;

            const onPointerDown = (e) => {
                const t = e.target;
                const tag = (t && t.nodeType === 1) ? t.tagName : '';
                if (['BUTTON', 'SELECT', 'INPUT', 'TEXTAREA'].includes(tag)) return;

                this.isDragging = true;
                this.wasDragged = false;
                this._longPressTriggered = false;

                const getCoord = (ev) => ({
                    x: ev.clientX,
                    y: ev.clientY
                });
                const startPos = getCoord(e);

                const capEl = this.triggerElement;
                if (capEl.setPointerCapture) {
                    try { capEl.setPointerCapture(e.pointerId); } catch {}
                }

                if (this.pressTimer) clearTimeout(this.pressTimer);
                this.pressTimer = setTimeout(() => {
                    if (this.isDragging && !this.wasDragged) {
                        this._longPressTriggered = true;
                        this.stateManager.set('app.scriptActive', false);
                        this.stateManager.set('ui.areControlsVisible', false);
                        this.showToast('Script OFF (Long Press)');
                        this.updateTriggerStyle();
                        this.isDragging = false;
                    }
                }, 800);

                this.globalContainer.style.transition = 'none';

                const moveHandler = (ev) => {
                    if (!this.isDragging) return;
                    const curPos = getCoord(ev);
                    const dx = curPos.x - startPos.x;
                    const dy = curPos.y - startPos.y;

                    if (!this.wasDragged && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                        this.wasDragged = true;
                        if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }
                    }

                    if (this.wasDragged) {
                        this.delta = { x: dx, y: dy };
                        this.globalContainer.style.setProperty('--vsc-translate-x', `${this.uiState.x + dx}px`);
                        this.globalContainer.style.setProperty('--vsc-translate-y', `${this.uiState.y + dy}px`);
                    }
                };

                const endHandler = (ev) => {
                    if (this.pressTimer) { clearTimeout(this.pressTimer); this.pressTimer = null; }

                    if (capEl.releasePointerCapture) {
                        try { capEl.releasePointerCapture(ev.pointerId); } catch {}
                    }

                    if (this.isDragging) {
                        if (this.wasDragged) {
                            this.uiState.x += (this.delta.x || 0);
                            this.uiState.y += (this.delta.y || 0);
                            Utils.safeSetItem('vsc_ui_pos', JSON.stringify(this.uiState));
                            lastDragEnd = Date.now();
                        } else if (!this._longPressTriggered) {
                            if (!this.stateManager.get('app.scriptActive')) {
                                this.stateManager.set('app.scriptActive', true);
                                this.showToast('Script ON');
                            }
                            const isVisible = this.stateManager.get('ui.areControlsVisible');
                            this.stateManager.set('ui.areControlsVisible', !isVisible);
                            triggerBurstScan(100);

                            if (!isVisible) {
                                const ensureMediaSoon = (count) => {
                                    if (!this.stateManager.get('app.scriptActive')) return;
                                    const hasMedia = this.stateManager.get('media.activeMedia').size > 0 || hasRealVideoCached();
                                    if (hasMedia) return;

                                    if (count > 0) {
                                          triggerBurstScan(250);
                                          if (count < 4) scheduleScan(null);
                                          setTimeout(() => ensureMediaSoon(count - 1), 500);
                                    } else {
                                          const frames = document.getElementsByTagName('iframe');
                                          for(let i=0; i<frames.length; i++) scheduleScan(frames[i], true);
                                          this.showToast('미디어를 찾을 수 없습니다.');
                                    }
                                };
                                setTimeout(() => ensureMediaSoon(8), 200);
                            }
                        }
                    }

                    this.isDragging = false;
                    this.globalContainer.style.transition = '';

                    window.removeEventListener('pointermove', moveHandler);
                    window.removeEventListener('pointerup', endHandler);
                    window.removeEventListener('pointercancel', endHandler);
                };

                window.addEventListener('pointermove', moveHandler);
                window.addEventListener('pointerup', endHandler);
                window.addEventListener('pointercancel', endHandler);
            };

            this.triggerElement.addEventListener('pointerdown', onPointerDown);

            this.triggerElement.addEventListener('click', (e) => {
                this.isDragging = false;
                this.wasDragged = false;
                if (Date.now() - lastDragEnd < 400 || this._longPressTriggered) {
                    e.stopPropagation(); e.preventDefault();
                }
            }, { capture: true });
        }
    }

    function exportSyncState(sm) {
      const pick = (k) => sm.get(k);
      return {
        v: 1,
        app: { scriptActive: pick('app.scriptActive') },
        ui: {
          areControlsVisible: pick('ui.areControlsVisible'),
          hideUntilReload: pick('ui.hideUntilReload')
        },
        videoFilter: { ...pick('videoFilter') },
        imageFilter: { ...pick('imageFilter') },
        audio: { ...pick('audio') },
        playback: { targetRate: pick('playback.targetRate') }
      };
    }
    function applySyncState(sm, payload, guardFlagSetter) {
      if (!payload) return;
      guardFlagSetter(true);
      try {
        if (payload.app?.scriptActive !== undefined) sm.set('app.scriptActive', !!payload.app.scriptActive);
        if (payload.ui) {
          if (payload.ui.areControlsVisible !== undefined) sm.set('ui.areControlsVisible', !!payload.ui.areControlsVisible);
          if (payload.ui.hideUntilReload !== undefined) sm.set('ui.hideUntilReload', !!payload.ui.hideUntilReload);
        }
        if (payload.videoFilter) sm.batchSet('videoFilter', payload.videoFilter);
        if (payload.imageFilter) sm.batchSet('imageFilter', payload.imageFilter);
        if (payload.audio) sm.batchSet('audio', payload.audio);
        if (payload.playback?.targetRate !== undefined) sm.set('playback.targetRate', Number(payload.playback.targetRate) || 1.0);
      } finally {
        guardFlagSetter(false);
      }
    }

    class FrameSync {
      constructor(stateManager) {
        this.sm = stateManager;
        this.isTop = (window === window.top);
        this.token = null;
        this._ports = new Map();
        this._boundMessage = null;
      }

      start() {
        this._boundMessage = (e) => this._onMessage(e);
        window.addEventListener('message', this._boundMessage, true);
        if (this.isTop) {
          this.token = Math.random().toString(36).slice(2);
          this._hookTopBroadcast();
        } else {
          this._postToParent({ type: 'hello', id: VSC_INSTANCE_ID });
          this._hookChildUpstream();
        }
      }

      destroy() {
          if (this._boundMessage) window.removeEventListener('message', this._boundMessage, true);
          this._ports.clear();
      }

      _hookTopBroadcast() {
        const schedule = () => {
          const now = performance.now();
          if (this._sendTimer) return;
          const delay = (now - this._lastSend < 50) ? 50 : 0;
          this._sendTimer = setTimeout(() => {
            this._sendTimer = null;
            this._lastSend = performance.now();
            this._broadcast({ type: 'state', payload: exportSyncState(this.sm) });
          }, delay);
        };
        
        const keys = [
            'app.scriptActive', 'ui.areControlsVisible', 'ui.hideUntilReload',
            'videoFilter.*', 'imageFilter.*', 'audio.*', 'playback.targetRate'
        ];
        keys.forEach(k => this.sm.subscribe(k, schedule));
      }

      _hookChildUpstream() {
        const scheduleUp = () => {
          if (this._applyingRemote) return;
          if (!this.token) return;
          if (this._sendTimer) return;
          this._sendTimer = setTimeout(() => {
            this._sendTimer = null;
            this._postToParent({ type: 'update', token: this.token, payload: exportSyncState(this.sm) });
          }, 120);
        };
        const keys = [
            'app.scriptActive', 'ui.areControlsVisible', 'ui.hideUntilReload',
            'videoFilter.*', 'imageFilter.*', 'audio.*', 'playback.targetRate'
        ];
        keys.forEach(k => this.sm.subscribe(k, scheduleUp));
      }

      _postToParent(msg) { try { window.parent.postMessage({ ch: VSC_MSG, ...msg }, '*'); } catch {} }
      _postTo(win, msg) { try { win.postMessage({ ch: VSC_MSG, ...msg, token: this.token }, '*'); } catch {} }
      _broadcast(msg) { for (const [win] of this._ports) this._postTo(win, msg); }

      _onMessage(e) {
        const d = e.data;
        if (!d || d.ch !== VSC_MSG) return;
        
        // [v132.0.89] Simple payload check
        if (d.payload && typeof d.payload !== 'object') return;

        const allowed = ['hello', 'welcome', 'state', 'update', 'force-ui', 'hide-ui'];
        if (!allowed.includes(d.type)) return;

        if (!this.isTop) {
            if (['welcome', 'state', 'force-ui', 'hide-ui'].includes(d.type)) {
                if (e.source !== window.parent) return;
            }
        }

        if (this.isTop && d.type !== 'hello' && !this._ports.has(e.source)) return;

        if (this.isTop && d.type === 'hello') {
          if (e.source) {
            this._ports.set(e.source, { t: Date.now() });
            e.source.postMessage({ ch: VSC_MSG, type: 'welcome', token: this.token, payload: exportSyncState(this.sm) }, '*');
          }
          return;
        }

        if (!this.isTop && d.type === 'welcome') {
          this.token = d.token || null;
          applySyncState(this.sm, d.payload, (v) => { this._applyingRemote = v; });
          if (this.sm.get('ui.areControlsVisible')) {
              if (isChildFullscreenLikely()) {
                  this.sm.set('ui.createRequested', true);
              }
          }
          return;
        }

        if (d.type === 'force-ui' && !this.isTop) {
             window.dispatchEvent(new CustomEvent('vsc-force-ui'));
             this.sm.set('ui.createRequested', true);
             return;
        }

        if (d.type === 'hide-ui' && !this.isTop) {
             window.dispatchEvent(new CustomEvent('vsc-hide-ui'));
             return;
        }

        if (!this.isTop && d.type === 'state') {
          if (!this.token) return;
          if (d.token && d.token !== this.token) return;
          applySyncState(this.sm, d.payload, (v) => { this._applyingRemote = v; });
          if (this.sm.get('ui.areControlsVisible')) {
              if (isChildFullscreenLikely()) {
                  this.sm.set('ui.createRequested', true);
              }
          }
          return;
        }

        if (this.isTop && d.type === 'update') {
          if (!d.token || d.token !== this.token) return;
          applySyncState(this.sm, d.payload, () => {});
          this._broadcast({ type: 'state', payload: exportSyncState(this.sm) });
          return;
        }
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
        pluginManager.register(new AudioController());
        pluginManager.initAll();

        try {
            const fs = new FrameSync(stateManager);
            window.__vscFrameSync = fs;
            fs.start();
            window.addEventListener('pagehide', () => fs.destroy(), { once: true });
        } catch {}
    }

    main();
})();
