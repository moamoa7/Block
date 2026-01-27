// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v6.0.0 Precision)
// @namespace    http://tampermonkey.net/
// @version      6.0.0-KR-Precision
// @description  백그라운드 절전 정밀 제어; 실시간 사이트(SOOP/Gemini/유튜브) 끊김 방지; 시각적 버그 방지 분리
// @author       KiwiFruit (Architected by AI)
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
    // 1. 설정 및 도메인 리스트 (사용자 정의 영역)
    // ========================
    const SiteLists = {
        // [1] 백그라운드 절전 제외 (영상/AI 답변 끊김 방지)
        noThrottling: [
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'afreecatv.com',
            'poooo.ml', 'ok.ru', 'tv.kakao.com',
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com',
            'disneyplus.com', 'watcha.com',
            'gemini.google.com', 'chatgpt.com', 'claude.ai',
            'music.youtube.com', 'spotify.com'
        ],
        // [2] 동작 줄이기 제외 (UI/프로필 화면 안 보임 방지)
        noMotion: [
            'coupangplay.com', 'apple.com', 'gemini.google.com'
        ],
        // [3] GPU/렌더링 간섭 제외 (채팅창/레이어 깨짐 방지)
        noRender: [
            'twitch.tv', 'dcinside.com'
        ]
    };

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
        // 현재 사이트가 어느 목록에 해당하는지 판별
        checkDomain() {
            const host = window.location.hostname;
            this.isNoThrottle = SiteLists.noThrottling.some(d => host.includes(d));
            this.isNoMotion = SiteLists.noMotion.some(d => host.includes(d));
            this.isNoRender = SiteLists.noRender.some(d => host.includes(d));
        },
        checkNetwork() {
            const conn = navigator.connection;
            if (conn) {
                this.state.isSlowNetwork = conn.saveData || (conn.effectiveType && conn.effectiveType.includes('2g'));
            }
        }
    };

    // 초기화 시 도메인 체크
    Env.checkDomain();

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
            // [정밀 제어] noMotion 목록에 있으면 실행 안 함
            if (Env.isNoMotion || !Config.reduceMotion.enabled) return;

            const style = document.createElement('style');
            style.id = 'perfopt-motion';
            style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }`;
            document.head.appendChild(style);
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
            // [정밀 제어] noRender 목록(트위치 등)에서는 이미지 로딩 간섭 최소화
            if (Env.isNoRender || !Config.lazyLoad.enabled) return;

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
            // [정밀 제어] noRender 목록에서는 GPU 강제 할당 금지 (레이어 버그 방지)
            if (Env.isNoRender || !Config.hardwareAcceleration.enabled || Env.state.isLowEnd) return;
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
            // [정밀 제어] noRender 목록에서는 렌더링 간섭 금지
            if (Env.isNoRender || !Config.contentVisibility.enabled) return;

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
            // 프리패치는 특별한 이유가 없으면 항상 켜두되, 느린 네트워크에서는 끔
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
            // [정밀 제어] noThrottling 목록에 있는 사이트(실시간)는 절전 모드 절대 작동 안 함
            if (Env.isNoThrottle) {
                console.log('[PerfOpt] Real-time site detected: Background throttling DISABLED.');
                return;
            }
            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.throttle();
                else this.restore();
            });
        }
        throttle() {
            document.title = '💤 ' + document.title.replace(/^💤 /, '');
            // console.log('[PerfOpt] Global Timers Throttled (Background Mode)'); // 로그 너무 많아서 주석처리
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
    // 4. UI 컨트롤러 (Titanium - DOM 조립 방식)
    // ========================
    class UIController extends BaseModule {
        constructor() { super('UIController'); this.visible = false; this.button = null; this.panel = null; this.monitor = null; }
        setMonitor(monitor) { this.monitor = monitor; }

        init() {
            if (!Config.ui.enabled) return;
            this.createUI();
            setInterval(() => { if (this.panel && this.panel.style.display === 'block') this.update(); }, 1000);
        }

        el(tag, className, text) {
            const e = document.createElement(tag);
            if (className) e.className = className;
            if (text) e.textContent = text;
            return e;
        }

        createUI() {
            const style = document.createElement('style');
            style.textContent = `
                .perf-btn { position:fixed; bottom:20px; right:20px; width:50px; height:50px; border-radius:50%; background:#4a90e2; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:2147483647; box-shadow:0 4px 10px rgba(0,0,0,0.2); font-size:24px; transition:transform 0.2s; }
                .perf-btn:hover { transform:scale(1.1); }
                .perf-panel { position:fixed; bottom:80px; right:20px; width:300px; background:rgba(255,255,255,0.95); backdrop-filter:blur(10px); border-radius:12px; padding:20px; z-index:2147483647; box-shadow:0 10px 30px rgba(0,0,0,0.15); display:none; font-family:sans-serif; font-size:13px; color:#333; border:1px solid #eee; }
                .perf-row { display:flex; justify-content:space-between; margin-bottom:8px; align-items:center; }
                .perf-title { font-weight:bold; font-size:15px; margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:10px; color:#4a90e2; }
                .perf-badge { padding:2px 6px; border-radius:10px; font-size:11px; background:#eee; }
                .perf-badge.good { background:#d4edda; color:#155724; }
                .perf-badge.warn { background:#fff3cd; color:#856404; }
                .perf-badge.bad { background:#f8d7da; color:#721c24; }
                .perf-status-dot { width:8px; height:8px; border-radius:50%; background:#ccc; display:inline-block; margin-left:5px; }
                .perf-status-dot.on { background:#28a745; }
                .perf-status-dot.off { background:#dc3545; }
                .perf-section { margin-bottom:15px; padding:10px; border-radius:8px; background:#f8f9fa; }
            `;
            document.head.appendChild(style);

            this.button = this.el('div', 'perf-btn', '⚡');
            this.button.onclick = () => {
                this.panel.style.display = this.panel.style.display === 'none' ? 'block' : 'none';
                this.update();
            };
            document.body.appendChild(this.button);

            this.panel = this.el('div', 'perf-panel');
            this.panel.appendChild(this.el('div', 'perf-title', '🚀 성능 최적화 센터 (Precision)'));

            // 섹션 1: 엔진 판단
            const sec1 = this.el('div', 'perf-section');
            const row1 = this.el('div', 'perf-row');
            row1.appendChild(this.el('b', '', '엔진 자동 판단'));
            sec1.appendChild(row1);
            const rowDec = this.el('div', 'perf-row');
            this.uiDecision = this.el('span', '', '정상 가동 중');
            this.uiDecision.style.fontWeight = 'bold';
            this.uiDecision.style.color = '#28a745';
            rowDec.appendChild(this.uiDecision);
            sec1.appendChild(rowDec);
            this.panel.appendChild(sec1);

            // 섹션 2: Web Vitals
            const sec2 = this.el('div', 'perf-section');
            sec2.style.background = 'transparent'; sec2.style.padding = '0';
            const rowVitals = this.el('div', 'perf-row');
            rowVitals.appendChild(this.el('b', '', 'Core Web Vitals'));
            sec2.appendChild(rowVitals);

            const createMetricRow = (label, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const val = this.el('span', 'perf-badge', '--');
                val.id = id;
                r.appendChild(val);
                return r;
            };
            sec2.appendChild(createMetricRow('FCP (첫 화면)', 'ui-fcp'));
            sec2.appendChild(createMetricRow('LCP (최대 로딩)', 'ui-lcp'));
            sec2.appendChild(createMetricRow('CLS (화면 밀림)', 'ui-cls'));
            this.panel.appendChild(sec2);

            // 섹션 3: 모듈 상태
            const sec3 = this.el('div', 'perf-section');
            sec3.style.background = 'transparent'; sec3.style.padding = '0';
            const rowMods = this.el('div', 'perf-row');
            rowMods.appendChild(this.el('b', '', '모듈 상태'));
            sec3.appendChild(rowMods);

            // 상태 시각화 로직
            const isMotionActive = !Env.isNoMotion; // 쿠팡, 넷플릭스 X
            const isRenderActive = !Env.isNoRender; // 트위치, 숲 X
            const isThrottleActive = !Env.isNoThrottle; // 유튜브, 트위치, 쿠팡 X (영상 재생 보장)

            const createModRow = (label, isOn, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const dot = this.el('div', `perf-status-dot ${isOn ? 'on' : 'off'}`);
                if(id) dot.id = id;
                r.appendChild(dot);
                return r;
            };

            sec3.appendChild(createModRow('🚀 동작 줄이기', isMotionActive));
            sec3.appendChild(createModRow('🖼️ 이미지 지연 로딩', isRenderActive)); // 렌더링 간섭과 같이 묶음
            sec3.appendChild(createModRow('👁️ 렌더링 최적화', isRenderActive));
            sec3.appendChild(createModRow('🔗 스마트 프리패치', true, 'ui-dot-link'));
            sec3.appendChild(createModRow('💤 백그라운드 절전', isThrottleActive));
            this.panel.appendChild(sec3);

            // 섹션 4: 통계
            const rowStats = this.el('div', 'perf-row');
            rowStats.style.borderTop = '1px solid #eee';
            rowStats.style.paddingTop = '10px';
            rowStats.style.marginTop = '10px';
            rowStats.appendChild(this.el('b', '', '실시간 통계'));
            this.panel.appendChild(rowStats);

            const createStatRow = (label, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const val = this.el('b', '', '0');
                val.id = id;
                r.appendChild(val);
                return r;
            };
            this.panel.appendChild(createStatRow('지연 로딩된 수', 'ui-lazy'));
            this.panel.appendChild(createStatRow('프리패치된 링크', 'ui-prefetch'));
            this.panel.appendChild(createStatRow('GPU 가속 요소', 'ui-gpu'));

            // Footer
            const footer = this.el('div', 'perf-row', 'Ver 6.0.0-KR-Precision');
            footer.style.marginTop = '10px';
            footer.style.fontSize = '11px';
            footer.style.color = '#999';
            this.panel.appendChild(footer);

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

            if (this.uiDecision) {
                if (Env.state.isOverloaded) {
                    this.uiDecision.textContent = Env.state.decisionText;
                    this.uiDecision.style.color = '#dc3545';
                } else if (Env.state.isSlowNetwork) {
                    this.uiDecision.textContent = '📶 네트워크 느림 (절약 모드)';
                    this.uiDecision.style.color = '#ffc107';
                } else {
                    this.uiDecision.textContent = '✅ 최적 상태 유지 중';
                    this.uiDecision.style.color = '#28a745';
                }
            }

            const linkDot = document.getElementById('ui-dot-link');
            if (linkDot) {
                if (Env.state.isOverloaded || Env.state.isSlowNetwork) linkDot.className = 'perf-status-dot off';
                else linkDot.className = 'perf-status-dot on';
            }

            updateBadge('ui-fcp', m.fcp, 1800, 'ms');
            updateBadge('ui-lcp', m.lcp, 2500, 'ms');
            updateBadge('ui-cls', m.cls, 0.1);

            const lazyCount = document.querySelectorAll('img[loading="lazy"]').length;
            const prefetchCount = document.querySelectorAll('link[rel="prefetch"]').length;
            const gpuCount = document.querySelectorAll('.gpu-acc').length;

            if (document.getElementById('ui-lazy')) document.getElementById('ui-lazy').textContent = lazyCount;
            if (document.getElementById('ui-prefetch')) document.getElementById('ui-prefetch').textContent = prefetchCount;
            if (document.getElementById('ui-gpu')) document.getElementById('ui-gpu').textContent = gpuCount;
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
