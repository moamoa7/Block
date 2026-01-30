// ==UserScript==
// @name         Web 성능 종합 최적화 도구상자 (v13.0.0 PerformanceX)
// @namespace    http://tampermonkey.net/
// @version      13.0.0-KR-PerformanceX
// @description  H.264 코덱 강제(저사양 가속); 트위치/치지직 채팅창 보호; 메모리 누수 방지
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
    // 1. 도메인 리스트
    // ========================
    const SiteLists = {
        // [1] 백그라운드 절전 제외 (영상/AI 답변 끊김 방지) (미디어 정지 안 함 & 절전 안 함)
        noThrottling: [
            // 📡 실시간 방송 / 라이브 스트리밍
            'youtube.com', 'twitch.tv', 'sooplive.co.kr', 'chzzk.naver.com', 'tv.naver.com', 'tv.kakao.com', 'pandalive.co.kr',

            // 🎬 OTT / 동영상 플랫폼
            'netflix.com', 'tving.com', 'wavve.com', 'coupangplay.com', 'disneyplus.com', 'watcha.com',
            'ok.ru',

            // 🤖 AI 채팅 (실시간 답변 생성 중 끊김 방지)
            'gemini.google.com', 'chatgpt.com', 'claude.ai',

            // 🎵 음악 스트리밍
            'music.youtube.com', 'spotify.com',

            // 기타
           'github.com',
        ],

        // [2] 동작 줄이기 제외 (강제 애니메이션 제거 시 UI가 깨지는 곳)
        noMotion: [
            // OTT 프로필 선택 화면 / 영상 안보임 등
            'coupangplay.com', 'wavve.com',
            // 화려한 웹사이트 / AI 효과
            'apple.com', 'gemini.google.com',
            // 일부 애니메이션 효과 안보임
            'etoland.co.kr',
        ],

        // [3] 렌더링/GPU 간섭 제외 (레이아웃 틀어짐 방지)
        noRender: [
            // 채팅창 레이어 깨짐 방지
            'twitch.tv',
            // 사이트 레이아웃 깨짐 방지
            'youtube.com', 'dcinside.com', 'tv.naver.com', 'tvwiki5.net', 'avsee.ru', 'cineaste.co.kr', 'inven.co.kr',
        ]
    };

    // ========================
    // 2. 환경 엔진
    // ========================
    const Env = {
        features: {
            nativeLazyLoad: 'loading' in HTMLImageElement.prototype,
            intersectionObserver: 'IntersectionObserver' in window,
            mutationObserver: 'MutationObserver' in window,
            performanceObserver: 'PerformanceObserver' in window,
            requestIdleCallback: 'requestIdleCallback' in window,
            contentVisibility: CSS.supports('content-visibility', 'hidden'),
            webgpu: typeof GPU !== 'undefined' && !!navigator.gpu,
            mediaSource: 'MediaSource' in window
        },
        state: {
            isOverloaded: false,
            longTaskCount: 0,
            // [판단 기준] 코어가 4개 이하거나, 기기 메모리(RAM)가 4GB 이하면 저사양으로 간주
            isLowEnd: navigator.hardwareConcurrency <= 4 || (navigator.deviceMemory && navigator.deviceMemory <= 4),
            isSlowNetwork: false,
            activeReason: '초기화 중',
            cleanedCount: 0,
            disabledModules: new Set(),
            history: [],
            isThrottleActive: false
        },

        log(msg) {
            const time = new Date().toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
            this.state.history.unshift({ t: time, msg: msg });
            if (this.state.history.length > 5) this.state.history.pop();
        },

        isMatch(list) {
            const host = window.location.hostname;
            return list.some(domain => host.includes(domain));
        },

        checkDomain() {
            this.isNoThrottle = this.isMatch(SiteLists.noThrottling);
            this.isNoMotion = this.isMatch(SiteLists.noMotion);
            this.isNoRender = this.isMatch(SiteLists.noRender);

            if (this.isNoThrottle) {
                this.state.activeReason = '스트리밍/AI 보호';
                this.log('화이트리스트: 보호 모드 가동');
            } else {
                this.state.activeReason = '일반 모드 (절전 대기)';
                this.log('일반 사이트: 최적화 준비 완료');
            }
        },

        checkNetwork() {
            const conn = navigator.connection;
            if (conn) {
                this.state.isSlowNetwork = conn.saveData || (conn.effectiveType && conn.effectiveType.includes('2g'));
            }
        }
    };

    Env.checkDomain();

    const Config = {
        debug: false,
        ui: { enabled: true },
        memory: {
            enabled: true,
            interval: 30000,
            maxChildren: 1000, keepCount: 500,
            targetSelector: 'ul, ol, div[class*="chat"], div[class*="list"], div[class*="log"], div[class*="comment"]',
            activeTimeout: 60000
        },
        preconnect: {
            enabled: true,
            domains: ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'ajax.googleapis.com']
        },
        // [New] 코덱 최적화 설정
        codec: {
            enabled: true,
            forceH264: Env.state.isLowEnd // 저사양일 때만 기본 활성화 (원하면 true로 강제 가능)
        },
        scheduler: { deadline: 10, maxTasksPerTick: 15 },
        lazyLoad: { enabled: true, selector: 'img[data-src], img.lazy', preloadDistance: 150 },
        reduceMotion: { enabled: true },
        hardwareAcceleration: { enabled: true, selector: 'header, nav, aside, .sticky', skipViewportElements: true },
        contentVisibility: { enabled: true, selector: 'section, article, .post, .comment-list', hiddenDistance: 800, excludeSelectors: '[contenteditable], .player' },
        linkPrefetch: { enabled: true, hoverDelay: 65, sameOriginOnly: true },
        backgroundThrottle: { enabled: true, throttleDelay: 1000 }
    };

    // ========================
    // 3. 모듈 정의
    // ========================
    class BaseModule {
        constructor(name) { this.moduleName = name; this.observer = null; }
        safeInit() {
            try {
                this.init();
            } catch (e) {
                console.warn(`[PerfOpt] ❌ ${this.moduleName} Crashed!`, e);
                Env.state.disabledModules.add(this.moduleName);
                Env.log(`❌ ${this.moduleName} 오류로 중단됨`);
            }
        }
        init() {}
    }

    // [New] 코덱 최적화 모듈 (참고한 스크립트의 핵심 기능 이식)
    class CodecOptimizer extends BaseModule {
        constructor() { super('CodecOptimizer'); }

        init() {
            // 저사양 기기가 아니거나 설정이 꺼져있으면 작동 안 함
            if (!Config.codec.enabled || !Config.codec.forceH264) return;
            if (!Env.features.mediaSource) return;

            const mse = window.MediaSource;
            const originalIsTypeSupported = mse.isTypeSupported.bind(mse);

            // MSE의 코덱 지원 여부 확인 함수를 후킹(Hijack)
            mse.isTypeSupported = (type) => {
                if (type === undefined) return '';
                const lowerType = type.toLowerCase();

                // VP9, AV1 코덱을 "지원하지 않음"으로 거짓말을 함
                // 그러면 유튜브/트위치는 어쩔 수 없이 가벼운 H.264(avc1)를 보내줌
                if (lowerType.includes('vp9') || lowerType.includes('vp09') || lowerType.includes('av01')) {
                    return false;
                }
                return originalIsTypeSupported(type);
            };

            Env.log('🎥 H.264 코덱 강제 적용 (가속 최적화)');
        }
    }

    class PreconnectOptimizer extends BaseModule {
        constructor() { super('PreconnectOptimizer'); }
        init() {
            if (!Config.preconnect.enabled) return;
            Config.preconnect.domains.forEach(domain => {
                const link = document.createElement('link');
                link.rel = 'preconnect';
                link.href = `https://${domain}`;
                link.crossOrigin = 'anonymous';
                document.head.appendChild(link);

                const dns = document.createElement('link');
                dns.rel = 'dns-prefetch';
                dns.href = `https://${domain}`;
                document.head.appendChild(dns);
            });
        }
    }

    class MemoryGuardian extends BaseModule {
        constructor() { super('MemoryGuardian'); }
        init() {
            if (!Config.memory.enabled) return;
            const mark = (e) => this.markActive(e);
            document.addEventListener('mousedown', mark, { passive: true });
            document.addEventListener('touchstart', mark, { passive: true });
            document.addEventListener('keydown', mark, { passive: true });
            setInterval(() => {
                if (window.requestIdleCallback) window.requestIdleCallback(() => this.cleanUp());
                else setTimeout(() => this.cleanUp(), 100);
            }, Config.memory.interval);
        }
        markActive(e) {
            const target = e.target.closest(Config.memory.targetSelector);
            if (target) target.dataset.poLastActive = Date.now();
        }
        cleanUp() {
            const candidates = document.querySelectorAll(Config.memory.targetSelector);
            let removedTotal = 0;
            const now = Date.now();
            candidates.forEach(container => {
                if (container.dataset.poProtected) return;
                if (container.matches(':hover')) return;
                if (container.contains(document.activeElement)) return;
                const lastActive = parseInt(container.dataset.poLastActive || '0');
                if (now - lastActive < Config.memory.activeTimeout) return;
                if (container.scrollHeight > container.clientHeight && container.scrollHeight - container.scrollTop - container.clientHeight > 50) return;
                if (container.isContentEditable) return;
                const count = container.childElementCount;
                if (count > Config.memory.maxChildren) {
                    const toRemove = count - Config.memory.keepCount;
                    for (let i = 0; i < toRemove; i++) {
                        if (container.firstElementChild) {
                            container.removeChild(container.firstElementChild);
                            removedTotal++;
                        }
                    }
                }
            });
            if (removedTotal > 0) {
                Env.state.cleanedCount += removedTotal;
                Env.log(`🧹 메모리 정리: ${removedTotal}개 삭제`);
            }
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
            Env.log('⚠️ CPU 과부하: 임시 절전 가동');
            setTimeout(() => {
                Env.state.isOverloaded = false;
                Env.state.activeReason = '시스템 정상화';
            }, 5000);
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
                new MutationObserver((mutations) => {
                    for (const m of mutations) if (m.addedNodes.length) applyNative(m.addedNodes);
                }).observe(document.body, { childList: true, subtree: true });
            }
        }
    }

    class GPUAccelerator extends BaseModule {
        init() {
            if (Env.isNoRender || !Config.hardwareAcceleration.enabled || Env.state.isLowEnd) return;

            const apply = (el) => {
                if (el.classList.contains('gpu-acc') || el.closest('.streaming')) return;
                if (Config.hardwareAcceleration.skipViewportElements) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top < window.innerHeight && rect.bottom > 0) {
                        setTimeout(() => {
                            el.classList.add('gpu-acc');
                            el.style.transform = 'translateZ(0)';
                        }, 3000);
                        return;
                    }
                }
                el.classList.add('gpu-acc');
                el.style.transform = 'translateZ(0)';
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
            new MutationObserver((mutations) => {
                if (window.requestIdleCallback) window.requestIdleCallback(() => {
                    for (const m of mutations) if (m.addedNodes.length) scan(m.addedNodes);
                });
            }).observe(document.body, { childList: true, subtree: true });
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
                    if (el.tagName === 'CANVAS' || el.querySelector('canvas')) return false;
                    if (el.getAttribute('data-webgpu') || el.querySelector('[data-webgpu]')) return false;
                    if (el.querySelector('video, iframe, [role="img"]')) return false;
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

            new MutationObserver((mutations) => {
                if (window.requestIdleCallback) window.requestIdleCallback(() => {
                    for (const m of mutations) if (m.addedNodes.length) scan(m.addedNodes);
                });
            }).observe(document.body, { childList: true, subtree: true });

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
            new MutationObserver((mutations) => {
                for (const m of mutations) if (m.addedNodes.length) scan(m.addedNodes);
            }).observe(document.body, { childList: true, subtree: true });
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
            Env.log('💤 탭 비활성: 절전 모드 진입');
            Env.state.isThrottleActive = true;
            window.requestAnimationFrame = (cb) => this.origTimeout(() => this.origRAF((t) => cb(t)), 1000);
            window.setInterval = (cb, t) => this.origInterval(cb, Math.max(t, 1000));
            window.setTimeout = (cb, t) => this.origTimeout(cb, Math.max(t, 1000));
        }
        restore() {
            document.title = document.title.replace(/^💤 /, '');
            Env.log('⚡ 탭 활성: 절전 해제');
            Env.state.isThrottleActive = false;
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
            new PerformanceObserver((l) => l.getEntries().forEach(e => { if (e.name === 'first-contentful-paint') this.metrics.fcp = Math.round(e.startTime); })).observe({ type: 'paint', buffered: true });
            new PerformanceObserver((l) => l.getEntries().forEach(e => { if (!e.hadRecentInput) this.metrics.cls += e.value; })).observe({ type: 'layout-shift', buffered: true });
            new PerformanceObserver((l) => { const e = l.getEntries(); if(e.length) this.metrics.lcp = Math.round(e[e.length-1].startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
        }
        getMetrics() { return this.metrics; }
    }

    // ========================
    // 4. UI 컨트롤러
    // ========================
    class UIController extends BaseModule {
        constructor() { super('UIController'); this.visible = false; this.button = null; this.panel = null; this.monitor = null; this.animFrameId = null; }
        setMonitor(monitor) { this.monitor = monitor; }
        init() { if (!Config.ui.enabled) return; this.createUI(); }
        el(tag, cls, txt) { const e = document.createElement(tag); if(cls) e.className=cls; if(txt) e.textContent=txt; return e; }

        createUI() {
            const style = document.createElement('style');
            style.textContent = `
                .perf-btn { position:fixed; bottom:60px; right:10px; width:30x; height:30px; border-radius:50%; background:#4a90e2; color:#fff; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:2147483647; box-shadow:0 4px 10px rgba(0,0,0,0.2); font-size:24px; transition:transform 0.2s; }
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
                .perf-status-dot.err { background:#fd7e14; }
                .perf-log-box { margin-top:10px; max-height:60px; overflow-y:auto; background:#f1f3f5; padding:8px; border-radius:5px; font-size:10px; color:#555; }
                .perf-log-item { margin-bottom:3px; border-bottom:1px solid #e9ecef; padding-bottom:2px; }
                @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            `;
            document.head.appendChild(style);

            this.button = this.el('div', 'perf-btn', '⚡');
            this.button.onclick = (e) => {
                e.stopPropagation();
                if (this.panel.style.display === 'none') {
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
            this.panel.appendChild(this.el('div', 'perf-title', '🚀 PerformanceX (v13.0)'));

            const sec1 = this.el('div', 'perf-section', '');
            sec1.style.background = '#f8f9fa'; sec1.style.padding = '10px'; sec1.style.borderRadius = '8px'; sec1.style.marginBottom = '15px';
            const r1 = this.el('div', 'perf-row');
            r1.appendChild(this.el('b', '', '엔진 상태'));
            sec1.appendChild(r1);
            const r2 = this.el('div', 'perf-row');
            this.uiDecision = this.el('span', '', '대기 중...');
            this.uiDecision.style.fontWeight = 'bold';
            r2.appendChild(this.uiDecision);
            sec1.appendChild(r2);
            this.panel.appendChild(sec1);

            const r3 = this.el('div', 'perf-row');
            r3.appendChild(this.el('b', '', 'Web Vitals'));
            this.panel.appendChild(r3);
            const addMetric = (label, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const v = this.el('span', 'perf-badge', '--');
                v.id = id;
                r.appendChild(v);
                this.panel.appendChild(r);
            };
            addMetric('FCP (첫 화면)', 'ui-fcp');
            addMetric('LCP (최대 로딩)', 'ui-lcp');
            addMetric('CLS (화면 밀림)', 'ui-cls');

            const r4 = this.el('div', 'perf-row');
            r4.style.marginTop = '15px';
            r4.appendChild(this.el('b', '', '모듈 상태'));
            this.panel.appendChild(r4);

            const addMod = (label, isOn, moduleName, dynamicId) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));

                let dotClass = 'off';
                if (Env.state.disabledModules.has(moduleName)) dotClass = 'err';
                else if (isOn) dotClass = 'on';

                const d = this.el('div', `perf-status-dot ${dotClass}`);
                if (dynamicId) d.id = dynamicId;
                r.appendChild(d);
                this.panel.appendChild(r);
            };

            addMod('🚀 동작 줄이기', !Env.isNoMotion, 'MotionReducer');
            addMod('🖼️ 이미지 지연', !Env.isNoRender, 'ImageOptimizer');
            addMod('👁️ 렌더링/GPU', !Env.isNoRender, 'GPUAccelerator');
            addMod('🔗 스마트 프리패치', true, 'LinkPrefetcher', 'ui-dot-link');
            addMod('🔌 CDN 프리커넥트', Config.preconnect.enabled, 'PreconnectOptimizer');
            addMod('🎥 H.264 코덱강제', Config.codec.forceH264, 'CodecOptimizer'); // [New UI]
            addMod('💤 백그라운드 절전', !Env.isNoThrottle, 'BackgroundThrottler', 'ui-dot-throttle');

            const rMem = this.el('div', 'perf-row');
            rMem.appendChild(this.el('span', '', '🧹 메모리 청소됨'));
            this.memCount = this.el('b', '', '0');
            rMem.appendChild(this.memCount);
            this.panel.appendChild(rMem);

            const rStat = this.el('div', 'perf-row');
            rStat.style.marginTop = '10px'; rStat.style.borderTop = '1px solid #eee'; rStat.style.paddingTop = '10px';
            rStat.appendChild(this.el('b', '', '상세 통계'));
            this.panel.appendChild(rStat);
            const addStat = (label, id) => {
                const r = this.el('div', 'perf-row');
                r.appendChild(this.el('span', '', label));
                const v = this.el('b', '', '0');
                v.id = id;
                r.appendChild(v);
                this.panel.appendChild(r);
            }
            addStat('지연 로딩된 수', 'ui-lazy');
            addStat('프리패치된 링크', 'ui-prefetch');
            addStat('GPU 가속 요소', 'ui-gpu');

            this.logContainer = this.el('div', 'perf-log-box', '');
            this.panel.appendChild(this.logContainer);

            const footer = this.el('div', 'perf-row', 'Ver 13.0.0-KR-PerformanceX');
            footer.style.marginTop = '10px'; footer.style.fontSize = '10px'; footer.style.color = '#999';
            this.panel.appendChild(footer);
            document.body.appendChild(this.panel);
        }

        startLiveUpdate() {
            this.stopLiveUpdate();
            const loop = () => {
                if (!this.panel.classList.contains('show')) return;
                this.update();
                this.animFrameId = setTimeout(() => requestAnimationFrame(loop), 200);
            };
            loop();
        }

        stopLiveUpdate() {
            if (this.animFrameId) { clearTimeout(this.animFrameId); this.animFrameId = null; }
        }

        update() {
            if (!this.monitor) return;
            const m = this.monitor.getMetrics();

            const setBadge = (id, v, lim) => {
                const e = document.getElementById(id);
                if (!e) return;
                if (v === null) { e.className = 'perf-badge'; e.textContent = '--'; return; }
                e.textContent = typeof v === 'number' ? v.toFixed(0) : v;
                e.className = `perf-badge ${v <= lim ? 'good' : 'bad'}`;
            };

            setBadge('ui-fcp', m.fcp, 1800);
            setBadge('ui-lcp', m.lcp, 2500);
            setBadge('ui-cls', m.cls, 0.1);

            const decisionText = Env.state.isOverloaded ? Env.state.decisionText : '✅ 최적 상태 유지 중';
            const reason = `(${Env.state.activeReason})`;
            this.uiDecision.textContent = `${decisionText} ${reason}`;
            if (Env.state.isOverloaded) this.uiDecision.style.color = '#dc3545';
            else if (Env.state.isSlowNetwork) this.uiDecision.style.color = '#ffc107';
            else this.uiDecision.style.color = '#28a745';

            const linkDot = document.getElementById('ui-dot-link');
            if (linkDot) {
                if (Env.state.isOverloaded || Env.state.isSlowNetwork) linkDot.className = 'perf-status-dot off';
                else linkDot.className = 'perf-status-dot on';
            }
            const throttleDot = document.getElementById('ui-dot-throttle');
            if (throttleDot) {
                throttleDot.className = Env.state.isThrottleActive ? 'perf-status-dot on' : 'perf-status-dot off';
            }

            const lazyCount = document.querySelectorAll('img[loading="lazy"]').length;
            const prefetchCount = document.querySelectorAll('link[rel="prefetch"]').length;
            const gpuCount = document.querySelectorAll('.gpu-acc').length;

            if (document.getElementById('ui-lazy')) document.getElementById('ui-lazy').textContent = lazyCount;
            if (document.getElementById('ui-prefetch')) document.getElementById('ui-prefetch').textContent = prefetchCount;
            if (document.getElementById('ui-gpu')) document.getElementById('ui-gpu').textContent = gpuCount;
            if (this.memCount) this.memCount.textContent = Env.state.cleanedCount + ' 개';

            if (this.logContainer) {
                this.logContainer.innerHTML = Env.state.history.map(item => `<div class="perf-log-item"><b>[${item.t}]</b> ${item.msg}</div>`).join('');
            }
        }
    }

    // ========================
    // 5. 앱 컨트롤러
    // ========================
    class AppController {
        init() {
            const modules = {
                sys: new SystemMonitor('SystemMonitor'),
                mem: new MemoryGuardian('MemoryGuardian'),
                motion: new MotionReducer('MotionReducer'),
                img: new ImageOptimizer('ImageOptimizer'),
                gpu: new GPUAccelerator('GPUAccelerator'),
                vis: new ContentVisibility('ContentVisibility'),
                link: new LinkPrefetcher('LinkPrefetcher'),
                precon: new PreconnectOptimizer('PreconnectOptimizer'),
                codec: new CodecOptimizer('CodecOptimizer'), // [New]
                throttle: new BackgroundThrottler('BackgroundThrottler'),
                monitor: new PerformanceMonitor('PerformanceMonitor'),
                ui: new UIController('UIController')
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
