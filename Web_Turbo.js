// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      18.2
// @description  Lean web optimizer v18.2 – Font FOIT prevention, DNS auto-preconnect, LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, DRM-safe MSE stream protection, chat CSS guard, BFCache safe, scheduler.yield integration. Zero prototype hooks except FontFace.
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
  const V = '18.2';
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

  /* [FIX-opt3] TIER를 동적 계산 가능하도록 let + 함수화 */
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
  };

  /* ═══════════════════════════════════════════════
   *  §0.5  Safe Head Append Helper
   *  [FIX-7] document-start 시점에서 head가 없을 수 있음
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

  /* doc.head가 생성되면 flush */
  if (doc.head) {
    headReady = true;
  } else {
    const headObs = new MutationObserver(() => {
      if (doc.head) { flushHeadQueue(); headObs.disconnect(); }
    });
    if (doc.documentElement) {
      headObs.observe(doc.documentElement, { childList: true });
    } else {
      /* documentElement조차 없는 극초기 — document 자체를 관찰 */
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
   * ═══════════════════════════════════════════════ */
  const CSP = (() => {
    let blocked = false;
    const stats = { violations: 0 };
    try {
      doc.addEventListener('securitypolicyviolation', () => {
        stats.violations++; blocked = true;
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
      /* [FIX-7] safe head append */
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
      /* [FIX-7] safe head append */
      appendToHead(s);
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §6  FontFace Override (FOIT 방지)
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = TIER === 't1' ? 'optional' : 'swap';
  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (f, src, desc = {}) {
      if (!desc.display) desc.display = FONT_DISPLAY;
      return new Orig(f, src, desc);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
    /* [FIX-5] name 프로퍼티 보존 */
    Object.defineProperty(win.FontFace, 'name', { value: 'FontFace', configurable: true });
  }

  const patchFontRules = () => {
    /* [FIX-opt4] CORS 스타일시트 명확한 스킵 */
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
   *  §7  LCP Boost + Below‑fold Optimization (v18.2)
   *
   *  web.dev 권장:
   *  - LCP 이미지: fetchpriority="high", loading="lazy" 제거
   *  - 비-LCP 하위 이미지: loading="lazy", decoding="async",
   *    fetchpriority="low"
   *  - iframe: loading="lazy"
   *  - 반응형 img: sizes 누락 보정 (lazy 한정)
   *
   *  [FIX-6] LCP 확정 후 IO 시작으로 race condition 제거
   *  [FIX-3] sizes="auto"는 loading="lazy" + srcset 조합만
   *  [FIX-4] boostLCP stale 참조 방지
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) lcpEl = last.element;
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
  }

  /* [FIX-4] DOM 연결 확인 + 로딩 상태 체크 */
  const boostLCP = () => {
    if (!lcpEl) return;
    if (!lcpEl.isConnected) { lcpEl = null; return; }
    if (lcpEl.tagName === 'IMG') {
      if (lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
      if (!lcpEl.complete) {
        lcpEl.fetchPriority = 'high';
        lcpEl.decoding = 'auto';
      }
    }
  };

  /* Below‑fold 이미지/iframe 최적화 — IntersectionObserver */
  let belowFoldIO = null;
  let belowFoldMO = null;

  const optimizeBelowFold = () => {
    const observed = new WeakSet();

    /* [FIX-1] rootMargin 명시적 4-value 형식 */
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

            /* [FIX-3] sizes="auto"는 lazy + srcset 조합에서만 유효 (스펙 준수) */
            if (el.srcset && el.loading === 'lazy' && (!el.sizes || el.sizes === '')) {
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

    /* [FIX-2] body만 감시 (img/iframe은 body 내에만 의미 있음) */
    /* [FIX-opt1] video 감지도 MO에 통합하여 setInterval 제거 */
    belowFoldMO = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = node.tagName;
          if (tag === 'IMG' || tag === 'IFRAME') observeEl(node);
          if (tag === 'VIDEO') checkVideo(node);
          if (node.children) {
            for (const child of node.children) {
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
   *  [FIX-opt5] DocumentFragment 배치 삽입
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
              track(new URL(e.name).origin);
              if (e.duration > CFG.slowResMs)
                console.warn(`[TO] Slow resource (${Math.round(e.duration)}ms): ${e.name.slice(0, 80)}`);
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
   *  §9  Data‑Saver Listener
   *  [FIX-opt3] TIER 재계산
   * ═══════════════════════════════════════════════ */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      NET.ect = conn.effectiveType || NET.ect;
      NET.dl  = conn.downlink ?? NET.dl;
      NET.rtt = conn.rtt ?? NET.rtt;
      NET.save = !!conn.saveData;
      TIER = getTier();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §10  Visibility & BFCache
   * ═══════════════════════════════════════════════ */
  const initVisibility = () => {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') scanVideos();
    });
    win.addEventListener('pageshow', e => {
      if (e.persisted) { scanVideos(); patchFontRules(); boostLCP(); }
    });
  };

  /* ═══════════════════════════════════════════════
   *  §11  SPA Navigation (listen only)
   * ═══════════════════════════════════════════════ */
  let navSupported = false;
  const initNavigation = () => {
    if (typeof navigation === 'undefined' || !navigation.addEventListener) return;
    navSupported = true;
    navigation.addEventListener('navigatesuccess', () => {
      scanVideos(); patchFontRules(); boostLCP();
    });
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

      /* [FIX-6] Below-fold 최적화를 LCP 확정 후로 지연 */
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

      /* [FIX-opt1] setInterval(scanVideos) 제거 — MO에 통합됨 */

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
        features: {
          viewTransition: typeof doc.startViewTransition === 'function',
          navigation: navSupported,
          mse: typeof MediaSource === 'function',
          schedulerYield: typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function',
        },
      };

      const f = win.__turboOptimizer__.features;
      const mode = isChat ? 'Chat' : isStreaming ? 'Stream' : 'Gen';
      console.log(
        `[TO v${V}] ✅ ${mode} ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ` +
        `${NET.ect}/${TIER} TT:${TT.name} ` +
        `MSE:${isStreaming ? '✓(prot)' : '–'} DNS:${DnsHints.stats().hints} ` +
        `Nav:${navSupported ? '✓' : '✗'} Yield:${f.schedulerYield ? '✓' : '✗'} ${HOST}`
      );
    };

    if (doc.readyState !== 'loading') onReady();
    else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
  };

  boot();
})();
