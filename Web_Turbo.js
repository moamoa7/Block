// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      9.2
// @description  모든 웹사이트에서 렉을 제거합니다. v9.2: 탭 복귀 시 화면 멈춤(Blank Screen) 현상 완벽 해결, 강제 리플로우 도입, LoAF 렉 감지, 캔버스 GPU 메모리 회수 등 무결점 가속 제공.
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
    const MEDIA_TAGS = { IMG: 1, VIDEO: 2, IFRAME: 3, CANVAS: 4 };

    const CFG = {
        limitNodes:               150,
        gcMarginTop:              800,
        gcMarginBottom:           2500,
        idleTimeout:              3000,
        throttleDwell:            120,
        lowPowerFrameThreshold:   40,
        lowPowerLimitNodes:       80,
        lowPowerBatteryThreshold: 0.15,
        mediaMarginTop:           300,
        mediaMarginBottom:        1000,
        fpsAlpha:                 0.15,
        gcTaskPriority:           'background',
        hardReclaimMarginTop:     4000,
        hardReclaimMarginBottom:  6000,
        restoreBatchSize:         3,
        memoryThresholdBytes:     800 * 1024 * 1024,
        memoryCheckInterval:      15000,
        loafJankThresholdMs:      100,
        loafJankWindowSize:       5,
        slowNetBatchSize:         1,
        blobAutoExpireMs:         60000,
        bulkCleanupThreshold:     50,
        timerThrottleMinInterval: 1000,
        timerThrottleThreshold:   500,
        yieldInterval:            4,
        frameDeltaMaxMs:          500,
        gcYieldChunkSize:         30,
        viewTransitionPauseMs:    300,
        willChangeCleanupMs:      3000,
        idlePrefetchMargin:       1500,
        loafBatchReduction:       0.5,
        mutationDebounceMs:       16,
        inputActiveDebounceMs:    300,
    };

    // ── 런타임 상태 ──
    let isLowPowerMode = false;
    let effectiveLimitNodes = CFG.limitNodes;
    let memoryPressure = false;
    let scrollDirection = 1;
    let effectiveRestoreBatch = CFG.restoreBatchSize;
    let gcPausedUntil = 0;

    let statsReclaimCount = 0;
    let statsRestoreCount = 0;
    let statsHibernateCount = 0;
    let statsThrottledTimers = 0;

    let inputActiveUntil = 0;

    // ── 기능 감지 ──
    const hasSchedulerYield = typeof globalThis.scheduler?.yield === 'function';
    const hasSchedulerPostTask = typeof globalThis.scheduler?.postTask === 'function';
    const hasRIC = typeof requestIdleCallback === 'function';
    const hasLoAF = typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');

    const yieldToMain = hasSchedulerYield
        ? () => scheduler.yield()
        : () => new Promise(r => setTimeout(r, 0));

    // ═══════════════════════════════════════════════
    // §1-b. OffscreenCanvas 감지
    // ═══════════════════════════════════════════════
    const offscreenCanvasSet = new WeakSet();

    {
        const origTransfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
        if (origTransfer) {
            HTMLCanvasElement.prototype.transferControlToOffscreen = function (...args) {
                offscreenCanvasSet.add(this);
                return origTransfer.apply(this, args);
            };
        }
    }

    const safeCanvasResize = (canvas, width, height) => {
        if (offscreenCanvasSet.has(canvas)) return false;
        try {
            canvas.width = width;
            canvas.height = height;
            return true;
        } catch (_) {
            offscreenCanvasSet.add(canvas);
            return false;
        }
    };

    // ═══════════════════════════════════════════════
    // §1-c. 입력 활성 감지
    // ═══════════════════════════════════════════════
    {
        const markInputActive = () => {
            inputActiveUntil = performance.now() + CFG.inputActiveDebounceMs;
        };

        document.addEventListener('keydown', markInputActive, { capture: true, passive: true });
        document.addEventListener('input', markInputActive, { capture: true, passive: true });
        document.addEventListener('compositionstart', markInputActive, { capture: true, passive: true });
        document.addEventListener('compositionupdate', markInputActive, { capture: true, passive: true });
    }

    const isInputActive = () => performance.now() < inputActiveUntil;

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
                    options = { __proto__: null, ...options, passive: true };
            }
            return origAdd.call(this, type, listener, options);
        };
    }

    // ═══════════════════════════════════════════════
    // §2-b. 지능형 타이머 쓰로틀링
    // ═══════════════════════════════════════════════
    {
        const origSetInterval = window.setInterval;
        const origClearInterval = window.clearInterval;
        const throttledTimers = new Map();
        let isTabHidden = document.hidden;
        let nextWrappedId = 0x7FFFFFFF;

        const reapplyThrottles = () => {
            isTabHidden = document.hidden;
            for (const [, info] of throttledTimers) {
                origClearInterval.call(window, info.rid);
                const delay = isTabHidden
                    ? Math.max(info.od, CFG.timerThrottleMinInterval)
                    : info.od;
                info.rid = origSetInterval.call(window, info.cb, delay);
            }
        };

        document.addEventListener('visibilitychange', reapplyThrottles);

        window.setInterval = function (callback, delay, ...args) {
            if (typeof callback !== 'function')
                return origSetInterval.call(window, callback, delay, ...args);
            delay = Number(delay) || 0;
            if (delay >= CFG.timerThrottleThreshold)
                return origSetInterval.call(window, callback, delay, ...args);

            const bound = args.length > 0 ? () => callback(...args) : callback;
            const effectiveDelay = isTabHidden
                ? Math.max(delay, CFG.timerThrottleMinInterval) : delay;
            const rid = origSetInterval.call(window, bound, effectiveDelay);
            const wid = --nextWrappedId;
            throttledTimers.set(wid, { cb: bound, od: delay, rid });
            statsThrottledTimers++;
            return wid;
        };

        window.clearInterval = function (id) {
            const info = throttledTimers.get(id);
            if (info) {
                origClearInterval.call(window, info.rid);
                throttledTimers.delete(id);
            } else {
                origClearInterval.call(window, id);
            }
        };
    }

    // ═══════════════════════════════════════════════
    // §3. CSS 주입
    // ═══════════════════════════════════════════════
    const baseCSS = `
        ${SELECTORS} {
            content-visibility: auto;
            contain-intrinsic-size: auto 500px;
            contain: content;
        }
        @media not (prefers-reduced-motion: reduce) {
            html { scroll-behavior: smooth !important; }
        }
        img {
            content-visibility: auto;
            decoding: async;
        }
        input, textarea, [contenteditable="true"], [role="textbox"],
        .ProseMirror, .cm-editor, .CodeMirror, .ql-editor {
            content-visibility: visible !important;
            contain: none !important;
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

    const forceFontDisplaySwap = () => {
        try {
            if (document.fonts) {
                for (const face of document.fonts) {
                    if (face.display === 'block' || face.display === 'auto')
                        face.display = 'swap';
                }
                return;
            }
            for (const sheet of document.styleSheets) {
                try {
                    const rules = sheet.cssRules;
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
    const COMPLEX_JOINED = COMPLEX_SELECTORS.length ? COMPLEX_SELECTORS.join(', ') : null;
    const complexMatchCache = new WeakMap();

    const matchesSelectors = (el) => {
        if (TAG_SELECTORS.has(el.tagName)) return true;
        const cl = el.classList;
        if (cl) for (let i = 0, n = cl.length; i < n; i++)
            if (CLASS_SELECTORS.has(cl[i])) return true;
        if (COMPLEX_JOINED === null) return false;
        let cached = complexMatchCache.get(el);
        if (cached !== undefined) return cached;
        cached = el.matches(COMPLEX_JOINED);
        complexMatchCache.set(el, cached);
        return cached;
    };

    // ═══════════════════════════════════════════════
    // §5. 스크롤 방향 추적 + MinHeap 복원 큐
    // ═══════════════════════════════════════════════
    {
        let lastScrollY = window.scrollY;
        window.addEventListener('scroll', () => {
            const y = window.scrollY;
            scrollDirection = (y >= lastScrollY) ? 1 : -1;
            lastScrollY = y;
        }, { passive: true });
    }

    class MinHeap {
        constructor(cap) {
            this._d = new Array(cap || 64);
            this._n = 0;
        }
        get length() { return this._n; }

        push(dist, target, tag) {
            const i = this._n++;
            this._d[i] = { distance: dist, target, tag };
            this._up(i);
        }

        pop() {
            if (this._n === 0) return undefined;
            const top = this._d[0];
            if (--this._n > 0) {
                this._d[0] = this._d[this._n];
                this._down(0);
            }
            this._d[this._n] = undefined;
            return top;
        }

        clear() {
            for (let i = 0; i < this._n; i++) this._d[i] = undefined;
            this._n = 0;
        }

        _up(i) {
            const d = this._d;
            const item = d[i];
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (item.distance >= d[p].distance) break;
                d[i] = d[p];
                i = p;
            }
            d[i] = item;
        }

        _down(i) {
            const d = this._d, n = this._n;
            const item = d[i];
            const half = n >> 1;
            while (i < half) {
                let child = (i << 1) + 1;
                const right = child + 1;
                if (right < n && d[right].distance < d[child].distance) child = right;
                if (item.distance <= d[child].distance) break;
                d[i] = d[child];
                i = child;
            }
            d[i] = item;
        }
    }

    const restoreHeap = new MinHeap(64);
    let restoreRafId = 0;
    const restoreQueueSet = new WeakSet();

    const enqueueRestore = (target, tag, rect) => {
        if (restoreQueueSet.has(target)) return;
        restoreQueueSet.add(target);

        const vc = window.innerHeight * 0.5;
        const ec = rect.top + rect.height * 0.5;
        let dist = Math.abs(ec - vc);
        if ((scrollDirection > 0 && ec > vc) || (scrollDirection < 0 && ec < vc))
            dist *= 0.5;

        restoreHeap.push(dist, target, tag);
        if (!restoreRafId) restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    const drainRestoreQueue = async () => {
        restoreRafId = 0;
        let processed = 0;
        while (restoreHeap.length > 0 && processed < effectiveRestoreBatch) {
            const item = restoreHeap.pop();
            if (!item) break;
            restoreQueueSet.delete(item.target);
            executeRestore(item.target, item.tag);
            processed++;
            if (processed % CFG.yieldInterval === 0) await yieldToMain();
        }
        if (restoreHeap.length > 0)
            restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    // ═══════════════════════════════════════════════
    // §6. 미디어 최적화 + 통합 라이프사이클
    // ═══════════════════════════════════════════════
    const optimizedSet = new WeakSet();
    const S_IDLE = 0, S_DWELLING = 1, S_ACTIVE = 2,
          S_RECLAIMED = 3, S_HARD_RECLAIMED = 4;
    const mediaState = new WeakMap();
    const mediaDwellTimers = new WeakMap();
    const mediaSaved = new WeakMap();
    const videoPausedByUs = new WeakSet();

    const willChangeTimers = new WeakMap();

    const optimizeMedia = (el) => {
        if (optimizedSet.has(el)) return;
        optimizedSet.add(el);
        const tag = el.tagName;
        if (tag === 'IMG') {
            if (!el.loading) el.loading = 'lazy';
            el.decoding = 'async';
            if (!el.fetchPriority) el.fetchPriority = 'low';
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'VIDEO') {
            el.preload = 'metadata';
            try { el.disablePictureInPicture = true; } catch (_) {}
            try { el.disableRemotePlayback = true; } catch (_) {}
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'IFRAME') {
            if (!el.loading) el.loading = 'lazy';
            mediaLifecycleObserver.observe(el);
        } else if (tag === 'CANVAS') {
            if (!offscreenCanvasSet.has(el)) {
                hardReclaimObserver.observe(el);
            }
        }
    };

    const scheduleWillChangeCleanup = (target) => {
        if (willChangeTimers.has(target)) {
            clearTimeout(willChangeTimers.get(target));
        }
        const tid = setTimeout(() => {
            willChangeTimers.delete(target);
            if (target.style.willChange === 'transform') {
                target.style.willChange = '';
            }
        }, CFG.willChangeCleanupMs);
        willChangeTimers.set(target, tid);
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
            target.fetchPriority = 'auto';
        } else if (tag === 'VIDEO') {
            if (saved.src && !saved.src.startsWith('blob:')) {
                target.src = saved.src;
                target.load();
            }
            target.style.willChange = 'transform';
            scheduleWillChangeCleanup(target);
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
            if (willChangeTimers.has(target)) {
                clearTimeout(willChangeTimers.get(target));
                willChangeTimers.delete(target);
            }
            if (target.src && !target.src.startsWith('data:')) {
                const saved = { src: target.src };
                if (saved.src.startsWith('blob:'))
                    try { URL.revokeObjectURL(saved.src); } catch (_) {}
                target.removeAttribute('src');
                target.load();
                mediaSaved.set(target, saved);
            }
            target.style.willChange = '';
        } else if (tag === 'IFRAME') {
            if (target.src && target.src !== 'about:blank') {
                mediaSaved.set(target, { src: target.src });
                target.src = 'about:blank';
            }
        }
        statsReclaimCount++;
    };

    const _dedupeMap = new Map();
    const dedupeEntries = (entries) => {
        _dedupeMap.clear();
        for (let i = 0; i < entries.length; i++)
            _dedupeMap.set(entries[i].target, entries[i]);
        return _dedupeMap;
    };

    const mediaLifecycleObserver = new IntersectionObserver((entries) => {
        const deduped = dedupeEntries(entries);
        for (const [target, entry] of deduped) {
            const { isIntersecting, boundingClientRect } = entry;
            const tag = target.tagName;
            const state = mediaState.get(target) || S_IDLE;
            if (state === S_HARD_RECLAIMED) continue;

            if (isIntersecting) {
                if (state === S_RECLAIMED)
                    enqueueRestore(target, tag, boundingClientRect);
                if (tag === 'VIDEO') {
                    if (videoPausedByUs.has(target)) {
                        videoPausedByUs.delete(target);
                        target.play().catch(() => {});
                    }
                    target.style.willChange = 'transform';
                    scheduleWillChangeCleanup(target);
                }
                if (tag === 'IMG') target.fetchPriority = 'high';

                if (state === S_IDLE || state === S_RECLAIMED) {
                    mediaState.set(target, S_DWELLING);
                    if (!mediaDwellTimers.has(target)) {
                        const id = setTimeout(() => {
                            mediaDwellTimers.delete(target);
                            mediaState.set(target, S_ACTIVE);
                        }, CFG.throttleDwell);
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
                if (tag === 'IMG') target.fetchPriority = 'low';

                if (state === S_ACTIVE || state === S_DWELLING) {
                    mediaState.set(target, S_RECLAIMED);
                    reclaimMedia(target, tag);
                    restoreQueueSet.delete(target);
                } else {
                    mediaState.set(target, S_IDLE);
                }
            }
        }
    }, {
        rootMargin: `${CFG.mediaMarginTop}px 0px ${CFG.mediaMarginBottom}px 0px`,
        threshold: 0
    });

    // ═══════════════════════════════════════════════
    // §7. 하드 리클레임 Observer
    // ═══════════════════════════════════════════════
    const canvasSaved = new WeakMap();

    const hardReclaimObserver = new IntersectionObserver((entries) => {
        const deduped = dedupeEntries(entries);
        for (const [target, entry] of deduped) {
            const tag = target.tagName;
            if (!entry.isIntersecting) {
                if (tag === 'CANVAS') {
                    if (!canvasSaved.has(target)
                        && !offscreenCanvasSet.has(target)
                        && (target.width > 0 || target.height > 0)) {
                        canvasSaved.set(target, { w: target.width, h: target.height });
                        safeCanvasResize(target, 0, 0);
                    }
                } else {
                    const state = mediaState.get(target) || S_IDLE;
                    if (state !== S_RECLAIMED && state !== S_HARD_RECLAIMED)
                        reclaimMedia(target, tag);
                    mediaState.set(target, S_HARD_RECLAIMED);
                }
            } else {
                if (tag === 'CANVAS') {
                    if (canvasSaved.has(target)) {
                        const saved = canvasSaved.get(target);
                        canvasSaved.delete(target);
                        safeCanvasResize(target, saved.w, saved.h);
                    }
                } else if (MEDIA_TAGS[tag] && MEDIA_TAGS[tag] <= 3) {
                    mediaState.set(target, S_RECLAIMED);
                }
            }
        }
    }, {
        rootMargin: `${CFG.hardReclaimMarginTop}px 0px ${CFG.hardReclaimMarginBottom}px 0px`,
        threshold: 0
    });

    // ═══════════════════════════════════════════════
    // §8. ResizeObserver 높이 캐싱
    // ═══════════════════════════════════════════════
    const heightCache = new WeakMap();

    const resizeObserver = new ResizeObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const e = entries[i];
            const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
            if (h > 0) heightCache.set(e.target, h);
        }
    });

    // ═══════════════════════════════════════════════
    // §9. 스마트 GC
    // ═══════════════════════════════════════════════
    const gcHiddenSet = new WeakSet();
    const gcHiddenHeight = new WeakMap();
    const gcOriginalStyle = new WeakMap();
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

    const SKIP_GC_TAGS = new Set(['MAIN', 'BODY', 'HTML']);
    const isTopLevelStructural = (el) => {
        if (SKIP_GC_TAGS.has(el.tagName)) return true;
        // [v9.2] 제미나이 등 특수 SPA 구조 강제 예외 (컨테이너 보호)
        if (el.tagName === 'INFINITE-SCROLLER' || el.tagName === 'CHAT-VIEW-ITEM') return true;

        if (el.parentElement === document.body) {
            const tag = el.tagName;
            if (tag === 'MAIN' || tag === 'SECTION' || tag === 'ARTICLE') {
                const siblings = document.body.querySelectorAll(`:scope > ${tag.toLowerCase()}`);
                if (siblings.length <= 1) return true;
            }
        }
        return false;
    };

    const gcObserver = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
            const { target, isIntersecting } = entries[i];
            if (!isIntersecting && !gcHiddenSet.has(target)) {
                if (isTopLevelStructural(target)) continue;

                const h = heightCache.get(target) || target.offsetHeight || 500;
                gcHiddenSet.add(target);
                gcHiddenHeight.set(target, h);
                gcOriginalStyle.set(target, target.style.cssText || '');
                target.style.cssText =
                    `content-visibility:hidden;contain-intrinsic-size:auto ${h}px`;
            } else if (isIntersecting && gcHiddenSet.has(target)) {
                gcHiddenSet.delete(target);
                gcHiddenHeight.delete(target);
                const orig = gcOriginalStyle.get(target);
                gcOriginalStyle.delete(target);
                target.style.cssText = orig || '';
            }
        }
    }, {
        rootMargin: `${CFG.gcMarginTop}px 0px ${CFG.gcMarginBottom}px 0px`,
        threshold: 0
    });

    const forceRestoreVisible = () => {
        const vh = window.innerHeight;
        const margin = CFG.gcMarginBottom;
        let restored = 0;
        for (let i = 0; i < allTrackedRefs.length; i++) {
            const el = allTrackedRefs[i]?.deref();
            if (!el || !gcHiddenSet.has(el)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.bottom > -margin && rect.top < vh + margin) {
                gcHiddenSet.delete(el);
                gcHiddenHeight.delete(el);
                const orig = gcOriginalStyle.get(el);
                gcOriginalStyle.delete(el);
                el.style.cssText = orig || '';
                restored++;
            }
        }
        for (let i = 0; i < allTrackedRefs.length; i++) {
            const el = allTrackedRefs[i]?.deref();
            if (!el) continue;
            const mediaEls = el.querySelectorAll('img,video,iframe');
            for (let j = 0; j < mediaEls.length; j++) {
                const m = mediaEls[j];
                if (mediaState.get(m) === S_HARD_RECLAIMED) {
                    mediaState.set(m, S_RECLAIMED);
                    mediaLifecycleObserver.unobserve(m);
                    mediaLifecycleObserver.observe(m);
                }
            }
        }
        return restored;
    };

    const gcFeed = async () => {
        if (performance.now() < gcPausedUntil) return;

        const len = allTrackedRefs.length;
        if (len <= effectiveLimitNodes) return;
        const cutoff = len - effectiveLimitNodes;
        const start = Math.max(gcObserveWatermark, 0);
        let processed = 0;
        for (let i = start; i < cutoff; i++) {
            const el = allTrackedRefs[i]?.deref();
            if (el) gcObserver.observe(el);
            if (++processed % CFG.gcYieldChunkSize === 0) await yieldToMain();
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
    };

    const untrackNode = (el) => {
        if (!trackedNodeSet.has(el)) return;
        trackedNodeSet.delete(el);
        resizeObserver.unobserve(el);
        gcObserver.unobserve(el);
        mediaLifecycleObserver.unobserve(el);
        hardReclaimObserver.unobserve(el);
        if (gcHiddenSet.has(el)) {
            gcHiddenSet.delete(el);
            gcHiddenHeight.delete(el);
            const orig = gcOriginalStyle.get(el);
            gcOriginalStyle.delete(el);
            el.style.cssText = orig || '';
        }
        finalizer.unregister(el);
    };

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
        effectiveLimitNodes = CFG.lowPowerLimitNodes;
        lowPowerStyleEl.disabled = false;
        gcObserveWatermark = 0;
        gcFeed();
    };

    const exitLowPowerMode = () => {
        if (!isLowPowerMode) return;
        isLowPowerMode = false;
        effectiveLimitNodes = CFG.limitNodes;
        lowPowerStyleEl.disabled = true;
    };

    let startFrameMonitor;
    let currentSmoothedFPS = 60;

    {
        if (hasLoAF) {
            const recentLoAFs = [];
            const loafObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    recentLoAFs.push(entry.duration);
                    if (recentLoAFs.length > CFG.loafJankWindowSize) recentLoAFs.shift();
                }
                if (recentLoAFs.length >= CFG.loafJankWindowSize) {
                    let jankCount = 0;
                    for (let i = 0; i < recentLoAFs.length; i++)
                        if (recentLoAFs[i] > CFG.loafJankThresholdMs) jankCount++;

                    if (jankCount >= Math.ceil(CFG.loafJankWindowSize / 2)) {
                        if (!isLowPowerMode) enterLowPowerMode();
                        effectiveRestoreBatch = Math.max(1,
                            Math.floor(CFG.restoreBatchSize * CFG.loafBatchReduction));
                    } else {
                        effectiveRestoreBatch = CFG.restoreBatchSize;
                    }
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
                if (delta > CFG.frameDeltaMaxMs) {
                    lastFrameTime = now;
                    requestAnimationFrame(frameMonitor);
                    return;
                }
                const instantFPS = 1000 / delta;
                smoothFPS += CFG.fpsAlpha * (instantFPS - smoothFPS);
                currentSmoothedFPS = smoothFPS;

                if (smoothFPS < CFG.lowPowerFrameThreshold) {
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
                        && battery.level <= CFG.lowPowerBatteryThreshold;
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
                    effectiveRestoreBatch = CFG.slowNetBatchSize;
                    if (saveData) enterLowPowerMode();
                } else if (etype === '3g') {
                    effectiveRestoreBatch = Math.max(1,
                        Math.floor(CFG.restoreBatchSize / 2));
                } else {
                    effectiveRestoreBatch = CFG.restoreBatchSize;
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
            }, CFG.blobAutoExpireMs);
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
    // §12. 탭 복귀 시 강제 복원 (v9.2 패치: 강제 리플로우 & 예외 처리)
    // ═══════════════════════════════════════════════
    {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                // Microtask 레벨에서 우선 실행하여 브라우저 파이프라인 선점
                queueMicrotask(() => {
                    forceRestoreVisible();

                    // 강제 리플로우(Reflow) 유발: 화면이 하얗게 굳는 현상 방지
                    void document.body.offsetHeight; 

                    // 2차 안전장치 (렌더링 엔진 지연 대비)
                    setTimeout(() => {
                        forceRestoreVisible();
                    }, 500);
                });
            }
        });
    }

    // ═══════════════════════════════════════════════
    // §13. Shadow DOM 탐색
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
        shadowMut.observe(shadowRoot, { childList: true, subtree: true });
    };

    const checkShadowRoot = (el) => {
        try {
            if (el.shadowRoot && el.shadowRoot.mode === 'open')
                processShadowRoot(el.shadowRoot);
        } catch (_) {}
    };

    // ═══════════════════════════════════════════════
    // §14. MutationObserver (입력 시 지연 처리)
    // ═══════════════════════════════════════════════
    let batchScheduled = false;
    let batchTimerId = 0;
    const pendingNodes = [];
    const pendingGuard = new WeakSet();

    const processSubtree = (root) => {
        try {
            if (!root) return;
            const isFragment = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
            const isElement  = root.nodeType === Node.ELEMENT_NODE;
            if (!isFragment && !isElement) return;

            if (isElement) {
                if (MEDIA_TAGS[root.tagName]) optimizeMedia(root);
                if (matchesSelectors(root)) trackNode(root);
                checkShadowRoot(root);
            }

            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let cur;
            while ((cur = walker.nextNode())) {
                if (MEDIA_TAGS[cur.tagName]) optimizeMedia(cur);
                if (matchesSelectors(cur)) trackNode(cur);
                checkShadowRoot(cur);
            }
        } catch (_) {}
    };

    const cleanupSubtree = (root) => {
        try {
            if (!root || root.nodeType !== 1) return;
            if (trackedNodeSet.has(root)) untrackNode(root);

            const els = root.querySelectorAll(SELECTORS);
            if (els.length <= CFG.bulkCleanupThreshold) {
                for (let i = 0; i < els.length; i++)
                    if (trackedNodeSet.has(els[i])) untrackNode(els[i]);
            } else {
                const arr = Array.from(els);
                let idx = 0;
                const chunk = CFG.bulkCleanupThreshold;
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
        batchTimerId = 0;
        const nodes = pendingNodes.splice(0);
        for (let i = 0; i < nodes.length; i++) {
            if (nodes[i].nodeType === 1) processSubtree(nodes[i]);
        }
        gcFeed();
    };

    const scheduleBatch = () => {
        if (batchScheduled) return;
        batchScheduled = true;

        if (isInputActive()) {
            batchTimerId = setTimeout(flushBatch, CFG.inputActiveDebounceMs);
        } else {
            requestAnimationFrame(flushBatch);
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
                    if (result.bytes > CFG.memoryThresholdBytes) {
                        if (!memoryPressure) {
                            memoryPressure = true;
                            effectiveLimitNodes = Math.min(effectiveLimitNodes, CFG.lowPowerLimitNodes);
                            gcObserveWatermark = 0;
                            gcFeed();
                        }
                    } else if (memoryPressure) {
                        memoryPressure = false;
                        effectiveLimitNodes = isLowPowerMode
                            ? CFG.lowPowerLimitNodes : CFG.limitNodes;
                    }
                } catch (_) {}
                setTimeout(checkMemory, CFG.memoryCheckInterval);
            };
            setTimeout(checkMemory, 10000);
        }
    }

    // ═══════════════════════════════════════════════
    // §16. 정기 GC + ViewTransition 일시정지
    // ═══════════════════════════════════════════════
    const scheduleTask = hasSchedulerPostTask
        ? (fn) => scheduler.postTask(fn, { priority: CFG.gcTaskPriority }).catch(() => {})
        : hasRIC
            ? (fn) => requestIdleCallback((dl) => {
                  if (dl.timeRemaining() > 5 || dl.didTimeout) fn();
              }, { timeout: CFG.idleTimeout })
            : (fn) => setTimeout(fn, CFG.idleTimeout);

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

    {
        const origStartViewTransition = document.startViewTransition;
        if (typeof origStartViewTransition === 'function') {
            document.startViewTransition = function (...args) {
                gcPausedUntil = performance.now() + CFG.viewTransitionPauseMs;
                return origStartViewTransition.apply(this, args);
            };
        }
    }

    {
        if (hasRIC) {
            const prefetchObserver = new IntersectionObserver((entries) => {
                for (let i = 0; i < entries.length; i++) {
                    const { target, isIntersecting } = entries[i];
                    if (isIntersecting && target.tagName === 'IMG'
                        && target.complete === false && typeof target.decode === 'function') {
                        requestIdleCallback(() => {
                            target.decode().catch(() => {});
                        }, { timeout: 2000 });
                        prefetchObserver.unobserve(target);
                    }
                }
            }, {
                rootMargin: `${CFG.idlePrefetchMargin}px 0px ${CFG.idlePrefetchMargin}px 0px`,
                threshold: 0
            });
            window._turboPrefetchObserver = prefetchObserver;
        }
    }

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
                            if (gcHiddenSet.has(el)) hiddenCount++;
                        } else deadRefs++;
                    }
                    const info = {
                        version: '9.2',
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
                emergencyRestore() {
                    let restored = 0;
                    for (let i = 0; i < allTrackedRefs.length; i++) {
                        const el = allTrackedRefs[i]?.deref();
                        if (el && gcHiddenSet.has(el)) {
                            gcHiddenSet.delete(el);
                            gcHiddenHeight.delete(el);
                            const orig = gcOriginalStyle.get(el);
                            gcOriginalStyle.delete(el);
                            el.style.cssText = orig || '';
                            restored++;
                        }
                    }
                    return `Emergency restored ${restored} nodes`;
                },
                forceRestore() {
                    return `Force restored ${forceRestoreVisible()} visible nodes`;
                },
                config: CFG,
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

            if (window._turboPrefetchObserver) {
                const imgs = document.body.getElementsByTagName('img');
                for (let i = 0; i < imgs.length; i++) {
                    window._turboPrefetchObserver.observe(imgs[i]);
                }
            }

            console.log(
                `%c🚀 Turbo Optimizer v9.2 %c Active: ${location.hostname}`,
                'color:#00ffa3;font-weight:bold;background:#222;padding:3px 6px;border-radius:4px',
                'color:#fff'
            );
        } catch (_) {}
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
