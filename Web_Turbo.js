// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://github.com/moamoa7
// @version      22.1
// @description  Lean web optimizer v22.1 – Font FOIT prevention (swap/optional), LCP boost + lazy removal, below-fold img lazy/async/low-priority, iframe lazy, responsive sizes fix, AI chat memory optimization. Zero prototype hooks except FontFace.
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
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;
  const lcpEls = new Set();                           // [Fix 5] 모든 LCP 후보 누적 보관
  let lcpResolve;
  const lcpReady = new Promise(r => (lcpResolve = r)); // [Fix 7] Promise 간소화

  if (typeof PerformanceObserver === 'function') {
    try {
      const obs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last?.element) {
          lcpEl = last.element;
          lcpEls.add(lcpEl);                          // [Fix 5] Set에 누적
          boostLCP();
        }
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
    lcpReady.then(() => {
      const observed = new WeakSet();

      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          const tag = el.tagName;
          io.unobserve(el);

          if (tag === 'IMG') {
            if (lcpEls.has(el) || e.isIntersecting) continue;  // [Fix 5] Set으로 보호
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
            if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';
            if (!el.fetchPriority || el.fetchPriority === 'auto' || el.fetchPriority === 'high') // [Fix 1] 'auto' 추가
              el.fetchPriority = 'low';
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
      let rafScheduled = false;
      let chatCheckScheduled = false;                // [Fix 3] rAF 디바운스용 플래그

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
        // [Fix 3] rAF 디바운스로 호출 빈도 제한
        if (!chatStyleInjected && !chatCheckScheduled) {
          chatCheckScheduled = true;
          requestAnimationFrame(() => {
            applyChatMemoryOptimization();
            chatCheckScheduled = false;
          });
        }
      }).observe(doc.body, { childList: true, subtree: true });
    });
  };

  /* ═══════════════════════════════════════════════
   *  §3  AI Chat Memory Auto-Optimizer (Generic)
   * ═══════════════════════════════════════════════ */
  const CHAT_SELECTORS = [
    '[data-message-author-role]',   // ChatGPT
    '[data-testid*="message"]',     // React 기반 AI 챗
    '[class*="chat-message"]',      // 일반적인 채팅 UI
    '[class*="ConversationItem"]',  // Claude 등
    '[class*="msg-content"]',       // 기타 채팅 서비스
  ];
  const CHAT_MIN_COUNT = 6;
  let chatStyleInjected = false;

  const applyChatMemoryOptimization = () => {
    if (chatStyleInjected) return;

    // [Fix 2] 매칭되는 모든 셀렉터 수집 후 단일 <style> 인젝션
    const matched = CHAT_SELECTORS.filter(sel => doc.querySelectorAll(sel).length >= CHAT_MIN_COUNT);
    if (!matched.length) return;

    const style = doc.createElement('style');
    style.textContent = `
      ${matched.join(',\n      ')} {
        content-visibility: auto;
        contain-intrinsic-size: auto 200px;
      }
    `;
    doc.head.appendChild(style);
    chatStyleInjected = true;
  };

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

    setTimeout(applyChatMemoryOptimization, 3000);
    setTimeout(applyChatMemoryOptimization, 8000);
  };

  if (doc.readyState !== 'loading') onReady();
  else doc.addEventListener('DOMContentLoaded', onReady, { once: true });
})();
