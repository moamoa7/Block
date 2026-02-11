// ==UserScript==
// @name        Web 성능 최적화 (v76.6 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     76.6.0-KR-ULTRA-Infinity-Autonomous
// @description [Infinity] 끝없는 최적화 + Autonomous (Hoisted Config, Power-Aware Recovery, Layout-Safe LCP)
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

    // [Util] Helpers
    const hostEndsWithAny = (h, list) => list.some(d => h === d || h.endsWith('.' + d));
    const safeJsonParse = (str) => { try { return JSON.parse(str) || {}; } catch { return {}; } };

    // [Safe Init] Hoist Config/API to prevent TDZ crashes
    let Config = {
        codecMode: 'off', passive: false, gpu: false, memory: false,
        allowIframe: false, downgradeLevel: 0
    };

    const API = {
        profile: () => {},
        toggleConfig: () => {},
        toggleSessionSafe: () => {},
        shutdownMemory: () => {},
        restartMemory: () => {}
    };

    // Safe Scheduler
    const scheduler = {
        request: (cb, timeout = 200) => {
            return (win.requestIdleCallback)
                ? win.requestIdleCallback(cb, { timeout })
                : setTimeout(cb, timeout);
        },
        cancel: (id) => {
            if (!id) return;
            (win.cancelIdleCallback) ? win.cancelIdleCallback(id) : clearTimeout(id);
        }
    };

    // [Config Helpers]
    const cleanAutoFlags = (o) => {
        delete o.autoDowngraded;
        delete o.downgradeLevel;
        delete o._restore;
        delete o.downgradeReason;
        return o;
    };

    const stripTransient = (o) => {
        const out = { ...o };
        for (const k in out) if (k.startsWith('_')) delete out[k];
        return out;
    };

    const normUrl = (u) => {
        try {
            if (!u || u.startsWith('data:')) return u;
            const url = new URL(u, win.location.href);
            return url.origin + url.pathname;
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

    const DEEP_SCAN_LIMIT = 200;
    const FEED_SEL = '[role="feed"] > *, .feed > *, .list > *, .timeline > *';
    const SUPPORTED_TYPES = new Set(typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes || []) : []);

    // [Config & State]
    const hostname = win.location.hostname.toLowerCase();

    const lcpKeyBase = `PerfX_LCP_${hostname}`;
    const pathSegs = win.location.pathname.split('/').filter(Boolean).map(s => {
        if (/^\d+$/.test(s)) return ':id';
        if (/^[0-9a-f-]{36}$/i.test(s)) return ':uuid';
        if (s.length > 24 || /^[0-9a-z_-]{20,}$/i.test(s)) return ':token';
        return s;
    });
    const pathBucket = pathSegs.slice(0, 2).join('/');
    const LCP_KEY = `${lcpKeyBase}:${pathBucket}`;

    // Runtime Configuration
    let RuntimeConfig = {};

    const Env = {
        storageKey: `PerfX_ULTRA_${hostname}`,
        getOverrides() { return safeJsonParse(localStorage.getItem(this.storageKey)); },
        saveOverrides(data) {
            const safeData = stripTransient(data);
            localStorage.setItem(this.storageKey, JSON.stringify(safeData));
            RuntimeConfig = { ...RuntimeConfig, ...data };
        }
    };

    // Init Config
    RuntimeConfig = Env.getOverrides();
    const debug = !!RuntimeConfig.debug;
    const log = (...args) => debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    // [Safety 0] Crash Guard V4.3
    const CRASH_KEY = `perfx-crash:${hostname}`;
    const SESSION_OFF_KEY = `perfx-safe:${hostname}`;

    try {
        if (new URLSearchParams(win.location.search).has('perfx-off')) sessionStorage.setItem(SESSION_OFF_KEY, '1');
        const lastCrash = parseInt(localStorage.getItem(CRASH_KEY) || '0');

        if (lastCrash >= 3) {
            sessionStorage.setItem(SESSION_OFF_KEY, '1');
            localStorage.setItem(CRASH_KEY, '0');
        }

        if (sessionStorage.getItem(SESSION_OFF_KEY)) {
            console.warn(`[PerfX] 🚨 Safe Mode Active for ${hostname}`);
            RuntimeConfig = { ...RuntimeConfig, codecMode: 'off', passive: false, gpu: false, memory: false, _sessionSafe: true };
        } else {
            localStorage.setItem(CRASH_KEY, lastCrash + 1);
            win.addEventListener('load', () => setTimeout(() => localStorage.removeItem(CRASH_KEY), 10000));
        }
    } catch(e) {}

    // Global Detection
    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = hostEndsWithAny(hostname, [...LISTS.BANKS_KR, ...LISTS.GOV_KR]) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = hostEndsWithAny(hostname, LISTS.HEAVY_FEEDS);
    const isVideoSite = hostEndsWithAny(hostname, LISTS.OTT_KR);
    const isSafeMode = isCritical || RuntimeConfig._sessionSafe;

    // [Power State & Live Multiplier]
    const baseLowPower = (navigator.hardwareConcurrency ?? 4) < 4 || (navigator.connection?.saveData === true);
    let isLowPowerMode = baseLowPower;

    const computePerfMultiplier = () => {
        const hc = navigator.hardwareConcurrency || 4;
        const dm = navigator.deviceMemory || 4;
        const saveData = !!navigator.connection?.saveData;
        const net = navigator.connection?.effectiveType || '4g';

        const lowDevice = (hc <= 4) || (dm <= 4) || isMobile;

        let m = lowDevice ? 0.8 : 1.0;
        if (saveData) m *= 0.85;
        if (/2g|3g/.test(net)) m *= 0.85;
        if (isLowPowerMode && !saveData) m *= 0.85;

        return Math.max(0.6, Math.min(1.2, m));
    };

    let perfMultiplier = computePerfMultiplier();
    // ✅ Scale MAX_OBSERVERS
    let MAX_OBSERVERS = Math.floor(2000 * perfMultiplier);

    if ('getBattery' in navigator) {
        navigator.getBattery().then(b => {
            const update = () => {
                isLowPowerMode = baseLowPower || (!b.charging && b.level < 0.2);
                win.dispatchEvent(new Event('perfx-power-change'));
            };
            update(); b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update);
        }).catch(() => {});
    }

    win.addEventListener('perfx-power-change', () => {
        perfMultiplier = computePerfMultiplier();
        MAX_OBSERVERS = Math.floor(2000 * perfMultiplier);

        if (isLowPowerMode) {
            RuntimeConfig._powerThrottled = true; // ✅ Mark logic flag
            if (Config.memory) {
                Config.memory = false;
                API.shutdownMemory();
                log('Low Power: Memory Guard Disabled');
            }
        } else {
            RuntimeConfig._powerThrottled = false;
        }
    });

    navigator.connection?.addEventListener?.('change', () => { perfMultiplier = computePerfMultiplier(); });

    // ==========================================
    // 1. Populate Config & API (Safe Init)
    // ==========================================
    const calculatedConfig = {
        codecMode: RuntimeConfig.codecMode ?? 'hard',
        passive: RuntimeConfig.passive ?? (!isLayoutSensitive),
        gpu: RuntimeConfig.gpu ?? (!isLayoutSensitive && !isLowPowerMode),
        memory: RuntimeConfig.memory ?? (!isLayoutSensitive && !isHeavyFeed),
        allowIframe: RuntimeConfig.allowIframe ?? false,
        downgradeLevel: RuntimeConfig.downgradeLevel || 0
    };

    if (isSafeMode) {
        Object.assign(calculatedConfig, { codecMode: 'off', passive: false, gpu: false, memory: false, allowIframe: true });
    }

    // ✅ Fill Hoisted Objects
    Object.assign(Config, calculatedConfig);

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
        // shutdown/restart are injected by DomWatcher
    });

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

    if (debug) win.perfx = { version: '76.6.0', config: Config, ...API };

    // ==========================================
    // 2. Autonomous V14 (Power-Aware & Layout-Safe)
    // ==========================================
    if (SUPPORTED_TYPES.size > 0 && !isSafeMode) {
        try {
            let clsTotal = 0, ltTotal = 0;
            let lastCls = 0, lastLt = 0;
            let recoveryStreak = 0;

            let lcpMissCount = 0;
            let savedLCP = localStorage.getItem(LCP_KEY);
            if (savedLCP) RuntimeConfig._lcp = savedLCP;

            const getThresholds = () => ({
                L1_CLS: 0.05 * perfMultiplier,
                L1_LT: 5 * perfMultiplier,
                L2_CLS: 0.2 * perfMultiplier,
                L2_LT: 15 * perfMultiplier,
                REC_CLS: 0.01 * perfMultiplier,
                REC_LT: 1 * perfMultiplier
            });

            if (SUPPORTED_TYPES.has('largest-contentful-paint')) {
                new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    if (entries.length > 0) {
                        const lcp = entries[entries.length - 1];
                        // ✅ LCP Fallback: use element.src if url is empty
                        const url = lcp.url || lcp.element?.src || lcp.element?.currentSrc;

                        if (url) {
                            const currentLCP = normUrl(url);
                            if (savedLCP && currentLCP !== savedLCP) {
                                lcpMissCount++;
                                if (lcpMissCount >= 3) {
                                    savedLCP = currentLCP;
                                    RuntimeConfig._lcp = currentLCP;
                                    lcpMissCount = 0;
                                }
                            } else {
                                if (currentLCP === savedLCP) lcpMissCount = 0;
                                if (!savedLCP) {
                                    savedLCP = currentLCP;
                                    RuntimeConfig._lcp = currentLCP;
                                }
                            }
                        }
                    }
                }).observe({type: 'largest-contentful-paint', buffered: true});
            }

            if (SUPPORTED_TYPES.has('layout-shift')) {
                new PerformanceObserver((list) => {
                    for (const e of list.getEntries()) if (!e.hadRecentInput) clsTotal += e.value;
                }).observe({type: 'layout-shift', buffered: true});
            }

            if (SUPPORTED_TYPES.has('longtask')) {
                new PerformanceObserver((list) => {
                    ltTotal += list.getEntries().length;
                }).observe({type: 'longtask', buffered: true});
            }

            const commitLCP = () => { if (savedLCP) localStorage.setItem(LCP_KEY, savedLCP); };
            const resetDeltas = () => { lastCls = clsTotal; lastLt = ltTotal; recoveryStreak = 0; };

            let healthTimer = null;
            const checkHealth = () => {
                if (document.hidden) return;

                const clsDelta = clsTotal - lastCls;
                const ltDelta = ltTotal - lastLt;
                lastCls = clsTotal;
                lastLt = ltTotal;

                const c = RuntimeConfig;
                const currentLevel = c.downgradeLevel || 0;
                const TH = getThresholds();

                // L2
                if ((clsDelta > TH.L2_CLS || ltDelta > TH.L2_LT) && currentLevel < 2) {
                    if (!c._restore) c._restore = { codecMode: c.codecMode, gpu: c.gpu, memory: c.memory, passive: c.passive };
                    c.downgradeLevel = 2;
                    c.downgradeReason = { cls: clsDelta, lt: ltDelta, t: Date.now(), level: 2 };
                    c.gpu = false; c.memory = false; c.codecMode = 'soft';
                    c.autoDowngraded = true;
                    Env.saveOverrides(c);

                    Config.gpu = false; Config.memory = false;
                    API.shutdownMemory();
                    log(`Downgrade L2`);
                    recoveryStreak = 0;
                }
                // L1
                else if ((clsDelta > TH.L1_CLS || ltDelta > TH.L1_LT) && currentLevel < 1) {
                    if (!c._restore) c._restore = { codecMode: c.codecMode, gpu: c.gpu, memory: c.memory, passive: c.passive };
                    c.downgradeLevel = 1;
                    c.downgradeReason = { cls: clsDelta, lt: ltDelta, t: Date.now(), level: 1 };
                    c.memory = false;
                    Env.saveOverrides(c);

                    Config.memory = false;
                    API.shutdownMemory();
                    log(`Downgrade L1`);
                    recoveryStreak = 0;
                }
                // Recovery (Power Aware)
                else if (currentLevel > 0 && clsDelta < TH.REC_CLS && ltDelta < TH.REC_LT) {
                    recoveryStreak++;
                    const requiredStreak = currentLevel === 1 ? 2 : 4;

                    if (recoveryStreak >= requiredStreak) {
                        if (c._restore) {
                            // ✅ Logic Logic: Don't enable memory if power throttled
                            Config.memory = !!c._restore.memory && !c._powerThrottled;
                            Config.gpu = !!c._restore.gpu;
                            Config.passive = !!c._restore.passive;

                            Object.assign(c, c._restore);
                            delete c._restore;
                        }
                        delete c.downgradeLevel;
                        delete c.autoDowngraded;
                        delete c.downgradeReason;
                        Env.saveOverrides(c);

                        if (Config.memory) API.restartMemory();
                        log('Restored (Power-Aware)');
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

    // [Core 1] EventPassivator v3.6
    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive || win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            const evts = new Set(['touchstart', 'wheel', 'mousewheel']);
            const needsPDCache = new WeakMap();

            const checkNeedsPD = (listener) => {
                if (!listener) return false;
                if (needsPDCache.has(listener)) return needsPDCache.get(listener);
                let res = false;
                try {
                    const fn = typeof listener === 'function' ? listener : (listener.handleEvent || null);
                    if (fn) {
                        const str = Function.prototype.toString.call(fn);
                        res = str.includes('preventDefault') || str.includes('returnValue');
                    }
                } catch {}
                needsPDCache.set(listener, res);
                return res;
            };

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);

            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (!listener) return origAdd.call(this, type, listener, options);
                    if (type === 'touchmove') return origAdd.call(this, type, listener, options);

                    let finalOptions = options;
                    if (evts.has(type)) {
                        const isObj = typeof options === 'object' && options !== null;
                        if (!isObj || options.passive === undefined) {
                            if (type === 'touchstart' || !checkNeedsPD(listener)) {
                                try {
                                    finalOptions = isObj
                                        ? { ...options, passive: true }
                                        : { capture: options === true, passive: true };
                                } catch (e) { finalOptions = options; }
                            }
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
            if (Config.codecMode === 'off') return;
            if (isVideoSite) return;

            const shouldBlock = (t) => {
                if (typeof t !== 'string') return false;
                const v = t.toLowerCase();
                if (Config.codecMode === 'hard') {
                    if (isLowPowerMode) return v.includes('av01') || /vp9|vp09/.test(v);
                    return false;
                }
                if (Config.codecMode === 'soft') return v.includes('av01');
                return false;
            };

            const hook = (target, prop, isProto, marker) => {
                if (!target) return;
                const root = isProto ? target.prototype : target;
                if (root[marker]) return;
                try {
                    const orig = root[prop];
                    root[prop] = function(t) {
                        if (shouldBlock(t)) return isProto ? '' : false;
                        return orig.apply(this, arguments);
                    };
                    root[marker] = true;
                } catch(e) {}
            };

            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, Symbol.for('perfx.ms'));
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, Symbol.for('perfx.me'));
        }
    }

    // [Core 3] DomWatcher v3.4 (Chunked Restore)
    class DomWatcher extends BaseModule {
        init() {
            if (!Config.gpu && !Config.memory) return;
            if (isSafeMode) return;

            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            if (!('IntersectionObserver' in win)) return;

            this.styleMap = new WeakMap();
            this.optimized = new Set();
            this.obsCount = 0;
            this.removedQueue = new Set();
            this.gcTimer = null;

            // ✅ Chunked Restore Logic
            API.shutdownMemory = () => {
                if (this.mutObs) { this.mutObs.disconnect(); this.mutObs = null; }
                if (this.visObs) { this.visObs.disconnect(); this.visObs = null; }

                const restoreQueue = [...this.optimized];
                this.optimized.clear();
                this.removedQueue.clear();
                scheduler.cancel(this.gcTimer);
                this.gcTimer = null;

                const processRestore = () => {
                    const chunk = restoreQueue.splice(0, 200); // 200 per frame
                    for (const el of chunk) this.restoreStyle(el);
                    if (restoreQueue.length > 0) scheduler.request(processRestore, 16);
                };
                processRestore();

                if (Config.gpu) this.startIO();
            };

            API.restartMemory = () => {
                if (Config.memory) {
                    this.startIO();
                    this.startMO();
                } else if (Config.gpu) {
                    this.startIO();
                }
            };

            this.startAll = () => { this.startIO(); this.startMO(); };
            if (document.readyState === 'loading') win.addEventListener('DOMContentLoaded', this.startAll);
            else this.startAll();

            win.addEventListener('perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
        }

        applyOptimization(el, rect) {
            if (this.styleMap.has(el)) return;
            if (!rect || rect.height < 50 || rect.width < 50) return;

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
            el.style.contain = 'content';
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
            if (this.removedQueue.size === 0 || this.optimized.size === 0) return;
            for (const root of this.removedQueue) this.sweepRemovedSubtree(root);
            this.removedQueue.clear();
            this.gcTimer = null;
        }

        sweepRemovedSubtree(root) {
            if (!root || root.nodeType !== 1) return;
            if (this.optimized.has(root)) this.restoreStyle(root);

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            while(walker.nextNode()) {
                if (this.optimized.has(walker.currentNode)) this.restoreStyle(walker.currentNode);
            }
        }

        startIO() {
            if (this.visObs) this.visObs.disconnect();
            if (!Config.memory && !Config.gpu) return;

            this.obsCount = 0;
            this.observed = new WeakSet();
            const margin = (isLowPowerMode || isMobile) ? '200px 0px' : '600px 0px';

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
                if (el && this.obsCount < MAX_OBSERVERS && !this.observed.has(el)) {
                    this.visObs.observe(el);
                    this.observed.add(el);
                    this.obsCount++;
                }
            };

            if (Config.gpu) document.querySelectorAll('canvas').forEach(this.observeSafe);
            if (Config.memory) document.querySelectorAll(FEED_SEL).forEach(this.observeSafe);
        }

        startMO() {
            if (!Config.memory) return;
            if (this.mutObs) this.mutObs.disconnect();

            this.mutObs = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (this.obsCount < MAX_OBSERVERS) {
                        m.addedNodes.forEach(n => {
                            if (n.nodeType === 1) {
                                if (n.matches && n.matches(FEED_SEL)) this.observeSafe(n);
                                if (n.querySelectorAll && this.obsCount < MAX_OBSERVERS) {
                                    const list = n.querySelectorAll(FEED_SEL);
                                    for (let i = 0; i < list.length && this.obsCount < MAX_OBSERVERS && i < DEEP_SCAN_LIMIT; i++) {
                                        this.observeSafe(list[i]);
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
            this.mutObs.observe(document.body, { childList: true, subtree: true });
        }
    }

    // [Core 4] NetworkAssistant v2.14 (Zero-Layout)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isSafeMode) return;

            const getLCP = () => RuntimeConfig._lcp || localStorage.getItem(LCP_KEY);
            const batchQueue = new Set();
            let batchTimer = null;

            let isProtectionPhase = true;
            if (document.readyState === 'complete') isProtectionPhase = false;
            else win.addEventListener('load', () => {
                setTimeout(() => isProtectionPhase = false, 3000);
            });

            // Layout Guard (Limit checks)
            let viewportCheckCount = 0;
            const nearViewport = (img) => {
                if (viewportCheckCount > 50) return false; // Stop checking after 50
                try {
                    const rect = img.getBoundingClientRect();
                    viewportCheckCount++;
                    return rect.top < win.innerHeight * 1.5;
                } catch { return false; }
            };

            const isCandidate = (img) => {
                const src = (img.currentSrc || img.src || '').toLowerCase();
                if (src.startsWith('data:') || src.startsWith('blob:')) return false;
                if (src.includes('logo') || src.includes('icon') || src.includes('pixel')) return false;
                const w = parseInt(img.getAttribute('width') || '0');
                const h = parseInt(img.getAttribute('height') || '0');
                return (w * h > 22500) || (w === 0 && h === 0);
            };

            let candidateCount = 0;

            const processImg = (img) => {
                if (img.hasAttribute('loading')) return;

                // 1. LCP Match (Highest Priority - No Reflow)
                const lcpUrl = getLCP();
                if (lcpUrl) {
                    const cur = normUrl(img.currentSrc || img.src);
                    if (cur === lcpUrl) {
                        img.setAttribute('loading', 'eager');
                        img.setAttribute('fetchpriority', 'high');
                        return; // ✅ Return early, skip viewport check
                    }
                }

                // 2. Viewport Guard (Limited Reflow)
                if (nearViewport(img)) return;

                // 3. Fallback Protection
                if (!lcpUrl && isProtectionPhase) {
                    if (isCandidate(img)) {
                        candidateCount++;
                        if (candidateCount <= 3) return;
                    }
                }

                img.setAttribute('loading', 'lazy');
                img.setAttribute('decoding', 'async');
            };

            const flushQueue = () => {
                batchQueue.forEach(processImg);
                batchQueue.clear();
                batchTimer = null;
            };

            const scheduleImg = (img) => {
                batchQueue.add(img);
                if (!batchTimer) batchTimer = scheduler.request(flushQueue, 200);
            };

            const run = () => { document.querySelectorAll('img').forEach(scheduleImg); };
            if (document.readyState === 'loading') win.addEventListener('DOMContentLoaded', run);
            else run();

            new MutationObserver(ms => {
                ms.forEach(m => m.addedNodes.forEach(n => {
                    if (n.tagName === 'IMG') scheduleImg(n);
                    else if (n.nodeType === 1 && n.querySelectorAll) {
                        n.querySelectorAll('img').forEach(scheduleImg);
                    }
                }));
            }).observe(document.documentElement, { childList: true, subtree: true });
        }
    }

    // [Core 5] HardwareGovernor (Battery Saver)
    class HardwareGovernor extends BaseModule {
        init() {
            if (!isLowPowerMode) return;
            const MAP_DOMAINS = ['map.naver.com', 'map.kakao.com', 'dmap.daum.net'];
            if (hostEndsWithAny(hostname, MAP_DOMAINS) || (hostname.includes('google') && hostname.includes('map'))) return;
            if (!isHeavyFeed) return;

            if (navigator.geolocation) {
                const makeError = () => ({ code: 1, message: "Blocked by PerfX" });
                const denyWatch = (s, e) => { if(e) e(makeError()); return Math.floor(Math.random()*10000); };
                const denyGet = (s, e) => { if(e) e(makeError()); };

                navigator.geolocation.getCurrentPosition = denyGet;
                navigator.geolocation.watchPosition = denyWatch;
                log('HardwareGovernor: Geolocation blocked.');
            }
        }
    }

    // Module Init
    [
        new EventPassivator(),
        new CodecOptimizer(),
        new DomWatcher(),
        new NetworkAssistant(),
        new HardwareGovernor()
    ].forEach(m => m.safeInit());

    if (debug) log(`PerfX v${win.perfx.version} Ready`);

})();
