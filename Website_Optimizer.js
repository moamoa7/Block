// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v5.6.2 Coupang Final)
// @namespace    http://tampermonkey.net/
// @version      5.6.2-KR-StreamingFinal
// @description  쿠팡플레이 프로필 화면 버그 수정; 애니메이션 제거/렌더링 최적화 예외 처리 강화
// @author       KiwiFruit (Refined by AI)
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
    // 1. 환경 및 상태 감지
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
        state: {
            isOverloaded: false,
            longTaskCount: 0,
            isLowEnd: navigator.hardwareConcurrency <= 4,
            isSlowNetwork: false,
            decisionText: '대기 중...'
        },
        checkNetwork() {
            const conn = navigator.connection;
            if (conn) {
                this.state.isSlowNetwork = conn.saveData || (conn.effectiveType && conn.effectiveType.includes('2g'));
            }
        },
        // [v5.6.2] 스트리밍 사이트 목록 (이 사이트들은 '안전 모드'로 작동)
        streamingDomains: [
            'twitch.tv',
            'youtube.com',
            'sooplive.co.kr',
            'afreecatv.com',
            'poooo.ml',
            'ok.ru',
            'tv.kakao.com',
            'netflix.com',
            'tving.com',
            'wavve.com',
            'coupangplay.com',
            'disneyplus.com',
            'watcha.com'
        ]
    };

    Env.isStreamingSite = Env.streamingDomains.some(domain => window.location.hostname.includes(domain));
    Env.isTwitch = window.location.hostname.includes('twitch.tv');

    const Config = {
        debug: false,
        ui: { enabled: true },
        scheduler: { deadline: 10, maxTasksPerTick: 15 },
        lazyLoad: {
            enabled: true,
            selector: 'img[data-src], img[data-original], img.lazy, iframe[data-src]',
            preloadDistance: 150
        },
        reduceMotion: { enabled: true },
        hardwareAcceleration: {
            enabled: true,
            selector: 'header, nav, aside, .sticky, .fixed',
            skipViewportElements: true
        },
        contentVisibility: {
            enabled: true,
            selector: 'section, article, .post, .js-section, .comment-list',
            hiddenDistance: 800,
            excludeSelectors: '[contenteditable], .editor, .player, [data-no-cv], .textarea'
        },
        linkPrefetch: {
            enabled: true,
            hoverDelay: 65,
            sameOriginOnly: true,
            ignoreSelectors: '[href^="#"], [href^="javascript:"], [href*="logout"], [href*="signout"]'
        },
        mediaSuspend: { enabled: true, suspendDistance: 300 },
        backgroundThrottle: { enabled: true, throttleDelay: 1000 }
    };

    // ========================
    // 2. 지능형 스케줄러
    // ========================
    class Scheduler {
        constructor() { this.tasks = []; this.isRunning = false; }
        enqueue(task) { this.tasks.push(task); this.schedule(); }
        schedule() {
            if (this.isRunning || this.tasks.length === 0) return;
            this.isRunning = true;
            if (Env.features.requestIdleCallback) {
                requestIdleCallback((deadline) => this.process(deadline), { timeout: 2000 });
            } else {
                setTimeout(() => this.process({ timeRemaining: () => 50 }), 10);
            }
        }
        process(deadline) {
            let processedCount = 0;
            while (this.tasks.length > 0 && deadline.timeRemaining() > 0 && !Env.state.isOverloaded && processedCount < Config.scheduler.maxTasksPerTick) {
                const task = this.tasks.shift();
                if (task) try { task(); processedCount++; } catch (e) {}
            }
            this.isRunning = false;
            if (this.tasks.length > 0) this.schedule();
        }
    }
    const GlobalScheduler = new Scheduler();

    // ========================
    // 3. 모듈 클래스 정의
    // ========================
    class BaseModule {
        constructor(name) { this.moduleName = name; this.observer = null; }
        init() {}
        destroy() { if (this.observer) { this.observer.disconnect(); this.observer = null; } }
        setupMutationObserver(callback) {
            if (!Env.features.mutationObserver) return;
            this.observer = new MutationObserver((mutations) => {
                GlobalScheduler.enqueue(() => {
                    for (const m of mutations) if (m.addedNodes.length) callback(m.addedNodes);
                });
            });
            this.observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    class SystemMonitor extends BaseModule {
        init() {
            Env.checkNetwork();
            if (Env.features.performanceObserver) {
                new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.duration > 60) {
                            Env.state.longTaskCount++;
                            if (Env.state.longTaskCount >= 3) this.triggerOverload();
                        }
                    }
                }).observe({ type: 'longtask', buffered: true });
            }
            setInterval(() => { Env.state.longTaskCount = 0; }, 2000);
        }
        triggerOverload() {
            if (Env.state.isOverloaded) return;
            Env.state.isOverloaded = true;
            Env.state.decisionText = '⚠️ 과부하 감지 → 절전 모드';
            setTimeout(() => {
                Env.state.isOverloaded = false;
                Env.state.decisionText = '✅ 시스템 정상화';
            }, 5000);
        }
    }

    class MotionReducer extends BaseModule {
        init() {
            // [v5.6.2 수정] 스트리밍 사이트는 UI 애니메이션 의존도가 높아서(오프닝/프로필) 제외
            if (Env.isStreamingSite || !Config.reduceMotion.enabled) return;

            const style = document.createElement('style');
            style.id = 'perfopt-motion';
            style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }`;
            document.head.appendChild(style);
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            if (Env.isStreamingSite || !Config.lazyLoad.enabled) return;

            if (Env.features.nativeLazyLoad) {
                const applyNative = (nodes) => {
                    nodes.forEach(n => {
                        if (n.nodeType === 1) {
                            if (n.tagName === 'IMG' || n.tagName === 'IFRAME') n.loading = 'lazy';
                            n.querySelectorAll('img, iframe').forEach(el => el.loading = 'lazy');
                        }
                    });
                };
                applyNative([document.body]);
                this.setupMutationObserver(applyNative);
                return;
            }

            const io = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const t = e.target;
                        if (t.dataset.src) { t.src = t.dataset.src; delete t.dataset.src; }
                        io.unobserve(t);
                    }
                });
            }, { rootMargin: '200px' });

            const scan = (nodes) => {
                nodes.forEach(n => {
                    if (n.nodeType === 1) {
                        if (n.matches(Config.lazyLoad.selector)) io.observe(n);
                        n.querySelectorAll(Config.lazyLoad.selector).forEach(i => io.observe(i));
                    }
                });
            };
            scan([document.body]);
            this.setupMutationObserver(scan);
        }
    }

    class GPUAccelerator extends BaseModule {
        init() {
            if (Env.isStreamingSite || !Config.hardwareAcceleration.enabled || Env.state.isLowEnd) return;
            const apply = (el) => {
                if (!el.classList.contains('gpu-acc') && !el.closest('.streaming')) {
                    el.classList.add('gpu-acc');
                    el.style.transform = 'translateZ(0)';
                }
            };
            const scan = (nodes) => {
                nodes.forEach(n => {
                    if (n.nodeType === 1) {
                        if (n.matches(Config.hardwareAcceleration.selector)) apply(n);
                        n.querySelectorAll(Config.hardwareAcceleration.selector).forEach(apply);
                    }
                });
            };
            scan([document.body]);
            this.setupMutationObserver(scan);
        }
    }

    class ContentVisibility extends BaseModule {
        init() {
            if (Env.isStreamingSite || !Config.contentVisibility.enabled) return;

            const buffer = Config.contentVisibility.hiddenDistance;
            const vh = window.innerHeight;

            const update = (nodes) => {
                const candidates = [...nodes].filter(el => {
                    if (el.closest(Config.contentVisibility.excludeSelectors)) return false;
                    if (el.querySelector('canvas, video, iframe, [role="img"]')) return false;
                    return true;
                });

                candidates.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom < -buffer || rect.top > vh + buffer) {
                        el.style.contentVisibility = 'auto';
                        el.style.containIntrinsicSize = '1px 500px';
                    }
                });
            };

            const scan = (nodes) => {
                nodes.forEach(n => {
                    if (n.nodeType === 1) update(n.querySelectorAll(Config.contentVisibility.selector));
                });
            };
            scan([document.body]);
            this.setupMutationObserver(scan);

            let ticking = false;
            window.addEventListener('scroll', () => {
                if(!ticking) {
                    requestAnimationFrame(() => {
                        update(document.querySelectorAll(Config.contentVisibility.selector));
                        ticking = false;
                    });
                    ticking = true;
                }
            }, { passive: true });
        }
    }

    class LinkPrefetcher extends BaseModule {
        constructor() { super('LinkPrefetcher'); this.prefetched = new Set(); }

        init() {
            if (!Config.linkPrefetch.enabled || Env.state.isSlowNetwork) return;
            const io = new IntersectionObserver((entries) => {
                entries.forEach(e => {
                    if (e.isIntersecting) {
                        const link = e.target;
                        link.addEventListener('mouseenter', () => {
                            if (Env.state.isOverloaded) return;
                            setTimeout(() => this.preload(link), Config.linkPrefetch.hoverDelay);
                        }, { once: true, passive: true });
                        io.unobserve(link);
                    }
                });
            });
            const scan = (nodes) => {
                nodes.forEach(n => {
                    if (n.nodeType === 1) n.querySelectorAll('a[href^="http"]').forEach(a => {
                        if (this.isValidLink(a)) io.observe(a);
                    });
                });
            };
            scan([document.body]);
            this.setupMutationObserver(scan);
        }
        isValidLink(el) {
            const href = el.getAttribute('href');
            if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.includes('logout')) return false;
            try {
                const url = new URL(href, window.location.href);
                if (Config.linkPrefetch.sameOriginOnly && url.origin !== window.location.origin) return false;
                return true;
            } catch { return false; }
        }
        preload(el) {
            const url = el.href;
            if (this.prefetched.has(url)) return;
            this.prefetched.add(url);
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.href = url;
            link.as = 'document';
            document.head.appendChild(link);
        }
    }

    class BackgroundThrottler extends BaseModule {
        constructor() {
            super('BackgroundThrottler');
            this.origRAF = window.requestAnimationFrame;
            this.origInterval = window.setInterval;
            this.origTimeout = window.setTimeout;
        }
        init() {
            if (Env.isStreamingSite) {
                console.log('[PerfOpt] Streaming site detected: Background throttling disabled.');
                return;
            }
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.throttle();
                else this.restore();
            });
        }
        throttle() {
            document.title = '💤 ' + document.title.replace(/^💤 /, '');
            console.log('[PerfOpt] Global Timers Throttled (Background Mode)');
            window.requestAnimationFrame = (cb) => {
                return this.origTimeout(() => { this.origRAF((t) => cb(t)); }, 1000);
            };
            window.setInterval = (cb, t) => this.origInterval(cb, Math.max(t, 1000));
            window.setTimeout = (cb, t) => this.origTimeout(cb, Math.max(t, 1000));
        }
        restore() {
            document.title = document.title.replace(/^💤 /, '');
            setTimeout(() => {
                window.requestAnimationFrame = this.origRAF;
                window.setInterval = this.origInterval;
                window.setTimeout = this.origTimeout;
            }, 100);
        }
    }

    class PerformanceMonitor extends BaseModule {
        constructor() { super('PerformanceMonitor'); this.metrics = { fcp: null, lcp: null, cls: 0 }; }
        init() {
            if (!Env.features.performanceObserver) return;
            new PerformanceObserver((l) => l.getEntries().forEach(e => { if (e.name === 'first-contentful-paint') this.metrics.fcp = Math.round(e.startTime); })).observe({ type: 'paint', buffered: true });
            new PerformanceObserver((l) => l.getEntries().forEach(e => { if (!e.hadRecentInput) this.metrics.cls += e.value; })).observe({ type: 'layout-shift', buffered: true });
            new PerformanceObserver((l) => { const e = l.getEntries(); if (e.length) this.metrics.lcp = Math.round(e[e.length-1].startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
        }
        getMetrics() { return this.metrics; }
    }

    // ========================
    // 4. UI 컨트롤러
    // ========================
    class UIController extends BaseModule {
        constructor() { super('UIController'); this.visible = false; this.button = null; this.panel = null; this.monitor = null; }
        setMonitor(monitor) { this.monitor = monitor; }

        init() {
            if (!Config.ui.enabled) return;
            this.createUI();
            setInterval(() => { if (this.panel.classList.contains('show')) this.update(); }, 1000);
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
                .perf-badge.warn { background:#fff3cd; color:#856404; }
                .perf-badge.bad { background:#f8d7da; color:#721c24; }
                .perf-status-dot { width:8px; height:8px; border-radius:50%; background:#ccc; display:inline-block; margin-left:5px; }
                .perf-status-dot.on { background:#28a745; }
                .perf-status-dot.off { background:#dc3545; }
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

            const isSafeMode = Env.isStreamingSite;

            this.panel.innerHTML = `
                <div class="perf-title">🚀 성능 최적화 센터 (Streaming+)</div>

                <div style="margin-bottom:15px; background:#f1f3f5; padding:10px; border-radius:8px;">
                    <div class="perf-row"><b>엔진 자동 판단</b></div>
                    <div class="perf-row"><span id="ui-decision" style="color:#007bff; font-weight:bold;">정상 가동 중</span></div>
                </div>

                <div style="margin-bottom:15px">
                    <div class="perf-row"><b>Core Web Vitals</b></div>
                    <div class="perf-row"><span>FCP (첫 화면)</span><span id="ui-fcp" class="perf-badge">--</span></div>
                    <div class="perf-row"><span>LCP (최대 로딩)</span><span id="ui-lcp" class="perf-badge">--</span></div>
                    <div class="perf-row"><span>CLS (화면 밀림)</span><span id="ui-cls" class="perf-badge">--</span></div>
                </div>

                <div style="margin-bottom:15px">
                    <div class="perf-row"><b>모듈 상태 ${isSafeMode ? '(안전 모드)' : ''}</b></div>
                    <div class="perf-row"><span>🚀 동작 줄이기 (No Ani)</span><div class="perf-status-dot ${!isSafeMode?'on':'off'}"></div></div>
                    <div class="perf-row"><span>🖼️ 이미지 지연 로딩</span><div class="perf-status-dot ${!isSafeMode?'on':'off'}"></div></div>
                    <div class="perf-row"><span>👁️ 렌더링 최적화</span><div class="perf-status-dot ${!isSafeMode?'on':'off'}"></div></div>
                    <div class="perf-row"><span>🔗 스마트 프리패치</span><div class="perf-status-dot on" id="ui-dot-link"></div></div>
                    <div class="perf-row"><span>💤 백그라운드 절전</span><div class="perf-status-dot ${!isSafeMode?'on':'off'}"></div></div>
                </div>

                <div class="perf-row" style="margin-top:10px; font-size:11px; color:#999;">Ver 5.6.2-CoupangFix</div>
            `;
            document.body.appendChild(this.panel);
        }

        update() {
            if (!this.monitor) return;
            const m = this.monitor.getMetrics();

            const updateBadge = (id, val, goodLimit, suffix='') => {
                const el = document.getElementById(id);
                if (!el) return;
                if (val === null) { el.className = 'perf-badge'; el.textContent = '--'; return; }
                el.textContent = (typeof val === 'number' ? val.toFixed(suffix?0:3) : val) + suffix;
                el.className = `perf-badge ${val <= goodLimit ? 'good' : 'bad'}`;
            };

            const decisionEl = document.getElementById('ui-decision');
            if (Env.state.isOverloaded) {
                decisionEl.textContent = Env.state.decisionText;
                decisionEl.style.color = '#dc3545';
            } else if (Env.state.isSlowNetwork) {
                decisionEl.textContent = '📶 네트워크 느림 (절약 모드)';
                decisionEl.style.color = '#ffc107';
            } else {
                decisionEl.textContent = '✅ 최적 상태 유지 중';
                decisionEl.style.color = '#28a745';
            }

            const linkDot = document.getElementById('ui-dot-link');
            if (Env.state.isOverloaded || Env.state.isSlowNetwork) linkDot.className = 'perf-status-dot off';
            else linkDot.className = 'perf-status-dot on';

            updateBadge('ui-fcp', m.fcp, 1800, 'ms');
            updateBadge('ui-lcp', m.lcp, 2500, 'ms');
            updateBadge('ui-cls', m.cls, 0.1);
        }
    }

    // ========================
    // 5. 앱 컨트롤러
    // ========================
    class AppController {
        init() {
            const style = document.createElement('style');
            style.textContent = '@font-face { font-display: swap; }';
            document.head.appendChild(style);

            const modules = {
                sys: new SystemMonitor(),
                motion: new MotionReducer(),
                img: new ImageOptimizer(),
                gpu: new GPUAccelerator(),
                vis: new ContentVisibility(),
                link: new LinkPrefetcher(),
                throttle: new BackgroundThrottler(),
                monitor: new PerformanceMonitor(),
                ui: new UIController()
            };

            modules.sys.init();
            modules.motion.init();
            modules.img.init();
            modules.gpu.init();
            modules.vis.init();
            modules.link.init();
            modules.throttle.init();
            modules.monitor.init();

            modules.ui.setMonitor(modules.monitor);
            modules.ui.init();

            window.addEventListener('pageshow', (e) => {
                if (e.persisted) {
                    modules.throttle.restore();
                    modules.link.init();
                }
            });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => new AppController().init());
    else new AppController().init();

})();
