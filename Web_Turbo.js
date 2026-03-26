// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      20.1
// @description  Lean web optimizer v20.1 – Font FOIT prevention, LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, Speculation Rules prefetch, BFCache safe, SPA popstate fallback. Zero prototype hooks except FontFace.
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
  const V = '20.1';
  const doc = document;
  const win = window;

  /* ═══════════════════════════════════════════════
   *  §0  Environment
   * ═══════════════════════════════════════════════ */
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const IS_SLOW = !!conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';

  const LAZY_MARGIN = '300px 0px 300px 0px';
  const GRACE_MS = 30000;
  const IDLE_TIMEOUT = 2000;

  /* ═══════════════════════════════════════════════
   *  §1  FontFace Override (FOIT 방지)
   *
   *  - 'auto'도 패치 대상으로 통일
   *  - patchFontRules: 처리 완료 시트를 WeakSet으로
   *    기억하여 SPA 전환 시 중복 순회 방지
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = IS_SLOW ? 'optional' : 'swap';

  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (f, src, desc) {
      const d = Object.assign({}, desc);
      if (!d.display || d.display === 'auto') d.display = FONT_DISPLAY;
      return new Orig(f, src, d);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
    Object.defineProperty(win.FontFace, 'name', { value: 'FontFace', configurable: true });
  }

  const patchedSheets = new WeakSet();

  const patchFontRules = () => {
    for (const ss of doc.styleSheets) {
      if (patchedSheets.has(ss)) continue;
      let rules;
      try { rules = ss.cssRules; } catch (_) { patchedSheets.add(ss); continue; }
      for (const r of rules) {
        if (r instanceof CSSFontFaceRule) {
          const s = r.style;
          if (!s.fontDisplay || s.fontDisplay === 'auto') s.fontDisplay = FONT_DISPLAY;
        }
      }
      patchedSheets.add(ss);
    }
  };

  /* ═══════════════════════════════════════════════
   *  §2  LCP Boost + Below-fold Optimization
   *
   *  수정사항:
   *  - LCP observer: 확정 후 disconnect
   *  - lcpReady Promise로 below-fold와 타이밍 동기화
   *  - onReady에서 중복 boostLCP() 호출 제거
   *  - MutationObserver: rAF 배치 처리
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;
  let lcpResolve;
  const lcpReady = new Promise((r) => { lcpResolve = r; });

  /* LCP 확정 시점: 첫 사용자 인터랙션 시 observer disconnect */
  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) { lcpEl = last.element; boostLCP(); }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });

      const stopLCP = () => {
        obs.disconnect();
        lcpResolve();
        for (const evt of ['click', 'keydown', 'scroll']) {
          win.removeEventListener(evt, stopLCP, { capture: true });
        }
      };
      for (const evt of ['click', 'keydown', 'scroll']) {
        win.addEventListener(evt, stopLCP, { capture: true, once: true, passive: true });
      }

      /* 안전망: 10초 후 강제 종료 */
      setTimeout(stopLCP, 10000);
    } catch (_) { lcpResolve(); }
  } else {
    lcpResolve();
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
    /* lcpReady 이후 실행하여 LCP 요소를 lazy로 잘못 설정하는 경합 방지 */
    lcpReady.then(() => {
      const observed = new WeakSet();

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
      }, { rootMargin: LAZY_MARGIN });

      const observeEl = (el) => {
        if (!observed.has(el)) { observed.add(el); io.observe(el); }
      };

      doc.querySelectorAll('img, iframe').forEach(observeEl);

      /* MutationObserver — rAF 배치 처리 */
      let pending = [];
      let rafScheduled = false;

      const flushPending = () => {
        for (const node of pending) {
          const tag = node.tagName;
          if (tag === 'IMG' || tag === 'IFRAME') { observeEl(node); continue; }
          if (node.querySelectorAll) {
            for (const child of node.querySelectorAll('img, iframe')) observeEl(child);
          }
        }
        pending = [];
        rafScheduled = false;
      };

      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) pending.push(node);
          }
        }
        if (pending.length && !rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushPending);
        }
      }).observe(doc.body, { childList: true, subtree: true });
    });
  };

  /* ═══════════════════════════════════════════════
   *  §3  Speculation Rules — Same-origin Prefetch
   * ═══════════════════════════════════════════════ */
  let speculationInjected = false;

  const injectSpeculationRules = () => {
    if (speculationInjected || IS_SLOW) return;
    if (typeof HTMLScriptElement === 'undefined' ||
        typeof HTMLScriptElement.supports !== 'function' ||
        !HTMLScriptElement.supports('speculationrules')) return;

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
    doc.head.appendChild(s);
    speculationInjected = true;
  };

  /* ═══════════════════════════════════════════════
   *  §4  Visibility, BFCache & Background Tab
   * ═══════════════════════════════════════════════ */
  let hiddenSince = 0;

  const initVisibility = () => {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        hiddenSince = performance.now();
        return;
      }
      const elapsed = hiddenSince ? performance.now() - hiddenSince : 0;
      hiddenSince = 0;
      if (elapsed >= GRACE_MS) patchFontRules();
    });

    win.addEventListener('pageshow', (e) => {
      if (e.persisted) patchFontRules();
    });
  };

  /* ═══════════════════════════════════════════════
   *  §5  SPA Navigation
   * ═══════════════════════════════════════════════ */
  const initNavigation = () => {
    const onNav = () => patchFontRules();
    if (typeof navigation !== 'undefined' && navigation?.addEventListener) {
      navigation.addEventListener('navigatesuccess', onNav);
    }
    win.addEventListener('popstate', onNav);
  };

  /* ═══════════════════════════════════════════════
   *  §6  Boot
   * ═══════════════════════════════════════════════ */
  const onReady = () => {
    patchFontRules();
    injectSpeculationRules();

    if ('requestIdleCallback' in win) {
      requestIdleCallback(optimizeBelowFold, { timeout: IDLE_TIMEOUT });
    } else {
      setTimeout(optimizeBelowFold, IDLE_TIMEOUT);
    }

    initVisibility();
    initNavigation();

    win.__turboOptimizer__ = {
      version: V,
      slow: IS_SLOW,
      lcp: () => lcpEl?.tagName || null,
      speculation: () => speculationInjected,
    };
  };

  if (doc.readyState !== 'loading') onReady();
  else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
})();
