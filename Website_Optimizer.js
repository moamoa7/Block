// ==UserScript==
// @name        Web 성능 Ultra-Lite 최적화 (v43.1 ULTRA Fixed)
// @namespace   http://tampermonkey.net/
// @version     43.1.0-KR-ULTRA-Fixed
// @description [ULTRA] UI 제거 + 이벤트 최적화 + 하드웨어 가속 + 메모리 관리 (Complete)
// @author      KiwiFruit
// @match       *://*/*
// @grant       unsafeWindow
// @license     MIT
// @run-at      document-start
// ==/UserScript==

(function () {
    'use strict';

    const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const rIC = win.requestIdleCallback || ((cb) => setTimeout(cb, 50));

    // ==========================================
    // 1. Critical Safety Checks
    // ==========================================
    const CRITICAL_DOMAINS = ['upbit.com', 'binance.com', 'gov.kr', 'hometax.go.kr', 'nts.go.kr'];
    if (CRITICAL_DOMAINS.some(d => win.location.hostname.endsWith(d))) {
        // UI가 없으므로 console로만 상태를 남김 (개발자 도구에서 확인 가능)
        win.perfx = { status: '🔒 Critical Mode (Inactive)' };
        return;
    }

    // ==========================================
    // 2. Headless Configuration
    // ==========================================
    const Env = {
        storageKey: `PerfX_ULTRA_${win.location.hostname}`,
        // 설정 변경법: 개발자 도구 콘솔에서 localStorage.setItem('PerfX_ULTRA_도메인', JSON.stringify({memory:false})) 입력
        getOverrides() { try { return JSON.parse(localStorage.getItem(this.storageKey)) || {}; } catch { return {}; } }
    };

    const initialOverrides = Env.getOverrides();
    const Config = {
        codecMode: initialOverrides.codecMode ?? 'hard',
        passive: initialOverrides.passive ?? true,
        gpu: initialOverrides.gpu ?? true,
        memory: initialOverrides.memory ?? true // ULTRA 버전은 기본값을 True로 권장 (UI가 없으므로)
    };

    // ==========================================
    // 3. Module System
    // ==========================================
    class BaseModule {
        safeInit() { try { this.init(); } catch (e) {} } // 에러 로그조차 생략하여 성능 확보
        init() {}
    }

    // ==========================================
    // 4. Core Modules
    // ==========================================

    // [Core 1] 입력 반응속도 부스팅
    class EventPassivator extends BaseModule {
        init() {
            if (!Config.passive) return;
            if (win.__perfx_evt_patched) return;
            win.__perfx_evt_patched = true;

            const targetProtos = [EventTarget.prototype, Node.prototype, win.constructor.prototype];
            const passiveEvents = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel']);

            targetProtos.forEach(proto => {
                const origAdd = proto.addEventListener;
                proto.addEventListener = function(type, listener, options) {
                    if (passiveEvents.has(type)) {
                        if (typeof options !== 'object') options = { passive: true, capture: !!options };
                        else if (options.passive === undefined) options = { ...options, passive: true };
                    }
                    return origAdd.call(this, type, listener, options);
                };
            });
        }
    }

    // [Core 2] 미디어 코덱 강제 (H.264)
    class CodecOptimizer extends BaseModule {
        init() {
            if (this.hooked) return;
            const SAFE_ZONES = ['meet.google.com', 'zoom.us', 'discord.com', 'teams.microsoft.com', 'webex.com'];
            if (SAFE_ZONES.some(d => win.location.hostname.includes(d))) return;

            const hook = () => {
                if (!win.MediaSource || win.MediaSource._perfXHooked) return;
                const orig = win.MediaSource.isTypeSupported?.bind(win.MediaSource);
                if (!orig) return;

                win.MediaSource.isTypeSupported = (t) => {
                    if (Config.codecMode === 'hard') {
                        if (t.toLowerCase().includes('av01') || t.toLowerCase().match(/vp9|vp09/)) return false;
                    }
                    return orig(t);
                };
                win.MediaSource._perfXHooked = true;
            };
            hook();
            if (!win.MediaSource) Object.defineProperty(win, 'MediaSource', { configurable: true, set: (v) => { delete win.MediaSource; win.MediaSource = v; hook(); } });
            this.hooked = true;
        }
    }

    // [Core 3] GPU & 메모리 통합 관리자
    class DomWatcher extends BaseModule {
        init() {
            if (!this.contextHooked && Config.gpu) { this.injectWebGL(); this.contextHooked = true; }
            this.startObserver();
        }

        injectWebGL() {
            try {
                // 저전력 기기 감지
                const isLowPower = navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4;
                const powerMode = isLowPower ? 'default' : 'high-performance';
                const hook = (proto) => {
                    const orig = proto.getContext;
                    proto.getContext = function(type, options) {
                        if (Config.gpu && type && type.includes('webgl')) {
                            options = { ...options, powerPreference: powerMode, desynchronized: true, antialias: false, stencil: false, depth: true };
                        }
                        return orig.call(this, type, options);
                    };
                };
                hook(HTMLCanvasElement.prototype);
                if (win.OffscreenCanvas) hook(OffscreenCanvas.prototype);
            } catch (e) {}
        }

        startObserver() {
            // IntersectionObserver: 화면 밖 요소 처리
            this.visObs = new IntersectionObserver(entries => entries.forEach(e => {
                // 1. Canvas 처리 (GPU)
                if (e.target.tagName === 'CANVAS' && Config.gpu) {
                    e.target.style.visibility = e.isIntersecting ? 'visible' : 'hidden';
                }
                // 2. 일반 DOM 처리 (Memory) - [복구된 로직]
                else if (Config.memory) {
                    if (e.isIntersecting) {
                        e.target.style.contentVisibility = 'visible';
                    } else {
                        // 높이가 있는 요소만 압축 (레이아웃 깨짐 방지)
                        e.target.style.containIntrinsicSize = `1px ${e.target.offsetHeight}px`;
                        e.target.style.contentVisibility = 'auto';
                    }
                }
            }), { rootMargin: '600px 0px', threshold: 0.01 });

            // 관찰 대상 (메모리 누수 주범들)
            const TARGET_SELECTORS = 'main, [role="feed"], .feed, #content, .infinite-scroll';
            const MEMORY_CHILDREN = '[role="feed"] > *, .infinite-scroll > *, ul > li';

            let pendingMutations = new Set();
            let throttleTimer = null;

            // 스로틀링: 200ms마다 한 번씩만 관찰 등록 (CPU 보호)
            const flushMutations = () => {
                pendingMutations.forEach(node => {
                    // Canvas는 무조건 관찰
                    if (Config.gpu && node.tagName === 'CANVAS') this.visObs.observe(node);
                    // Memory 설정이 켜져있고, 리스트 아이템인 경우만 관찰
                    if (Config.memory && node.matches && node.matches(MEMORY_CHILDREN)) this.visObs.observe(node);
                });
                pendingMutations.clear();
                throttleTimer = null;
            };

            const handleMutations = (mutations) => {
                mutations.forEach(m => m.addedNodes.forEach(n => {
                    if (n.nodeType === 1) pendingMutations.add(n);
                }));
                if (!throttleTimer) throttleTimer = setTimeout(flushMutations, 200);
            };

            rIC(() => {
                // 1. 주요 컨텐츠 영역 감시
                const contents = document.querySelectorAll(TARGET_SELECTORS);
                if (contents.length > 0) {
                    contents.forEach(el => {
                        new MutationObserver(handleMutations).observe(el, { childList: true, subtree: true });
                    });
                } else {
                    // 주요 영역 못 찾으면 Body 감시 (Fallback)
                    new MutationObserver(handleMutations).observe(document.body, { childList: true, subtree: true });
                }

                // 2. 초기 로드된 캔버스 즉시 등록
                if (Config.gpu) document.querySelectorAll('canvas').forEach(c => this.visObs.observe(c));
            });
        }
    }

    // ==========================================
    // 5. Init Sequence
    // ==========================================
    [new EventPassivator(), new CodecOptimizer(), new DomWatcher()].forEach(m => m.safeInit());

})();
