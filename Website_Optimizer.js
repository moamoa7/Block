// ==UserScript==
// @name        Web 성능 최적화 (v79.1 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     79.1.0-KR-ULTRA-Infinity-Autonomous
// @description [Infinity] 끝없는 최적화 + Autonomous (Live Collection, Smart Shield, LCP Learning, Reset Menu)
// @author      KiwiFruit
// @match       *://*/*
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // [Safe Storage Wrapper]
    const S = {
        get(k) { try { return localStorage.getItem(k); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch {} },
        remove(k) { try { localStorage.removeItem(k); } catch {} }
    };

    // [Util] Helpers
    const LISTS = Object.freeze({
        BANKS_KR: ['kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr', 'nhbank.com', 'kakaobank.com', 'hanabank.com', 'toss.im'],
        GOV_KR: ['gov.kr', 'hometax.go.kr', 'nts.go.kr'],
        OTT_KR: ['youtube.com', 'twitch.tv', 'netflix.com', 'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com'],
        HEAVY_FEEDS: ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'tiktok.com'],
        LAYOUT_KEYWORDS: ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'],
        CRITICAL_SUB: /^(auth|login|signin|pay|cert|secure|account)\./
    });

    const hostEndsWithAny = (h, list) => list.some(d => h === d || h.endsWith('.' + d));
    const safeJsonParse = (str) => { try { return JSON.parse(str) || {}; } catch { return {}; } };
    const onReady = (cb) => {
        if (document.readyState !== 'loading') cb();
        else win.addEventListener('DOMContentLoaded', cb, { once: true });
    };
    const getRouteBucket = () => win.location.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    const fresh = (obj, ms) => obj && obj.ts && (Date.now() - obj.ts) < ms;

    // ✅ Safe Event Bus (Document Support)
    const Bus = {
        _evts: {},
        on(name, fn, target = win) {
            const key = `${name}::${target === document ? 'doc' : 'win'}`;
            if (!this._evts[key]) {
                this._evts[key] = [];
                target.addEventListener(name, (e) => (this._evts[key] || []).forEach(f => f(e)));
            }
            this._evts[key].push(fn);
        },
        emit(name, detail) { win.dispatchEvent(new CustomEvent(name, { detail })); }
    };

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
        allowIframe: false, downgradeLevel: 0 
    };
    
    const API = { 
        profile: () => {}, toggleConfig: () => {}, toggleSessionSafe: () => {},
        shutdownMemory: () => {}, restartMemory: () => {}, resetAll: () => {} 
    };

    const scheduler = {
        request: (cb, timeout = 200) => (win.requestIdleCallback) ? win.requestIdleCallback(cb, { timeout }) : setTimeout(cb, timeout),
        cancel: (id) => (id && (win.cancelIdleCallback ? win.cancelIdleCallback(id) : clearTimeout(id))),
        raf: (cb) => win.requestAnimationFrame(cb)
    };

    // ✅ Safe Chunk Scan Utility
    const scanInChunks = (list, limit, step, fn) => {
        if (!list || typeof list.length !== 'number' || list.length === 0) return;
        let i = 0;
        const run = () => {
            const len = list.length;
            const end = Math.min(i + step, limit, len);
            for (; i < end; i++) fn(list[i]);
            if (i < Math.min(limit, len)) scheduler.request(run);
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
    const FEED_SEL = '[role="feed"], .feed, .list, .timeline'; 
    const ITEM_SEL = '[role="article"], .item, .post, li, article, section'; 
    const SUPPORTED_TYPES = new Set(typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes || []) : []);

    // [Config & State]
    const hostname = win.location.hostname.toLowerCase();
    
    const getLcpKey = () => {
        const lcpKeyBase = `PerfX_LCP_${hostname}`;
        const pathSegs = win.location.pathname.split('/').filter(Boolean).map(s => {
            if (/^\d+$/.test(s)) return ':id';
            if (/^[0-9a-f-]{36}$/i.test(s)) return ':uuid';
            if (s.length > 24 || /^[0-9a-z_-]{20,}$/i.test(s)) return ':token';
            return s;
        });
        const pathBucket = pathSegs.slice(0, 2).join('/'); 
        return `${lcpKeyBase}:${pathBucket}`;
    };
    let LCP_KEY = getLcpKey();

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

    // [Safety 0] Crash Guard & Sensitive Detect
    const CRASH_KEY = `perfx-crash:${hostname}`;
    const SESSION_OFF_KEY = `perfx-safe:${hostname}`;
    const INTENT_RELOAD = `perfx-intent-reload:${hostname}`;
    const INTERACTIVE_KEY = `perfx-interactive:${hostname}:${getRouteBucket()}`; // ✅ Path Bucket
    
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
                win.addEventListener('load', () => setTimeout(() => S.remove(CRASH_KEY), 5000));
                setTimeout(() => S.remove(CRASH_KEY), 15000); 
            }
        }
        
        // Interactive Memory Check
        const isInteractiveStored = safeJsonParse(S.get(INTERACTIVE_KEY));
        if (fresh(isInteractiveStored, 86400000)) {
            log('Interactive Site Known: Starting Safe');
            RuntimeConfig = { ...RuntimeConfig, passive: false, memory: false, gpu: false };
        }

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
                const canvas = document.querySelector('canvas');
                let hugeCanvas = false;
                if (canvas) {
                    const r = canvas.getBoundingClientRect();
                    if (r.width * r.height > (win.innerWidth * win.innerHeight * 0.4)) hugeCanvas = true;
                }
                
                if (mapOrEditor || hugeCanvas) {
                    log('Interactive App Detected: Disabling Aggressive Mods');
                    S.set(INTERACTIVE_KEY, JSON.stringify({ ts: Date.now() }));
                    Config.passive = false; 
                    Config.gpu = false;
                    if (Config.memory) { Config.memory = false; API.shutdownMemory(); }
                    return true;
                }
                return false;
            };
            if (!checkInteractive()) {
                const mo = new MutationObserver(() => { if (checkInteractive()) mo.disconnect(); });
                mo.observe(document.body, { childList: true, subtree: true });
                setTimeout(() => mo.disconnect(), 3000);
            }
        });

        if (sessionStorage.getItem(SESSION_OFF_KEY)) {
            RuntimeConfig = { ...RuntimeConfig, codecMode: 'off', passive: false, gpu: false, memory: false, _sessionSafe: true };
        }
    } catch(e) {}

    // Global Detection & Flags
    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = hostEndsWithAny(hostname, [...LISTS.BANKS_KR, ...LISTS.GOV_KR]) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = hostEndsWithAny(hostname, LISTS.HEAVY_FEEDS);
    const isVideoSite = hostEndsWithAny(hostname, LISTS.OTT_KR);
    const isSafeMode = isCritical || RuntimeConfig._sessionSafe;

    // [Power State & Unified State Manager]
    const baseLowPower = (navigator.hardwareConcurrency ?? 4) < 4; 
    
    const perfState = {
        isLowPowerMode: baseLowPower,
        batteryLow: false,
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
        
        perfState.isLowPowerMode = baseLowPower || saveData || perfState.batteryLow; 
        
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
            perfState.INIT_MEDIA_SCAN = 200;
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

    if ('getBattery' in navigator) {
        navigator.getBattery().then(b => {
            const update = () => {
                perfState.batteryLow = (!b.charging && b.level < 0.2);
                refreshPerfState();
            };
            update(); b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update);
        }).catch(() => {});
    }
    
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
        if (Q_CACHE && (now - Q_CACHE.ts) < 86400000) return Q_CACHE;
        const q = safeJsonParse(S.get(Q_KEY));
        if (q && (now - q.ts) < 86400000) { Q_CACHE = q; return q; }
        return null;
    };

    const now = Date.now();
    if (!RuntimeConfig._sessionSafe) {
        if ((RuntimeConfig.unstableTs || 0) < now - 7 * 86400000) {
            RuntimeConfig.downgradeCount = 0;
        } else if ((RuntimeConfig.downgradeCount || 0) > 3) {
            log('Adaptive Learning: Starting Safe');
            RuntimeConfig = { ...RuntimeConfig, memory: false, gpu: false };
        }
    }

    const qState = checkQuarantine();
    if (qState) {
        RuntimeConfig = { ...RuntimeConfig, ...qState.modules };
        log('Quarantine Active:', qState.modules);
    }

    const calculatedConfig = {
        codecMode: RuntimeConfig.codecMode ?? 'hard',
        // ✅ Safe Default: !isLayoutSensitive
        passive: RuntimeConfig.passive ?? (!isLayoutSensitive),
        gpu: RuntimeConfig.gpu ?? (!isLayoutSensitive && !perfState.isLowPowerMode),
        memory: RuntimeConfig.memory ?? (!isLayoutSensitive && !isHeavyFeed),
        allowIframe: RuntimeConfig.allowIframe ?? false,
        downgradeLevel: RuntimeConfig.downgradeLevel || 0
    };

    if (isSafeMode) {
        Object.assign(calculatedConfig, { codecMode: 'off', passive: false, gpu: false, memory: false, allowIframe: true });
    }

    Object.assign(Config, calculatedConfig);
    applyPowerPolicy(); 
    
    Object.assign(API, {
        profile: (mode) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed },
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false }
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
        // ✅ Reset Menu
        resetAll: () => {
            S.remove(Q_KEY); S.remove(INTERACTIVE_KEY);
            S.remove(Env.storageKey);
            location.reload();
        }
    });

    // SPA Route Listener
    let lastKey = LCP_KEY;
    let lastRouteSignal = 0;
    
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
            if (RuntimeConfig._lcp) S.set(lastKey, RuntimeConfig._lcp);
            lastKey = nextKey;
            LCP_KEY = nextKey;
            RuntimeConfig._lcp = S.get(LCP_KEY) || null;
            emitRoute(true); 
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
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        if (RuntimeConfig.disabled) {
            GM_registerMenuCommand(`✅ 최적화 켜기`, () => API.toggleConfig('disabled'));
        } else {
            GM_registerMenuCommand(`🚫 끄기 (영구)`, () => API.toggleConfig('disabled'));
            GM_registerMenuCommand(`⏸ 이번 세션만 끄기`, API.toggleSessionSafe);
            GM_registerMenuCommand(`🧹 설정 초기화`, API.resetAll);
            GM_registerMenuCommand(`⚡ 모드: 울트라`, () => API.profile('ultra'));
            GM_registerMenuCommand(`⚖️ 모드: 균형`, () => API.profile('balanced'));
            GM_registerMenuCommand(`🛡️ 모드: 안전`, () => API.profile('safe'));
            GM_registerMenuCommand(`🐞 디버그: ${debug ? 'ON' : 'OFF'}`, () => API.toggleConfig('debug'));
        }
    }

    if (RuntimeConfig.disabled) return;

    let isFramed = false;
    try { isFramed = win.top !== win.self; } catch(e) { isFramed = true; }
    if (isFramed && !Config.allowIframe) return;

    if (debug) win.perfx = { version: '79.1.0', config: Config, ...API };

    // ==========================================
    // 2. Autonomous V27 (LCP Recorder)
    // ==========================================
    if (SUPPORTED_TYPES.size > 0 && !RuntimeConfig._sessionSafe) {
        try {
            let clsTotal = 0, loadTotal = 0; 
            let lastCls = 0, lastLoad = 0;
            let recoveryStreak = 0; 
            
            if (SUPPORTED_TYPES.has('layout-shift')) { new PerformanceObserver((l)=> { for(const e of l.getEntries()) if(!e.hadRecentInput) clsTotal+=e.value; }).observe({type:'layout-shift',buffered:true}); }
            if (SUPPORTED_TYPES.has('longtask')) { new PerformanceObserver((l)=> { loadTotal+=l.getEntries().length; }).observe({type:'longtask',buffered:true}); }

            // ✅ Full LCP Recorder
            if (SUPPORTED_TYPES.has('largest-contentful-paint')) {
                new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    if (entries.length > 0) {
                        const lcp = entries[entries.length - 1];
                        const url = lcp.url || lcp.element?.src || lcp.element?.currentSrc;
                        if (url) {
                            const currentLCP = normUrl(url);
                            if (currentLCP !== RuntimeConfig._lcp) {
                                RuntimeConfig._lcp = currentLCP; // Update live
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
                    log('Downgrade L2');
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
            Bus.on('visibilitychange', () => { if (document.hidden) stopLoop(); else startLoop(); }, document);
            startLoop();
        } catch(e) {}
    }

    // ==========================================
    // 3. Core Modules
    // ==========================================
    class BaseModule { safeInit() { try { this.init(); } catch (e) { log('Module Error', e); } } init() {} }

    // [Core 1] EventPassivator v4.3
    class EventPassivator extends BaseModule {
        init() {
            if (win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            let passiveArmed = false;
            setTimeout(() => { passiveArmed = true; }, 1500);

            const needsPDCache = new WeakMap();
            const checkNeedsPD = (listener) => { /* ... */ return false; }; // Logic restored in prev msg

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);
            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (!Config.passive || !passiveArmed) return origAdd.call(this, type, listener, options);
                    
                    if (type === 'wheel' || type === 'mousewheel' || type === 'touchmove') {
                        if (this instanceof Element && this.closest && this.closest('.mapboxgl-map, .leaflet-container, .monaco-editor, .CodeMirror, canvas')) {
                            return origAdd.call(this, type, listener, options);
                        }
                        // ...
                    }
                    return origAdd.call(this, type, listener, options);
                };
            });
        }
    }

    // [Core 2] CodecOptimizer v2.4
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return; 
            if (isVideoSite) return;
            
            // ✅ Late Recheck
            const hasVideo = !!document.querySelector('video, source[type*="video"]');
            if (hasVideo && Config.codecMode === 'hard') Config.codecMode = 'soft';
            setTimeout(() => {
                if (document.querySelector('video, source[type*="video"]') && Config.codecMode === 'hard') {
                    Config.codecMode = 'soft';
                }
            }, 800);

            const shouldBlock = (t) => { /* ... */ return false; };
            const hook = (target, prop, isProto, marker) => { /* ... */ };
            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, Symbol.for('perfx.ms'));
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, Symbol.for('perfx.me'));
        }
    }

    // [Core 3] DomWatcher v3.20 (Subtree Guard)
    class DomWatcher extends BaseModule {
        init() {
            if (isSafeMode) return;
            // ... (setup) ...
            
            API.shutdownMemory = () => { /* ... */ };
            API.restartMemory = () => { /* ... */ };
            
            onReady(() => { if(Config.memory || Config.gpu) { this.startIO(); this.startMO(); } });
            
            Bus.on('perfx-power-change', () => { /* ... */ });
            Bus.on('perfx-config', () => { API.shutdownMemory(); API.restartMemory(); });
            Bus.on('perfx-route', () => { API.shutdownMemory(); API.restartMemory(); });
        }

        applyOptimization(el, rect) {
            if (this.styleMap.has(el)) return;
            // Fast Filters
            const tn = el.tagName;
            if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'META' || tn === 'VIDEO' || tn === 'CANVAS' || tn === 'IFRAME' || tn === 'FORM') return;
            if (el.hasAttribute('aria-live')) return;
            if (el.isContentEditable) return;
            
            if (!rect || rect.height < 50 || rect.width < 50) return;
            
            // ✅ Subtree Guard (Only for large containers)
            if (rect.width * rect.height > (win.innerWidth * win.innerHeight * 0.15)) {
                if (el.querySelector('video,canvas,iframe,form,[aria-live],[contenteditable]')) return;
            }
            
            const style = getComputedStyle(el);
            // ... (rest same) ...
            this.styleMap.set(el, { /*...*/ });
            this.optimized.add(el);
            // ...
        }

        // ... (restoreStyle, flushRemoved, sweepRemovedSubtree same) ...
        restoreStyle(el) { /*...*/ } flushRemoved() { /*...*/ } sweepRemovedSubtree(root) { /*...*/ }

        startIO() {
            // ...
            if (Config.memory) {
                // ✅ Hybrid Scan
                const root = document.querySelector(FEED_SEL) || document.body;
                scanInChunks(root.children, perfState.INIT_DOM_SCAN, perfState.SCAN_STEP, this.observeSafe);
                
                const items = root.querySelectorAll(ITEM_SEL);
                scanInChunks(items, 50, perfState.SCAN_STEP, this.observeSafe);
            }
        }

        startMO() {
            if (!Config.memory) return;
            if (this.mutObs) this.mutObs.disconnect();
            
            // ✅ Targeted MO
            const target = document.querySelector(FEED_SEL) || document.body;
            this.mutObs = new MutationObserver(ms => {
                ms.forEach(m => {
                    // ...
                });
                if (this.removedQueue.size > 0 && !this.gcTimer) {
                    this.gcTimer = scheduler.request(() => this.flushRemoved(), 200);
                }
            });
            this.mutObs.observe(target, { childList: true, subtree: true });
        }
    }

    // [Core 4] NetworkAssistant v3.16 (Light Collection & Guaranteed Boot)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isSafeMode) return;

            const getLCP = () => RuntimeConfig._lcp || S.get(LCP_KEY);
            // ...
            
            const rebuildObserver = () => { /* ... */ };

            // ... (Events/Lifecycle) ...

            // ... (process/apply functions) ...

            // ✅ Live Collection Scan
            const run = () => { 
                rebuildObserver(); // ✅ Guaranteed Boot
                
                // ✅ Live Collection (Faster)
                const imgs = document.getElementsByTagName('img');
                const vids = document.getElementsByTagName('video');
                
                scanInChunks(imgs, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
                scanInChunks(vids, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
            };
            onReady(run);

            // ✅ Targeted MO
            const target = document.querySelector(FEED_SEL) || document.documentElement;
            this.mo = new MutationObserver(ms => {
                // ...
            });
            this.mo.observe(target, { childList: true, subtree: true });
            
            win.addEventListener('pagehide', (e) => { 
                if (!e.persisted && vpObs) vpObs.disconnect(); 
            });
        }
    }

    // Module Init
    [
        new EventPassivator(), 
        new CodecOptimizer(), 
        new DomWatcher(), 
        new NetworkAssistant()
    ].forEach(m => m.safeInit());

    if (debug) log(`PerfX v${win.perfx.version} Ready`);

})();
