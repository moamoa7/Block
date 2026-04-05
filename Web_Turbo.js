// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://github.com/moamoa7
// @version      25.0
// @description  Lean web optimizer v25 – Font FOIT prevention, LCP boost, below-fold lazy, iframe lazy. No chat DOM intervention.
// @match        *://*/*
// @exclude      *://www.google.com/maps/*
// @exclude      *://maps.google.com/*
// @exclude      *://www.figma.com/*
// @exclude      *://*.figma.com/*
// @exclude      *://excalidraw.com/*
// @exclude      *://*.unity.com/*
// @exclude      *://*.unity3d.com/*
// @exclude      *://www.photopea.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

'use strict';
(() => {
  const doc = document;
  const win = window;

  /* ═══════════════════════════════════════════════
   *  §0  Environment
   * ═══════════════════════════════════════════════ */
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const IS_SLOW = !!conn.saveData || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
  const LAZY_MARGIN = '300px 0px 300px 0px';

  /* ═══════════════════════════════════════════════
   *  §1  FontFace Override (FOIT 방지)
   *
   *  Known Limitation: patchFontRules()는 DOMContentLoaded 시
   *  1회만 실행됨. SPA에서 JS로 동적 삽입되는 <style>/<link>의
   *  @font-face는 패치되지 않음. 단, FontFace 생성자 패치가
   *  JS API를 통한 동적 폰트 로딩은 처리함.
   * ═══════════════════════════════════════════════ */
  const FONT_DISPLAY = IS_SLOW ? 'optional' : 'swap';

  if (typeof FontFace === 'function') {
    const Orig = FontFace;
    win.FontFace = function (f, src, desc) {
      const d = Object.assign({}, desc);
      if (!d.display || d.display === 'auto' || d.display === 'block') {
        d.display = FONT_DISPLAY;
      }
      return new Orig(f, src, d);
    };
    win.FontFace.prototype = Orig.prototype;
    Object.setPrototypeOf(win.FontFace, Orig);
    Object.defineProperty(win.FontFace, 'name', { value: 'FontFace', configurable: true });
  }

  const patchedSheets = new WeakSet();

  const patchRuleList = (rules) => {
    for (const r of rules) {
      if (r instanceof CSSFontFaceRule) {
        const s = r.style;
        if (!s.fontDisplay || s.fontDisplay === 'auto' || s.fontDisplay === 'block') {
          s.fontDisplay = FONT_DISPLAY;
        }
      } else if (r instanceof CSSImportRule) {
        try {
          if (r.styleSheet?.cssRules) patchRuleList(r.styleSheet.cssRules);
        } catch (_) { /* cross-origin @import */ }
      }
    }
  };

  const patchFontRules = () => {
    for (const ss of doc.styleSheets) {
      if (patchedSheets.has(ss)) continue;
      let rules;
      try { rules = ss.cssRules; } catch (_) { patchedSheets.add(ss); continue; }
      patchRuleList(rules);
      patchedSheets.add(ss);
    }
  };

  /* ═══════════════════════════════════════════════
   *  §2  LCP Boost + Below-fold Optimization
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;

  const lcpEls = new WeakSet();

  let lcpResolve;
  const lcpReady = new Promise(r => (lcpResolve = r));

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) {
          lcpEl = last.element;
          lcpEls.add(lcpEl);
          boostLCP();
        }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });

      const ac = new AbortController();

      const stopLCP = () => {
        obs.disconnect();
        lcpEl = null;
        lcpResolve();
        ac.abort();
      };

      for (const evt of ['click', 'keydown', 'scroll']) {
        win.addEventListener(evt, stopLCP, {
          signal: ac.signal,
          capture: true,
          passive: true,
        });
      }

      setTimeout(stopLCP, IS_SLOW ? 10000 : 5000);
    } catch (_) { lcpResolve(); }
  } else {
    lcpResolve();
  }

  function boostLCP() {
    if (!lcpEl?.isConnected) { lcpEl = null; return; }
    if (lcpEl.tagName === 'IMG') {
      if (lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
      if (lcpEl.fetchPriority === 'low') lcpEl.fetchPriority = 'high';
      if (lcpEl.decoding === 'async') lcpEl.decoding = 'auto';
    }
  }

  const optimizeBelowFold = () => {
    lcpReady.then(() => {
      if (!doc.body) return;

      const observed = new WeakSet();

      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          const tag = el.tagName;
          io.unobserve(el);

          if (tag === 'IMG') {
            if (lcpEls.has(el) || e.isIntersecting) continue;

            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
            if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';

            if (!el.fetchPriority || el.fetchPriority === 'auto' || el.fetchPriority === 'high') {
              el.fetchPriority = 'low';
            }

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

      let pending = [];
      let flushScheduled = false;

      const flushPending = () => {
        const batch = pending;
        pending = [];
        flushScheduled = false;

        for (const node of batch) {
          const tag = node.tagName;
          if (tag === 'IMG' || tag === 'IFRAME') { observeEl(node); continue; }
          if (node.querySelectorAll) {
            for (const child of node.querySelectorAll('img, iframe')) observeEl(child);
          }
        }
      };

      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) pending.push(node);
          }
        }
        if (pending.length && !flushScheduled) {
          flushScheduled = true;
          if ('requestIdleCallback' in win) {
            requestIdleCallback(flushPending, { timeout: 500 });
          } else {
            setTimeout(flushPending, 100);
          }
        }
      }).observe(doc.body, { childList: true, subtree: true });
    });
  };

  /* ═══════════════════════════════════════════════
   *  §3  Chat Memory Optimization – 완전 제거
   *
   *  content-visibility: auto는 동적 높이 요소
   *  (AI 채팅 스트리밍)에서 layout thrashing과
   *  scroll anchoring 충돌을 유발하므로 제거.
   * ═══════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════
   *  §4  Boot
   * ═══════════════════════════════════════════════ */
  const onReady = () => {
    patchFontRules();

    if ('requestIdleCallback' in win) {
      requestIdleCallback(optimizeBelowFold, { timeout: 2000 });
    } else {
      setTimeout(optimizeBelowFold, 2000);
    }
  };

  if (doc.readyState !== 'loading') onReady();
  else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
})();
