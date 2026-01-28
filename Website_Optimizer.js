// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v9.0.0 Control & Insight)
// @namespace    http://tampermonkey.net/
// @version      9.0.0-KR-ControlInsight
// @description  백그라운드 미디어 자동 제어(광고 차단); 작동 로그(History) 시각화; 화이트리스트 기반
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
    // 1. 설정 및 도메인 리스트 (화이트리스트)
    // ========================
    const SiteLists = {
        // [1] 백그라운드 절전 제외 (영상/AI 답변 끊김 방지) (미디어 정지 안 함 & 절전 안 함)
        noThrottling: [
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'chzzk.naver.com',
            'ok.ru', 'tv.kakao.com',
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com',
            'disneyplus.com', 'watcha.com',
            'gemini.google.com', 'chatgpt.com', 'claude.ai',
            'music.youtube.com', 'spotify.com'
        ],
        // [2] 동작 줄이기 제외 (UI/프로필 화면 안 보임 방지) (애니메이션 유지)
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
            decisionText: '대기 중...',
            activeReason: '초기화 중',
            // [v9.0] 로그 히스토리
            history: []
        },

        // [v9.0] 로그 기록 함수
        log(msg) {
            const time = new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.state.history.unshift({ t: time, msg: msg });
            if (this.state.history.length > 5) this.state.history.pop(); // 최대 5개 유지
        },

        checkDomain() {
            const host = window.location.hostname;
            this.isNoThrottle = SiteLists.noThrottling.some(d => host.includes(d));
            this.isNoMotion = SiteLists.noMotion.some(d => host.includes(d));
            this.isNoRender = SiteLists.noRender.some(d => host.includes(d));

            if (this.isNoThrottle) {
                this.state.activeReason = '스트리밍/AI 보호';
                this.log('화이트리스트 감지: 보호 모드 가동');
            } else {
                this.state.activeReason = '일반 모드 (절전 대기)';
                this.log('일반 사이트: 최적화 준비 완료');
            }
        },
        checkNetwork() {
            const conn = navigator.connection;
            if (conn) {
                this.state.isSlowNetwork = conn.saveData || (conn.effectiveType && conn.effectiveType.includes('2g'));
                if (this.state.isSlowNetwork) {
                    this.state.activeReason = '네트워크 절약';
                    this.log('네트워크 느림: 데이터 절약 모드');
                }
            }
        }
    };

    Env.checkDomain();

    const Config = {
        debug: false,
        ui: { enabled: true },
        scheduler: { deadline: 10, maxTasksPerTick: 15 },
        lazyLoad: { enabled: true, selector: 'img[data-src], img[data-original], img.lazy, iframe[data-src]', preloadDistance: 150 },
        reduceMotion: { enabled: true },
        hardwareAcceleration: { enabled: true, selector: 'header, nav, aside, .sticky, .fixed', skipViewportElements: true },
        contentVisibility: { enabled: true, selector: 'section, article, .post, .js-section, .comment-list', hiddenDistance: 800, excludeSelectors: '[contenteditable], .editor, .player, [data-no-cv], .textarea' },
        linkPrefetch: { enabled: true, hoverDelay: 65, sameOriginOnly: true },
        mediaSuspend: { enabled: true }, // [v9.0] 설정 활성화
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
        safeInit() { try { this.init(); } catch (e) { console.warn(`[PerfOpt] ${this.moduleName} crashed:`, e); } }
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
            Env.state.activeReason = 'CPU 과부하 감지';
            Env.state.decisionText = '⚠️ 과부하 감지 → 절전 모드';
            Env.log('⚠️ CPU 과부하 발생 (자동 절전)'); // 로그 기록
            setTimeout(() => {
                Env.state.isOverloaded = false;
                Env.state.activeReason = '시스템 정상화';
                Env.state.decisionText = '✅ 시스템 정상화';
                Env.log('✅ 시스템 부하 해소'); // 로그 기록
            }, 5000);
        }
    }

    // [v9.0] 미디어 자동 제어기 (광고/뉴스 영상 차단)
    class MediaSuspender extends BaseModule {
        constructor() { super('MediaSuspender'); }

        init() {
            if (!Config.mediaSuspend.enabled) return;
            if (Env.isNoThrottle) return; // 화이트리스트 사이트는 절대 건드리지 않음

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) {
                    this.suspend();
                } else {
                    this.resume();
                }
            });
        }

        suspend() {
            let count = 0;
            document.querySelectorAll('video, audio').forEach(v => {
                if (!v.paused && !v.ended) {
                    v.pause();
                    v.dataset.autoPaused = '1';
                    count++;
                }
            });
            if (count > 0) Env.log(`⏸️ 미디어 ${count}개 자동 정지`);
        }

        resume() {
            let count = 0;
            document.querySelectorAll('[data-auto-paused]').forEach(v => {
                v.play().catch(() => {}); // 자동 재생 정책 등으로 실패할 수 있음 (무시)
                delete v.dataset.autoPaused;
                count++;
            });
            if (count > 0) Env.log(`▶️ 미디어 ${count}개 자동 재개`);
        }
    }

    class MotionReducer extends BaseModule {
        init() {
            if (Env.isNoMotion || !Config.reduceMotion.enabled) return;
            const style = document.createElement('style');
            style.textContent = `*, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }`;
            document.head.appendChild(style);
        }
    }

    class ImageOptimizer extends BaseModule {
        init() {
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
            // (구형 브라우저 Fallback 생략)
        }
    }

    class GPUAccelerator extends BaseModule {
        init() {
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
            if (Env.isNoRender || !Config.contentVisibility.enabled) return;
            const buffer = Config.contentVisibility.hiddenDistance;
            const vh = window.innerHeight;

            const update = (nodes) => {
                const candidates = [...nodes].filter(el => {
                    if (el.dataset.poCv) return false;
                    if (el.closest(Config.contentVisibility.excludeSelectors)) return false;
                    if (el.querySelector('canvas, video, iframe, [role="img"]')) return false;
                    return true;
                });

                candidates.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.bottom < -buffer || rect.top > vh + buffer) {
                        el.style.contentVisibility = 'auto';
                        el.style.containIntrinsicSize = '1px 500px';
                        el.dataset.poCv = '1';
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
            try {
                const url = new URL(el.href, window.location.href);
                if (Config.linkPrefetch.sameOriginOnly && url.origin !== window.location.origin) return false;
                if (url.href.includes('logout') || url.href.includes('signout')) return false;
                return true;
            } catch { return false; }
        }
        preload(el) {
            const url = el.href;
            if (this.prefetched.has(url)) return;
            this.prefetched.add(url);
            const link = document.createElement('link');
            link.rel = 'prefetch'; link.href = url; link.as = 'document';
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
            if (Env.isNoThrottle) return;

            document.addEventListener('visibilitychange', () => {
                if (document.hidden) this.throttle();
                else this.restore();
            });
        }
        throttle() {
            document.title = '💤 ' + document.title.replace(/^💤 /, '');
            Env.log('💤 탭 비활성: 절전 모드 진입'); // 로그
            window.requestAnimationFrame = (cb) => this.origTimeout(() => this.origRAF((t) => cb(t)), 1000);
            window.setInterval = (cb, t) => this.origInterval(cb, Math.max(t, 1000));
            window.setTimeout = (cb, t) => this.origTimeout(cb, Math.max(t, 1000));
        }
        restore() {
            document.title = document.title.replace(/^💤 /, '');
            Env.log('⚡ 탭 활성: 절전 해제'); // 로그
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

            const fcpEntries = performance.getEntriesByName('first-contentful-paint');
            if (fcpEntries.length > 0) this.metrics.fcp = Math.round(fcpEntries[0].startTime);

            new PerformanceObserver((l) => l.getEntries().forEach(e => {
                if (e.name === 'first-contentful-paint') this.metrics.fcp = Math.round(e.startTime);
            })).observe({ type: 'paint', buffered: true });

            new PerformanceObserver((l) => l.getEntries().forEach(e => {
                if (!e.hadRecentInput) this.metrics.cls += e.value;
            })).observe({ type: 'layout-shift', buffered: true });

            new PerformanceObserver((l) => {
                const e = l.getEntries();
                if (e.length) this.metrics.lcp = Math.round(e[e.length-1].startTime);
            }).observe({ type: 'largest-contentful-paint', buffered: true });
        }
        getMetrics() { return this.metrics; }
    }

    // ========================
    // 4. UI 컨트롤러
    // ========================
    class UIController extends BaseModule {
        constructor() {
            super('UIController');
            this.visible = false;
            this.button = null;
            this.panel = null;
            this.monitor = null;
            this.animFrameId = null;
        }
        setMonitor(monitor) { this.monitor = monitor; }

        init() {
            if (!Config.ui.enabled) return;
            this.createUI();
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
                .perf-panel.show { display:block !important; animation: fadeIn 0.1s ease-out; }
                .perf-row { display:flex; justify-content:space-between; margin-bottom:8px; align-items:center; }
                .perf-title { font-weight:bold; font-size:15px; margin-bottom:15px; border-bottom:1px solid #eee; padding-bottom:10px; color:#4a90e2; }
                .perf-badge { padding:2px 6px; border-radius:10px; font-size:11px; background:#eee; }
                .perf-badge.good { background:#d4edda; color:#155724; }
                .perf-badge.bad { background:#f8d7da; color:#721c24; }
                .perf-status-dot { width:8px; height:8px; border-radius:50%; background:#ccc; display:inline-block; margin-left:5px; }
                .perf-status-dot.on { background:#28a745; }
                .perf-status-dot.off { background:#dc3545; }
                .perf-log-box { margin-top:15px; max-height:80px; overflow-y:auto; background:#f1f3f5; padding:8px; border-radius:5px; font-size:11px; color:#555; }
                .perf-log-item { margin-bottom:4px; border-bottom:1px solid #e9ecef; padding-bottom:2px; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            `;
            document.head.appendChild(style);

            this.button = this.el('div', 'perf-btn', '⚡');
            this.button.onclick = (e) => {
                e.stopPropagation();
                const isHidden = this.panel.style.display === 'none';
                if (isHidden) {
                    this.panel.style.display = 'block';
                    this.panel.classList.add('show');
                    this.update();
                    this.startLiveUpdate();
                } else {
                    this.panel.style.display = 'none';
                    this.panel.classList.remove('show');
                    this.stopLiveUpdate();
                }
            };
            document.body.appendChild(this.button);

            this.panel = this.el('div', 'perf-panel');
            this.panel.style.display = 'none';
            this.panel.appendChild(this.el('div', 'perf-title', '🚀 성능 최적화 센터 (Insight)'));

            const sec1 = this.el('div', 'perf-section');
            const row1 = this.el('div', 'perf-row');
            row1.appendChild(this.el('b', '', '엔진 자동 판단'));
            sec1.appendChild(row1);
            const rowDec = this.el('div', 'perf-row');
            this.uiDecision = this.el('span', '', '정상 가동 중');
            this.uiDecision.style.fontWeight = 'bold';
            rowDec.appendChild(this.uiDecision);
            sec1.appendChild(rowDec);
            this.panel.appendChild(sec1);

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

            const sec3 = this.el('div', 'perf-section');
            sec3.style.background = 'transparent'; sec3.style.padding = '0';
            const rowMods = this.el('div', 'perf-row');
            rowMods.appendChild(this.el('b', '', '모듈 상태'));
            sec3.appendChild(rowMods);

            const isMotionActive = !Env.isNoMotion;
            const isRenderActive = !Env.isNoRender;
            const isThrottleActive = !Env.isNoThrottle;

            const createModRow = (label, isOn, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const dot = this.el('div', `perf-status-dot ${isOn ? 'on' : 'off'}`);
                if(id) dot.id = id;
                r.appendChild(dot);
                return r;
            };

            sec3.appendChild(createModRow('🚀 동작 줄이기', isMotionActive));
            sec3.appendChild(createModRow('🖼️ 이미지 지연 로딩', isRenderActive));
            sec3.appendChild(createModRow('👁️ 렌더링 최적화', isRenderActive));
            sec3.appendChild(createModRow('🔗 스마트 프리패치', true, 'ui-dot-link'));
            sec3.appendChild(createModRow('💤 백그라운드 절전', isThrottleActive));
            this.panel.appendChild(sec3);

            // [v9.0] 로그 히스토리 영역
            this.logContainer = this.el('div', 'perf-log-box', '');
            this.panel.appendChild(this.logContainer);

            // [v9.0] 하단 통계 복구 (UI 공간 확보 위해 폰트 작게)
            const rowStats = this.el('div', 'perf-row');
            rowStats.style.borderTop = '1px solid #eee';
            rowStats.style.paddingTop = '8px';
            rowStats.style.marginTop = '8px';
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

            const footer = this.el('div', 'perf-row', 'Ver 9.0.0-KR-ControlInsight');
            footer.style.marginTop = '10px';
            footer.style.fontSize = '10px';
            footer.style.color = '#999';
            this.panel.appendChild(footer);

            document.body.appendChild(this.panel);
        }

        startLiveUpdate() {
            this.stopLiveUpdate();
            const loop = () => {
                if (!this.panel.classList.contains('show')) return;
                this.update();
                this.animFrameId = setTimeout(() => {
                    requestAnimationFrame(loop);
                }, 100);
            };
            loop();
        }

        stopLiveUpdate() {
            if (this.animFrameId) {
                clearTimeout(this.animFrameId);
                this.animFrameId = null;
            }
        }

        update() {
            if (!this.monitor) return;
            const m = this.monitor.getMetrics();

            const updateBadge = (id, val, goodLimit, suffix='') => {
                const el = document.getElementById(id);
                if (!el) return;
                if (val === null || val === undefined) { el.className = 'perf-badge'; el.textContent = '--'; return; }
                el.textContent = (typeof val === 'number' ? val.toFixed(suffix?0:3) : val) + suffix;
                el.className = `perf-badge ${val <= goodLimit ? 'good' : 'bad'}`;
            };

            if (this.uiDecision) {
                const decisionText = Env.state.isOverloaded ? Env.state.decisionText : '✅ 최적 상태 유지 중';
                const reason = `(${Env.state.activeReason})`;
                this.uiDecision.textContent = `${decisionText} ${reason}`;

                if (Env.state.isOverloaded) this.uiDecision.style.color = '#dc3545';
                else if (Env.state.isSlowNetwork) this.uiDecision.style.color = '#ffc107';
                else this.uiDecision.style.color = '#28a745';
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

            // [v9.0] 로그 업데이트
            if (this.logContainer) {
                this.logContainer.innerHTML = Env.state.history.map(item =>
                    `<div class="perf-log-item"><b>[${item.t}]</b> ${item.msg}</div>`
                ).join('');
            }
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
                suspend: new MediaSuspender(), // [v9.0] 추가
                motion: new MotionReducer(),
                img: new ImageOptimizer(),
                gpu: new GPUAccelerator(),
                vis: new ContentVisibility(),
                link: new LinkPrefetcher(),
                throttle: new BackgroundThrottler(),
                monitor: new PerformanceMonitor(),
                ui: new UIController()
            };

            Object.values(modules).forEach(m => m.safeInit());
            modules.ui.setMonitor(modules.monitor);

            window.addEventListener('pageshow', (e) => {
                if (e.persisted) {
                    modules.throttle.restore();
                    modules.link.init();
                    modules.ui.stopLiveUpdate();
                }
            });
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => new AppController().init());
    else new AppController().init();

})();
