// ==UserScript==
// @name        Web 성능 최적화 (v73.0 ULTRA Infinity Final Complete)
// @namespace   http://tampermonkey.net/
// @version     73.0.0-KR-ULTRA-Infinity-Final-Complete
// @description [Infinity] 끝없는 최적화 + Final Complete (Symbol Integrity, Anti-Flicker, Robust Debug)
// @author      KiwiFruit
// @match       *://*/*
// @grant       unsafeWindow
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    if (performance && performance.mark) performance.mark('perfx-start');

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    
    // [Debug System]
    const log = (...args) => win.perfx?.debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    // rIC Polyfill
    const rIC = win.requestIdleCallback
        ? (cb) => win.requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => {
            const start = Date.now();
            return setTimeout(() => cb({
                didTimeout: false,
                timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
            }), 50);
        };

    // ==========================================
    // 1. Critical Domain & Device Detection
    // ==========================================
    const hostname = win.location.hostname.toLowerCase();

    const CRITICAL_DOMAINS = [
        'gov.kr', 'hometax.go.kr', 'nts.go.kr',
        'kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr',
        'nhbank.com', 'hanabank.com', 'kakaobank.com', 'tossbank.com',
        'kiwoom.com', 'miraeasset.com', 'samsungpop.com', 'daishin.com',
        'auth.kakao.com', 'service.kakao.com', 'cert.signkorea.com', 'kftc.or.kr',
        'inicis.com', 'nicepay.co.kr', 'payco.com', 'smartstore.naver.com', 'order.pay.naver.com',
        'pay.naver.com', 'kakaopay.com', 'tosspayments.com',
        'nid.naver.com', 'accounts.google.com', 'appleid.apple.com',
        'upbit.com', 'binance.com', 'bithumb.com', 'coinone.co.kr',
        'paypal.com', 'stripe.com',
        'kakao.com', 'naver.com', 'google.com'
    ];

    const isCritical = (() => {
        const criticalSet = new Set(CRITICAL_DOMAINS);
        if (criticalSet.has(hostname)) return true;
        for (const d of CRITICAL_DOMAINS) {
            if (hostname.endsWith('.' + d)) return true;
        }
        return false;
    })();

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const IS_LAYOUT_SENSITIVE = hostname.includes('tvwiki') ||
                                ['noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'].some(k => hostname.includes(k));

    const HEAVY_FEEDS = ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'youtube.com'];
    const isHeavyFeed = HEAVY_FEEDS.some(d => hostname === d || hostname.endsWith('.' + d));

    // ==========================================
    // 2. Global State & Battery Logic
    // ==========================================
    let isLowPowerMode = (navigator.hardwareConcurrency ?? 2) < 4;

    if ('getBattery' in navigator && typeof navigator.getBattery === 'function') {
        navigator.getBattery().then(battery => {
            const updatePowerState = () => {
                const isSaveMode = 'savePower' in battery ? battery.savePower === true : false;
                if (isSaveMode) isLowPowerMode = true;
                else if (battery.charging) isLowPowerMode = false;
                else isLowPowerMode = battery.level < 0.2;
            };
            updatePowerState();
            battery.addEventListener('levelchange', updatePowerState);
            battery.addEventListener('chargingchange', updatePowerState);
        }).catch(() => {});
    }

    // SPA Router Hook (Idempotent)
    const hookHistory = () => {
        if (history.__perfx_hooked) return;
        history.__perfx_hooked = true;

        const wrap = (type) => {
            const orig = history[type];
            return function() {
                const rv = orig.apply(this, arguments);
                win.dispatchEvent(new Event('perfx-route-change'));
                return rv;
            };
        };
        history.pushState = wrap('pushState');
        history.replaceState = wrap('replaceState');
        win.addEventListener('popstate', () => win.dispatchEvent(new Event('perfx-route-change')));
        log('History API hooked');
    };
    hookHistory();

    // ==========================================
    // 3. Configuration & Overrides
    // ==========================================
    const Env = {
        storageKey: `PerfX_ULTRA_${hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } }
    };

    const initialOverrides = Env.getOverrides();

    let Config;
    if (isCritical) {
        Config = { codecMode: 'off', passive: false, gpu: false, memory: false };
    } else {
        if (IS_LAYOUT_SENSITIVE) {
            Config = {
                codecMode: initialOverrides.codecMode ?? 'hard',
                passive: false,
                gpu: false,
                memory: false
            };
        } else {
            Config = {
                codecMode: initialOverrides.codecMode ?? 'hard',
                passive: initialOverrides.passive ?? true,
                gpu: isMobile ? (initialOverrides.gpu ?? false) : (initialOverrides.gpu ?? true),
                memory: isHeavyFeed ? false : (initialOverrides.memory ?? true)
            };
        }
    }

    win.perfx = {
        version: '73.0.0-KR-ULTRA-Infinity-Final-Complete',
        status: isCritical ? '🔒 Safe Mode' : (IS_LAYOUT_SENSITIVE ? '👻 Ghost Mode' : (isMobile ? '📱 Mobile' : '💻 Desktop')),
        config: Config,
        debug: false,
        isLowPowerMode: () => isLowPowerMode,
        profile: (mode, autoReload = true) => {
            const presets = {
                ultra: { codecMode: 'hard', passive: true, gpu: true, memory: !isHeavyFeed && !IS_LAYOUT_SENSITIVE },
                balanced: { codecMode: 'soft', passive: true, gpu: false, memory: !isHeavyFeed && !IS_LAYOUT_SENSITIVE },
                mobile: { codecMode: 'hard', passive: true, gpu: false, memory: !isHeavyFeed && !IS_LAYOUT_SENSITIVE },
                safe: { codecMode: 'off', passive: false, gpu: false, memory: false }
            };
            const p = presets[String(mode).toLowerCase()];
            if (p) {
                localStorage.setItem(`PerfX_ULTRA_${hostname}`, JSON.stringify(p));
                if (autoReload) win.location.reload();
                return true;
            }
            return false;
        },
        off: () => {
            localStorage.setItem(`PerfX_ULTRA_${hostname}`, JSON.stringify({ codecMode: 'off', passive: false, gpu: false, memory: false }));
            win.location.reload();
        }
    };

    // ==========================================
    // 4. Module System
    // ==========================================
    class BaseModule {
        safeInit() { try { this.init(); } catch (e) { log('Module Error', e); } }
        init() {}
    }

    // ==========================================
    // 5. Core Modules
    // ==========================================

    // [Core 1] 입력 반응속도 부스팅 (Smart Event Detection)
    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive || win.__perfx_evt_patched) return;
            if (IS_LAYOUT_SENSITIVE) return;

            const EXCEPT = ['figma.com', 'miro.com', 'photopea.com', 'excalidraw.com'];
            if (EXCEPT.some(d => hostname === d || hostname.endsWith('.' + d))) return;

            win.__perfx_evt_patched = true;
            const evts = new Set(['touchstart', 'touchmove', 'touchcancel', 'wheel', 'mousewheel']);
            
            // [Final Complete] Symbol Key for Ultimate Integrity
            const OPT_KEY = Symbol.for('__perfx_lastOpts');
            log('EventPassivator enabled with Symbol integrity');

            const targets = [
                win.EventTarget && win.EventTarget.prototype,
                win.Window && win.Window.prototype,
                win.Document && win.Document.prototype,
                win.HTMLElement && win.HTMLElement.prototype
            ].filter(Boolean);

            targets.forEach(proto => {
                const origAdd = proto.addEventListener;
                const origRemove = proto.removeEventListener;

                if (!origAdd || origAdd.__perfx_wrapped) return;

                const perfxAddWrapper = function(type, listener, options) {
                    if (type === 'unload') return; // Bfcache Protection

                    let finalOptions = options;

                    if (evts.has(type)) {
                        const isObj = typeof options === 'object' && options !== null;
                        const capture = isObj ? !!options.capture : (options === true);
                        const once = isObj ? !!options.once : false;
                        
                        let needsPreventDefault = false;
                        if (listener) {
                            try {
                                const fn = typeof listener === 'function'
                                    ? listener
                                    : (listener.handleEvent && typeof listener.handleEvent === 'function' ? listener.handleEvent : null);

                                if (fn) {
                                    const str = fn.toString();
                                    if (str.includes('preventDefault') || str.includes('returnValue')) {
                                        needsPreventDefault = true;
                                    }
                                }
                            } catch (e) {}
                        }

                        let forcePassive = true;
                        if (isObj && 'passive' in options) {
                            forcePassive = options.passive;
                        } else if (needsPreventDefault) {
                            forcePassive = false;
                        }

                        if (isObj && options.passive === undefined) {
                            finalOptions = Object.assign({}, options, { passive: forcePassive });
                        } else if (!isObj) {
                            finalOptions = { capture, once, passive: forcePassive };
                        }
                    }
                    
                    // [Final Complete] Symbol Key 저장 (충돌 확률 0%)
                    if (listener && (typeof listener === 'object' || typeof listener === 'function')) {
                        try { listener[OPT_KEY] = finalOptions; } catch(e) {}
                    }
                    
                    return origAdd.call(this, type, listener, finalOptions);
                };

                perfxAddWrapper.__perfx_wrapped = true;
                proto.addEventListener = perfxAddWrapper;

                const perfxRemoveWrapper = function(type, listener, options) {
                    // [Final Complete] Symbol Key 조회
                    const opt = (listener && listener[OPT_KEY]) || options;
                    return origRemove.call(this, type, listener, opt);
                };
                perfxRemoveWrapper.__perfx_wrapped = true;
                proto.removeEventListener = perfxRemoveWrapper;
            });
        }
    }

    // [Core 2] 미디어 코덱 강제
    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off' || this.hooked) return;
            const SAFES = ['youtube.com', 'twitch.tv', 'netflix.com', 'tving.com', 'wavve.com'];
            if (SAFES.some(d => hostname === d || hostname.endsWith('.' + d))) return;

            let disabled = false;

            const shouldOptimize = (t) => {
                if (typeof t !== 'string') return false;
                const v = t.toLowerCase();
                if (Config.codecMode === 'hard') return v.includes('av01') || /vp9|vp09/.test(v);
                if (Config.codecMode === 'soft') return v.includes('av01');
                return false;
            };

            const hookMS = () => {
                if (disabled || !win.MediaSource || win.MediaSource._perfXHooked) return;
                try {
                    if (typeof win.MediaSource.isTypeSupported !== 'function') throw 0;
                    
                    const orig = win.MediaSource.isTypeSupported.bind(win.MediaSource);
                    win.MediaSource.isTypeSupported = (t) => {
                        if (shouldOptimize(t)) return false;
                        return orig(t);
                    };
                    Object.defineProperty(win.MediaSource, '_perfXHooked', { value: true, configurable: false });
                    log('CodecOptimizer: MediaSource hooked');
                } catch (e) { 
                    disabled = true;
                    // [Final Complete] 디버그 모드에서는 재시도 허용
                    if (win.perfx?.debug) { disabled = false; log('CodecOptimizer error (Debug Mode: Retry active)', e); }
                }
            };

            const hookCPT = () => {
                if (disabled || !win.HTMLMediaElement) return;
                if (win.HTMLMediaElement.prototype._perfXHooked) return;
                try {
                    const orig = win.HTMLMediaElement.prototype.canPlayType;
                    win.HTMLMediaElement.prototype.canPlayType = function(t) {
                        if (shouldOptimize(t)) return '';
                        return orig.call(this, t);
                    };
                    Object.defineProperty(win.HTMLMediaElement.prototype, '_perfXHooked', { value: true, configurable: false });
                    log('CodecOptimizer: HTMLMediaElement hooked');
                } catch (e) { disabled = true; }
            };

            if (!win.MediaSource) {
                Object.defineProperty(win, 'MediaSource', {
                    configurable: true,
                    set(v) {
                        try {
                            Object.defineProperty(win, 'MediaSource', { value: v, writable: true, configurable: false });
                            hookMS();
                        } catch (e) {}
                    }
                });
            } else hookMS();
            hookCPT();
            this.hooked = true;
        }
    }

    // [Core 3] GPU & 메모리 통합 관리자
    class DomWatcher extends BaseModule {
        init() {
            if (IS_LAYOUT_SENSITIVE) return;

            this.observed = new WeakSet();
            this.supportsCV = 'contentVisibility' in document.documentElement.style;

            if (!('IntersectionObserver' in win)) {
                Config.memory = false;
                Config.gpu = false;
                return;
            }

            if (!Config.gpu && !Config.memory) return;
            if (Config.gpu) this.injectWebGL();

            const startAll = () => {
                this.startIO();
                this.startMO();
            };

            if (!document.body) win.addEventListener('DOMContentLoaded', startAll, { once: true });
            else startAll();

            win.addEventListener('pagehide', () => {
                if (this.visObs) this.visObs.disconnect();
                if (this.mutObs) this.mutObs.disconnect();
            });

            win.addEventListener('perfx-route-change', () => {
                if (this.visObs && Config.gpu) {
                    log('Route change detected, rescanning canvases');
                    rIC(() => {
                         document.querySelectorAll('canvas').forEach(c => {
                             if (!this.observed.has(c)) { this.visObs.observe(c); this.observed.add(c); }
                         });
                    });
                }
            });

            win.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    if (this.visObs) this.visObs.disconnect();
                    if (win.gc) { try { win.gc(); } catch {} }
                } else {
                    if (this.visObs) this.startIO();
                }
            });
        }

        injectWebGL() {
            try {
                const hook = (proto) => {
                    const desc = Object.getOwnPropertyDescriptor(proto, 'getContext');
                    if (desc && !desc.writable) return;
                    const orig = proto.getContext;
                    proto.getContext = function(type, options) {
                        if (type && type.includes('webgl')) {
                            const pref = (isLowPowerMode || isMobile) ? 'low-power' : 'high-performance';
                            let hasPowerPref = false;
                            try { hasPowerPref = 'powerPreference' in (win.WebGLContextAttributes?.prototype || {}); } catch(e) {}
                            options = { ...(options || {}) };
                            if (hasPowerPref) options.powerPreference = pref;
                            if (isMobile) Object.assign(options, { desynchronized: false, antialias: false });
                            else Object.assign(options, { desynchronized: true, antialias: false });
                        }
                        return orig.call(this, type, options);
                    };
                };
                hook(HTMLCanvasElement.prototype);
                if (win.OffscreenCanvas) hook(OffscreenCanvas.prototype);
                log('WebGL injected');
            } catch (e) { Config.gpu = false; }
        }

        startIO() {
            if (this.visObs) this.visObs.disconnect();

            const margin = (isLowPowerMode || isMobile) ? '150px 0px' : '400px 0px';
            const queue = new Map();
            let scheduled = false;
            
            log('IntersectionObserver started', { margin });

            this.visObs = new IntersectionObserver(entries => {
                if (entries.length > 300) { queue.clear(); scheduled = false; return; }

                entries.forEach(e => queue.set(e.target, e));
                if (scheduled) return;
                scheduled = true;
                
                rIC(() => {
                    if (document.hidden) { queue.clear(); scheduled = false; return; }
                    if (queue.size > 200) { queue.clear(); scheduled = false; return; }
                    
                    queue.forEach(e => {
                        if (!e.target.isConnected) return;
                        if (e.target.tagName === 'CANVAS' && Config.gpu) e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                        else if (Config.memory && this.supportsCV) {
                            if (e.isIntersecting) { 
                                e.target.style.removeProperty('content-visibility');
                                e.target.style.removeProperty('contain'); 
                            } else { 
                                const rect = e.target.getBoundingClientRect();
                                const h = rect.height || e.target.offsetHeight || 1;
                                e.target.style.containIntrinsicSize = `1px ${Math.ceil(h)}px`; 
                                e.target.style.contain = 'layout paint'; 
                                e.target.style.contentVisibility = 'auto'; 
                            }
                        }
                    });
                    queue.clear(); scheduled = false;
                });
            }, { 
                rootMargin: margin, 
                threshold: 0.01 // [Final Complete] Anti-Flicker (GPU 떨림 방지)
            });

            if (Config.gpu) document.querySelectorAll('canvas').forEach(c => { this.visObs.observe(c); this.observed.add(c); });

            if (Config.memory) {
                rIC(() => {
                    const targets = document.querySelectorAll('[role="feed"] > *, .infinite-scroll > *');
                    for (let i = 0; i < targets.length; i++) {
                        if (i > 300) break;
                        this.visObs.observe(targets[i]);
                    }
                });
            }
        }

        startMO() {
            if (this._moConnected) return;
            this._moConnected = true;

            const selector = '[role="feed"] > *, .infinite-scroll > *';
            const handle = (mutations) => {
                if (isHeavyFeed) return;
                mutations.forEach(m => m.addedNodes.forEach(n => {
                    if (n.nodeType === 1 && this.visObs) {
                        if ((Config.gpu && n.tagName === 'CANVAS') || (Config.memory && n.matches && n.matches(selector))) {
                            this.visObs.observe(n);
                        }
                    }
                }));
            };
            this.mutObs = new MutationObserver(handle);
            
            const moConfig = { childList: true, subtree: isHeavyFeed ? false : true };
            if (document.body) this.mutObs.observe(document.body, moConfig);
            log('MutationObserver connected', moConfig);
        }
    }

    // [Core 4] 네트워크 보조 (Dual Prefetch)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isCritical || win.__perfx_net_done) return;
            if (IS_LAYOUT_SENSITIVE) return;

            win.__perfx_net_done = true;
            rIC(() => {
                document.querySelectorAll('img:not([loading])').forEach(img => {
                    if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
                    img.setAttribute('decoding', 'async');
                });

                if (document.head) {
                    const existing = new Set();
                    document.head.querySelectorAll('link[rel="preconnect"], link[rel="dns-prefetch"]').forEach(l => existing.add(l.href));

                    const origins = new Set();
                    document.querySelectorAll('script[src^="http"], link[rel="stylesheet"][href^="http"]').forEach(el => {
                        try { 
                            const url = new URL(el.src || el.href); 
                            if (url.origin !== win.location.origin && !/doubleclick|googlesyndication|facebook|twitter|criteo|adservice/i.test(url.hostname)) {
                                origins.add(url.origin); 
                            }
                        } catch(e) {}
                    });

                    const MAX_PRECONNECT = isMobile ? 2 : 4;
                    let count = 0;
                    
                    origins.forEach(origin => {
                        if (count >= MAX_PRECONNECT) return;
                        if (!existing.has(origin)) {
                            const link = document.createElement('link');
                            link.rel = 'preconnect'; link.href = origin; link.crossOrigin = 'anonymous';
                            document.head.appendChild(link);
                            const dns = document.createElement('link');
                            dns.rel = 'dns-prefetch'; dns.href = origin;
                            document.head.appendChild(dns);
                            existing.add(origin);
                            count++;
                        }
                    });
                    log(`NetworkAssistant: ${count} origins preconnected`);
                }
            });
        }
    }

    [new EventPassivator(), new CodecOptimizer(), new DomWatcher(), new NetworkAssistant()].forEach(m => m.safeInit());

    rIC(() => { 
        if (performance.mark) { 
            performance.mark('perfx-ready'); 
            performance.measure('perfx-init', 'perfx-start', 'perfx-ready'); 
            log('PerfX Ready');
        } 
    });

})();
