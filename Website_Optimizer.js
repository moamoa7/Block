// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (Ultimate Hybrid v4)
// @namespace    http://tampermonkey.net/
// @version      4.0.0-KR-Hybrid
// @description  웹 브라우징 가속; 애니메이션 제거, 스마트 프리패치, 미디어 자동 정지, BFCache; 트위치/유튜브 최적화
// @author       KiwiFruit (Hybridized by AI)
// @match        *://*/*
// @exclude      *://weibo.com/*
// @exclude      *://*.weibo.com/*
// @grant        none
// @license      MIT
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ========================
    // 1. 환경 감지 및 설정
    // ========================
    const Env = {
        features: {
            nativeLazyLoad: 'loading' in HTMLImageElement.prototype,
            intersectionObserver: 'IntersectionObserver' in window,
            mutationObserver: 'MutationObserver' in window,
            performanceObserver: 'PerformanceObserver' in window,
            requestIdleCallback: 'requestIdleCallback' in window,
            contentVisibility: CSS.supports('content-visibility', 'hidden'),
            webgpu: typeof GPU !== 'undefined' && !!navigator.gpu
        },
        performanceTier: (() => {
            if (navigator.hardwareConcurrency >= 4) return 2;
            if (window.devicePixelRatio <= 1.5) return 1;
            return 0;
        })(),
        networkType: navigator.connection?.effectiveType || 'unknown',
        isTwitch: window.location.hostname.includes('twitch.tv'),
        isYoutube: window.location.hostname.includes('youtube.com')
    };

    const Config = {
        debug: false,
        ui: {
            enabled: true,
            position: 'bottom-right',
            zIndex: 9999,
            autoHideDelay: 3000,
            hoverDelay: 300,
            hideOffset: { bottom: 20, right: -50 },
            showOffset: { bottom: 20, right: 20 },
            statsUpdateTimeout: 2000,
            sampleSize: 200
        },
        lazyLoad: {
            enabled: true,
            selector: 'img[data-src], img[data-original], img.lazy, iframe[data-src], .js-lazy-load',
            preloadDistance: 150
        },
        // [NEW] 동작 줄이기 (애니메이션 제거) - 저사양 PC 필수
        reduceMotion: {
            enabled: true, 
            forceDisableCSS: true
        },
        hardwareAcceleration: {
            enabled: true,
            selector: 'header, nav, aside, .sticky, .fixed, .js-animate, .js-transform',
            skipViewportElements: true,
            delayForVisibleElements: 5000
        },
        contentVisibility: {
            enabled: true,
            selector: 'section, article, .post, .js-section',
            hiddenDistance: 600,
            viewportBuffer: 200,
            streamModeThreshold: 500,
            respectCanvas: true,
            respectWebGPU: true,
            smartViewportCheck: true
        },
        linkPrefetch: {
            enabled: true,
            hoverDelay: 65,
            ignoreSelectors: '[href^="#"], [href^="javascript:"], [href*="logout"], [href*="signout"]'
        },
        mediaSuspend: {
            enabled: true,
            suspendDistance: 200
        },
        backgroundThrottle: {
            enabled: true,
            throttleDelay: 1000
        },
        preconnect: {
            enabled: true,
            domains: ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com']
        },
        blacklistedDomains: ['weibo.com', 'weibo.cn']
    };

    const Logger = {
        log: (module, level, msg) => {
            if (Config.debug || level === 'error') {
                const prefix = `[PerfOpt][${module}]`;
                const methods = { debug: console.log, info: console.info, warn: console.warn, error: console.error };
                methods[level](prefix, msg);
            }
        },
        debug: (m, msg) => Logger.log(m, 'debug', msg),
        info: (m, msg) => Logger.log(m, 'info', msg),
        warn: (m, msg) => Logger.log(m, 'warn', msg),
        error: (m, msg) => Logger.log(m, 'error', msg)
    };

    // ========================
    // 2. 핵심 기본 클래스
    // ========================
    class BaseModule {
        constructor(name) {
            this.moduleName = name;
            this.initialized = false;
            this.mutationObserver = null;
        }

        init() {
            if (this.initialized) return;
            this.initialized = true;
            this.setupMutationObserver();
            Logger.info(this.moduleName, '초기화 완료');
        }

        destroy() {
            if (!this.initialized) return;
            this.initialized = false;
            if (this.mutationObserver) {
                this.mutationObserver.disconnect();
                this.mutationObserver = null;
            }
            Logger.info(this.moduleName, '중지됨');
        }

        emit(event, data = {}) {
            window.dispatchEvent(new CustomEvent(`perfopt:${this.moduleName}:${event}`, {
                detail: { ...data, module: this.moduleName, timestamp: Date.now() }
            }));
        }

        setupMutationObserver() {
            if (!Env.features.mutationObserver) return;
            this.mutationObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    if (mutation.addedNodes.length) {
                        this.handleNewNodes(mutation.addedNodes);
                    }
                }
            });
            this.mutationObserver.observe(document.body, { childList: true, subtree: true });
        }

        handleNewNodes(nodeList) {}
    }

    // ========================
    // 3. [NEW] 모듈: 동작 줄이기 (애니메이션 제거)
    // ========================
    class MotionReducer extends BaseModule {
        constructor() { super('MotionReducer'); }

        init() {
            super.init();
            if (!Config.reduceMotion.enabled) return;
            this.injectStyle();
        }

        injectStyle() {
            const styleId = 'perfopt-no-motion';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            // CPU 부하를 줄이는 핵심 CSS
            style.textContent = `
                *, *::before, *::after {
                    animation: none !important;
                    transition: none !important;
                    scroll-behavior: auto !important;
                }
            `;
            document.head.appendChild(style);
            Logger.info('MotionReducer', '애니메이션 및 트랜지션 제거됨');
        }

        destroy() {
            super.destroy();
            const style = document.getElementById('perfopt-no-motion');
            if (style) style.remove();
        }
    }

    // ========================
    // 4. 모듈: 이미지 지연 로딩
    // ========================
    class ImageOptimizer extends BaseModule {
        constructor() { super('ImageOptimizer'); this.observer = null; }

        init() {
            super.init();
            if (Env.isTwitch) return; 
            if (!Config.lazyLoad.enabled) return;

            if (Env.features.intersectionObserver) {
                this.applyIntersectionObserver();
            } else {
                this.applyNativeLazyLoad();
            }
        }

        applyIntersectionObserver() {
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const el = entry.target;
                        if (el.dataset.src) {
                            el.src = el.dataset.src;
                            delete el.dataset.src;
                            this.observer.unobserve(el);
                        }
                    }
                });
            }, { rootMargin: `${Config.lazyLoad.preloadDistance}px 0px` });
            this.scanAndObserve(document.querySelectorAll(Config.lazyLoad.selector));
        }

        applyNativeLazyLoad() {
            document.querySelectorAll(Config.lazyLoad.selector).forEach(el => el.loading = 'lazy');
        }

        scanAndObserve(elements) {
            elements.forEach(el => {
                if (this.observer) this.observer.observe(el);
            });
        }

        handleNewNodes(nodeList) {
            if (!this.observer) return;
            nodeList.forEach(node => {
                if (node.nodeType === 1) {
                    if (node.matches(Config.lazyLoad.selector)) this.observer.observe(node);
                    node.querySelectorAll(Config.lazyLoad.selector).forEach(el => this.observer.observe(el));
                }
            });
        }

        destroy() {
            super.destroy();
            if (this.observer) { this.observer.disconnect(); this.observer = null; }
        }
    }

    // ========================
    // 5. 모듈: GPU 가속
    // ========================
    class GPUAccelerator extends BaseModule {
        constructor() { super('GPUAccelerator'); }

        init() {
            super.init();
            if (Env.isTwitch) return;
            if (!Config.hardwareAcceleration.enabled) return;
            this.processElements(document.querySelectorAll(Config.hardwareAcceleration.selector));
        }

        processElements(elements) {
            elements.forEach(el => this.applyOptimization(el));
        }

        applyOptimization(element) {
            if (element.classList.contains('gpu-accelerate')) return;
            if (element.closest('.streaming, .generating')) return;
            element.classList.add('gpu-accelerate');
            element.style.transform = 'translateZ(0)';
        }

        handleNewNodes(nodeList) {
            if (Env.isTwitch) return;
            nodeList.forEach(node => {
                if (node.nodeType === 1) {
                    const candidates = node.matches(Config.hardwareAcceleration.selector)
                        ? [node, ...node.querySelectorAll(Config.hardwareAcceleration.selector)]
                        : node.querySelectorAll(Config.hardwareAcceleration.selector);
                    candidates.forEach(el => this.applyOptimization(el));
                }
            });
        }
    }

    // ========================
    // 6. 모듈: 콘텐츠 가시성 (렌더링 최적화)
    // ========================
    class ContentVisibility extends BaseModule {
        constructor() {
            super('ContentVisibility');
            this.scrollListener = null;
            this.processed = new WeakSet();
        }

        init() {
            super.init();
            if (Env.isTwitch) return;
            if (!Config.contentVisibility.enabled || !Env.features.contentVisibility) return;

            this.updateVisibility(document.querySelectorAll(Config.contentVisibility.selector));

            let ticking = false;
            this.scrollListener = () => {
                if (!ticking) {
                    requestAnimationFrame(() => {
                        this.updateVisibility(document.querySelectorAll(Config.contentVisibility.selector));
                        ticking = false;
                    });
                    ticking = true;
                }
            };
            window.addEventListener('scroll', this.scrollListener, { passive: true });
        }

        updateVisibility(elements) {
            const buffer = Config.contentVisibility.hiddenDistance;
            const wh = window.innerHeight;
            elements.forEach(el => {
                if (this.processed.has(el)) return;
                const rect = el.getBoundingClientRect();
                if (rect.bottom < -buffer || rect.top > wh + buffer) {
                    el.style.contentVisibility = 'auto';
                    el.style.containIntrinsicSize = `1px ${rect.height || 500}px`;
                    this.processed.add(el);
                }
            });
        }

        handleNewNodes(nodeList) {
            if (Env.isTwitch) return;
            nodeList.forEach(node => {
                if (node.nodeType === 1) {
                    const candidates = node.querySelectorAll ? node.querySelectorAll(Config.contentVisibility.selector) : [];
                    this.updateVisibility(candidates);
                }
            });
        }

        destroy() {
            super.destroy();
            if (this.scrollListener) window.removeEventListener('scroll', this.scrollListener);
        }
    }

    // ========================
    // 7. 모듈: 스마트 링크 프리패치
    // ========================
    class LinkPrefetcher extends BaseModule {
        constructor() { super('LinkPrefetcher'); this.observer = null; this.prefetchedUrls = new Set(); }

        init() {
            super.init();
            if (!Config.linkPrefetch.enabled) return;
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const link = entry.target;
                        this.attachHoverListener(link);
                        this.observer.unobserve(link);
                    }
                });
            });
            this.scanLinks(document.body);
        }

        scanLinks(root) {
            const links = root.querySelectorAll('a[href]');
            links.forEach(el => { if (this.isValidLink(el)) this.observer.observe(el); });
        }

        isValidLink(el) {
            const href = el.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.includes('logout')) return false;
            try { return new URL(href, window.location.href).origin === window.location.origin; } catch { return false; }
        }

        attachHoverListener(link) {
            let timer = null;
            link.addEventListener('mouseenter', () => {
                timer = setTimeout(() => { this.prefetch(link.href); }, Config.linkPrefetch.hoverDelay);
            }, { passive: true });
            link.addEventListener('mouseleave', () => { if (timer) clearTimeout(timer); }, { passive: true });
        }

        prefetch(url) {
            if (this.prefetchedUrls.has(url)) return;
            this.prefetchedUrls.add(url);
            const link = document.createElement('link');
            link.rel = 'prefetch'; link.href = url;
            document.head.appendChild(link);
        }

        handleNewNodes(nodeList) {
            nodeList.forEach(node => {
                if (node.nodeType === 1) {
                    if (node.tagName === 'A' && this.isValidLink(node)) this.observer.observe(node);
                    this.scanLinks(node);
                }
            });
        }

        destroy() {
            super.destroy();
            if (this.observer) this.observer.disconnect();
        }
    }

    // ========================
    // 8. 모듈: 미디어 자동 정지
    // ========================
    class MediaSuspender extends BaseModule {
        constructor() { super('MediaSuspender'); this.observer = null; }

        init() {
            super.init();
            if (Env.isTwitch) return;
            if (!Config.mediaSuspend.enabled) return;

            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const video = entry.target;
                    if (document.pictureInPictureElement === video) return;
                    if (!entry.isIntersecting) {
                        if (!video.paused && !video.ended) {
                            video.pause();
                            video.dataset.perfoptSuspended = 'true';
                        }
                    } else {
                        if (video.dataset.perfoptSuspended === 'true') {
                            video.play().catch(() => {});
                            delete video.dataset.perfoptSuspended;
                        }
                    }
                });
            }, { threshold: 0, rootMargin: `${Config.mediaSuspend.suspendDistance}px` });
            this.scanMedia(document);
        }

        scanMedia(root) { root.querySelectorAll('video').forEach(el => this.observer.observe(el)); }

        handleNewNodes(nodeList) {
            if (Env.isTwitch) return;
            nodeList.forEach(node => {
                if (node.nodeType === 1) {
                    if (node.tagName === 'VIDEO') this.observer.observe(node);
                    node.querySelectorAll('video').forEach(el => this.observer.observe(el));
                }
            });
        }

        destroy() {
            super.destroy();
            if (this.observer) this.observer.disconnect();
        }
    }

    // ========================
    // 9. 모듈: 백그라운드 탭 절전 모드
    // ========================
    class BackgroundThrottler extends BaseModule {
        constructor() {
            super('BackgroundThrottler');
            this.originalRAF = window.requestAnimationFrame;
            this.originalSetInterval = window.setInterval;
            this.originalSetTimeout = window.setTimeout;
        }

        init() {
            super.init();
            if (!Config.backgroundThrottle.enabled) return;
            if (Env.isTwitch || Env.isYoutube) return;

            document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
            this.handleVisibilityChange();
        }

        handleVisibilityChange() {
            if (document.visibilityState === 'hidden') {
                this.enableThrottling();
                document.title = `💤 ${document.title.replace(/^💤\s/, '')}`;
            } else {
                this.disableThrottling();
                document.title = document.title.replace(/^💤\s/, '');
            }
        }

        enableThrottling() {
            window.requestAnimationFrame = (callback) => {
                return this.originalSetTimeout(() => {
                    this.originalRAF(callback);
                }, 1000);
            };
            window.setInterval = (callback, delay, ...args) => {
                const newDelay = Math.max(delay, Config.backgroundThrottle.throttleDelay);
                return this.originalSetInterval(callback, newDelay, ...args);
            };
        }

        disableThrottling() {
            window.requestAnimationFrame = this.originalRAF;
            window.setInterval = this.originalSetInterval;
        }
    }

    // ========================
    // 10. 성능 모니터링
    // ========================
    class PerformanceMonitor extends BaseModule {
        constructor() {
            super('PerformanceMonitor');
            this.metrics = { fcp: null, lcp: null, cls: 0, ttfb: null };
        }

        init() {
            super.init();
            if (!Env.features.performanceObserver) return;
            new PerformanceObserver((l) => {
                l.getEntries().forEach(e => { if (e.name === 'first-contentful-paint') this.metrics.fcp = Math.round(e.startTime); });
            }).observe({ type: 'paint', buffered: true });
            new PerformanceObserver((l) => {
                l.getEntries().forEach(e => { if (!e.hadRecentInput) this.metrics.cls += e.value; });
            }).observe({ type: 'layout-shift', buffered: true });
            new PerformanceObserver((l) => {
                const entries = l.getEntries();
                if (entries.length > 0) this.metrics.lcp = Math.round(entries[entries.length - 1].startTime);
            }).observe({ type: 'largest-contentful-paint', buffered: true });
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const t = performance.timing;
                    if (t) this.metrics.ttfb = t.responseStart - t.navigationStart;
                }, 0);
            });
        }
        getMetrics() { return this.metrics; }
    }

    // ========================
    // 11. UI 컨트롤러
    // ========================
    class UIController extends BaseModule {
        constructor() { super('UIController'); this.visible = false; this.button = null; this.panel = null; this.monitor = null; }
        setMonitor(monitor) { this.monitor = monitor; }

        init() {
            super.init();
            if (!Config.ui.enabled) return;
            this.createUI();
            this.startLoop();
        }

        createUI() {
            const style = document.createElement('style');
            style.textContent = `
                .perf-btn { position:fixed; bottom:20px; right:20px; width:50px; height:50px; border-radius:50%; background:#4a90e2; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:10000; box-shadow:0 4px 10px rgba(0,0,0,0.2); font-size:24px; transition:transform 0.2s; }
                .perf-btn:hover { transform:scale(1.1); }
                .perf-panel { position:fixed; bottom:80px; right:20px; width:300px; background:rgba(255,255,255,0.95); backdrop-filter:blur(10px); border-radius:12px; padding:20px; z-index:10000; box-shadow:0 10px 30px rgba(0,0,0,0.15); display:none; font-family:sans-serif; font-size:13px; color:#333; }
                .perf-panel.show { display:block; animation:fadeIn 0.2s; }
                .perf-row { display:flex; justify-content:space-between; margin-bottom:8px; align-items:center; }
                .perf-title { font-weight:bold; font-size:15px; margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:10px; color:#4a90e2; }
                .perf-badge { padding:2px 6px; border-radius:10px; font-size:11px; background:#eee; }
                .perf-badge.good { background:#d4edda; color:#155724; }
                .perf-badge.bad { background:#f8d7da; color:#721c24; }
                .perf-mod-status { width:8px; height:8px; border-radius:50%; background:#ccc; }
                .perf-mod-status.on { background:#28a745; }
                .perf-mod-status.off { background:#dc3545; }
                @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
            `;
            document.head.appendChild(style);

            this.button = document.createElement('div');
            this.button.className = 'perf-btn';
            this.button.innerHTML = '⚡';
            this.button.onclick = () => { this.panel.classList.toggle('show'); this.update(); };
            document.body.appendChild(this.button);

            this.panel = document.createElement('div');
            this.panel.className = 'perf-panel';
            
            const isSafeMode = Env.isTwitch || Env.isYoutube;
            const isImgEnabled = Config.lazyLoad.enabled && !Env.isTwitch;
            const isGpuEnabled = Config.hardwareAcceleration.enabled && !Env.isTwitch;
            const isVisEnabled = Config.contentVisibility.enabled && !Env.isTwitch;
            const isMediaEnabled = Config.mediaSuspend.enabled && !Env.isTwitch;
            const isThrottleEnabled = Config.backgroundThrottle.enabled && !isSafeMode;

            this.panel.innerHTML = `
                <div class="perf-title">🚀 성능 최적화 센터</div>
                <div style="margin-bottom:15px">
                    <div class="perf-row"><b>Core Web Vitals</b></div>
                    <div class="perf-row"><span>FCP (첫 화면)</span><span id="ui-fcp" class="perf-badge">--</span></div>
                    <div class="perf-row"><span>LCP (최대 로딩)</span><span id="ui-lcp" class="perf-badge">--</span></div>
                    <div class="perf-row"><span>CLS (화면 밀림)</span><span id="ui-cls" class="perf-badge">--</span></div>
                </div>
                <div style="margin-bottom:15px">
                    <div class="perf-row"><b>활성 모듈 ${isSafeMode ? '(안전 모드)' : ''}</b></div>
                    <div class="perf-row"><span>🚀 동작 줄이기 (No Ani)</span><div class="perf-mod-status ${Config.reduceMotion.enabled?'on':'off'}"></div></div>
                    <div class="perf-row"><span>🖼️ 이미지 지연 로딩</span><div class="perf-mod-status ${isImgEnabled?'on':'off'}"></div></div>
                    <div class="perf-row"><span>🎮 GPU 가속</span><div class="perf-mod-status ${isGpuEnabled?'on':'off'}"></div></div>
                    <div class="perf-row"><span>👁️ 렌더링 최적화</span><div class="perf-mod-status ${isVisEnabled?'on':'off'}"></div></div>
                    <div class="perf-row"><span>🔗 스마트 프리패치</span><div class="perf-mod-status ${Config.linkPrefetch.enabled?'on':''}"></div></div>
                    <div class="perf-row"><span>💤 백그라운드 절전</span><div class="perf-mod-status ${isThrottleEnabled?'on':'off'}"></div></div>
                </div>
                <div class="perf-row"><b>통계</b></div>
                <div class="perf-row"><span>지연 로딩</span><b id="ui-lazy">0</b></div>
                <div class="perf-row"><span>프리패치</span><b id="ui-prefetch">0</b></div>
                <div class="perf-row"><span>GPU 가속</span><b id="ui-gpu">0</b></div>
                <div class="perf-row" style="margin-top:10px; font-size:11px; color:#999;">Ver 4.0.0-Hybrid</div>
            `;
            document.body.appendChild(this.panel);
        }

        startLoop() { setInterval(() => { if (this.panel.classList.contains('show')) this.update(); }, 1000); }

        update() {
            if (!this.monitor) return;
            const m = this.monitor.getMetrics();
            const setBadge = (id, val, goodLimit, unit='') => {
                const el = document.getElementById(id);
                if (!el || val === null) return;
                el.textContent = (typeof val === 'number' ? val.toFixed(unit?0:3) : val) + unit;
                el.className = `perf-badge ${val <= goodLimit ? 'good' : 'bad'}`;
            };
            setBadge('ui-fcp', m.fcp, 1800, 'ms');
            setBadge('ui-lcp', m.lcp, 2500, 'ms');
            setBadge('ui-cls', m.cls, 0.1);
            document.getElementById('ui-lazy').textContent = document.querySelectorAll('img[loading="lazy"]').length;
            document.getElementById('ui-gpu').textContent = document.querySelectorAll('.gpu-accelerate').length;
            document.getElementById('ui-prefetch').textContent = document.querySelectorAll('link[rel="prefetch"]').length;
        }
    }

    // ========================
    // 12. 앱 컨트롤러 (메인)
    // ========================
    class AppController extends BaseModule {
        constructor() { super('AppController'); this.modules = {}; }

        init() {
            super.init();
            Logger.info('App', '최적화 도구 가동 시작');

            this.injectGlobalStyles();

            this.modules.monitor = new PerformanceMonitor();
            this.modules.ui = new UIController();
            this.modules.motion = new MotionReducer(); // 신규 추가
            this.modules.img = new ImageOptimizer();
            this.modules.gpu = new GPUAccelerator();
            this.modules.vis = new ContentVisibility();
            this.modules.link = new LinkPrefetcher();
            this.modules.media = new MediaSuspender();
            this.modules.throttle = new BackgroundThrottler();

            this.modules.monitor.init();
            this.modules.ui.setMonitor(this.modules.monitor);
            this.modules.ui.init();
            this.modules.motion.init();
            this.modules.img.init();
            this.modules.gpu.init();
            this.modules.vis.init();
            this.modules.link.init();
            this.modules.media.init();
            this.modules.throttle.init();

            window.addEventListener('pagehide', (event) => {
                if (!event.persisted) {
                    this.destroy();
                } else {
                    Logger.info('App', 'BFCache 모드로 전환됨 (스크립트 유지)');
                }
            });
        }

        injectGlobalStyles() {
            const style = document.createElement('style');
            style.textContent = `
                /* 텍스트가 폰트 로딩될 때까지 숨겨지는 현상 방지 */
                @font-face { font-display: swap; }
            `;
            document.head.appendChild(style);
        }

        destroy() {
            Object.values(this.modules).forEach(m => m.destroy && m.destroy());
            super.destroy();
        }
    }

    const app = new AppController();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => app.init());
    } else {
        app.init();
    }

})();
