// ==UserScript==
// @name        Web 성능 종합 최적화 도구상자 (v23.7 Diamond Stable)
// @namespace   http://tampermonkey.net/
// @version     23.7.0-KR-Diamond-Stable
// @description [Final] +Map/Form Safety +Idle Purge +Hook Guard +Passive Event Control
// @author      KiwiFruit (Architected by AI & User)
// @match       *://*/*
// @exclude     *://weibo.com/*
// @exclude     *://*.weibo.com/*
// @grant       unsafeWindow
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    // ========================
    // 0. Safety Check
    // ========================
    if (new URLSearchParams(window.location.search).get('perfx_safe') === '1') {
        console.warn('[PerfX] Safe Mode Activated. Script Disabled.');
        return;
    }

    // ========================
    // 1. Core Utils & Env
    // ========================
    const Env = {
        isMobile: /Mobi|Android|iPhone/i.test(navigator.userAgent),
        getNetworkInfo() {
            const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
            const isSlow = conn ? (conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) : false;
            const type = conn ? (conn.effectiveType || '4g') : 'unknown';
            return { isSlow, type, saveData: conn?.saveData };
        },
        storageKey: `PerfX_v23_${window.location.hostname}`,
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } },
        setOverride(key, val) {
            const data = this.getOverrides(); data[key] = val;
            localStorage.setItem(this.storageKey, JSON.stringify(data));
        },
        isMatch(list) { return list.some(d => window.location.hostname.includes(d)); },
        runOnLoad(cb) {
            if (document.documentElement) cb();
            else document.addEventListener('DOMContentLoaded', cb);
        }
    };

    const MasterHeartbeat = {
        tasks: new Map(),
        timer: null,
        addTask(name, interval, fn, skipIfHighLoad = false) {
            this.tasks.set(name, { fn, interval, lastRun: Date.now(), skipIfHighLoad });
            if (!this.timer) this.start();
        },
        removeTask(name) {
            this.tasks.delete(name);
            if (this.tasks.size === 0) this.stop();
        },
        start() { this.timer = setInterval(() => this.tick(), 1000); },
        stop() { clearInterval(this.timer); this.timer = null; },
        tick() {
            if (this.tasks.size === 0) return;
            const now = Date.now();
            this.tasks.forEach(task => {
                if (State.isHighLoad && task.skipIfHighLoad) return;
                const elapsed = now - task.lastRun;
                if (elapsed >= task.interval) {
                    task.fn();
                    task.lastRun = now - (elapsed % task.interval);
                }
            });
        }
    };

    const Scheduler = {
        run: (task, timeout = 1000) => {
            if (window.requestIdleCallback) window.requestIdleCallback(task, { timeout });
            else setTimeout(task, 50);
        }
    };

    class BatchProcessor {
        constructor(processorFn) {
            this.queue = new Set();
            this.processor = processorFn;
            this.isScheduled = false;
        }
        add(item) {
            this.queue.add(item);
            if (!this.isScheduled) {
                this.isScheduled = true;
                Scheduler.run(() => { this.flush(); this.isScheduled = false; });
            }
        }
        flush() {
            const items = Array.from(this.queue);
            this.queue.clear();
            this.processor(items);
        }
    }

    const State = {
        processedNodes: new WeakSet(),
        blockedCount: 0,
        isHighLoad: false,
        longTaskCount: 0,
        totalDrops: 0,
        lastDropSample: 0,
        currentDropRate: 0,
        audioActive: false
    };

    const SmartCache = {
        key: 'perfx_session_cache',
        history: new Set(),
        maxSize: Env.isMobile ? 100 : 200,
        init() {
            try {
                const saved = JSON.parse(sessionStorage.getItem(this.key));
                if (Array.isArray(saved)) this.history = new Set(saved);
            } catch (e) {}
        },
        has(url) {
            if (this.history.has(url)) {
                this.history.delete(url); this.history.add(url);
                return true;
            }
            return false;
        },
        add(url) {
            if (this.history.has(url)) this.history.delete(url);
            this.history.add(url);
            if (this.history.size > this.maxSize) {
                const oldest = this.history.values().next().value;
                this.history.delete(oldest);
            }
            if (!this.saveTimer) {
                this.saveTimer = setTimeout(() => {
                    try { sessionStorage.setItem(this.key, JSON.stringify(Array.from(this.history))); } catch (e) {}
                    this.saveTimer = null;
                }, 1000);
            }
        }
    };
    SmartCache.init();

    const NetworkStatus = Env.getNetworkInfo();

    // ========================
    // 2. Configuration
    // ========================
    const SiteLists = {
        noThrottling: [
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'chzzk.naver.com', 'tv.naver.com', 'tv.kakao.com', 'pandalive.co.kr',
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'disneyplus.com', 'watcha.com', 'ok.ru',
            'gemini.google.com', 'chatgpt.com', 'claude.ai',
            'music.youtube.com', 'spotify.com', 'github.com',
            'reddit.com'
        ],
        noRender: [
            'youtube.com', 'dcinside.com', 'tv.naver.com', 'tvwiki5.net', 'avsee.ru', 'cineaste.co.kr', 'inven.co.kr',
        ],
        heavySPA: [
            'reddit.com', 'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'linkedin.com'
        ],
        drmCritical: [
            'netflix.com', 'disneyplus.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'watcha.com',
            'primevideo.com', 'hbo', 'hulu'
        ],
        disallowCodec: [
            'meet.google.com', 'discord.com', 'zoom.us'
        ],
        // [New] No Passive Events (Maps, Canvas, Games)
        noPassive: [
            'map.naver.com', 'map.kakao.com', 'google.com/maps', 'figma.com', 'miro.com', 'canva.com', 'webtoon', 'agar.io'
        ],
        critical: [
            'bank', 'pay', 'checkout', 'billing', 'console.aws', 'azure.com', 'cloud.google',
            'paypal.com', 'stripe.com', 'toss.im', 'kakao.com/pay', 'naver.com/pay',
            'upbit.com', 'bithumb.com', 'binance.com'
        ]
    };

    const isCritical = Env.isMatch(SiteLists.critical);
    const isDRM = Env.isMatch(SiteLists.drmCritical);
    const isHeavySPA = Env.isMatch(SiteLists.heavySPA);
    // [New] Passive Exclusion Check
    const isNoPassive = Env.isMatch(SiteLists.noPassive);

    const overrides = Env.getOverrides();
    const autoEco = NetworkStatus.isSlow && !Env.isMatch(SiteLists.noThrottling) && !isCritical;

    const rawConfig = {
        codecMode: overrides.codecMode || 'soft',
        throttle: { enabled: !Env.isMatch(SiteLists.noThrottling) && !isCritical && (autoEco || overrides.throttle !== false) },
        motion: { enabled: !Env.isMatch(SiteLists.noRender) && (autoEco || overrides.motion !== false) },
        gpu: { enabled: !Env.isMatch(SiteLists.noRender) && (autoEco || overrides.gpu !== false) },
        image: { enabled: !Env.isMatch(SiteLists.noRender) && (autoEco || overrides.image !== false) },
        prefetch: { enabled: !isHeavySPA && !NetworkStatus.isSlow && !Env.isMatch(SiteLists.noThrottling) && overrides.prefetch !== false },
        prefetchStrategy: overrides.prefetchStrategy || 'prefetch',
        connect: { enabled: overrides.connect !== false },
        memory: { enabled: overrides.memory !== false },
        privacy: { enabled: !isCritical && overrides.privacy !== false },
        stealth: overrides.stealth !== false,
        debug: { enabled: overrides.debug === true }
    };

    if (Env.isMatch(SiteLists.disallowCodec)) rawConfig.codecMode = 'off';
    if (isDRM) rawConfig.codecMode = 'off';

    const Config = Object.freeze(rawConfig);

    class BaseModule {
        safeInit() { try { this.init(); } catch (e) { console.error(`[PerfX] ${this.constructor.name}`, e); } }
        init() {}
    }

    // ========================
    // 4. Systems (Core)
    // ========================

    // [v23.7] Shadow Piercer with Hook Guard
    class ShadowPiercer extends BaseModule {
        static targets = new Set();
        static isPassive = false;
        static onPierce(cb) { this.targets.add(cb); }
        init() {
            if (isCritical) { ShadowPiercer.isPassive = true; return; }
            if (Element.prototype.attachShadow.__perfX_hooked) return; // Hook Guard
            try {
                const origAttach = Element.prototype.attachShadow;
                Element.prototype.attachShadow = function(init) {
                    const root = origAttach.call(this, init);
                    ShadowPiercer.targets.forEach(cb => cb(root));
                    return root;
                };
                Element.prototype.attachShadow.__perfX_hooked = true;
            } catch(e) { ShadowPiercer.isPassive = true; }
        }
    }

    class AdaptiveGovernor extends BaseModule {
        init() {
            if (!window.PerformanceObserver) return;
            try {
                let strain = 0;
                let stabilityStreak = 0;
                MasterHeartbeat.addTask('governor', 2000, () => {
                    strain = Math.max(0, strain * 0.6);
                    const currentDrops = State.totalDrops;
                    const deltaDrops = currentDrops - State.lastDropSample;
                    State.lastDropSample = currentDrops;
                    State.currentDropRate = deltaDrops;
                    if (strain > 2 || deltaDrops > 5) {
                        stabilityStreak = 0;
                        if (!State.isHighLoad) State.isHighLoad = true;
                    } else if (strain < 0.5 && deltaDrops === 0) {
                        stabilityStreak++;
                        if (State.isHighLoad && stabilityStreak >= 2) {
                            State.isHighLoad = false;
                            stabilityStreak = 0;
                        }
                    } else { stabilityStreak = 0; }
                }, false);
                const observer = new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    State.longTaskCount += entries.length;
                    strain += entries.length;
                });
                observer.observe({ entryTypes: ['longtask'] });
            } catch(e) {}
        }
    }

    class NavigationHandler {
        static listeners = [];
        static onNavigate(cb) { this.listeners.push(cb); }
        static init() {
            let lastUrl = location.href;
            const check = () => {
                if (location.href !== lastUrl) {
                    lastUrl = location.href;
                    NavigationHandler.listeners.forEach(cb => cb());
                }
            };
            const wrap = (type) => {
                const orig = history[type];
                return function () {
                    const res = orig.apply(this, arguments);
                    check();
                    return res;
                };
            };
            history.pushState = wrap('pushState');
            history.replaceState = wrap('replaceState');
            window.addEventListener('popstate', check);
            Env.runOnLoad(() => {
                const title = document.querySelector('title');
                if (title) new MutationObserver(check).observe(title, { childList: true });
            });
        }
    }

    class ToastManager {
        static show(message, type = 'info') {
            const container = document.getElementById('perfx-toast-container') || this.createContainer();
            const toast = document.createElement('div');
            toast.textContent = message;
            Object.assign(toast.style, {
                background: 'rgba(30,30,30,0.95)', color: type === 'warn' ? '#FF5252' : '#fff',
                padding: '12px 20px', marginBottom: '10px', borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontSize: '13px', fontFamily: 'sans-serif',
                opacity: '0', transform: 'translateY(20px)', transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                borderLeft: `4px solid ${type === 'warn' ? '#FF5252' : '#4CAF50'}`, backdropFilter: 'blur(4px)'
            });
            container.appendChild(toast);
            requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; });
            setTimeout(() => {
                toast.style.opacity = '0'; toast.style.transform = 'translateY(10px)';
                setTimeout(() => toast.remove(), 300);
            }, 2500);
        }
        static createContainer() {
            const div = document.createElement('div');
            div.id = 'perfx-toast-container';
            Object.assign(div.style, {
                position: 'fixed', bottom: '80px', left: '50%', transform: 'translateX(-50%)',
                zIndex: '2147483647', display: 'flex', flexDirection: 'column', alignItems: 'center', pointerEvents: 'none'
            });
            (document.documentElement || document.body).appendChild(div);
            return div;
        }
    }

    class VideoInspector {
        static getStatus() {
            const videos = Array.from(document.querySelectorAll('video'));
            if (videos.length === 0) {
                State.audioActive = false;
                if (window.location.href.match(/(live|play|watch)/)) return { active: true, loading: true, msg: 'Waiting for stream...' };
                return { active: false, msg: 'No Active Video' };
            }
            videos.sort((a, b) => {
                const sizeA = a.offsetWidth * a.offsetHeight;
                const sizeB = b.offsetWidth * b.offsetHeight;
                if (sizeA !== sizeB) return sizeB - sizeA;
                return (!b.paused) - (!a.paused);
            });
            const v = videos[0];
            const isPlaying = !v.paused;
            State.audioActive = isPlaying;
            const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : {};
            const drop = q.droppedVideoFrames || 0;
            State.totalDrops = drop;
            const w = v.videoWidth;
            const h = v.videoHeight;
            if (w === 0) return { active: true, loading: true, msg: isPlaying ? 'Stream Loading...' : 'Ready (Buffering)' };

            let policyMsg = Config.codecMode === 'hard' ? 'H.264 Forced' : (Config.codecMode === 'soft' ? 'VP9 Allowed' : 'Native');
            const isLive = v.duration === Infinity;
            const dropThreshold = isLive ? 15 : 5;
            const isBad = drop > dropThreshold;
            return { active: true, loading: false, res: `${w}x${h}`, drop: drop, policy: policyMsg, isBad: isBad };
        }
    }

    // ========================
    // 5. Logic Modules
    // ========================

    class PrivacySaver extends BaseModule {
        init() {
            if (!Config.privacy.enabled || isCritical) return;
            const TRACKERS = ['google-analytics', 'googletagmanager', 'doubleclick', 'facebook.com/tr', 'connect.facebook', 'clarity.ms', 'hotjar', 'mixpanel', 'segment.com'];
            const isTracker = (url) => url && TRACKERS.some(t => url.includes(t));
            try {
                const origBeacon = navigator.sendBeacon;
                if (origBeacon) {
                    navigator.sendBeacon = function (url, data) {
                        if (isTracker(url)) { State.blockedCount++; return true; }
                        return origBeacon.call(this, url, data);
                    };
                }
            } catch (e) {}
        }
    }

    class CodecOptimizer extends BaseModule {
        init() {
            if (Config.codecMode === 'off' || isDRM) return;
            const hook = () => {
                if (!window.MediaSource || window.MediaSource._perfXHooked) return;
                const orig = window.MediaSource.isTypeSupported.bind(window.MediaSource);
                const cache = new Map();
                window.MediaSource.isTypeSupported = (t) => {
                    if (!t) return false;
                    if (cache.has(t)) return cache.get(t);
                    if (cache.size > 50) cache.clear();
                    let result = true;
                    if (Config.codecMode === 'soft' && t.toLowerCase().includes('av01')) result = false;
                    else if (Config.codecMode === 'hard' && t.toLowerCase().match(/vp9|vp09|av01/)) result = false;
                    if (result) result = orig(t);
                    cache.set(t, result);
                    return result;
                };
                window.MediaSource._perfXHooked = true;
                console.log(`[PerfX] Codec Hooked (${Config.codecMode})`);
            };
            hook();
            if (!window.MediaSource) {
                Object.defineProperty(window, 'MediaSource', {
                    configurable: true, set: (v) => { delete window.MediaSource; window.MediaSource = v; hook(); }
                });
            }
        }
    }

    class BackgroundThrottler extends BaseModule {
        init() {
            if (!Config.throttle.enabled || isCritical) return;
            if (window.__perfXRafWrapped) return;
            window.__perfXRafWrapped = true;
            const origRAF = window.requestAnimationFrame;
            let isHidden = false;
            const checkState = () => {
                isHidden = document.hidden || !document.hasFocus();
                if (!Config.stealth) document.title = (isHidden ? '💤 ' : '') + document.title.replace(/^💤 /, '');
            };
            try {
                const wrapper = function requestAnimationFrame(callback) {
                    if (isHidden) {
                        if (State.audioActive) return origRAF(callback);
                        const delay = State.isHighLoad ? 500 : 350;
                        return setTimeout(() => { try { callback(performance.now()); } catch(e){} }, delay);
                    }
                    return origRAF(callback);
                };
                wrapper.toString = () => 'function requestAnimationFrame() { [native code] }';

                Object.defineProperty(window, 'requestAnimationFrame', {
                    configurable: true, writable: true, value: wrapper
                });
            } catch (e) {}
            document.addEventListener('visibilitychange', checkState);
            window.addEventListener('blur', checkState);
            window.addEventListener('focus', checkState);
            checkState();
        }
    }

    class StyleInjector extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                let css = '';
                if (Config.motion.enabled) {
                    css += `html[data-perfx-motion="off"] *:not(input):not(textarea):not(select):not([role="progressbar"]):not([class*="loading"]):not([class*="spinner"]):not([class*="progress"]):not([class*="loader"]) { animation-duration: 0.001s !important; transition-duration: 0.001s !important; scroll-behavior: auto !important; } `;
                    document.documentElement.setAttribute('data-perfx-motion', 'off');
                }
                if (Config.gpu.enabled) css += `.gpu-acc { transform: translateZ(0); } header, nav, .sticky { transform: translateZ(0); } `;
                if (css) { const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style); }
            });
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            if (!Config.image.enabled) return;
            const obs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const node = e.target;
                        Scheduler.run(() => {
                            if (State.processedNodes.has(node)) return;
                            if (node.tagName === 'IMG') {
                                if (!node.hasAttribute('loading')) node.loading = 'lazy';
                                if (!node.hasAttribute('decoding')) node.decoding = 'async';
                                State.processedNodes.add(node);
                            }
                        });
                        obs.unobserve(node);
                    }
                });
            }, { rootMargin: '200px' });
            const batcher = new BatchProcessor((nodes) => { nodes.forEach(n => obs.observe(n)); });
            Env.runOnLoad(() => {
                const scan = (n) => {
                    if (n.tagName === 'IMG') batcher.add(n);
                    if (n.querySelectorAll) n.querySelectorAll('img').forEach(img => batcher.add(img));
                };
                scan(document.body);
                ShadowPiercer.onPierce((root) => {
                    scan(root);
                    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(root, {childList:true, subtree:true});
                });
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }

    // [v23.7] Smart Layout Containment + Safe Guard
    class LayoutOptimizer extends BaseModule {
        init() {
            if (!Config.gpu.enabled) return;
            Env.runOnLoad(() => {
                const css = `
                    .perfx-cv-auto { content-visibility: auto; contain-intrinsic-size: 1px 1000px; }
                `;
                const style = document.createElement('style');
                style.textContent = css;
                document.head.appendChild(style);

                const applyCV = (root) => {
                    Scheduler.run(() => {
                        root.querySelectorAll('section, article, .feed, .comments, [role="feed"], [id*="comment"]').forEach(el => {
                            if (State.processedNodes.has(el)) return;
                            // [Safety] Risk B: Table/Form exclusion
                            if (el.closest('form, table, [contenteditable]')) return;
                            if (el.offsetHeight < 300) return;
                            el.classList.add('perfx-cv-auto');
                            State.processedNodes.add(el);
                        });
                    });
                };
                applyCV(document.body);
                ShadowPiercer.onPierce(applyCV);
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.querySelectorAll && applyCV(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }

    // [v23.7] Force Font Display + DRM Safety
    class FontTurbo extends BaseModule {
        init() {
            // [Safety] Risk C: DRM exclusion
            if (isCritical || isDRM) return;
            Env.runOnLoad(() => {
                if (document.fonts) {
                    document.fonts.ready.then(() => {
                        document.fonts.forEach(face => {
                            if (face.family.match(/icon|symbol|awesome/i)) return;
                            if (face.display !== 'swap') face.display = 'swap';
                        });
                    });
                }
                const style = document.createElement('style');
                style.textContent = `@font-face { font-display: swap; }`;
                document.head.appendChild(style);
            });
        }
    }

    // [v23.7] Force Passive + Map/Game Exclusion
    class EventPassivator extends BaseModule {
        init() {
            // [Safety] Risk A: Map/Canvas exclusion
            if (isCritical || isNoPassive) return;
            try {
                const events = ['touchstart', 'touchmove', 'wheel', 'mousewheel'];
                const originalAdd = EventTarget.prototype.addEventListener;
                EventTarget.prototype.addEventListener = function(type, listener, options) {
                    let useCapture = options;
                    if (events.includes(type)) {
                        if (typeof options === 'object' && options !== null) {
                            if (options.passive === undefined) options.passive = true;
                        } else {
                            useCapture = options;
                            options = { passive: true, capture: typeof useCapture === 'boolean' ? useCapture : false };
                        }
                    }
                    return originalAdd.call(this, type, listener, options);
                };
                console.log('[PerfX] Passive Events Enforced');
            } catch(e) { }
        }
    }

    class LinkPrefetcher extends BaseModule {
        init() {
            if (!Config.prefetch.enabled) return;
            const relType = (Config.prefetchStrategy === 'prerender' && (navigator.connection?.effectiveType === '4g')) ? 'prerender' : 'prefetch';
            const MAX_PREFETCH = 15;
            let currentPrefetchCount = 0;
            let lastDecayTime = Date.now();
            const checkDecay = () => {
                if (Date.now() - lastDecayTime > 60000) { if (currentPrefetchCount > 0) currentPrefetchCount--; lastDecayTime = Date.now(); }
            };
            NavigationHandler.onNavigate(() => { currentPrefetchCount = 0; });
            const obs = new IntersectionObserver(entries => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const el = e.target;
                        if (State.processedNodes.has(el)) return;
                        el.addEventListener('mouseenter', () => {
                            checkDecay();
                            if (State.isHighLoad || currentPrefetchCount >= MAX_PREFETCH || SmartCache.has(el.href)) return;
                            try { if (new URL(el.href).origin !== window.location.origin) return; } catch { return; }
                            Scheduler.run(() => {
                                State.processedNodes.add(el);
                                SmartCache.add(el.href);
                                const l = document.createElement('link'); l.rel = relType; l.href = el.href;
                                document.head.appendChild(l);
                                currentPrefetchCount++;
                            });
                        }, {once:true, passive:true});
                        obs.unobserve(el);
                    }
                });
            }, { rootMargin: '200px' });
            const batcher = new BatchProcessor((nodes) => { nodes.forEach(n => obs.observe(n)); });
            Env.runOnLoad(() => {
                const scan = (n) => {
                    if (n.querySelectorAll) {
                        const links = n.querySelectorAll('a[href^="http"]');
                        if (links.length > 0) links.forEach(a => batcher.add(a));
                    }
                };
                scan(document.body);
                ShadowPiercer.onPierce((root) => {
                    scan(root);
                    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(root, {childList:true, subtree:true});
                });
                new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => scan(n)))).observe(document.body, {childList:true, subtree:true});
            });
        }
    }

    // [v23.7] Memory Guardian + Idle-Only Purge
    class MemoryGuardian extends BaseModule {
        init() {
            if (!Config.memory.enabled) return;
            const LIMIT = Env.isMobile ? 600 : 1200;
            const PURGE = Env.isMobile ? 300 : 600;
            const run = (root) => {
                if (!root) return;
                // [Improvement 3] Only purge when user is not looking (Safety)
                if (!document.hidden) return;

                Scheduler.run(() => {
                    root.querySelectorAll('[role="feed"], [role="log"], .chat-scrollable, ul, ol').forEach(el => {
                        if (el.matches(':hover, :focus-within, .virtualized')) return;
                        if (el.dataset.reactroot || Object.keys(el).some(k => k.startsWith('__react'))) return;

                        if (el.scrollHeight <= el.clientHeight * 1.5 || el.scrollTop < el.clientHeight) return;
                        if (el.childElementCount > LIMIT) {
                            try {
                                const removeCount = Math.max(0, Math.min(PURGE, el.childElementCount - 50));
                                if (removeCount > 0) {
                                    const range = document.createRange();
                                    range.setStart(el, 0); range.setEnd(el, removeCount);
                                    range.deleteContents();
                                }
                            } catch(e) {}
                        }
                    });
                });
            };
            // Run interval changed to 30s to reduce overhead
            MasterHeartbeat.addTask('memory', 30000, () => run(document.body), true);
            ShadowPiercer.onPierce((root) => MasterHeartbeat.addTask('memory_shadow', 30000, () => run(root), true));
        }
    }

    class PreconnectOptimizer extends BaseModule {
        init() {
            if (!Config.connect.enabled) return;
            Env.runOnLoad(() => {
                ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'].forEach(d => {
                    const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://' + d; l.crossOrigin = 'anonymous'; document.head.appendChild(l);
                });
            });
        }
    }

    class DebugOverlay extends BaseModule {
        init() {
            if (!Config.debug.enabled) return;
            Env.runOnLoad(() => {
                const hud = document.createElement('div');
                Object.assign(hud.style, {
                    position: 'fixed', top: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: '#0f0',
                    padding: '5px 10px', fontSize: '12px', zIndex: '999999', pointerEvents: 'none', borderRadius: '4px', fontFamily: 'monospace', whiteSpace: 'pre-line'
                });
                document.body.appendChild(hud);
                MasterHeartbeat.addTask('debug_hud', 2000, () => {
                    const status = VideoInspector.getStatus();
                    const loadStatus = State.isHighLoad ? '[High Load]' : '[Stable]';
                    if(status.active) {
                        hud.textContent = `📺 ${status.res} ${loadStatus}\n⚙️ ${status.policy}\n📉 Drop: ${status.drop}`;
                        hud.style.display = 'block';
                    } else hud.style.display = 'none';
                }, true);
            });
        }
    }

    class UIController extends BaseModule {
        init() {
            Env.runOnLoad(() => {
                if (autoEco) ToastManager.show(`🐢 ${NetworkStatus.type.toUpperCase()} 감지: Auto-Eco 모드 가동`, 'warn');
                const btn = document.createElement('div');
                btn.textContent = '⚡';
                const savedPos = JSON.parse(localStorage.getItem('perfx_btn_pos') || '{"bottom":"60px","right":"10px"}');
                Object.assign(btn.style, {
                    position: 'fixed', bottom: savedPos.bottom || 'auto', right: savedPos.right || 'auto', top: savedPos.top || 'auto', left: savedPos.left || 'auto',
                    width: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    height: Env.isMobile ? 'clamp(30px, 6vmin, 38px)' : 'clamp(32px, 7vmin, 44px)',
                    fontSize: Env.isMobile ? 'clamp(18px, 3.5vmin, 22px)' : 'clamp(20px, 4vmin, 26px)',
                    background: autoEco ? '#FF9800' : (isCritical ? '#607D8B' : '#4a90e2'),
                    color: '#FFD700', borderRadius: '50%', zIndex: '2147483647',
                    display: 'flex', justifyContent: 'center', alignItems: 'center',
                    boxShadow: '0 3px 8px rgba(0,0,0,0.4)', opacity: '0.8', userSelect: 'none',
                    cursor: 'pointer', touchAction: 'none'
                });

                const panel = document.createElement('div');
                Object.assign(panel.style, {
                    position: 'fixed', width: '240px', background: 'rgba(25,25,25,0.96)', backdropFilter: 'blur(5px)',
                    borderRadius: '8px', padding: '15px', zIndex: '2147483647', display: 'none', color: '#eee',
                    fontFamily: 'sans-serif', fontSize: '12px', border: '1px solid #444'
                });

                let isDragging = false;
                let startX, startY, initialLeft, initialTop;
                let hasMoved = false;

                const onPointerDown = (e) => {
                    e.stopImmediatePropagation();
                    if (!e.isPrimary) return;
                    isDragging = false; hasMoved = false;
                    const rect = btn.getBoundingClientRect();
                    btn.style.bottom = 'auto'; btn.style.right = 'auto'; btn.style.left = rect.left + 'px'; btn.style.top = rect.top + 'px';
                    startX = e.clientX; startY = e.clientY; initialLeft = rect.left; initialTop = rect.top;

                    btn.setPointerCapture(e.pointerId);
                    btn.addEventListener('pointermove', onPointerMove);
                    btn.addEventListener('pointerup', onPointerUp);
                };

                const onPointerMove = (e) => {
                    if (!hasMoved && (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4)) {
                        isDragging = true; hasMoved = true;
                    }
                    if (isDragging) {
                        let newLeft = Math.max(0, Math.min(initialLeft + (e.clientX - startX), window.innerWidth - btn.offsetWidth));
                        let newTop = Math.max(0, Math.min(initialTop + (e.clientY - startY), window.innerHeight - btn.offsetHeight));
                        btn.style.left = newLeft + 'px'; btn.style.top = newTop + 'px';
                    }
                };

                const onPointerUp = (e) => {
                    btn.removeEventListener('pointermove', onPointerMove);
                    btn.removeEventListener('pointerup', onPointerUp);
                    btn.releasePointerCapture(e.pointerId);

                    if (isDragging) {
                        localStorage.setItem('perfx_btn_pos', JSON.stringify({top: btn.style.top, left: btn.style.left}));
                        if (panel.style.display === 'block') repositionPanel();
                    } else {
                        togglePanel();
                    }
                    isDragging = false;
                };

                btn.addEventListener('pointerdown', onPointerDown);
                btn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); }, { capture: true });

                const repositionPanel = () => {
                    const wasVisible = panel.style.display !== 'none';
                    if (!wasVisible) { panel.style.visibility = 'hidden'; panel.style.display = 'block'; }
                    const btnRect = btn.getBoundingClientRect();
                    const panelWidth = panel.offsetWidth || 270;
                    const panelHeight = panel.offsetHeight || 300;
                    if (!wasVisible) { panel.style.display = 'none'; panel.style.visibility = ''; }
                    let newLeft = btnRect.left - panelWidth - 12;
                    let newTop = btnRect.top;
                    if (newLeft < 10) newLeft = btnRect.right + 12;
                    if (newTop + panelHeight > window.innerHeight) newTop = window.innerHeight - panelHeight - 10;
                    if (newTop < 10) newTop = 10;
                    panel.style.left = newLeft + 'px'; panel.style.top = newTop + 'px'; panel.style.bottom = 'auto'; panel.style.right = 'auto';
                };

                const monitorBox = document.createElement('div');
                monitorBox.style.cssText = 'background:#111; border-radius:6px; padding:8px; margin-bottom:12px; border:1px solid #333; text-align:center; font-family:monospace; color:#4CAF50; white-space:pre-line';
                monitorBox.textContent = 'Ready';
                panel.appendChild(monitorBox);

                const infoRow = document.createElement('div');
                infoRow.style.cssText = 'font-size:10px; color:#aaa; margin-bottom:10px; display:flex; justify-content:space-between; padding:0 4px;';
                const netSpan = document.createElement('span');
                const privacySpan = document.createElement('span');
                infoRow.append(netSpan, privacySpan);
                panel.appendChild(infoRow);

                let localInterval = null;
                const updateMonitor = () => {
                    try {
                        const status = VideoInspector.getStatus();
                        const privacyIcon = isCritical ? '🔒 Safe Site' : `🛡️ ${State.blockedCount}`;
                        const loadIcon = State.isHighLoad ? '🔥 High Load' : '🟢 Stable';
                        netSpan.textContent = `📶 ${NetworkStatus.type.toUpperCase()}`;
                        privacySpan.textContent = `${loadIcon} | ${privacyIcon}` + (ShadowPiercer.isPassive ? ' 🧱' : '');
                        if (status.active) {
                            if (status.loading) { monitorBox.textContent = status.msg; monitorBox.style.color = '#FF9800'; }
                            else {
                                monitorBox.textContent = `📺 ${status.res} | 📉 ${State.currentDropRate}/s\n⚙️ Policy: ${status.policy}`;
                                monitorBox.style.color = status.isBad ? '#FF5252' : '#4CAF50';
                            }
                        } else { monitorBox.textContent = status.msg; monitorBox.style.color = '#777'; }
                    } catch (e) { monitorBox.textContent = 'Error: ' + e.message; monitorBox.style.color = '#FF5252'; }
                };

                const togglePanel = () => {
                    if (panel.style.display === 'none') {
                        repositionPanel(); panel.style.display = 'block'; updateMonitor();
                        localInterval = setInterval(updateMonitor, 500);
                    } else { panel.style.display = 'none'; clearInterval(localInterval); localInterval = null; }
                };

                const titleRow = document.createElement('div');
                titleRow.style.cssText = 'margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px; display:flex; justify-content:space-between; align-items:center';
                const titleContainer = document.createElement('div');
                const titleMain = document.createElement('b'); titleMain.textContent = 'PerfX ';
                const titleVer = document.createElement('span'); titleVer.textContent = 'v23.7 Dia.'; titleVer.style.cssText = 'font-size:10px;color:#aaa';
                titleContainer.append(titleMain, titleVer);
                const closeBtn = document.createElement('span'); closeBtn.textContent = '✖'; closeBtn.style.cursor = 'pointer';
                closeBtn.onclick = () => { panel.style.display = 'none'; clearInterval(localInterval); };
                titleRow.append(titleContainer, closeBtn);
                panel.appendChild(titleRow);

                const addRow = (label, key, val, displayVal, color) => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display:flex; justify-content:space-between; margin-bottom:6px; align-items:center';
                    const labelSpan = document.createElement('span'); labelSpan.textContent = label;
                    const valSpan = document.createElement('span'); valSpan.textContent = displayVal;
                    valSpan.style.fontWeight = 'bold'; valSpan.style.cursor = 'pointer'; valSpan.style.color = color || '#888';
                    valSpan.onclick = () => {
                        if (isCritical && (key === 'privacy' || key === 'throttle')) { ToastManager.show('🔒 Critical Site: Option Locked', 'warn'); return; }
                        if (key === 'codecMode') {
                            const next = val === 'soft' ? 'hard' : (val === 'hard' ? 'off' : 'soft');
                            Env.setOverride(key, next); ToastManager.show(`Codec: ${next.toUpperCase()} (Reload)`, 'info');
                        } else {
                            Env.setOverride(key, !val); ToastManager.show(`${label}: ${!val ? 'ON' : 'OFF'} (Reload)`, !val ? 'info' : 'warn');
                        }
                    };
                    row.append(labelSpan, valSpan);
                    panel.appendChild(row);
                };

                let codecColor = Config.codecMode === 'soft' ? '#4CAF50' : (Config.codecMode === 'hard' ? '#FF9800' : '#888');
                if (Env.isMatch(SiteLists.disallowCodec)) addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, 'FORCE OFF', '#E91E63');
                else addRow('🎥 코덱 모드', 'codecMode', Config.codecMode, Config.codecMode.toUpperCase(), codecColor);

                addRow('🛡️ 트래커 차단', 'privacy', Config.privacy.enabled, Config.privacy.enabled?'ON':'OFF', Config.privacy.enabled?'#4CAF50':'');
                addRow('💤 절전 모드', 'throttle', Config.throttle.enabled, Config.throttle.enabled?'ON':'OFF', Config.throttle.enabled?'#4CAF50':'');
                addRow('🚀 모션 제거', 'motion', Config.motion.enabled, Config.motion.enabled?'ON':'OFF', Config.motion.enabled?'#4CAF50':'');
                addRow('👁️ 렌더링/GPU', 'gpu', Config.gpu.enabled, Config.gpu.enabled?'ON':'OFF', Config.gpu.enabled?'#4CAF50':'');
                addRow('🧹 메모리 청소', 'memory', Config.memory.enabled, Config.memory.enabled?'ON':'OFF', Config.memory.enabled?'#4CAF50':'');
                addRow('📟 디버그 HUD', 'debug', Config.debug.enabled, Config.debug.enabled?'ON':'OFF', Config.debug.enabled?'#2196F3':'');

                (document.documentElement || document.body).append(btn, panel);
            });
        }
    }

    NavigationHandler.init();
    new ShadowPiercer().safeInit();
    new AdaptiveGovernor().safeInit();
    new PrivacySaver().safeInit();
    new CodecOptimizer().safeInit();
    new BackgroundThrottler().safeInit();
    [new StyleInjector(), new ImageOptimizer(), new LayoutOptimizer(), new FontTurbo(), new EventPassivator(),
     new LinkPrefetcher(), new PreconnectOptimizer(), new MemoryGuardian(), new DebugOverlay(), new UIController()
    ].forEach(m => m.safeInit());

})();
