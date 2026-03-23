// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      14.0
// @description  Non-blocking web optimizer v14.0 – IO-based viewport, batched DNS via ResourceTiming observer, CSP directive-aware, WeakRef idle sweep, Display Locking, img sizes fix, all features maintained & upgraded.
// @author       You & Oppai1442 Logic
// @match        *://*/*
// @exclude      *://www.google.com/maps/*
// @exclude      *://www.figma.com/*
// @exclude      *://*.figma.com/*
// @exclude      *://excalidraw.com/*
// @exclude      *://*.unity3dusercontent.com/*
// @exclude      *://play.unity.com/*
// @exclude      *://www.photopea.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const V = '14.0', HOST = location.hostname, ORIGIN = location.origin;

  /* ═══════════════════════════════════════
     §0  DEVICE · NETWORK · CONFIG
     ═══════════════════════════════════════ */
  const DEV_CORES = navigator.hardwareConcurrency || 4;
  const DEV_MEM   = navigator.deviceMemory || 4;
  const T = (DEV_CORES <= 2 || DEV_MEM <= 2) ? 'low'
          : (DEV_CORES <= 4 || DEV_MEM <= 4) ? 'mid' : 'high';

  const NET = { slow: false, save: false, etype: '4g', downlink: 10, rtt: 50 };
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const netUp = () => {
    if (!conn) return;
    NET.save = !!conn.saveData;
    NET.etype = conn.effectiveType || '4g';
    NET.downlink = conn.downlink ?? 10;
    NET.rtt = conn.rtt ?? 50;
    NET.slow = NET.save || NET.etype === 'slow-2g' || NET.etype === '2g';
  };
  netUp();
  conn?.addEventListener?.('change', netUp);

  const isLow = T === 'low';
  const CFG = {
    bootMin: 2000, bootMax: 5000, bootPoll: 500, bootTh: 100,
    thrDelay: 5000, thrMin: isLow ? 2000 : 1000,
    fpsInt: 2000, fpsLo: isLow ? 25 : 20, fpsHi: isLow ? 35 : 40,
    lpTr: '100ms', lpAn: '100ms',
    font: NET.slow ? 'optional' : 'swap',
    batch: isLow ? 80 : 150,
    yldN: isLow ? 30 : 50,
    gcMs: isLow ? 20000 : (NET.slow ? 60000 : 30000),
    lcpMs: 2500,
    spaDb: 300,
    dnsMaxPc: isLow ? 2 : 4,
    dnsMaxDns: isLow ? 6 : 12,
    priCrit: 'link[rel="stylesheet"],script[src]:not([async]):not([defer])',
    dlockMargin: '200px',
    dlockSel: '.offscreen-section,[data-display-lock],aside.sidebar',
  };

  /* ═══════════════════════════════════════
     §0-b  SCHEDULER — 한번만 감지, 분기 최소화
     ═══════════════════════════════════════ */
  const hasPT  = typeof globalThis.scheduler?.postTask === 'function';
  const hasYld = typeof globalThis.scheduler?.yield === 'function';
  const hasRIC = typeof requestIdleCallback === 'function';

  // postTask가 있으면 사용, 없으면 rIC/setTimeout 폴백
  const sched = hasPT
    ? (fn, p) => scheduler.postTask(fn, { priority: p || 'background' })
    : hasRIC
      ? (fn, p) => (p === 'user-blocking')
        ? Promise.resolve().then(fn)
        : new Promise(r => requestIdleCallback(() => r(fn()), { timeout: 5000 }))
      : (fn, p) => new Promise(r => setTimeout(() => r(fn()), (p === 'user-blocking') ? 0 : 16));

  const yld = hasYld
    ? () => scheduler.yield()
    : () => new Promise(r => setTimeout(r, 0));

  /* ═══════════════════════════════════════
     §0-c  CSP VIOLATION MONITOR — directive 구분
     ═══════════════════════════════════════
     v13.7 문제: connect-src 차단을 img-src/dns-prefetch에도
     적용하여 과도한 차단. directive별로 분리.
  */
  const CSP = (() => {
    // directive → Set<origin>
    const byDir = new Map();
    let violations = 0;

    document.addEventListener('securitypolicyviolation', (e) => {
      violations++;
      const uri = e.blockedURI || '';
      const dir = e.violatedDirective?.split(' ')[0] || 'unknown';
      if (!uri) return;
      try {
        const o = new URL(uri).origin;
        if (o === 'null') return;
        if (!byDir.has(dir)) byDir.set(dir, new Set());
        byDir.get(dir).add(o);
      } catch (_) {}
      if (violations <= 5) console.warn(`[TO] CSP:${dir} → ${uri.slice(0, 80) || 'inline'}`);
    });

    return {
      /** connect-src 관련 차단 여부 (fetch/XHR용) */
      isConnectBlocked: (o) => byDir.get('connect-src')?.has(o) ?? false,
      /** 전체 차단 여부 (dns-prefetch용 — script-src/style-src는 무관하므로 제외) */
      isDnsBlocked: (o) => {
        for (const [dir, set] of byDir) {
          // script-src, style-src, font-src 차단은 dns-prefetch에 무관
          if (dir === 'script-src' || dir === 'style-src' || dir === 'font-src') continue;
          if (set.has(o)) return true;
        }
        return false;
      },
      stats: () => ({ violations, directives: Object.fromEntries([...byDir].map(([k, v]) => [k, [...v]])) }),
    };
  })();

  /* ═══════════════════════════════════════
     §1  PASSIVE EVENT HOOK — 객체 할당 최소화
     ═══════════════════════════════════════
     v13.7 문제: 매 호출마다 스프레드로 새 객체 생성.
     개선: 캐시된 옵션 객체 재사용 (capture true/false × passive).
  */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll', 'touchstart', 'touchmove']);
  // 미리 4개 옵션 객체 캐시 — 이벤트 등록시 새 객체 할당 제로
  const _OPTS = {
    pf: Object.freeze({ passive: true, capture: false }),
    pt: Object.freeze({ passive: true, capture: true }),
  };
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) {
      if (!o || o === false) return _ael.call(this, t, fn, _OPTS.pf);
      if (o === true) return _ael.call(this, t, fn, _OPTS.pt);
      // 객체인 경우: capture 값만 확인, 나머지 속성은 유지하되 passive 강제
      if (typeof o === 'object') {
        if (!o.passive) { o.passive = true; }
        return _ael.call(this, t, fn, o);
      }
    }
    return _ael.call(this, t, fn, o);
  };

  if (HTMLCanvasElement?.prototype?.transferControlToOffscreen) {
    const _tr = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function () { this.dataset.offscreen = '1'; return _tr.call(this); };
  }

  console.log(`[TO v${V}] P1✓ ${T}/${NET.etype}`);

  /* ═══════════════════════════════════════
     §2  PHASE 2 BOOT
     ═══════════════════════════════════════ */
  const onReady = cb => document.readyState !== 'loading' ? cb() : document.addEventListener('DOMContentLoaded', cb, { once: true });

  onReady(() => {
    const t0 = performance.now();
    let p = 0;
    const mx = ((CFG.bootMax - CFG.bootMin) / CFG.bootPoll) | 0;
    const go = () => {
      if (performance.now() - t0 < CFG.bootMin) { setTimeout(go, CFG.bootMin - (performance.now() - t0)); return; }
      if ((document.body?.offsetHeight || 0) > CFG.bootTh || p >= mx) { initAll(); return; }
      p++; setTimeout(go, CFG.bootPoll);
    };
    hasRIC ? requestIdleCallback(() => go(), { timeout: CFG.bootMax }) : setTimeout(go, CFG.bootMin);
  });

  /* ═══════════════════════════════════════
     §3  MAIN INIT
     ═══════════════════════════════════════ */
  function initAll() {
    let lowPower = false, thrOn = false;

    /* ─── §4 SITE PROFILES ─── */
    const PR = {
      'gemini.google.com':     { s: '.streaming',                  t: 'message-content',      c: '.chat-history' },
      'chatgpt.com':           { s: '.result-streaming',           t: '[data-message-id]',    c: '[class*="react-scroll"]' },
      'chat.openai.com':       { s: '.result-streaming',           t: '[data-message-id]',    c: '[class*="react-scroll"]' },
      'claude.ai':             { s: '[data-is-streaming="true"]',  t: '.font-claude-message', c: '.overflow-y-auto' },
      'genspark.ai':           { s: '.streaming-content',          t: '.message-bubble',      c: '.chat-scroll' },
      'perplexity.ai':         { s: '.prose.streaming',            t: '.prose',               c: '[class*="overflow"]' },
      'aistudio.google.com':   { s: '.streaming',                  t: '.turn-container',      c: '.chat-scroll-container' },
      'copilot.microsoft.com': { s: '[data-streaming]',            t: '.response-message',    c: '.scroller' },
      'grok.com':              { s: '.streaming',                  t: '.message',             c: '.overflow-auto' },
      'x.com':                 { s: '.streaming',                  t: '.message',             c: '.overflow-auto' },
      'huggingface.co':        { s: '.generating',                 t: '.message',             c: '.overflow-auto' },
      'chat.deepseek.com':     { s: '.ds-streaming',               t: '.ds-message',          c: '.ds-scroll' },
      'poe.com':               { s: '[class*="loading"]',          t: '[class*="Message"]',   c: '[class*="ChatMessages"]' },
    };
    const SP = Object.keys(PR).reduce((m, d) => HOST.includes(d.replace('*.', '')) ? PR[d] : m, null);
    const AI = !!SP;

    /* ═══════════════════════════════════════
       §5  LCP TRACKER — AbortController 일괄 정리
       ═══════════════════════════════════════
       v13.7 유지. 변경 없음 — 이미 최적.
    */
    const lcp = { el: null, done: false };
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const lcpObs = new PerformanceObserver(list => {
          const e = list.getEntries();
          if (e.length) lcp.el = e[e.length - 1].element || null;
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
        const ac = new AbortController();
        const fin = () => {
          if (lcp.done) return;
          lcp.done = true; ac.abort(); lcpObs.disconnect();
          if (lcp.el?.tagName === 'IMG') {
            lcp.el.loading = 'eager';
            lcp.el.fetchPriority = 'high';
            lcp.el.decoding = 'sync';
          }
        };
        for (const e of ['keydown', 'click', 'scroll', 'touchstart'])
          addEventListener(e, fin, { once: true, passive: true, capture: true, signal: ac.signal });
        setTimeout(fin, CFG.lcpMs);
      } catch (_) {}
    }

    /* ═══════════════════════════════════════
       §6  CSS INJECTION — 단일 style 요소로 통합
       ═══════════════════════════════════════
       v13.7: style 2개 (hS, lS) → DOM 노드 절약을 위해
       lS만 별도 유지 (disabled 토글이 필요하므로).
       hS 내용은 단일 textContent로 최적화.
    */
    const cvSel = AI
      ? `article:not(${SP.t}),section:not(${SP.t})`
      : 'article,section,.post,.comment,.card,li.item';
    const scSel = [
      '.chat-history', '.overflow-y-auto', '[class*="react-scroll"]',
      '.chat-scroll', '.scroller', '.overflow-auto',
      AI ? SP.c : ''
    ].filter(Boolean).join(',');

    const hS = document.createElement('style');
    hS.id = 'tb-h';
    hS.textContent =
      `${cvSel}{content-visibility:auto;contain-intrinsic-size:auto 500px}` +
      `img[loading="lazy"],iframe[loading="lazy"]{content-visibility:auto;contain-intrinsic-size:auto 300px}` +
      `${scSel}{contain:content;will-change:scroll-position;overflow-anchor:auto;overscroll-behavior:contain}`;

    const lS = document.createElement('style');
    lS.id = 'tb-lp';
    lS.disabled = true;
    lS.textContent =
      `*,*::before,*::after{animation-duration:${CFG.lpAn}!important;transition-duration:${CFG.lpTr}!important;text-rendering:optimizeSpeed!important}` +
      `[style*="infinite"],.animated,[class*="animate"],lottie-player,dotlottie-player{animation-play-state:paused!important}`;

    (document.head || document.documentElement).append(hS, lS);

    const prm = matchMedia('(prefers-reduced-motion:reduce)');
    if (prm.matches) { lowPower = true; lS.disabled = false; }
    prm.addEventListener('change', e => {
      if (e.matches && !lowPower) { lowPower = true; lS.disabled = false; }
    });

    const setWC = v => {
      try {
        const els = document.querySelectorAll(scSel);
        for (let i = 0; i < els.length; i++) els[i].style.willChange = v;
      } catch (_) {}
    };

    /* ═══════════════════════════════════════
       §7  FONT-DISPLAY OVERRIDE
       ═══════════════════════════════════════ */
    try {
      const _F = window.FontFace;
      if (_F) {
        window.FontFace = function (f, s, d) {
          return new _F(f, s, { ...d, display: CFG.font });
        };
        window.FontFace.prototype = _F.prototype;
      }
    } catch (_) {}
    sched(() => {
      try {
        for (const s of document.styleSheets)
          try { for (const r of s.cssRules || []) if (r instanceof CSSFontFaceRule) r.style.fontDisplay = CFG.font; } catch (_) {}
      } catch (_) {}
    });

    /* ═══════════════════════════════════════
       §8  TIMER THROTTLE
       ═══════════════════════════════════════ */
    const _si = window.setInterval;
    window.setInterval = function (fn, d, ...a) {
      if (thrOn && typeof d === 'number' && d < CFG.thrMin) d = CFG.thrMin;
      return _si.call(window, fn, d, ...a);
    };
    setTimeout(() => { thrOn = true; }, CFG.thrDelay);

    /* ═══════════════════════════════════════
       §9  MEMORY TRACKER — FinalizationRegistry + idle sweep
       ═══════════════════════════════════════
       v14.0 개선: nid를 Map 외부 counter 대신
       WeakRef 자체를 Set으로 관리 → Map overhead 제거.
       단, blob revoke를 위해 별도 Map 유지.
    */
    const Mem = (() => {
      const blobMap = new Map();   // id → blobURL (revoke용)
      const refs = new Map();      // id → WeakRef
      let nid = 0, cleaned = 0, revoked = 0;
      const reg = typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry(m => {
            refs.delete(m.id);
            cleaned++;
            if (m.blob) try { URL.revokeObjectURL(m.blob); revoked++; } catch (_) {}
            blobMap.delete(m.id);
          })
        : null;
      return {
        track(el) {
          if (!reg) return;
          const id = nid++;
          const src = el.src || el.currentSrc || '';
          const blob = src.startsWith('blob:') ? src : null;
          refs.set(id, new WeakRef(el));
          if (blob) blobMap.set(id, blob);
          reg.register(el, { id, blob });
        },
        sweep() {
          let swept = 0;
          for (const [id, r] of refs) {
            if (!r.deref()) { refs.delete(id); blobMap.delete(id); swept++; }
          }
          return swept;
        },
        stats() {
          let a = 0;
          for (const [, r] of refs) if (r.deref()) a++;
          return { tracked: refs.size, alive: a, cleaned, revoked };
        }
      };
    })();

    const heapMB = () => {
      try { if (performance.memory) return ((performance.memory.usedJSHeapSize / 1048576) + .5) | 0; } catch (_) {}
      return null;
    };

    /* ═══════════════════════════════════════
       §10  VIEWPORT DETECTION — IntersectionObserver 기반
       ═══════════════════════════════════════
       ★ v14.0 핵심 개선:
       v13.7은 getBoundingClientRect()를 개별 호출 → 강제 reflow.
       IO로 전환하여 reflow 제로, 비동기 콜백으로 처리.

       구조:
       1) vpIO: 뷰포트 내/외 판정용 IO (rootMargin 50px)
       2) vpMap: WeakMap<Element, boolean> — 현재 VP 상태
       3) optMedia: vpMap 참조 (동기 접근, reflow 없음)
       4) 새 노드 추가 시 vpIO.observe → 콜백에서 vpMap 갱신 + optMedia
    */
    const done = new WeakSet();
    const vpMap = new WeakMap(); // element → isInViewport(boolean)

    const vpIO = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        vpMap.set(e.target, e.isIntersecting);
        // IO 콜백에서 바로 최적화 적용
        if (!done.has(e.target)) applyMediaOpt(e.target);
      }
    }, { rootMargin: '50px' });

    const applyMediaOpt = (el) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (lcp.el === el) {
          el.loading = 'eager'; el.fetchPriority = 'high'; el.decoding = 'sync';
          done.add(el); Mem.track(el); vpIO.unobserve(el); return;
        }
        const inVP = vpMap.get(el) ?? true; // 아직 판정 전이면 eager 가정
        if (inVP) {
          if (!el.hasAttribute('loading'))       el.loading = 'eager';
          if (!el.hasAttribute('fetchpriority')) el.fetchPriority = 'high';
          if (!el.hasAttribute('decoding'))      el.decoding = 'async';
        } else {
          if (!el.hasAttribute('loading'))       el.loading = 'lazy';
          if (!el.hasAttribute('decoding'))      el.decoding = 'async';
          if (NET.slow && !el.hasAttribute('fetchpriority')) el.fetchPriority = 'low';
        }
      } else if (tag === 'IFRAME') {
        if (!el.hasAttribute('loading')) el.loading = 'lazy';
      } else if (tag === 'VIDEO') {
        if (!el.hasAttribute('preload')) el.preload = NET.slow ? 'none' : 'metadata';
      }
      done.add(el); Mem.track(el);
      vpIO.unobserve(el); // 판정 완료 후 관찰 중단 (리소스 절약)
    };

    /** 새 미디어 요소를 IO에 등록 */
    const enrollMedia = (el) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag !== 'IMG' && tag !== 'IFRAME' && tag !== 'VIDEO') return;
      // LCP 요소는 즉시 처리
      if (lcp.el === el) { applyMediaOpt(el); return; }
      // IFRAME, VIDEO는 VP 판정 불필요 — 즉시 처리
      if (tag !== 'IMG') { applyMediaOpt(el); return; }
      // IMG → IO에 등록, 콜백에서 처리
      vpIO.observe(el);
    };

    /** 기존 DOM 전체 스캔 (초기 + SPA 전환) */
    const scanAllMedia = () => {
      const all = document.querySelectorAll('img,iframe,video');
      for (let i = 0; i < all.length; i++) enrollMedia(all[i]);
    };

    /* ═══════════════════════════════════════
       §11  MUTATION OBSERVER — 통합 (미디어 + DNS)
       ═══════════════════════════════════════
       v14.0 개선:
       1) querySelectorAll 중첩 제거 — TreeWalker로 단일 순회
       2) 이중 버퍼 race condition 수정
       3) DNS 버퍼를 미디어와 분리하지 않고 같은 루프에서 처리
    */
    const M_TAGS = new Set(['IMG', 'IFRAME', 'VIDEO']);
    const SRC_TAGS = new Set(['IMG', 'SCRIPT', 'IFRAME', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK']);
    let mBuf = [], mRaf = 0;

    const mObs = new MutationObserver(ms => {
      for (let i = 0; i < ms.length; i++) {
        const ad = ms[i].addedNodes;
        for (let j = 0; j < ad.length; j++) {
          const n = ad[j];
          if (n.nodeType === 1) mBuf.push(n);
        }
      }
      if (mBuf.length && !mRaf) mRaf = requestAnimationFrame(mFlush);
    });

    async function mFlush() {
      mRaf = 0;
      // 현재 버퍼를 가져오고 즉시 새 배열로 교체 (race-free)
      const batch = mBuf;
      mBuf = [];

      const len = Math.min(batch.length, CFG.batch);
      for (let i = 0; i < len; i++) {
        const n = batch[i];
        const tag = n.tagName;

        // 미디어 처리
        if (M_TAGS.has(tag)) {
          enrollMedia(n);
        }

        // DNS 힌트 처리
        if (SRC_TAGS.has(tag)) {
          DnsHints.trackNode(n);
        }

        // 자식 순회 — TreeWalker로 효율적 탐색 (깊이 제한)
        if (n.children && n.children.length > 0) {
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
              const t = node.tagName;
              if (M_TAGS.has(t) || SRC_TAGS.has(t)) return NodeFilter.FILTER_ACCEPT;
              // 깊이 2까지만 — 자식의 자식만
              return node.parentElement === n || node.parentElement?.parentElement === n
                ? NodeFilter.FILTER_SKIP
                : NodeFilter.FILTER_REJECT;
            }
          });
          let child;
          while ((child = tw.nextNode())) {
            if (M_TAGS.has(child.tagName)) enrollMedia(child);
            if (SRC_TAGS.has(child.tagName)) DnsHints.trackNode(child);
          }
        }

        // 양보 (메인 스레드 블로킹 방지)
        if (i > 0 && i % CFG.yldN === 0) await yld();
      }

      // DNS fragment 플러시 (배치)
      DnsHints.flushFrag();

      // 초과분 다음 프레임으로 이월
      if (batch.length > CFG.batch) {
        for (let i = CFG.batch; i < batch.length; i++) mBuf.push(batch[i]);
        if (!mRaf) mRaf = requestAnimationFrame(mFlush);
      }
    }

    if (document.body) {
      mObs.observe(document.body, { childList: true, subtree: true });
    } else {
      const bw = new MutationObserver(() => {
        if (document.body) { bw.disconnect(); mObs.observe(document.body, { childList: true, subtree: true }); }
      });
      bw.observe(document.documentElement, { childList: true });
    }

    /* ─── §12 초기 미디어 스캔 ─── */
    sched(scanAllMedia);

    /* ═══════════════════════════════════════
       §13  DNS-PREFETCH / PRECONNECT — CSP directive-aware
       ═══════════════════════════════════════
       v14.0 개선:
       1) CSP.isDnsBlocked() 사용 (directive 구분)
       2) ResourceTiming PerformanceObserver로 실시간 수집
          (getEntriesByType 전체 복사 제거)
       3) DocumentFragment 배치 삽입 유지
    */
    const DnsHints = (() => {
      const dnsSeen = new Set();
      const pcSeen  = new Set();
      let pcCount = 0;
      const frag = document.createDocumentFragment();
      let fragDirty = false;

      // 빈도 추적 (ResourceTiming observer 기반)
      const freqMap = new Map();

      // PerformanceObserver로 실시간 리소스 빈도 추적
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              const o = extractOrigin(e.name);
              if (o) freqMap.set(o, (freqMap.get(o) || 0) + 1);
            }
          }).observe({ type: 'resource', buffered: true });
        } catch (_) {}
      }

      const extractOrigin = (src) => {
        if (!src) return null;
        try {
          const u = new URL(src, ORIGIN);
          if (u.origin !== ORIGIN && u.protocol.startsWith('http')) return u.origin;
        } catch (_) {}
        return null;
      };

      const addDns = (origin) => {
        if (dnsSeen.has(origin) || dnsSeen.size >= CFG.dnsMaxDns) return;
        if (CSP.isDnsBlocked(origin)) return;
        dnsSeen.add(origin);
        const l = document.createElement('link');
        l.rel = 'dns-prefetch'; l.href = origin;
        frag.appendChild(l);
        fragDirty = true;
      };

      const addPc = (origin) => {
        if (pcSeen.has(origin) || pcCount >= CFG.dnsMaxPc) return;
        if (CSP.isDnsBlocked(origin)) return;
        pcSeen.add(origin); pcCount++;
        const l = document.createElement('link');
        l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
        frag.appendChild(l);
        fragDirty = true;
      };

      const flushFrag = () => {
        if (fragDirty && document.head) {
          document.head.appendChild(frag);
          fragDirty = false;
        }
      };

      const collectExisting = () => {
        const links = document.querySelectorAll('link[rel="dns-prefetch"],link[rel="preconnect"]');
        for (let i = 0; i < links.length; i++) {
          try {
            const o = new URL(links[i].href).origin;
            if (links[i].rel === 'dns-prefetch') dnsSeen.add(o);
            else { pcSeen.add(o); pcCount++; }
          } catch (_) {}
        }
      };

      const scanDOM = () => {
        collectExisting();

        // freqMap 기반 preconnect 우선순위 (이미 PerfObserver가 실시간 업데이트)
        const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
        for (let i = 0; i < sorted.length && pcCount < CFG.dnsMaxPc; i++) {
          addPc(sorted[i][0]);
          addDns(sorted[i][0]);
        }

        // TreeWalker 순회
        if (!document.body) { flushFrag(); return; }
        const tw = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_ELEMENT,
          { acceptNode(node) { return SRC_TAGS.has(node.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } }
        );

        let node, count = 0;
        while ((node = tw.nextNode())) {
          const src = node.src || node.href || node.currentSrc || '';
          const o = extractOrigin(src);
          if (o) {
            addDns(o);
            if ((freqMap.get(o) || 0) >= 2) addPc(o);
          }
          const ss = node.srcset;
          if (ss) {
            const parts = ss.split(',');
            for (let i = 0; i < parts.length; i++) {
              const u = parts[i].trim().split(/\s+/)[0];
              const so = extractOrigin(u);
              if (so) addDns(so);
            }
          }
          if (++count >= 200 && hasRIC) break;
        }
        flushFrag();

        // 200개 초과 → idle로 이연
        if (count >= 200) {
          const resumeWalk = (deadline) => {
            let c = 0, n;
            while ((n = tw.nextNode())) {
              const src = n.src || n.href || n.currentSrc || '';
              const o = extractOrigin(src);
              if (o) addDns(o);
              if (++c % 50 === 0 && deadline.timeRemaining() < 2) {
                requestIdleCallback(resumeWalk, { timeout: 3000 });
                flushFrag();
                return;
              }
            }
            flushFrag();
          };
          requestIdleCallback(resumeWalk, { timeout: 3000 });
        }
      };

      const trackNode = (node) => {
        const src = node.src || node.href || node.currentSrc || '';
        const o = extractOrigin(src);
        if (o) addDns(o);
      };

      return { scanDOM, trackNode, flushFrag, extractOrigin, stats: () => ({ dnsPrefetch: dnsSeen.size, preconnect: pcSeen.size, pcBudget: CFG.dnsMaxPc }) };
    })();

    sched(() => DnsHints.scanDOM());

    /* ─── §14 3RD-PARTY SCRIPT 우선순위 하락 ─── */
    sched(() => {
      const scripts = document.querySelectorAll('script[src]');
      for (let i = 0; i < scripts.length; i++) {
        try {
          const u = new URL(scripts[i].src);
          if (u.origin !== ORIGIN && !scripts[i].hasAttribute('fetchpriority'))
            scripts[i].fetchPriority = 'low';
        } catch (_) {}
      }
    });

    /* ─── §14-b CRITICAL RESOURCE 우선순위 상승 ─── */
    sched(() => {
      const els = document.querySelectorAll(CFG.priCrit);
      for (let i = 0; i < els.length; i++) {
        try {
          const src = els[i].src || els[i].href || '';
          const u = new URL(src, ORIGIN);
          if (u.origin === ORIGIN && !els[i].hasAttribute('fetchpriority'))
            els[i].fetchPriority = 'high';
        } catch (_) {}
      }
    });

    /* ═══════════════════════════════════════
       §14-c  SPECULATION RULES — CSP 연동
       ═══════════════════════════════════════ */
    sched(() => {
      if (NET.slow || NET.save) return;
      try {
        if (!HTMLScriptElement.supports?.('speculationrules')) return;
        const rules = {
          prefetch: [{
            where: {
              and: [
                { href_matches: '/*' },
                { not: { href_matches: ['/*\\?*', '/api/*', '/logout', '/sign-out'] } },
                { not: { selector_matches: '[rel~="nofollow"]' } }
              ]
            },
            eagerness: 'moderate'
          }]
        };
        if (T === 'high' && DEV_MEM >= 8) {
          rules.prerender = [{
            where: {
              and: [
                { href_matches: '/*' },
                { not: { href_matches: ['/*\\?*', '/api/*', '/logout', '/sign-out'] } }
              ]
            },
            eagerness: 'conservative'
          }];
        }
        const script = document.createElement('script');
        script.type = 'speculationrules';
        script.textContent = JSON.stringify(rules);
        document.head.appendChild(script);
      } catch (_) {}
    });

    /* ═══════════════════════════════════════
       §15  FPS MONITOR
       ═══════════════════════════════════════ */
    let fpsF = 0, fpsT = performance.now(), fpsC = 60;
    const fpsTick = (n) => {
      fpsF++;
      const dt = n - fpsT;
      if (dt >= CFG.fpsInt) {
        fpsC = (fpsF * 1000 / dt + .5) | 0;
        fpsF = 0; fpsT = n;
        if (!prm.matches) {
          if (fpsC < CFG.fpsLo && !lowPower)     { lowPower = true;  lS.disabled = false; setWC('auto'); }
          else if (fpsC > CFG.fpsHi && lowPower)  { lowPower = false; lS.disabled = true;  setWC('scroll-position'); }
        }
      }
      requestAnimationFrame(fpsTick);
    };
    requestAnimationFrame(fpsTick);

    /* ═══════════════════════════════════════
       §16  SPA NAVIGATION — 디바운스 + 전체 재스캔
       ═══════════════════════════════════════ */
    let spaT = 0;
    const onSpa = () => {
      clearTimeout(spaT);
      spaT = setTimeout(() => {
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); });
        setTimeout(() => sched(() => ImgFormat.scan()), 2000);
      }, CFG.spaDb);
    };
    const _hp = history.pushState, _hr = history.replaceState;
    history.pushState    = function (...a) { _hp.apply(this, a); onSpa(); };
    history.replaceState = function (...a) { _hr.apply(this, a); onSpa(); };
    addEventListener('popstate', onSpa);
    if (typeof navigation !== 'undefined') navigation.addEventListener?.('navigatesuccess', onSpa);

    /* ═══════════════════════════════════════
       §17  TAB RESUME + bfcache
       ═══════════════════════════════════════ */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sched(scanAllMedia);
        sched(() => DisplayLock.scan());
      }
    });
    addEventListener('pageshow', e => {
      if (e.persisted) {
        console.log(`[TO v${V}] bfcache restore`);
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); });
      }
    });

    /* ─── §17-b FETCH / XHR 외부 도메인 자동 dns-prefetch ─── */
    (() => {
      const _fetch = window.fetch;
      if (_fetch) {
        window.fetch = function (input, init) {
          try {
            const url = typeof input === 'string' ? input : input?.url || '';
            const o = DnsHints.extractOrigin(url);
            if (o && !CSP.isConnectBlocked(o)) {
              queueMicrotask(() => { DnsHints.trackNode({ tagName: 'LINK', href: url }); DnsHints.flushFrag(); });
            }
          } catch (_) {}
          return _fetch.call(this, input, init);
        };
      }
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try {
          const s = typeof url === 'string' ? url : url?.toString();
          const o = DnsHints.extractOrigin(s);
          if (o && !CSP.isConnectBlocked(o)) {
            queueMicrotask(() => { DnsHints.trackNode({ tagName: 'LINK', href: s }); DnsHints.flushFrag(); });
          }
        } catch (_) {}
        return _open.call(this, method, url, ...rest);
      };
    })();

    /* ═══════════════════════════════════════
       §18  LONG TASK / LoAF MONITORING
       ═══════════════════════════════════════ */
    if (typeof PerformanceObserver !== 'undefined') {
      const tryO = (type, th) => {
        try {
          new PerformanceObserver(l => {
            for (const e of l.getEntries()) if (e.duration > th) console.warn(`[TO] ${type}:${(e.duration + .5) | 0}ms`);
          }).observe({ type, buffered: false });
        } catch (_) {}
      };
      tryO('long-animation-frame', 150);
      tryO('longtask', 100);
    }

    /* ─── §18-b RESOURCE TIMING 느린 리소스 경고 ─── */
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (e.duration > 3000) console.warn(`[TO] slow-res: ${e.name.slice(0, 80)} ${(e.duration + .5) | 0}ms`);
          }
        }).observe({ type: 'resource', buffered: false });
      } catch (_) {}
    }

    /* ═══════════════════════════════════════
       §19  SOFT GC + IDLE SWEEP
       ═══════════════════════════════════════ */
    _si.call(window, () => sched(() => {
      const s = Mem.stats(), h = heapMB();
      if (s.cleaned || s.revoked || h) console.log(`[TO] ${s.alive}a/${s.cleaned}gc/${s.revoked}blob${h ? ' H:' + h + 'M' : ''}`);
    }), CFG.gcMs);

    if (hasRIC) {
      const idleGC = (deadline) => {
        if (deadline.timeRemaining() > 5) {
          const swept = Mem.sweep();
          if (swept > 0) console.log(`[TO] idle-sweep: ${swept}`);
        }
        requestIdleCallback(idleGC, { timeout: CFG.gcMs * 2 });
      };
      requestIdleCallback(idleGC, { timeout: CFG.gcMs });
    }

    /* ═══════════════════════════════════════
       §21  DISPLAY LOCKING — IO 기반 content-visibility:hidden
       ═══════════════════════════════════════
       v14.0 개선: offsetHeight 읽기를 IO 콜백의
       boundingClientRect.height로 대체 → forced reflow 제거.
    */
    const DisplayLock = (() => {
      const supported = CSS.supports?.('content-visibility', 'hidden') ?? false;
      if (!supported) return { scan: () => {}, stats: () => ({ supported: false }) };

      const locked = new WeakSet();
      let lockCount = 0, unlockCount = 0;

      const io = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const el = e.target;
          if (e.isIntersecting) {
            if (locked.has(el)) {
              el.style.contentVisibility = 'auto';
              el.style.containIntrinsicSize = 'auto 500px';
              locked.delete(el);
              unlockCount++;
            }
          } else {
            if (!locked.has(el)) {
              // ★ IO 콜백의 boundingClientRect 사용 — reflow 없음
              const h = e.boundingClientRect.height;
              el.style.contentVisibility = 'hidden';
              el.style.containIntrinsicSize = `auto ${h}px`;
              locked.add(el);
              lockCount++;
            }
          }
        }
      }, { rootMargin: CFG.dlockMargin });

      const observed = new WeakSet();

      const observeEl = (el) => {
        if (observed.has(el)) return;
        observed.add(el);
        io.observe(el);
      };

      const scan = () => {
        // 채팅 컨테이너 자식
        if (AI && SP.c) {
          try {
            const children = document.querySelectorAll(`${SP.c} > *`);
            for (let i = 0; i < children.length; i++) {
              if (children[i].children.length >= 3) observeEl(children[i]);
            }
          } catch (_) {}
        }

        // 리스트/피드 아이템 — ★ offsetHeight 접근 제거, children.length만 체크
        const containers = document.querySelectorAll(
          '[role="feed"] > *, [role="list"] > *, .feed > *, .timeline > *'
        );
        for (let i = 0; i < containers.length; i++) {
          if (containers[i].children.length >= 2) observeEl(containers[i]);
        }

        // 커스텀 셀렉터
        try {
          const custom = document.querySelectorAll(CFG.dlockSel);
          for (let i = 0; i < custom.length; i++) observeEl(custom[i]);
        } catch (_) {}
      };

      return { scan, stats: () => ({ supported, locked: lockCount, unlocked: unlockCount }) };
    })();

    sched(() => DisplayLock.scan());

    /* ═══════════════════════════════════════
       §22  IMAGE FORMAT HINTS — sizes 자동 보정
       ═══════════════════════════════════════
       v14.0 개선:
       1) canvas.toDataURL 제거 → createImageBitmap 비동기 감지
          (블로킹 없이 AVIF/WebP 지원 여부 판정)
       2) getEntriesByName 개별 호출 제거
          → PerformanceObserver에서 대형 이미지를 실시간 감지
    */
    const ImgFormat = (() => {
      let avif = false, webp = false;
      let hinted = 0, sizesFixed = 0;

      // ★ 비동기 포맷 감지 (canvas.toDataURL 동기 블로킹 제거)
      const detectFormats = async () => {
        const test = async (blob) => {
          try { const bmp = await createImageBitmap(blob); bmp.close(); return true; }
          catch (_) { return false; }
        };
        // 1x1 AVIF
        try {
          const avifBlob = new Blob([new Uint8Array([
            0,0,0,28,102,116,121,112,97,118,105,102,0,0,0,0,97,118,105,102,109,105,102,49,109,105,97,102
          ])], { type: 'image/avif' });
          avif = await test(avifBlob);
        } catch (_) {}
        // 1x1 WebP
        try {
          const webpBlob = new Blob([new Uint8Array([
            82,73,70,70,36,0,0,0,87,69,66,80,86,80,56,32,24,0,0,0,48,1,0,157,1,42,1,0,1,0,1,64,37,164,0,3,112,0,254,251,148,0,0
          ])], { type: 'image/webp' });
          webp = await test(webpBlob);
        } catch (_) {}
      };

      // 대형 이미지 실시간 감지 (PerformanceObserver — §13과 별도)
      if (typeof PerformanceObserver !== 'undefined') {
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              if (e.initiatorType !== 'img') continue;
              const kb = (e.transferSize || 0) / 1024;
              if (kb > 500) {
                console.warn(`[TO] large-img: ${kb | 0}KB ${e.name.slice(0, 60)}… → AVIF/WebP 권장`);
                hinted++;
              }
            }
          }).observe({ type: 'resource', buffered: true });
        } catch (_) {}
      }

      const scan = () => {
        const imgs = document.querySelectorAll('img[srcset]');
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i];
          if (img.dataset.tbFmt) continue;
          img.dataset.tbFmt = '1';
          // sizes 자동 보정
          if (!img.sizes || img.sizes === '100vw') {
            const w = img.clientWidth || img.offsetWidth;
            if (w > 0 && w < innerWidth * 0.9) {
              img.sizes = `${w}px`;
              sizesFixed++;
            }
          }
        }
      };

      // 포맷 감지 비동기 실행
      detectFormats();

      return { scan, stats: () => ({ avif, webp, hinted, sizesFixed }) };
    })();

    if (document.readyState === 'complete') {
      sched(() => ImgFormat.scan());
    } else {
      addEventListener('load', () => sched(() => ImgFormat.scan()), { once: true });
    }

    /* ═══════════════════════════════════════
       §23  PRIORITY HINTS via Fetch Metadata (신규)
       ═══════════════════════════════════════
       above-the-fold 이미지의 fetchpriority를 IO 기반으로
       동적 조정 — 이미 §10에서 IO 콜백으로 처리되므로
       이 섹션은 <link rel="preload"> 최적화에 집중.

       기존에 없던 기능: 사이트가 preload hint를 과도하게
       사용하는 경우 (5개 초과) 저우선순위 리소스를 자동 탈락.
    */
    sched(() => {
      const preloads = document.querySelectorAll('link[rel="preload"]');
      if (preloads.length <= 5) return;
      // 6번째 이후 preload에 fetchpriority=low 부여 (브라우저 힌트)
      for (let i = 5; i < preloads.length; i++) {
        if (!preloads[i].hasAttribute('fetchpriority')) {
          preloads[i].fetchPriority = 'low';
        }
      }
    });

    /* ═══════════════════════════════════════
       §24  IDLE PREFETCH BUDGET CONTROL (신규)
       ═══════════════════════════════════════
       브라우저의 자동 prefetch가 과도한 네트워크 사용을
       유발하지 않도록, 데이터 세이버 모드에서 speculation
       rules의 동적 제거 + prefetch link 비활성화.
    */
    if (conn) {
      conn.addEventListener('change', () => {
        netUp();
        if (NET.save || NET.slow) {
          // speculation rules 제거
          const specScripts = document.querySelectorAll('script[type="speculationrules"]');
          for (let i = 0; i < specScripts.length; i++) specScripts[i].remove();
          // prefetch link 비활성화
          const pfLinks = document.querySelectorAll('link[rel="prefetch"]');
          for (let i = 0; i < pfLinks.length; i++) pfLinks[i].remove();
        }
      });
    }

    /* ═══════════════════════════════════════
       §25  PAINT HOLDING HINT (신규)
       ═══════════════════════════════════════
       SPA 네비게이션 시 render-blocking 없이 "paint hold" 효과를
       줌. content-visibility:hidden을 body에 잠시 적용 후 해제.
       → First Paint 지터 방지.
    */
    const paintHold = (() => {
      const supported = CSS.supports?.('content-visibility', 'hidden') ?? false;
      if (!supported) return { hold: () => {}, release: () => {} };

      let holding = false;
      return {
        hold() {
          if (holding || !document.body) return;
          holding = true;
          document.body.style.contentVisibility = 'hidden';
        },
        release() {
          if (!holding || !document.body) return;
          holding = false;
          document.body.style.contentVisibility = '';
          // 한 프레임 후 완전 제거 (깜빡임 방지)
          requestAnimationFrame(() => {
            if (document.body.style.contentVisibility === '')
              document.body.style.removeProperty('content-visibility');
          });
        }
      };
    })();

    // SPA 전환 시 paint hold 적용
    const _hp2 = history.pushState;
    history.pushState = function (...a) {
      paintHold.hold();
      _hp2.apply(this, a);
      requestAnimationFrame(() => paintHold.release());
      onSpa();
    };

    /* ═══════════════════════════════════════
       §20  DIAGNOSTIC PANEL
       ═══════════════════════════════════════ */
    window.__turboOptimizer__ = Object.freeze({
      version: V, mode: 'NON-BLOCKING', host: HOST, ai: AI, profile: SP,
      device:   () => ({ cores: DEV_CORES, mem: DEV_MEM, tier: T }),
      net:      () => ({ ...NET }),
      fps:      () => fpsC,
      lowPower: () => lowPower,
      throttle: () => thrOn,
      memory:   () => ({ ...Mem.stats(), heapMB: heapMB() }),
      lcp:      () => ({ el: lcp.el?.tagName || null, done: lcp.done }),
      dns:      () => DnsHints.stats(),
      csp:      () => CSP.stats(),
      dlock:    () => DisplayLock.stats(),
      imgfmt:   () => ImgFormat.stats(),
      sched:    { postTask: hasPT, yield: hasYld },
      stats() {
        return {
          v: V, host: HOST, ai: AI,
          device: { cores: DEV_CORES, mem: DEV_MEM, tier: T },
          net: { ...NET }, fps: fpsC, lowPower, thrOn,
          mem: { ...Mem.stats(), heapMB: heapMB() },
          lcp: this.lcp(), dns: this.dns(), csp: this.csp(),
          dlock: this.dlock(), imgfmt: this.imgfmt(), sched: this.sched,
        };
      },
      help() {
        console.log([
          `Turbo Optimizer v${V} (Non-blocking)`,
          '─'.repeat(48),
          '.stats()  전체     .fps()    FPS',
          '.memory() 메모리   .net()    네트워크',
          '.device() HW       .lcp()    LCP 상태',
          '.dns()    DNS 힌트  .csp()    CSP (directive별)',
          '.dlock()  D-Lock   .imgfmt() 이미지 포맷',
          '─'.repeat(48),
          '✦ IO-based viewport detection (reflow 제로)',
          '✦ CSP directive-aware 차단 (connect/img/default 분리)',
          '✦ ResourceTiming PerformanceObserver 실시간 DNS 빈도',
          '✦ createImageBitmap 비동기 포맷 감지',
          '✦ MutationObserver TreeWalker 단일순회 (깊이 제한)',
          '✦ Race-free 배치 버퍼 (이중 버퍼 버그 수정)',
          '✦ Passive event 캐시 객체 (GC 압력 제거)',
          '✦ DisplayLock IO boundingClientRect (reflow 제거)',
          '✦ Paint Hold (SPA 전환 지터 방지)',
          '✦ Preload budget control (과도한 preload 조절)',
          '✦ Data saver 동적 speculation/prefetch 제거',
          '✦ 모든 v13.7 기능 유지 + 성능 업그레이드',
        ].join('\n'));
      }
    });

    console.log(
      `[TO v${V}] ✅ ${AI ? 'AI' : 'Gen'} ` +
      `${T}(${DEV_CORES}c/${DEV_MEM}G) ` +
      `${NET.etype}${NET.save ? '/s' : ''} ` +
      `S:${hasPT ? 'pT' : hasYld ? 'y' : 'fb'} ` + HOST
    );
  }
})();
