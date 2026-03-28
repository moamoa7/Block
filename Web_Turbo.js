// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://github.com/moamoa7
// @version      24.0
// @description  Lean web optimizer v24 – Font FOIT prevention, LCP boost, below-fold lazy, iframe lazy. No chat DOM intervention.
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
        // 'block'은 FOIT를 유발하므로 override 대상에 포함.
        // 주의: 아이콘 폰트 등에서 의도적 block 사용 시 fallback 깜빡임 발생 가능.
        d.display = FONT_DISPLAY;
      }
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
          if (!s.fontDisplay || s.fontDisplay === 'auto' || s.fontDisplay === 'block') {
            s.fontDisplay = FONT_DISPLAY;
          }
        }
      }
      patchedSheets.add(ss);
    }
  };

  /* ═══════════════════════════════════════════════
   *  §2  LCP Boost + Below-fold Optimization
   * ═══════════════════════════════════════════════ */
  let lcpEl = null;

  // LCP 요소를 lazy 변환에서 제외하기 위한 집합.
  // WeakSet이므로 요소가 DOM에서 제거된 후에는 GC 대상이 됨.
  // (DOM에 연결된 동안은 DOM 트리가 강한 참조를 유지하므로 GC 불가)
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

      // 저속 환경에서는 LCP 후보 변경이 늦게 발생할 수 있으므로 여유를 둠
      setTimeout(stopLCP, IS_SLOW ? 10000 : 5000);
    } catch (_) { lcpResolve(); }
  } else {
    lcpResolve();
  }

  function boostLCP() {
    // LCP 엔트리는 렌더링 이후 발화하므로 fetchPriority/decoding 설정은 무효.
    // 유일하게 유효한 처리: lazy→eager 복원 (아직 fetch가 시작되지 않은 경우 대비)
    if (!lcpEl?.isConnected) { lcpEl = null; return; }
    if (lcpEl.tagName === 'IMG' && lcpEl.loading === 'lazy') lcpEl.loading = 'eager';
  }

  const optimizeBelowFold = () => {
    lcpReady.then(() => {
      // doc.body가 아직 없는 극단적 경우 방어
      if (!doc.body) return;

      const observed = new WeakSet();

      const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const el = e.target;
          const tag = el.tagName;
          io.unobserve(el);

          if (tag === 'IMG') {
            // LCP 요소는 lazy 변환에서 제외
            if (lcpEls.has(el) || e.isIntersecting) continue;

            // NOTE: HTML 파서가 이미 처리한 <img>에 대해서는 loading='lazy'를
            // 사후 설정해도 브라우저가 이미 시작한 fetch를 취소하지 않음.
            // 이 처리는 주로 MutationObserver가 감지한 동적 삽입 요소에 효과적임.
            if (!el.loading || el.loading === 'eager') el.loading = 'lazy';
            if (!el.decoding || el.decoding === 'auto') el.decoding = 'async';

            // fetchPriority는 in-flight 요청에도 우선순위 재평가가 가능하므로 유지
            if (!el.fetchPriority || el.fetchPriority === 'auto' || el.fetchPriority === 'high') {
              el.fetchPriority = 'low';
            }

            // sizes='auto'는 loading="lazy"와 함께 적용될 때만 유효.
            // 이미 파싱된 이미지에서는 loading='lazy'가 실질적으로 적용되지 않으므로
            // 동적 삽입 요소에서만 효과가 있음.
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

      // 초기 스캔
      doc.querySelectorAll('img, iframe').forEach(observeEl);

      // 동적 요소 감시 – throttle로 비용 제한
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
