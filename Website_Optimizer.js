// ==UserScript==
// @name        Web 성능 최적화 (v81.2 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     81.2.0-KR-ULTRA-Infinity-Autonomous
// @description [Ultimate] 끝없는 최적화 + Autonomous (WebRTC Guard, Full LCP Inference, Smart Shield, True LRU)
// @author      KiwiFruit
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

    // [Safe Storage Wrapper with True LRU & Memory Cache]
    const S = {
        _idxCache: null,
        _idxDirty: false,
        _idxTimer: null,

        get(k) {
            try {
                const v = localStorage.getItem(k);
                if (v !== null) this._trackKey(k); // ✅ Read Tracking
                return v;
            } catch { return null; }
        },
        set(k, v) {
            try {
                localStorage.setItem(k, v);
                this._trackKey(k);
            } catch {}
        },
        remove(k) { try { localStorage.removeItem(k); } catch {} },

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

                this._idxDirty = true;
                if (!this._idxTimer) {
                    this._idxTimer = setTimeout(() => {
                        this._idxTimer = null;
                        if (!this._idxDirty) return;
                        this._idxDirty = false;
                        try { localStorage.setItem('PerfX_IDX', JSON.stringify(this._idxCache || [])); } catch {}
                    }, 250);
                }
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
    const safeJsonParse = (str) => { try { return JSON.parse(str) || {}; } catch { return {}; } };

    const onReady = (cb) => {
        if (document.readyState !== 'loading') cb();
        else win.addEventListener('DOMContentLoaded', cb, { once: true });
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

    // ✅ Event Bus (단순화 및 EventTarget 호환)
    const Bus = {
        on(name, fn, target = win) {
            target.addEventListener(name, fn);
        },
        emit(name, detail) { 
            win.dispatchEvent(new CustomEvent(name, { detail })); 
        }
    };

    // ✅ BaseModule with AbortController for clean event management
    class BaseModule {
        constructor() {
            this._ac = new AbortController();
        }
        on(target, type, listener, options) {
            if (!target || !target.addEventListener) return;
            const opts = (typeof options === 'object' && options !== null)
                ? { ...options, signal: this._ac.signal }
                : { capture: options === true, signal: this._ac.signal };
            target.addEventListener(type, listener, opts);
        }
        destroy() {
            try { this._ac.abort(); } catch {}
        }
        safeInit() {
            try { this.init(); } catch (e) { log('Module Error', e); }
        }
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
        allowIframe: false, rtcGuard: false, downgradeLevel: 0 // ✅ WebRTCGuard 기본 OFF
    };

    const API = {
        profile: () => {}, toggleConfig: () => {}, toggleSessionSafe: () => {},
        shutdownMemory: () => {}, restartMemory: () => {}, resetAll: () => {}, showStatus: () => {}
    };

    // ✅ Modern Scheduler (postTask/yield 우선, fallback 유지)
    const scheduler = {
        request(cb, timeout = 200, priority = 'background') {
            if (win.scheduler?.postTask) {
                const ctrl = new AbortController();
                const promise = win.scheduler.postTask(() => cb(), { delay: timeout, priority, signal: ctrl.signal });
                return { kind: 'postTask', ctrl, promise };
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
            if (win.scheduler?.yield) {
                try { await win.scheduler.yield(); return; } catch {}
            }
            if (win.scheduler?.postTask) {
                try { await win.scheduler.postTask(() => {}, { priority }); return; } catch {}
            }
            await new Promise(r => setTimeout(r, 0));
        }
    };

    // ✅ Robust Chunk Scan Utility (Yield 지원)
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
    const SAN_KEYS = ['autoDowngraded', '_restore', 'downgradeReason'];
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
    const ITEM_SEL = '[role="article"], [data-perfx-item], article, .item, .post'; // ✅ 최적화 (li, section 제거)
    const SUPPORTED_TYPES = new Set(typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes || []) : []);

    // [Config & State]
    const hostname = win.location.hostname.toLowerCase();

    // Dynamic Keys
    const getLcpKey = () => `PerfX_LCP_${hostname}:${getPathBucket()}`;
    const getInteractiveKey = () => `perfx-interactive:${hostname}:${getPathBucket()}`;
    const getProfileKey = () => `PerfX_PROFILE_${hostname}`;

    let LCP_KEY = getLcpKey();
    let INTERACTIVE_KEY = getInteractiveKey();

    // Runtime Configuration
    let RuntimeConfig = {};

    const Env = {
        storageKey: `PerfX_ULTRA_${hostname}`,
        getOverrides() { return safeJsonParse(S.get(this.storageKey)); },
        saveOverrides(data) {
            const safeData = sanitizeConfig(data);
            S.set(this.storageKey, JSON.stringify(safeData));
            RuntimeConfig = { ...RuntimeConfig, ...data };
        }
    };

    // Init Config
    RuntimeConfig = Env.getOverrides();
    const debug = !!RuntimeConfig.debug;
    const log = (...args) => debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    // ✅ Hoisted Interactive Check (TDZ Safe)
    const applyInteractiveMemory = () => {
        const isInteractiveStored = safeJsonParse(S.get(INTERACTIVE_KEY));
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

        // Auto-Downgrade Profile Check
        const forcedProfile = safeJsonParse(S.get(getProfileKey()));
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
                location.reload();
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
                        location.reload();
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

    // Global Detection & Flags
    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = hostEndsWithAny(hostname, [...LISTS.BANKS_KR, ...LISTS.GOV_KR]) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = hostEndsWithAny(hostname, LISTS.HEAVY_FEEDS);
    const isVideoSite = hostEndsWithAny(hostname, LISTS.OTT_KR);
    const isSafeMode = isCritical || RuntimeConfig._sessionSafe;

    // [Power State]
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
    const triggerRefresh = () => refreshPerfState();
    win.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(triggerRefresh, 200); });
    navigator.connection?.addEventListener?.('change', refreshPerfState);
    computeState();

    // ==========================================
    // 1. Populate Config & API
    // ==========================================
    const Q_KEY = `perfx-quarantine:${hostname}`;
    let Q_CACHE = null;

    const checkQuarantine = (now = Date.now()) => {
        if (Q_CACHE && (now - Q_CACHE.ts) < DAY) return Q_CACHE;
        const q = safeJsonParse(S.get(Q_KEY));
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
        rtcGuard: RuntimeConfig.rtcGuard ?? false, // ✅ WebRTCGuard 기본 OFF
        downgradeLevel: RuntimeConfig.downgradeLevel || 0
    };

    if (isSafeMode) {
        Object.assign(calculatedConfig, { codecMode: 'off', passive: false, gpu: false, memory: false, rtcGuard: false, allowIframe: true });
    }

    Object.assign(Config, calculatedConfig);
    applyPowerPolicy();

    Object.assign(API, {
        profile: (mode) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed, rtcGuard: false }, // ✅ 기본 OFF
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed, rtcGuard: false },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false, rtcGuard: false }
            };
            const p = presets[mode] || presets.balanced;
            const current = Env.getOverrides();
            S.remove(Q_KEY); Q_CACHE = null;
            Env.saveOverrides({ ...current, ...p, disabled: false });
            location.reload();
        },
        toggleConfig: (key) => {
            const c = Env.getOverrides();
            c[key] = !c[key];
            Env.saveOverrides(c);
            location.reload();
        },
        toggleSessionSafe: () => {
             if (sessionStorage.getItem(SESSION_OFF_KEY)) sessionStorage.removeItem(SESSION_OFF_KEY);
             else sessionStorage.setItem(SESSION_OFF_KEY, '1');
             location.reload();
        },
        resetAll: () => {
            S.clearPrefix(['PerfX_', 'perfx-', 'PerfX_IDX']);
            location.reload();
        },
        showStatus: () => {
            const info = `[PerfX v81.2]\nURL: ${getPathBucket()}\nMode: ${RuntimeConfig._sessionSafe ? 'SAFE' : 'ACTIVE'}\nPower: ${perfState.isLowPowerMode ? 'LOW' : 'HIGH'}\nCaps: DOM=${perfState.DOM_CAP}, MEDIA=${perfState.MEDIA_CAP}\nQuarantine: ${Q_CACHE ? 'YES' : 'NO'}\nRTC: ${Config.rtcGuard ? 'ON' : 'OFF'}\nModules: P=${Config.passive} M=${Config.memory} G=${Config.gpu} C=${Config.codecMode}`;
            if (typeof GM_notification !== 'undefined') GM_notification({ title: 'PerfX Status', text: info, timeout: 5000 });
            else console.log(info);
        }
    });

    // SPA Route Listener
    let lastKey = LCP_KEY;
    let lastRouteSignal = 0;

    // ✅ SPA Hero Inference (Chunked)
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
                    Bus.emit('perfx-lcp-update', { url: nUrl }); // ✅ 캐시 업데이트 신호
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
        const origPush = history.pushState;
        history.pushState = function() { origPush.apply(this, arguments); onRoute(); };
        const origRep = history.replaceState;
        history.replaceState = function() { origRep.apply(this, arguments); onRoute(); };
        win.addEventListener('popstate', onRoute);
        win.addEventListener('hashchange', onRoute);
        win.addEventListener('pageshow', (e) => { if(e.persisted) Bus.emit('perfx-route', { force: true }); });
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        if (RuntimeConfig.disabled) {
            GM_registerMenuCommand(`✅ 최적화 켜기`, () => API.toggleConfig('disabled'));
        } else {
            GM_registerMenuCommand(`🚫 끄기 (영구)`, () => API.toggleConfig('disabled'));
            GM_registerMenuCommand(`⏸ 이번 세션만 끄기`, API.toggleSessionSafe);
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

    if (debug) win.perfx = { version: '81.2.0', config: Config, ...API };

    // ==========================================
    // 2. Autonomous V28
    // ==========================================
    if (SUPPORTED_TYPES.size > 0 && !RuntimeConfig._sessionSafe) {
        try {
            let clsTotal = 0, loadTotal = 0;
            let lastCls = 0, lastLoad = 0;
            let recoveryStreak = 0;

            if (SUPPORTED_TYPES.has('layout-shift')) { new PerformanceObserver((l)=> { for(const e of l.getEntries()) if(!e.hadRecentInput) clsTotal+=e.value; }).observe({type:'layout-shift',buffered:true}); }
            if (SUPPORTED_TYPES.has('longtask')) { new PerformanceObserver((l)=> { loadTotal+=l.getEntries().length; }).observe({type:'longtask',buffered:true}); }

            if (SUPPORTED_TYPES.has('largest-contentful-paint')) {
                new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    if (entries.length > 0) {
                        const lcp = entries[entries.length - 1];
                        const url = lcp.url || lcp.element?.src || lcp.element?.currentSrc;
                        if (url) {
                            const currentLCP = normUrl(url);
                            if (currentLCP !== RuntimeConfig._lcp) {
                                RuntimeConfig._lcp = currentLCP;
                                schedulePersistLCP();
                                Bus.emit('perfx-lcp-update', { url: currentLCP }); // ✅ 캐시 업데이트 신호
                            }
                        }
                    }
                }).observe({type: 'largest-contentful-paint', buffered: true});
            }

            let healthTimer = null;
            let hasVideoCache = null, hasVideoTs = 0;
            const hasVideo = () => {
                const t = Date.now();
                if (hasVideoCache !== null && (t - hasVideoTs) < 30000) return hasVideoCache;
                hasVideoCache = !!document.querySelector('video, source[type*="video"]');
                hasVideoTs = t;
                return hasVideoCache;
            };

            const checkHealth = () => {
                if (document.hidden) return;
                const clsDelta = clsTotal - lastCls;
                const loadDelta = loadTotal - lastLoad;
                lastCls = clsTotal; lastLoad = loadTotal;

                const c = RuntimeConfig;
                const currentLevel = c.downgradeLevel || 0;
                const TH = {
                    L1_CLS: 0.05 * perfState.perfMultiplier,
                    L2_CLS: 0.2 * perfState.perfMultiplier,
                    L2_LOAD: 15 * perfState.perfMultiplier
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
                    return;
                }

                // L2
                if ((clsDelta > TH.L2_CLS || loadDelta > TH.L2_LOAD) && currentLevel < 2) {
                    if (!c._restore) c._restore = { ...Config };
                    c.downgradeLevel = 2;
                    c.downgradeReason = { cls: clsDelta, load: loadDelta };
                    c.gpu = false; c.memory = false; c.codecMode = 'soft';
                    c.downgradeCount = (c.downgradeCount || 0) + 1;
                    c.unstableTs = now;
                    Env.saveOverrides(c);
                    Object.assign(Config, {gpu:false, memory:false});
                    API.shutdownMemory();
                    log(`Downgrade L2`);
                    recoveryStreak = 0;
                }
                // Recovery
                else if (currentLevel > 0 && clsDelta < 0.01 && loadDelta < 1) {
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
                        delete c.downgradeLevel; delete c.autoDowngraded; delete c.downgradeReason;
                        Env.saveOverrides(c);
                        Bus.emit('perfx-config');
                        log('Restored');
                        recoveryStreak = 0;
                    }
                } else {
                    recoveryStreak = 0;
                }
                healthTimer = setTimeout(checkHealth, 5000);
            };

            const startLoop = () => { if (!healthTimer) checkHealth(); };
            const stopLoop = () => { if (healthTimer) clearTimeout(healthTimer); healthTimer = null; };
            Bus.on('visibilitychange', () => {
                if (document.hidden) { stopLoop(); persistLCP(); }
                else startLoop();
            }, document);
            win.addEventListener('pagehide', persistLCP);
            startLoop();
        } catch(e) {}
    }

    // ==========================================
    // 3. Core Modules
    // ==========================================

    // [Core 0] WebRTC Guard (Grid Defense)
    class WebRTCGuard extends BaseModule {
        init() {
            if (!Config.rtcGuard || isSafeMode) return;
            if (hostEndsWithAny(hostname, LISTS.RTC_ALLOW)) return;

            const origPeer = win.RTCPeerConnection || win.webkitRTCPeerConnection || win.mozRTCPeerConnection;
            if (!origPeer) return;

            const proxiedPeer = function(config, constraints) {
                const pc = new origPeer(config, constraints);
                pc.createDataChannel = function() {
                    throw new DOMException('RTCDataChannel blocked by PerfX policy', 'NotAllowedError'); // ✅ 예외 발생 (1-4)
                };
                return pc;
            };
            proxiedPeer.prototype = origPeer.prototype;
            if (win.RTCPeerConnection) win.RTCPeerConnection = proxiedPeer;
            if (win.webkitRTCPeerConnection) win.webkitRTCPeerConnection = proxiedPeer;
            if (win.mozRTCPeerConnection) win.mozRTCPeerConnection = proxiedPeer;
        }
    }

    // [Core 1] EventPassivator v5.3 (단순화 및 Opt-out 추가)
    class EventPassivator extends BaseModule {
        init() {
            if (win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            let passiveArmed = false;
            setTimeout(() => { passiveArmed = true; }, 1500);

            const isTopLevelTarget = (t) => t === win || t === document || t === document.body || t === document.documentElement;
            const PASSIVE_OPT_OUT_SEL = '[data-perfx-no-passive], .mapboxgl-map, .leaflet-container, .monaco-editor, .CodeMirror, canvas'; // ✅ (3-2)
            const FORCE_PASSIVE_TYPES = new Set(['wheel', 'mousewheel']); // ✅ (3-4) touchmove는 기본 보수적 유지

            const shouldSkipPassivePatch = (target) => {
                try { return !!(target && target instanceof Element && target.closest?.(PASSIVE_OPT_OUT_SEL)); } catch { return false; }
            };

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);
            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (!Config.passive || !passiveArmed) return origAdd.call(this, type, listener, options);

                    if (FORCE_PASSIVE_TYPES.has(type)) {
                        if (!isTopLevelTarget(this) && shouldSkipPassivePatch(this)) {
                            return origAdd.call(this, type, listener, options);
                        }

                        const isObj = typeof options === 'object' && options !== null;
                        if (!isObj || options.passive === undefined) {
                            try {
                                const finalOptions = isObj ? { ...options, passive: true } : { capture: options === true, passive: true };
                                return origAdd.call(this, type, listener, finalOptions);
                            } catch {}
                        }
                    }
                    return origAdd.call(this, type, listener, options);
                };
            });
        }
    }

    // [Core 2] CodecOptimizer v2.7 (effectiveCodecMode & MediaCapabilities)
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off' || isVideoSite) return;

            const requestedCodecMode = Config.codecMode; // ✅ 사용자 설정 보존 (1-3)
            let effectiveCodecMode = requestedCodecMode;
            if (!perfState.isLowPowerMode && requestedCodecMode === 'hard') {
                effectiveCodecMode = 'soft'; // 실행 시점 유효값만 변경
            }

            setTimeout(() => {
                if (document.querySelector('video, source[type*="video"]') && effectiveCodecMode === 'hard') {
                    effectiveCodecMode = 'soft';
                }
            }, 800);

            // ✅ MediaCapabilities 정책 보조 (2-2)
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
                        return false; // 기기가 충분히 원활하게 돌린다면 허용
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

    // [Core 3] DomWatcher v4.3 (CIS Auto Fallback)
    class DomWatcher extends BaseModule {
        init() {
            if (isSafeMode) return;
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            this.supportsCISAuto = !!(win.CSS?.supports?.('contain-intrinsic-size', 'auto 1px auto 1px')); // ✅ (2-3)

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

            this.on(win, 'perfx-power-change', () => { // ✅ BaseModule this.on 적용 (3-1)
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
            this.on(win, 'perfx-config', () => { API.shutdownMemory(); API.restartMemory(); });
            this.on(win, 'perfx-route', () => { API.shutdownMemory(); API.restartMemory(); });
        }

        // ✅ Opt-out 및 예외 처리 강화 (3-2)
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
            if (this.supportsCISAuto) { // ✅ CIS auto fallback (2-3)
                el.style.containIntrinsicSize = `auto ${Math.max(1, w)}px auto ${Math.max(1, h)}px`;
            } else {
                el.style.containIntrinsicSize = `${Math.max(1, w)}px ${Math.max(1, h)}px`;
            }
            el.style.contain = 'layout paint';
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
                    const items = queryFeedItems(root); // ✅ fallback li (4-2)
                    scanInChunks(items, 50, perfState.SCAN_STEP, this.observeSafe);
                }
            }
        }

        startMO() {
            if (!Config.memory) return;
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

    // [Core 4] NetworkAssistant v4.3
    class NetworkAssistant extends BaseModule {
        init() {
            if (isSafeMode) return;

            const nearSet = new WeakMap();
            const farSet = new WeakMap();
            const distMap = new WeakMap();
            const observing = new Set();
            let imgSlots = 0, vidSlots = 0;
            let MAX_IMG = 0, MAX_VID = 0;
            let vpObs = null;
            let currentGen = 0;

            const batchQueue = new Map();
            let batchTimer = null;

            let lcpUrlCached = RuntimeConfig._lcp || S.get(LCP_KEY) || null; // ✅ LCP URL 캐시 (3-3)

            let protectTimer = null;
            let isProtectionPhase = false; // ✅ 섀도잉 픽스 (1-1)

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

            const setImgLazy = (img, setPriority = true) => { // ✅ fetchPriority 보강 픽스 (1-2)
                if (!img || img.complete) return;
                const currentLoading = (img.getAttribute('loading') || '').toLowerCase();
                const currentFP = (img.getAttribute('fetchpriority') || '').toLowerCase();

                if (!currentLoading) img.loading = 'lazy';
                if (!img.hasAttribute('decoding')) img.decoding = 'async';
                
                if (setPriority && currentFP !== 'high') {
                    try {
                        if ('fetchPriority' in img) img.fetchPriority = 'low';
                        else if (!img.hasAttribute('fetchpriority')) img.setAttribute('fetchpriority', 'low');
                    } catch {
                        if (!img.hasAttribute('fetchpriority')) img.setAttribute('fetchpriority', 'low');
                    }
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
                            nearSet.set(el, currentGen);
                        } else {
                            farSet.set(el, currentGen);
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

            this.on(document, 'visibilitychange', () => {
                if (document.hidden) {
                    if (batchTimer) { scheduler.cancel(batchTimer); batchTimer = null; }
                    if (this.mo) this.mo.disconnect();
                } else {
                    startProtection(false);
                    if (this.mo) this.mo.observe(document.documentElement, { childList: true, subtree: true });
                }
            });

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
                if (img.hasAttribute('loading') && img.hasAttribute('fetchpriority')) return;
                
                if (lcpUrlCached) { // ✅ LCP 캐시 사용 (3-3)
                    const cur = normUrl(img.currentSrc || img.src);
                    if (cur === lcpUrlCached) { 
                        img.loading = 'eager'; 
                        if ('fetchPriority' in img) img.fetchPriority = 'high';
                        else img.setAttribute('fetchpriority', 'high'); 
                        return; 
                    }
                }

                if (fromMutation && !isProtectionPhase) {
                    if (imgSlots < MAX_IMG) { safeObserve(img); return; }
                    setImgLazy(img);
                    return;
                }

                if (nearSet.get(img) === currentGen) return;
                if (farSet.get(img) === currentGen) { setImgLazy(img); return; }

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

            this.on(win, 'pagehide', (e) => {
                if (!e.persisted && vpObs) vpObs.disconnect();
            });
        }
    }

    // Module Init
    [
        new WebRTCGuard(), // ✅ (1-4에 따라 로딩은 하되 내부 정책으로 기본 OFF 처리됨)
        new EventPassivator(),
        new CodecOptimizer(),
        new DomWatcher(),
        new NetworkAssistant()
    ].forEach(m => m.safeInit ? m.safeInit() : (m.init && m.init()));

    if (debug) log(`PerfX v81.2 Ready`);

})();
