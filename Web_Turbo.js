// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      19.0
// @description  Lean web optimizer v19.0 – Font FOIT prevention, DNS auto-preconnect, LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, DRM-safe MSE stream protection, BFCache safe, Speculation Rules prefetch, popstate SPA fallback, background-tab grace period, auto chat-UI detection. Zero prototype hooks except FontFace.
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
  const V = '19.0';
  const doc = document;
  const win = window;
  const HOST = location.hostname;
  const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent || '');

  /* ═══════════════════════════════════════════════
   *  §0  Environment
   * ═══════════════════════════════════════════════ */
  const DEV_CORES = navigator.hardwareConcurrency || 4;
  const DEV_MEM   = navigator.deviceMemory ?? (IS_MOBILE ? 4 : 8);
  const conn      = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const NET = {
    ect : conn.effectiveType || '4g',
    dl  : conn.downlink      || 10,
    rtt : conn.rtt           || 50,
    save: !!conn.saveData,
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
    chatStructThreshold : 4,
    chatMutationWindow  : 2000,
    chatMutationThreshold: 60,
  };

  /* ═══════════════════════════════════════════════
   *  §0.5  Safe Head Append Helper
   * ═══════════════════════════════════════════════ */
  const pendingHeadEls = [];
  let headReady = !!doc.head;

  const appendToHead = (el) => {
    if (doc.head) doc.head.appendChild(el);
    else pendingHeadEls.push(el);
  };

  const flushHeadQueue = () => {
    if (headReady) return;
    headReady = true;
    if (!doc.head) return;
    for (const el of pendingHeadEls) doc.head.appendChild(el);
    pendingHeadEls.length = 0;
  };

  if (!headReady) {
    const target = doc.documentElement || doc;
    const headObs = new MutationObserver(() => {
      if (doc.head) { flushHeadQueue(); headObs.disconnect(); }
    });
    headObs.observe(target, { childList: true, subtree: !doc.documentElement });
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
    doc.addEventListener('securitypolicyviolation', (e) => {
      stats.violations++;
      const dir = e.violatedDirective || '';
      if (dir.startsWith('script-src') || dir.startsWith('default-src')) blocked = true;
    });
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
    streamStyle = doc.createElement('style');
    streamStyle.id = 'tb-stream';
    streamStyle.textContent = 'video,video *,:has(>video),:has(>video) *{content-visibility:visible!important;contain-intrinsic-size:none!important}';
    appendToHead(streamStyle);
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

  const checkVideo = (el) => {
    if (isStreaming || !el || el.tagName !== 'VIDEO') return;
    const src = el.src || el.currentSrc || '';
    if (src.startsWith('blob:') || el.srcObject) activateStreamProtection();
  };

  const scanVideos = () => {
    if (isStreaming) return;
    doc.querySelectorAll('video').forEach(checkVideo);
  };

  /* ═══════════════════════════════════════════════
   *  §4  Chat UI Auto-Detection
   *
   *  전략: Phase A(구조 점수)가 역치 이상이면
   *  즉시 보호 CSS를 적용하고, Phase B(변이 감시)를
   *  지속적으로 돌려서 오탐 시 해제한다.
   *
   *  ─ Phase A만 통과  → 선제 보호 ON
   *  ─ Phase B 확인    → 보호 확정, 감시 종료
   *  ─ Phase B 3회 실패 → 오탐 판정, 보호 해제
   * ═══════════════════════════════════════════════ */
  let isChat = false;
  let chatStyle = null;
  let chatDetectionDone = false;

  const CHAT_SELECTORS = [
    { s: '[data-message-id]',        w: 2 },
    { s: '[data-turn]',              w: 2 },
    { s: '[data-testid*="message"]', w: 2 },
    { s: '[role="log"]',             w: 2 },
    { s: '[class*="streaming"]',     w: 2 },
    { s: '[class*="generating"]',    w: 2 },
    { s: '[class*="conversation"]',  w: 1.5 },
    { s: '[class*="typing"]',        w: 1 },
    { s: '[class*="markdown"] [class*="message"]', w: 1.5 },
    { s: '[class*="prose"] [class*="message"]',    w: 1.5 },
    { s: '[contenteditable="true"]', w: 1 },
    { s: 'textarea',                 w: 0.5 },
  ];

  const calcStructScore = () => {
    let score = 0;
    for (const { s, w } of CHAT_SELECTORS) {
      if (doc.querySelector(s)) score += w;
    }
    return score;
  };

  const setChatProtection = (on) => {
    if (on && !chatStyle) {
      isChat = true;
      chatStyle = doc.createElement('style');
      chatStyle.id = 'tb-chat';
      chatStyle.textContent =
        '[class*="streaming"],[class*="generating"],[class*="loading"],[class*="pending"]' +
        '{content-visibility:visible!important}';
      appendToHead(chatStyle);
    } else if (!on && chatStyle) {
      isChat = false;
      chatStyle.remove();
      chatStyle = null;
    }
  };

  const runChatDetection = () => {
    const structScore = calcStructScore();
    if (structScore < CFG.chatStructThreshold) {
      chatDetectionDone = true;
      return;
    }

    /* Phase A 통과 → 선제 보호 */
    setChatProtection(true);

    /* Phase B — 지속 감시로 확정 또는 해제 */
    let attempts = 0;
    const maxAttempts = 3;

    const runPhaseB = () => {
      let count = 0;
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'characterData') count++;
          else if (m.type === 'childList') count += m.addedNodes.length;
        }
        if (count >= CFG.chatMutationThreshold) {
          mo.disconnect();
          chatDetectionDone = true;
          /* 확정 — 보호 유지 */
        }
      });
      mo.observe(doc.body, { childList: true, characterData: true, subtree: true });

      setTimeout(() => {
        mo.disconnect();
        if (chatDetectionDone) return;

        attempts++;
        if (count >= CFG.chatMutationThreshold) {
          chatDetectionDone = true;
          return;
        }
        if (attempts >= maxAttempts) {
          /* 오탐 판정 → 보호 해제 */
          setChatProtection(false);
          chatDetectionDone = true;
          return;
        }
        /* 재시도 — 사용자가 아직 질문을 안 했을 수 있음 */
        setTimeout(runPhaseB, 10000);
      }, CFG.chatMutationWindow);
    };

    runPhaseB();
  };

  /* ═══════════════════════════════════════════════
   *  §5  CSS (ViewTransition)
   * ═══════════════════════════════════════════════ */
  const injectCSS = () => {
    if (typeof doc.startViewTransition !== 'function') return;
    const s = doc.createElement('style');
    s.id = 'tb-css';
    s.textContent = '::view-transition-old(*),::view-transition-new(*){animation-duration:.15s}';
    appendToHead(s);
  };

  /* ═══════════════════════════════════════════════
   *  §6  FontFace Override (FOIT 방지)
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = TIER === 't1' ? 'optional' : 'swap';

  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (f, src, desc) {
      const d = Object.assign({}, desc);
      if (!d.display) d.display = FONT_DISPLAY;
      return new Orig(f, src, d);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
    Object.defineProperty(win.FontFace, 'name', { value: 'FontFace', configurable: true });
  }

  const patchFontRules = () => {
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
  };

  /* ═══════════════════════════════════════════════
   *  §7  LCP Boost + Below-fold Optimization
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) { lcpEl = last.element; boostLCP(); }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
  }

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

  const optimizeBelowFold = () => {
    const observed = new WeakSet();
    const margin = `${CFG.lazyMarginPx}px 0px ${CFG.lazyMarginPx}px 0px`;

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        const tag = el.tagName;
        io.unobserve(el);

        if (tag === 'IMG') {
          if (el === lcpEl || e.isIntersecting) continue;
          if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
          if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';
          if (!el.fetchPriority || el.fetchPriority === 'high') el.fetchPriority = 'low';
          if (el.srcset && el.loading === 'lazy' &&
              (!el.sizes || el.sizes === '') && /\d+w/.test(el.srcset)) {
            el.sizes = 'auto';
          }
        } else if (tag === 'IFRAME') {
          if (!e.isIntersecting && (!el.loading || el.loading === 'eager')) {
            el.loading = 'lazy';
          }
        }
      }
    }, { rootMargin: margin });

    const observeEl = (el) => {
      if (!observed.has(el)) { observed.add(el); io.observe(el); }
    };

    doc.querySelectorAll('img, iframe').forEach(observeEl);

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const tag = node.tagName;
          if (tag === 'IMG' || tag === 'IFRAME') observeEl(node);
          else if (tag === 'VIDEO') checkVideo(node);

          if (!node.querySelectorAll) continue;
          for (const child of node.querySelectorAll('img, iframe, video')) {
            const ct = child.tagName;
            if (ct === 'IMG' || ct === 'IFRAME') observeEl(child);
            else if (ct === 'VIDEO') checkVideo(child);
          }
        }
      }
    });
    mo.observe(doc.body, { childList: true, subtree: true });
  };

  /* ═══════════════════════════════════════════════
   *  §8  DNS Prefetch / Preconnect Auto-Promotion
   * ═══════════════════════════════════════════════ */
  const DnsHints = (() => {
    const seen = new Set();
    const linkMap = new Map();
    const freqMap = new Map();
    let hintCount = 0, preconnCount = 0;
    const pending = [];
    const origin = location.origin;

    const flush = () => {
      if (!pending.length || !doc.head) return;
      const frag = doc.createDocumentFragment();
      for (const l of pending) frag.appendChild(l);
      doc.head.appendChild(frag);
      pending.length = 0;
    };

    const addHint = (o, rel, crossOrigin) => {
      if (seen.has(o) || hintCount >= CFG.dnsHintMax) return;
      seen.add(o);
      const l = doc.createElement('link');
      l.rel = rel;
      l.href = o;
      if (crossOrigin) l.crossOrigin = 'anonymous';
      pending.push(l);
      linkMap.set(o, l);
      hintCount++;
      if (rel === 'preconnect') preconnCount++;
    };

    const track = (o) => {
      if (!o || o === origin) return;
      const c = (freqMap.get(o) || 0) + 1;
      freqMap.set(o, c);

      if (c >= CFG.dnsFreqThreshold && preconnCount < CFG.dnsPreconnMax) {
        const ex = linkMap.get(o);
        if (ex && ex.rel === 'dns-prefetch') {
          ex.rel = 'preconnect';
          ex.crossOrigin = 'anonymous';
          preconnCount++;
        } else if (!seen.has(o)) {
          addHint(o, 'preconnect', true);
        }
      } else if (!seen.has(o)) {
        addHint(o, 'dns-prefetch', false);
      }
    };

    if (typeof PerformanceObserver === 'function') {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const name = e.name || '';
            if (!name.startsWith('http')) continue;
            try { track(new URL(name).origin); } catch (_) {}
          }
          flush();
        });
        obs.observe({ type: 'resource', buffered: true });
      } catch (_) {}
    }

    return {
      flush,
      stats: () => ({ hints: hintCount, preconnects: preconnCount, tracked: freqMap.size }),
    };
  })();

  /* ═══════════════════════════════════════════════
   *  §8.5  Speculation Rules — Same-origin Prefetch
   * ═══════════════════════════════════════════════ */
  let speculationInjected = false;

  const injectSpeculationRules = () => {
    if (speculationInjected || isChat || NET.save || TIER === 't1') return;
    if (typeof HTMLScriptElement === 'undefined' ||
        typeof HTMLScriptElement.supports !== 'function' ||
        !HTMLScriptElement.supports('speculationrules')) return;
    if (CSP.isBlocked()) return;

    const rules = {
      prefetch: [{
        where: {
          and: [
            { href_matches: '/*' },
            { not: { href_matches: '/logout/*' } },
            { not: { href_matches: '/signout/*' } },
            { not: { href_matches: '/api/*' } },
            { not: { href_matches: '/*?*action=logout*' } },
            { not: { selector_matches: '[download],[href=""],[href^="#"],[href^="javascript:"]' } },
          ]
        },
        eagerness: 'moderate',
      }],
    };

    const s = doc.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify(rules);
    appendToHead(s);
    speculationInjected = true;
  };

  /* ═══════════════════════════════════════════════
   *  §9  Data-Saver Listener
   * ═══════════════════════════════════════════════ */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      const oldTier = TIER;
      NET.ect  = conn.effectiveType || NET.ect;
      NET.dl   = conn.downlink ?? NET.dl;
      NET.rtt  = conn.rtt ?? NET.rtt;
      NET.save = !!conn.saveData;
      TIER = getTier();
      if (oldTier === 't1' && TIER !== 't1') injectSpeculationRules();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §10  Visibility, BFCache & Background Tab
   * ═══════════════════════════════════════════════ */
  let hiddenSince = 0;

  const refresh = () => { scanVideos(); patchFontRules(); boostLCP(); };

  const initVisibility = () => {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        hiddenSince = performance.now();
        return;
      }
      const elapsed = hiddenSince ? performance.now() - hiddenSince : 0;
      hiddenSince = 0;

      if (elapsed >= CFG.gracePeriodMs) {
        refresh();
        DnsHints.flush();
      } else {
        scanVideos();
      }
    });

    win.addEventListener('pageshow', (e) => {
      if (e.persisted) refresh();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §11  SPA Navigation
   * ═══════════════════════════════════════════════ */
  let navSupported = false;

  const initNavigation = () => {
    if (typeof navigation !== 'undefined' && navigation?.addEventListener) {
      navSupported = true;
      navigation.addEventListener('navigatesuccess', refresh);
    }
    win.addEventListener('popstate', refresh);
  };

  /* ═══════════════════════════════════════════════
   *  §12  Boot
   * ═══════════════════════════════════════════════ */
  const boot = () => {
    injectCSS();

    const onReady = () => {
      flushHeadQueue();
      patchFontRules();
      scanVideos();
      boostLCP();
      DnsHints.flush();

      /* Chat 감지 (동기 Phase A → 비동기 Phase B) */
      runChatDetection();

      /* Speculation Rules — Chat 선제 보호와 독립적으로 판단 */
      injectSpeculationRules();

      const startBelowFold = () => { optimizeBelowFold(); };

      if ('requestIdleCallback' in win) {
        requestIdleCallback(startBelowFold, { timeout: 3000 });
      } else {
        setTimeout(startBelowFold, 1500);
      }

      initVisibility();
      initNavigation();
      initDataSaver();

      /* Diagnostic */
      win.__turboOptimizer__ = {
        version: V,
        device: { cores: DEV_CORES, mem: DEV_MEM, tier: DEV_TIER, mobile: IS_MOBILE },
        network: NET, tier: TIER,
        streaming: () => isStreaming,
        chat: () => isChat,
        dns: DnsHints.stats,
        csp: () => CSP.stats,
        lcp: () => lcpEl?.tagName || null,
        trustedTypes: TT.name,
        nav: navSupported,
        speculation: () => speculationInjected,
      };
    };

    if (doc.readyState !== 'loading') onReady();
    else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
  };

  boot();
})();
