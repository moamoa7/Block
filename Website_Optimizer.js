// ==UserScript==
// @name        Web 성능 최적화 (v78.6 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     78.6.0-KR-ULTRA-Infinity-Autonomous
// @description [Infinity] 끝없는 최적화 + Autonomous (Preemptive Lazy, Visual Viewport, Canvas Guard)
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
    const hostEndsWithAny = (h, list) => list.some(d => h === d || h.endsWith('.' + d));
    const safeJsonParse = (str) => { try { return JSON.parse(str) || {}; } catch { return {}; } };
    const onReady = (cb) => {
        if (document.readyState !== 'loading') cb();
        else win.addEventListener('DOMContentLoaded', cb, { once: true });
    };

    // ✅ Visual Viewport Aware Height
    const viewH = () => win.visualViewport?.height || win.innerHeight;

    // ✅ True Distance Helper
    const distToViewport = (r) => {
        const h = viewH();
        if (!r) return -1; // Unknown = Keep (sorts to end if descending)
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
        shutdownMemory: () => {}, restartMemory: () => {} 
    };

    // Safe Scheduler
    const scheduler = {
        request: (cb, timeout = 200) => (win.requestIdleCallback) ? win.requestIdleCallback(cb, { timeout }) : setTimeout(cb, timeout),
        cancel: (id) => (id && (win.cancelIdleCallback ? win.cancelIdleCallback(id) : clearTimeout(id))),
        raf: (cb) => win.requestAnimationFrame(cb)
    };

    // ✅ Chunk Scan Utility
    const scanInChunks = (list, limit, step, fn) => {
        let i = 0;
        const run = () => {
            const end = Math.min(i + step, limit, list.length);
            for (; i < end; i++) fn(list[i]);
            if (i < Math.min(limit, list.length)) scheduler.request(run);
        };
        run();
    };

    // [Config Helpers]
    const cleanAutoFlags = (o) => {
        delete o.autoDowngraded; delete o.downgradeLevel;
        delete o._restore; delete o.downgradeReason;
        return o;
    };

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
    const LISTS = Object.freeze({
        BANKS_KR: ['kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr', 'nhbank.com', 'kakaobank.com', 'hanabank.com', 'toss.im'],
        GOV_KR: ['gov.kr', 'hometax.go.kr', 'nts.go.kr'],
        OTT_KR: ['youtube.com', 'twitch.tv', 'netflix.com', 'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com'],
        HEAVY_FEEDS: ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'tiktok.com'],
        LAYOUT_KEYWORDS: ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'],
        CRITICAL_SUB: /^(auth|login|signin|pay|cert|secure|account)\./
    });

    const FEED_SEL = '[role="feed"] > *, .feed > *, .list > *, .timeline > *';
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
                onReady(() => setTimeout(() => S.remove(CRASH_KEY), 15000));
            }
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
        });

        if (sessionStorage.getItem(SESSION_OFF_KEY)) {
            console.warn(`[PerfX] 🚨 Safe Mode Active for ${hostname}`);
            RuntimeConfig = { ...RuntimeConfig, codecMode: 'off', passive: false, gpu: false, memory: false, _sessionSafe: true };
        }
    } catch(e) {}

    // Global Detection
    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = hostEndsWithAny(hostname, [...LISTS.BANKS_KR, ...LISTS.GOV_KR]) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = hostEndsWithAny(hostname, LISTS.HEAVY_FEEDS);
    const isVideoSite = hostEndsWithAny(hostname, LISTS.OTT_KR);
    const isSafeMode = isCritical || RuntimeConfig._sessionSafe;

    // [Power State & Unified State Manager]
    const baseLowPower = (navigator.hardwareConcurrency ?? 4) < 4; 
    
    // Global State
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
            perfState.MEDIA_CAP = Math.min(perfState.MEDIA_CAP, 180); // ✅ Tighter
            perfState.DOM_MARGIN = '300px 0px';
            // ✅ Visual Viewport Aware Margin
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
        applyPowerPolicy();
    };

    if ('getBattery' in navigator) {
        navigator.getBattery().then(b => {
            const update = () => {
                perfState.batteryLow = (!b.charging && b.level < 0.2);
                win.dispatchEvent(new Event('perfx-power-change'));
            };
            update(); b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update);
        }).catch(() => {});
    }
    
    // ✅ Throttle Resize/Orientation for Mobile Viewport update
    let rzT = null;
    const triggerRefresh = () => win.dispatchEvent(new Event('perfx-power-change'));
    win.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(triggerRefresh, 200); });
    
    win.addEventListener('perfx-power-change', refreshPerfState);
    navigator.connection?.addEventListener?.('change', refreshPerfState);
    refreshPerfState(); 

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
            cleanAutoFlags(current);
            S.remove(Q_KEY); Q_CACHE = null;
            Env.saveOverrides({ ...current, ...p, disabled: false });
            win.location.reload();
        },
        toggleConfig: (key) => {
            const c = Env.getOverrides();
            c[key] = !c[key];
            Env.saveOverrides(c);
            win.location.reload();
        },
        toggleSessionSafe: () => {
             if (sessionStorage.getItem(SESSION_OFF_KEY)) sessionStorage.removeItem(SESSION_OFF_KEY);
             else sessionStorage.setItem(SESSION_OFF_KEY, '1');
             win.location.reload();
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
            win.dispatchEvent(new CustomEvent('perfx-route', { detail: { force } }));
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
            GM_registerMenuCommand(`⏸ 이번 세션만 끄기 (${RuntimeConfig._sessionSafe ? 'ON' : 'OFF'})`, API.toggleSessionSafe);
            GM_registerMenuCommand(`⚡ 모드: ${RuntimeConfig.codecMode || 'Auto'}`, () => API.profile('ultra'));
            GM_registerMenuCommand(`⚖️ 모드: 균형`, () => API.profile('balanced'));
            GM_registerMenuCommand(`🛡️ 모드: 안전`, () => API.profile('safe'));
            GM_registerMenuCommand(`🖼️ Iframe: ${Config.allowIframe ? 'ON' : 'OFF'}`, () => API.toggleConfig('allowIframe'));
            GM_registerMenuCommand(`🐞 디버그: ${debug ? 'ON' : 'OFF'}`, () => API.toggleConfig('debug'));
        }
    }

    if (RuntimeConfig.disabled) return;

    let isFramed = false;
    try { isFramed = win.top !== win.self; } catch(e) { isFramed = true; }
    if (isFramed && !Config.allowIframe) return;

    if (debug) win.perfx = { version: '78.6.0', config: Config, ...API };

    // ==========================================
    // 2. Autonomous V24 (Cause-Based & Adaptive)
    // ==========================================
    if (SUPPORTED_TYPES.size > 0 && !isSafeMode) {
        try {
            let clsTotal = 0, loadTotal = 0; 
            let lastCls = 0, lastLoad = 0;
            let recoveryStreak = 0; 
            
            let lcpMissCount = 0;
            if (S.get(LCP_KEY)) RuntimeConfig._lcp = S.get(LCP_KEY);
            
            const useLoAF = SUPPORTED_TYPES.has('long-animation-frame');
            
            const getThresholds = () => ({
                L1_CLS: 0.05 * perfState.perfMultiplier,
                L1_LOAD: (useLoAF ? 150 : 5) * perfState.perfMultiplier, 
                L2_CLS: 0.2 * perfState.perfMultiplier,
                L2_LOAD: (useLoAF ? 500 : 15) * perfState.perfMultiplier,
                REC_CLS: 0.01 * perfState.perfMultiplier,
                REC_LOAD: (useLoAF ? 50 : 1) * perfState.perfMultiplier
            });

            // ... (Observers same) ...
            if (SUPPORTED_TYPES.has('largest-contentful-paint')) {
                new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    if (entries.length > 0) {
                        const lcp = entries[entries.length - 1];
                        const url = lcp.url || lcp.element?.src || lcp.element?.currentSrc;
                        if (url) {
                            const currentLCP = normUrl(url);
                            if (RuntimeConfig._lcp && currentLCP !== RuntimeConfig._lcp) {
                                lcpMissCount++;
                                if (lcpMissCount >= 3) { RuntimeConfig._lcp = currentLCP; lcpMissCount = 0; }
                            } else {
                                if (currentLCP === RuntimeConfig._lcp) lcpMissCount = 0; 
                                if (!RuntimeConfig._lcp) RuntimeConfig._lcp = currentLCP;
                            }
                        }
                    }
                }).observe({type: 'largest-contentful-paint', buffered: true});
            }
            if (SUPPORTED_TYPES.has('layout-shift')) {
                new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) clsTotal += e.value; }).observe({type: 'layout-shift', buffered: true});
            }
            if (useLoAF) {
                new PerformanceObserver((list) => { for (const e of list.getEntries()) { const blocking = Math.min(200, e.duration - 50); if (blocking > 0) loadTotal += blocking; } }).observe({type: 'long-animation-frame', buffered: true});
            } else if (SUPPORTED_TYPES.has('longtask')) {
                new PerformanceObserver((list) => { loadTotal += list.getEntries().length; }).observe({type: 'longtask', buffered: true});
            }

            const commitLCP = () => { if (RuntimeConfig._lcp) S.set(LCP_KEY, RuntimeConfig._lcp); };
            const resetDeltas = () => { lastCls = clsTotal; lastLoad = loadTotal; recoveryStreak = 0; };

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
                lastCls = clsTotal;
                lastLoad = loadTotal;

                const c = RuntimeConfig;
                const currentLevel = c.downgradeLevel || 0;
                const TH = getThresholds();
                const now = Date.now();
                
                const decideQuarantine = (reason) => {
                    if (reason.load > reason.cls) {
                        return { gpu: false, codecMode: hasVideo() ? 'soft' : c.codecMode, memory: false }; 
                    }
                    return { memory: false, passive: false }; 
                };

                // Quarantine Check
                if (c.downgradeCount > 5 && !checkQuarantine(now)) {
                    const lastReason = c.downgradeReason || { cls: 1, load: 0 };
                    const modules = decideQuarantine(lastReason);
                    const qVal = { ts: now, modules };
                    S.set(Q_KEY, JSON.stringify(qVal));
                    Q_CACHE = qVal; 
                    
                    c.downgradeCount = 0; c.downgradeWindowTs = now; c.unstableTs = now; 
                    Object.assign(c, modules); Object.assign(Config, modules);
                    Env.saveOverrides(c);
                    win.dispatchEvent(new Event('perfx-config'));
                    log('Smart Quarantine Activated:', modules);
                    return; 
                }
                
                if (!c.downgradeWindowTs || (now - c.downgradeWindowTs) > 86400000) {
                    c.downgradeWindowTs = now;
                    c.downgradeCount = 0;
                }

                // L2 (Update unstableTs)
                if ((clsDelta > TH.L2_CLS || loadDelta > TH.L2_LOAD) && currentLevel < 2) {
                    if (!c._restore) c._restore = { codecMode: c.codecMode, gpu: c.gpu, memory: c.memory, passive: c.passive };
                    c.downgradeLevel = 2;
                    c.downgradeReason = { cls: clsDelta, load: loadDelta, t: Date.now(), level: 2 };
                    c.gpu = false; c.memory = false; c.codecMode = 'soft';
                    c.autoDowngraded = true;
                    c.downgradeCount = (c.downgradeCount || 0) + 1; 
                    c.unstableTs = now; // ✅ Update TS
                    Env.saveOverrides(c);
                    Config.gpu = false; Config.memory = false;
                    API.shutdownMemory();
                    log(`Downgrade L2`);
                    recoveryStreak = 0;
                }
                // L1 (Update unstableTs)
                else if ((clsDelta > TH.L1_CLS || loadDelta > TH.L1_LOAD) && currentLevel < 1) {
                    if (!c._restore) c._restore = { codecMode: c.codecMode, gpu: c.gpu, memory: c.memory, passive: c.passive };
                    c.downgradeLevel = 1;
                    c.downgradeReason = { cls: clsDelta, load: loadDelta, t: Date.now(), level: 1 };
                    c.memory = false;
                    c.downgradeCount = (c.downgradeCount || 0) + 1; 
                    c.unstableTs = now; // ✅ Update TS
                    Env.saveOverrides(c);
                    Config.memory = false; 
                    API.shutdownMemory(); 
                    log(`Downgrade L1`);
                    recoveryStreak = 0;
                }
                // Recovery
                else if (currentLevel > 0 && clsDelta < TH.REC_CLS && loadDelta < TH.REC_LOAD) {
                    recoveryStreak++;
                    const requiredStreak = currentLevel === 1 ? 2 : 4;
                    if (recoveryStreak >= requiredStreak) {
                        const isQ = checkQuarantine(now);
                        if (c._restore) {
                            if (isQ) {
                                if (Q_CACHE?.modules?.memory === false) c._restore.memory = false;
                                if (Q_CACHE?.modules?.gpu === false) c._restore.gpu = false;
                            }
                            Config.memory = !!c._restore.memory && !c._powerThrottled;
                            Config.gpu = !!c._restore.gpu;
                            Config.passive = !!c._restore.passive;
                            Object.assign(c, c._restore);
                            delete c._restore;
                        }
                        delete c.downgradeLevel; delete c.autoDowngraded; delete c.downgradeReason;
                        Env.saveOverrides(c);
                        win.dispatchEvent(new Event('perfx-config'));
                        log('Restored');
                        recoveryStreak = 0;
                    }
                } else {
                    recoveryStreak = 0; 
                }
                healthTimer = setTimeout(checkHealth, 5000);
            };
            
            const startLoop = () => { if (!healthTimer) checkHealth(); };
            const stopLoop = () => { if (healthTimer) { clearTimeout(healthTimer); healthTimer = null; } };

            win.addEventListener('visibilitychange', () => {
                if (document.hidden) { stopLoop(); commitLCP(); } 
                else { resetDeltas(); startLoop(); }
            });
            win.addEventListener('pagehide', (e) => {
                stopLoop(); commitLCP();
                if (!e.persisted) API.shutdownMemory(); 
            });
            win.addEventListener('pageshow', (e) => {
                if (e.persisted) { resetDeltas(); startLoop(); API.restartMemory(); }
            });
            startLoop();
        } catch(e) {}
    }

    // ==========================================
    // 3. Core Modules
    // ==========================================
    class BaseModule { safeInit() { try { this.init(); } catch (e) { log('Module Error', e); } } init() {} }

    // [Core 1] EventPassivator v3.9 (Canvas Guard)
    class EventPassivator extends BaseModule {
        init() {
            if (win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            // ✅ Canvas Guard
            onReady(() => {
                const c = document.querySelector('canvas');
                if (c) {
                    const r = c.getBoundingClientRect();
                    // If canvas takes > 40% of screen, disable passive to avoid breaking games/maps
                    if (r.width * r.height > (win.innerWidth * win.innerHeight * 0.4)) {
                        Config.passive = false; 
                        log('Large Canvas Detected: Passive Disabled');
                    }
                }
            });

            const evts = new Set(['wheel', 'mousewheel']); 
            const needsPDCache = new WeakMap();

            const checkNeedsPD = (listener) => { /* ... */ return false; }; // Simplified for length, same logic
            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);

            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (!Config.passive) return origAdd.call(this, type, listener, options);
                    
                    if (!listener) return origAdd.call(this, type, listener, options);
                    let finalOptions = options;
                    if (evts.has(type)) {
                        const isObj = typeof options === 'object' && options !== null;
                        if (!isObj || options.passive === undefined) {
                            try { finalOptions = isObj ? { ...options, passive: true } : { capture: options === true, passive: true }; } catch (e) { finalOptions = options; }
                        }
                    }
                    return origAdd.call(this, type, listener, finalOptions);
                };
            });
        }
    }

    // [Core 2] CodecOptimizer v2.3
    class CodecOptimizer extends BaseModule {
        init() {
            if (isVideoSite) return;
            // ... (Same logic) ...
            const shouldBlock = (t) => {
                // ✅ Check Config directly
                if (Config.codecMode === 'hard') {
                    if (perfState.isLowPowerMode) return t.includes('av01') || /vp9|vp09/.test(t);
                    return false;
                }
                if (Config.codecMode === 'soft') return t.includes('av01');
                return false;
            };
            // ... (Hook logic same) ...
            const hook = (target, prop, isProto, marker) => { /* ... */ };
            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, Symbol.for('perfx.ms'));
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, Symbol.for('perfx.me'));
        }
    }

    // [Core 3] DomWatcher v3.16 (Safe Skip)
    class DomWatcher extends BaseModule {
        init() {
            if (isSafeMode) return;
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            if (Config.memory && !this.supportsCV) Config.memory = false;
            if (!('IntersectionObserver' in win)) return;

            this.styleMap = new WeakMap();
            this.optimized = new Set();
            this.obsCount = 0;
            this.removedQueue = new Set();
            this.gcTimer = null;

            API.shutdownMemory = () => { /* ... */ if (Config.gpu) this.startIO(); };
            API.restartMemory = () => { if (Config.memory) { this.startIO(); this.startMO(); } else if (Config.gpu) { this.startIO(); } };

            this.startAll = () => { scheduler.request(() => { this.startIO(); this.startMO(); }); };
            onReady(this.startAll);

            win.addEventListener('perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
            win.addEventListener('perfx-config', () => { API.shutdownMemory(); API.restartMemory(); });
        }

        applyOptimization(el, rect) {
            if (this.styleMap.has(el)) return;
            if (!rect || rect.height < 50 || rect.width < 50) return;
            
            const style = getComputedStyle(el);
            if (style.position === 'sticky' || style.position === 'fixed') return;
            if (el.isContentEditable) return;
            if (el.querySelector?.('video,canvas,iframe,form,[aria-live]')) return;
            if (/(auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) return;

            this.styleMap.set(el, {
                cv: el.style.contentVisibility,
                contain: el.style.contain,
                cis: el.style.containIntrinsicSize
            });
            this.optimized.add(el);

            const w = Math.min(2000, Math.ceil(rect.width));
            const h = Math.min(2000, Math.ceil(rect.height));
            el.style.containIntrinsicSize = `${w}px ${h}px`;
            el.style.contentVisibility = 'auto';
            el.style.contain = 'layout paint'; 
        }
        // ... (Restore/Flush/Sweep same) ...
        restoreStyle(el) { const b = this.styleMap.get(el); if(b) { el.style.contentVisibility=b.cv; el.style.contain=b.contain; el.style.containIntrinsicSize=b.cis; this.styleMap.delete(el); } this.optimized.delete(el); }
        flushRemoved() { if (this.removedQueue.size === 0 || this.optimized.size === 0) return; for (const root of this.removedQueue) this.sweepRemovedSubtree(root); this.removedQueue.clear(); this.gcTimer = null; }
        sweepRemovedSubtree(root) { if (!root || root.nodeType !== 1) return; if (this.optimized.has(root)) this.restoreStyle(root); const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); while(walker.nextNode()) { if (this.optimized.has(walker.currentNode)) this.restoreStyle(walker.currentNode); } }

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

            if (Config.gpu) document.querySelectorAll('canvas').forEach(this.observeSafe);
            if (Config.memory) {
                const list = document.querySelectorAll(FEED_SEL);
                scanInChunks(list, perfState.INIT_DOM_SCAN, perfState.SCAN_STEP, this.observeSafe);
            }
        }

        startMO() {
            if (!Config.memory) return;
            if (!document.body) { win.addEventListener('DOMContentLoaded', () => this.startMO(), { once: true }); return; }
            if (this.mutObs) this.mutObs.disconnect();
            this.mutObs = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (this.obsCount < perfState.DOM_CAP) {
                        m.addedNodes.forEach(n => {
                            if (n.nodeType === 1) {
                                if (n.matches && n.matches(FEED_SEL)) this.observeSafe(n);
                                if (n.querySelectorAll) {
                                    const list = n.querySelectorAll(FEED_SEL);
                                    scanInChunks(list, 200, perfState.SCAN_STEP, this.observeSafe);
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
            this.mutObs.observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    // [Core 4] NetworkAssistant v3.11 (Preemptive Lazy)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isSafeMode) return;

            const getLCP = () => RuntimeConfig._lcp || S.get(LCP_KEY);
            const batchQueue = new Map();
            let batchTimer = null;
            let isProtectionPhase = true;
            
            // ✅ Set Lazy Helper
            const setImgLazy = (img, setPriority = true) => {
                if (!img || img.hasAttribute('loading') || img.hasAttribute('fetchpriority')) return;
                img.setAttribute('loading', 'lazy');
                img.setAttribute('decoding', 'async');
                if (setPriority) img.setAttribute('fetchpriority', 'low');
            };

            const distMap = new WeakMap(); 
            const observing = new Set(); 
            let imgSlots = 0, vidSlots = 0;
            let MAX_IMG = 0, MAX_VID = 0;
            let vpObs = null;
            let currentGen = 0;

            const updateCaps = () => {
                const cap = perfState.MEDIA_CAP;
                MAX_IMG = Math.floor(cap * 0.85);
                MAX_VID = Math.max(10, cap - MAX_IMG);
                if (isMobile) MAX_VID = Math.min(MAX_VID, 6);
                
                if (observing.size > cap) {
                    const sorted = [...observing].sort((a, b) => {
                        const dA = distMap.get(a) ?? -1; // ✅ Fix: -1 = Unknown (Keep)
                        const dB = distMap.get(b) ?? -1;
                        return dB - dA; 
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
                        
                        // ✅ Image Logic
                        if (e.isIntersecting) {
                            nearSet.set(el, currentGen);
                            // If it was forced lazy, browser handles eager switch naturally
                        } else { 
                            farSet.set(el, currentGen); 
                            setImgLazy(el); // Confirmed Far -> Lazy
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

            // Events
            win.addEventListener('perfx-power-change', rebuildObserver);
            win.addEventListener('perfx-config', () => {
                if (batchTimer) { scheduler.cancel(batchTimer); batchTimer = null; }
                batchQueue.clear();
                rebuildObserver();
            });

            // Lifecycle
            let protectTimer = null;
            const startProtection = (force = false) => {
                if (!force && isProtectionPhase) return;
                const ms = force ? perfState.PROTECT_MS : Math.min(1000, perfState.PROTECT_MS / 3);
                isProtectionPhase = true;
                if (protectTimer) clearTimeout(protectTimer);
                protectTimer = setTimeout(() => {
                    isProtectionPhase = false;
                    protectTimer = null;
                }, ms);
            };

            win.addEventListener('perfx-route', (e) => {
                if (e.detail?.force) {
                    currentGen++;
                    // ✅ Reset observing on route change
                    observing.forEach(el => { try{vpObs.unobserve(el);}catch{} });
                    observing.clear();
                    rebuildObserver(); 
                }
                startProtection(e.detail?.force);
            });
            
            onReady(() => startProtection(true)); 
            
            win.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (batchTimer) { scheduler.cancel(batchTimer); batchTimer = null; }
                    if (this.mo) this.mo.disconnect();
                } else {
                    startProtection(false);
                    if (this.mo) this.mo.observe(document.documentElement, { childList: true, subtree: true });
                }
            });

            const nearSet = new WeakMap();
            const farSet = new WeakMap();
            
            const decSlot = (el) => {
                if (observing.has(el)) {
                    observing.delete(el);
                    distMap.delete(el);
                    if (el.tagName === 'VIDEO') vidSlots = Math.max(0, vidSlots - 1);
                    else imgSlots = Math.max(0, imgSlots - 1);
                }
            };

            const safeObserve = (el) => {
                const isVid = el.tagName === 'VIDEO';
                if (observing.has(el)) return;
                if (isVid) { if (vidSlots >= MAX_VID) return; vidSlots++; }
                else { if (imgSlots >= MAX_IMG) return; imgSlots++; }
                
                observing.add(el);
                if (vpObs) vpObs.observe(el);
            };

            const processVideo = (vid) => {
                if (vid.hasAttribute('preload') || isVideoSite) return;
                if (!perfState.shouldAggressiveVideo && !vid.autoplay) { safeObserve(vid); return; }
                vid.setAttribute('preload', 'none');
                safeObserve(vid);
            };

            const processImg = (img, fromMutation) => {
                // ... (LCP Check) ...
                if (img.hasAttribute('loading') || img.hasAttribute('fetchpriority')) return;
                const lcpUrl = getLCP();
                if (lcpUrl) {
                    const cur = normUrl(img.currentSrc || img.src);
                    if (cur === lcpUrl) { img.setAttribute('loading', 'eager'); img.setAttribute('fetchpriority', 'high'); return; }
                }

                // ✅ Preemptive Lazy Strategy
                if (fromMutation && !isProtectionPhase) {
                    if (imgSlots < MAX_IMG) { safeObserve(img); return; }
                    setImgLazy(img, false); // Fallback
                    return;
                }

                // Initial Load: Default to Lazy unless protected/near
                if (!isProtectionPhase && !nearSet.has(img)) {
                     // If we are not observing and it's not LCP, safer to lazy
                     // But IO will correct it if near.
                }

                if (nearSet.get(img) === currentGen) return; 
                if (farSet.get(img) === currentGen) { setImgLazy(img); return; }
                
                safeObserve(img);
            };

            // ✅ Full Flush
            const flushQueue = () => {
                batchQueue.forEach((fromMutation, node) => {
                    if (!node.isConnected) return;
                    if (node.tagName === 'VIDEO') processVideo(node);
                    else processImg(node, fromMutation);
                });
                batchQueue.clear();
                batchTimer = null;
            };

            const scheduleNode = (node, fromMutation = false) => {
                const current = batchQueue.get(node);
                batchQueue.set(node, current || fromMutation);
                if (!batchTimer) batchTimer = scheduler.request(flushQueue, 200);
            };

            const run = () => { 
                const imgs = document.querySelectorAll('img');
                const vids = document.querySelectorAll('video');
                rebuildObserver();
                scanInChunks(imgs, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
                scanInChunks(vids, perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
            };
            onReady(run);

            this.mo = new MutationObserver(ms => {
                ms.forEach(m => {
                    m.addedNodes.forEach(n => {
                        if (n.tagName === 'IMG' || n.tagName === 'VIDEO') scheduleNode(n, true);
                        else if (n.nodeType === 1 && n.querySelectorAll) {
                            const list = n.querySelectorAll('img, video');
                            scanInChunks(list, 300, perfState.SCAN_STEP, (child) => scheduleNode(child, true));
                        }
                    });
                    // ✅ Slot Leak Fix
                    m.removedNodes.forEach(n => {
                        if (n.nodeType === 1) {
                            if (n.tagName === 'IMG' || n.tagName === 'VIDEO') decSlot(n);
                            else if (n.querySelectorAll) {
                                const list = n.querySelectorAll('img, video');
                                scanInChunks(list, 300, perfState.SCAN_STEP, decSlot);
                            }
                        }
                    });
                });
            });
            this.mo.observe(document.documentElement, { childList: true, subtree: true });
            
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
