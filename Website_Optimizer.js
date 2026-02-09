// ==UserScript==
// @name        Web 성능 최적화 (v75.0 ULTRA Infinity Autonomous)
// @namespace   http://tampermonkey.net/
// @version     75.0.0-KR-ULTRA-Infinity-Autonomous
// @description [Infinity] 끝없는 최적화 + Autonomous (Self-Tuning, LCP/CLS Guard, Deadlock Free Menu)
// @author      KiwiFruit
// @match       *://*/*
// @grant       unsafeWindow
// @grant       GM_registerMenuCommand
// @grant       GM_setValue
// @grant       GM_getValue
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // [Util] Helpers
    const hostEndsWithAny = (h, list) => list.some(d => h === d || h.endsWith('.' + d));
    const safeJsonParse = (str) => { try { return JSON.parse(str); } catch { return {}; } };

    // [Config] Storage & Env
    const Env = {
        storageKey: `PerfX_ULTRA_${win.location.hostname.toLowerCase()}`,
        getOverrides() { return safeJsonParse(localStorage.getItem(this.storageKey)); }
    };
    const initialOverrides = Env.getOverrides();

    // [Menu System - Deadlock Free]
    // 비활성화 상태여도 메뉴는 등록해야 함 (복구 수단)
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
            return; // ⛔ Core Logic Stop
        }

        GM_registerMenuCommand(`🚫 이 사이트에서 끄기 (영구)`, toggleDisable);
        GM_registerMenuCommand(`⚡ 모드: ${initialOverrides.codecMode || 'Auto'} (Ultra)`, () => win.perfx.profile('ultra'));
        GM_registerMenuCommand(`⚖️ 모드: 균형 (Balanced)`, () => win.perfx.profile('balanced'));
        GM_registerMenuCommand(`🛡️ 모드: 안전 (Safe)`, () => win.perfx.profile('safe'));
        GM_registerMenuCommand(`🖼️ Iframe 허용: ${initialOverrides.allowIframe ? 'ON' : 'OFF'}`, win.perfx.toggleIframe);
        GM_registerMenuCommand(`🐞 디버그: ${initialOverrides.debug ? 'ON' : 'OFF'}`, win.perfx.toggleDebug);
    } else if (initialOverrides.disabled) {
        return;
    }

    // [Safety 0] Crash Guard v2 (Load-based Reset)
    const CRASH_KEY = 'perfx-crash-count';
    try {
        if (new URLSearchParams(win.location.search).has('perfx-off')) return;
        if (sessionStorage.getItem('perfx-off')) return;

        const lastCrash = parseInt(sessionStorage.getItem(CRASH_KEY) || '0');
        if (lastCrash >= 3) {
            console.warn('[PerfX] 🚨 반복적인 크래시 감지. 안전 모드로 전환하거나 비활성화합니다.');
            // 자동 비활성화 대신 Safe 모드로 1회 기회 부여, 그래도 안되면 비활성화
            if (!initialOverrides.codecMode || initialOverrides.codecMode !== 'off') {
                localStorage.setItem(Env.storageKey, JSON.stringify({ ...initialOverrides, codecMode: 'off', passive: false, gpu: false, memory: false }));
                sessionStorage.setItem(CRASH_KEY, '0'); // Safe모드 기회 제공
                win.location.reload();
                return;
            } else {
                // 이미 Safe인데도 터지면 Disable
                localStorage.setItem(Env.storageKey, JSON.stringify({ ...initialOverrides, disabled: true }));
                return;
            }
        }
        sessionStorage.setItem(CRASH_KEY, lastCrash + 1);
        
        // 정상 로드 후 2초 생존 시 카운트 리셋 (오탐 방지)
        win.addEventListener('load', () => {
            setTimeout(() => sessionStorage.removeItem(CRASH_KEY), 2000);
        });
    } catch(e) {}

    // [Autonomous] Performance Observer (Auto-Tuning)
    // LCP/CLS 악화 시 다음 방문 때 자동 다운그레이드
    if (typeof PerformanceObserver !== 'undefined') {
        try {
            let cls = 0;
            new PerformanceObserver((entryList) => {
                for (const entry of entryList.getEntries()) {
                    if (!entry.hadRecentInput) cls += entry.value;
                }
            }).observe({type: 'layout-shift', buffered: true});

            win.addEventListener('visibilitychange', () => {
                if (document.hidden && cls > 0.25) { // CLS 임계점
                    const c = Env.getOverrides();
                    // 이미 Balanced/Safe가 아니면 다운그레이드 예약
                    if (c.codecMode !== 'soft' && c.codecMode !== 'off') {
                        c.codecMode = 'soft'; // Force Balanced next time
                        c.gpu = false; 
                        c.memory = false;
                        c.autoDowngraded = true;
                        localStorage.setItem(Env.storageKey, JSON.stringify(c));
                        console.warn('[PerfX] High CLS detected. Auto-downgrading profile for next visit.');
                    }
                }
            });
        } catch(e) {}
    }

    // [Debug System]
    if (initialOverrides.debug && win.performance?.mark) win.performance.mark('perfx-start');
    const log = (...args) => initialOverrides.debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    const rIC = win.requestIdleCallback
        ? (cb) => win.requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 1 }), 50);

    // ==========================================
    // 1. Critical Domain & Detection
    // ==========================================
    const hostname = win.location.hostname.toLowerCase();
    
    // [Fix] Narrowed Critical Subdomains
    const CRITICAL_DOMAINS = [
        'gov.kr', 'hometax.go.kr', 'nts.go.kr', 
        'kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr', 'nhbank.com', 'kakaobank.com',
        'naver.com', 'kakao.com', 'google.com', 'appleid.apple.com'
    ];
    const CRITICAL_SUB = /^(auth|login|signin|cert|secure)\./; // Reduced scope
    const isCritical = hostEndsWithAny(hostname, CRITICAL_DOMAINS) || CRITICAL_SUB.test(hostname);

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    
    // [Fix] Includes for keywords
    const LAYOUT_KEYWORDS = ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'];
    const IS_LAYOUT_SENSITIVE = LAYOUT_KEYWORDS.some(k => hostname.includes(k));

    const HEAVY_FEEDS = ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'youtube.com'];
    const isHeavyFeed = hostEndsWithAny(hostname, HEAVY_FEEDS);

    // ==========================================
    // 2. State & Config
    // ==========================================
    // [Fix] Simplified Battery Check
    let isLowPowerMode = (navigator.hardwareConcurrency ?? 2) < 4 ||
                         (navigator.connection?.saveData === true) ||
                         (win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);

    const triggerStateChange = () => win.dispatchEvent(new Event('perfx-power-change'));

    if ('getBattery' in navigator) {
        navigator.getBattery().then(b => {
            const update = () => {
                isLowPowerMode = (!b.charging && b.level < 0.2); // Removed savePower
                triggerStateChange();
            };
            update(); b.addEventListener('levelchange', update); b.addEventListener('chargingchange', update);
        }).catch(() => {});
    }

    let isFramed = false;
    try { isFramed = win.top !== win.self; } catch(e) { isFramed = true; }
    if (isFramed && !initialOverrides.allowIframe) return;

    let Config;
    if (isCritical) {
        Config = { codecMode: 'off', passive: false, gpu: false, memory: false };
    } else {
        Config = {
            codecMode: initialOverrides.codecMode ?? 'hard',
            passive: IS_LAYOUT_SENSITIVE ? false : (initialOverrides.passive ?? true),
            gpu: IS_LAYOUT_SENSITIVE ? false : (isMobile ? (initialOverrides.gpu ?? false) : (initialOverrides.gpu ?? true)),
            memory: (isHeavyFeed || IS_LAYOUT_SENSITIVE) ? false : (initialOverrides.memory ?? true)
        };
    }

    win.perfx = {
        version: '75.0.0-KR-ULTRA-Infinity-Autonomous',
        status: isCritical ? '🔒 Safe' : (IS_LAYOUT_SENSITIVE ? '👻 Ghost' : '⚡ Active'),
        config: Config,
        debug: initialOverrides.debug || false,
        profile: (mode) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed },
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false }
            };
            const p = presets[mode] || presets.balanced;
            const current = Env.getOverrides();
            localStorage.setItem(Env.storageKey, JSON.stringify({ ...current, ...p, disabled: false }));
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

    // [Core 1] EventPassivator v2.1 (Safe Option Handling)
    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive || win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            const evts = new Set(['touchstart', 'touchmove', 'touchcancel', 'wheel', 'mousewheel']);
            const optStore = new WeakMap();

            const setStoredCapture = (listener, type, capture) => {
                let m = optStore.get(listener);
                if (!m) { m = new Map(); optStore.set(listener, m); }
                m.set(type, capture);
            };
            const getStoredCapture = (listener, type) => {
                const m = optStore.get(listener);
                return m ? m.get(type) : undefined;
            };

            const targets = [win.EventTarget && win.EventTarget.prototype].filter(Boolean);

            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                const origRemove = proto.removeEventListener;
                
                const needsPDCache = new WeakMap();
                const checkNeedsPD = (listener) => {
                    if (!listener) return false;
                    if (needsPDCache.has(listener)) return needsPDCache.get(listener);
                    let res = false;
                    try {
                        const fn = typeof listener === 'function' ? listener : 
                            (typeof listener?.handleEvent === 'function' ? listener.handleEvent : null);
                        if (fn) {
                            const str = Function.prototype.toString.call(fn);
                            res = str.includes('preventDefault') || str.includes('returnValue');
                        }
                    } catch {}
                    needsPDCache.set(listener, res);
                    return res;
                };

                proto.addEventListener = function(type, listener, options) {
                    if (type === 'unload' || !listener) return origAdd.call(this, type, listener, options);
                    
                    let finalOptions = options;
                    if (evts.has(type)) {
                        const isObj = typeof options === 'object' && options !== null;
                        const capture = isObj ? !!options.capture : (options === true);
                        
                        setStoredCapture(listener, type, capture);
                        
                        if (!isObj || options.passive === undefined) {
                            const forcePassive = !checkNeedsPD(listener);
                            
                            // [Fix] Safe Object Creation
                            try {
                                if (isObj) {
                                    finalOptions = { ...options, passive: forcePassive }; // Spread is safer than assign for getters
                                } else {
                                    finalOptions = { capture, passive: forcePassive };
                                }
                            } catch (e) {
                                finalOptions = options; // Fallback on error
                            }
                        }
                    }
                    return origAdd.call(this, type, listener, finalOptions);
                };

                proto.removeEventListener = function(type, listener, options) {
                    if (!listener) return origRemove.call(this, type, listener, options);
                    
                    const storedCapture = getStoredCapture(listener, type);
                    let finalOptions = options;
                    
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
            log('EventPassivator v2.1: Active');
        }
    }

    // [Core 2] CodecOptimizer (Unique Symbols)
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off') return;
            const SAFES = ['youtube.com', 'twitch.tv', 'netflix.com', 'disneyplus.com'];
            if (hostEndsWithAny(hostname, SAFES)) return;

            const shouldBlock = (t) => {
                if (typeof t !== 'string') return false;
                const v = t.toLowerCase();
                if (Config.codecMode === 'hard' && isLowPowerMode) return v.includes('av01') || /vp9|vp09/.test(v);
                if (Config.codecMode === 'soft' || !isLowPowerMode) return v.includes('av01');
                return false;
            };

            // [Fix] Unique Hook Markers
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

            const HOOK_MS = Symbol('perfx.hook.ms');
            const HOOK_ME = Symbol('perfx.hook.me');

            if (win.MediaSource) hook(win.MediaSource, 'isTypeSupported', false, HOOK_MS);
            if (win.HTMLMediaElement) hook(win.HTMLMediaElement, 'canPlayType', true, HOOK_ME);
        }
    }

    // [Core 3] DomWatcher (Expanded Selectors & Size Guard)
    class DomWatcher extends BaseModule {
        init() {
            if (IS_LAYOUT_SENSITIVE) return;
            if (!Config.gpu && !Config.memory) return;
            
            this.observed = new WeakSet();
            this.styleBackup = new WeakMap();
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            
            if (!('IntersectionObserver' in win)) return;

            const startAll = () => { this.startIO(); this.startMO(); };
            if (!document.body) win.addEventListener('DOMContentLoaded', startAll, { once: true });
            else startAll();

            win.addEventListener('perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });

            win.addEventListener('pagehide', () => {
                if (this.visObs) this.visObs.disconnect();
                if (this.mutObs) this.mutObs.disconnect();
            });
        }

        restoreStyle(el) {
            const b = this.styleBackup.get(el);
            if (!b) {
                el.style.removeProperty('content-visibility');
                el.style.removeProperty('contain');
                el.style.removeProperty('contain-intrinsic-size');
            } else {
                el.style.contentVisibility = b.cv;
                el.style.contain = b.contain;
                el.style.containIntrinsicSize = b.cis;
                this.styleBackup.delete(el);
            }
        }

        applyOptimization(el, rect) {
            // [Fix] Size Guard (Skip small elements)
            if (rect.height < 80 || rect.width < 80) return;

            if (!this.styleBackup.has(el)) {
                this.styleBackup.set(el, {
                    cv: el.style.contentVisibility,
                    contain: el.style.contain,
                    cis: el.style.containIntrinsicSize
                });
            }
            const w = Math.max(1, rect.width || el.offsetWidth || 1);
            const h = Math.max(1, rect.height || el.offsetHeight || 1);
            el.style.containIntrinsicSize = `${Math.ceil(w)}px ${Math.ceil(h)}px`;
            el.style.contain = 'layout paint';
            el.style.contentVisibility = 'auto';
        }

        startIO() {
            if (this.visObs) this.visObs.disconnect();
            const margin = (isLowPowerMode || isMobile) ? '200px 0px' : '500px 0px';
            
            this.visObs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (!e.target.isConnected) { this.visObs.unobserve(e.target); return; }

                    if (Config.gpu && e.target.tagName === 'CANVAS') {
                        e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                    } else if (Config.memory && this.supportsCV) {
                        if (e.isIntersecting) this.restoreStyle(e.target);
                        else this.applyOptimization(e.target, e.boundingClientRect);
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
            
            // [Fix] Expanded Selectors
            if (Config.memory) {
                const sel = '[role="feed"] > *, .feed > *, .list > *, .timeline > *, .infinite-scroll > *';
                document.querySelectorAll(sel).forEach(observeSafe);
            }
        }

        startMO() {
            if (isHeavyFeed || !Config.memory) return;
            let obsCount = 0;
            const sel = '[role="feed"] > *, .feed > *, .list > *, .timeline > *, .infinite-scroll > *';

            const mo = new MutationObserver(ms => {
                if (obsCount > 1000) return;
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
            mo.observe(document.body, { childList: true, subtree: true });
            this.mutObs = mo;
        }
    }

    // [Core 4] NetworkAssistant (Prioritized Preconnect)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isCritical || win.__perfx_net_done || IS_LAYOUT_SENSITIVE) return;
            win.__perfx_net_done = true;

            rIC(() => {
                const imgs = [...document.querySelectorAll('img:not([loading])')];
                if (imgs.length === 0) return;

                const candidates = imgs.map((img, idx) => {
                    const w = parseInt(img.getAttribute('width') || '0');
                    const h = parseInt(img.getAttribute('height') || '0');
                    return { img, idx, score: (w * h) || 0 };
                });

                const scoreSorted = [...candidates].sort((a,b) => b.score - a.score).slice(0, 2);
                const idxSorted = candidates.slice(0, 2);
                const eagerSet = new Set([...scoreSorted, ...idxSorted].map(c => c.img));

                imgs.forEach(img => {
                    if (!eagerSet.has(img)) {
                        img.setAttribute('loading', 'lazy');
                        img.setAttribute('decoding', 'async');
                    }
                });

                if (document.head) {
                    const origins = new Set();
                    const existing = new Set();
                    
                    document.head.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]').forEach(l => {
                        try { existing.add(new URL(l.href).origin); } catch(e){}
                    });

                    const add = (u) => { 
                        try { 
                            const url = new URL(u);
                            if (url.origin !== win.location.origin && !/doubleclick|googlesyndication|facebook|twitter|criteo|adservice|analytics/i.test(url.hostname)) {
                                origins.add(url.origin); 
                            }
                        } catch(e){} 
                    };
                    document.querySelectorAll('script[src^="http"], link[href^="http"]').forEach(el => add(el.src || el.href));

                    // [Fix] Priority Logic
                    const sortedOrigins = [...origins].sort((a, b) => {
                        const score = (o) => {
                            if (o.includes('font')) return 3;
                            if (o.includes('cdn') || o.includes('static')) return 2;
                            if (o.includes('img') || o.includes('image')) return 1;
                            return 0;
                        };
                        return score(b) - score(a);
                    });

                    let count = 0;
                    const MAX = isMobile ? 2 : 4;
                    for (const origin of sortedOrigins) {
                        if (count >= MAX) break;
                        if (!existing.has(origin)) {
                            const l = document.createElement('link');
                            l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
                            document.head.appendChild(l);
                            existing.add(origin);
                            count++;
                        }
                    }
                }
            });
        }
    }

    [new EventPassivator(), new CodecOptimizer(), new DomWatcher(), new NetworkAssistant()].forEach(m => m.safeInit());

    if (initialOverrides.debug) log(`PerfX v${win.perfx.version} Ready`);

})();
