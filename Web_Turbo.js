// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      18.5
// @description  Lean web optimizer v18.5 – Font FOIT prevention, DNS auto-preconnect, LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, DRM-safe MSE stream protection, chat CSS guard, BFCache safe, scheduler.yield integration, Speculation Rules prefetch, popstate SPA fallback, background-tab grace period. Zero prototype hooks except FontFace.
// @match        *://*/*
// @exclude      *://www.google.com/maps/*
// @exclude      *://www.figma.com/*
// @exclude      *://excalidraw.com/*
// @exclude      *://*.unity.com/*
// @exclude      *://*.unity3d.com/*
// @exclude      *://www.photopea.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

'use strict';
(() => {
  const V = '18.5';
  const doc = document;
  const win = window;
  const HOST = location.hostname;
  const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent || '');

  /* ═══════════════════════════════════════════════
   *  §0  Environment
   * ═══════════════════════════════════════════════ */
  const DEV_CORES = navigator.hardwareConcurrency || 4;
  const DEV_MEM   = (navigator.deviceMemory ?? (IS_MOBILE ? 4 : 8));
  const conn      = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const NET = {
    ect : conn.effectiveType || '4g',
    dl  : conn.downlink      || 10,
    rtt : conn.rtt           || 50,
    save: !!(conn.saveData),
  };

  const getTier = () =>
    NET.ect === '4g' && NET.dl >= 5 ? 't3'
    : NET.ect === '4g' || NET.ect === '3g' ? 't2' : 't1';
  let TIER = getTier();

  const DEV_TIER = DEV_CORES >= 4 && DEV_MEM >= 4 ? 'high'
                 : DEV_CORES >= 2 && DEV_MEM >= 2 ? 'mid' : 'low';

  const CFG = {
    dnsHintMax       : 8,
    dnsPreconnMax    : 4,
    dnsFreqThreshold : 3,
    slowResMs        : 3000,
    lazyMarginPx     : 300,
    gracePeriodMs    : 30000,
  };

  /* ═══════════════════════════════════════════════
   *  §0.5  Safe Head Append Helper
   * ═══════════════════════════════════════════════ */
  const pendingHeadEls = [];
  let headReady = false;

  const appendToHead = (el) => {
    if (doc.head) {
      doc.head.appendChild(el);
    } else {
      pendingHeadEls.push(el);
    }
  };

  const flushHeadQueue = () => {
    if (headReady) return;
    headReady = true;
    for (const el of pendingHeadEls) {
      if (doc.head) doc.head.appendChild(el);
    }
    pendingHeadEls.length = 0;
  };

  if (doc.head) {
    headReady = true;
  } else {
    const headObs = new MutationObserver(() => {
      if (doc.head) { flushHeadQueue(); headObs.disconnect(); }
    });
    if (doc.documentElement) {
      headObs.observe(doc.documentElement, { childList: true });
    } else {
      headObs.observe(doc, { childList: true, subtree: true });
    }
  }

  /* ═══════════════════════════════════════════════
   *  §1  Trusted Types (named policy)
   * ═══════════════════════════════════════════════ */
  const TT = (() => {
    if (typeof trustedTypes === 'undefined') return { p: null, name: 'none' };
    try {
      const existing = trustedTypes.defaultPolicy;
      if (existing) return { p: existing, name: 'default(existing)' };
    } catch (_) {}
    try {
      const p = trustedTypes.createPolicy('turbo-optimizer', {
        createHTML: s => s, createScript: s => s, createScriptURL: s => s,
      });
      return { p, name: 'named' };
    } catch (_) { return { p: null, name: 'failed' }; }
  })();

  /* ═══════════════════════════════════════════════
   *  §2  CSP Monitor
   *  [PATCH-14] directive별 필터링 — script-src/default-src
   *  위반만 blocked 처리. img-src 등 무관한 위반으로
   *  Speculation Rules 삽입이 차단되는 오탐 방지.
   * ═══════════════════════════════════════════════ */
  const CSP = (() => {
    let blocked = false;
    const stats = { violations: 0 };
    try {
      doc.addEventListener('securitypolicyviolation', (e) => {
        stats.violations++;
        const dir = e.violatedDirective || '';
        if (dir.startsWith('script-src') || dir.startsWith('default-src')) {
          blocked = true;
        }
      });
    } catch (_) {}
    return { isBlocked: () => blocked, stats };
  })();

  /* ═══════════════════════════════════════════════
   *  §3  MSE Streaming Detection (DRM‑safe)
   * ═══════════════════════════════════════════════ */
  let isStreaming = false;
  let streamStyle = null;

  const activateStreamProtection = () => {
    if (streamStyle) return;
    isStreaming = true;
    try {
      streamStyle = doc.createElement('style');
      streamStyle.id = 'tb-stream';
      streamStyle.textContent = 'video,video *,:has(>video),:has(>video) *{content-visibility:visible!important;contain-intrinsic-size:none!important}';
      appendToHead(streamStyle);
    } catch (_) {}
  };

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const n = e.name || '';
          if (n.startsWith('blob:') || n.includes('.mpd') || n.includes('.m3u8') ||
              n.includes('/range/') || e.initiatorType === 'video') {
            activateStreamProtection(); obs.disconnect(); return;
          }
        }
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  const checkVideo = el => {
    if (isStreaming || !el || el.tagName !== 'VIDEO') return;
    const src = el.src || el.currentSrc || '';
    if (src.startsWith('blob:') || el.srcObject) activateStreamProtection();
  };
  const scanVideos = () => {
    if (isStreaming) return;
    try { doc.querySelectorAll('video').forEach(checkVideo); } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §4  Chat Site Detection
   * ═══════════════════════════════════════════════ */
  const isChat = new Set([
    'chatgpt.com','chat.openai.com','gemini.google.com','claude.ai',
    'genspark.ai','perplexity.ai','aistudio.google.com',
    'copilot.microsoft.com','grok.com','huggingface.co',
    'chat.deepseek.com','poe.com',
  ]).has(HOST);

  /* ═══════════════════════════════════════════════
   *  §5  CSS (ViewTransition + Chat 보호)
   * ═══════════════════════════════════════════════ */
  const injectCSS = () => {
    try {
      const parts = [];
      if (typeof doc.startViewTransition === 'function') {
        parts.push('::view-transition-old(*),::view-transition-new(*){animation-duration:.15s}');
      }
      if (isChat) {
        parts.push('[class*="streaming"],[class*="generating"],[class*="loading"],[class*="pending"]{content-visibility:visible!important}');
      }
      if (!parts.length) return;
      const s = doc.createElement('style'); s.id = 'tb-css';
      s.textContent = parts.join('\n');
      appendToHead(s);
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §6  FontFace Override (FOIT 방지)
   *  [PATCH-1] desc 객체 방어적 복사 — 호출자의 원본
   *  descriptor 객체가 변이(mutate)되는 것을 방지.
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = TIER === 't1' ? 'optional' : 'swap';
  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (f, src, desc = {}) {
      const d = Object.assign({}, desc);
      if (!d.display) d.display = FONT_DISPLAY;
      return new Orig(f, src, d);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
    Object.defineProperty(win.FontFace, 'name', { value: 'FontFace', configurable: true });
  }

  const patchFontRules = () => {
    try {
      for (const ss of doc.styleSheets) {
        let rules;
        try { rules = ss.cssRules; } catch (_) { continue; }
        for (const r of rules) {
          if (r instanceof CSSFontFaceRule) {
            const s = r.style;
            if (!s.fontDisplay || s.fontDisplay === 'auto') s.fontDisplay = FONT_DISPLAY;
          }
        }
      }
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §7  LCP Boost + Below‑fold Optimization
   *
   *  [PATCH-2] PerformanceObserver 콜백 내에서도
   *  boostLCP() 호출 — DOMContentLoaded보다 LCP 엔트리가
   *  늦게 도착하는 느린 페이지 커버.
   *
   *  [PATCH-5] sizes="auto"는 width descriptor(`w`)가 있는
   *  srcset에서만 적용 — 미지원 브라우저 100vw 폴백 시
   *  불필요한 과대 이미지 방지.
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) {
          lcpEl = last.element;
          /* [PATCH-2] LCP 업데이트 시 즉시 boost */
          boostLCP();
        }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
  }

  /* boostLCP를 hoisting 가능하도록 function 선언 사용 */
  function boostLCP() {
    if (!lcpEl) return;
    if (!lcpEl.isConnected) { lcpEl = null; return; }
    if (lcpEl.tagName === 'IMG') {
      if (lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
      if (!lcpEl.complete) {
        lcpEl.fetchPriority = 'high';
        lcpEl.decoding = 'auto';
      }
    }
  }

  /* Below‑fold 이미지/iframe 최적화 — IntersectionObserver */
  let belowFoldIO = null;
  let belowFoldMO = null;

  const optimizeBelowFold = () => {
    const observed = new WeakSet();

    belowFoldIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const tag = el.tagName;

        if (tag === 'IMG') {
          if (el === lcpEl) { belowFoldIO.unobserve(el); continue; }

          if (!e.isIntersecting) {
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
            if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';
            if (!el.fetchPriority || el.fetchPriority === 'high') el.fetchPriority = 'low';

            /* [PATCH-5] sizes="auto"는 lazy + width descriptor srcset에서만 */
            if (el.srcset && el.loading === 'lazy' &&
                (!el.sizes || el.sizes === '') &&
                /\d+w/.test(el.srcset)) {
              el.sizes = 'auto';
            }
          }

          belowFoldIO.unobserve(el);
        }

        if (tag === 'IFRAME') {
          if (!e.isIntersecting) {
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
          }
          belowFoldIO.unobserve(el);
        }
      }
    }, { rootMargin: `${CFG.lazyMarginPx}px 0px ${CFG.lazyMarginPx}px 0px` });

    const observeEl = (el) => {
      if (!observed.has(el)) { observed.add(el); belowFoldIO.observe(el); }
    };

    /* 기존 요소 등록 */
    doc.querySelectorAll('img, iframe').forEach(observeEl);

    /* [PATCH-9] MutationObserver — 깊은 자식 탐색
     * subtree:true이어도 addedNodes에는 직접 삽입된 최상위
     * 노드만 포함. innerHTML 등으로 삽입된 중첩 img/iframe/video는
     * querySelectorAll로 탐색해야 함. */
    belowFoldMO = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = node.tagName;
          /* 노드 자신 확인 */
          if (tag === 'IMG' || tag === 'IFRAME') observeEl(node);
          if (tag === 'VIDEO') checkVideo(node);
          /* 깊은 자식 탐색 */
          if (node.querySelectorAll) {
            const imgs = node.querySelectorAll('img, iframe, video');
            for (const child of imgs) {
              const ct = child.tagName;
              if (ct === 'IMG' || ct === 'IFRAME') observeEl(child);
              if (ct === 'VIDEO') checkVideo(child);
            }
          }
        }
      }
    });
    belowFoldMO.observe(doc.body, { childList: true, subtree: true });

    return belowFoldMO;
  };

  /* ═══════════════════════════════════════════════
   *  §8  DNS Prefetch / Preconnect Auto‑Promotion
   * ═══════════════════════════════════════════════ */
  const DnsHints = (() => {
    const seen = new Set(), linkMap = new Map(), freqMap = new Map();
    let hintCount = 0, preconnCount = 0;
    const pending = [];

    const flushPending = () => {
      if (!pending.length || !doc.head) return;
      const frag = doc.createDocumentFragment();
      for (const l of pending) frag.appendChild(l);
      doc.head.appendChild(frag);
      pending.length = 0;
    };

    const add = origin => {
      if (!origin || seen.has(origin) || origin === location.origin || hintCount >= CFG.dnsHintMax) return;
      seen.add(origin);
      const l = doc.createElement('link'); l.rel = 'dns-prefetch'; l.href = origin;
      pending.push(l); linkMap.set(origin, l); hintCount++;
    };
    const track = origin => {
      if (!origin || origin === location.origin) return;
      const c = (freqMap.get(origin) || 0) + 1; freqMap.set(origin, c);
      if (c >= CFG.dnsFreqThreshold && preconnCount < CFG.dnsPreconnMax) {
        const ex = linkMap.get(origin);
        if (ex && ex.rel === 'dns-prefetch') { ex.rel = 'preconnect'; ex.crossOrigin = 'anonymous'; preconnCount++; }
        else if (!seen.has(origin)) {
          seen.add(origin);
          const l = doc.createElement('link'); l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
          pending.push(l); linkMap.set(origin, l); preconnCount++; hintCount++;
        }
      } else if (!seen.has(origin)) add(origin);
    };

    if (typeof PerformanceObserver === 'function') {
      try {
        const obs = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            try {
              const name = e.name || '';
              if (!name.startsWith('http')) continue;
              track(new URL(name).origin);
              if (e.duration > CFG.slowResMs)
                console.warn(`[TO] Slow resource (${Math.round(e.duration)}ms): ${name.slice(0, 80)}`);
            } catch (_) {}
          }
          flushPending();
        });
        obs.observe({ type: 'resource', buffered: true });
      } catch (_) {}
    }

    return { flush: flushPending, stats: () => ({ hints: hintCount, preconnects: preconnCount, tracked: freqMap.size }) };
  })();

  /* ═══════════════════════════════════════════════
   *  §8.5  Speculation Rules — Same-origin Prefetch
   *
   *  [PATCH-6] href_matches 빈 문자열 → selector_matches로
   *  빈 href, hash-only, javascript: 링크를 명확히 제외.
   * ═══════════════════════════════════════════════ */
  let speculationInjected = false;

  const injectSpeculationRules = () => {
    if (speculationInjected) return;
    if (isChat) return;
    if (NET.save) return;
    if (TIER === 't1') return;

    if (typeof HTMLScriptElement === 'undefined' ||
        typeof HTMLScriptElement.supports !== 'function' ||
        !HTMLScriptElement.supports('speculationrules')) return;

    if (CSP.isBlocked()) return;

    try {
      const rules = {
        prefetch: [{
          where: {
            and: [
              { href_matches: '/*' },
              { not: { href_matches: '/logout/*' } },
              { not: { href_matches: '/signout/*' } },
              { not: { href_matches: '/api/*' } },
              { not: { href_matches: '/*?*action=logout*' } },
              { not: { selector_matches: '[download], [href=""], [href^="#"], [href^="javascript:"]' } },
            ]
          },
          eagerness: 'moderate'
        }]
      };

      const s = doc.createElement('script');
      s.type = 'speculationrules';
      s.textContent = JSON.stringify(rules);
      appendToHead(s);

      speculationInjected = true;
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §9  Data‑Saver Listener
   *  [PATCH-10] TIER 변경 시 Speculation Rules 재주입
   * ═══════════════════════════════════════════════ */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      const oldTier = TIER;
      NET.ect = conn.effectiveType || NET.ect;
      NET.dl  = conn.downlink ?? NET.dl;
      NET.rtt = conn.rtt ?? NET.rtt;
      NET.save = !!conn.saveData;
      TIER = getTier();
      /* 네트워크 개선 시 Speculation Rules 재시도 */
      if (oldTier === 't1' && TIER !== 't1') injectSpeculationRules();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §10  Visibility, BFCache & Background Tab
   *        Grace Period
   *
   *  [v18.5] 탭이 CFG.gracePeriodMs(30s) 이상 숨겨진 뒤
   *  복귀하면 전체 상태를 재초기화한다.
   *  프로토타입 훅 없이 비활성 탭 복귀 시나리오를 견고하게 처리.
   * ═══════════════════════════════════════════════ */
  let hiddenSince = 0;

  const initVisibility = () => {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        hiddenSince = performance.now();
      } else {
        /* 탭이 다시 보이게 됨 */
        const elapsed = hiddenSince ? performance.now() - hiddenSince : 0;
        hiddenSince = 0;

        if (elapsed >= CFG.gracePeriodMs) {
          /* 장시간 백그라운드 → 전체 재초기화 */
          scanVideos();
          patchFontRules();
          boostLCP();
          DnsHints.flush();
        } else {
          /* 짧은 전환 → 기존 최소 동작 */
          scanVideos();
        }
      }
    });

    win.addEventListener('pageshow', e => {
      if (e.persisted) { scanVideos(); patchFontRules(); boostLCP(); }
    });
  };

  /* ═══════════════════════════════════════════════
   *  §11  SPA Navigation (listen only)
   *  [PATCH-8] navigation optional chaining — null 방어
   *
   *  [v18.5] popstate 폴백 추가 — Navigation API 미지원
   *  브라우저에서 뒤로가기/앞으로가기 시에도 상태 갱신.
   * ═══════════════════════════════════════════════ */
  let navSupported = false;

  const initNavigation = () => {
    const onNav = () => {
      scanVideos();
      patchFontRules();
      boostLCP();
    };

    /* Navigation API (modern browsers) */
    if (typeof navigation !== 'undefined' && navigation?.addEventListener) {
      navSupported = true;
      navigation.addEventListener('navigatesuccess', onNav);
    }

    /* popstate 폴백 — Navigation API 유무와 무관하게 항상 등록.
     * history.back()/forward(), hash 변경 등을 커버.
     * Navigation API와 중복 발생해도 각 함수가 멱등(idempotent)이므로 안전. */
    win.addEventListener('popstate', onNav);
  };

  /* ═══════════════════════════════════════════════
   *  §12  Boot
   * ═══════════════════════════════════════════════ */
  const boot = () => {
    /* Phase 1: document-start */
    injectCSS();

    /* Phase 2: DOM ready */
    const onReady = () => {
      flushHeadQueue();
      patchFontRules();
      scanVideos();
      boostLCP();

      injectSpeculationRules();

      const startBelowFold = () => {
        optimizeBelowFold();
        DnsHints.flush();
      };

      if ('requestIdleCallback' in win) {
        requestIdleCallback(startBelowFold, { timeout: 3000 });
      } else {
        setTimeout(startBelowFold, 1500);
      }

      initVisibility();
      initNavigation();
      initDataSaver();

      /* Diagnostic API */
      win.__turboOptimizer__ = {
        version: V,
        device: { cores: DEV_CORES, mem: DEV_MEM, tier: DEV_TIER, mobile: IS_MOBILE },
        network: NET, tier: TIER,
        streaming: () => isStreaming,
        dns: () => DnsHints.stats(),
        csp: () => CSP.stats,
        lcp: () => lcpEl?.tagName || null,
        trustedTypes: TT.name,
        chat: isChat,
        nav: navSupported,
        speculation: speculationInjected,
        features: {
          viewTransition: typeof doc.startViewTransition === 'function',
          navigation: navSupported,
          mse: typeof MediaSource === 'function',
          schedulerYield: typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function',
          speculationRules: speculationInjected,
        },
      };

      const f = win.__turboOptimizer__.features;
      const mode = isChat ? 'Chat' : isStreaming ? 'Stream' : 'Gen';
      console.log(
        `[TO v${V}] ✅ ${mode} ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ` +
        `${NET.ect}/${TIER} TT:${TT.name} ` +
        `MSE:${isStreaming ? '✓(prot)' : '–'} DNS:${DnsHints.stats().hints} ` +
        `Nav:${navSupported ? '✓' : '✗'} Yield:${f.schedulerYield ? '✓' : '✗'} ` +
        `Spec:${speculationInjected ? '✓' : '✗'} ${HOST}`
      );
    };

    if (doc.readyState !== 'loading') onReady();
    else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
  };

  boot();
})();
