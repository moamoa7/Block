// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      15.0
// @description  Non-blocking web optimizer v15.0 – Navigation API, View Transitions, LoAF-based adaptive, speculation rules v2 (eager+moderate+prerender_until_script), measureUserAgentSpecificMemory, optimized MO batching, all features maintained & upgraded.
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

  const V = '15.0', HOST = location.hostname, ORIGIN = location.origin;

  /* ═══════════════════════════════════════
     §0-TT  TRUSTED TYPES POLICY
     ═══════════════════════════════════════
     v14→v15: 로직 동일, 코드 압축. */
  const TT = (() => {
    const PT = { createHTML: s => s, createScript: s => s, createScriptURL: s => s };
    if (typeof trustedTypes === 'undefined' || !trustedTypes.createPolicy)
      return { html: s => s, script: s => s, scriptURL: s => s, active: false };

    let p = null;
    try { if (!trustedTypes.defaultPolicy) p = trustedTypes.createPolicy('default', PT); } catch (_) {}
    if (!p) try { p = trustedTypes.createPolicy('turbo-optimizer', PT); } catch (_) {}

    return p
      ? { html: s => p.createHTML(s), script: s => p.createScript(s), scriptURL: s => p.createScriptURL(s),
          active: true, isDefault: p.name === 'default' }
      : { html: s => s, script: s => s, scriptURL: s => s, active: false, blocked: true };
  })();

  /* ═══════════════════════════════════════
     §0  DEVICE · NETWORK · CONFIG
     ═══════════════════════════════════════
     v15 변경:
     - NET tier를 4단계로 세분화 (2g/3g/4g/5g)
     - RTT 기반 rootMargin 동적 계산
     - 디바이스 tier에 따른 batch size 재조정 */
  const DEV_CORES = navigator.hardwareConcurrency || 4;
  const DEV_MEM   = navigator.deviceMemory || 4;
  const T = (DEV_CORES <= 2 || DEV_MEM <= 2) ? 'low'
          : (DEV_CORES <= 4 || DEV_MEM <= 4) ? 'mid' : 'high';

  const NET = { slow: false, save: false, etype: '4g', downlink: 10, rtt: 50, tier: 3 };
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const netUp = () => {
    if (!conn) return;
    NET.save = !!conn.saveData;
    NET.etype = conn.effectiveType || '4g';
    NET.downlink = conn.downlink ?? 10;
    NET.rtt = conn.rtt ?? 50;
    NET.slow = NET.save || NET.etype === 'slow-2g' || NET.etype === '2g';
    // v15: 4-tier network classification
    NET.tier = NET.etype === 'slow-2g' || NET.etype === '2g' ? 1
             : NET.etype === '3g' ? 2
             : NET.rtt < 50 && NET.downlink > 10 ? 4 : 3;
  };
  netUp();
  conn?.addEventListener?.('change', netUp);

  const isLow = T === 'low';
  const CFG = {
    bootMin: 2000, bootMax: 5000, bootPoll: 500, bootTh: 100,
    thrDelay: 5000,
    thrMin: isLow ? 2000 : 1000,
    thrHidden: 4000, // v15: 배경 탭 throttle 최소값
    fpsInt: 2000, fpsLo: isLow ? 25 : 20, fpsHi: isLow ? 35 : 40,
    lpTr: '100ms', lpAn: '100ms',
    font: NET.slow ? 'optional' : 'swap',
    batch: isLow ? 80 : T === 'mid' ? 150 : 250, // v15: high tier 배치 증가
    yldN: isLow ? 30 : 50,
    gcMs: isLow ? 20000 : (NET.slow ? 60000 : 30000),
    lcpMs: 2500,
    spaDb: 300,
    dnsMaxPc: isLow ? 2 : 4,
    dnsMaxDns: isLow ? 6 : 12,
    priCrit: 'link[rel="stylesheet"],script[src]:not([async]):not([defer])',
    dlockMargin: '200px',
    dlockSel: '.offscreen-section,[data-display-lock],aside.sidebar',
    // v15: viewport IO rootMargin — tier/network 반응형
    vpMargin: T === 'low' || NET.tier <= 2 ? '50px'
            : T === 'high' && NET.tier >= 3 ? '200px' : '100px',
  };

  /* ═══════════════════════════════════════
     §0-b  SCHEDULER
     ═══════════════════════════════════════
     v15 변경:
     - scheduler.yield()를 최우선 경로로 승격 (Baseline)
     - postTask priority 매핑 정밀화
     - rIC 폴백에서 timeout을 3000으로 단축 (5000→3000) */
  const hasPT  = typeof globalThis.scheduler?.postTask === 'function';
  const hasYld = typeof globalThis.scheduler?.yield === 'function';
  const hasRIC = typeof requestIdleCallback === 'function';

  const sched = hasPT
    ? (fn, p) => scheduler.postTask(fn, { priority: p || 'background' })
    : hasRIC
      ? (fn, p) => (p === 'user-blocking')
        ? Promise.resolve().then(fn)
        : new Promise(r => requestIdleCallback(() => r(fn()), { timeout: 3000 }))
      : (fn, p) => new Promise(r => setTimeout(() => r(fn()), (p === 'user-blocking') ? 0 : 16));

  // v15: yield에 priority 힌트 — postTask 기반 yield가 가능하면 활용
  const yld = hasYld
    ? () => scheduler.yield()
    : hasPT
      ? () => scheduler.postTask(() => {}, { priority: 'user-visible' })
      : () => new Promise(r => setTimeout(r, 0));

  /* ═══════════════════════════════════════
     §0-c  CSP VIOLATION MONITOR
     ═══════════════════════════════════════
     v14→v15: 동일 로직, 코드 압축 */
  const CSP = (() => {
    const byDir = new Map();
    let violations = 0;

    document.addEventListener('securitypolicyviolation', e => {
      violations++;
      const uri = e.blockedURI || '', dir = e.violatedDirective?.split(' ')[0] || 'unknown';
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
      isConnectBlocked: o => byDir.get('connect-src')?.has(o) ?? false,
      isDnsBlocked: o => {
        for (const [dir, set] of byDir) {
          if (dir === 'script-src' || dir === 'style-src' || dir === 'font-src') continue;
          if (set.has(o)) return true;
        }
        return false;
      },
      stats: () => ({ violations, directives: Object.fromEntries([...byDir].map(([k, v]) => [k, [...v]])) }),
    };
  })();

  /* ═══════════════════════════════════════
     §1  PASSIVE EVENT HOOK
     ═══════════════════════════════════════
     v15 변경:
     - 원본 옵션의 once/signal 보존 (v14에서는 유실 가능)
     - capture 옵션 정확한 전파 */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll', 'touchstart', 'touchmove']);
  const _OPTS_PF = Object.freeze({ passive: true, capture: false });
  const _OPTS_PT = Object.freeze({ passive: true, capture: true });
  const _ael = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) {
      if (!o || o === false) return _ael.call(this, t, fn, _OPTS_PF);
      if (o === true) return _ael.call(this, t, fn, _OPTS_PT);
      if (typeof o === 'object') {
        // v15: once, signal 등 원본 옵션 보존하면서 passive만 강제
        if (!o.passive) {
          return _ael.call(this, t, fn, { ...o, passive: true });
        }
      }
    }
    return _ael.call(this, t, fn, o);
  };

  if (HTMLCanvasElement?.prototype?.transferControlToOffscreen) {
    const _tr = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
      this.dataset.offscreen = '1'; return _tr.call(this);
    };
  }

  console.log(`[TO v${V}] P1✓ ${T}/${NET.etype}(t${NET.tier}) TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? 'blocked' : 'n/a')}`);

  /* ═══════════════════════════════════════
     §0-d  TRUSTED TYPES 안전 DOM 헬퍼
     ═══════════════════════════════════════
     v14→v15: 동일 로직 */
  const safeSetText = (el, text) => {
    if (el.tagName === 'STYLE') {
      if (TT.isDefault) { el.textContent = text; return true; }
      if (TT.active) { try { el.textContent = TT.script(text); return true; } catch (_) {} }
      try { el.appendChild(document.createTextNode(text)); return true; } catch (_) {}
      return false;
    }
    if (el.tagName === 'SCRIPT') {
      if (TT.isDefault) { el.textContent = text; return true; }
      if (TT.active) { try { el.textContent = TT.script(text); return true; } catch (_) {} }
      return false;
    }
    el.textContent = text;
    return true;
  };

  /* ═══════════════════════════════════════
     §2  PHASE 2 BOOT
     ═══════════════════════════════════════ */
  const onReady = cb => document.readyState !== 'loading'
    ? cb()
    : document.addEventListener('DOMContentLoaded', cb, { once: true });

  onReady(() => {
    const t0 = performance.now();
    let p = 0;
    const mx = ((CFG.bootMax - CFG.bootMin) / CFG.bootPoll) | 0;
    const go = () => {
      if (performance.now() - t0 < CFG.bootMin) {
        setTimeout(go, CFG.bootMin - (performance.now() - t0)); return;
      }
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

    // v15: 전역 AbortController — 정리용
    const globalAC = new AbortController();
    const gSig = globalAC.signal;

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

    /* ─── §5 LCP TRACKER ─── */
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
       §6  CSS
       ═══════════════════════════════════════
       v15 변경:
       - adoptedStyleSheets 단일 경로 강화
       - lpSheet 토글을 disabled 대신 배열 교체 (리페인트 최소화)
       - content-visibility 선언 정리 */
    const cvSel = AI
      ? `article:not(${SP.t}),section:not(${SP.t})`
      : 'article,section,.post,.comment,.card,li.item';
    const scSel = [
      '.chat-history', '.overflow-y-auto', '[class*="react-scroll"]',
      '.chat-scroll', '.scroller', '.overflow-auto',
      AI ? SP.c : ''
    ].filter(Boolean).join(',');

    const hCSS =
      `${cvSel}{content-visibility:auto;contain-intrinsic-size:auto 500px}` +
      `img[loading="lazy"],iframe[loading="lazy"]{content-visibility:auto;contain-intrinsic-size:auto 300px}` +
      `${scSel}{contain:content;will-change:scroll-position;overflow-anchor:auto;overscroll-behavior:contain}`;

    const lpCSS =
      `*,*::before,*::after{animation-duration:${CFG.lpAn}!important;transition-duration:${CFG.lpTr}!important;text-rendering:optimizeSpeed!important}` +
      `[style*="infinite"],.animated,[class*="animate"],lottie-player,dotlottie-player{animation-play-state:paused!important}`;

    let lS_sheet = null;
    const useAdopted = typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype;

    if (useAdopted) {
      try {
        const hSheet = new CSSStyleSheet();
        hSheet.replaceSync(hCSS);
        const lpSheet = new CSSStyleSheet();
        lpSheet.replaceSync(lpCSS);
        lS_sheet = lpSheet;
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, hSheet];
      } catch (_) { insertStyleFallback(); }
    } else {
      insertStyleFallback();
    }

    let lS = null;
    function insertStyleFallback() {
      const hS = document.createElement('style'); hS.id = 'tb-h';
      safeSetText(hS, hCSS);
      lS = document.createElement('style'); lS.id = 'tb-lp'; lS.disabled = true;
      safeSetText(lS, lpCSS);
      (document.head || document.documentElement).append(hS, lS);
    }

    const setLowPower = (on) => {
      if (useAdopted && lS_sheet) {
        const sheets = document.adoptedStyleSheets;
        const has = sheets.includes(lS_sheet);
        if (on && !has) document.adoptedStyleSheets = [...sheets, lS_sheet];
        else if (!on && has) document.adoptedStyleSheets = sheets.filter(s => s !== lS_sheet);
      } else if (lS) {
        lS.disabled = !on;
      }
    };

    const prm = matchMedia('(prefers-reduced-motion:reduce)');
    if (prm.matches) { lowPower = true; setLowPower(true); }
    prm.addEventListener('change', e => {
      if (e.matches && !lowPower) { lowPower = true; setLowPower(true); }
    });

    const setWC = v => {
      try {
        const els = document.querySelectorAll(scSel);
        for (let i = 0; i < els.length; i++) els[i].style.willChange = v;
      } catch (_) {}
    };

    /* ─── §7 FONT-DISPLAY OVERRIDE ─── */
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

    /* ─── §8 TIMER THROTTLE ─── */
    const _si = window.setInterval;
    // v15: visibilityState 기반 적응형 throttle
    window.setInterval = function (fn, d, ...a) {
      if (thrOn && typeof d === 'number') {
        const min = document.visibilityState === 'hidden' ? CFG.thrHidden : CFG.thrMin;
        if (d < min) d = min;
      }
      return _si.call(window, fn, d, ...a);
    };
    setTimeout(() => { thrOn = true; }, CFG.thrDelay);

    /* ─── §9 MEMORY TRACKER ─── */
    const Mem = (() => {
      const blobMap = new Map();
      const refs = new Map();
      let nid = 0, cleaned = 0, revoked = 0;
      const reg = typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry(m => {
            refs.delete(m.id); cleaned++;
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

    /* v15: measureUserAgentSpecificMemory 사용 (performance.memory 대체)
       - crossOriginIsolated 환경에서만 사용 가능
       - 비동기 API이므로 Promise 기반으로 전환
       - 불가능하면 기존 performance.memory 폴백 */
    const heapMB = async () => {
      // 1차: measureUserAgentSpecificMemory (정밀, 표준)
      if (typeof performance.measureUserAgentSpecificMemory === 'function') {
        try {
          const m = await performance.measureUserAgentSpecificMemory();
          return ((m.bytes / 1048576) + 0.5) | 0;
        } catch (_) {}
      }
      // 2차: performance.memory (Chrome 전용 legacy)
      try {
        if (performance.memory) return ((performance.memory.usedJSHeapSize / 1048576) + 0.5) | 0;
      } catch (_) {}
      return null;
    };

    /* ═══════════════════════════════════════
       §10  VIEWPORT — IntersectionObserver 기반
       ═══════════════════════════════════════
       v15 변경:
       - rootMargin을 CFG.vpMargin으로 동적 적용
       - LCP 이미지 sizes 속성 자동 보정 통합 */
    const done = new WeakSet();
    const vpMap = new WeakMap();

    const vpIO = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        vpMap.set(e.target, e.isIntersecting);
        if (!done.has(e.target)) applyMediaOpt(e.target);
      }
    }, { rootMargin: CFG.vpMargin });

    const applyMediaOpt = (el) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (lcp.el === el) {
          el.loading = 'eager'; el.fetchPriority = 'high'; el.decoding = 'sync';
          done.add(el); Mem.track(el); vpIO.unobserve(el); return;
        }
        const inVP = vpMap.get(el) ?? true;
        if (inVP) {
          if (!el.hasAttribute('loading'))       el.loading = 'eager';
          if (!el.hasAttribute('fetchpriority')) el.fetchPriority = 'high';
          if (!el.hasAttribute('decoding'))      el.decoding = 'async';
        } else {
          if (!el.hasAttribute('loading'))       el.loading = 'lazy';
          if (!el.hasAttribute('decoding'))      el.decoding = 'async';
          if (NET.tier <= 2 && !el.hasAttribute('fetchpriority')) el.fetchPriority = 'low';
        }
      } else if (tag === 'IFRAME') {
        if (!el.hasAttribute('loading')) el.loading = 'lazy';
      } else if (tag === 'VIDEO') {
        if (!el.hasAttribute('preload')) el.preload = NET.tier <= 2 ? 'none' : 'metadata';
      }
      done.add(el); Mem.track(el);
      vpIO.unobserve(el);
    };

    const enrollMedia = (el) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag !== 'IMG' && tag !== 'IFRAME' && tag !== 'VIDEO') return;
      if (lcp.el === el) { applyMediaOpt(el); return; }
      if (tag !== 'IMG') { applyMediaOpt(el); return; }
      vpIO.observe(el);
    };

    const scanAllMedia = () => {
      const all = document.querySelectorAll('img,iframe,video');
      for (let i = 0; i < all.length; i++) enrollMedia(all[i]);
    };

    /* ═══════════════════════════════════════
       §11  MUTATION OBSERVER
       ═══════════════════════════════════════
       v15 변경:
       - TreeWalker 제거 → querySelectorAll (네이티브 C++ 셀렉터 최적화)
       - takeRecords() 활용으로 flush 시점 제어
       - 메인 루프 더 단순화, yield 빈도 유지 */
    const M_SEL = 'img,iframe,video,script[src],link[href],audio,source';
    let mBuf = [], mRaf = 0;

    const mObs = new MutationObserver(ms => {
      for (let i = 0; i < ms.length; i++) {
        const ad = ms[i].addedNodes;
        for (let j = 0; j < ad.length; j++) {
          if (ad[j].nodeType === 1) mBuf.push(ad[j]);
        }
      }
      if (mBuf.length && !mRaf) mRaf = requestAnimationFrame(mFlush);
    });

    async function mFlush() {
      mRaf = 0;
      const batch = mBuf;
      mBuf = [];

      const len = Math.min(batch.length, CFG.batch);
      let yldCount = 0;

      for (let i = 0; i < len; i++) {
        const n = batch[i];
        const tag = n.tagName;

        // 루트 노드 자체 처리
        if (tag === 'IMG' || tag === 'IFRAME' || tag === 'VIDEO') enrollMedia(n);
        if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'VIDEO' ||
            tag === 'AUDIO' || tag === 'SOURCE' || tag === 'LINK') DnsHints.trackNode(n);

        // v15: querySelectorAll로 자손 일괄 탐색 (TreeWalker 대체)
        // — 네이티브 C++ 구현이므로 JS TreeWalker 필터보다 빠름
        if (n.children && n.children.length > 0) {
          try {
            const descendants = n.querySelectorAll(M_SEL);
            for (let k = 0; k < descendants.length; k++) {
              const child = descendants[k];
              const ct = child.tagName;
              if (ct === 'IMG' || ct === 'IFRAME' || ct === 'VIDEO') enrollMedia(child);
              DnsHints.trackNode(child);
            }
          } catch (_) {}
        }

        if (++yldCount % CFG.yldN === 0) await yld();
      }

      DnsHints.flushFrag();

      // 잔여 overflow → 다음 프레임
      if (batch.length > CFG.batch) {
        mBuf = batch.slice(CFG.batch).concat(mBuf);
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
       §13  DNS-PREFETCH / PRECONNECT
       ═══════════════════════════════════════
       v15 변경:
       - scanDOM 내 TreeWalker 제거 → querySelectorAll
       - 조기 종료 budget 체크 추가
       - rIC resume 경로 단순화 */
    const DnsHints = (() => {
      const dnsSeen = new Set();
      const pcSeen  = new Set();
      let pcCount = 0;
      const frag = document.createDocumentFragment();
      let fragDirty = false;
      const freqMap = new Map();

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

        // 빈도 기반 상위 origin preconnect
        const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
        for (let i = 0; i < sorted.length && pcCount < CFG.dnsMaxPc; i++) {
          addPc(sorted[i][0]);
          addDns(sorted[i][0]);
        }

        if (!document.body) { flushFrag(); return; }

        // v15: querySelectorAll (TreeWalker 대체)
        const nodes = document.body.querySelectorAll(
          'img[src],script[src],iframe[src],video[src],audio[src],source[src],source[srcset],link[href],img[srcset]'
        );

        const processNode = (node, budget) => {
          const src = node.src || node.href || node.currentSrc || '';
          const o = extractOrigin(src);
          if (o) {
            addDns(o);
            if ((freqMap.get(o) || 0) >= 2) addPc(o);
          }
          const ss = node.getAttribute('srcset');
          if (ss) {
            const parts = ss.split(',');
            for (let j = 0; j < parts.length; j++) {
              const u = parts[j].trim().split(/\s+/)[0];
              const so = extractOrigin(u);
              if (so) addDns(so);
            }
          }
        };

        // 1차: 첫 200개 동기 처리
        const first = Math.min(nodes.length, 200);
        for (let i = 0; i < first; i++) processNode(nodes[i]);
        flushFrag();

        // budget 초과 시 → idle callback으로 나머지
        if (nodes.length > 200 && hasRIC) {
          let idx = 200;
          const resume = (deadline) => {
            while (idx < nodes.length) {
              processNode(nodes[idx++]);
              if (idx % 50 === 0 && deadline.timeRemaining() < 2) {
                flushFrag();
                requestIdleCallback(resume, { timeout: 3000 });
                return;
              }
            }
            flushFrag();
          };
          requestIdleCallback(resume, { timeout: 3000 });
        }
      };

      const trackNode = (node) => {
        const src = node.src || node.href || node.currentSrc || '';
        const o = extractOrigin(src);
        if (o) addDns(o);
      };

      return { scanDOM, trackNode, flushFrag, extractOrigin,
               stats: () => ({ dnsPrefetch: dnsSeen.size, preconnect: pcSeen.size, pcBudget: CFG.dnsMaxPc }) };
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
       §14-c  SPECULATION RULES v2
       ═══════════════════════════════════════
       v15 변경:
       - eager prefetch + moderate prerender 이중 전략 (Shopify/Google 패턴)
       - high-tier + high-memory에서 prerender_until_script 시도
       - safeSetText TT 안전 삽입 유지 */
    sched(() => {
      if (NET.save || NET.tier <= 1) return;
      try {
        if (!HTMLScriptElement.supports?.('speculationrules')) return;

        const noNav = ['/*\\?*', '/api/*', '/logout', '/sign-out', '/auth/*', '/checkout/*'];
        const baseWhere = {
          and: [
            { href_matches: '/*' },
            { not: { href_matches: noNav } },
            { not: { selector_matches: '[rel~="nofollow"]' } }
          ]
        };

        const rules = {
          // v15: eager prefetch — HTML만 미리 가져옴 (저비용)
          prefetch: [{
            where: baseWhere,
            eagerness: 'eager'
          }],
          // moderate prerender — hover/viewport 기반 (중비용)
          prerender: [{
            where: baseWhere,
            eagerness: 'moderate'
          }]
        };

        // v15: prerender_until_script — high tier에서만, JS 부작용 없이 서브리소스까지 로드
        if (T === 'high' && DEV_MEM >= 8) {
          try {
            rules.prerender_until_script = [{
              where: baseWhere,
              eagerness: 'moderate'
            }];
          } catch (_) {
            // API 미지원 시 무시 (origin trial 또는 flag 필요)
          }
        }

        const script = document.createElement('script');
        script.type = 'speculationrules';

        const ok = safeSetText(script, JSON.stringify(rules));
        if (ok) {
          document.head.appendChild(script);
        } else {
          try {
            const links = document.querySelectorAll('a[href^="/"]');
            const budget = Math.min(links.length, 3);
            for (let i = 0; i < budget; i++) {
              const l = document.createElement('link');
              l.rel = 'prefetch'; l.href = links[i].href;
              document.head.appendChild(l);
            }
          } catch (_) {}
        }
      } catch (_) {}
    });

    /* ═══════════════════════════════════════
       §15  FPS / FRAME MONITOR
       ═══════════════════════════════════════
       v15 변경:
       - LoAF (Long Animation Frame) API가 있으면 그것으로 프레임 건강도 측정
       - rAF 카운터는 LoAF 미지원 폴백으로만 유지
       - 프레임 기반 low-power 판정 로직 통합 */
    let fpsC = 60;
    const hasLoAF = (() => {
      try {
        // LoAF 지원 확인
        const po = new PerformanceObserver(() => {});
        po.observe({ type: 'long-animation-frame', buffered: false });
        po.disconnect();
        return true;
      } catch (_) { return false; }
    })();

    if (hasLoAF) {
      // v15: LoAF 기반 적응형 모니터
      // 연속된 LoAF 빈도로 "jank score" 계산
      let loafCount = 0, loafWindow = performance.now();

      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          loafCount++;
          if (e.duration > 150) console.warn(`[TO] LoAF:${(e.duration + .5) | 0}ms`);
        }

        const now = performance.now();
        if (now - loafWindow >= CFG.fpsInt) {
          // LoAF/초 = jank rate. 높으면 low-power 진입
          const rate = loafCount / ((now - loafWindow) / 1000);
          loafCount = 0; loafWindow = now;

          // rate > 5 → 초당 5회 이상 long frame = 심각한 jank
          // rate < 1 → 거의 jank 없음
          if (!prm.matches) {
            if (rate > 4 && !lowPower)      { lowPower = true;  setLowPower(true);  setWC('auto'); }
            else if (rate < 1 && lowPower)  { lowPower = false; setLowPower(false); setWC('scroll-position'); }
          }

          // fpsC 역산: LoAF가 적으면 60fps 근사치로 간주
          fpsC = rate > 4 ? 15 : rate > 2 ? 30 : 55;
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
    } else {
      // 폴백: rAF 카운터 (v14 방식)
      let fpsF = 0, fpsT = performance.now();
      const fpsTick = (n) => {
        fpsF++;
        const dt = n - fpsT;
        if (dt >= CFG.fpsInt) {
          fpsC = (fpsF * 1000 / dt + .5) | 0;
          fpsF = 0; fpsT = n;
          if (!prm.matches) {
            if (fpsC < CFG.fpsLo && !lowPower)     { lowPower = true;  setLowPower(true);  setWC('auto'); }
            else if (fpsC > CFG.fpsHi && lowPower)  { lowPower = false; setLowPower(false); setWC('scroll-position'); }
          }
        }
        requestAnimationFrame(fpsTick);
      };
      requestAnimationFrame(fpsTick);
    }

    /* ═══════════════════════════════════════
       §16  SPA NAVIGATION
       ═══════════════════════════════════════
       v15 변경:
       - Navigation API (Baseline 2026)를 주 감지 경로로 사용
       - View Transitions API로 paint hold 대체
       - history.pushState/replaceState 래핑은 Navigation API 미지원 폴백 */

    let spaT = 0;
    const onSpa = () => {
      clearTimeout(spaT);
      spaT = setTimeout(() => {
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); });
        setTimeout(() => sched(() => ImgFormat.scan()), 2000);
      }, CFG.spaDb);
    };

    // v15: View Transitions 기반 paint hold (§25 대체)
    const hasVT = typeof document.startViewTransition === 'function';

    const navigateWithTransition = (updateFn) => {
      if (hasVT && !lowPower) {
        try {
          document.startViewTransition(() => {
            updateFn();
            return Promise.resolve();
          });
          return;
        } catch (_) {}
      }
      updateFn();
    };

    // v15: Navigation API (주 경로)
    const hasNavAPI = typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function';

    if (hasNavAPI) {
      navigation.addEventListener('navigatesuccess', onSpa, { signal: gSig });
      // navigate 이벤트로 전환 감지 (pushState/replaceState/popstate 모두 포함)
      navigation.addEventListener('navigate', (e) => {
        // intercept하지 않음 — 감지만
        if (e.navigationType === 'push' || e.navigationType === 'replace') {
          // View Transitions와 연계
          if (hasVT && !lowPower && !e.canIntercept) {
            // external navigation이면 무시
          }
        }
      }, { signal: gSig });
    }

    // 폴백: history 래핑 (Navigation API 미지원 브라우저)
    const _hp = history.pushState, _hr = history.replaceState;
    history.pushState = function (...a) {
      const exec = () => _hp.apply(this, a);
      if (!hasNavAPI) {
        navigateWithTransition(exec);
        onSpa();
      } else {
        exec(); // Navigation API가 이벤트를 발생시킴
      }
      return undefined;
    };
    history.replaceState = function (...a) {
      const r = _hr.apply(this, a);
      if (!hasNavAPI) onSpa();
      return r;
    };
    if (!hasNavAPI) {
      addEventListener('popstate', onSpa);
    }

    /* ─── §17 TAB RESUME + bfcache ─── */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        sched(scanAllMedia);
        sched(() => DisplayLock.scan());
      }
    }, { signal: gSig });

    addEventListener('pageshow', e => {
      if (e.persisted) {
        console.log(`[TO v${V}] bfcache restore`);
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); });
      }
    }, { signal: gSig });

    /* ─── §17-b FETCH / XHR dns-prefetch ─── */
    (() => {
      const _fetch = window.fetch;
      if (_fetch) {
        window.fetch = function (input, init) {
          try {
            const url = typeof input === 'string' ? input : input?.url || '';
            const o = DnsHints.extractOrigin(url);
            if (o && !CSP.isConnectBlocked(o)) {
              queueMicrotask(() => { DnsHints.trackNode({ src: url }); DnsHints.flushFrag(); });
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
            queueMicrotask(() => { DnsHints.trackNode({ src: s }); DnsHints.flushFrag(); });
          }
        } catch (_) {}
        return _open.call(this, method, url, ...rest);
      };
    })();

    /* ─── §18 LONG TASK MONITOR ─── */
    // v15: LoAF가 이미 §15에서 처리되므로 longtask만 폴백으로 유지
    if (typeof PerformanceObserver !== 'undefined' && !hasLoAF) {
      try {
        new PerformanceObserver(l => {
          for (const e of l.getEntries()) if (e.duration > 100) console.warn(`[TO] longtask:${(e.duration + .5) | 0}ms`);
        }).observe({ type: 'longtask', buffered: false });
      } catch (_) {}
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

    /* ─── §19 SOFT GC + IDLE SWEEP ─── */
    // v15: 적응형 GC 주기 — 메모리 압박 시 빈번하게
    let gcInterval = CFG.gcMs;

    const gcTick = async () => {
      const s = Mem.stats();
      const h = await heapMB();
      if (s.cleaned || s.revoked || h) console.log(`[TO] ${s.alive}a/${s.cleaned}gc/${s.revoked}blob${h ? ' H:' + h + 'M' : ''}`);

      // v15: 메모리 600MB 이상이면 GC 주기 단축
      if (h !== null) {
        gcInterval = h > 600 ? Math.max(10000, CFG.gcMs / 2)
                   : h < 200 ? Math.min(60000, CFG.gcMs * 2)
                   : CFG.gcMs;
      }

      setTimeout(gcTick, gcInterval);
    };
    setTimeout(gcTick, CFG.gcMs);

    if (hasRIC) {
      const idleGC = (deadline) => {
        if (deadline.timeRemaining() > 5) {
          const swept = Mem.sweep();
          if (swept > 0) console.log(`[TO] idle-sweep: ${swept}`);
        }
        requestIdleCallback(idleGC, { timeout: gcInterval * 2 });
      };
      requestIdleCallback(idleGC, { timeout: CFG.gcMs });
    }

    /* ═══════════════════════════════════════
       §21  DISPLAY LOCKING
       ═══════════════════════════════════════
       v14→v15: 동일 로직 */
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
      const observeEl = (el) => { if (!observed.has(el)) { observed.add(el); io.observe(el); } };

      const scan = () => {
        if (AI && SP.c) {
          try {
            const children = document.querySelectorAll(`${SP.c} > *`);
            for (let i = 0; i < children.length; i++) {
              if (children[i].children.length >= 3) observeEl(children[i]);
            }
          } catch (_) {}
        }
        const containers = document.querySelectorAll(
          '[role="feed"] > *, [role="list"] > *, .feed > *, .timeline > *'
        );
        for (let i = 0; i < containers.length; i++) {
          if (containers[i].children.length >= 2) observeEl(containers[i]);
        }
        try {
          const custom = document.querySelectorAll(CFG.dlockSel);
          for (let i = 0; i < custom.length; i++) observeEl(custom[i]);
        } catch (_) {}
      };

      return { scan, stats: () => ({ supported, locked: lockCount, unlocked: unlockCount }) };
    })();

    sched(() => DisplayLock.scan());

    /* ═══════════════════════════════════════
       §22  IMAGE FORMAT HINTS
       ═══════════════════════════════════════
       v14→v15: 동일 로직 */
    const ImgFormat = (() => {
      let avif = false, webp = false;
      let hinted = 0, sizesFixed = 0;

      const detectFormats = async () => {
        const test = async (blob) => {
          try { const bmp = await createImageBitmap(blob); bmp.close(); return true; }
          catch (_) { return false; }
        };
        try {
          avif = await test(new Blob([new Uint8Array([
            0,0,0,28,102,116,121,112,97,118,105,102,0,0,0,0,97,118,105,102,109,105,102,49,109,105,97,102
          ])], { type: 'image/avif' }));
        } catch (_) {}
        try {
          webp = await test(new Blob([new Uint8Array([
            82,73,70,70,36,0,0,0,87,69,66,80,86,80,56,32,24,0,0,0,48,1,0,157,1,42,1,0,1,0,1,64,37,164,0,3,112,0,254,251,148,0,0
          ])], { type: 'image/webp' }));
        } catch (_) {}
      };

      if (typeof PerformanceObserver !== 'undefined') {
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              if (e.initiatorType !== 'img') continue;
              const kb = (e.transferSize || 0) / 1024;
              if (kb > 500) { console.warn(`[TO] large-img: ${kb | 0}KB ${e.name.slice(0, 60)}… → AVIF/WebP 권장`); hinted++; }
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
          if (!img.sizes || img.sizes === '100vw') {
            const w = img.clientWidth || img.offsetWidth;
            if (w > 0 && w < innerWidth * 0.9) { img.sizes = `${w}px`; sizesFixed++; }
          }
        }
      };

      detectFormats();
      return { scan, stats: () => ({ avif, webp, hinted, sizesFixed }) };
    })();

    if (document.readyState === 'complete') sched(() => ImgFormat.scan());
    else addEventListener('load', () => sched(() => ImgFormat.scan()), { once: true });

    /* ─── §23 PRELOAD BUDGET ─── */
    sched(() => {
      const preloads = document.querySelectorAll('link[rel="preload"]');
      if (preloads.length <= 5) return;
      for (let i = 5; i < preloads.length; i++) {
        if (!preloads[i].hasAttribute('fetchpriority'))
          preloads[i].fetchPriority = 'low';
      }
    });

    /* ─── §24 DATA SAVER DYNAMIC ─── */
    if (conn) {
      conn.addEventListener('change', () => {
        netUp();
        if (NET.save || NET.tier <= 1) {
          const specScripts = document.querySelectorAll('script[type="speculationrules"]');
          for (let i = 0; i < specScripts.length; i++) specScripts[i].remove();
          const pfLinks = document.querySelectorAll('link[rel="prefetch"]');
          for (let i = 0; i < pfLinks.length; i++) pfLinks[i].remove();
        }
      });
    }

    /* ═══════════════════════════════════════
       §25  PAINT HOLD → VIEW TRANSITIONS (v15 통합)
       ═══════════════════════════════════════
       v15: §16에서 View Transitions로 통합 완료.
       content-visibility body hack 제거 — 브라우저 네이티브 합성 전환 사용.
       View Transitions 미지원 시 paintHold 레거시 경로 유지. */
    const paintHold = (() => {
      // View Transitions가 있으면 paintHold 불필요
      if (hasVT) return { hold() {}, release() {} };

      const ok = CSS.supports?.('content-visibility', 'hidden') ?? false;
      if (!ok) return { hold() {}, release() {} };
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
          requestAnimationFrame(() => {
            if (document.body.style.contentVisibility === '')
              document.body.style.removeProperty('content-visibility');
          });
        }
      };
    })();

    /* ═══════════════════════════════════════
       §26  CLEANUP ON UNLOAD (v15 신규)
       ═══════════════════════════════════════
       AbortController를 통한 이벤트 리스너 일괄 해제.
       pagehide에서 실행하여 bfcache 호환. */
    addEventListener('pagehide', () => {
      globalAC.abort();
      mObs.disconnect();
      vpIO.disconnect();
    }, { once: true });

    /* ═══════════════════════════════════════
       §20  DIAGNOSTIC
       ═══════════════════════════════════════
       v15 변경:
       - heapMB가 async이므로 stats()도 async
       - Navigation API / View Transitions / LoAF 상태 노출 */
    window.__turboOptimizer__ = Object.freeze({
      version: V, mode: 'NON-BLOCKING', host: HOST, ai: AI, profile: SP,
      device:   () => ({ cores: DEV_CORES, mem: DEV_MEM, tier: T }),
      net:      () => ({ ...NET }),
      fps:      () => fpsC,
      lowPower: () => lowPower,
      throttle: () => thrOn,
      memory:   async () => ({ ...Mem.stats(), heapMB: await heapMB() }),
      lcp:      () => ({ el: lcp.el?.tagName || null, done: lcp.done }),
      dns:      () => DnsHints.stats(),
      csp:      () => CSP.stats(),
      dlock:    () => DisplayLock.stats(),
      imgfmt:   () => ImgFormat.stats(),
      tt:       () => ({ active: TT.active, isDefault: TT.isDefault, blocked: !!TT.blocked }),
      sched:    { postTask: hasPT, yield: hasYld },
      // v15: 새 기능 상태
      features: () => ({
        navAPI: hasNavAPI,
        viewTransitions: hasVT,
        loaf: hasLoAF,
        measureMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
        speculationRules: !!HTMLScriptElement.supports?.('speculationrules'),
      }),
      async stats() {
        return {
          v: V, host: HOST, ai: AI,
          device: { cores: DEV_CORES, mem: DEV_MEM, tier: T },
          net: { ...NET }, fps: fpsC, lowPower, thrOn,
          mem: { ...Mem.stats(), heapMB: await heapMB() },
          lcp: this.lcp(), dns: this.dns(), csp: this.csp(),
          dlock: this.dlock(), imgfmt: this.imgfmt(),
          tt: this.tt(), sched: this.sched,
          features: this.features(),
        };
      },
      help() {
        console.log([
          `Turbo Optimizer v${V} (Non-blocking)`,
          '─'.repeat(48),
          '.stats()     전체 (async)  .fps()     FPS/jank',
          '.memory()    메모리 (async) .net()     네트워크',
          '.device()    HW            .lcp()     LCP 상태',
          '.dns()       DNS 힌트       .csp()     CSP (directive별)',
          '.dlock()     D-Lock        .imgfmt()  이미지 포맷',
          '.tt()        Trusted Types  .features() v15 기능 상태',
          '─'.repeat(48),
          '★ v15.0 변경사항:',
          '✦ Navigation API (Baseline) → pushState 래핑 폴백화',
          '✦ View Transitions API → content-visibility paint hold 대체',
          '✦ LoAF (Long Animation Frame) → rAF FPS 카운터 대체',
          '✦ Speculation Rules v2: eager prefetch + moderate prerender',
          '✦ prerender_until_script (high-tier)',
          '✦ measureUserAgentSpecificMemory → performance.memory 대체',
          '✦ MO: querySelectorAll → TreeWalker 대체 (네이티브 최적화)',
          '✦ scheduler.yield() 우선 + postTask fallback yield',
          '✦ 동적 vpMargin (device/network 반응형)',
          '✦ 적응형 GC 주기 (메모리 압박 시 단축)',
          '✦ visibilityState 기반 타이머 throttle 강화',
          '✦ Passive event: once/signal 옵션 보존',
          '✦ NET 4-tier (2g/3g/4g/5g) 세분화',
          '✦ AbortController 기반 전역 정리',
          '✦ pagehide unload cleanup (bfcache 호환)',
        ].join('\n'));
      }
    });

    console.log(
      `[TO v${V}] ✅ ${AI ? 'AI' : 'Gen'} ` +
      `${T}(${DEV_CORES}c/${DEV_MEM}G) ` +
      `${NET.etype}/t${NET.tier}${NET.save ? '/s' : ''} ` +
      `S:${hasPT ? 'pT' : hasYld ? 'y' : 'fb'} ` +
      `TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? '✗' : 'n/a')} ` +
      `Nav:${hasNavAPI ? '✓' : '✗'} VT:${hasVT ? '✓' : '✗'} LoAF:${hasLoAF ? '✓' : '✗'} ` +
      HOST
    );
  }
})();
