// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      11.0
// @description  모든 웹사이트에서 렉을 제거하고 최적의 성능을 보장합니다. v11.0: 모든 사이트에 일관된 뼈대 보호 정책 적용. 사이트별 분기 최소화, 구조적 안정성 대폭 강화.
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
    // §1. 사이트 프로필 감지
    // ═══════════════════════════════════════════════
    const HOST = location.hostname;

    const SITE_PROFILE = (() => {
        if (HOST.includes('gemini.google.com'))
            return {
                id: 'gemini',
                streamingSelector: 'model-response[is-streaming], .loading-spinner, mat-progress-bar',
                turnSelector: 'model-response, user-query',
                scrollContainer: 'infinite-scroller.chat-history, .conversation-container',
            };
        if (HOST.includes('chatgpt.com') || HOST.includes('chat.openai.com'))
            return {
                id: 'chatgpt',
                streamingSelector: '.result-streaming, button[aria-label="Stop generating"], .streaming',
                turnSelector: 'article[data-testid^="conversation-turn-"]',
                scrollContainer: '[class*="react-scroll-to-bottom"]',
            };
        if (HOST.includes('claude.ai'))
            return {
                id: 'claude',
                streamingSelector: '[data-is-streaming="true"], button[aria-label="Stop Response"]',
                turnSelector: 'div[class*="ChatMessage"]',
                scrollContainer: '.overflow-y-auto',
            };
        if (HOST.includes('genspark.ai'))
            return {
                id: 'genspark',
                streamingSelector: '.loading-spinner, .generating, .streaming-indicator, .thinking-indicator, button[class*="stop"], .moa-progress, .agent-thinking',
                turnSelector: '.conversation-statement',
                scrollContainer: '.chat-container, .conversation-list',
            };
        if (HOST.includes('perplexity.ai'))
            return {
                id: 'perplexity',
                streamingSelector: '[data-testid="streaming-indicator"], .animate-pulse, button[aria-label="Stop"]',
                turnSelector: '[data-testid="message-content"]',
                scrollContainer: 'main',
            };
        if (HOST.includes('aistudio.google.com'))
            return {
                id: 'aistudio',
                streamingSelector: '.generating-indicator, mat-progress-bar, .loading',
                turnSelector: 'ms-chat-turn, .chat-turn',
                scrollContainer: '.chat-scroll-container',
            };
        if (HOST.includes('copilot.microsoft.com'))
            return {
                id: 'copilot',
                streamingSelector: '.typing-indicator, cib-typing-indicator, [is-streaming]',
                turnSelector: 'cib-chat-turn, cib-message-group',
                scrollContainer: 'cib-chat-main',
            };
        if (HOST.includes('grok.com') || HOST.includes('x.ai'))
            return {
                id: 'grok',
                streamingSelector: '[data-streaming="true"], .animate-pulse',
                turnSelector: '[class*="message"]',
                scrollContainer: 'main',
            };
        if (HOST.includes('huggingface.co') && location.pathname.startsWith('/chat'))
            return {
                id: 'huggingchat',
                streamingSelector: '.message.assistant .loading, button[aria-label="Stop generating"]',
                turnSelector: '.message',
                scrollContainer: '.overflow-y-auto',
            };
        if (HOST.includes('chat.deepseek.com'))
            return {
                id: 'deepseek',
                streamingSelector: '.ds-loading, .thinking-block, button[class*="stop"]',
                turnSelector: '[class*="Message"]',
                scrollContainer: '.overflow-y-auto',
            };
        if (HOST.includes('poe.com'))
            return {
                id: 'poe',
                streamingSelector: '[class*="ChatMessage_loading"], button[class*="StopButton"]',
                turnSelector: '[class*="ChatMessage"]',
                scrollContainer: '[class*="ChatMessagesView"]',
            };
        return null;
    })();

    const IS_AI_CHAT = SITE_PROFILE !== null;

    // ═══════════════════════════════════════════════
    // §1-a. 상수 & 설정
    // ═══════════════════════════════════════════════
    const SELECTOR_LIST = [
        'article', 'section', 'main', '.post', '.content', '.comment',
        'section[data-testid^="conversation-turn-"]',
        'div[class*="ChatMessage"]',
        'infinite-scroller > div', 'chat-view-item',
        '.conversation-statement',
        '[data-testid="message-content"]',
        'div[class*="Message"]',
        'div[class*="ChatMessage"]',
    ];

    const SELECTORS = SELECTOR_LIST.join(', ');
    const MEDIA_TAG_SET = new Set(['IMG', 'VIDEO', 'IFRAME', 'CANVAS']);

    const CFG = {
        limitNodes:               IS_AI_CHAT ? 80 : 150,
        gcMarginTop:              800,
        gcMarginBottom:           IS_AI_CHAT ? 1500 : 2500,
        idleTimeout:              3000,
        throttleDwell:            120,
        lowPowerFrameThreshold:   40,
        lowPowerLimitNodes:       50,
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
        timerThrottleMinInterval: 1000,
        timerThrottleThreshold:   500,
        yieldInterval:            4,
        frameDeltaMaxMs:          500,
        gcYieldChunkSize:         30,
        viewTransitionPauseMs:    300,
        willChangeCleanupMs:      3000,
        loafBatchReduction:       0.5,
        inputActiveDebounceMs:    300,
        streamingCheckInterval:   500,
        streamingGcPauseMs:       2000,
        mutationCoalesceMs:       100,
        bulkCleanupThreshold:     50,
        hydrationGracePeriodMs:   2500,
    };

    let isLowPowerMode = false;
    let effectiveLimitNodes = CFG.limitNodes;
    let memoryPressure = false;
    let scrollDirection = 1;
    let effectiveRestoreBatch = CFG.restoreBatchSize;
    let gcPausedUntil = 0;
    let inputActiveUntil = 0;
    let isStreaming = false;

    let statsReclaimCount = 0;
    let statsRestoreCount = 0;
    let statsThrottledTimers = 0;
    let currentSmoothedFPS = 60;

    const hasSchedulerYield    = typeof globalThis.scheduler?.yield === 'function';
    const hasSchedulerPostTask = typeof globalThis.scheduler?.postTask === 'function';
    const hasRIC               = typeof requestIdleCallback === 'function';
    const hasLoAF = typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
    const hasLongTask = !hasLoAF && typeof PerformanceObserver !== 'undefined'
        && PerformanceObserver.supportedEntryTypes?.includes('longtask');
    const hasNavigationAPI = typeof navigation !== 'undefined'
        && typeof navigation.addEventListener === 'function';

    const yieldToMain = hasSchedulerYield
        ? () => scheduler.yield()
        : () => new Promise(r => setTimeout(r, 0));

    // ═══════════════════════════════════════════════
    // §1-b. OffscreenCanvas 감지
    // ═══════════════════════════════════════════════
    const offscreenCanvasSet = new WeakSet();
    {
        const orig = HTMLCanvasElement.prototype.transferControlToOffscreen;
        if (orig) {
            HTMLCanvasElement.prototype.transferControlToOffscreen = function (...a) {
                offscreenCanvasSet.add(this);
                return orig.apply(this, a);
            };
        }
    }
    const safeCanvasResize = (c, w, h) => {
        if (offscreenCanvasSet.has(c)) return false;
        try { c.width = w; c.height = h; return true; }
        catch { offscreenCanvasSet.add(c); return false; }
    };

    // ═══════════════════════════════════════════════
    // §1-c. 입력 활성 감지
    // ═══════════════════════════════════════════════
    {
        const mark = () => { inputActiveUntil = performance.now() + CFG.inputActiveDebounceMs; };
        for (const evt of ['keydown', 'input', 'compositionstart', 'compositionupdate'])
            document.addEventListener(evt, mark, { capture: true, passive: true });
    }
    const isInputActive = () => performance.now() < inputActiveUntil;

    // ═══════════════════════════════════════════════
    // §1-d. AI 스트리밍 감지
    // ═══════════════════════════════════════════════
    if (IS_AI_CHAT && SITE_PROFILE.streamingSelector) {
        const checkStreaming = () => {
            const wasStreaming = isStreaming;
            isStreaming = !!document.querySelector(SITE_PROFILE.streamingSelector);
            if (isStreaming && !wasStreaming) gcPausedUntil = Infinity;
            if (!isStreaming && wasStreaming) gcPausedUntil = performance.now() + CFG.streamingGcPauseMs;
        };
        const startStreamingWatch = () => setInterval(checkStreaming, CFG.streamingCheckInterval);
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startStreamingWatch);
        else startStreamingWatch();
    }

    // ═══════════════════════════════════════════════
    // §2. 패시브 이벤트 리스너 강제화
    // ═══════════════════════════════════════════════
    {
        const origAdd = EventTarget.prototype.addEventListener;
        const PASSIVE_TYPES = new Set(['touchstart', 'touchmove', 'wheel', 'mousewheel', 'scroll']);
        const PF = Object.freeze({ passive: true, capture: false });
        const PT = Object.freeze({ passive: true, capture: true });

        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (PASSIVE_TYPES.has(type)) {
                if (options == null || options === false) options = PF;
                else if (options === true) options = PT;
                else if (typeof options === 'object' && options.passive === undefined)
                    options = { ...options, passive: true };
            }
            return origAdd.call(this, type, listener, options);
        };
    }

    // ═══════════════════════════════════════════════
    // §2-b. 지능형 타이머 쓰로틀링
    // ═══════════════════════════════════════════════
    {
        const origSI = window.setInterval;
        const origCI = window.clearInterval;
        const throttled = new Map();
        let hidden = document.hidden;
        let wrapId = 0x7FFFFFFF;

        const reapply = () => {
            hidden = document.hidden;
            for (const [, info] of throttled) {
                origCI.call(window, info.rid);
                info.rid = origSI.call(window, info.cb,
                    hidden ? Math.max(info.od, CFG.timerThrottleMinInterval) : info.od);
            }
        };
        document.addEventListener('visibilitychange', reapply);

        window.setInterval = function (cb, delay, ...args) {
            if (typeof cb !== 'function') return origSI.call(window, cb, delay, ...args);
            delay = Number(delay) || 0;
            if (delay >= CFG.timerThrottleThreshold) return origSI.call(window, cb, delay, ...args);
            const bound = args.length ? () => cb(...args) : cb;
            const eff = hidden ? Math.max(delay, CFG.timerThrottleMinInterval) : delay;
            const rid = origSI.call(window, bound, eff);
            const wid = --wrapId;
            throttled.set(wid, { cb: bound, od: delay, rid });
            statsThrottledTimers++;
            return wid;
        };

        window.clearInterval = function (id) {
            const info = throttled.get(id);
            if (info) { origCI.call(window, info.rid); throttled.delete(id); }
            else origCI.call(window, id);
        };
    }

    // ═══════════════════════════════════════════════
    // §3. CSS 주입 (★ v11.0: 모든 사이트 공통 뼈대 보호)
    // ═══════════════════════════════════════════════

    // ★ [v11.0] 모든 사이트에서 body 직계 자식과 앱 셸 구조는
    //    content-visibility:auto로 숨기지 않도록 원천 보호
    const skeletonProtectCSS = `
        body > *,
        [id="app"], [id="root"], [id="__next"], [id="__nuxt"],
        app-root, #app-root,
        main, [role="main"] {
            content-visibility: visible !important;
            contain-intrinsic-size: none !important;
        }
    `;

    const baseCSS = `
        ${skeletonProtectCSS}
        ${SELECTORS}{content-visibility:auto;contain-intrinsic-size:auto 500px;contain:content}
        @media not (prefers-reduced-motion:reduce){html{scroll-behavior:smooth!important}}
        img{content-visibility:auto;decoding:async}
        input,textarea,[contenteditable="true"],[role="textbox"],
        .ProseMirror,.cm-editor,.CodeMirror,.ql-editor{
            content-visibility:visible!important;contain:none!important}
    `;
    const lowPowerCSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}`;

    const styleEl = document.createElement('style');
    styleEl.textContent = baseCSS;
    const lowPowerStyleEl = document.createElement('style');
    lowPowerStyleEl.textContent = lowPowerCSS;
    lowPowerStyleEl.disabled = true;

    {
        const insert = () => (document.head || document.documentElement).append(styleEl, lowPowerStyleEl);
        if (document.head) insert();
        else new MutationObserver((_, obs) => {
            if (document.head) { obs.disconnect(); insert(); }
        }).observe(document.documentElement, { childList: true });
    }

    const forceFontDisplaySwap = () => {
        try {
            if (document.fonts) {
                for (const f of document.fonts)
                    if (f.display === 'block' || f.display === 'auto') f.display = 'swap';
                return;
            }
            for (const s of document.styleSheets) {
                try {
                    for (const r of s.cssRules)
                        if (r instanceof CSSFontFaceRule && !r.style.fontDisplay)
                            r.style.fontDisplay = 'swap';
                } catch {}
            }
        } catch {}
    };

    // ═══════════════════════════════════════════════
    // §4. 셀렉터 매칭 최적화
    // ═══════════════════════════════════════════════
    const TAG_SEL = new Set();
    const CLASS_SEL = new Set();
    const COMPLEX_SEL = [];

    for (const s of SELECTOR_LIST) {
        if (/^[a-z][\w-]*$/i.test(s)) TAG_SEL.add(s.toUpperCase());
        else if (/^\.\w[\w-]*$/.test(s)) CLASS_SEL.add(s.slice(1));
        else COMPLEX_SEL.push(s);
    }
    const COMPLEX_JOINED = COMPLEX_SEL.length ? COMPLEX_SEL.join(', ') : null;

    const matchesSelectors = (el) => {
        if (TAG_SEL.has(el.tagName)) return true;
        const cl = el.classList;
        if (cl) for (let i = 0, n = cl.length; i < n; i++)
            if (CLASS_SEL.has(cl[i])) return true;
        if (!COMPLEX_JOINED) return false;
        return el.matches(COMPLEX_JOINED);
    };

    // ═══════════════════════════════════════════════
    // §5. 스크롤 방향 추적
    // ═══════════════════════════════════════════════
    {
        let lastY = window.scrollY;
        window.addEventListener('scroll', () => {
            const y = window.scrollY;
            scrollDirection = y >= lastY ? 1 : -1;
            lastY = y;
        }, { passive: true });
    }

    // ═══════════════════════════════════════════════
    // §6. 복원 큐
    // ═══════════════════════════════════════════════
    const restoreQueue = [];
    const restoreQueueSet = new WeakSet();
    let restoreRafId = 0;

    const enqueueRestore = (target, tag, rect) => {
        if (restoreQueueSet.has(target)) return;
        restoreQueueSet.add(target);
        const vc = window.innerHeight * 0.5;
        const ec = rect.top + rect.height * 0.5;
        let dist = Math.abs(ec - vc);
        if ((scrollDirection > 0 && ec > vc) || (scrollDirection < 0 && ec < vc)) dist *= 0.5;
        restoreQueue.push({ dist, target, tag });
        if (!restoreRafId) restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    const drainRestoreQueue = async () => {
        restoreRafId = 0;
        restoreQueue.sort((a, b) => a.dist - b.dist);
        let processed = 0;
        while (restoreQueue.length && processed < effectiveRestoreBatch) {
            const item = restoreQueue.shift();
            restoreQueueSet.delete(item.target);
            executeRestore(item.target, item.tag);
            processed++;
            if (processed % CFG.yieldInterval === 0) await yieldToMain();
        }
        if (restoreQueue.length)
            restoreRafId = requestAnimationFrame(drainRestoreQueue);
    };

    // ═══════════════════════════════════════════════
    // §7. 미디어 라이프사이클
    // ═══════════════════════════════════════════════
    const optimizedSet = new WeakSet();
    const S_IDLE = 0, S_DWELLING = 1, S_ACTIVE = 2, S_RECLAIMED = 3, S_HARD = 4;
    const mediaState   = new WeakMap();
    const mediaDwell   = new WeakMap();
    const mediaSaved   = new WeakMap();
    const canvasSaved  = new WeakMap();
    const videoPaused  = new WeakSet();
    const willChangeTm = new WeakMap();

    const preserveSize = (el) => {
        const w = el.offsetWidth, h = el.offsetHeight;
        if (w > 0 && h > 0) { el.style.minWidth = w + 'px'; el.style.minHeight = h + 'px'; }
    };

    const scheduleWillChangeCleanup = (el) => {
        if (willChangeTm.has(el)) clearTimeout(willChangeTm.get(el));
        willChangeTm.set(el, setTimeout(() => {
            willChangeTm.delete(el);
            if (el.style.willChange === 'transform') el.style.willChange = '';
        }, CFG.willChangeCleanupMs));
    };

    const executeRestore = (target, tag) => {
        const saved = mediaSaved.get(target);
        if (!saved) return;
        mediaSaved.delete(target);
        target.style.minWidth = '';
        target.style.minHeight = '';
        if (tag === 'IMG') {
            if (saved.src) target.src = saved.src;
            if (saved.srcset) target.srcset = saved.srcset;
            target.fetchPriority = 'auto';
        } else if (tag === 'VIDEO') {
            if (saved.src) { target.src = saved.src; target.load(); }
            target.style.willChange = 'transform';
            scheduleWillChangeCleanup(target);
        } else if (tag === 'IFRAME') {
            if (saved.src) target.src = saved.src;
        }
        statsRestoreCount++;
    };

    const reclaimMedia = (target, tag) => {
        preserveSize(target);
        if (tag === 'IMG') {
            const saved = {};
            if (target.src && !target.src.startsWith('data:')) {
                saved.src = target.src; target.removeAttribute('src');
            }
            if (target.srcset) { saved.srcset = target.srcset; target.removeAttribute('srcset'); }
            if (saved.src || saved.srcset) mediaSaved.set(target, saved);
        } else if (tag === 'VIDEO') {
            if (willChangeTm.has(target)) { clearTimeout(willChangeTm.get(target)); willChangeTm.delete(target); }
            if (target.src && !target.src.startsWith('data:')) {
                mediaSaved.set(target, { src: target.src });
                target.removeAttribute('src'); target.load();
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

    const handleMediaIntersection = (target, isIntersecting, rect, isHardLevel) => {
        const tag = target.tagName;
        const state = mediaState.get(target) || S_IDLE;

        if (isHardLevel) {
            if (tag === 'CANVAS') {
                if (!isIntersecting) {
                    if (!canvasSaved.has(target) && !offscreenCanvasSet.has(target)
                        && (target.width > 0 || target.height > 0)) {
                        canvasSaved.set(target, { w: target.width, h: target.height });
                        safeCanvasResize(target, 0, 0);
                    }
                } else if (canvasSaved.has(target)) {
                    const s = canvasSaved.get(target); canvasSaved.delete(target);
                    safeCanvasResize(target, s.w, s.h);
                }
                return;
            }
            if (!isIntersecting) {
                if (state !== S_RECLAIMED && state !== S_HARD) reclaimMedia(target, tag);
                mediaState.set(target, S_HARD);
            } else {
                if (state === S_HARD) mediaState.set(target, S_RECLAIMED);
            }
            return;
        }

        if (state === S_HARD) return;

        if (isIntersecting) {
            if (state === S_RECLAIMED) enqueueRestore(target, tag, rect);
            if (tag === 'VIDEO') {
                if (videoPaused.has(target)) { videoPaused.delete(target); target.play().catch(() => {}); }
                target.style.willChange = 'transform';
                scheduleWillChangeCleanup(target);
            }
            if (tag === 'IMG') target.fetchPriority = 'high';

            if (state === S_IDLE || state === S_RECLAIMED) {
                mediaState.set(target, S_DWELLING);
                if (!mediaDwell.has(target)) {
                    mediaDwell.set(target, setTimeout(() => {
                        mediaDwell.delete(target); mediaState.set(target, S_ACTIVE);
                    }, CFG.throttleDwell));
                }
            }
        } else {
            if (mediaDwell.has(target)) { clearTimeout(mediaDwell.get(target)); mediaDwell.delete(target); }
            if (tag === 'VIDEO' && target instanceof HTMLVideoElement && !target.paused) {
                target.pause(); videoPaused.add(target);
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
    };

    const _dedup = new Map();
    const dedup = (entries) => { _dedup.clear(); for (const e of entries) _dedup.set(e.target, e); return _dedup; };

    const mediaLifecycleObserver = new IntersectionObserver((entries) => {
        for (const [target, entry] of dedup(entries))
            handleMediaIntersection(target, entry.isIntersecting, entry.boundingClientRect, false);
    }, { rootMargin: `${CFG.mediaMarginTop}px 0px ${CFG.mediaMarginBottom}px 0px`, threshold: 0 });

    const hardReclaimObserver = new IntersectionObserver((entries) => {
        for (const [target, entry] of dedup(entries))
            handleMediaIntersection(target, entry.isIntersecting, entry.boundingClientRect, true);
    }, { rootMargin: `${CFG.hardReclaimMarginTop}px 0px ${CFG.hardReclaimMarginBottom}px 0px`, threshold: 0 });

    const optimizeMedia = (el) => {
        if (optimizedSet.has(el)) return;
        optimizedSet.add(el);
        const tag = el.tagName;
        if (tag === 'IMG') {
            if (!el.loading) el.loading = 'lazy';
            el.decoding = 'async';
            if (!el.fetchPriority) el.fetchPriority = 'low';
            mediaLifecycleObserver.observe(el);
            hardReclaimObserver.observe(el);
        } else if (tag === 'VIDEO') {
            el.preload = 'metadata';
            try { el.disablePictureInPicture = true; } catch {}
            try { el.disableRemotePlayback = true; } catch {}
            mediaLifecycleObserver.observe(el);
            hardReclaimObserver.observe(el);
        } else if (tag === 'IFRAME') {
            if (!el.loading) el.loading = 'lazy';
            mediaLifecycleObserver.observe(el);
            hardReclaimObserver.observe(el);
        } else if (tag === 'CANVAS' && !offscreenCanvasSet.has(el)) {
            hardReclaimObserver.observe(el);
        }
    };

    // ═══════════════════════════════════════════════
    // §8. GC 시스템 (★ v11.0: 모든 사이트 공통 뼈대 보호)
    // ═══════════════════════════════════════════════
    const trackedNodes = new Set();
    const gcHiddenSet  = new Set();
    const gcHiddenHeight = new WeakMap();
    const gcOriginalStyle = new WeakMap();
    const heightCache = new WeakMap();

    const resizeObserver = new ResizeObserver((entries) => {
        for (const e of entries) {
            const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
            if (h > 0) heightCache.set(e.target, h);
        }
    });

    // ★ [v11.0] 모든 사이트에서 공통으로 적용되는 뼈대 보호 판정
    //   - body/html/main 태그 자체
    //   - body 직계 자식 중 유일한 구조 태그
    //   - 앱 셸 id (#app, #root, #__next, #__nuxt 등)
    //   - 스크롤 컨테이너 (AI 사이트의 scrollContainer)
    //   - role="main" 요소
    const SKIP_GC_TAGS = new Set(['MAIN', 'BODY', 'HTML']);
    const APP_SHELL_IDS = new Set(['app', 'root', '__next', '__nuxt', 'app-root', '__app']);

    const isStructuralSkeleton = (el) => {
        // 1) html/body/main 태그 자체는 절대 건드리지 않음
        if (SKIP_GC_TAGS.has(el.tagName)) return true;

        // 2) 앱 셸 id를 가진 요소 보호
        if (el.id && APP_SHELL_IDS.has(el.id)) return true;

        // 3) 커스텀 엘리먼트 중 'app-root' 같은 앱 루트 태그 보호
        const tagLower = el.tagName.toLowerCase();
        if (tagLower === 'app-root') return true;

        // 4) role="main" 보호
        if (el.getAttribute('role') === 'main') return true;

        // 5) body 직계 자식 중 유일한 구조 태그면 보호
        if (el.parentElement === document.body) {
            const tag = el.tagName;
            if (tag === 'MAIN' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'DIV') {
                // body 직계 자식이 3개 이하면 모두 뼈대로 판정
                const directChildren = document.body.children;
                if (directChildren.length <= 3) return true;
                // 같은 태그가 하나뿐이면 뼈대
                if (tag !== 'DIV' &&
                    document.body.querySelectorAll(`:scope > ${tag.toLowerCase()}`).length <= 1)
                    return true;
            }
        }

        // 6) AI 챗의 스크롤 컨테이너 보호
        if (IS_AI_CHAT && SITE_PROFILE.scrollContainer) {
            try {
                if (el.matches(SITE_PROFILE.scrollContainer)) return true;
            } catch {}
        }

        return false;
    };

    const gcObserver = new IntersectionObserver((entries) => {
        for (const { target, isIntersecting } of entries) {
            if (!isIntersecting && !gcHiddenSet.has(target)) {
                if (isStructuralSkeleton(target)) continue;
                if (isStreaming) continue;

                const h = heightCache.get(target) || target.offsetHeight || 500;
                gcHiddenSet.add(target);
                gcHiddenHeight.set(target, h);
                gcOriginalStyle.set(target, target.style.cssText || '');
                target.style.cssText = `content-visibility:hidden;contain-intrinsic-size:auto ${h}px`;
            } else if (isIntersecting && gcHiddenSet.has(target)) {
                gcHiddenSet.delete(target);
                gcHiddenHeight.delete(target);
                const orig = gcOriginalStyle.get(target);
                gcOriginalStyle.delete(target);
                target.style.cssText = orig || '';
            }
        }
    }, { rootMargin: `${CFG.gcMarginTop}px 0px ${CFG.gcMarginBottom}px 0px`, threshold: 0 });

    const gcFeed = async () => {
        if (performance.now() < gcPausedUntil) return;
        if (isStreaming) return;
        const size = trackedNodes.size;
        if (size <= effectiveLimitNodes) return;

        const cutoff = size - effectiveLimitNodes;
        let i = 0, processed = 0;
        for (const el of trackedNodes) {
            if (i++ >= cutoff) break;
            if (!el.isConnected) { trackedNodes.delete(el); continue; }
            if (isStructuralSkeleton(el)) continue;
            gcObserver.observe(el);
            if (++processed % CFG.gcYieldChunkSize === 0) await yieldToMain();
        }
    };

    const trackNode = (el) => {
        if (trackedNodes.has(el)) return;
        // ★ [v11.0] 뼈대 요소는 어떤 사이트든 추적 셋에 넣지 않음
        if (isStructuralSkeleton(el)) return;
        trackedNodes.add(el);
        resizeObserver.observe(el);
    };

    const untrackNode = (el) => {
        if (!trackedNodes.delete(el)) return;
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
    };

    const forceRestoreVisible = () => {
        const vh = window.innerHeight;
        const margin = CFG.gcMarginBottom;
        let restored = 0;
        for (const el of gcHiddenSet) {
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
        for (const el of trackedNodes) {
            if (!el.isConnected) continue;
            const mediaEls = el.querySelectorAll('img,video,iframe');
            for (const m of mediaEls) {
                if (mediaState.get(m) === S_HARD) {
                    mediaState.set(m, S_RECLAIMED);
                    mediaLifecycleObserver.unobserve(m);
                    mediaLifecycleObserver.observe(m);
                }
            }
        }
        return restored;
    };

    const forceRestoreAll = () => {
        let restored = 0;
        for (const el of gcHiddenSet) {
            gcHiddenSet.delete(el);
            gcHiddenHeight.delete(el);
            const orig = gcOriginalStyle.get(el);
            gcOriginalStyle.delete(el);
            el.style.cssText = orig || '';
            restored++;
        }
        return restored;
    };

    const purgeDisconnected = () => {
        for (const el of trackedNodes)
            if (!el.isConnected) { trackedNodes.delete(el); gcHiddenSet.delete(el); }
    };

    // ═══════════════════════════════════════════════
    // §9. 저사양 모드
    // ═══════════════════════════════════════════════
    const enterLowPowerMode = () => {
        if (isLowPowerMode) return;
        isLowPowerMode = true;
        effectiveLimitNodes = CFG.lowPowerLimitNodes;
        lowPowerStyleEl.disabled = false;
        gcFeed();
    };
    const exitLowPowerMode = () => {
        if (!isLowPowerMode) return;
        isLowPowerMode = false;
        effectiveLimitNodes = CFG.limitNodes;
        lowPowerStyleEl.disabled = true;
    };

    let startFrameMonitor;
    {
        if (hasLoAF) {
            const recent = [];
            try {
                new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        recent.push(entry.duration);
                        if (recent.length > CFG.loafJankWindowSize) recent.shift();
                    }
                    if (recent.length >= CFG.loafJankWindowSize) {
                        let jank = 0;
                        for (const d of recent) if (d > CFG.loafJankThresholdMs) jank++;
                        if (jank >= Math.ceil(CFG.loafJankWindowSize / 2)) {
                            if (!isLowPowerMode) enterLowPowerMode();
                            effectiveRestoreBatch = Math.max(1,
                                Math.floor(CFG.restoreBatchSize * CFG.loafBatchReduction));
                        } else {
                            effectiveRestoreBatch = CFG.restoreBatchSize;
                        }
                    }
                }).observe({ type: 'long-animation-frame', buffered: false });
            } catch {}
        } else if (hasLongTask) {
            let ltCount = 0, ltTimer = 0;
            try {
                new PerformanceObserver((list) => {
                    ltCount += list.getEntries().length;
                    clearTimeout(ltTimer);
                    ltTimer = setTimeout(() => {
                        if (ltCount >= 3 && !isLowPowerMode) enterLowPowerMode();
                        ltCount = 0;
                    }, 2000);
                }).observe({ type: 'longtask', buffered: false });
            } catch {}
        }

        let lastFT = 0, smoothFPS = 60, lowDur = 0, highDur = 0;
        let monActive = true, batLow = false;

        const frameMon = (now) => {
            if (!monActive) return;
            if (lastFT > 0) {
                const delta = now - lastFT;
                if (delta > CFG.frameDeltaMaxMs) { lastFT = now; requestAnimationFrame(frameMon); return; }
                smoothFPS += CFG.fpsAlpha * (1000 / delta - smoothFPS);
                currentSmoothedFPS = smoothFPS;

                if (smoothFPS < CFG.lowPowerFrameThreshold) {
                    lowDur += delta; highDur = 0;
                    if (lowDur > 500 && !isLowPowerMode) enterLowPowerMode();
                } else {
                    highDur += delta; lowDur = 0;
                    if (highDur > 2000 && isLowPowerMode && !batLow) exitLowPowerMode();
                }
            }
            lastFT = now;
            requestAnimationFrame(frameMon);
        };

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) monActive = false;
            else { monActive = true; lastFT = 0; smoothFPS = 60; lowDur = highDur = 0; requestAnimationFrame(frameMon); }
        });

        if (navigator.getBattery) {
            navigator.getBattery().then((bat) => {
                const chk = () => {
                    batLow = !bat.charging && bat.level <= CFG.lowPowerBatteryThreshold;
                    if (batLow) enterLowPowerMode();
                };
                bat.addEventListener('chargingchange', chk);
                bat.addEventListener('levelchange', chk);
                chk();
            }).catch(() => {});
        }

        try {
            const mq = matchMedia('(prefers-reduced-motion: reduce)');
            mq.addEventListener('change', (e) => { if (e.matches) enterLowPowerMode(); });
            if (mq.matches) enterLowPowerMode();
        } catch {}

        const conn = navigator.connection;
        if (conn) {
            const upd = () => {
                const et = conn.effectiveType;
                if (conn.saveData || et === 'slow-2g' || et === '2g') {
                    effectiveRestoreBatch = CFG.slowNetBatchSize;
                    if (conn.saveData) enterLowPowerMode();
                } else if (et === '3g') {
                    effectiveRestoreBatch = Math.max(1, CFG.restoreBatchSize >> 1);
                } else {
                    effectiveRestoreBatch = CFG.restoreBatchSize;
                }
            };
            conn.addEventListener('change', upd); upd();
        }

        startFrameMonitor = () => requestAnimationFrame(frameMon);
    }

    // ═══════════════════════════════════════════════
    // §10. 탭 복귀 + SPA 전환 (★ v11.0: 모든 사이트 공통)
    // ═══════════════════════════════════════════════
    {
        const onResume = () => {
            queueMicrotask(() => {
                forceRestoreAll();
                void document.body?.offsetHeight; // 렌더링 파이프라인 강제 트리거
                setTimeout(() => forceRestoreAll(), 500);
            });
        };

        document.addEventListener('visibilitychange', () => { if (!document.hidden) onResume(); });

        const onNavigate = () => {
            gcPausedUntil = performance.now() + CFG.viewTransitionPauseMs;
            requestAnimationFrame(() => { forceRestoreAll(); purgeDisconnected(); });
        };

        if (hasNavigationAPI) {
            try { navigation.addEventListener('navigatesuccess', onNavigate); } catch {}
        }
        window.addEventListener('popstate', onNavigate);

        // ★ [v11.0] SPA URL 변경 감지 — 모든 사이트 공통
        let lastURL = location.href;
        const urlCheck = () => {
            if (location.href !== lastURL) {
                lastURL = location.href;
                gcPausedUntil = performance.now() + 1000;
                forceRestoreAll();
                purgeDisconnected();
            }
        };
        const origPushState = history.pushState;
        const origReplaceState = history.replaceState;
        history.pushState = function (...a) {
            origPushState.apply(this, a);
            requestAnimationFrame(urlCheck);
        };
        history.replaceState = function (...a) {
            origReplaceState.apply(this, a);
            requestAnimationFrame(urlCheck);
        };
    }

    // ═══════════════════════════════════════════════
    // §11. Shadow DOM 탐색
    // ═══════════════════════════════════════════════
    const observedShadows = new WeakSet();

    const processShadowRoot = (sr) => {
        if (observedShadows.has(sr)) return;
        observedShadows.add(sr);
        processSubtree(sr);
        new MutationObserver(handleMutations).observe(sr, { childList: true, subtree: true });
    };

    const checkShadow = (el) => {
        try { if (el.shadowRoot?.mode === 'open') processShadowRoot(el.shadowRoot); } catch {}
    };

    // ═══════════════════════════════════════════════
    // §12. DOM 처리 + MutationObserver
    // ═══════════════════════════════════════════════
    let batchScheduled = false;
    let batchTimerId = 0;
    const pendingNodes = [];
    const pendingGuard = new WeakSet();

    const processSubtree = (root) => {
        try {
            if (!root) return;
            const isEl = root.nodeType === 1;
            const isFrag = root.nodeType === 11;
            if (!isEl && !isFrag) return;

            if (isEl) {
                if (MEDIA_TAG_SET.has(root.tagName)) optimizeMedia(root);
                if (matchesSelectors(root)) trackNode(root);
                checkShadow(root);
            }

            const tracked = root.querySelectorAll(SELECTORS);
            for (let i = 0, n = tracked.length; i < n; i++) {
                trackNode(tracked[i]); checkShadow(tracked[i]);
            }
            const media = root.querySelectorAll('img,video,iframe,canvas');
            for (let i = 0, n = media.length; i < n; i++) optimizeMedia(media[i]);
        } catch {}
    };

    const cleanupSubtree = (root) => {
        try {
            if (!root || root.nodeType !== 1) return;
            if (trackedNodes.has(root)) untrackNode(root);
            const els = root.querySelectorAll(SELECTORS);
            if (els.length <= CFG.bulkCleanupThreshold) {
                for (let i = 0, n = els.length; i < n; i++)
                    if (trackedNodes.has(els[i])) untrackNode(els[i]);
            } else {
                const arr = Array.from(els);
                let idx = 0;
                const chunk = CFG.bulkCleanupThreshold;
                const processChunk = async () => {
                    const end = Math.min(idx + chunk, arr.length);
                    for (; idx < end; idx++)
                        if (trackedNodes.has(arr[idx])) untrackNode(arr[idx]);
                    if (idx < arr.length) {
                        await yieldToMain();
                        processChunk();
                    }
                };
                processChunk();
            }
        } catch {}
    };

    const flushBatch = () => {
        batchScheduled = false;
        batchTimerId = 0;
        const nodes = pendingNodes.splice(0);
        for (let i = 0; i < nodes.length; i++)
            if (nodes[i].nodeType === 1) processSubtree(nodes[i]);
        if (!isStreaming) gcFeed();
    };

    const scheduleBatch = () => {
        if (batchScheduled) return;
        batchScheduled = true;
        if (isInputActive()) {
            batchTimerId = setTimeout(flushBatch, CFG.inputActiveDebounceMs);
        } else if (isStreaming) {
            batchTimerId = setTimeout(flushBatch, CFG.mutationCoalesceMs);
        } else {
            requestAnimationFrame(flushBatch);
        }
    };

    const handleMutations = (mutations) => {
        let hasAdded = false;
        for (let i = 0; i < mutations.length; i++) {
            const { addedNodes, removedNodes } = mutations[i];
            for (let j = 0; j < addedNodes.length; j++) {
                const n = addedNodes[j];
                if (n.nodeType === 1 && !pendingGuard.has(n)) {
                    pendingGuard.add(n); pendingNodes.push(n); hasAdded = true;
                }
            }
            for (let j = 0; j < removedNodes.length; j++) {
                const n = removedNodes[j];
                if (n.nodeType === 1) { pendingGuard.delete(n); cleanupSubtree(n); }
            }
        }
        if (hasAdded) scheduleBatch();
    };

    const mutObserver = new MutationObserver(handleMutations);

    // ═══════════════════════════════════════════════
    // §13. 메모리 압박 감지
    // ═══════════════════════════════════════════════
    {
        const hasMemAPI = typeof performance.measureUserAgentSpecificMemory === 'function';
        if (hasMemAPI && typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
            const check = async () => {
                try {
                    const r = await performance.measureUserAgentSpecificMemory();
                    if (r.bytes > CFG.memoryThresholdBytes) {
                        if (!memoryPressure) {
                            memoryPressure = true;
                            effectiveLimitNodes = Math.min(effectiveLimitNodes, CFG.lowPowerLimitNodes);
                            gcFeed();
                        }
                    } else if (memoryPressure) {
                        memoryPressure = false;
                        effectiveLimitNodes = isLowPowerMode ? CFG.lowPowerLimitNodes : CFG.limitNodes;
                    }
                } catch {}
                setTimeout(check, CFG.memoryCheckInterval);
            };
            setTimeout(check, 10000);
        }
    }

    // ═══════════════════════════════════════════════
    // §14. 정기 GC + ViewTransition
    // ═══════════════════════════════════════════════
    const scheduleTask = hasSchedulerPostTask
        ? (fn, pri) => scheduler.postTask(fn, { priority: pri || 'background' }).catch(() => {})
        : hasRIC
            ? (fn) => requestIdleCallback((dl) => { if (dl.timeRemaining() > 5 || dl.didTimeout) fn(); }, { timeout: CFG.idleTimeout })
            : (fn) => setTimeout(fn, CFG.idleTimeout);

    let gcChainActive = false;
    const scheduleGC = () => {
        if (gcChainActive) return;
        gcChainActive = true;
        const tick = () => {
            if (document.hidden) { gcChainActive = false; return; }
            scheduleTask(() => { gcFeed(); purgeDisconnected(); tick(); });
        };
        tick();
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleGC(); });

    {
        const orig = document.startViewTransition;
        if (typeof orig === 'function') {
            document.startViewTransition = function (...a) {
                gcPausedUntil = performance.now() + CFG.viewTransitionPauseMs;
                return orig.apply(this, a);
            };
        }
    }

    let prefetchObserver = null;
    if (hasRIC) {
        prefetchObserver = new IntersectionObserver((entries) => {
            for (const { target, isIntersecting } of entries) {
                if (isIntersecting && target.tagName === 'IMG'
                    && !target.complete && typeof target.decode === 'function') {
                    requestIdleCallback(() => target.decode().catch(() => {}), { timeout: 2000 });
                    prefetchObserver.unobserve(target);
                }
            }
        }, { rootMargin: `1500px 0px 1500px 0px`, threshold: 0 });
    }

    // ═══════════════════════════════════════════════
    // §15. 진단 인터페이스
    // ═══════════════════════════════════════════════
    try {
        Object.defineProperty(window, '__turboOptimizer__', {
            configurable: false, enumerable: false,
            value: Object.freeze({
                stats() {
                    let hiddenCount = 0;
                    for (const el of trackedNodes) if (gcHiddenSet.has(el)) hiddenCount++;
                    const info = {
                        version: '11.0',
                        siteProfile: SITE_PROFILE?.id || 'generic',
                        isStreaming,
                        lowPowerMode: isLowPowerMode,
                        memoryPressure,
                        smoothedFPS: Math.round(currentSmoothedFPS * 10) / 10,
                        effectiveLimitNodes,
                        effectiveRestoreBatch,
                        trackedNodes: trackedNodes.size,
                        gcHiddenNodes: hiddenCount,
                        restoreQueueLength: restoreQueue.length,
                        mediaReclaimed: statsReclaimCount,
                        mediaRestored: statsRestoreCount,
                        throttledTimers: statsThrottledTimers,
                        network: navigator.connection
                            ? { effectiveType: navigator.connection.effectiveType, saveData: navigator.connection.saveData }
                            : 'unavailable',
                    };
                    console.table(info);
                    return info;
                },
                gc() { gcFeed(); return 'GC feed executed'; },
                emergencyRestore() {
                    let restored = 0;
                    for (const el of gcHiddenSet) {
                        gcHiddenSet.delete(el);
                        gcHiddenHeight.delete(el);
                        const orig = gcOriginalStyle.get(el);
                        gcOriginalStyle.delete(el);
                        el.style.cssText = orig || '';
                        restored++;
                    }
                    return `Emergency restored ${restored} nodes`;
                },
                forceRestore() { return `Force restored ${forceRestoreAll()} nodes`; },
                config: CFG,
            })
        });
    } catch {}

    // ═══════════════════════════════════════════════
    // §16. 초기화
    // ═══════════════════════════════════════════════
    const init = () => {
        try {
            // ★ [v11.0] 모든 사이트에서 초기 렌더링(Hydration) 보호 유예
            gcPausedUntil = performance.now() + CFG.hydrationGracePeriodMs;

            mutObserver.observe(document.body, { childList: true, subtree: true });
            processSubtree(document.body);
            gcFeed();
            scheduleGC();
            startFrameMonitor();
            forceFontDisplaySwap();
            new MutationObserver(() => forceFontDisplaySwap())
                .observe(document.head || document.documentElement, { childList: true, subtree: true });

            if (prefetchObserver) {
                const imgs = document.body.getElementsByTagName('img');
                for (let i = 0; i < imgs.length; i++) prefetchObserver.observe(imgs[i]);
            }

            console.log(
                `%c🚀 Turbo Optimizer v11.0 %c Active: ${location.hostname} [${SITE_PROFILE?.id || 'generic'}]`,
                'color:#00ffa3;font-weight:bold;background:#222;padding:3px 6px;border-radius:4px',
                'color:#fff'
            );
        } catch {}
    };

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else init();
})();
