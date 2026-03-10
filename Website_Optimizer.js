// ==UserScript==
// @name        Web 성능 최적화 (v82.0.0 Clean)
// @namespace   http://tampermonkey.net/
// @version     82.0.0-KR-CLEAN
// @description [Clean] 순수 성능 최적화만 — content-visibility, lazy loading, LCP 예측
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

    // [Constants & Hardware]
    const REAL_HW_CONCURRENCY = navigator.hardwareConcurrency ?? 4;
    const REAL_DEVICE_MEMORY = navigator.deviceMemory ?? 4;

    let isFramed = false;
    try { isFramed = win.top !== win.self; } catch { isFramed = true; }

    // [Helpers]
    const safeJsonParse = (str, fallback = null) => {
        try { return JSON.parse(str) ?? fallback; }
        catch { return fallback; }
    };

    // [Simple Storage Wrapper — no LRU]
    const S = {
        get(k) { try { return localStorage.getItem(k); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch {} },
        remove(k) { try { localStorage.removeItem(k); } catch {} },
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

    // [Util]
    const LISTS = {
        BANKS_KR: ['kbstar.com', 'shinhan.com', 'wooribank.com', 'ibk.co.kr', 'nhbank.com', 'kakaobank.com', 'hanabank.com', 'toss.im'],
        GOV_KR: ['gov.kr', 'hometax.go.kr', 'nts.go.kr'],
        OTT_KR: ['youtube.com', 'twitch.tv', 'netflix.com', 'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com'],
        HEAVY_FEEDS: ['twitter.com', 'x.com', 'instagram.com', 'threads.net', 'facebook.com', 'tiktok.com'],
        LAYOUT_KEYWORDS: ['tvwiki', 'noonoo', 'linkkf', 'ani24', 'newtoki', 'mana'],
        CRITICAL_SUB: /^(auth|login|signin|pay|cert|secure|account)\./
    };

    const makeHostMatcher = (list) => {
        const exact = new Set(list);
        return (h) => {
            if (exact.has(h)) return true;
            let idx = h.indexOf('.');
            while (idx !== -1) {
                if (exact.has(h.slice(idx + 1))) return true;
                idx = h.indexOf('.', idx + 1);
            }
            return false;
        };
    };

    const isBankOrGov = makeHostMatcher([...LISTS.BANKS_KR, ...LISTS.GOV_KR]);
    const isOttHost = makeHostMatcher(LISTS.OTT_KR);
    const isHeavyFeedHost = makeHostMatcher(LISTS.HEAVY_FEEDS);

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

    // Bucket & Freshness
    const RE_ID = /^\d+$/;
    const RE_UUID = /^[0-9a-f-]{36}$/i;
    const RE_TOKEN = /^[0-9a-z_-]{20,}$/i;
    const normSeg = (s) => {
        if (RE_ID.test(s)) return ':id';
        if (RE_UUID.test(s)) return ':uuid';
        if (s.length > 24 || RE_TOKEN.test(s)) return ':token';
        return s;
    };
    const getPathBucket = () => win.location.pathname.split('/').filter(Boolean).slice(0, 2).map(normSeg).join('/');

    // Event Bus
    const Bus = {
        on(name, fn, target = win) { target.addEventListener(name, fn); },
        emit(name, detail) { win.dispatchEvent(new CustomEvent(name, { detail })); }
    };

    // BaseModule with AbortController
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

    // Distance Helper
    const viewH = () => win.visualViewport?.height || win.innerHeight;
    const distToViewport = (r) => {
        if (!r) return -1;
        const h = viewH();
        if (r.bottom < 0) return -r.bottom;
        if (r.top > h) return r.top - h;
        return 0;
    };

    // Modern Scheduler
    const scheduler = {
        request(cb, timeout = 200, priority = 'background') {
            if (win.scheduler?.postTask) {
                const ctrl = new AbortController();
                win.scheduler.postTask(() => cb(), { delay: timeout, priority, signal: ctrl.signal }).catch(() => {});
                return { kind: 'postTask', ctrl };
            }
            if (win.requestIdleCallback) return { kind: 'ric', id: win.requestIdleCallback(cb, { timeout }) };
            return { kind: 'timeout', id: setTimeout(cb, timeout) };
        },
        cancel(handle) {
            if (!handle) return;
            try {
                if (handle.kind === 'postTask') handle.ctrl.abort();
                else if (handle.kind === 'ric' && win.cancelIdleCallback) win.cancelIdleCallback(handle.id);
                else if (handle.kind === 'timeout') clearTimeout(handle.id);
            } catch {}
        }
    };

    // Sync Chunk Scan
    const scanInChunks = (list, limit, step, fn) => {
        if (!list || typeof list.length !== 'number' || list.length === 0) return;
        let i = 0;
        const len = list.length;
        const max = Math.min(limit, len);
        const run = () => {
            const end = Math.min(i + step, max);
            for (; i < end; i++) fn(list[i]);
            if (i < max) scheduler.request(run, 0, 'background');
        };
        run();
    };

    const normUrl = (u) => {
        try {
            if (!u || u.startsWith('data:')) return u;
            const url = new URL(u, win.location.href);
            const params = new URLSearchParams(url.search);
            const keep = ['w', 'width', 'h', 'height', 'q', 'quality', 'fmt', 'format'];
            const newParams = new URLSearchParams();
            keep.forEach(k => { if (params.has(k)) newParams.set(k, params.get(k)); });
            return url.origin + url.pathname + (newParams.toString() ? '?' + newParams.toString() : '');
        } catch { return u; }
    };

    // [Constants]
    const FEED_SEL = '[role="feed"], [data-perfx-feed], .feed, .timeline';
    const ITEM_SEL = '[role="article"], [data-perfx-item], article, .item, .post';
    const SUPPORTED_TYPES = new Set(typeof PerformanceObserver !== 'undefined' ? (PerformanceObserver.supportedEntryTypes || []) : []);

    // [Config & State]
    const hostname = win.location.hostname.toLowerCase();
    const getLcpKey = () => `PerfX_LCP_${hostname}:${getPathBucket()}`;
    let LCP_KEY = getLcpKey();

    let RuntimeConfig = {};
    const Env = {
        storageKey: `PerfX_ULTRA_${hostname}`,
        getOverrides() { return safeJsonParse(S.get(this.storageKey), {}); },
        saveOverrides(data) {
            S.set(this.storageKey, JSON.stringify(data));
            RuntimeConfig = { ...RuntimeConfig, ...data };
        }
    };

    RuntimeConfig = Env.getOverrides();
    const debug = !!RuntimeConfig.debug;
    const log = (...args) => debug && console.log('%c[PerfX]', 'color: #00ff00; background: #000; padding: 2px 4px; border-radius: 2px;', ...args);

    const isMobile = win.matchMedia ? win.matchMedia('(pointer:coarse)').matches : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isCritical = isBankOrGov(hostname) || LISTS.CRITICAL_SUB.test(hostname);
    const isLayoutSensitive = LISTS.LAYOUT_KEYWORDS.some(k => hostname.includes(k));
    const isHeavyFeed = isHeavyFeedHost(hostname);
    const isVideoSite = isOttHost(hostname);

    // [Config]
    let Config = {
        passive: false,
        gpu: false,
        memory: false,
        allowIframe: false,
        memoryContainMode: 'safe'
    };

    const calculatedConfig = {
        passive: RuntimeConfig.passive ?? (!isLayoutSensitive),
        gpu: RuntimeConfig.gpu ?? (!isLayoutSensitive && !(REAL_HW_CONCURRENCY < 4)),
        memory: RuntimeConfig.memory ?? (!isLayoutSensitive && !isHeavyFeed),
        allowIframe: RuntimeConfig.allowIframe ?? false,
        memoryContainMode: RuntimeConfig.memoryContainMode || 'safe'
    };

    if (isCritical) Object.assign(calculatedConfig, { passive: false, gpu: false, memory: false, allowIframe: true });

    Object.assign(Config, calculatedConfig);

    // [Perf State]
    const perfState = {
        isLowPowerMode: REAL_HW_CONCURRENCY < 4,
        perfMultiplier: 1.0,
        DOM_CAP: 2000, MEDIA_CAP: 800,
        DOM_MARGIN: '600px 0px', NET_MARGIN: '50% 0px',
        INIT_DOM_SCAN: 300, INIT_MEDIA_SCAN: 600, SCAN_STEP: 100, PROTECT_MS: 3000,
        shouldAggressiveVideo: false
    };

    const computeState = () => {
        const hc = REAL_HW_CONCURRENCY;
        const dm = REAL_DEVICE_MEMORY;
        const saveData = !!navigator.connection?.saveData;
        const net = navigator.connection?.effectiveType || '4g';

        perfState.isLowPowerMode = hc < 4 || saveData;

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

    const refreshPerfState = () => { computeState(); Bus.emit('perfx-power-change'); };

    let rzT = null;
    win.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(refreshPerfState, 200); });
    navigator.connection?.addEventListener?.('change', refreshPerfState);
    computeState();

    // [API]
    const API = {
        shutdownMemory: () => {},
        restartMemory: () => {},
        toggleConfig: (key) => {
            const c = Env.getOverrides();
            c[key] = !c[key];
            Env.saveOverrides(c);
            try { win.location.reload(); } catch {}
        },
        resetAll: () => {
            S.clearPrefix(['PerfX_', 'perfx-']);
            try { win.location.reload(); } catch {}
        },
        showStatus: () => {
            const info = `[PerfX v82.0.0 Clean]\nURL: ${getPathBucket()}\nPower: ${perfState.isLowPowerMode ? 'LOW' : 'HIGH'}\nCaps: DOM=${perfState.DOM_CAP}, MEDIA=${perfState.MEDIA_CAP}\nModules: M=${Config.memory} G=${Config.gpu}`;
            if (typeof GM_notification !== 'undefined') GM_notification({ title: 'PerfX Status', text: info, timeout: 5000 });
            else console.log(info);
        }
    };

    // [Menu Commands]
    if (typeof GM_registerMenuCommand !== 'undefined') {
        if (RuntimeConfig.disabled) {
            GM_registerMenuCommand('✅ 최적화 켜기', () => API.toggleConfig('disabled'));
        } else {
            GM_registerMenuCommand('❌ 최적화 끄기 (영구)', () => API.toggleConfig('disabled'));
            GM_registerMenuCommand('🧹 설정 초기화', API.resetAll);
            GM_registerMenuCommand('📊 현재 상태 보기', API.showStatus);
        }
    }

    if (RuntimeConfig.disabled) return;
    if (isFramed && !Config.allowIframe) return;

    // [LCP Tracking — 순수 성능 최적화]
    let lcpWriteT = null;
    const persistLCP = () => { if (RuntimeConfig._lcp) S.set(LCP_KEY, RuntimeConfig._lcp); };
    const schedulePersistLCP = () => { clearTimeout(lcpWriteT); lcpWriteT = setTimeout(persistLCP, 1200); };

    // LCP via PerformanceObserver
    if (SUPPORTED_TYPES.has('largest-contentful-paint')) {
        try {
            const po = new PerformanceObserver((list) => {
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
            po.observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {}
    }

    // LCP fallback: hero image detection
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
                if (area > maxArea) { maxArea = area; heroUrl = img.currentSrc || img.src; }
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

    // [SPA Route Detection — popstate/hashchange/pageshow only, no History patching]
    let lastKey = LCP_KEY;
    let lastRouteSignal = 0;

    const emitRoute = (force) => {
        const now = Date.now();
        if (force || now - lastRouteSignal > 1000) {
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
            RuntimeConfig._lcp = S.get(LCP_KEY) || null;
            emitRoute(true);
            detectHeroImage();
        } else {
            emitRoute(false);
        }
    };

    win.addEventListener('popstate', onRoute);
    win.addEventListener('hashchange', onRoute);
    win.addEventListener('pageshow', (e) => { if (e.persisted) Bus.emit('perfx-route', { force: true }); });
    win.addEventListener('pagehide', persistLCP);

    // Persist LCP on visibility change
    document.addEventListener('visibilitychange', () => { if (document.hidden) persistLCP(); });

    if (debug) win.perfx = { version: '82.0.0', config: Config, ...API };

    // ==========================================
    // Core Modules
    // ==========================================

    // [Core 1] DomWatcher (content-visibility)
    class DomWatcher extends BaseModule {
        init() {
            if (isCritical) return;
            this.supportsCV = 'contentVisibility' in document.documentElement.style;
            this.supportsCISAuto = !!(win.CSS?.supports?.('contain-intrinsic-size', 'auto 1px auto 1px'));

            if (Config.memory && !this.supportsCV) Config.memory = false;
            if (!('IntersectionObserver' in win)) return;

            this.styleMap = new WeakMap();
            this.optimized = new WeakSet();
            this.restoreRefs = [];
            this.removedQueue = new Set();
            this.gcTimer = null;

            API.shutdownMemory = () => {
                if (this.mutObs) { this.mutObs.disconnect(); this.mutObs = null; }
                if (this.visObs) { this.visObs.disconnect(); this.visObs = null; }
                if (this.gcTimer) { scheduler.cancel(this.gcTimer); this.gcTimer = null; }

                if (this.restoreRefs.length > 0) {
                    const refs = this.restoreRefs.splice(0);
                    const processRestore = () => {
                        const chunk = refs.splice(0, 100);
                        for (const ref of chunk) {
                            const el = ref.deref();
                            if (el) this.restoreStyle(el);
                        }
                        if (refs.length > 0) scheduler.request(processRestore);
                    };
                    processRestore();
                }
                if (Config.gpu) this.startIO();
            };

            API.restartMemory = () => {
                if (Config.memory) { this.startIO(); this.startMO(); }
                else if (Config.gpu) { this.startIO(); }
            };

            onReady(() => { if (Config.memory || Config.gpu) { this.startIO(); this.startMO(); } });

            this.on(win, 'perfx-power-change', () => {
                if (this.ioTimeout) clearTimeout(this.ioTimeout);
                this.ioTimeout = setTimeout(() => this.startIO(), 1000);
            });
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
            if (this.styleMap.has(el) || this.optimized.has(el)) return;
            if (!this.isOptimizable(el, rect)) return;

            const style = getComputedStyle(el);
            if (style.position === 'sticky' || style.position === 'fixed') return;
            if (/(auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) return;

            this.styleMap.set(el, { cv: el.style.contentVisibility, contain: el.style.contain, cis: el.style.containIntrinsicSize });
            this.optimized.add(el);
            if (typeof WeakRef !== 'undefined') this.restoreRefs.push(new WeakRef(el));

            const w = Math.min(2000, Math.ceil(rect.width)), h = Math.min(2000, Math.ceil(rect.height));
            el.style.contentVisibility = 'auto';
            if (this.supportsCISAuto) el.style.containIntrinsicSize = `auto ${Math.max(1, w)}px auto ${Math.max(1, h)}px`;
            else el.style.containIntrinsicSize = `${Math.max(1, w)}px ${Math.max(1, h)}px`;
            el.style.contain = Config.memoryContainMode === 'aggressive' ? 'layout paint' : 'paint';
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
            if (!document.body) { onReady(() => this.startIO()); return; }

            this.obsCount = 0;
            this.observed = new WeakSet();

            this.visObs = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (!e.target.isConnected) return;
                    if (Config.gpu && e.target.tagName === 'CANVAS') {
                        e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                    } else if (Config.memory && this.supportsCV) {
                        if (e.isIntersecting) this.restoreStyle(e.target);
                        else this.applyOptimization(e.target, e.boundingClientRect);
                    }
                });
            }, { rootMargin: perfState.DOM_MARGIN, threshold: 0.01 });

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
                if (root.tagName !== 'BODY') scanInChunks(queryFeedItems(root), 50, perfState.SCAN_STEP, this.observeSafe);
            }
        }

        startMO() {
            if (!Config.memory) return;
            if (!document.body) { onReady(() => this.startMO()); return; }
            if (this.mutObs) this.mutObs.disconnect();

            const target = document.querySelector(FEED_SEL) || document.body;
            this.mutObs = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (this.obsCount < perfState.DOM_CAP) {
                        m.addedNodes.forEach(n => {
                            if (n.nodeType === 1 && ['DIV', 'SECTION', 'ARTICLE', 'LI'].includes(n.tagName)) {
                                this.observeSafe(n);
                                if (n.childElementCount > 0) scanInChunks(n.querySelectorAll(ITEM_SEL), 50, perfState.SCAN_STEP, this.observeSafe);
                            }
                        });
                    }
                    m.removedNodes.forEach(n => { if (n.nodeType === 1) this.removedQueue.add(n); });
                });
                if (this.removedQueue.size > 0 && !this.gcTimer) {
                    this.gcTimer = scheduler.request(() => this.flushRemoved(), 200);
                }
            });
            this.mutObs.observe(target, { childList: true, subtree: true });
        }

        destroy() {
            super.destroy();
            if (this.mutObs) this.mutObs.disconnect();
            if (this.visObs) this.visObs.disconnect();
            if (this.gcTimer) scheduler.cancel(this.gcTimer);
        }
    }

    // [Core 2] NetworkAssistant (lazy loading + LCP preload)
    class NetworkAssistant extends BaseModule {
        init() {
            if (isCritical) return;

            const seenState = new WeakMap();
            const distMap = new WeakMap();
            const observing = new Set();
            let imgSlots = 0, vidSlots = 0, MAX_IMG = 0, MAX_VID = 0, vpObs = null, currentGen = 0;
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
                } catch { try { img.setAttribute('fetchpriority', value); } catch {} }
            };

            const isAuthorCriticalImage = (img) => {
                if (!img) return false;
                const loading = (img.getAttribute('loading') || '').toLowerCase();
                const fp = getFetchPriority(img);
                return loading === 'eager' || fp === 'high' || !!img.closest?.('[data-perfx-critical]');
            };

            const setImgLazy = (img, setPriority = true) => {
                if (!img || img.complete || isAuthorCriticalImage(img)) return;
                const currentLoading = (img.getAttribute('loading') || '').toLowerCase();
                const currentFP = getFetchPriority(img);
                if (!currentLoading) img.loading = 'lazy';
                if (!img.hasAttribute('decoding')) img.decoding = 'async';
                if (setPriority && !currentFP) setFetchPrioritySafe(img, 'low');
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
                        const vA = distMap.get(a) ?? -1, vB = distMap.get(b) ?? -1;
                        return (vB === -1 ? 0 : vB) - (vA === -1 ? 0 : vA);
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
                        if (e.isIntersecting) seenState.set(el, { gen: currentGen, near: true });
                        else {
                            seenState.set(el, { gen: currentGen, near: false });
                            applyLazy(el, e.boundingClientRect);
                        }
                        vpObs.unobserve(el);
                        decSlot(el);
                    });
                }, { rootMargin: perfState.NET_MARGIN });

                observing.forEach(el => vpObs.observe(el));
                imgSlots = 0;
                vidSlots = 0;
                observing.forEach(el => { if (el.tagName === 'VIDEO') vidSlots++; else imgSlots++; });
            };

            this.on(win, 'perfx-power-change', rebuildObserver);
            this.on(win, 'perfx-lcp-update', (e) => { lcpUrlCached = e.detail?.url || lcpUrlCached; });

            this.on(win, 'perfx-route', (e) => {
                lcpUrlCached = RuntimeConfig._lcp || S.get(LCP_KEY) || null;
                if (e.detail?.force) {
                    currentGen++;
                    observing.forEach(el => { try { vpObs.unobserve(el); } catch {} });
                    observing.clear();
                    rebuildObserver();
                }
                startProtection(e.detail?.force);
            });

            onReady(() => { startProtection(true); rebuildObserver(); });

            const safeObserve = (el) => {
                if (!vpObs || observing.has(el)) return;
                const isVid = el.tagName === 'VIDEO';
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
                batchQueue.set(node, batchQueue.get(node) || fromMutation);
                if (!batchTimer) batchTimer = scheduler.request(flushQueue, 200);
            };

            const run = () => {
                rebuildObserver();
                scanInChunks(document.getElementsByTagName('img'), perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
                scanInChunks(document.getElementsByTagName('video'), perfState.INIT_MEDIA_SCAN, perfState.SCAN_STEP, (n) => scheduleNode(n, false));
            };
            onReady(run);

            this.mo = new MutationObserver(ms => {
                ms.forEach(m => {
                    if (m.addedNodes.length === 0) return;
                    m.addedNodes.forEach(n => {
                        if (n.tagName === 'IMG' || n.tagName === 'VIDEO' || n.tagName === 'IFRAME') scheduleNode(n, true);
                        else if (n.nodeType === 1 && n.getElementsByTagName) {
                            const i = n.getElementsByTagName('img'), v = n.getElementsByTagName('video');
                            if (i.length) scanInChunks(i, 300, perfState.SCAN_STEP, (child) => scheduleNode(child, true));
                            if (v.length) scanInChunks(v, 100, perfState.SCAN_STEP, (child) => scheduleNode(child, true));
                        }
                    });
                    m.removedNodes.forEach(n => {
                        if (n.nodeType === 1) {
                            if (n.tagName === 'IMG' || n.tagName === 'VIDEO') decSlot(n);
                            else if (n.getElementsByTagName) {
                                const i = n.getElementsByTagName('img'), v = n.getElementsByTagName('video');
                                if (i.length) scanInChunks(i, 300, perfState.SCAN_STEP, decSlot);
                                if (v.length) scanInChunks(v, 100, perfState.SCAN_STEP, decSlot);
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

            this.on(win, 'pagehide', (e) => { if (!e.persisted && vpObs) vpObs.disconnect(); });
        }

        destroy() {
            super.destroy();
            if (this.mo) this.mo.disconnect();
        }
    }

    // [Module Init]
    onPageActivated(() => {
        [
            new DomWatcher(),
            new NetworkAssistant()
        ].forEach(m => m.safeInit ? m.safeInit() : (m.init && m.init()));

        onReady(detectHeroImage);

        if (debug) log('PerfX v82.0.0 Clean Ready');
    });

})();
