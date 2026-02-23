// ==UserScript==
// @name        Web 성능 최적화 + Privacy Shield (v81.4 ULTRA Infinity)
// @namespace   http://tampermonkey.net/
// @version     81.4.1-KR-ULTRA-Privacy
// @description [Ultimate] 끝없는 최적화 + Autonomous + Aggressive Privacy (WebRTC Guard, Full LCP Inference, Smart Shield, True LRU, Tracker Blocking, Fingerprint Spoofing)
// @author      KiwiFruit & j0tsarup
// @match       *://*/*
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @grant       GM_notification
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // [Constants]
    const DAY = 86400000;
    const WEEK = 7 * DAY;

    // [Global Helpers]
    const reloadPage = () => {
        try { win.location.reload(); }
        catch {
            try { location.reload(); } catch {}
        }
    };

    const safeJsonParse = (str, fallback = null) => {
        try {
            const v = JSON.parse(str);
            return v ?? fallback;
        } catch {
            return fallback;
        }
    };

    const makeTTLCache = () => {
        let value = null;
        let ts = 0;
        return {
            get(ttl, compute) {
                const now = Date.now();
                if (value !== null && (now - ts) < ttl) return value;
                value = compute();
                ts = now;
                return value;
            },
            set(v) { value = v; ts = Date.now(); },
            clear() { value = null; ts = 0; }
        };
    };

    // [Safe Storage Wrapper with True LRU & Memory Cache]
    const S = {
        _idxCache: null,
        _idxDirty: false,
        _idxTimer: null,

        _flushIdxSoon() {
            this._idxDirty = true;
            if (this._idxTimer) return;
            this._idxTimer = setTimeout(() => {
                this._idxTimer = null;
                if (!this._idxDirty) return;
                this._idxDirty = false;
                try { localStorage.setItem('PerfX_IDX', JSON.stringify(this._idxCache || [])); } catch {}
            }, 250);
        },

        get(k) {
            try {
                const v = localStorage.getItem(k);
                if (v !== null) this._trackKey(k);
                return v;
            } catch { return null; }
        },

        set(k, v) {
            try {
                localStorage.setItem(k, v);
                this._trackKey(k);
            } catch {}
        },

        remove(k) {
            try { localStorage.removeItem(k); } catch {}
            try {
                if (k === 'PerfX_IDX') {
                    this._idxCache = [];
                    this._idxDirty = false;
                    return;
                }
                if (Array.isArray(this._idxCache)) {
                    const pos = this._idxCache.indexOf(k);
                    if (pos !== -1) {
                        this._idxCache.splice(pos, 1);
                        this._flushIdxSoon();
                    }
                }
            } catch {}
        },

        _getPerfXIdx() {
            if (this._idxCache) return this._idxCache;
            try {
                this._idxCache = JSON.parse(localStorage.getItem('PerfX_IDX') || '[]');
                if (!Array.isArray(this._idxCache)) this._idxCache = [];
            } catch {
                this._idxCache = [];
            }
            return this._idxCache;
        },

        _trackKey(k) {
            if (!k.startsWith('PerfX_') && !k.startsWith('perfx-')) return;
            if (k === 'PerfX_IDX') return;

            try {
                const idx = this._getPerfXIdx();
                const limit = win.matchMedia('(pointer:coarse)').matches ? 50 : 100;

                const pos = idx.indexOf(k);
                if (pos !== -1) idx.splice(pos, 1);
                idx.push(k);

                while (idx.length > limit) {
                    const old = idx.shift();
                    try { localStorage.removeItem(old); } catch {}
                }
                this._flushIdxSoon();
            } catch {}
        },

        clearPrefix(prefixes) {
            try {
                const toRemove = [];
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && prefixes.some(p => k.startsWith(p))) toRemove.push(k);
                }
                toRemove.forEach(k => localStorage.removeItem(k));

                if (Array.isArray(this._idxCache)) {
                    const before = this._idxCache.length;
                    this._idxCache = this._idxCache.filter(k => !prefixes.some(p => k.startsWith(p)));
                    if (this._idxCache.length !== before) this._flushIdxSoon();
                }
            } catch {}
        }
    };

    // [Util] Helpers
    const LISTS = Object.freeze({
        BANKS_KR: ['kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr', 'nhbank.com', 'kakaobank.com', 'hanabank.com', 'toss.im'],
        GOV_KR: ['gov.kr', 'hometax.go.kr', 'nts.go.kr'],
        OTT_KR: ['youtube.com', 'twitch.tv', 'netflix.com', 'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com'],
        HEAVY_FEEDS: ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'tiktok.com'],
        LAYOUT_KEYWORDS: ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'],
        RTC_ALLOW: ['meet.google.com', 'zoom.us', 'webex.com', 'discord.com', 'teams.microsoft.com', 'slack.com', 'geforcenow.com'],
        CRITICAL_SUB: /^(auth|login|signin|pay|cert|secure|account)\./
    });

    const hostEndsWithAny = (h, list) => list.some(d => h === d || h.endsWith('.' + d));

    const onReady = (cb) => {
        if (document.readyState !== 'loading') cb();
        else win.addEventListener('DOMContentLoaded', cb, { once: true });
    };

    const onPageActivated = (cb) => {
        try {
            if (document.prerendering) {
                document.addEventListener('prerenderingchange', () => cb(), { once: true });
                return;
            }
        } catch {}
        cb();
    };

    const getActivationStart = () => {
        try {
            const nav = performance.getEntriesByType('navigation')[0];
            return Number(nav?.activationStart || 0);
        } catch {
            return 0;
        }
    };

    // Bucket & Freshness
    const normSeg = (s) => {
        if (/^\d+$/.test(s)) return ':id';
        if (/^[0-9a-f-]{36}$/i.test(s)) return ':uuid';
        if (s.length > 24 || /^[0-9a-z_-]{20,}$/i.test(s)) return ':token';
        return s;
    };
    const getPathBucket = () => win.location.pathname.split('/').filter(Boolean).slice(0, 2).map(normSeg).join('/');
    const fresh = (obj, ms) => obj && obj.ts && (Date.now() - obj.ts) < ms;

    // ✅ Event Bus
    const Bus = {
        on(name, fn, target = win) { target.addEventListener(name, fn); },
        emit(name, detail) { win.dispatchEvent(new CustomEvent(name, { detail })); }
    };

    // ✅ BaseModule with AbortController
    class BaseModule {
        constructor() { this._ac = new AbortController(); }
        on(target, type, listener, options) {
            if (!target || !target.addEventListener) return;
            const opts = (typeof options === 'object' && options !== null)
                ? { ...options, signal: this._ac.signal }
                : { capture: options === true, signal: this._ac.signal };
            target.addEventListener(type, listener, opts);
        }
        destroy() { try { this._ac.abort(); } catch {} }
        safeInit() { try { this.init(); } catch (e) { log('Module Error', e); } }
        init() {}
    }

    // ✅ True Distance Helper
    const viewH = () => win.visualViewport?.height || win.innerHeight;
    const distToViewport = (r) => {
        if (!r) return -1;
        const h = viewH();
        if (r.bottom < 0) return -r.bottom;
        if (r.top > h) return r.top - h;
        return 0;
    };

    // [Safe Init] Hoist Config/API
    let Config = {
        codecMode: 'off', passive: false, gpu: false, memory: false,
        allowIframe: false, rtcGuard: false, downgradeLevel: 0,
        memoryContainMode: 'safe'
    };

    const API = {
        profile: () => {}, toggleConfig: () => {}, toggleSessionSafe: () => {},
        shutdownMemory: () => {}, restartMemory: () => {}, resetAll: () => {}, showStatus: () => {}
    };

    // ✅ Modern Scheduler
    const scheduler = {
        request(cb, timeout = 200, priority = 'background') {
            if (win.scheduler?.postTask) {
                const ctrl = new AbortController();
                win.scheduler
                    .postTask(() => cb(), { delay: timeout, priority, signal: ctrl.signal })
                    .catch(() => {});
                return { kind: 'postTask', ctrl };
            }
            if (win.requestIdleCallback) {
                return { kind: 'ric', id: win.requestIdleCallback(cb, { timeout }) };
            }
            return { kind: 'timeout', id: setTimeout(cb, timeout) };
        },
        cancel(handle) {
            if (!handle) return;
            try {
                if (handle.kind === 'postTask') handle.ctrl.abort();
                else if (handle.kind === 'ric' && win.cancelIdleCallback) win.cancelIdleCallback(handle.id);
                else if (handle.kind === 'timeout') clearTimeout(handle.id);
            } catch {}
        },
        raf(cb) { return win.requestAnimationFrame(cb); },
        async yield(priority = 'user-visible') {
            if (win.scheduler?.yield) { try { await win.scheduler.yield(); return; } catch {} }
            if (win.scheduler?.postTask) { try { await win.scheduler.postTask(() => {}, { priority }); return; } catch {} }
            await new Promise(r => setTimeout(r, 0));
        }
    };

    // ✅ Robust Chunk Scan Utility
    const scanInChunks = (list, limit, step, fn) => {
        if (!list || typeof list.length !== 'number' || list.length === 0) return;
        let i = 0;
        const run = async () => {
            const len = list.length;
            const max = Math.min(limit, len);
            const end = Math.min(i + step, max);
            for (; i < end; i++) fn(list[i]);
            if (i < max) {
                await scheduler.yield('background').catch(() => {});
                scheduler.request(run, 0, 'background');
            }
        };
        run();
    };

    // [Config Helpers]
    const SAN_KEYS = ['_restore', 'downgradeReason'];
    const sanitizeConfig = (o) => {
        const out = { ...o };
        for (const k of SAN_KEYS) delete out[k];
        for (const k in out) if (k.startsWith('_')) delete out[k];
        return out;
    };

    const normUrl = (u) => {
        try {
            if (!u || u.startsWith('data:')) return u;
            const url = new URL(u, win.location.href);
            const params = new URLSearchParams(url.search);
            const keep = ['w', 'width', 'h', 'height', 'q', 'quality', 'fmt', 'format'];
            const newParams = new URLSearchParams();
            keep.forEach(k => { if(params.has(k)) newParams.set(k, params.get(k)); });
            return url.origin + url.pathname + (newParams.toString() ? '?' + newParams.toString() : '');
        } catch { return u; }
    };

    // [Constants]
    const FEED_SEL = '[role="feed"], [data-perfx-feed], .feed, .timeline';
    const ITEM_SEL = '[role="article"], [data-perfx-item], article, .item, .post';
    const SUPPORTED_TYPES = new Set(typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes || []) : []);

    // [Config & State]
    const hostname = win.location.hostname.toLowerCase();

    // Dynamic Keys
    const getLcpKey = () => `PerfX_LCP_${hostname}:${getPathBucket()}`;
    const getInteractiveKey = () => `perfx-interactive:${hostname}:${getPathBucket()}`;
    const getProfileKey = () => `PerfX_PROFILE_${hostname}`;

    let LCP_KEY = getLcpKey();
    let INTERACTIVE_KEY = getInteractiveKey();

    let RuntimeConfig = {};

    const Env = {
        storageKey: `PerfX_ULTRA_${hostname}`,
        getOverrides() { return safeJsonParse(S.get(this.storageKey), {}); },
        saveOverrides(data) {
            const safeData = sanitizeConfig(data);
            S.set(this.storageKey, JSON.stringify(safeData));
            RuntimeConfig = { ...RuntimeConfig, ...data };
        }
    };

    RuntimeConfig = Env.getOverrides();
    const debug = !!RuntimeConfig.debug;
    const log = (...args) => debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    const applyInteractiveMemory = () => {
        const isInteractiveStored = safeJsonParse(S.get(INTERACTIVE_KEY), null);
        if (fresh(isInteractiveStored, DAY)) {
            log('Interactive Site Known: Starting Safe');
            RuntimeConfig = { ...RuntimeConfig, passive: false, memory: false, gpu: false, rtcGuard: false };
            Object.assign(Config, { passive: false, memory: false, gpu: false, rtcGuard: false });
            Bus.emit('perfx-config');
        }
    };

    // [Safety 0] Crash Guard
    const CRASH_KEY = `perfx-crash:${hostname}`;
    const SESSION_OFF_KEY = `perfx-safe:${hostname}`;
    const INTENT_RELOAD = `perfx-intent-reload:${hostname}`;
    const INTENT_INTERACTIVE = `perfx-intent-interactive:${hostname}`;

    try {
        if (new URLSearchParams(win.location.search).has('perfx-off')) sessionStorage.setItem(SESSION_OFF_KEY, '1');

        const isIntent = sessionStorage.getItem(INTENT_RELOAD);
        if (isIntent) {
            sessionStorage.removeItem(INTENT_RELOAD);
        } else {
            const lastCrash = parseInt(S.get(CRASH_KEY) || '0');
            if (lastCrash >= 3) { sessionStorage.setItem(SESSION_OFF_KEY, '1'); S.set(CRASH_KEY, '0'); }

            if (!sessionStorage.getItem(SESSION_OFF_KEY)) {
                S.set(CRASH_KEY, lastCrash + 1);
                if (win.requestIdleCallback) win.requestIdleCallback(() => S.remove(CRASH_KEY), { timeout: 10000 });
                else win.addEventListener('load', () => setTimeout(() => S.remove(CRASH_KEY), 5000));
            }
        }

        const forcedProfile = safeJsonParse(S.get(getProfileKey()), null);
        if (fresh(forcedProfile, WEEK)) {
            log('Adaptive Profile: Balanced Mode Enforced');
            RuntimeConfig = { ...RuntimeConfig, memory: false };
        }

        applyInteractiveMemory();

        onReady(() => {
            let isFramed = false; try { isFramed = win.top !== win.self; } catch { isFramed = true; }
            if (isFramed) return;

            const sensitive = document.querySelector('input[type="password"], input[autocomplete="one-time-code"], form[action*="login"], form[action*="pay"]');
            if (sensitive && !sessionStorage.getItem(SESSION_OFF_KEY)) {
                log('Sensitive Page Detected: Entering Safe Mode');
                sessionStorage.setItem(SESSION_OFF_KEY, '1');
                sessionStorage.setItem(INTENT_RELOAD, '1');
                reloadPage();
            }

            const checkInteractive = () => {
                const mapOrEditor = document.querySelector('.mapboxgl-map, .leaflet-container, .monaco-editor, .CodeMirror');
                const canvases = document.getElementsByTagName('canvas');
                let hugeCanvas = false;
                for (let i = 0; i < Math.min(canvases.length, 4); i++) {
                    const r = canvases[i].getBoundingClientRect();
                    if (r.width * r.height > (win.innerWidth * win.innerHeight * 0.4)) {
                        hugeCanvas = true; break;
                    }
                }

                if (mapOrEditor || hugeCanvas) {
                    log('Interactive App Detected: Reloading Safe');
                    S.set(INTERACTIVE_KEY, JSON.stringify({ ts: Date.now() }));

                    if (!sessionStorage.getItem(INTENT_INTERACTIVE)) {
                        sessionStorage.setItem(INTENT_INTERACTIVE, '1');
                        sessionStorage.setItem(INTENT_RELOAD, '1');
                        reloadPage();
                        return true;
                    }

                    Config.passive = false; Config.gpu = false; Config.rtcGuard = false;
                    if (Config.memory) { Config.memory = false; API.shutdownMemory(); }
                    return true;
                }
                return false;
            };

            if (!sessionStorage.getItem(INTENT_INTERACTIVE)) {
                if (!checkInteractive()) {
                    const mo = new MutationObserver(() => { if (checkInteractive()) mo.disconnect(); });
                    mo.observe(document.body, { childList: true, subtree: true });
                    setTimeout(() => mo.disconnect(), 3000);
                }
            } else {
                sessionStorage.removeItem(INTENT_INTERACTIVE);
            }
        });

        if (sessionStorage.getItem(SESSION_OFF_KEY)) {
            RuntimeConfig = { ...RuntimeConfig, codecMode: 'off', passive: false, gpu: false, memory: false, rtcGuard: false, _sessionSafe: true };
        }
    } catch(e) {}

    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = hostEndsWithAny(hostname, [...LISTS.BANKS_KR, ...LISTS.GOV_KR]) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = hostEndsWithAny(hostname, LISTS.HEAVY_FEEDS);
    const isVideoSite = hostEndsWithAny(hostname, LISTS.OTT_KR);
    const isSafeMode = isCritical || RuntimeConfig._sessionSafe;

    const baseLowPower = (navigator.hardwareConcurrency ?? 4) < 4;

    const perfState = {
        isLowPowerMode: baseLowPower,
        perfMultiplier: 1.0,
        DOM_CAP: 2000,
        MEDIA_CAP: 800,
        DOM_MARGIN: '600px 0px',
        NET_MARGIN: '50% 0px',
        INIT_DOM_SCAN: 300,
        INIT_MEDIA_SCAN: 600,
        SCAN_STEP: 100,
        PROTECT_MS: 3000,
        shouldAggressiveVideo: false
    };

    const applyPowerPolicy = () => {
        if (perfState.isLowPowerMode) {
            RuntimeConfig._powerThrottled = true;
            if (Config.memory) { Config.memory = false; API.shutdownMemory(); }
        } else {
            RuntimeConfig._powerThrottled = false;
        }
    };

    const computeState = () => {
        const hc = navigator.hardwareConcurrency || 4;
        const dm = navigator.deviceMemory || 4;
        const saveData = !!navigator.connection?.saveData;
        const net = navigator.connection?.effectiveType || '4g';

        perfState.isLowPowerMode = baseLowPower || saveData;

        let m = (hc <= 4 || dm <= 4 || isMobile) ? 0.8 : 1.0;
        if (saveData) m *= 0.85;
        if (/2g|3g/.test(net)) m *= 0.85;
        if (perfState.isLowPowerMode && !saveData) m *= 0.85;

        perfState.perfMultiplier = Math.max(0.6, Math.min(1.2, m));
        perfState.shouldAggressiveVideo = perfState.isLowPowerMode || isMobile || !!saveData;

        perfState.DOM_CAP = Math.floor(2000 * perfState.perfMultiplier);
        perfState.MEDIA_CAP = Math.floor(800 * perfState.perfMultiplier);
        perfState.PROTECT_MS = isMobile ? 3500 : Math.floor(3000 / perfState.perfMultiplier);

        if (isMobile) {
            perfState.DOM_CAP = Math.min(perfState.DOM_CAP, 1000);
            perfState.MEDIA_CAP = Math.min(perfState.MEDIA_CAP, 180);
            perfState.DOM_MARGIN = '300px 0px';
            perfState.NET_MARGIN = `${Math.round(viewH() * 0.6)}px 0px`;
            perfState.INIT_DOM_SCAN = 120;
            perfState.INIT_MEDIA_SCAN = 150;
            perfState.SCAN_STEP = 50;
        } else {
            perfState.DOM_MARGIN = perfState.isLowPowerMode ? '400px 0px' : '600px 0px';
            perfState.NET_MARGIN = '50% 0px';
            perfState.INIT_DOM_SCAN = 400;
            perfState.INIT_MEDIA_SCAN = 800;
            perfState.SCAN_STEP = 100;
        }

        perfState.DOM_CAP = Math.max(perfState.DOM_CAP, 200);
        perfState.MEDIA_CAP = Math.max(perfState.MEDIA_CAP, 100);
    };

    const refreshPerfState = () => {
        computeState();
        Bus.emit('perfx-power-change');
    };

    let rzT = null;
    win.addEventListener('resize', () => {
        clearTimeout(rzT);
        rzT = setTimeout(refreshPerfState, 200);
    });
    navigator.connection?.addEventListener?.('change', refreshPerfState);
    computeState();

    const Q_KEY = `perfx-quarantine:${hostname}`;
    let Q_CACHE = null;

    const checkQuarantine = (now = Date.now()) => {
        if (Q_CACHE && (now - Q_CACHE.ts) < DAY) return Q_CACHE;
        const q = safeJsonParse(S.get(Q_KEY), null);
        if (q && (now - q.ts) < DAY) { Q_CACHE = q; return q; }
        return null;
    };

    const qState = checkQuarantine();
    if (qState) {
        Q_CACHE = qState;
        RuntimeConfig = { ...RuntimeConfig, ...qState.modules };
        log('Quarantine Active:', qState.modules);
    }

    const calculatedConfig = {
        codecMode: RuntimeConfig.codecMode ?? 'hard',
        passive: RuntimeConfig.passive ?? (!isLayoutSensitive),
        gpu: RuntimeConfig.gpu ?? (!isLayoutSensitive && !perfState.isLowPowerMode),
        memory: RuntimeConfig.memory ?? (!isLayoutSensitive && !isHeavyFeed),
        allowIframe: RuntimeConfig.allowIframe ?? false,
        rtcGuard: RuntimeConfig.rtcGuard ?? false,
        downgradeLevel: RuntimeConfig.downgradeLevel || 0,
        memoryContainMode: RuntimeConfig.memoryContainMode || 'safe'
    };

    if (isSafeMode) {
        Object.assign(calculatedConfig, { codecMode: 'off', passive: false, gpu: false, memory: false, rtcGuard: false, allowIframe: true });
    }

    Object.assign(Config, calculatedConfig);
    applyPowerPolicy();

    Object.assign(API, {
        profile: (mode) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed, rtcGuard: false },
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed, rtcGuard: false },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false, rtcGuard: false }
            };
            const p = presets[mode] || presets.balanced;
            const current = Env.getOverrides();
            S.remove(Q_KEY); Q_CACHE = null;
            Env.saveOverrides({ ...current, ...p, disabled: false });
            reloadPage();
        },
        toggleConfig: (key) => {
            const c = Env.getOverrides();
            c[key] = !c[key];
            Env.saveOverrides(c);
            reloadPage();
        },
        toggleSessionSafe: () => {
             if (sessionStorage.getItem(SESSION_OFF_KEY)) sessionStorage.removeItem(SESSION_OFF_KEY);
             else sessionStorage.setItem(SESSION_OFF_KEY, '1');
             reloadPage();
        },
        resetAll: () => {
            S.clearPrefix(['PerfX_', 'perfx-']);
            try {
                sessionStorage.removeItem(SESSION_OFF_KEY);
                sessionStorage.removeItem(INTENT_RELOAD);
                sessionStorage.removeItem(INTENT_INTERACTIVE);
            } catch {}
            reloadPage();
        },
        showStatus: () => {
            const psStats = win.__PS_STATS__ || { blockedRequests: 0, strippedParams: 0, cleanedLinks: 0 };
            const info = `[PerfX v81.4 ULTRA Privacy]\nURL: ${getPathBucket()}\nMode: ${RuntimeConfig._sessionSafe ? 'SAFE' : 'ACTIVE'}\nPower: ${perfState.isLowPowerMode ? 'LOW' : 'HIGH'}\nCaps: DOM=${perfState.DOM_CAP}, MEDIA=${perfState.MEDIA_CAP}\nQuarantine: ${Q_CACHE ? 'YES' : 'NO'}\nRTC: ${Config.rtcGuard ? 'ON' : 'OFF'}\nModules: P=${Config.passive} M=${Config.memory} G=${Config.gpu} C=${Config.codecMode}\n\n🛡️ [Privacy Shield]\nBlocked Reqs: ${psStats.blockedRequests}\nCleaned Params: ${psStats.strippedParams}\nCleaned Links: ${psStats.cleanedLinks}`;
            if (typeof GM_notification !== 'undefined') GM_notification({ title: 'PerfX + Privacy Status', text: info, timeout: 5000 });
            else console.log(info);
        }
    });

    let lastKey = LCP_KEY;
    let lastRouteSignal = 0;

    const detectHeroImage = () => {
        const imgs = document.images;
        if (!imgs.length) return;

        let i = 0, maxArea = 0, heroUrl = null;
        const limit = isMobile ? 60 : 120;

        const step = () => {
            const end = Math.min(i + 20, imgs.length, limit);
            for (; i < end; i++) {
                const img = imgs[i];
                const r = img.getBoundingClientRect();
                if (r.bottom <= 0 || r.top >= win.innerHeight) continue;
                const area = r.width * r.height;
                if (area > maxArea) {
                    maxArea = area;
                    heroUrl = img.currentSrc || img.src;
                }
            }
            if (i < Math.min(imgs.length, limit)) scheduler.request(step);
            else if (heroUrl) {
                const nUrl = normUrl(heroUrl);
                if (RuntimeConfig._lcp !== nUrl) {
                    RuntimeConfig._lcp = nUrl;
                    persistLCP();
                    Bus.emit('perfx-lcp-update', { url: nUrl });
                }
            }
        };
        setTimeout(() => scheduler.request(step), 800);
    };

    let lcpWriteT = null;
    const persistLCP = () => { if (RuntimeConfig._lcp) S.set(LCP_KEY, RuntimeConfig._lcp); };
    const schedulePersistLCP = () => {
        clearTimeout(lcpWriteT);
        lcpWriteT = setTimeout(persistLCP, 1200);
    };

    const emitRoute = (force) => {
        const now = Date.now();
        const throttle = force ? 5000 : 1000;
        if (force || now - lastRouteSignal > throttle) {
            lastRouteSignal = now;
            Bus.emit('perfx-route', { force });
        }
    };

    const onRoute = () => {
        const nextKey = getLcpKey();
        if (nextKey !== lastKey) {
            persistLCP();
            lastKey = nextKey;
            LCP_KEY = nextKey;

            INTERACTIVE_KEY = `perfx-interactive:${hostname}:${getPathBucket()}`;
            applyInteractiveMemory();

            RuntimeConfig._lcp = S.get(LCP_KEY) || null;
            emitRoute(true);
            detectHeroImage();
        } else {
            emitRoute(false);
        }
    };

    if (!win.__perfx_history_patched) {
        win.__perfx_history_patched = true;

        const wrapHistoryMethod = (orig) => function(...args) {
            const ret = orig.apply(this, args);
            queueMicrotask(() => {
                try { onRoute(); }
                catch (e) { log('onRoute error:', e); }
            });
            return ret;
        };

        const origPush = history.pushState;
        history.pushState = wrapHistoryMethod(origPush);

        const origRep = history.replaceState;
        history.replaceState = wrapHistoryMethod(origRep);

        win.addEventListener('popstate', onRoute);
        win.addEventListener('hashchange', onRoute);
        win.addEventListener('pageshow', (e) => {
            if (e.persisted) Bus.emit('perfx-route', { force: true });
        });
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        if (RuntimeConfig.disabled) {
            GM_registerMenuCommand(`✅ 최적화 켜기`, () => API.toggleConfig('disabled'));
        } else {
            GM_registerMenuCommand(`❌ 최적화 끄기 (영구)`, () => API.toggleConfig('disabled'));
            GM_registerMenuCommand(`⏸️ 이번 세션만 끄기`, API.toggleSessionSafe);
            GM_registerMenuCommand(`🧹 설정/학습 초기화`, API.resetAll);
            GM_registerMenuCommand(`📊 현재 상태 보기`, API.showStatus);
            GM_registerMenuCommand(`⚡ 모드: 울트라`, () => API.profile('ultra'));
            GM_registerMenuCommand(`⚖️ 모드: 균형`, () => API.profile('balanced'));
            GM_registerMenuCommand(`🛡️ 모드: 안전`, () => API.profile('safe'));
        }
    }

    if (RuntimeConfig.disabled) return;

    let isFramed = false;
    try { isFramed = win.top !== win.self; } catch(e) { isFramed = true; }
    if (isFramed && !Config.allowIframe) return;

    if (debug) win.perfx = { version: '81.4.1', config: Config, ...API };

    // ==========================================
    // 2. Autonomous V30 (Safe PO, LoAF Weighting, Resource Observer)
    // ==========================================
    if (SUPPORTED_TYPES.size > 0 && !RuntimeConfig._sessionSafe) {
        const poList = [];
        const safePO = (type, cb, opt = {}) => {
            try {
                if (!SUPPORTED_TYPES.has(type)) return null;
                const po = new PerformanceObserver(cb);
                po.observe({ type, buffered: true, ...opt });
                poList.push(po);
                return po;
            } catch (e) {
                log(`PO(${type}) init fail`, e);
                return null;
            }
        };

        let clsTotal = 0, longTaskCount = 0, longTaskDur = 0;
        let loafCount = 0, loafDur = 0, loafBlock = 0, slowInteractionScore = 0;
        let lastCls = 0, lastLtDur = 0, lastLoafCount = 0, lastLoafBlock = 0, lastSlowScore = 0;
        let resourceBytes = 0, slowResourceCount = 0;
        let lastResBytes = 0, lastSlowRes = 0;
        let recoveryStreak = 0;

        const interactionMaxDur = new Map();
        let interactionGcTs = performance.now();

        safePO('layout-shift', (l) => {
            for (const e of l.getEntries()) { if (!e.hadRecentInput) clsTotal += e.value; }
        });

        safePO('longtask', (l) => {
            for (const e of l.getEntries()) {
                longTaskCount += 1;
                longTaskDur += (e.duration || 0);
            }
        });

        safePO('long-animation-frame', (l) => {
            for (const e of l.getEntries()) {
                loafCount += 1;
                loafDur += (e.duration || 0);
                loafBlock += (e.blockingDuration || e.duration || 0);
            }
        });

        safePO('event', (l) => {
            const now = performance.now();
            for (const e of l.getEntries()) {
                const dur = e.duration || 0;
                if (dur < 80) continue;
                const iid = e.interactionId || 0;
                if (iid > 0) {
                    const prev = interactionMaxDur.get(iid) || 0;
                    if (dur > prev) interactionMaxDur.set(iid, dur);
                } else {
                    slowInteractionScore += (dur >= 160 ? 2 : 1);
                }
            }
            if (now - interactionGcTs > 3000) {
                for (const maxDur of interactionMaxDur.values()) {
                    slowInteractionScore += (maxDur >= 200 ? 2 : 1);
                }
                interactionMaxDur.clear();
                interactionGcTs = now;
            }
        }, { durationThreshold: 40 });

        safePO('largest-contentful-paint', (list) => {
            const entries = list.getEntries();
            if (entries.length > 0) {
                const lcp = entries[entries.length - 1];
                const url = lcp.url || lcp.element?.src || lcp.element?.currentSrc;
                if (url) {
                    const currentLCP = normUrl(url);
                    if (currentLCP !== RuntimeConfig._lcp) {
                        RuntimeConfig._lcp = currentLCP;
                        schedulePersistLCP();
                        Bus.emit('perfx-lcp-update', { url: currentLCP });
                    }
                }
            }
        });

        safePO('resource', (list) => {
            for (const e of list.getEntries()) {
                const it = e.initiatorType || '';
                if (!['img', 'video', 'script', 'fetch', 'xmlhttprequest'].includes(it)) continue;
                resourceBytes += (e.transferSize || 0);
                if ((e.duration || 0) > 800) slowResourceCount += 1;
            }
        });

        const adaptMediaCapsByResources = () => {
            const bytesDelta = resourceBytes - lastResBytes;
            const slowDelta = slowResourceCount - lastSlowRes;
            lastResBytes = resourceBytes;
            lastSlowRes = slowResourceCount;

            if (bytesDelta > 8 * 1024 * 1024 || slowDelta >= 5) {
                perfState.MEDIA_CAP = Math.max(80, Math.floor(perfState.MEDIA_CAP * 0.85));
                Bus.emit('perfx-power-change');
                log('Adaptive MEDIA_CAP down', { bytesDelta, slowDelta, mediaCap: perfState.MEDIA_CAP });
            }
        };

        const videoPresenceCache = makeTTLCache();
        const hasVideo = () => videoPresenceCache.get(30000, () => !!document.querySelector('video, source[type*="video"]'));

        let healthTimer = null;
        let ignoreHealthUntil = 0;

        const scheduleHealthNext = (ms = 5000) => {
            if (healthTimer) clearTimeout(healthTimer);
            healthTimer = setTimeout(checkHealth, ms);
        };

        onPageActivated(() => {
            const activationStart = getActivationStart();
            if (activationStart > 0) {
                ignoreHealthUntil = performance.now() + 2000;
                log('Prerender activated, temporary health grace window');
            }
        });

        const checkHealth = () => {
            try {
                if (document.hidden) return;
                if (performance.now() < ignoreHealthUntil) {
                    scheduleHealthNext(3000);
                    return;
                }

                const clsDelta = clsTotal - lastCls;
                const ltDurDelta = longTaskDur - lastLtDur;
                const loafCountDelta = loafCount - lastLoafCount;
                const loafBlockDelta = loafBlock - lastLoafBlock;
                const slowScoreDelta = slowInteractionScore - lastSlowScore;

                lastCls = clsTotal;
                lastLtDur = longTaskDur;
                lastLoafCount = loafCount;
                lastLoafBlock = loafBlock;
                lastSlowScore = slowInteractionScore;

                const c = RuntimeConfig;
                const currentLevel = c.downgradeLevel || 0;

                const TH = {
                    L2_CLS: 0.2 * perfState.perfMultiplier,
                    L2_LT_DUR: 250 * perfState.perfMultiplier,
                    L2_LOAF_BLOCK: 120 * perfState.perfMultiplier,
                    L2_LOAF_COUNT: Math.max(2, Math.round(4 * perfState.perfMultiplier)),
                    L2_EVT: Math.max(2, Math.round(3 * perfState.perfMultiplier))
                };

                const now = Date.now();

                // Quarantine
                if (c.downgradeCount > 5 && !checkQuarantine(now)) {
                    const lastReason = c.downgradeReason || { cls: 1, load: 0 };
                    const modules = (lastReason.load > lastReason.cls)
                        ? { gpu: false, codecMode: hasVideo() ? 'soft' : c.codecMode, memory: false }
                        : { memory: false, passive: false };

                    const qVal = { ts: now, modules };
                    S.set(Q_KEY, JSON.stringify(qVal));
                    Q_CACHE = qVal;

                    c.downgradeCount = 0; c.unstableTs = now;
                    S.set(getProfileKey(), JSON.stringify({ ts: now }));
                    Object.assign(c, modules); Object.assign(Config, modules);
                    Env.saveOverrides(c);
                    Bus.emit('perfx-config');
                    API.shutdownMemory();

                    scheduleHealthNext(5000);
                    return;
                }

                const degradeByFrameJank = loafBlockDelta > TH.L2_LOAF_BLOCK || (loafCountDelta > TH.L2_LOAF_COUNT && ltDurDelta > TH.L2_LT_DUR);

                // L2
                if ((clsDelta > TH.L2_CLS || degradeByFrameJank || slowScoreDelta > TH.L2_EVT) && currentLevel < 2) {
                    if (!c._restore) c._restore = { ...Config };

                    c.downgradeLevel = 2;
                    c.downgradeReason = { cls: clsDelta, load: loafCountDelta };
                    c.gpu = false;
                    c.memory = false;
                    c.codecMode = 'soft';
                    c.downgradeCount = (c.downgradeCount || 0) + 1;
                    c.unstableTs = now;

                    Env.saveOverrides(c);

                    Object.assign(Config, { gpu: false, memory: false, codecMode: 'soft', downgradeLevel: 2 });

                    API.shutdownMemory();
                    Bus.emit('perfx-config');
                    log(`Downgrade L2`);
                    recoveryStreak = 0;
                }
                // Recovery
                else if (currentLevel > 0 && clsDelta < 0.01 && !degradeByFrameJank && slowScoreDelta < 1) {
                    recoveryStreak++;
                    if (recoveryStreak >= 4) {
                        const isQ = checkQuarantine(now);
                        if (c._restore) {
                            if (isQ) {
                                if (Q_CACHE?.modules?.memory === false) c._restore.memory = false;
                                if (Q_CACHE?.modules?.gpu === false) c._restore.gpu = false;
                            }
                            Object.assign(Config, c._restore);
                            Object.assign(c, c._restore);
                            delete c._restore;
                        }
                        delete c.downgradeLevel; delete c.downgradeReason;
                        Env.saveOverrides(c);
                        Bus.emit('perfx-config');
                        log('Restored');
                        recoveryStreak = 0;
                    }
                } else {
                    recoveryStreak = 0;
                }

                adaptMediaCapsByResources();

            } catch (e) {
                log('checkHealth error', e);
            } finally {
                if (!document.hidden && !healthTimer) scheduleHealthNext(5000);
            }
        };

        const stopLoop = () => { if (healthTimer) clearTimeout(healthTimer); healthTimer = null; };
        Bus.on('visibilitychange', () => {
            if (document.hidden) { stopLoop(); persistLCP(); }
            else { if (!healthTimer) scheduleHealthNext(5000); }
        }, document);
        win.addEventListener('pagehide', persistLCP);

        if (!healthTimer) scheduleHealthNext(5000);
    }

    // ==========================================
    // 3. Core Modules
    // ==========================================

    // [Core 0] WebRTC Guard (Refined Proxy/Reflect)
    class WebRTCGuard extends BaseModule {
        init() {
            if (!Config.rtcGuard || isSafeMode) return;
            if (hostEndsWithAny(hostname, LISTS.RTC_ALLOW)) return;

            const patchPeerCtor = (prop) => {
                const Peer = win[prop];
                if (!Peer) return;
                const MARK = Symbol.for(`perfx.rtc.${prop}`);
                if (Peer[MARK]) return;

                let Wrapped;
                if (typeof Proxy !== 'undefined') {
                    Wrapped = new Proxy(Peer, {
                        construct(target, args, newTarget) {
                            const pc = Reflect.construct(target, args, newTarget);
                            if (typeof pc.createDataChannel === 'function') {
                                pc.createDataChannel = function() {
                                    throw new DOMException('RTCDataChannel blocked by PerfX policy', 'NotAllowedError');
                                };
                            }
                            return pc;
                        }
                    });
                } else {
                    Wrapped = function(...args) {
                        const pc = new Peer(...args);
                        if (typeof pc.createDataChannel === 'function') {
                            pc.createDataChannel = function() {
                                throw new DOMException('RTCDataChannel blocked by PerfX policy', 'NotAllowedError');
                            };
                        }
                        return pc;
                    };
                }

                try { Object.setPrototypeOf(Wrapped, Peer); } catch {}
                try { Wrapped.prototype = Peer.prototype; } catch {}
                try { Object.defineProperty(Wrapped, MARK, { value: true }); } catch {}

                win[prop] = Wrapped;
            };

            patchPeerCtor('RTCPeerConnection');
            patchPeerCtor('webkitRTCPeerConnection');
            patchPeerCtor('mozRTCPeerConnection');
        }
    }

    // [Core 1] EventPassivator with Strict Ruleset
    class EventPassivator extends BaseModule {
        init() {
            if (win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            let passiveArmed = false;
            setTimeout(() => { passiveArmed = true; }, 1500);

            const PASSIVE_RULES = {
                FORCE_TYPES: new Set(['wheel', 'mousewheel']),
                SKIP_HOSTS: [ /figma\.com$/i, /miro\.com$/i, /excalidraw\.com$/i ],
                SKIP_TARGET_SELECTORS: [
                    '.mapboxgl-map', '.leaflet-container', '.monaco-editor',
                    '.CodeMirror', '.cm-editor', 'canvas', '[data-perfx-no-passive]'
                ]
            };

            const shouldSkipPassiveByHost = (hn) => PASSIVE_RULES.SKIP_HOSTS.some(re => re.test(hn));
            const shouldSkipPassiveByTarget = (target) => {
                try {
                    if (!(target instanceof Element)) return false;
                    return !!target.closest(PASSIVE_RULES.SKIP_TARGET_SELECTORS.join(', '));
                } catch { return false; }
            };

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);
            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (!Config.passive || !passiveArmed || !PASSIVE_RULES.FORCE_TYPES.has(type) || shouldSkipPassiveByHost(location.hostname) || this === window || this === document || shouldSkipPassiveByTarget(this)) {
                        return origAdd.call(this, type, listener, options);
                    }

                    const isObj = typeof options === 'object' && options !== null;
                    if (!isObj || options.passive === undefined) {
                        try {
                            const finalOptions = isObj ? { ...options, passive: true } : { capture: options === true, passive: true };
                            return origAdd.call(this, type, listener, finalOptions);
                        } catch {}
                    }
                    return origAdd.call(this, type, listener, options);
                };
            });
        }
    }

    // [Core 2] CodecOptimizer
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off' || isVideoSite) return;

            const requestedCodecMode = Config.codecMode;
            let effectiveCodecMode = requestedCodecMode;
            if (!perfState.isLowPowerMode && requestedCodecMode === 'hard') {
                effectiveCodecMode = 'soft';
            }

            setTimeout(() => {
                if (document.querySelector('video, source[type*="video"]') && effectiveCodecMode === 'hard') {
                    effectiveCodecMode = 'soft';
                }
            }, 800);

            const codecPolicy = { av1: { supported: null, smooth: null, powerEfficient: null } };
            async function probeCodecCapabilities() {
                if (!navigator.mediaCapabilities?.decodingInfo) return;
                try {
                    const res = await navigator.mediaCapabilities.decodingInfo({
                        type: 'file',
                        video: { contentType: 'video/mp4; codecs="av01.0.05M.08"', width: 1280, height: 720, bitrate: 2500000, framerate: 30 }
                    });
                    codecPolicy.av1 = { supported: !!res.supported, smooth: !!res.smooth, powerEfficient: !!res.powerEfficient };
                } catch {}
            }
            probeCodecCapabilities();

            const shouldBlock = (t) => {
                if (typeof t !== 'string') return false;
                const v = t.toLowerCase();

                if (effectiveCodecMode === 'hard') return v.includes('av01') || /vp9|vp09/.test(v);

                if (effectiveCodecMode === 'soft' && v.includes('av01')) {
                    if (codecPolicy.av1.supported === true && codecPolicy.av1.smooth === true && codecPolicy.av1.powerEfficient === true) {
                        return false;
                    }
                    return true;
                }
                return false;
            };

            const hook = (target, prop, isProto, marker) => {
                if (!target) return;
                const root = isProto ? target.prototype : target;
                if (!root || root[marker]) return;
                try {
                    const orig = root[prop];
                    if (typeof orig !== 'function') return;
                    root[prop] = function(t) {
                        if (shouldBlock(t)) return isProto ? '' : false;
                        return orig.apply(this, arguments);
                    };
                    root[marker] = true;
                } catch {}
            };

            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, Symbol.for('perfx.ms'));
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, Symbol.for('perfx.me'));
        }
    }

    // [Core 3] DomWatcher
    class DomWatcher extends BaseModule {
        init() {
            if (isSafeMode) return;
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            this.supportsCISAuto = !!(win.CSS?.supports?.('contain-intrinsic-size', 'auto 1px auto 1px'));

            if (Config.memory && !this.supportsCV) Config.memory = false;
            if (!('IntersectionObserver' in win)) return;

            this.styleMap = new WeakMap();
            this.optimized = new Set();
            this.removedQueue = new Set();
            this.gcTimer = null;

            API.shutdownMemory = () => {
                if (this.mutObs) { this.mutObs.disconnect(); this.mutObs = null; }
                if (this.visObs) { this.visObs.disconnect(); this.visObs = null; }
                if (this.optimized.size > 0) {
                    const arr = [...this.optimized];
                    const processRestore = () => {
                        const chunk = arr.splice(0, 100);
                        for (const el of chunk) this.restoreStyle(el);
                        if (arr.length > 0) scheduler.request(processRestore);
                        else this.optimized.clear();
                    };
                    processRestore();
                }
                if (Config.gpu) this.startIO();
            };

            API.restartMemory = () => {
                if (Config.memory) { this.startIO(); this.startMO(); }
                else if (Config.gpu) { this.startIO(); }
            };

            onReady(() => { if(Config.memory || Config.gpu) { this.startIO(); this.startMO(); } });

            this.on(win, 'perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
            this.on(win, 'perfx-config', () => { API.shutdownMemory(); API.restartMemory(); });
            this.on(win, 'perfx-route', () => { API.shutdownMemory(); API.restartMemory(); });
        }

        isOptimizable(el, rect) {
            if (!el || el.nodeType !== 1) return false;
            if (el.closest?.('[data-perfx-no-cv], [contenteditable="true"], video, canvas, iframe, form')) return false;
            const tn = el.tagName;
            if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'META') return false;
            if (el.hasAttribute('aria-live')) return false;

            if (!rect || rect.height < 50 || rect.width < 50) return false;
            const area = rect.width * rect.height;
            if (isMobile && area < 2000) return false;
            if (!isMobile && area < 3000) return false;

            if (area > (win.innerWidth * win.innerHeight * 0.15)) {
                if (el.childElementCount > 6 && el.querySelector('video,canvas,iframe,form,[aria-live],[contenteditable]')) return false;
            }
            return true;
        }

        applyOptimization(el, rect) {
            if (this.styleMap.has(el)) return;
            if (!this.isOptimizable(el, rect)) return;

            const style = getComputedStyle(el);
            if (style.position === 'sticky' || style.position === 'fixed') return;
            if (/(auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) return;

            this.styleMap.set(el, {
                cv: el.style.contentVisibility,
                contain: el.style.contain,
                cis: el.style.containIntrinsicSize
            });
            this.optimized.add(el);

            const w = Math.min(2000, Math.ceil(rect.width));
            const h = Math.min(2000, Math.ceil(rect.height));

            el.style.contentVisibility = 'auto';
            if (this.supportsCISAuto) {
                el.style.containIntrinsicSize = `auto ${Math.max(1, w)}px auto ${Math.max(1, h)}px`;
            } else {
                el.style.containIntrinsicSize = `${Math.max(1, w)}px ${Math.max(1, h)}px`;
            }

            if (Config.memoryContainMode === 'aggressive') {
                el.style.contain = 'layout paint';
            } else {
                el.style.contain = 'paint';
            }
        }

        restoreStyle(el) {
            const b = this.styleMap.get(el);
            if (b) {
                el.style.contentVisibility = b.cv;
                el.style.contain = b.contain;
                el.style.containIntrinsicSize = b.cis;
                this.styleMap.delete(el);
            }
            this.optimized.delete(el);
        }

        flushRemoved() {
            if (this.removedQueue.size === 0) return;
            for (const root of this.removedQueue) this.sweepRemovedSubtree(root);
            this.removedQueue.clear();
            this.gcTimer = null;
        }

        sweepRemovedSubtree(root) {
            if (!root || root.nodeType !== 1) return;
            if (this.optimized.has(root)) this.restoreStyle(root);

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            while (walker.nextNode()) {
                const el = walker.currentNode;
                if (this.optimized.has(el)) this.restoreStyle(el);
            }
        }

        startIO() {
            if (this.visObs) this.visObs.disconnect();
            if (!Config.memory && !Config.gpu) return;

            if (!document.body) {
                onReady(() => this.startIO());
                return;
            }

            this.obsCount = 0;
            this.observed = new WeakSet();
            const margin = perfState.DOM_MARGIN;

            this.visObs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (!e.target.isConnected) return;
                    if (Config.gpu && e.target.tagName === 'CANVAS') {
                        e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                    }
                    else if (Config.memory && this.supportsCV) {
                        if (e.isIntersecting) this.restoreStyle(e.target);
                        else this.applyOptimization(e.target, e.boundingClientRect);
                    }
                });
            }, { rootMargin: margin, threshold: 0.01 });

            this.observeSafe = (el) => {
                if (el && this.obsCount < perfState.DOM_CAP && !this.observed.has(el)) {
                    this.visObs.observe(el);
                    this.observed.add(el);
                    this.obsCount++;
                }
            };

            const queryFeedItems = (root) => {
                let items = root.querySelectorAll(ITEM_SEL);
                if (!items.length && root.matches?.('[role="list"], ul, ol')) items = root.querySelectorAll(':scope > li');
                return items;
            };

            if (Config.gpu) document.querySelectorAll('canvas').forEach(this.observeSafe);

            if (Config.memory) {
                const root = document.querySelector(FEED_SEL) || document.body;
                scanInChunks(root.children, perfState.INIT_DOM_SCAN, perfState.SCAN_STEP, this.observeSafe);

                if (root.tagName !== 'BODY') {
                    const items = queryFeedItems(root);
                    scanInChunks(items, 50, perfState.SCAN_STEP, this.observeSafe);
                }
            }
        }

        startMO() {
            if (!Config.memory) return;
            if (!document.body) {
                onReady(() => this.startMO());
                return;
            }
            if (this.mutObs) this.mutObs.disconnect();

            const target = document.querySelector(FEED_SEL) || document.body;

            this.mutObs = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (this.obsCount < perfState.DOM_CAP) {
                        m.addedNodes.forEach(n => {
                            if (n.nodeType === 1) {
                                if (['DIV','SECTION','ARTICLE','LI'].includes(n.tagName)) {
                                    this.observeSafe(n);
                                    if (n.childElementCount > 0) {
                                        const list = n.querySelectorAll(ITEM_SEL);
                                        scanInChunks(list, 50, perfState.SCAN_STEP, this.observeSafe);
                                    }
                                }
                            }
                        });
                    }
                    m.removedNodes.forEach(n => {
                        if (n.nodeType === 1) this.removedQueue.add(n);
                    });
                });
                if (this.removedQueue.size > 0 && !this.gcTimer) {
                    this.gcTimer = scheduler.request(() => this.flushRemoved(), 200);
                }
            });
            this.mutObs.observe(target, { childList: true, subtree: true });
        }
    }

    // [Core 4] NetworkAssistant
    class NetworkAssistant extends BaseModule {
        init() {
            if (isSafeMode) return;

            const seenState = new WeakMap();
            const distMap = new WeakMap();
            const observing = new Set();
            let imgSlots = 0, vidSlots = 0;
            let MAX_IMG = 0, MAX_VID = 0;
            let vpObs = null;
            let currentGen = 0;

            const batchQueue = new Map();
            let batchTimer = null;

            let lcpUrlCached = RuntimeConfig._lcp || S.get(LCP_KEY) || null;

            let protectTimer = null;
            let isProtectionPhase = false;

            const startProtection = (force = false) => {
                isProtectionPhase = true;
                const ms = force ? perfState.PROTECT_MS : Math.min(1000, perfState.PROTECT_MS / 3);
                if (protectTimer) clearTimeout(protectTimer);
                protectTimer = setTimeout(() => { isProtectionPhase = false; protectTimer = null; }, ms);
            };

            const decSlot = (el) => {
                if (observing.has(el)) {
                    observing.delete(el);
                    distMap.delete(el);
                    if (el.tagName === 'VIDEO') vidSlots = Math.max(0, vidSlots - 1);
                    else imgSlots = Math.max(0, imgSlots - 1);
                }
            };

            const getFetchPriority = (img) => {
                try { if ('fetchPriority' in img) return String(img.fetchPriority || '').toLowerCase(); } catch {}
                return (img.getAttribute('fetchpriority') || '').toLowerCase();
            };

            const setFetchPrioritySafe = (img, value) => {
                try {
                    if ('fetchPriority' in img) img.fetchPriority = value;
                    else img.setAttribute('fetchpriority', value);
                } catch {
                    try { img.setAttribute('fetchpriority', value); } catch {}
                }
            };

            const isAuthorCriticalImage = (img) => {
                if (!img) return false;
                const loading = (img.getAttribute('loading') || '').toLowerCase();
                const fp = getFetchPriority(img);
                return loading === 'eager' || fp === 'high' || !!img.closest?.('[data-perfx-critical]');
            };

            const setImgLazy = (img, setPriority = true) => {
                if (!img || img.complete) return;
                if (isAuthorCriticalImage(img)) return;

                const currentLoading = (img.getAttribute('loading') || '').toLowerCase();
                const currentFP = getFetchPriority(img);

                if (!currentLoading) img.loading = 'lazy';
                if (!img.hasAttribute('decoding')) img.decoding = 'async';

                if (setPriority && !currentFP) {
                    setFetchPrioritySafe(img, 'low');
                }
            };

            const applyLazy = (img, rect) => {
                if (!rect) { setImgLazy(img); return; }
                if (rect.top < win.innerHeight + 200 && rect.bottom > -200) return;
                setImgLazy(img);
            };

            const updateCaps = () => {
                const cap = perfState.MEDIA_CAP;
                MAX_IMG = Math.floor(cap * 0.85);
                MAX_VID = Math.max(10, cap - MAX_IMG);
                if (isMobile) MAX_VID = Math.min(MAX_VID, 6);

                if (observing.size > cap) {
                    const sorted = [...observing].sort((a, b) => {
                        const dA = distMap.get(a) ?? -1;
                        const dB = distMap.get(b) ?? -1;
                        const vA = dA === -1 ? 0 : dA;
                        const vB = dB === -1 ? 0 : dB;
                        return vB - vA;
                    });
                    const excess = observing.size - cap;
                    for (let i = 0; i < excess; i++) {
                        const el = sorted[i];
                        if (vpObs) vpObs.unobserve(el);
                        decSlot(el);
                    }
                }
            };

            const rebuildObserver = () => {
                if (vpObs) vpObs.disconnect();
                updateCaps();

                vpObs = new IntersectionObserver((entries) => {
                    entries.forEach(e => {
                        const el = e.target;
                        distMap.set(el, distToViewport(e.boundingClientRect));

                        if (el.tagName === 'VIDEO') {
                            if (e.isIntersecting) {
                                el.setAttribute('preload', 'metadata');
                                vpObs.unobserve(el);
                                decSlot(el);
                            } else {
                                if (!el.hasAttribute('preload')) el.setAttribute('preload', 'none');
                            }
                            return;
                        }

                        if (e.isIntersecting) {
                            seenState.set(el, { gen: currentGen, near: true });
                        } else {
                            seenState.set(el, { gen: currentGen, near: false });
                            applyLazy(el, e.boundingClientRect);
                        }
                        vpObs.unobserve(el);
                        decSlot(el);
                    });
                }, { rootMargin: perfState.NET_MARGIN });

                observing.forEach(el => vpObs.observe(el));

                imgSlots = 0; vidSlots = 0;
                observing.forEach(el => {
                    if (el.tagName === 'VIDEO') vidSlots++; else imgSlots++;
                });
            };

            this.on(win, 'perfx-power-change', rebuildObserver);
            this.on(win, 'perfx-config', () => {
                if (batchTimer) { scheduler.cancel(batchTimer); batchTimer = null; }
                batchQueue.clear();
                rebuildObserver();
            });
            this.on(win, 'perfx-lcp-update', (e) => { lcpUrlCached = e.detail?.url || lcpUrlCached; });

            this.on(win, 'perfx-route', (e) => {
                lcpUrlCached = RuntimeConfig._lcp || S.get(LCP_KEY) || null;
                if (e.detail?.force) {
                    currentGen++;
                    observing.forEach(el => { try{vpObs.unobserve(el);}catch{} });
                    observing.clear();
                    rebuildObserver();
                }
                startProtection(e.detail?.force);
            });

            onReady(() => { startProtection(true); rebuildObserver(); });

            const safeObserve = (el) => {
                if (!vpObs) return;
                const isVid = el.tagName === 'VIDEO';
                if (observing.has(el)) return;
                if (isVid) { if (vidSlots >= MAX_VID) return; vidSlots++; }
                else { if (imgSlots >= MAX_IMG) return; imgSlots++; }

                observing.add(el);
                vpObs.observe(el);
            };
            const ensureObs = () => { if (!vpObs) rebuildObserver(); };

            const processVideo = (vid) => {
                if (vid.hasAttribute('preload') || isVideoSite) return;
                if (!perfState.shouldAggressiveVideo && !vid.autoplay) { safeObserve(vid); return; }
                vid.setAttribute('preload', 'none');
                safeObserve(vid);
            };

            const processImg = (img, fromMutation) => {
                if (!img || img.complete) return;

                const loading = (img.getAttribute('loading') || '').toLowerCase();
                const fp = getFetchPriority(img);

                if (loading === 'eager' || fp === 'high') return;

                if (lcpUrlCached) {
                    const cur = normUrl(img.currentSrc || img.src);
                    if (cur === lcpUrlCached) {
                        img.loading = 'eager';
                        if (!img.hasAttribute('decoding')) img.decoding = 'sync';
                        setFetchPrioritySafe(img, 'high');
                        return;
                    }
                }

                if (loading === 'lazy' && fp === 'low') return;

                if (fromMutation && !isProtectionPhase) {
                    if (imgSlots < MAX_IMG) { safeObserve(img); return; }
                    setImgLazy(img);
                    return;
                }

                const st = seenState.get(img);
                if (st && st.gen === currentGen) {
                    if (st.near) return;
                    setImgLazy(img);
                    return;
                }

                safeObserve(img);
            };

            const flushQueue = () => {
                batchQueue.forEach((fromMutation, node) => {
                    if (!node.isConnected) return;
                    if (node.tagName === 'IFRAME') {
                        if (!node.hasAttribute('loading') && !isCritical) node.loading = 'lazy';
                        return;
                    }
                    if (node.tagName === 'VIDEO') processVideo(node);
                    else processImg(node, fromMutation);
                });
                batchQueue.clear();
                batchTimer = null;
            };

            const scheduleNode = (node, fromMutation = false) => {
                ensureObs();
                const current = batchQueue.get(node);
                batchQueue.set(node, current || fromMutation);
                if (!batchTimer) batchTimer = scheduler.request(flushQueue, 200);
            };

            const run = () => {
                rebuildObserver();
                const imgs = document.getElementsByTagName('img');
                const vids = document.getElementsByTagName('video');
                scanInChunks(imgs, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
                scanInChunks(vids, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
            };
            onReady(run);

            this.mo = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (m.addedNodes.length === 0) return;
                    m.addedNodes.forEach(n => {
                        if (n.tagName === 'IMG' || n.tagName === 'VIDEO' || n.tagName === 'IFRAME') scheduleNode(n, true);
                        else if (n.nodeType === 1) {
                            if (n.getElementsByTagName) {
                                const i = n.getElementsByTagName('img');
                                if (i.length) scanInChunks(i, 300, perfState.SCAN_STEP, (child) => scheduleNode(child, true));
                                const v = n.getElementsByTagName('video');
                                if (v.length) scanInChunks(v, 100, perfState.SCAN_STEP, (child) => scheduleNode(child, true));
                            }
                        }
                    });
                    m.removedNodes.forEach(n => {
                        if (n.nodeType === 1) {
                            if (n.tagName === 'IMG' || n.tagName === 'VIDEO') decSlot(n);
                            else if (n.getElementsByTagName) {
                                const i = n.getElementsByTagName('img');
                                if(i.length) scanInChunks(i, 300, perfState.SCAN_STEP, decSlot);
                                const v = n.getElementsByTagName('video');
                                if(v.length) scanInChunks(v, 100, perfState.SCAN_STEP, decSlot);
                            }
                        }
                    });
                });
            });
            this.mo.observe(document.documentElement, { childList: true, subtree: true });

            this.on(document, 'visibilitychange', () => {
                if (document.hidden) {
                    if (batchTimer) { scheduler.cancel(batchTimer); batchTimer = null; }
                    if (this.mo) this.mo.disconnect();
                } else {
                    startProtection(false);
                    ensureObs();
                    scanInChunks(document.getElementsByTagName('img'), 200, perfState.SCAN_STEP, (n) => scheduleNode(n, true));
                    scanInChunks(document.getElementsByTagName('video'), 80, perfState.SCAN_STEP, (n) => scheduleNode(n, true));
                    if (this.mo) this.mo.observe(document.documentElement, { childList: true, subtree: true });
                }
            });

            this.on(win, 'pagehide', (e) => {
                if (!e.persisted && vpObs) vpObs.disconnect();
            });
        }
    }

    // [Core 5] PrivacyAssistant
    class PrivacyAssistant extends BaseModule {
        init() {
            this.stats = { blockedRequests: 0, strippedParams: 0, cleanedLinks: 0 };
            win.__PS_STATS__ = this.stats;

            this.TRACKING_PARAMS = new Set([
                'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
                'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
                'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid',
                'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_source',
                'mc_cid', 'mc_eid', 'msclkid',
                '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking',
                'mkt_tok', 'mc_phishing_protection_id', 's_cid', 'icid',
                'ref', 'referrer', 'source', 'affiliate', 'zanpid',
                'origin', 'igshid', 'twclid', 'li_fat_id', 'yclid', 'email_source', 'CMP'
            ]);

            this.BLOCKED_PATTERNS = [
                /google-analytics\.com/, /googletagmanager\.com/, /googletagservices\.com/,
                /googlesyndication\.com\/pagead/, /doubleclick\.net/,
                /facebook\.com\/tr\b/, /connect\.facebook\.net/,
                /static\.ads-twitter\.com/, /t\.co\/i\/adsct/,
                /snap\.licdn\.com/, /px\.ads\.linkedin\.com/,
                /hotjar\.com/, /api\.mixpanel\.com/, /api\.amplitude\.com/,
                /api\.segment\.io/, /cdn\.segment\.com/, /heapanalytics\.com/,
                /fullstory\.com/, /static\.getclicky\.com/, /quantserve\.com/,
                /scorecardresearch\.com/, /outbrain\.com\/paid/, /trc\.taboola\.com/,
                /\/beacon(\b|\.)/, /\/pixel(\b|\.)/, /\/collect(\?|$)/, /\/analytics(\?|$)/
            ];

            // 1. Layer 1: Clean Tracking Parameters
            this.cleanCurrentURL();
            this.on(win, 'perfx-route', () => this.cleanCurrentURL());

            // 2. Layer 4: Clean Search Engine Links
            this.on(document, 'mousedown', (e) => {
                const anchor = e.target.closest('a[href]');
                if (anchor) this.unwrapSearchLink(anchor);
            }, true); // use capture phase

            onReady(() => {
                document.querySelectorAll('a[href]').forEach(a => this.unwrapSearchLink(a));
            });

            // 3. Skip Layers 2 & 3 in Safe Mode to prevent breaking critical sites
            if (isSafeMode) {
                log('PrivacyAssistant: Safe Mode active. Spoofing and Network Blocking disabled.');
                return;
            }

            // 4. Layer 2: Fingerprint Spoofing
            this.spoofFingerprint();

            // 5. Layer 3: Network Request Blocking
            this.patchNetwork();
            this.observeBeacons();
        }

        cleanURL(urlStr) {
            let url;
            try { url = new URL(urlStr); } catch { return urlStr; }

            let stripped = 0;
            this.TRACKING_PARAMS.forEach(p => {
                if (url.searchParams.has(p)) {
                    url.searchParams.delete(p);
                    stripped++;
                }
            });

            for (const key of [...url.searchParams.keys()]) {
                if (key.startsWith('utm_')) {
                    url.searchParams.delete(key);
                    stripped++;
                }
            }

            this.stats.strippedParams += stripped;
            return stripped > 0 ? url.toString() : urlStr;
        }

        cleanCurrentURL() {
            const cleaned = this.cleanURL(win.location.href);
            if (cleaned !== win.location.href) {
                history.replaceState(null, '', cleaned);
            }
        }

        isBlocked(url) {
            if (!url) return false;
            return this.BLOCKED_PATTERNS.some(p => p.test(url));
        }

        defineOverride(obj, prop, value) {
            try {
                Object.defineProperty(obj, prop, {
                    get: () => value,
                    configurable: false,
                });
            } catch (_) {}
        }

        spoofFingerprint() {
            // 2a. Canvas
            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (...args) {
                const ctx = this.getContext('2d');
                if (ctx) {
                    const imageData = ctx.getImageData(0, 0, 1, 1);
                    imageData.data[3] = imageData.data[3] === 0 ? 1 : 0;
                    ctx.putImageData(imageData, 0, 0);
                }
                return origToDataURL.apply(this, args);
            };

            const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function (...args) {
                const data = origGetImageData.apply(this, args);
                data.data[3] ^= 1;
                return data;
            };

            // 2b. WebGL
            const getParam = WebGLRenderingContext.prototype.getParameter;
            WebGLRenderingContext.prototype.getParameter = function (param) {
                if (param === 37445) return 'Intel Inc.';
                if (param === 37446) return 'Intel Iris OpenGL';
                return getParam.call(this, param);
            };
            if (typeof WebGL2RenderingContext !== 'undefined') {
                const getParam2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function (param) {
                    if (param === 37445) return 'Intel Inc.';
                    if (param === 37446) return 'Intel Iris OpenGL';
                    return getParam2.call(this, param);
                };
            }

            // 2c. AudioContext
            if (typeof AudioBuffer !== 'undefined') {
                const origGetChannelData = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function (...args) {
                    const data = origGetChannelData.apply(this, args);
                    if (data.length > 0) data[0] += 0.0000001 * (Math.random() - 0.5);
                    return data;
                };
            }

            // 2d. Navigator
            this.defineOverride(Navigator.prototype, 'hardwareConcurrency', 4);
            this.defineOverride(Navigator.prototype, 'deviceMemory', 8);
            try {
                Object.defineProperty(Navigator.prototype, 'plugins', {
                    get: () => ({ length: 3 }),
                    configurable: false,
                });
            } catch (_) {}
            this.defineOverride(Navigator.prototype, 'languages', ['en-GB']);

            // 2e. Screen
            const W = Math.round(screen.width  / 100) * 100 || 1920;
            const H = Math.round(screen.height / 100) * 100 || 1080;
            this.defineOverride(Screen.prototype, 'width', W);
            this.defineOverride(Screen.prototype, 'height', H);
            this.defineOverride(Screen.prototype, 'availWidth', W);
            this.defineOverride(Screen.prototype, 'availHeight', H);
            this.defineOverride(Screen.prototype, 'colorDepth', 24);
            this.defineOverride(Screen.prototype, 'pixelDepth', 24);
        }

        patchNetwork() {
            const self = this;
            
            // XHR
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                if (self.isBlocked(url)) {
                    self.stats.blockedRequests++;
                    return origOpen.call(this, method, 'about:blank', ...rest);
                }
                return origOpen.call(this, method, url, ...rest);
            };

            // Fetch
            const origFetch = win.fetch;
            win.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
                if (self.isBlocked(url)) {
                    self.stats.blockedRequests++;
                    return Promise.resolve(new Response('', { status: 200 }));
                }
                return origFetch.apply(this, arguments);
            };
        }

        observeBeacons() {
            this.beaconObs = new MutationObserver(mutations => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== 1) continue;
                        const tag = node.tagName;
                        const src = node.src || node.href || '';
                        if ((tag === 'SCRIPT' || tag === 'IMG' || tag === 'IFRAME') && this.isBlocked(src)) {
                            node.remove();
                            this.stats.blockedRequests++;
                        }
                    }
                }
            });
            onReady(() => {
                this.beaconObs.observe(document.documentElement, { childList: true, subtree: true });
            });
        }

        unwrapSearchLink(anchor) {
            const href = anchor.href || '';

            // Google
            if (/\bgoogle\.[a-z.]+\/url\b/.test(href)) {
                try {
                    const u = new URL(href);
                    const dest = u.searchParams.get('q') || u.searchParams.get('url');
                    if (dest) { anchor.href = dest; this.stats.cleanedLinks++; }
                } catch (_) {}
                return;
            }

            // Bing
            if (/\bbing\.com\//.test(href)) {
                const real = anchor.getAttribute('data-href');
                if (real) { anchor.href = real; this.stats.cleanedLinks++; }
                return;
            }

            // Yahoo
            if (/\bsearch\.yahoo\.com\//.test(href)) {
                try {
                    const u = new URL(href);
                    const dest = u.searchParams.get('url');
                    if (dest) { anchor.href = decodeURIComponent(dest); this.stats.cleanedLinks++; }
                } catch (_) {}
                return;
            }

            // DuckDuckGo
            if (/\bduckduckgo\.com\//.test(href)) {
                const cleaned = this.cleanURL(href);
                if (cleaned !== href) { anchor.href = cleaned; this.stats.cleanedLinks++; }
            }
        }
        
        destroy() {
            super.destroy();
            if (this.beaconObs) this.beaconObs.disconnect();
        }
    }

    // Module Init Wrap
    onPageActivated(() => {
        [
            new WebRTCGuard(),
            new EventPassivator(),
            new CodecOptimizer(),
            new DomWatcher(),
            new NetworkAssistant(),
            new PrivacyAssistant() // ✅ 새로 병합된 프라이버시 모듈
        ].forEach(m => m.safeInit ? m.safeInit() : (m.init && m.init()));

        if (debug) log(`PerfX v81.4 Ready with Privacy Shield`);
    });

})();
