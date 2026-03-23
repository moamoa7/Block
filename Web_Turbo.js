// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  // @description 모든 웹사이트에서 렉을 제거합니다. LoAF 렉 감지, 바이너리 힙 기반 복원 큐, 지능형 타이머 쓰로틀링 및 scheduler.yield를 이용한 비차단식 자원 관리를 통해 최상의 부드러움을 제공합니다.
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
        timerThrottleMinInterval:  1000,
        timerThrottleThreshold:    500,
        deferRequestsUntilLoad:    true,
        // [v7.0] 새 설정
        heapInitialCapacity:       64,
        yieldInterval:             4,        // yield 호출 주기 (매 N개 처리마다)
        frameDeltaMaxMs:           500,      // 이 이상의 프레임 간격은 무시
    };

    let isLowPowerMode = false;
    let effectiveLimitNodes = CONFIG.limitNodes;
    let memoryPressure = false;
    let scrollDirection = 1;
    let effectiveRestoreBatch = CONFIG.restoreBatchSize;

    let statsReclaimCount = 0;
    let statsRestoreCount = 0;
    let statsHibernateCount = 0;
    let statsDeferredRequests = 0;
    let statsThrottledTimers = 0;

    // [v7.0] scheduler.yield 지원 감지
    const hasSchedulerYield = typeof globalThis.scheduler?.yield === 'function';
    const yieldToMain = hasSchedulerYield
        ? () => scheduler.yield()
        : () => new Promise(r => setTimeout(r, 0));

    // ═══════════════════════════════════════════════
    // §2. 패시브 이벤트 리스너 강제화
    // ═══════════════════════════════════════════════
    {
        const origAdd = EventTarget.prototype.addEventListener;
        const PASSIVE_TYPES = new Set([
            'touchstart', 'touchmove', 'wheel', 'mousewheel', 'scroll'
        ]);
        const P_FALSE = Object.freeze({ passive: true, capture: false });
        const P_TRUE  = Object.freeze({ passive: true, capture: true });

        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (PASSIVE_TYPES.has(type)) {
                if (options == null || options === false) options = P_FALSE;
                else if (options === true) options = P_TRUE;
                else if (typeof options === 'object' && options.passive === undefined)
                    options = Object.assign({}, options, { passive: true });
            }
            return origAdd.call(this, type, listener, options);
        };
    }

    // ═══════════════════════════════════════════════
    // §2-b. 지능형 타이머 쓰로틀링 (v7.0: ID 충돌 수정)
    // ═══════════════════════════════════════════════
    {
        const origSetInterval = window.setInterval;
        const origClearInterval = window.clearInterval;
        const throttledTimers = new Map();
        let isTabHidden = document.hidden;
        let nextWrappedId = 0x7FFFFFFF; // 높은 값에서 시작하여 브라우저 ID와 충돌 방지

        const reapplyThrottles = () => {
            isTabHidden = document.hidden;
            for (const [wid, info] of throttledTimers) {
                origClearInterval.call(window, info.realId);
                const delay = isTabHidden
                    ? Math.max(info.origDelay, CONFIG.timerThrottleMinInterval)
                    : info.origDelay;
                info.realId = origSetInterval.call(window, info.origCallback, delay);
            }
        };

        document.addEventListener('visibilitychange', reapplyThrottles);

        window.setInterval = function (callback, delay, ...args) {
            if (typeof callback !== 'function')
                return origSetInterval.call(window, callback, delay, ...args);

            delay = Number(delay) || 0;
            if (delay >= CONFIG.timerThrottleThreshold)
                return origSetInterval.call(window, callback, delay, ...args);

            const bound = args.length > 0 ? () => callback(...args) : callback;
            const effectiveDelay = isTabHidden
                ? Math.max(delay, CONFIG.timerThrottleMinInterval) : delay;

            const realId = origSetInterval.call(window, bound, effectiveDelay);
            const wid = --nextWrappedId; // 고유 래핑 ID (음수 방향으로 감소)

            throttledTimers.set(wid, {
                origCallback: bound,
                origDelay: delay,
                realId,
                lastRun: 0,
            });

            statsThrottledTimers++;
            return wid;
        };

        window.clearInterval = function (id) {
            if (throttledTimers.has(id)) {
                origClearInterval.call(window, throttledTimers.get(id).realId);
                throttledTimers.delete(id);
            } else {
                origClearInterval.call(window, id);
            }
        };
    }

    // ═══════════════════════════════════════════════
    // §2-c. 비핵심 요청 지연 (fetch/XHR)
    // ═══════════════════════════════════════════════
    {
        const NON_ESSENTIAL_PATTERNS = [
            'googletagmanager.com', 'google-analytics.com',
            'googlesyndication.com', 'doubleclick.net', 'adservice.google.',
            'facebook.net/tr', 'connect.facebook.net', 'analytics.',
            'cdn.mxpnl.com', 'cdn.segment.com', 'bat.bing.com',
            'ads.linkedin.com', 'static.hotjar.com', 'script.hotjar.com',
            'plausible.io/api', 'cdn.amplitude.com',
        ];

        const isNonEssentialUrl = (url) => {
            try {
                const str = typeof url === 'string' ? url
                    : (url instanceof URL) ? url.href
                    : (url instanceof Request) ? url.url
                    : String(url);
                for (let i = 0; i < NON_ESSENTIAL_PATTERNS.length; i++)
                    if (str.includes(NON_ESSENTIAL_PATTERNS[i])) return true;
            } catch (_) {}
            return false;
        };

        let pageLoaded = document.readyState === 'complete';
        const deferredQueue = [];

        if (!pageLoaded) {
            window.addEventListener('load', () => {
                pageLoaded = true;
                while (deferredQueue.length > 0) {
                    try { deferredQueue.shift()(); } catch (_) {}
                }
            }, { once: true });
        }

        if (CONFIG.deferRequestsUntilLoad) {
            const origFetch = window.fetch;
            window.fetch = function (input, init) {
                if (!pageLoaded && isNonEssentialUrl(input)) {
                    statsDeferredRequests++;
                    return new Promise((resolve, reject) => {
                        deferredQueue.push(() =>
                            origFetch.call(window, input, init).then(resolve, reject));
                    });
                }
                return origFetch.call(window, input, init);
            };

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
                    deferredQueue.push(() => origXHRSend.call(xhr, body));
                    return;
                }
                return origXHRSend.call(this, body);
            };
        }
    }

    // ═══════════════════════════════════════════════
    // §3. CSS (v7.0: contain: strict)
    // ═══════════════════════════════════════════════
    const baseCSS = `
        ${SELECTORS} {
            content-visibility: auto;
            contain-intrinsic-size: auto 500px;
            contain: strict;
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
            (document.head || document.documentElement).append(styleEl, lowPowerStyleEl);
        };
        if (document.head) insertStyles();
        else {
            const hw = new MutationObserver(() => {
                if (document.head) { hw.disconnect(); insertStyles(); }
            });
            hw.observe(document.documentElement, { childList: true });
        }
    }

    // [v7.0] document.fonts API 사용
    const forceFontDisplaySwap = () => {
        try {
            if (document.fonts) {
                for (const face of document.fonts) {
                    if (face.display === 'block' || face.display === 'auto')
                        face.display = 'swap';
                }
                return;
            }
            // Fallback: 기존 방식
            for (const sheet of document.styleSheets) {
                try {
                    const rules = sheet.cssRules || sheet.rules;
                    if (!rules) continue;
                    for (let i = 0; i < rules.length; i++) {
                        if (rules[i] instanceof CSSFontFaceRule && !rules[i].style.fontDisplay)
                            rules[i].style.fontDisplay = 'swap';
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
        if (/^[a-z][\w-]*$/i.test(s)) TAG_SELECTORS.add(s.toUpperCase());
        else if (/^\.\w[\w-]*$/.test(s)) CLASS_SELECTORS.add(s.slice(1));
        else COMPLEX_SELECTORS.push(s);
    }
    const COMPLEX_JOINED = COMPLEX_SELECTORS.length > 0
        ? COMPLEX_SELECTORS.join(', ') : null;

    const matchesSelectors = (el) => {
        if (TAG_SELECTORS.has(el.tagName)) return true;
        const cl = el.classList;
        if (cl) for (let i = 0, len = cl.length; i < len; i++)
            if (CLASS_SELECTORS.has(cl[i])) return true;
        if (COMPLEX_JOINED && el.matches(COMPLEX_JOINED)) return true;
        return false;
    };

    // ═══════════════════════════════════════════════
    // §5. 스크롤 방향 추적 + MinHeap 복원 큐 (v7.0)
    // ═══════════════════════════════════════════════
    {
        let lastScrollY = window.scrollY;
        window.addEventListener('scroll', () => {
            const y = window.scrollY;
            scrollDirection = (y >= lastScrollY) ? 1 : -1;
            lastScrollY = y;
        }, { passive: true });
    }

    // [v7.0] 바이너리 MinHeap — O(log n) 삽입/추출
    class MinHeap {
        constructor() { this._d = []; }
        get length() { return this._d.length; }

        push(item) {
            this._d.push(item);
            this._up(this._d.length - 1);
        }

        pop() {
            const d = this._d;
            if (d.length === 0) return undefined;
            const top = d[0];
            const last = d.pop();
            if (d.length > 0) { d[0] = last; this._down(0); }
            return top;
        }

        _up(i) {
            const d = this._d;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (d[i].distance >= d[p].distance) break;
                const tmp = d[i]; d[i] = d[p]; d[p] = tmp;
                i = p;
            }
        }

        _down(i) {
            const d = this._d;
            const n = d.length;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < n && d[l].distance < d[smallest].distance) smallest = l;
                if (r < n && d[r].distance < d[smallest].distance) smallest = r;
                if (smallest === i) break;
                const tmp = d[i]; d[i] = d[smallest]; d[smallest] = tmp;
                i = smallest;
            }
        }

        clear() { this._d.length = 0; }
    }

    const restoreHeap = new MinHeap();
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

        restoreHeap.push({ target, tag, distance });
        if (!restoreRafId) restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    const drainRestoreQueue = () => {
        restoreRafId = 0;
        const batch = Math.min(restoreHeap.length, effectiveRestoreBatch);
        for (let i = 0; i < batch; i++) {
            const item = restoreHeap.pop();
            if (!item) break;
            restoreQueueSet.delete(item.target);
            executeRestore(item.target, item.tag);
        }
        if (restoreHeap.length > 0)
            restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    // ═══════════════════════════════════════════════
    // §6. 미디어 최적화 + 통합 라이프사이클
    // ═══════════════════════════════════════════════
    const optimizedSet = new WeakSet();
    const MEDIA_IDLE = 0, MEDIA_DWELLING = 1, MEDIA_ACTIVE = 2,
          MEDIA_RECLAIMED = 3, MEDIA_HARD_RECLAIMED = 4;
    const mediaState = new WeakMap();
    const mediaDwellTimers = new WeakMap();
    const mediaSaved = new WeakMap();
    const videoPausedByUs = new WeakSet();

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
        const w = target.offsetWidth, h = target.offsetHeight;
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
                if (saved.src.startsWith('blob:'))
                    try { URL.revokeObjectURL(saved.src); } catch (_) {}
                target.removeAttribute('src');
            }
            if (target.srcset) { saved.srcset = target.srcset; target.removeAttribute('srcset'); }
            if (saved.src || saved.srcset) mediaSaved.set(target, saved);
        } else if (tag === 'VIDEO') {
            if (target.src && !target.src.startsWith('data:')) {
                const saved = { src: target.src };
                if (saved.src.startsWith('blob:'))
                    try { URL.revokeObjectURL(saved.src); } catch (_) {}
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
                if (state === MEDIA_RECLAIMED)
                    enqueueRestore(target, tag, boundingClientRect);
                if (tag === 'VIDEO' && videoPausedByUs.has(target)) {
                    videoPausedByUs.delete(target);
                    target.play().catch(() => {});
                }
                if (tag === 'VIDEO') target.style.willChange = 'transform';
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
                    if (state !== MEDIA_RECLAIMED && state !== MEDIA_HARD_RECLAIMED)
                        reclaimMedia(target, tag);
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
    // §9. 스마트 GC — IO + WeakRef (v7.0: in-place compact)
    // ═══════════════════════════════════════════════
    const gcHiddenMap = new WeakSet();
    const gcHiddenHeight = new WeakMap();
    let allTrackedRefs = [];
    const trackedNodeSet = new WeakSet();
    let gcObserveWatermark = 0;

    let deadRefCount = 0;
    const COMPACT_THRESHOLD = 50;

    const finalizer = new FinalizationRegistry(() => {
        if (++deadRefCount >= COMPACT_THRESHOLD) {
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
        trackedNodeSet.delete(el);
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

    // [v7.0] in-place compaction — 배열 재할당 없음
    const compactTrackedRefs = () => {
        let write = 0;
        for (let read = 0; read < allTrackedRefs.length; read++) {
            if (allTrackedRefs[read].deref() !== undefined)
                allTrackedRefs[write++] = allTrackedRefs[read];
        }
        allTrackedRefs.length = write;
        gcObserveWatermark = Math.min(gcObserveWatermark, write);
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
                    if (recentLoAFs.length > CONFIG.loafJankWindowSize) recentLoAFs.shift();
                }
                if (recentLoAFs.length >= CONFIG.loafJankWindowSize) {
                    let jankCount = 0;
                    for (let i = 0; i < recentLoAFs.length; i++)
                        if (recentLoAFs[i] > CONFIG.loafJankThresholdMs) jankCount++;
                    if (jankCount >= Math.ceil(CONFIG.loafJankWindowSize / 2) && !isLowPowerMode)
                        enterLowPowerMode();
                }
            });
            try { loafObserver.observe({ type: 'long-animation-frame', buffered: false }); }
            catch (_) {}
        }

        let lastFrameTime = 0, smoothFPS = 60;
        let lowDuration = 0, highDuration = 0;
        let monitorActive = true, batteryLow = false;
        const LOW_ENTER_MS = 500, LOW_EXIT_MS = 2000;

        const frameMonitor = (now) => {
            if (!monitorActive) return;
            if (lastFrameTime > 0) {
                const delta = now - lastFrameTime;
                // [v7.0] 비정상 프레임 간격 무시 (탭 복귀 스파이크 방지)
                if (delta > CONFIG.frameDeltaMaxMs) {
                    lastFrameTime = now;
                    requestAnimationFrame(frameMonitor);
                    return;
                }
                const instantFPS = 1000 / delta;
                smoothFPS += CONFIG.fpsAlpha * (instantFPS - smoothFPS);
                currentSmoothedFPS = smoothFPS;

                if (smoothFPS < CONFIG.lowPowerFrameThreshold) {
                    lowDuration += delta; highDuration = 0;
                    if (lowDuration > LOW_ENTER_MS && !isLowPowerMode) enterLowPowerMode();
                } else {
                    highDuration += delta; lowDuration = 0;
                    if (highDuration > LOW_EXIT_MS && isLowPowerMode && !batteryLow)
                        exitLowPowerMode();
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
                lowDuration = highDuration = 0;
                requestAnimationFrame(frameMonitor);
            }
        });

        if (navigator.getBattery) {
            navigator.getBattery().then((battery) => {
                const check = () => {
                    batteryLow = !battery.charging
                        && battery.level <= CONFIG.lowPowerBatteryThreshold;
                    if (batteryLow) enterLowPowerMode();
                };
                battery.addEventListener('chargingchange', check);
                battery.addEventListener('levelchange', check);
                check();
            }).catch(() => {});
        }

        try {
            const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
            mq.addEventListener('change', (e) => { if (e.matches) enterLowPowerMode(); });
            if (mq.matches) enterLowPowerMode();
        } catch (_) {}

        startFrameMonitor = () => requestAnimationFrame(frameMonitor);
    }

    {
        const conn = navigator.connection;
        if (conn) {
            const update = () => {
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
            conn.addEventListener('change', update);
            update();
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
        let hibernateTimer = 0, isHibernated = false;

        const hibernateTab = () => {
            if (isHibernated) return;
            isHibernated = true;
            statsHibernateCount++;
            for (let i = 0; i < allTrackedRefs.length; i++) {
                const el = allTrackedRefs[i]?.deref();
                if (!el) continue;
                const mediaEls = el.querySelectorAll(MEDIA_SELECTOR);
                for (let j = 0; j < mediaEls.length; j++) {
                    const m = mediaEls[j], tag = m.tagName;
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
                        c.width = 0; c.height = 0;
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
                for (let j = 0; j < mediaEls.length; j++)
                    if (mediaState.get(mediaEls[j]) === MEDIA_HARD_RECLAIMED)
                        mediaState.set(mediaEls[j], MEDIA_RECLAIMED);
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
    // §13. Shadow DOM 탐색 (v7.0: TreeWalker)
    // ═══════════════════════════════════════════════
    const observedShadowRoots = new WeakSet();

    const processShadowRoot = (shadowRoot) => {
        if (observedShadowRoots.has(shadowRoot)) return;
        observedShadowRoots.add(shadowRoot);
        processSubtree(shadowRoot);

        const shadowMut = new MutationObserver((mutations) => {
            let hasAdded = false;
            for (let i = 0; i < mutations.length; i++) {
                const added = mutations[i].addedNodes;
                for (let j = 0; j < added.length; j++) {
                    if (added[j].nodeType === 1) { pendingNodes.push(added[j]); pendingGuard.add(added[j]); hasAdded = true; }
                }
                const removed = mutations[i].removedNodes;
                for (let j = 0; j < removed.length; j++) {
                    if (removed[j].nodeType === 1) { pendingGuard.delete(removed[j]); cleanupSubtree(removed[j]); }
                }
            }
            if (hasAdded) scheduleBatch();
        });
        shadowMut.observe(shadowRoot, { childList: true, subtree: true });
    };

    const checkShadowRoot = (el) => {
        try {
            if (el.shadowRoot && el.shadowRoot.mode === 'open')
                processShadowRoot(el.shadowRoot);
        } catch (_) {}
    };

    // ═══════════════════════════════════════════════
    // §14. MutationObserver (v7.0: 배열 + WeakSet)
    // ═══════════════════════════════════════════════
    let batchScheduled = false;
    const pendingNodes = [];          // [v7.0] Set → Array (이터레이터 오버헤드 제거)
    const pendingGuard = new WeakSet(); // 중복 방지

    // [v7.0] TreeWalker 기반 processSubtree
    const processSubtree = (root) => {
        try {
            if (!root) return;
            const isFragment = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
            const isElement  = root.nodeType === Node.ELEMENT_NODE;
            if (!isFragment && !isElement) return;

            if (isElement) {
                const rootTag = root.tagName;
                if (rootTag === 'IMG' || rootTag === 'VIDEO'
                    || rootTag === 'IFRAME' || rootTag === 'CANVAS')
                    optimizeMedia(root);
                if (matchesSelectors(root)) trackNode(root);
                checkShadowRoot(root);
            }

            // [v7.0] 단일 TreeWalker로 미디어 + 콘텐츠 + Shadow DOM 모두 처리
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let cur;
            while ((cur = walker.nextNode())) {
                const tag = cur.tagName;
                // 미디어/캔버스 최적화
                if (tag === 'IMG' || tag === 'VIDEO' || tag === 'IFRAME' || tag === 'CANVAS')
                    optimizeMedia(cur);
                // 콘텐츠 노드 추적
                if (matchesSelectors(cur)) trackNode(cur);
                // Shadow DOM 탐색
                checkShadowRoot(cur);
            }
        } catch (_) {}
    };

    // [v7.0] scheduler.yield 기반 비동기 대량 cleanup
    const cleanupSubtree = (root) => {
        try {
            if (!root || root.nodeType !== 1) return;
            if (trackedNodeSet.has(root)) untrackNode(root);

            const els = root.querySelectorAll(SELECTORS);
            if (els.length <= CONFIG.bulkCleanupThreshold) {
                for (let i = 0; i < els.length; i++)
                    if (trackedNodeSet.has(els[i])) untrackNode(els[i]);
            } else {
                // 비동기 청크 처리 (scheduler.yield 활용)
                const arr = Array.from(els);
                let idx = 0;
                const chunk = CONFIG.bulkCleanupThreshold;
                const processChunk = async () => {
                    const end = Math.min(idx + chunk, arr.length);
                    for (; idx < end; idx++)
                        if (trackedNodeSet.has(arr[idx])) untrackNode(arr[idx]);
                    if (idx < arr.length) {
                        await yieldToMain();
                        processChunk();
                    }
                };
                processChunk();
            }
        } catch (_) {}
    };

    const flushBatch = () => {
        batchScheduled = false;
        for (let i = 0; i < pendingNodes.length; i++) {
            const node = pendingNodes[i];
            if (node.nodeType === 1) processSubtree(node);
        }
        pendingNodes.length = 0;
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
            const added = mutations[i].addedNodes;
            for (let j = 0; j < added.length; j++) {
                const node = added[j];
                if (node.nodeType === 1 && !pendingGuard.has(node)) {
                    pendingGuard.add(node);
                    pendingNodes.push(node);
                    hasAdded = true;
                }
            }
            const removed = mutations[i].removedNodes;
            for (let j = 0; j < removed.length; j++) {
                const node = removed[j];
                if (node.nodeType === 1) {
                    pendingGuard.delete(node);
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
                            effectiveLimitNodes = Math.min(effectiveLimitNodes, CONFIG.lowPowerLimitNodes);
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
                    let aliveRefs = 0, deadRefs = 0, hiddenCount = 0;
                    for (let i = 0; i < allTrackedRefs.length; i++) {
                        const el = allTrackedRefs[i].deref();
                        if (el !== undefined) {
                            aliveRefs++;
                            if (gcHiddenMap.has(el)) hiddenCount++;
                        } else deadRefs++;
                    }
                    const info = {
                        version: '7.0',
                        lowPowerMode: isLowPowerMode,
                        memoryPressure,
                        smoothedFPS: Math.round(currentSmoothedFPS * 10) / 10,
                        effectiveLimitNodes,
                        effectiveRestoreBatch,
                        trackedNodes: { alive: aliveRefs, dead: deadRefs, total: allTrackedRefs.length },
                        gcHiddenNodes: hiddenCount,
                        restoreQueueLength: restoreHeap.length,
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
                    return `Compacted: ${before} → ${allTrackedRefs.length} (${before - allTrackedRefs.length} removed)`;
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

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
