// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      14.0
// @description  Non-blocking web optimizer v14.0 – Trusted Types safe, IO-based viewport, batched DNS via RT observer, CSP directive-aware, Display Locking, img sizes fix, all features maintained & upgraded.
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
     §0-TT  TRUSTED TYPES POLICY (최우선 실행)
     ═══════════════════════════════════════
     목적: require-trusted-types-for 'script' CSP가 있는 사이트에서
     style.textContent, script.textContent 등 DOM 싱크 할당 차단 방지.

     전략:
     1) default policy가 없으면 → default policy 생성 (자동 passthrough)
     2) default policy가 이미 있으면 → named policy 생성 + 헬퍼 함수 제공
     3) trustedTypes 자체가 없으면 (CSP 미적용) → 단순 passthrough 함수

     ★ document-start에서 다른 어떤 DOM 조작보다 먼저 실행.
  */
  const TT = (() => {
    const passthrough = {
      createHTML: (s) => s,
      createScript: (s) => s,
      createScriptURL: (s) => s,
    };

    // trustedTypes API가 없으면 → TT 미적용 사이트, 그냥 문자열 반환
    if (typeof trustedTypes === 'undefined' || !trustedTypes.createPolicy) {
      return {
        html: (s) => s,
        script: (s) => s,
        scriptURL: (s) => s,
        active: false,
      };
    }

    let policy = null;

    try {
      // 시도 1: default policy 생성 (사이트보다 먼저 실행되므로 대부분 성공)
      if (!trustedTypes.defaultPolicy) {
        policy = trustedTypes.createPolicy('default', passthrough);
      }
    } catch (_) {
      // trusted-types CSP가 'default' 이름을 허용하지 않는 경우
    }

    if (!policy) {
      try {
        // 시도 2: named policy 생성
        policy = trustedTypes.createPolicy('turbo-optimizer', passthrough);
      } catch (_) {
        // 모든 policy 생성이 차단된 경우 — 최후 수단
      }
    }

    if (policy) {
      return {
        html: (s) => policy.createHTML(s),
        script: (s) => policy.createScript(s),
        scriptURL: (s) => policy.createScriptURL(s),
        active: true,
        isDefault: policy.name === 'default',
      };
    }

    // policy 생성 자체가 불가능한 극단적 CSP
    // → DOM 싱크 사용을 완전히 회피하는 경로로 분기
    return {
      html: (s) => s,
      script: (s) => s,
      scriptURL: (s) => s,
      active: false,
      blocked: true,
    };
  })();

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
     §0-b  SCHEDULER
     ═══════════════════════════════════════ */
  const hasPT  = typeof globalThis.scheduler?.postTask === 'function';
  const hasYld = typeof globalThis.scheduler?.yield === 'function';
  const hasRIC = typeof requestIdleCallback === 'function';

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
     ═══════════════════════════════════════ */
  const CSP = (() => {
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
      isConnectBlocked: (o) => byDir.get('connect-src')?.has(o) ?? false,
      isDnsBlocked: (o) => {
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
     §1  PASSIVE EVENT HOOK — 캐시 객체
     ═══════════════════════════════════════ */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll', 'touchstart', 'touchmove']);
  const _OPTS = {
    pf: Object.freeze({ passive: true, capture: false }),
    pt: Object.freeze({ passive: true, capture: true }),
  };
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) {
      if (!o || o === false) return _ael.call(this, t, fn, _OPTS.pf);
      if (o === true) return _ael.call(this, t, fn, _OPTS.pt);
      if (typeof o === 'object' && !o.passive) o.passive = true;
    }
    return _ael.call(this, t, fn, o);
  };

  if (HTMLCanvasElement?.prototype?.transferControlToOffscreen) {
    const _tr = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
      this.dataset.offscreen = '1'; return _tr.call(this);
    };
  }

  console.log(`[TO v${V}] P1✓ ${T}/${NET.etype} TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? 'blocked' : 'n/a')}`);

  /* ═══════════════════════════════════════
     §0-d  TRUSTED TYPES 안전한 DOM 헬퍼
     ═══════════════════════════════════════
     모든 DOM 싱크 할당을 이 헬퍼를 통해 수행.
     TT default policy가 있으면 자동 통과하지만,
     named policy인 경우 명시적 wrapping 필요.
  */
  const safeSetText = (el, text) => {
    // style 요소 → textContent는 TrustedHTML이 아닌 일반 텍스트이지만,
    // 일부 브라우저는 TT 강제 시 style.textContent도 차단.
    // → textContent 대신 sheet API 또는 adoptedStyleSheets 사용 시도.
    if (el.tagName === 'STYLE') {
      // 방법 1: default policy가 있으면 textContent 직접 할당
      if (TT.isDefault) {
        el.textContent = text; // default policy가 자동 변환
        return true;
      }
      // 방법 2: named policy → TT.html로 wrapping
      if (TT.active) {
        try { el.textContent = TT.script(text); return true; } catch (_) {}
      }
      // 방법 3: appendChild(document.createTextNode()) — TT 우회
      try {
        el.appendChild(document.createTextNode(text));
        return true;
      } catch (_) {}
      return false;
    }
    if (el.tagName === 'SCRIPT') {
      // default policy → 자동 통과
      if (TT.isDefault) {
        el.textContent = text;
        return true;
      }
      // named policy → 명시적 wrapping
      if (TT.active) {
        try { el.textContent = TT.script(text); return true; } catch (_) {}
      }
      // TT 완전 차단 → script 삽입 불가, false 반환
      return false;
    }
    // 일반 요소
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
       §6  CSS — Trusted Types 안전 삽입
       ═══════════════════════════════════════
       ★ 3가지 폴백 경로:
       1) adoptedStyleSheets (TT 완전 우회, 최신 브라우저)
       2) safeSetText (TT policy 기반)
       3) createTextNode (TT policy 없이도 가능)
    */
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

    /** Style 삽입 — adoptedStyleSheets 우선, 폴백으로 <style> */
    let lS_sheet = null; // low-power 토글용 참조
    const useAdopted = typeof CSSStyleSheet === 'function' && 'replace' in CSSStyleSheet.prototype;

    if (useAdopted) {
      // ★ adoptedStyleSheets: TT 완전 우회 (DOM 싱크 아님)
      try {
        const hSheet = new CSSStyleSheet();
        hSheet.replaceSync(hCSS);

        const lpSheet = new CSSStyleSheet();
        lpSheet.replaceSync(lpCSS);
        lS_sheet = lpSheet;

        // hSheet는 항상 활성, lpSheet는 조건부 추가
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, hSheet];
      } catch (_) {
        // 폴백 → <style> 요소
        insertStyleFallback();
      }
    } else {
      insertStyleFallback();
    }

    // <style> 폴백 변수
    let lS = null; // low-power style element (disabled 토글용)

    function insertStyleFallback() {
      const hS = document.createElement('style');
      hS.id = 'tb-h';
      safeSetText(hS, hCSS);

      lS = document.createElement('style');
      lS.id = 'tb-lp';
      lS.disabled = true;
      safeSetText(lS, lpCSS);

      (document.head || document.documentElement).append(hS, lS);
    }

    /** Low-power 모드 토글 */
    const setLowPower = (on) => {
      if (useAdopted && lS_sheet) {
        const sheets = document.adoptedStyleSheets;
        const idx = sheets.indexOf(lS_sheet);
        if (on && idx === -1) {
          document.adoptedStyleSheets = [...sheets, lS_sheet];
        } else if (!on && idx !== -1) {
          document.adoptedStyleSheets = sheets.filter(s => s !== lS_sheet);
        }
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
    window.setInterval = function (fn, d, ...a) {
      if (thrOn && typeof d === 'number' && d < CFG.thrMin) d = CFG.thrMin;
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

    const heapMB = () => {
      try { if (performance.memory) return ((performance.memory.usedJSHeapSize / 1048576) + .5) | 0; } catch (_) {}
      return null;
    };

    /* ═══════════════════════════════════════
       §10  VIEWPORT — IntersectionObserver 기반
       ═══════════════════════════════════════ */
    const done = new WeakSet();
    const vpMap = new WeakMap();

    const vpIO = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        vpMap.set(e.target, e.isIntersecting);
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
        const inVP = vpMap.get(el) ?? true;
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
       §11  MUTATION OBSERVER — TreeWalker 단일 순회
       ═══════════════════════════════════════ */
    const M_TAGS = new Set(['IMG', 'IFRAME', 'VIDEO']);
    const SRC_TAGS = new Set(['IMG', 'SCRIPT', 'IFRAME', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK']);
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
      for (let i = 0; i < len; i++) {
        const n = batch[i];
        const tag = n.tagName;

        if (M_TAGS.has(tag)) enrollMedia(n);
        if (SRC_TAGS.has(tag)) DnsHints.trackNode(n);

        if (n.children && n.children.length > 0) {
          const tw = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT, {
            acceptNode(node) {
              const t = node.tagName;
              if (M_TAGS.has(t) || SRC_TAGS.has(t)) return NodeFilter.FILTER_ACCEPT;
              return node.parentElement === n || node.parentElement?.parentElement === n
                ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_REJECT;
            }
          });
          let child;
          while ((child = tw.nextNode())) {
            if (M_TAGS.has(child.tagName)) enrollMedia(child);
            if (SRC_TAGS.has(child.tagName)) DnsHints.trackNode(child);
          }
        }

        if (i > 0 && i % CFG.yldN === 0) await yld();
      }

      DnsHints.flushFrag();

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
       §13  DNS-PREFETCH / PRECONNECT
       ═══════════════════════════════════════ */
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

        const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
        for (let i = 0; i < sorted.length && pcCount < CFG.dnsMaxPc; i++) {
          addPc(sorted[i][0]);
          addDns(sorted[i][0]);
        }

        if (!document.body) { flushFrag(); return; }
        const tw = document.createTreeWalker(
          document.body, NodeFilter.SHOW_ELEMENT,
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
       §14-c  SPECULATION RULES — Trusted Types 안전
       ═══════════════════════════════════════
       ★ 에러가 발생했던 핵심 위치.
       script.textContent = JSON.stringify(rules) → TrustedScript 필요.

       해결:
       1) safeSetText 헬퍼 사용
       2) TT가 완전 차단된 경우 → speculation rules 삽입 자체 포기
          (기능 다운그레이드 아님 — 해당 사이트의 CSP 정책 존중)
    */
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

        // ★ Trusted Types 안전 삽입
        const ok = safeSetText(script, JSON.stringify(rules));
        if (ok) {
          document.head.appendChild(script);
        } else {
          // TT 정책이 script 삽입을 완전 차단 → 대안: <link rel="prefetch">
          // speculation rules보다 범위는 좁지만 prefetch 기능은 유지
          try {
            const links = document.querySelectorAll('a[href^="/"]');
            const budget = Math.min(links.length, 3);
            for (let i = 0; i < budget; i++) {
              const l = document.createElement('link');
              l.rel = 'prefetch';
              l.href = links[i].href;
              document.head.appendChild(l);
            }
          } catch (_) {}
        }
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
          if (fpsC < CFG.fpsLo && !lowPower)     { lowPower = true;  setLowPower(true);  setWC('auto'); }
          else if (fpsC > CFG.fpsHi && lowPower)  { lowPower = false; setLowPower(false); setWC('scroll-position'); }
        }
      }
      requestAnimationFrame(fpsTick);
    };
    requestAnimationFrame(fpsTick);

    /* ═══════════════════════════════════════
       §16  SPA NAVIGATION
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

    /* ─── §17 TAB RESUME + bfcache ─── */
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

    /* ─── §17-b FETCH / XHR dns-prefetch ─── */
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

    /* ─── §18 LONG TASK / LoAF ─── */
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

    /* ─── §19 SOFT GC + IDLE SWEEP ─── */
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
       §21  DISPLAY LOCKING
       ═══════════════════════════════════════ */
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
       ═══════════════════════════════════════ */
    const ImgFormat = (() => {
      let avif = false, webp = false;
      let hinted = 0, sizesFixed = 0;

      const detectFormats = async () => {
        const test = async (blob) => {
          try { const bmp = await createImageBitmap(blob); bmp.close(); return true; }
          catch (_) { return false; }
        };
        try {
          const avifBlob = new Blob([new Uint8Array([
            0,0,0,28,102,116,121,112,97,118,105,102,0,0,0,0,97,118,105,102,109,105,102,49,109,105,97,102
          ])], { type: 'image/avif' });
          avif = await test(avifBlob);
        } catch (_) {}
        try {
          const webpBlob = new Blob([new Uint8Array([
            82,73,70,70,36,0,0,0,87,69,66,80,86,80,56,32,24,0,0,0,48,1,0,157,1,42,1,0,1,0,1,64,37,164,0,3,112,0,254,251,148,0,0
          ])], { type: 'image/webp' });
          webp = await test(webpBlob);
        } catch (_) {}
      };

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
          if (!img.sizes || img.sizes === '100vw') {
            const w = img.clientWidth || img.offsetWidth;
            if (w > 0 && w < innerWidth * 0.9) {
              img.sizes = `${w}px`;
              sizesFixed++;
            }
          }
        }
      };

      detectFormats();
      return { scan, stats: () => ({ avif, webp, hinted, sizesFixed }) };
    })();

    if (document.readyState === 'complete') {
      sched(() => ImgFormat.scan());
    } else {
      addEventListener('load', () => sched(() => ImgFormat.scan()), { once: true });
    }

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
        if (NET.save || NET.slow) {
          const specScripts = document.querySelectorAll('script[type="speculationrules"]');
          for (let i = 0; i < specScripts.length; i++) specScripts[i].remove();
          const pfLinks = document.querySelectorAll('link[rel="prefetch"]');
          for (let i = 0; i < pfLinks.length; i++) pfLinks[i].remove();
        }
      });
    }

    /* ─── §25 PAINT HOLD (SPA) ─── */
    const paintHold = (() => {
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

    // history.pushState는 이미 §16에서 래핑됨 — paint hold를 기존 래퍼에 통합
    const _hp_orig = history.pushState; // §16에서 이미 래핑된 버전
    history.pushState = function (...a) {
      paintHold.hold();
      const r = _hp_orig.apply(this, a);
      requestAnimationFrame(() => paintHold.release());
      return r;
    };

    /* ═══════════════════════════════════════
       §20  DIAGNOSTIC
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
      tt:       () => ({ active: TT.active, isDefault: TT.isDefault, blocked: !!TT.blocked }),
      sched:    { postTask: hasPT, yield: hasYld },
      stats() {
        return {
          v: V, host: HOST, ai: AI,
          device: { cores: DEV_CORES, mem: DEV_MEM, tier: T },
          net: { ...NET }, fps: fpsC, lowPower, thrOn,
          mem: { ...Mem.stats(), heapMB: heapMB() },
          lcp: this.lcp(), dns: this.dns(), csp: this.csp(),
          dlock: this.dlock(), imgfmt: this.imgfmt(),
          tt: this.tt(), sched: this.sched,
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
          '.tt()     Trusted Types 상태',
          '─'.repeat(48),
          '✦ Trusted Types default/named policy 자동 생성',
          '✦ adoptedStyleSheets TT 완전 우회',
          '✦ safeSetText 3단 폴백 (TT→createTextNode)',
          '✦ speculation rules TT 안전 삽입 + link prefetch 폴백',
          '✦ IO-based viewport detection (reflow 제로)',
          '✦ CSP directive-aware 차단 분리',
          '✦ ResourceTiming PerfObserver 실시간 DNS 빈도',
          '✦ createImageBitmap 비동기 포맷 감지',
          '✦ MO TreeWalker 깊이제한 단일순회',
          '✦ Race-free 배치 버퍼',
          '✦ Passive event 캐시 객체',
          '✦ DisplayLock IO boundingClientRect',
          '✦ Paint Hold (SPA 전환)',
          '✦ Preload budget + Data saver 동적 제거',
        ].join('\n'));
      }
    });

    console.log(
      `[TO v${V}] ✅ ${AI ? 'AI' : 'Gen'} ` +
      `${T}(${DEV_CORES}c/${DEV_MEM}G) ` +
      `${NET.etype}${NET.save ? '/s' : ''} ` +
      `S:${hasPT ? 'pT' : hasYld ? 'y' : 'fb'} ` +
      `TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? '✗' : 'n/a')} ` +
      HOST
    );
  }
})();
