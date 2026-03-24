// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      18.0
// @description  Lean web optimizer v18 – Font-display FOIT prevention, DNS prefetch/preconnect auto-promotion, LCP fetchPriority boost, DRM-safe MSE stream protection, chat-site CSS guard, data-saver cleanup. Zero prototype hooks, zero layout interference.
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
  const V = '18.0';
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
  };

  /* ═══════════════════════════════════════════════
   *  §1  Trusted Types (named policy — collision 방지)
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
        stats.violations++;
        blocked = true;
      });
    } catch (_) {}
    return { isBlocked: () => blocked, stats };
  })();

  /* ═══════════════════════════════════════════════
   *  §3  MSE Streaming Detection (DRM‑safe, 프로토타입 미수정)
   * ═══════════════════════════════════════════════ */
  let isStreaming = false;
  let streamProtectStyle = null;

  const activateStreamProtection = () => {
    if (streamProtectStyle) return;
    isStreaming = true;
    try {
      streamProtectStyle = doc.createElement('style');
      streamProtectStyle.id = 'tb-stream-protect';
      streamProtectStyle.textContent = 'video,video *,:has(>video),:has(>video) *{content-visibility:visible!important;contain-intrinsic-size:none!important}';
      (doc.head || doc.documentElement).appendChild(streamProtectStyle);
    } catch (_) {}
  };

  /* 감지 A: PerformanceObserver resource timing */
  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const n = e.name || '';
          if (n.startsWith('blob:') || n.includes('.mpd') || n.includes('.m3u8') ||
              n.includes('/range/') || e.initiatorType === 'video') {
            activateStreamProtection();
            obs.disconnect();
            return;
          }
        }
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  /* 감지 B: video blob src 직접 스캔 */
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
   *  §4  Chat Site Profiles (CV/contain 적용 방지 전용)
   * ═══════════════════════════════════════════════ */
  const isChat = (() => {
    const hosts = new Set([
      'chatgpt.com','chat.openai.com','gemini.google.com','claude.ai',
      'genspark.ai','perplexity.ai','aistudio.google.com',
      'copilot.microsoft.com','grok.com','huggingface.co',
      'chat.deepseek.com','poe.com',
    ]);
    return hosts.has(HOST);
  })();

  /* ═══════════════════════════════════════════════
   *  §5  CSS Injection (경량 — chat 보호 + ViewTransition만)
   * ═══════════════════════════════════════════════ */
  const injectCSS = () => {
    try {
      const parts = [];

      /* ViewTransition 속도 */
      if (typeof doc.startViewTransition === 'function') {
        parts.push('::view-transition-old(*),::view-transition-new(*){animation-duration:.15s}');
      }

      /* Chat 사이트: 스트리밍 영역 보호 */
      if (isChat) {
        parts.push('[class*="streaming"],[class*="generating"],[class*="loading"],[class*="pending"]{content-visibility:visible!important}');
      }

      if (!parts.length) return;
      const style = doc.createElement('style');
      style.id = 'tb-css';
      style.textContent = parts.join('\n');
      (doc.head || doc.documentElement).appendChild(style);
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §6  FontFace Override (FOIT 방지 — 실측 효과 큼)
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = TIER === 't1' ? 'optional' : 'swap';

  /* 6-a: FontFace 생성자 래핑 */
  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (family, source, desc = {}) {
      if (!desc.display) desc.display = FONT_DISPLAY;
      return new Orig(family, source, desc);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
  }

  /* 6-b: 기존 @font-face 규칙 패치 */
  const patchFontRules = () => {
    try {
      for (const ss of doc.styleSheets) {
        try {
          for (const rule of ss.cssRules) {
            if (rule instanceof CSSFontFaceRule) {
              const s = rule.style;
              if (!s.fontDisplay || s.fontDisplay === 'auto') s.fontDisplay = FONT_DISPLAY;
            }
          }
        } catch (_) { /* cross-origin */ }
      }
    } catch (_) {}
  };

  /* ═══════════════════════════════════════════════
   *  §7  LCP fetchPriority Boost
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
    if (lcpEl && lcpEl.tagName === 'IMG') {
      lcpEl.fetchPriority = 'high';
      if (lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
    }
  };

  /* ═══════════════════════════════════════════════
   *  §8  DNS Prefetch / Preconnect Auto‑Promotion
   * ═══════════════════════════════════════════════ */
  const DnsHints = (() => {
    const seen = new Set();
    const linkMap = new Map();
    const freqMap = new Map();
    let hintCount = 0, preconnCount = 0;

    const add = origin => {
      if (!origin || seen.has(origin) || origin === location.origin) return;
      if (hintCount >= CFG.dnsHintMax) return;
      seen.add(origin);
      const link = doc.createElement('link');
      link.rel = 'dns-prefetch';
      link.href = origin;
      doc.head.appendChild(link);
      linkMap.set(origin, link);
      hintCount++;
    };

    const track = origin => {
      if (!origin || origin === location.origin) return;
      const c = (freqMap.get(origin) || 0) + 1;
      freqMap.set(origin, c);

      if (c >= CFG.dnsFreqThreshold && preconnCount < CFG.dnsPreconnMax) {
        const existing = linkMap.get(origin);
        if (existing && existing.rel === 'dns-prefetch') {
          existing.rel = 'preconnect';
          existing.crossOrigin = 'anonymous';
          preconnCount++;
        } else if (!seen.has(origin)) {
          seen.add(origin);
          const link = doc.createElement('link');
          link.rel = 'preconnect';
          link.href = origin;
          link.crossOrigin = 'anonymous';
          doc.head.appendChild(link);
          linkMap.set(origin, link);
          preconnCount++;
          hintCount++;
        }
      } else if (!seen.has(origin)) {
        add(origin);
      }
    };

    /* PerformanceObserver로 origin 빈도 추적 */
    if (typeof PerformanceObserver === 'function') {
      try {
        const obs = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            try {
              track(new URL(e.name).origin);
              if (e.duration > CFG.slowResMs) {
                console.warn(`[TO] Slow resource (${Math.round(e.duration)}ms): ${e.name.slice(0, 80)}`);
              }
            } catch (_) {}
          }
        });
        obs.observe({ type: 'resource', buffered: true });
      } catch (_) {}
    }

    return {
      stats: () => ({ hints: hintCount, preconnects: preconnCount, tracked: freqMap.size }),
    };
  })();

  /* ═══════════════════════════════════════════════
   *  §9  Data‑Saver Network Listener
   * ═══════════════════════════════════════════════ */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      NET.ect  = conn.effectiveType || NET.ect;
      NET.dl   = conn.downlink ?? NET.dl;
      NET.rtt  = conn.rtt ?? NET.rtt;
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
      if (e.persisted) { scanVideos(); patchFontRules(); }
    });
  };

  /* ═══════════════════════════════════════════════
   *  §11  SPA Navigation (listen only — intercept 안 함)
   * ═══════════════════════════════════════════════ */
  let navSupported = false;
  const initNavigation = () => {
    if (typeof navigation === 'undefined' || !navigation.addEventListener) return;
    navSupported = true;
    navigation.addEventListener('navigatesuccess', () => {
      scanVideos();
      patchFontRules();
      boostLCP();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §12  Boot
   * ═══════════════════════════════════════════════ */
  const boot = () => {
    /* Phase 1: document-start (CSS + font) */
    injectCSS();

    /* Phase 2: DOM ready */
    const onReady = () => {
      patchFontRules();
      scanVideos();
      boostLCP();
      initVisibility();
      initNavigation();
      initDataSaver();

      /* 주기적 비디오 스캔 (SPA 대응, 10초) */
      setInterval(scanVideos, 10000);

      /* Diagnostic API */
      win.__turboOptimizer__ = {
        version : V,
        device  : { cores: DEV_CORES, mem: DEV_MEM, tier: DEV_TIER, mobile: IS_MOBILE },
        network : NET,
        tier    : TIER,
        streaming : () => isStreaming,
        dns     : () => DnsHints.stats(),
        csp     : () => CSP.stats,
        lcp     : () => lcpEl?.tagName || null,
        trustedTypes : TT.name,
        chat    : isChat,
        nav     : navSupported,
        features: {
          viewTransition : typeof doc.startViewTransition === 'function',
          navigation     : navSupported,
          mse            : typeof MediaSource === 'function',
        },
      };

      /* Boot log */
      const mode = isChat ? 'Chat' : isStreaming ? 'Stream' : 'Gen';
      console.log(
        `[TO v${V}] ✅ ${mode} ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ` +
        `${NET.ect}/${TIER} TT:${TT.name} ` +
        `MSE:${isStreaming ? '✓(prot)' : '–'} DNS:${DnsHints.stats().hints} ` +
        `Nav:${navSupported ? '✓' : '✗'} ${HOST}`
      );
    };

    if (doc.readyState !== 'loading') onReady();
    else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
  };

  boot();
})();
