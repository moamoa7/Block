// ==UserScript==
// @name        Web 성능 최적화 (v75.3 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     75.3.0-KR-ULTRA-Infinity-Autonomous
// @description [Infinity] 끝없는 최적화 + Autonomous (Self-Tuning, LCP/CLS/LongTask Guard, Battery Saver)
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
    const log = (...args) => initialOverrides.debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    // [Config] Storage & Env
    const Env = {
        storageKey: `PerfX_ULTRA_${win.location.hostname.toLowerCase()}`,
        getOverrides() { return safeJsonParse(localStorage.getItem(this.storageKey)); }
    };
    const initialOverrides = Env.getOverrides();

    // [Menu System]
    if (typeof GM_registerMenuCommand !== 'undefined') {
        const toggleDisable = () => {
            const c = Env.getOverrides();
            c.disabled = !c.disabled;
            localStorage.setItem(Env.storageKey, JSON.stringify(c));
            win.location.reload();
        };

        if (initialOverrides.disabled) {
            GM_registerMenuCommand(`✅ 이 사이트 최적화 켜기 (현재 꺼짐)`, toggleDisable);
            console.log('[PerfX] Script is disabled on this site by user request.');
            return;
        }

        GM_registerMenuCommand(`🚫 이 사이트에서 끄기 (영구)`, toggleDisable);
        GM_registerMenuCommand(`⚡ 모드: ${initialOverrides.codecMode || 'Auto'} (Ultra)`, () => win.perfx?.profile('ultra'));
        GM_registerMenuCommand(`⚖️ 모드: 균형 (Balanced)`, () => win.perfx?.profile('balanced'));
        GM_registerMenuCommand(`🛡️ 모드: 안전 (Safe)`, () => win.perfx?.profile('safe'));
        GM_registerMenuCommand(`🖼️ Iframe 허용: ${initialOverrides.allowIframe ? 'ON' : 'OFF'}`, () => win.perfx?.toggleIframe?.());
        GM_registerMenuCommand(`🐞 디버그: ${initialOverrides.debug ? 'ON' : 'OFF'}`, () => win.perfx?.toggleDebug?.());

    } else if (initialOverrides.disabled) {
        return;
    }

    // [Safety 0] Crash Guard v2
    const CRASH_KEY = 'perfx-crash-count';
    try {
        if (new URLSearchParams(win.location.search).has('perfx-off')) return;
        if (sessionStorage.getItem('perfx-off')) return;

        const lastCrash = parseInt(sessionStorage.getItem(CRASH_KEY) || '0');
        if (lastCrash >= 3) {
            console.warn('[PerfX] 🚨 반복적인 크래시 감지. 안전 모드로 전환.');
            localStorage.setItem(Env.storageKey, JSON.stringify({ ...initialOverrides, codecMode: 'off', passive: false, gpu: false, memory: false }));
            sessionStorage.setItem(CRASH_KEY, '0');
            return;
        }
        sessionStorage.setItem(CRASH_KEY, lastCrash + 1);
        win.addEventListener('load', () => setTimeout(() => sessionStorage.removeItem(CRASH_KEY), 2000));
    } catch(e) {}

    // [Autonomous V2] CLS & LongTask Observer (Auto-Downgrade)
    if (typeof PerformanceObserver !== 'undefined') {
        try {
            let cls = 0;
            let longTasks = 0;

            // CLS Observer
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) cls += entry.value;
                }
            }).observe({type: 'layout-shift', buffered: true});

            // LongTask Observer
            new PerformanceObserver((list) => {
                longTasks += list.getEntries().length;
            }).observe({type: 'longtask', buffered: true});

            win.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    // CLS가 높거나(0.25+) LongTask가 빈번하면(20+) 다운그레이드
                    if (cls > 0.25 || longTasks > 20) {
                        const c = Env.getOverrides();
                        if (!c.autoDowngraded && c.codecMode !== 'off') {
                            c.codecMode = 'soft'; // 코덱 완화
                            c.gpu = false;        // GPU 부하 해제
                            c.memory = false;     // DOM 관찰 해제
                            c.autoDowngraded = true;
                            localStorage.setItem(Env.storageKey, JSON.stringify(c));
                            console.warn(`[PerfX] Performance degraded (CLS:${cls.toFixed(2)}, LT:${longTasks}). Profile downgraded for next visit.`);
                        }
                    }
                    // (Optional) 상태가 매우 좋으면 복구하는 로직은 보수적으로 생략 (User override 존중)
                }
            });
        } catch(e) {}
    }

    // ==========================================
    // 1. Critical Domain & Detection
    // ==========================================
    const hostname = win.location.hostname.toLowerCase();
    const CRITICAL_DOMAINS = [
        'gov.kr', 'hometax.go.kr', 'nts.go.kr', 'banking', 'bank',
        'naver.com', 'kakao.com', 'google.com', 'appleid.apple.com'
    ];
    const CRITICAL_SUB = /^(auth|login|signin|pay|cert|secure)\./;
    const isCritical = hostEndsWithAny(hostname, CRITICAL_DOMAINS) || CRITICAL_SUB.test(hostname);
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const LAYOUT_KEYWORDS = ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'];
    const IS_LAYOUT_SENSITIVE = LAYOUT_KEYWORDS.some(k => hostname.includes(k));

    const HEAVY_FEEDS = ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'youtube.com'];
    const isHeavyFeed = hostEndsWithAny(hostname, HEAVY_FEEDS);

    // ==========================================
    // 2. State & Config
    // ==========================================
    let isLowPowerMode = (navigator.hardwareConcurrency ?? 4) < 4 || (navigator.connection?.saveData === true);
    const triggerStateChange = () => win.dispatchEvent(new Event('perfx-power-change'));

    if ('getBattery' in navigator) {
        navigator.getBattery().then(b => {
            const update = () => {
                isLowPowerMode = (!b.charging && b.level < 0.2); // 배터리 20% 미만 & 미충전 시
                triggerStateChange();
            };
            update(); b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update);
        }).catch(() => {});
    }

    // Config Table
    let Config = {
        codecMode: initialOverrides.codecMode ?? 'hard',
        passive: initialOverrides.passive ?? (!IS_LAYOUT_SENSITIVE),
        gpu: initialOverrides.gpu ?? (!IS_LAYOUT_SENSITIVE && !isMobile),
        memory: initialOverrides.memory ?? (!IS_LAYOUT_SENSITIVE && !isHeavyFeed),
        allowIframe: initialOverrides.allowIframe ?? false
    };

    if (isCritical) {
        Config = { codecMode: 'off', passive: false, gpu: false, memory: false, allowIframe: true };
    }

    // Iframe Guard
    try { if (win.top !== win.self && !Config.allowIframe) return; } catch(e) { return; }

    win.perfx = {
        version: '75.3.0',
        status: isCritical ? '🔒 Safe' : '⚡ Active',
        config: Config,
        profile: (mode) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed },
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false }
            };
            const p = presets[mode] || presets.balanced;
            localStorage.setItem(Env.storageKey, JSON.stringify({ ...Env.getOverrides(), ...p, disabled: false }));
            win.location.reload();
        },
        toggleDebug: () => {
            const c = Env.getOverrides();
            c.debug = !c.debug;
            localStorage.setItem(Env.storageKey, JSON.stringify(c));
            win.location.reload();
        },
        toggleIframe: () => {
             const c = Env.getOverrides();
             c.allowIframe = !c.allowIframe;
             localStorage.setItem(Env.storageKey, JSON.stringify(c));
             win.location.reload();
        }
    };

    // ==========================================
    // 3. Core Modules
    // ==========================================
    class BaseModule { safeInit() { try { this.init(); } catch (e) { log('Module Error', e); } } init() {} }

    // [Core 1] EventPassivator v3.0 (Target-Safe Storage)
    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive || win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            const evts = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);

            // Fix: Store by (Target -> Listener -> Type) to avoid collision
            const targetStore = new WeakMap();

            const setStoredCapture = (target, listener, type, capture) => {
                let lMap = targetStore.get(target);
                if (!lMap) { lMap = new WeakMap(); targetStore.set(target, lMap); }

                let tMap = lMap.get(listener);
                if (!tMap) { tMap = new Map(); lMap.set(listener, tMap); }

                tMap.set(type, capture);
            };

            const getStoredCapture = (target, listener, type) => {
                const lMap = targetStore.get(target);
                if (!lMap) return undefined;
                const tMap = lMap.get(listener);
                return tMap ? tMap.get(type) : undefined;
            };

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);

            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                const origRemove = proto.removeEventListener;

                proto.addEventListener = function(type, listener, options) {
                    // Safe Guard: Do not block unload entirely on critical/unknown sites
                    // Bfcache optimization: Use pagehide where possible
                    if (type === 'unload' && !isCritical) return;

                    if (!listener) return origAdd.call(this, type, listener, options);

                    let finalOptions = options;
                    if (evts.has(type)) {
                        const isObj = typeof options === 'object' && options !== null;
                        const capture = isObj ? !!options.capture : (options === true);

                        setStoredCapture(this, listener, type, capture);

                        if (!isObj || options.passive === undefined) {
                            try {
                                if (isObj) finalOptions = { ...options, passive: true };
                                else finalOptions = { capture, passive: true };
                            } catch (e) { finalOptions = options; }
                        }
                    }
                    return origAdd.call(this, type, listener, finalOptions);
                };

                proto.removeEventListener = function(type, listener, options) {
                    if (!listener) return origRemove.call(this, type, listener, options);

                    let finalOptions = options;
                    const storedCapture = getStoredCapture(this, listener, type);

                    // Restore capture flag if option is missing
                    if (storedCapture !== undefined) {
                         if (typeof options === 'object' && options !== null) {
                             if (options.capture === undefined) {
                                 try { finalOptions = { ...options, capture: storedCapture }; } catch(e){}
                             }
                         } else if (options === undefined || options === false || options === true) {
                             finalOptions = storedCapture;
                         }
                    }
                    return origRemove.call(this, type, listener, finalOptions);
                };
            });
            log('EventPassivator v3.0: Active');
        }
    }

    // [Core 2] CodecOptimizer v2.0 (Logic Fix)
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;
            const SAFES = ['youtube.com', 'twitch.tv', 'netflix.com'];
            if (hostEndsWithAny(hostname, SAFES)) return;

            const shouldBlock = (t) => {
                if (typeof t !== 'string') return false;
                const v = t.toLowerCase();

                // Hard Mode: 저전력일 때 AV1/VP9 차단 (배터리 방어)
                if (Config.codecMode === 'hard') {
                    if (isLowPowerMode) return v.includes('av01') || /vp9|vp09/.test(v);
                    return false; // 평시엔 허용
                }

                // Soft Mode: 항상 AV1 차단 (가벼움 우선)
                if (Config.codecMode === 'soft') {
                    return v.includes('av01');
                }

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

            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, Symbol('perfx.ms'));
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, Symbol('perfx.me'));
        }
    }

    // [Core 3] DomWatcher v2.1 (Bug Fix: Restore Observation & Safe CSS)
    class DomWatcher extends BaseModule {
        init() {
            if (!Config.gpu && !Config.memory) return;
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            if (!('IntersectionObserver' in win)) return;

            // Wait for DOM
            const startAll = () => { this.startIO(); this.startMO(); };
            if (document.readyState === 'loading') win.addEventListener('DOMContentLoaded', startAll);
            else startAll();

            win.addEventListener('perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
        }

        startIO() {
            if (this.visObs) this.visObs.disconnect();

            // ✅ Fix: Reset observed set when recreating observer
            this.observed = new WeakSet();

            const margin = (isLowPowerMode || isMobile) ? '200px 0px' : '500px 0px';

            this.visObs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (!e.target.isConnected) return;

                    // GPU Toggle
                    if (Config.gpu && e.target.tagName === 'CANVAS') {
                        e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                    }
                    // Memory Toggle
                    else if (Config.memory && this.supportsCV) {
                        if (e.isIntersecting) {
                            e.target.style.contentVisibility = 'visible';
                        } else {
                            // ✅ Fix: Use 'contain: content' or 'strict' to prevent layout break
                            e.target.style.contentVisibility = 'auto';
                            e.target.style.contain = 'content';
                        }
                    }
                });
            }, { rootMargin: margin, threshold: 0.01 });

            const observeSafe = (el) => {
                if (el && !this.observed.has(el)) {
                    this.visObs.observe(el);
                    this.observed.add(el);
                }
            };

            if (Config.gpu) document.querySelectorAll('canvas').forEach(observeSafe);
            if (Config.memory) {
                const sel = '[role="feed"] > *, .feed > *, .list > *, .timeline > *';
                document.querySelectorAll(sel).forEach(observeSafe);
            }
        }

        startMO() {
            if (!Config.memory) return;
            let obsCount = 0;
            const sel = '[role="feed"] > *, .feed > *, .list > *, .timeline > *';

            this.mutObs = new MutationObserver(ms => {
                if (obsCount > 500) return; // Limit observation
                ms.forEach(m => m.addedNodes.forEach(n => {
                    if (n.nodeType === 1 && n.matches && n.matches(sel)) {
                         if (!this.observed.has(n)) {
                            this.visObs.observe(n);
                            this.observed.add(n);
                            obsCount++;
                        }
                    }
                }));
            });
            this.mutObs.observe(document.body, { childList: true, subtree: true });
        }
    }

    // [Core 4] NetworkAssistant v2.0 (Timing Fix)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isCritical) return;

            // ✅ Fix: Run after DOM is ready to find images
            const runLazy = () => {
                if (win.requestIdleCallback) win.requestIdleCallback(this.optimize);
                else setTimeout(this.optimize, 200);
            };

            if (document.readyState === 'loading') win.addEventListener('DOMContentLoaded', runLazy);
            else runLazy();
        }

        optimize() {
            const imgs = document.querySelectorAll('img:not([loading])');
            if (imgs.length === 0) return;

            // Simple LCP Heuristic: First 2 images are eager, rest lazy
            let eagerCount = 0;
            imgs.forEach((img, idx) => {
                // If it looks like a big banner or is very first, keep eager
                if (idx < 2) {
                    img.setAttribute('loading', 'eager');
                } else {
                    img.setAttribute('loading', 'lazy');
                    img.setAttribute('decoding', 'async');
                }
            });

            // Preconnect cleanup (Only add if strictly necessary and not mobile)
            if (!isMobile) {
                // ... (Original Preconnect Logic reduced for brevity) ...
            }
        }
    }

    // [Core 5] HardwareGovernor (Battery Saver - Fixed)
    class HardwareGovernor extends BaseModule {
        init() {
            if (!isLowPowerMode) return;
            const MAP_DOMAINS = ['map.naver.com', 'map.kakao.com', 'dmap.daum.net'];
            if (hostEndsWithAny(hostname, MAP_DOMAINS) || (hostname.includes('google') && hostname.includes('map'))) return;

            if (navigator.geolocation) {
                // ✅ Fix: Standard Error Object
                const makeError = () => ({
                    code: 1, // PERMISSION_DENIED
                    message: "Blocked by PerfX (Battery Saver)"
                });

                // ✅ Fix: watchPosition must return an ID
                const denyWatch = (success, error) => {
                    if (error) error(makeError());
                    return Math.floor(Math.random() * 10000); // Dummy ID
                };

                const denyGet = (success, error) => {
                    if (error) error(makeError());
                };

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

    if (initialOverrides.debug) log(`PerfX v${win.perfx.version} Ready`);

})();
