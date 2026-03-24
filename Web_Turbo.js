// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      18.1
// @description  Lean web optimizer v18.1 – Font FOIT prevention, DNS auto-preconnect, LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, DRM-safe MSE stream protection, chat CSS guard, BFCache safe, scheduler.yield integration. Zero prototype hooks except FontFace.
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
  const V = '18.1';
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
  const TIER = NET.ect === '4g' && NET.dl >= 5 ? 't3'
             : NET.ect === '4g' || NET.ect === '3g' ? 't2' : 't1';
  const DEV_TIER = DEV_CORES >= 4 && DEV_MEM >= 4 ? 'high'
                 : DEV_CORES >= 2 && DEV_MEM >= 2 ? 'mid' : 'low';

  const CFG = {
    dnsHintMax       : 8,
    dnsPreconnMax    : 4,
    dnsFreqThreshold : 3,
    slowResMs        : 3000,
    lazyMarginPx     : 300,   /* below-fold 판정 마진 */
  };

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
      (doc.head || doc.documentElement).appendChild(streamStyle);
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
      (doc.head || doc.documentElement).appendChild(s);
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
  }
  const patchFontRules = () => {
    try {
      for (const ss of doc.styleSheets) {
        try { for (const r of ss.cssRules) {
          if (r instanceof CSSFontFaceRule) {
            const s = r.style;
            if (!s.fontDisplay || s.fontDisplay === 'auto') s.fontDisplay = FONT_DISPLAY;
          }
        }} catch (_) {}
      }
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §7  LCP Boost + Below‑fold Optimization (v18.1 신규)
   *
   *  web.dev 권장:
   *  - LCP 이미지: fetchpriority="high", loading="lazy" 제거
   *  - 비-LCP 하위 이미지: loading="lazy", decoding="async",
   *    fetchpriority="low"
   *  - iframe: loading="lazy"
   *  - 반응형 img: sizes 누락 보정
   *
   *  IO 기반이지만 스타일/레이아웃 변경 없음 (속성만 설정)
   *  → 리사이즈 딜레이 없음
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

  const boostLCP = () => {
    if (!lcpEl) return;
    if (lcpEl.tagName === 'IMG') {
      lcpEl.fetchPriority = 'high';
      /* web.dev: LCP 이미지에서 loading="lazy" 제거 (7% 사이트가 실수) */
      if (lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
      lcpEl.decoding = 'auto';
    }
  };

  /* Below‑fold 이미지/iframe 최적화 — IntersectionObserver */
  let belowFoldIO = null;
  const optimizeBelowFold = () => {
    /* 이미 observed 요소 추적 */
    const observed = new WeakSet();

    belowFoldIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const tag = el.tagName;

        if (tag === 'IMG') {
          /* LCP 이미지는 건드리지 않음 */
          if (el === lcpEl) { belowFoldIO.unobserve(el); continue; }

          if (!e.isIntersecting) {
            /* 화면 밖: lazy + async + low priority */
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
            if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';
            if (!el.fetchPriority || el.fetchPriority === 'high') el.fetchPriority = 'low';
          }
          /* 반응형 sizes 보정 */
          if (el.srcset && (!el.sizes || el.sizes === '')) el.sizes = 'auto';
        }

        if (tag === 'IFRAME') {
          if (!e.isIntersecting) {
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
          }
        }

        /* 한 번만 설정하면 되므로 unobserve */
        belowFoldIO.unobserve(el);
      }
    }, { rootMargin: `${CFG.lazyMarginPx}px` });

    /* 기존 요소 등록 */
    doc.querySelectorAll('img, iframe').forEach(el => {
      if (!observed.has(el)) { observed.add(el); belowFoldIO.observe(el); }
    });

    /* 새 요소 감지 (경량 MO — 1단계만, TreeWalker 없음) */
    const mo = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = node.tagName;
          if ((tag === 'IMG' || tag === 'IFRAME') && !observed.has(node)) {
            observed.add(node); belowFoldIO.observe(node);
          }
          /* 직계 자식만 체크 (TreeWalker 없음 — 성능 안전) */
          if (node.children) {
            for (const child of node.children) {
              const ct = child.tagName;
              if ((ct === 'IMG' || ct === 'IFRAME') && !observed.has(child)) {
                observed.add(child); belowFoldIO.observe(child);
              }
            }
          }
        }
      }
    });
    mo.observe(doc.documentElement || doc.body, { childList: true, subtree: true });
    return mo;
  };

  /* ═══════════════════════════════════════════════
   *  §8  DNS Prefetch / Preconnect Auto‑Promotion
   * ═══════════════════════════════════════════════ */
  const DnsHints = (() => {
    const seen = new Set(), linkMap = new Map(), freqMap = new Map();
    let hintCount = 0, preconnCount = 0;

    const add = origin => {
      if (!origin || seen.has(origin) || origin === location.origin || hintCount >= CFG.dnsHintMax) return;
      seen.add(origin);
      const l = doc.createElement('link'); l.rel = 'dns-prefetch'; l.href = origin;
      doc.head.appendChild(l); linkMap.set(origin, l); hintCount++;
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
          doc.head.appendChild(l); linkMap.set(origin, l); preconnCount++; hintCount++;
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
        });
        obs.observe({ type: 'resource', buffered: true });
      } catch (_) {}
    }

    return { stats: () => ({ hints: hintCount, preconnects: preconnCount, tracked: freqMap.size }) };
  })();

  /* ═══════════════════════════════════════════════
   *  §9  Data‑Saver Listener
   * ═══════════════════════════════════════════════ */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      NET.ect = conn.effectiveType || NET.ect;
      NET.dl  = conn.downlink ?? NET.dl;
      NET.rtt = conn.rtt ?? NET.rtt;
      NET.save = !!conn.saveData;
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
    /* unload 미사용 → BFCache 호환 보장 */
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
      patchFontRules();
      scanVideos();
      boostLCP();

      /* v18.1: Below-fold 최적화 */
      const mo = optimizeBelowFold();

      initVisibility();
      initNavigation();
      initDataSaver();

      /* 주기적 비디오 스캔 */
      setInterval(scanVideos, 10000);

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

      /* Boot log */
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
