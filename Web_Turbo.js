// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      6.2
// @description 모든 웹사이트에서 렉을 제거하고 최적의 성능을 보장합니다. 지능형 타이머 쓰로틀링, 비핵심 요청 지연, LoAF 기반 실시간 렉 감지 및 강력한 메모리 관리 기능을 통해 압도적인 부드러움을 제공합니다.
// @author       You & Oppai1442 Logic
// @match        *://*/*
// @exclude      *://www.google.com/maps/*
// @exclude      *://www.figma.com/*
// @exclude      *://*.figma.com/*
// @exclude      *://docs.google.com/spreadsheets/*
// @exclude      *://excalidraw.com/*
// @exclude      *://*.unity3dusercontent.com/*
// @exclude      *://play.unity.com/*
// @exclude      *://www.photopea.com/*
// @exclude      *://pixlr.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ═══════════════════════════════════════════════
    // §1. 상수 & 설정
    // ═══════════════════════════════════════════════
    const SELECTOR_LIST = [
        'article', 'section', 'main', '.post', '.content', '.comment',
        'section[data-testid^="conversation-turn-"]',
        'div[class*="ChatMessage"]',
        'infinite-scroller > div', 'chat-view-item'
    ];
    const SELECTORS = SELECTOR_LIST.join(', ');
    const MEDIA_SELECTOR = 'img, video, iframe';
    const CANVAS_SELECTOR = 'canvas';
    const ALL_RESOURCE_SELECTOR = MEDIA_SELECTOR + ', ' + CANVAS_SELECTOR;

    const CONFIG = {
        limitNodes:                150,
        gcMarginTop:               800,
        gcMarginBottom:            2500,
        idleTimeout:               3000,
        throttleDwell:             120,
        lowPowerFrameThreshold:    40,
        lowPowerLimitNodes:        80,
        lowPowerBatteryThreshold:  0.15,
        mediaMarginTop:            300,
        mediaMarginBottom:         1000,
        fpsAlpha:                  0.15,
        gcTaskPriority:            'background',
        hardReclaimMarginTop:      4000,
        hardReclaimMarginBottom:   6000,
        restoreBatchSize:          3,
        memoryThresholdBytes:      800 * 1024 * 1024,
        memoryCheckInterval:       15000,
        loafJankThresholdMs:       100,
        loafJankWindowSize:        5,
        slowNetBatchSize:          1,
        blobAutoExpireMs:          60000,
        hibernateDelayMs:          30 * 60 * 1000,
        bulkCleanupThreshold:      50,

        // [v6.2] 타이머 쓰로틀링
        timerThrottleMinInterval:  1000,   // 백그라운드 최소 간격 (ms)
        timerThrottleThreshold:    500,    // 이 미만 주기만 쓰로틀 대상

        // [v6.2] 비핵심 요청 지연
        deferRequestsUntilLoad:    true,   // document 로드 완료까지 비핵심 요청 지연
    };

    let isLowPowerMode = false;
    let effectiveLimitNodes = CONFIG.limitNodes;
    let memoryPressure = false;
    let scrollDirection = 1;
    let effectiveRestoreBatch = CONFIG.restoreBatchSize;

    let statsReclaimCount = 0;
    let statsRestoreCount = 0;
    let statsHibernateCount = 0;
    let statsDeferredRequests = 0;          // [v6.2]
    let statsThrottledTimers = 0;           // [v6.2]

    // ═══════════════════════════════════════════════
    // §2. 패시브 이벤트 리스너 강제화
    // ═══════════════════════════════════════════════
    {
        const origAdd = EventTarget.prototype.addEventListener;
        const PASSIVE_TYPES = new Set([
            'touchstart', 'touchmove', 'wheel', 'mousewheel', 'scroll'
        ]);
        const CACHED_PASSIVE_FALSE = Object.freeze({ passive: true, capture: false });
        const CACHED_PASSIVE_TRUE  = Object.freeze({ passive: true, capture: true });

        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (PASSIVE_TYPES.has(type)) {
                if (options == null || options === false) {
                    options = CACHED_PASSIVE_FALSE;
                } else if (options === true) {
                    options = CACHED_PASSIVE_TRUE;
                } else if (typeof options === 'object' && options.passive === undefined) {
                    options = Object.assign({}, options, { passive: true });
                }
            }
            return origAdd.call(this, type, listener, options);
        };
    }

    // ═══════════════════════════════════════════════
    // §2-b. [v6.2] 지능형 타이머 쓰로틀링
    //
    //   대상: setInterval의 짧은 주기(< 500ms)만
    //   조건: document.hidden === true일 때만 활성
    //   방법: 원본 setInterval을 래핑하여 hidden 시
    //         실제 실행 간격을 최소 1000ms로 보장
    //   비대상: setTimeout (일회성), 500ms+ 주기
    //
    //   구현: clearInterval 호환성을 위해
    //         원본 intervalId ↔ 래핑 intervalId 맵 관리
    // ═══════════════════════════════════════════════
    {
        const origSetInterval = window.setInterval;
        const origClearInterval = window.clearInterval;

        // 쓰로틀 대상 추적: wrappedId → { origCallback, origDelay, realId, lastRun }
        const throttledTimers = new Map();
        let isTabHidden = document.hidden;

        // hidden 상태 변경 시 모든 쓰로틀 타이머 재설정
        const reapplyThrottles = () => {
            isTabHidden = document.hidden;

            for (const [wrappedId, info] of throttledTimers) {
                origClearInterval.call(window, info.realId);

                if (isTabHidden) {
                    // 백그라운드: 최소 간격으로 변경
                    const throttledDelay = Math.max(
                        info.origDelay,
                        CONFIG.timerThrottleMinInterval
                    );
                    info.realId = origSetInterval.call(window, () => {
                        info.lastRun = performance.now();
                        try { info.origCallback(); } catch (_) {}
                    }, throttledDelay);
                } else {
                    // 포그라운드: 원래 간격 복원
                    info.realId = origSetInterval.call(
                        window, info.origCallback, info.origDelay
                    );
                }
            }
        };

        document.addEventListener('visibilitychange', reapplyThrottles);

        // setInterval 래핑
        window.setInterval = function (callback, delay, ...args) {
            // 함수가 아니면 원본 위임 (문자열 eval 등)
            if (typeof callback !== 'function') {
                return origSetInterval.call(window, callback, delay, ...args);
            }

            delay = Number(delay) || 0;

            // 쓰로틀 대상이 아닌 경우 원본 그대로
            if (delay >= CONFIG.timerThrottleThreshold) {
                return origSetInterval.call(window, callback, delay, ...args);
            }

            // args가 있으면 바인딩
            const boundCallback = args.length > 0
                ? () => callback(...args)
                : callback;

            // 현재 hidden이면 쓰로틀된 간격으로 시작
            const effectiveDelay = isTabHidden
                ? Math.max(delay, CONFIG.timerThrottleMinInterval)
                : delay;

            const realId = origSetInterval.call(window, () => {
                const info = throttledTimers.get(wrappedId);
                if (info) info.lastRun = performance.now();
                try { boundCallback(); } catch (_) {}
            }, effectiveDelay);

            // 래핑 ID 생성 (고유성 보장)
            const wrappedId = realId;

            throttledTimers.set(wrappedId, {
                origCallback: boundCallback,
                origDelay: delay,
                realId: realId,
                lastRun: 0,
            });

            statsThrottledTimers++;
            return wrappedId;
        };

        // clearInterval 래핑
        window.clearInterval = function (id) {
            if (throttledTimers.has(id)) {
                const info = throttledTimers.get(id);
                origClearInterval.call(window, info.realId);
                throttledTimers.delete(id);
            } else {
                origClearInterval.call(window, id);
            }
        };
    }

    // ═══════════════════════════════════════════════
    // §2-c. [v6.2] 비핵심 요청 지연 (fetch/XHR)
    //
    //   대상: 보수적 광고/분석 도메인 리스트
    //   조건: document.readyState !== 'complete'일 때만
    //   방법: 요청을 큐에 쌓고, load 이벤트 후 순차 실행
    //   비대상: 리스트에 없는 도메인, load 후 요청
    //
    //   주의: 완전한 광고 차단이 아님. 지연만 수행.
    // ═══════════════════════════════════════════════
    {
        // 매우 보수적인 비핵심 도메인 패턴
        // 서브도메인.메인도메인 패턴만 (정확히 광고/분석 전용)
        const NON_ESSENTIAL_PATTERNS = [
            'googletagmanager.com',
            'google-analytics.com',
            'googlesyndication.com',
            'doubleclick.net',
            'adservice.google.',
            'facebook.net/tr',
            'connect.facebook.net',
            'analytics.', // analytics.xxx.com
            'cdn.mxpnl.com',        // Mixpanel
            'cdn.segment.com',       // Segment
            'bat.bing.com',
            'ads.linkedin.com',
            'static.hotjar.com',
            'script.hotjar.com',
            'plausible.io/api',
            'cdn.amplitude.com',
        ];

        const isNonEssentialUrl = (url) => {
            try {
                const str = typeof url === 'string' ? url
                          : (url instanceof URL) ? url.href
                          : (url instanceof Request) ? url.url
                          : String(url);
                for (let i = 0; i < NON_ESSENTIAL_PATTERNS.length; i++) {
                    if (str.includes(NON_ESSENTIAL_PATTERNS[i])) return true;
                }
            } catch (_) {}
            return false;
        };

        let pageLoaded = document.readyState === 'complete';
        const deferredQueue = [];

        if (!pageLoaded) {
            window.addEventListener('load', () => {
                pageLoaded = true;
                // 지연된 요청 순차 실행
                while (deferredQueue.length > 0) {
                    const task = deferredQueue.shift();
                    try { task(); } catch (_) {}
                }
            }, { once: true });
        }

        // fetch 래핑
        if (CONFIG.deferRequestsUntilLoad) {
            const origFetch = window.fetch;

            window.fetch = function (input, init) {
                if (!pageLoaded && isNonEssentialUrl(input)) {
                    statsDeferredRequests++;
                    return new Promise((resolve, reject) => {
                        deferredQueue.push(() => {
                            origFetch.call(window, input, init)
                                .then(resolve)
                                .catch(reject);
                        });
                    });
                }
                return origFetch.call(window, input, init);
            };

            // XMLHttpRequest 래핑
            const origXHROpen = XMLHttpRequest.prototype.open;
            const origXHRSend = XMLHttpRequest.prototype.send;
            const xhrUrlMap = new WeakMap();

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                xhrUrlMap.set(this, url);
                return origXHROpen.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.send = function (body) {
                const url = xhrUrlMap.get(this);
                if (!pageLoaded && url && isNonEssentialUrl(url)) {
                    statsDeferredRequests++;
                    const xhr = this;
                    deferredQueue.push(() => {
                        origXHRSend.call(xhr, body);
                    });
                    return;
                }
                return origXHRSend.call(this, body);
            };
        }
    }

    // ═══════════════════════════════════════════════
    // §3. CSS
    // ═══════════════════════════════════════════════
    const baseCSS = `
        ${SELECTORS} {
            content-visibility: auto;
            contain-intrinsic-size: auto 500px;
            contain: layout paint style;
        }
        @media not (prefers-reduced-motion: reduce) {
            html { scroll-behavior: smooth !important; }
        }
        img {
            content-visibility: auto;
            decoding: async;
        }
    `;

    const lowPowerCSS = `
        *, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
        }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = baseCSS;

    const lowPowerStyleEl = document.createElement('style');
    lowPowerStyleEl.textContent = lowPowerCSS;
    lowPowerStyleEl.disabled = true;

    {
        const insertStyles = () => {
            const target = document.head || document.documentElement;
            target.append(styleEl, lowPowerStyleEl);
        };
        if (document.head) {
            insertStyles();
        } else {
            const headWatcher = new MutationObserver(() => {
                if (document.head) {
                    headWatcher.disconnect();
                    insertStyles();
                }
            });
            headWatcher.observe(document.documentElement, { childList: true });
        }
    }

    const forceFontDisplaySwap = () => {
        try {
            for (const sheet of document.styleSheets) {
                try {
                    const rules = sheet.cssRules || sheet.rules;
                    if (!rules) continue;
                    for (let i = 0; i < rules.length; i++) {
                        if (rules[i] instanceof CSSFontFaceRule) {
                            if (!rules[i].style.fontDisplay) {
                                rules[i].style.fontDisplay = 'swap';
                            }
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
    };

    // ═══════════════════════════════════════════════
    // §4. 셀렉터 매칭 최적화
    // ═══════════════════════════════════════════════
    const TAG_SELECTORS = new Set();
    const CLASS_SELECTORS = new Set();
    const COMPLEX_SELECTORS = [];

    for (const s of SELECTOR_LIST) {
        if (/^[a-z][\w-]*$/i.test(s)) {
            TAG_SELECTORS.add(s.toUpperCase());
        } else if (/^\.\w[\w-]*$/.test(s)) {
            CLASS_SELECTORS.add(s.slice(1));
        } else {
            COMPLEX_SELECTORS.push(s);
        }
    }

    const COMPLEX_JOINED = COMPLEX_SELECTORS.length > 0
        ? COMPLEX_SELECTORS.join(', ') : null;

    const matchesSelectors = (el) => {
        if (TAG_SELECTORS.has(el.tagName)) return true;
        const cl = el.classList;
        if (cl) {
            for (let i = 0, len = cl.length; i < len; i++) {
                if (CLASS_SELECTORS.has(cl[i])) return true;
            }
        }
        if (COMPLEX_JOINED && el.matches(COMPLEX_JOINED)) return true;
        return false;
    };

    // ═══════════════════════════════════════════════
    // §5. 스크롤 방향 추적 + 거리 기반 복원 큐
    // ═══════════════════════════════════════════════
    {
        let lastScrollY = window.scrollY;
        window.addEventListener('scroll', () => {
            const y = window.scrollY;
            scrollDirection = (y >= lastScrollY) ? 1 : -1;
            lastScrollY = y;
        }, { passive: true });
    }

    const restoreQueue = [];
    let restoreRafId = 0;
    const restoreQueueSet = new WeakSet();

    const enqueueRestore = (target, tag, boundingRect) => {
        if (restoreQueueSet.has(target)) return;
        restoreQueueSet.add(target);

        const viewportCenter = window.innerHeight / 2;
        const elCenter = boundingRect.top + boundingRect.height / 2;

        let distance = Math.abs(elCenter - viewportCenter);
        const isInScrollDirection =
            (scrollDirection > 0 && elCenter > viewportCenter) ||
            (scrollDirection < 0 && elCenter < viewportCenter);
        if (isInScrollDirection) distance *= 0.5;

        const item = { target, tag, distance };
        let inserted = false;
        for (let i = 0; i < restoreQueue.length; i++) {
            if (distance < restoreQueue[i].distance) {
                restoreQueue.splice(i, 0, item);
                inserted = true;
                break;
            }
        }
        if (!inserted) restoreQueue.push(item);

        if (!restoreRafId) restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    const drainRestoreQueue = () => {
        restoreRafId = 0;
        const batch = Math.min(restoreQueue.length, effectiveRestoreBatch);

        for (let i = 0; i < batch; i++) {
            const item = restoreQueue.shift();
            if (!item) break;
            restoreQueueSet.delete(item.target);
            executeRestore(item.target, item.tag);
        }

        if (restoreQueue.length > 0) {
            restoreRafId = requestAnimationFrame(drainRestoreQueue);
        }
    };

    // ═══════════════════════════════════════════════
    // §6. 미디어 최적화 + 통합 라이프사이클
    // ═══════════════════════════════════════════════
    const optimizedSet = new WeakSet();

    const optimizeMedia = (el) => {
        if (optimizedSet.has(el)) return;
        optimizedSet.add(el);

        const tag = el.tagName;
        if (tag === 'IMG') {
            if (!el.loading) el.loading = 'lazy';
            el.decoding = 'async';
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'VIDEO') {
            el.preload = 'metadata';
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'IFRAME') {
            if (!el.loading) el.loading = 'lazy';
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'CANVAS') {
            hardReclaimObserver.observe(el);
        }
    };

    const MEDIA_IDLE = 0;
    const MEDIA_DWELLING = 1;
    const MEDIA_ACTIVE = 2;
    const MEDIA_RECLAIMED = 3;
    const MEDIA_HARD_RECLAIMED = 4;

    const mediaState = new WeakMap();
    const mediaDwellTimers = new WeakMap();
    const mediaSaved = new WeakMap();
    const videoPausedByUs = new WeakSet();

    const executeRestore = (target, tag) => {
        const saved = mediaSaved.get(target);
        if (!saved) return;
        mediaSaved.delete(target);

        target.style.minWidth = '';
        target.style.minHeight = '';

        if (tag === 'IMG') {
            if (saved.src && !saved.src.startsWith('blob:')) target.src = saved.src;
            if (saved.srcset) target.srcset = saved.srcset;
        } else if (tag === 'VIDEO') {
            if (saved.src && !saved.src.startsWith('blob:')) {
                target.src = saved.src;
                target.load();
            }
            target.style.willChange = 'transform';
        } else if (tag === 'IFRAME') {
            if (saved.src) target.src = saved.src;
        }

        statsRestoreCount++;
    };

    const preserveSize = (target) => {
        const w = target.offsetWidth;
        const h = target.offsetHeight;
        if (w > 0 && h > 0) {
            target.style.minWidth = w + 'px';
            target.style.minHeight = h + 'px';
        }
    };

    const reclaimMedia = (target, tag) => {
        preserveSize(target);

        if (tag === 'IMG') {
            const saved = {};
            if (target.src && !target.src.startsWith('data:')) {
                saved.src = target.src;
                if (saved.src.startsWith('blob:')) {
                    try { URL.revokeObjectURL(saved.src); } catch (_) {}
                }
                target.removeAttribute('src');
            }
            if (target.srcset) {
                saved.srcset = target.srcset;
                target.removeAttribute('srcset');
            }
            if (saved.src || saved.srcset) mediaSaved.set(target, saved);
        } else if (tag === 'VIDEO') {
            if (target.src && !target.src.startsWith('data:')) {
                const saved = { src: target.src };
                if (saved.src.startsWith('blob:')) {
                    try { URL.revokeObjectURL(saved.src); } catch (_) {}
                }
                target.removeAttribute('src');
                target.load();
                mediaSaved.set(target, saved);
            }
            target.style.willChange = 'auto';
        } else if (tag === 'IFRAME') {
            if (target.src && target.src !== 'about:blank') {
                mediaSaved.set(target, { src: target.src });
                target.src = 'about:blank';
            }
        }

        statsReclaimCount++;
    };

    const mediaLifecycleObserver = new IntersectionObserver((entries) => {
        const seen = new Set();

        for (let i = entries.length - 1; i >= 0; i--) {
            const { target, isIntersecting, boundingClientRect } = entries[i];
            if (seen.has(target)) continue;
            seen.add(target);

            const tag = target.tagName;
            const state = mediaState.get(target) || MEDIA_IDLE;

            if (state === MEDIA_HARD_RECLAIMED) continue;

            if (isIntersecting) {
                if (state === MEDIA_RECLAIMED) {
                    enqueueRestore(target, tag, boundingClientRect);
                }

                if (tag === 'VIDEO' && videoPausedByUs.has(target)) {
                    videoPausedByUs.delete(target);
                    target.play().catch(() => {});
                }

                if (tag === 'VIDEO') {
                    target.style.willChange = 'transform';
                }

                if (state === MEDIA_IDLE || state === MEDIA_RECLAIMED) {
                    mediaState.set(target, MEDIA_DWELLING);
                    if (!mediaDwellTimers.has(target)) {
                        const id = setTimeout(() => {
                            mediaDwellTimers.delete(target);
                            mediaState.set(target, MEDIA_ACTIVE);
                        }, CONFIG.throttleDwell);
                        mediaDwellTimers.set(target, id);
                    }
                }
            } else {
                if (mediaDwellTimers.has(target)) {
                    clearTimeout(mediaDwellTimers.get(target));
                    mediaDwellTimers.delete(target);
                }

                if (tag === 'VIDEO' && target instanceof HTMLVideoElement && !target.paused) {
                    target.pause();
                    videoPausedByUs.add(target);
                }

                if (state === MEDIA_ACTIVE || state === MEDIA_DWELLING) {
                    mediaState.set(target, MEDIA_RECLAIMED);
                    reclaimMedia(target, tag);
                    restoreQueueSet.delete(target);
                } else {
                    mediaState.set(target, MEDIA_IDLE);
                }
            }
        }
    }, {
        rootMargin: `${CONFIG.mediaMarginTop}px 0px ${CONFIG.mediaMarginBottom}px 0px`,
        threshold: 0
    });

    // ═══════════════════════════════════════════════
    // §7. 하드 리클레임 Observer
    // ═══════════════════════════════════════════════
    const canvasSaved = new WeakMap();

    const hardReclaimObserver = new IntersectionObserver((entries) => {
        const seen = new Set();
        for (let i = entries.length - 1; i >= 0; i--) {
            const { target, isIntersecting } = entries[i];
            if (seen.has(target)) continue;
            seen.add(target);

            const tag = target.tagName;
            if (!isIntersecting) {
                if (tag === 'CANVAS') {
                    if (!canvasSaved.has(target) && (target.width > 0 || target.height > 0)) {
                        canvasSaved.set(target, { width: target.width, height: target.height });
                        target.width = 0;
                        target.height = 0;
                    }
                } else if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') {
                    const state = mediaState.get(target) || MEDIA_IDLE;
                    if (state !== MEDIA_RECLAIMED && state !== MEDIA_HARD_RECLAIMED) {
                        reclaimMedia(target, tag);
                    }
                    mediaState.set(target, MEDIA_HARD_RECLAIMED);
                }
            } else {
                if (tag === 'CANVAS' && canvasSaved.has(target)) {
                    const saved = canvasSaved.get(target);
                    canvasSaved.delete(target);
                    target.width = saved.width;
                    target.height = saved.height;
                } else if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME') {
                    mediaState.set(target, MEDIA_RECLAIMED);
                }
            }
        }
    }, {
        rootMargin: `${CONFIG.hardReclaimMarginTop}px 0px ${CONFIG.hardReclaimMarginBottom}px 0px`,
        threshold: 0
    });

    // ═══════════════════════════════════════════════
    // §8. ResizeObserver 높이 캐싱
    // ═══════════════════════════════════════════════
    const heightCache = new WeakMap();

    const resizeObserver = new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const h = entry.borderBoxSize?.[0]?.blockSize
                    ?? entry.contentRect.height;
            if (h > 0) heightCache.set(entry.target, h);
        }
    });

    // ═══════════════════════════════════════════════
    // §9. 스마트 GC — IO + WeakRef
    // ═══════════════════════════════════════════════
    const gcHiddenMap = new WeakSet();
    const gcHiddenHeight = new WeakMap();
    let allTrackedRefs = [];
    const trackedNodeSet = new WeakSet();
    let gcObserveWatermark = 0;

    let deadRefCount = 0;
    const COMPACT_THRESHOLD = 50;

    const finalizer = new FinalizationRegistry(() => {
        deadRefCount++;
        if (deadRefCount >= COMPACT_THRESHOLD) {
            deadRefCount = 0;
            compactTrackedRefs();
        }
    });

    const HIDDEN_STYLE = (h) =>
        `content-visibility:hidden;contain-intrinsic-size:auto ${h}px;overflow:hidden`;
    const VISIBLE_STYLE = 'content-visibility:auto;contain-intrinsic-size:;overflow:';

    const gcObserver = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const { target, isIntersecting } = entries[i];
            if (!isIntersecting && !gcHiddenMap.has(target)) {
                const h = heightCache.get(target) || 500;
                gcHiddenMap.add(target);
                gcHiddenHeight.set(target, h);
                target.style.cssText = HIDDEN_STYLE(h);
            } else if (isIntersecting && gcHiddenMap.has(target)) {
                gcHiddenMap.delete(target);
                gcHiddenHeight.delete(target);
                target.style.cssText = VISIBLE_STYLE;
            }
        }
    }, {
        rootMargin: `${CONFIG.gcMarginTop}px 0px ${CONFIG.gcMarginBottom}px 0px`,
        threshold: 0
    });

    const gcFeed = () => {
        const len = allTrackedRefs.length;
        if (len <= effectiveLimitNodes) return;
        const cutoff = len - effectiveLimitNodes;
        const start = Math.max(gcObserveWatermark, 0);
        for (let i = start; i < cutoff; i++) {
            const el = allTrackedRefs[i]?.deref();
            if (el) gcObserver.observe(el);
        }
        if (cutoff > gcObserveWatermark) gcObserveWatermark = cutoff;
    };

    const trackNode = (el) => {
        if (trackedNodeSet.has(el)) return;
        trackedNodeSet.add(el);
        const ref = new WeakRef(el);
        allTrackedRefs.push(ref);
        finalizer.register(el, ref);
        resizeObserver.observe(el);

        const canvases = el.querySelectorAll(CANVAS_SELECTOR);
        for (let i = 0; i < canvases.length; i++) optimizeMedia(canvases[i]);
    };

    const untrackNode = (el) => {
        if (!trackedNodeSet.has(el)) return;
        resizeObserver.unobserve(el);
        gcObserver.unobserve(el);
        mediaLifecycleObserver.unobserve(el);
        hardReclaimObserver.unobserve(el);
        if (gcHiddenMap.has(el)) {
            gcHiddenMap.delete(el);
            gcHiddenHeight.delete(el);
        }
        finalizer.unregister(el);
    };

    const compactTrackedRefs = () => {
        const newArr = [];
        for (let i = 0; i < allTrackedRefs.length; i++) {
            if (allTrackedRefs[i].deref() !== undefined) newArr.push(allTrackedRefs[i]);
        }
        allTrackedRefs = newArr;
        gcObserveWatermark = Math.min(gcObserveWatermark, newArr.length);
    };

    // ═══════════════════════════════════════════════
    // §10. 저사양 모드
    // ═══════════════════════════════════════════════
    const enterLowPowerMode = () => {
        if (isLowPowerMode) return;
        isLowPowerMode = true;
        effectiveLimitNodes = CONFIG.lowPowerLimitNodes;
        lowPowerStyleEl.disabled = false;
        gcObserveWatermark = 0;
        gcFeed();
    };

    const exitLowPowerMode = () => {
        if (!isLowPowerMode) return;
        isLowPowerMode = false;
        effectiveLimitNodes = CONFIG.limitNodes;
        lowPowerStyleEl.disabled = true;
    };

    let startFrameMonitor;
    let currentSmoothedFPS = 60;

    {
        const hasLoAF = typeof PerformanceObserver !== 'undefined'
            && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');

        if (hasLoAF) {
            const recentLoAFs = [];

            const loafObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    recentLoAFs.push(entry.duration);
                    if (recentLoAFs.length > CONFIG.loafJankWindowSize) {
                        recentLoAFs.shift();
                    }
                }

                if (recentLoAFs.length >= CONFIG.loafJankWindowSize) {
                    let jankCount = 0;
                    for (let i = 0; i < recentLoAFs.length; i++) {
                        if (recentLoAFs[i] > CONFIG.loafJankThresholdMs) jankCount++;
                    }
                    if (jankCount >= Math.ceil(CONFIG.loafJankWindowSize / 2)
                        && !isLowPowerMode) {
                        enterLowPowerMode();
                    }
                }
            });

            try {
                loafObserver.observe({ type: 'long-animation-frame', buffered: false });
            } catch (_) {}
        }

        let lastFrameTime = 0;
        let smoothFPS = 60;
        let lowDuration = 0;
        let highDuration = 0;
        let monitorActive = true;
        let batteryLow = false;

        const LOW_ENTER_MS = 500;
        const LOW_EXIT_MS = 2000;

        const frameMonitor = (now) => {
            if (!monitorActive) return;

            if (lastFrameTime > 0) {
                const delta = now - lastFrameTime;
                const instantFPS = 1000 / delta;
                smoothFPS += CONFIG.fpsAlpha * (instantFPS - smoothFPS);
                currentSmoothedFPS = smoothFPS;

                if (smoothFPS < CONFIG.lowPowerFrameThreshold) {
                    lowDuration += delta;
                    highDuration = 0;
                    if (lowDuration > LOW_ENTER_MS && !isLowPowerMode) enterLowPowerMode();
                } else {
                    highDuration += delta;
                    lowDuration = 0;
                    if (highDuration > LOW_EXIT_MS && isLowPowerMode && !batteryLow) {
                        exitLowPowerMode();
                    }
                }
            }

            lastFrameTime = now;
            requestAnimationFrame(frameMonitor);
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                monitorActive = false;
            } else {
                monitorActive = true;
                lastFrameTime = 0;
                smoothFPS = 60;
                lowDuration = 0;
                highDuration = 0;
                requestAnimationFrame(frameMonitor);
            }
        });

        if (navigator.getBattery) {
            navigator.getBattery().then((battery) => {
                const checkBattery = () => {
                    batteryLow = !battery.charging
                              && battery.level <= CONFIG.lowPowerBatteryThreshold;
                    if (batteryLow) enterLowPowerMode();
                };
                battery.addEventListener('chargingchange', checkBattery);
                battery.addEventListener('levelchange', checkBattery);
                checkBattery();
            }).catch(() => {});
        }

        try {
            const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
            motionQuery.addEventListener('change', (e) => {
                if (e.matches) enterLowPowerMode();
            });
            if (motionQuery.matches) enterLowPowerMode();
        } catch (_) {}

        startFrameMonitor = () => requestAnimationFrame(frameMonitor);
    }

    {
        const conn = navigator.connection;
        if (conn) {
            const updateNetworkAdaptation = () => {
                const etype = conn.effectiveType;
                const saveData = conn.saveData === true;

                if (saveData || etype === 'slow-2g' || etype === '2g') {
                    effectiveRestoreBatch = CONFIG.slowNetBatchSize;
                    if (saveData) enterLowPowerMode();
                } else if (etype === '3g') {
                    effectiveRestoreBatch = Math.max(1,
                        Math.floor(CONFIG.restoreBatchSize / 2));
                } else {
                    effectiveRestoreBatch = CONFIG.restoreBatchSize;
                }
            };
            conn.addEventListener('change', updateNetworkAdaptation);
            updateNetworkAdaptation();
        }
    }

    // ═══════════════════════════════════════════════
    // §11. Blob URL 자동 추적 & 만료
    // ═══════════════════════════════════════════════
    {
        const origCreate = URL.createObjectURL;
        const origRevoke = URL.revokeObjectURL;
        const pendingBlobs = new Map();

        URL.createObjectURL = function (blob) {
            const url = origCreate.call(this, blob);
            const timerId = setTimeout(() => {
                pendingBlobs.delete(url);
                try { origRevoke.call(URL, url); } catch (_) {}
            }, CONFIG.blobAutoExpireMs);
            pendingBlobs.set(url, timerId);
            return url;
        };

        URL.revokeObjectURL = function (url) {
            if (pendingBlobs.has(url)) {
                clearTimeout(pendingBlobs.get(url));
                pendingBlobs.delete(url);
            }
            return origRevoke.call(this, url);
        };
    }

    // ═══════════════════════════════════════════════
    // §12. 탭 Hibernation
    // ═══════════════════════════════════════════════
    {
        let hibernateTimer = 0;
        let isHibernated = false;

        const hibernateTab = () => {
            if (isHibernated) return;
            isHibernated = true;
            statsHibernateCount++;

            for (let i = 0; i < allTrackedRefs.length; i++) {
                const el = allTrackedRefs[i]?.deref();
                if (!el) continue;

                const mediaEls = el.querySelectorAll(MEDIA_SELECTOR);
                for (let j = 0; j < mediaEls.length; j++) {
                    const m = mediaEls[j];
                    const tag = m.tagName;
                    const state = mediaState.get(m) || MEDIA_IDLE;
                    if (state !== MEDIA_HARD_RECLAIMED) {
                        if (state !== MEDIA_RECLAIMED) reclaimMedia(m, tag);
                        mediaState.set(m, MEDIA_HARD_RECLAIMED);
                    }
                }

                const canvasEls = el.querySelectorAll(CANVAS_SELECTOR);
                for (let j = 0; j < canvasEls.length; j++) {
                    const c = canvasEls[j];
                    if (!canvasSaved.has(c) && (c.width > 0 || c.height > 0)) {
                        canvasSaved.set(c, { width: c.width, height: c.height });
                        c.width = 0;
                        c.height = 0;
                    }
                }
            }
        };

        const wakeTab = () => {
            if (!isHibernated) return;
            isHibernated = false;

            for (let i = 0; i < allTrackedRefs.length; i++) {
                const el = allTrackedRefs[i]?.deref();
                if (!el) continue;
                const mediaEls = el.querySelectorAll(MEDIA_SELECTOR);
                for (let j = 0; j < mediaEls.length; j++) {
                    if (mediaState.get(mediaEls[j]) === MEDIA_HARD_RECLAIMED) {
                        mediaState.set(mediaEls[j], MEDIA_RECLAIMED);
                    }
                }
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                hibernateTimer = setTimeout(hibernateTab, CONFIG.hibernateDelayMs);
            } else {
                clearTimeout(hibernateTimer);
                hibernateTimer = 0;
                wakeTab();
            }
        });
    }

    // ═══════════════════════════════════════════════
    // §13. Shadow DOM 재귀 탐색
    // ═══════════════════════════════════════════════
    const observedShadowRoots = new WeakSet();

    const processShadowRoot = (shadowRoot) => {
        if (observedShadowRoots.has(shadowRoot)) return;
        observedShadowRoots.add(shadowRoot);

        processSubtree(shadowRoot);

        const shadowMut = new MutationObserver((mutations) => {
            let hasAdded = false;
            for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                const added = mut.addedNodes;
                for (let j = 0; j < added.length; j++) {
                    const node = added[j];
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        pendingSet.add(node);
                        hasAdded = true;
                    }
                }
                const removed = mut.removedNodes;
                for (let j = 0; j < removed.length; j++) {
                    const node = removed[j];
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        pendingSet.delete(node);
                        cleanupSubtree(node);
                    }
                }
            }
            if (hasAdded) scheduleBatch();
        });

        shadowMut.observe(shadowRoot, { childList: true, subtree: true });
    };

    const checkShadowRoot = (el) => {
        try {
            if (el.shadowRoot && el.shadowRoot.mode === 'open') {
                processShadowRoot(el.shadowRoot);
            }
        } catch (_) {}
    };

    // ═══════════════════════════════════════════════
    // §14. MutationObserver
    // ═══════════════════════════════════════════════
    let batchScheduled = false;
    const pendingSet = new Set();

    const processSubtree = (root) => {
        try {
            if (!root) return;

            if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                const mediaEls = root.querySelectorAll(ALL_RESOURCE_SELECTOR);
                for (let i = 0; i < mediaEls.length; i++) optimizeMedia(mediaEls[i]);
                const contentEls = root.querySelectorAll(SELECTORS);
                for (let i = 0; i < contentEls.length; i++) trackNode(contentEls[i]);
                const allEls = root.querySelectorAll('*');
                for (let i = 0; i < allEls.length; i++) checkShadowRoot(allEls[i]);
                return;
            }

            if (root.nodeType !== Node.ELEMENT_NODE) return;

            const rootTag = root.tagName;
            if (rootTag === 'IMG' || rootTag === 'VIDEO'
                || rootTag === 'IFRAME' || rootTag === 'CANVAS')
                optimizeMedia(root);
            if (matchesSelectors(root)) trackNode(root);

            checkShadowRoot(root);

            const mediaEls = root.querySelectorAll(ALL_RESOURCE_SELECTOR);
            for (let i = 0; i < mediaEls.length; i++) optimizeMedia(mediaEls[i]);

            const contentEls = root.querySelectorAll(SELECTORS);
            for (let i = 0; i < contentEls.length; i++) trackNode(contentEls[i]);

            const allEls = root.querySelectorAll('*');
            for (let i = 0; i < allEls.length; i++) checkShadowRoot(allEls[i]);
        } catch (_) {}
    };

    const cleanupSubtree = (root) => {
        try {
            if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
            if (trackedNodeSet.has(root)) untrackNode(root);

            const els = root.querySelectorAll(SELECTORS);

            if (els.length <= CONFIG.bulkCleanupThreshold) {
                for (let i = 0; i < els.length; i++) {
                    if (trackedNodeSet.has(els[i])) untrackNode(els[i]);
                }
            } else {
                const arr = Array.from(els);
                let idx = 0;
                const chunkSize = CONFIG.bulkCleanupThreshold;
                const processChunk = () => {
                    const end = Math.min(idx + chunkSize, arr.length);
                    for (; idx < end; idx++) {
                        if (trackedNodeSet.has(arr[idx])) untrackNode(arr[idx]);
                    }
                    if (idx < arr.length) queueMicrotask(processChunk);
                };
                processChunk();
            }
        } catch (_) {}
    };

    const flushBatch = () => {
        batchScheduled = false;
        for (const node of pendingSet) {
            if (node.nodeType === Node.ELEMENT_NODE) processSubtree(node);
        }
        pendingSet.clear();
        gcFeed();
    };

    const scheduleBatch = () => {
        if (!batchScheduled) {
            batchScheduled = true;
            queueMicrotask(flushBatch);
        }
    };

    const mutObserver = new MutationObserver((mutations) => {
        let hasAdded = false;
        for (let i = 0; i < mutations.length; i++) {
            const mut = mutations[i];
            const added = mut.addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (node.nodeType === Node.ELEMENT_NODE) {
                    pendingSet.add(node);
                    hasAdded = true;
                }
            }
            const removed = mut.removedNodes;
            for (let j = 0; j < removed.length; j++) {
                const node = removed[j];
                if (node.nodeType === Node.ELEMENT_NODE) {
                    pendingSet.delete(node);
                    cleanupSubtree(node);
                }
            }
        }
        if (hasAdded) scheduleBatch();
    });

    // ═══════════════════════════════════════════════
    // §15. 메모리 압박 감지
    // ═══════════════════════════════════════════════
    {
        const hasMemoryAPI = typeof performance.measureUserAgentSpecificMemory === 'function';

        if (hasMemoryAPI && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
            const checkMemory = async () => {
                try {
                    const result = await performance.measureUserAgentSpecificMemory();
                    if (result.bytes > CONFIG.memoryThresholdBytes) {
                        if (!memoryPressure) {
                            memoryPressure = true;
                            effectiveLimitNodes = Math.min(
                                effectiveLimitNodes, CONFIG.lowPowerLimitNodes);
                            gcObserveWatermark = 0;
                            gcFeed();
                        }
                    } else if (memoryPressure) {
                        memoryPressure = false;
                        effectiveLimitNodes = isLowPowerMode
                            ? CONFIG.lowPowerLimitNodes : CONFIG.limitNodes;
                    }
                } catch (_) {}
                setTimeout(checkMemory, CONFIG.memoryCheckInterval);
            };
            setTimeout(checkMemory, 10000);
        }
    }

    // ═══════════════════════════════════════════════
    // §16. 정기 GC — scheduler.postTask
    // ═══════════════════════════════════════════════
    const hasScheduler = typeof globalThis.scheduler?.postTask === 'function';

    const scheduleTask = hasScheduler
        ? (fn) => scheduler.postTask(fn, { priority: CONFIG.gcTaskPriority }).catch(() => {})
        : (typeof requestIdleCallback === 'function')
            ? (fn) => requestIdleCallback((dl) => {
                  if (dl.timeRemaining() > 5 || dl.didTimeout) fn();
              }, { timeout: CONFIG.idleTimeout })
            : (fn) => setTimeout(fn, CONFIG.idleTimeout);

    let gcChainActive = false;

    const scheduleGC = () => {
        if (gcChainActive) return;
        gcChainActive = true;
        const tick = () => {
            if (document.hidden) { gcChainActive = false; return; }
            scheduleTask(() => { gcFeed(); tick(); });
        };
        tick();
    };

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) scheduleGC();
    });

    // ═══════════════════════════════════════════════
    // §17. 진단 인터페이스
    // ═══════════════════════════════════════════════
    try {
        Object.defineProperty(window, '__turboOptimizer__', {
            configurable: false,
            enumerable: false,
            value: Object.freeze({
                stats() {
                    let aliveRefs = 0;
                    let deadRefs = 0;
                    for (let i = 0; i < allTrackedRefs.length; i++) {
                        if (allTrackedRefs[i].deref() !== undefined) aliveRefs++;
                        else deadRefs++;
                    }

                    let hiddenCount = 0;
                    for (let i = 0; i < allTrackedRefs.length; i++) {
                        const el = allTrackedRefs[i].deref();
                        if (el && gcHiddenMap.has(el)) hiddenCount++;
                    }

                    const info = {
                        version: '6.2',
                        lowPowerMode: isLowPowerMode,
                        memoryPressure: memoryPressure,
                        smoothedFPS: Math.round(currentSmoothedFPS * 10) / 10,
                        effectiveLimitNodes: effectiveLimitNodes,
                        effectiveRestoreBatch: effectiveRestoreBatch,
                        trackedNodes: { alive: aliveRefs, dead: deadRefs, total: allTrackedRefs.length },
                        gcHiddenNodes: hiddenCount,
                        restoreQueueLength: restoreQueue.length,
                        mediaActions: { reclaimed: statsReclaimCount, restored: statsRestoreCount },
                        hibernations: statsHibernateCount,
                        deferredRequests: statsDeferredRequests,
                        throttledTimers: statsThrottledTimers,
                        network: navigator.connection ? {
                            effectiveType: navigator.connection.effectiveType,
                            saveData: navigator.connection.saveData,
                        } : 'unavailable',
                    };

                    console.table(info);
                    console.table(info.trackedNodes);
                    console.table(info.mediaActions);
                    return info;
                },
                compact() {
                    const before = allTrackedRefs.length;
                    compactTrackedRefs();
                    const after = allTrackedRefs.length;
                    return `Compacted: ${before} → ${after} (${before - after} removed)`;
                },
                gc() { gcFeed(); return 'GC feed executed'; },
                config: CONFIG,
            })
        });
    } catch (_) {}

    // ═══════════════════════════════════════════════
    // §18. 초기화
    // ═══════════════════════════════════════════════
    const init = () => {
        try {
            mutObserver.observe(document.body, { childList: true, subtree: true });
            processSubtree(document.body);
            gcFeed();
            scheduleGC();
            startFrameMonitor();

            forceFontDisplaySwap();
            new MutationObserver(() => forceFontDisplaySwap())
                .observe(document.head || document.documentElement, {
                    childList: true, subtree: true
                });
        } catch (_) {}
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
