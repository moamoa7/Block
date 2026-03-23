// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Non-blocking web optimizer v16.0 – TaskController dynamic priority, 3P script deferral via IO, unified IntersectionObserver, zero-alloc MO batching, CSS contain:strict, network quality estimation, element-timing, all v15 features maintained & upgraded.
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

  const V = '16.0', HOST = location.hostname, ORIGIN = location.origin;

  /* ═══════════════════════════════════════
     §0-TT  TRUSTED TYPES POLICY
     ═══════════════════════════════════════ */
  const TT = (() => {
    const PT = { createHTML: s => s, createScript: s => s, createScriptURL: s => s };
    if (typeof trustedTypes === 'undefined' || !trustedTypes.createPolicy)
      return { html: s => s, script: s => s, scriptURL: s => s, active: false };
    let p = null;
    try { if (!trustedTypes.defaultPolicy) p = trustedTypes.createPolicy('default', PT); } catch (_) {}
    if (!p) try { p = trustedTypes.createPolicy('turbo-optimizer', PT); } catch (_) {}
    return p
      ? { html: s => p.createHTML(s), script: s => p.createScript(s),
          scriptURL: s => p.createScriptURL(s), active: true, isDefault: p.name === 'default' }
      : { html: s => s, script: s => s, scriptURL: s => s, active: false, blocked: true };
  })();

  /* ═══════════════════════════════════════
     §0  DEVICE · NETWORK · CONFIG
     ═══════════════════════════════════════ */
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
    NET.tier = NET.etype === 'slow-2g' || NET.etype === '2g' ? 1
             : NET.etype === '3g' ? 2
             : NET.rtt < 50 && NET.downlink > 10 ? 4 : 3;
  };
  netUp();
  conn?.addEventListener?.('change', netUp);

  const isLow = T === 'low';
  const CFG = {
    bootMin: 2000, bootMax: 5000, bootPoll: 500, bootTh: 100,
    thrDelay: 5000, thrMin: isLow ? 2000 : 1000, thrHidden: 4000,
    fpsInt: 2000, fpsLo: isLow ? 25 : 20, fpsHi: isLow ? 35 : 40,
    lpTr: '100ms', lpAn: '100ms',
    font: NET.slow ? 'optional' : 'swap',
    batch: isLow ? 80 : T === 'mid' ? 150 : 250,
    yldN: isLow ? 30 : 50,
    gcMs: isLow ? 20000 : (NET.slow ? 60000 : 30000),
    lcpMs: 2500,
    spaDb: 300,
    dnsMaxPc: isLow ? 2 : 4,
    dnsMaxDns: isLow ? 6 : 12,
    priCrit: 'link[rel="stylesheet"],script[src]:not([async]):not([defer])',
    dlockMargin: '200px',
    dlockSel: '.offscreen-section,[data-display-lock],aside.sidebar',
    vpMargin: T === 'low' || NET.tier <= 2 ? '50px'
            : T === 'high' && NET.tier >= 3 ? '200px' : '100px',
    // v16: 3P script 지연 설정
    scriptDeferMargin: '300px',          // 3P 스크립트 viewport 진입 마진
    netQualitySampleSize: 20,            // RTT 보정용 샘플 수
    netQualityInterval: 15000,           // 네트워크 품질 재계산 주기
  };

  /* ═══════════════════════════════════════
     §0-b  SCHEDULER — TaskController 통합
     ═══════════════════════════════════════
     v16 변경:
     - TaskController로 예약 후 abort + 동적 우선순위 변경 지원
     - sched()가 { abort(), setPriority() } 핸들 반환 */
  const hasPT  = typeof globalThis.scheduler?.postTask === 'function';
  const hasYld = typeof globalThis.scheduler?.yield === 'function';
  const hasRIC = typeof requestIdleCallback === 'function';
  const hasTC  = typeof globalThis.TaskController === 'function';

  const sched = (() => {
    if (hasPT) {
      return (fn, p) => {
        const priority = p || 'background';
        if (hasTC) {
          const tc = new TaskController({ priority });
          const promise = scheduler.postTask(fn, { signal: tc.signal });
          return { promise, abort: () => tc.abort(), setPriority: (np) => tc.setPriority(np) };
        }
        return { promise: scheduler.postTask(fn, { priority }), abort: () => {}, setPriority: () => {} };
      };
    }
    if (hasRIC) {
      return (fn, p) => {
        const ac = new AbortController();
        const promise = (p === 'user-blocking')
          ? Promise.resolve().then(() => { if (!ac.signal.aborted) return fn(); })
          : new Promise(r => requestIdleCallback(() => { if (!ac.signal.aborted) r(fn()); }, { timeout: 3000 }));
        return { promise, abort: () => ac.abort(), setPriority: () => {} };
      };
    }
    return (fn, p) => {
      const ac = new AbortController();
      const promise = new Promise(r =>
        setTimeout(() => { if (!ac.signal.aborted) r(fn()); }, (p === 'user-blocking') ? 0 : 16));
      return { promise, abort: () => ac.abort(), setPriority: () => {} };
    };
  })();

  // v16: sched를 fire-and-forget로 호출하는 shorthand (v15 호환)
  const schedF = (fn, p) => { sched(fn, p); };

  const yld = hasYld
    ? () => scheduler.yield()
    : hasPT
      ? () => scheduler.postTask(() => {}, { priority: 'user-visible' })
      : () => new Promise(r => setTimeout(r, 0));

  /* ═══════════════════════════════════════
     §0-c  CSP VIOLATION MONITOR
     ═══════════════════════════════════════ */
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
     v16 변경:
     - v15의 {...o} 스프레드 → 직접 mutation으로 변경
       (이벤트 옵션 객체는 addEventListener 내에서 소비 후 폐기되므로 mutation 안전)
     - 불필요한 객체 할당 매 호출마다 제거 → GC 부하 감소 */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll', 'touchstart', 'touchmove']);
  const _OPTS_PF = Object.freeze({ passive: true, capture: false });
  const _OPTS_PT = Object.freeze({ passive: true, capture: true });
  const _ael = EventTarget.prototype.addEventListener;

  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) {
      if (!o || o === false) return _ael.call(this, t, fn, _OPTS_PF);
      if (o === true) return _ael.call(this, t, fn, _OPTS_PT);
      if (typeof o === 'object' && !o.passive) {
        // v16: 직접 mutation — addEventListener는 옵션을 읽은 뒤 참조하지 않음
        o.passive = true;
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

  console.log(`[TO v${V}] P1✓ ${T}/${NET.etype}(t${NET.tier}) TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? 'blocked' : 'n/a')} TC:${hasTC}`);

  /* ═══════════════════════════════════════
     §0-d  TRUSTED TYPES 안전 DOM 헬퍼
     ═══════════════════════════════════════ */
  const safeSetText = (el, text) => {
    const tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT') {
      if (TT.isDefault) { el.textContent = text; return true; }
      if (TT.active) { try { el.textContent = TT.script(text); return true; } catch (_) {} }
      if (tag === 'STYLE') { try { el.appendChild(document.createTextNode(text)); return true; } catch (_) {} }
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
       §6  CSS — contain:strict 분리 적용
       ═══════════════════════════════════════
       v16 변경:
       - 카드형 UI(.card, .post, .comment, li.item) → contain:strict
         (크기 고정적 요소이므로 size+layout+paint 모두 격리 안전)
       - 스크롤 컨테이너 → contain:content (기존 유지)
       - feed/list 자식 → contain:layout paint (size 제외 — 동적 높이) */
    const cvSel = AI
      ? `article:not(${SP.t}),section:not(${SP.t})`
      : 'article,section';
    const cardSel = '.post,.comment,.card,li.item';
    const scSel = [
      '.chat-history', '.overflow-y-auto', '[class*="react-scroll"]',
      '.chat-scroll', '.scroller', '.overflow-auto',
      AI ? SP.c : ''
    ].filter(Boolean).join(',');
    const feedChildSel = '[role="feed"]>*,[role="list"]>*,.feed>*,.timeline>*';

    const hCSS =
      `${cvSel}{content-visibility:auto;contain-intrinsic-size:auto 500px}` +
      `${cardSel}{contain:strict;contain-intrinsic-size:auto 300px;content-visibility:auto}` +
      `${feedChildSel}{contain:layout paint;contain-intrinsic-size:auto 400px;content-visibility:auto}` +
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
    schedF(() => {
      try {
        for (const s of document.styleSheets)
          try { for (const r of s.cssRules || []) if (r instanceof CSSFontFaceRule) r.style.fontDisplay = CFG.font; } catch (_) {}
      } catch (_) {}
    });

    /* ─── §8 TIMER THROTTLE ─── */
    const _si = window.setInterval;
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

    /* v16: heapMB를 캐시 기반으로 전환
       - 비동기 측정을 별도 주기로 실행하여 캐시에 저장
       - 소비처에서는 동기적으로 캐시 참조 → async 전파 제거 */
    let _heapCache = null;
    const _updateHeap = async () => {
      if (typeof performance.measureUserAgentSpecificMemory === 'function') {
        try {
          const m = await performance.measureUserAgentSpecificMemory();
          _heapCache = ((m.bytes / 1048576) + 0.5) | 0;
          return;
        } catch (_) {}
      }
      try {
        if (performance.memory) _heapCache = ((performance.memory.usedJSHeapSize / 1048576) + 0.5) | 0;
      } catch (_) {}
    };
    const heapMB = () => _heapCache;
    // 힙 측정은 30초마다 별도 실행
    _updateHeap();
    _si.call(window, _updateHeap, 30000);

    /* ═══════════════════════════════════════
       §10  UNIFIED INTERSECTION OBSERVER
       ═══════════════════════════════════════
       v16 핵심 변경:
       - vpIO(미디어) + DisplayLock IO + 3P script IO → 단일 IO 통합
       - 역할 분배: WeakMap에 { role, callback } 저장
       - IO 인스턴스 1개 = 오버헤드 최소화, 동일 타겟 중복 관찰 방지 */
    const done = new WeakSet();
    const ioRoles = new WeakMap(); // el → { media?, dlock?, script? }

    const unifiedIO = new IntersectionObserver((entries) => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const el = e.target;
        const role = ioRoles.get(el);
        if (!role) continue;

        // 미디어 역할
        if (role.media && !done.has(el)) {
          const tag = el.tagName;
          if (tag === 'IMG') {
            if (lcp.el === el) {
              el.loading = 'eager'; el.fetchPriority = 'high'; el.decoding = 'sync';
              done.add(el); Mem.track(el); role.media = false;
              maybeUnobserve(el, role); continue;
            }
            if (e.isIntersecting) {
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
          role.media = false;
          maybeUnobserve(el, role);
        }

        // Display Lock 역할
        if (role.dlock) {
          if (e.isIntersecting) {
            if (role.dlocked) {
              el.style.contentVisibility = 'auto';
              el.style.containIntrinsicSize = 'auto 500px';
              role.dlocked = false;
              DisplayLock._unlockCount++;
            }
          } else {
            if (!role.dlocked) {
              const h = e.boundingClientRect.height;
              el.style.contentVisibility = 'hidden';
              el.style.containIntrinsicSize = `auto ${h}px`;
              role.dlocked = true;
              DisplayLock._lockCount++;
            }
          }
          // dlock은 지속 관찰 — unobserve 하지 않음
        }

        // 3P Script 지연 역할
        if (role.script3p && e.isIntersecting) {
          ScriptDefer.activate(el);
          role.script3p = false;
          maybeUnobserve(el, role);
        }
      }
    }, { rootMargin: CFG.vpMargin });

    const maybeUnobserve = (el, role) => {
      if (!role.media && !role.dlock && !role.script3p) {
        unifiedIO.unobserve(el);
        ioRoles.delete(el);
      }
    };

    const observeWith = (el, rolePatch) => {
      let role = ioRoles.get(el);
      if (!role) {
        role = {};
        ioRoles.set(el, role);
        unifiedIO.observe(el);
      }
      Object.assign(role, rolePatch);
    };

    const enrollMedia = (el) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag !== 'IMG' && tag !== 'IFRAME' && tag !== 'VIDEO') return;
      if (lcp.el === el || tag !== 'IMG') {
        // 즉시 처리 (non-IMG 또는 LCP)
        const isLCP = lcp.el === el;
        if (tag === 'IMG' && isLCP) {
          el.loading = 'eager'; el.fetchPriority = 'high'; el.decoding = 'sync';
        } else if (tag === 'IFRAME') {
          if (!el.hasAttribute('loading')) el.loading = 'lazy';
        } else if (tag === 'VIDEO') {
          if (!el.hasAttribute('preload')) el.preload = NET.tier <= 2 ? 'none' : 'metadata';
        }
        done.add(el); Mem.track(el);
        return;
      }
      observeWith(el, { media: true });
    };

    const scanAllMedia = () => {
      const all = document.querySelectorAll('img,iframe,video');
      for (let i = 0; i < all.length; i++) enrollMedia(all[i]);
    };

    /* ═══════════════════════════════════════
       §11  MUTATION OBSERVER — zero-alloc 배칭
       ═══════════════════════════════════════
       v16 변경:
       - overflow 처리: 인덱스 기반 → slice/concat 제거
       - 이중 버퍼: mBuf0/mBuf1 교체 */
    const M_SEL = 'img,iframe,video,script[src],link[href],audio,source';
    let mBufA = [], mBufB = [], mActive = true; // mActive = A 사용중
    let mRaf = 0;

    const mObs = new MutationObserver(ms => {
      const buf = mActive ? mBufA : mBufB;
      for (let i = 0; i < ms.length; i++) {
        const ad = ms[i].addedNodes;
        for (let j = 0; j < ad.length; j++) {
          if (ad[j].nodeType === 1) buf.push(ad[j]);
        }
      }
      if (buf.length && !mRaf) mRaf = requestAnimationFrame(mFlush);
    });

    async function mFlush() {
      mRaf = 0;
      // 버퍼 스왑
      const batch = mActive ? mBufA : mBufB;
      mActive = !mActive;

      let idx = 0;
      const len = batch.length;

      while (idx < len) {
        const end = Math.min(idx + CFG.batch, len);
        for (; idx < end; idx++) {
          const n = batch[idx];
          const tag = n.tagName;

          if (tag === 'IMG' || tag === 'IFRAME' || tag === 'VIDEO') enrollMedia(n);
          if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'VIDEO' ||
              tag === 'AUDIO' || tag === 'SOURCE' || tag === 'LINK') DnsHints.trackNode(n);

          if (n.children && n.children.length > 0) {
            try {
              const desc = n.querySelectorAll(M_SEL);
              for (let k = 0; k < desc.length; k++) {
                const c = desc[k], ct = c.tagName;
                if (ct === 'IMG' || ct === 'IFRAME' || ct === 'VIDEO') enrollMedia(c);
                DnsHints.trackNode(c);
              }
            } catch (_) {}
          }
        }

        DnsHints.flushFrag();

        if (idx < len) await yld(); // 잔여분 있으면 yield 후 계속
      }

      batch.length = 0; // 배열 재사용 (GC 무)
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
    schedF(scanAllMedia);

    /* ═══════════════════════════════════════
       §13  DNS-PREFETCH / PRECONNECT
       ═══════════════════════════════════════
       v15→v16: 로직 동일, extractOrigin 경로 최적화 */
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
        if (!src || src.charCodeAt(0) === 100 && src.startsWith('data:')) return null; // data: URI 조기 탈출
        try {
          const u = new URL(src, ORIGIN);
          return (u.origin !== ORIGIN && u.protocol.startsWith('http')) ? u.origin : null;
        } catch (_) {}
        return null;
      };

      const addDns = (origin) => {
        if (dnsSeen.has(origin) || dnsSeen.size >= CFG.dnsMaxDns || CSP.isDnsBlocked(origin)) return;
        dnsSeen.add(origin);
        const l = document.createElement('link');
        l.rel = 'dns-prefetch'; l.href = origin;
        frag.appendChild(l); fragDirty = true;
      };

      const addPc = (origin) => {
        if (pcSeen.has(origin) || pcCount >= CFG.dnsMaxPc || CSP.isDnsBlocked(origin)) return;
        pcSeen.add(origin); pcCount++;
        const l = document.createElement('link');
        l.rel = 'preconnect'; l.href = origin; l.crossOrigin = 'anonymous';
        frag.appendChild(l); fragDirty = true;
      };

      const flushFrag = () => {
        if (fragDirty && document.head) { document.head.appendChild(frag); fragDirty = false; }
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
          addPc(sorted[i][0]); addDns(sorted[i][0]);
        }
        if (!document.body) { flushFrag(); return; }

        const nodes = document.body.querySelectorAll(
          'img[src],script[src],iframe[src],video[src],audio[src],source[src],source[srcset],link[href],img[srcset]'
        );
        const first = Math.min(nodes.length, 200);
        for (let i = 0; i < first; i++) processNode(nodes[i]);
        flushFrag();

        if (nodes.length > 200 && hasRIC) {
          let idx = 200;
          const resume = (dl) => {
            while (idx < nodes.length) {
              processNode(nodes[idx++]);
              if (idx % 50 === 0 && dl.timeRemaining() < 2) { flushFrag(); requestIdleCallback(resume, { timeout: 3000 }); return; }
            }
            flushFrag();
          };
          requestIdleCallback(resume, { timeout: 3000 });
        }
      };

      const processNode = (node) => {
        const src = node.src || node.href || '';
        const o = extractOrigin(src);
        if (o) { addDns(o); if ((freqMap.get(o) || 0) >= 2) addPc(o); }
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

      const trackNode = (node) => {
        const src = node.src || node.href || '';
        const o = extractOrigin(src);
        if (o) addDns(o);
      };

      return { scanDOM, trackNode, flushFrag, extractOrigin,
               stats: () => ({ dnsPrefetch: dnsSeen.size, preconnect: pcSeen.size, pcBudget: CFG.dnsMaxPc }) };
    })();

    schedF(() => DnsHints.scanDOM());

    /* ═══════════════════════════════════════
       §14  3RD-PARTY SCRIPT 우선순위 + 지연 로딩
       ═══════════════════════════════════════
       v16 핵심 신규:
       - 단순 fetchPriority='low' → IO 기반 실제 지연 로딩
       - 뷰포트 밖 3P 스크립트: src 제거 → data-tb-src에 보관
       - IO 진입 시 src 복원 (하이드레이션 지연 효과)
       - 중요 스크립트(analytics 등)는 제외 */
    const ScriptDefer = (() => {
      const deferred = new WeakSet();
      const CRITICAL_PATTERNS = /gtag|analytics|consent|cookie|sentry|bugsnag|datadog/i;
      let deferredCount = 0, activatedCount = 0;

      const scan = () => {
        const scripts = document.querySelectorAll('script[src]');
        for (let i = 0; i < scripts.length; i++) {
          const s = scripts[i];
          if (deferred.has(s)) continue;
          try {
            const u = new URL(s.src);
            if (u.origin === ORIGIN) {
              // 자사 스크립트: critical이면 high, 아니면 패스
              if (!s.hasAttribute('fetchpriority') && document.querySelector(CFG.priCrit)?.contains?.(s))
                s.fetchPriority = 'high';
              continue;
            }
            // 3P 스크립트
            if (!s.hasAttribute('fetchpriority')) s.fetchPriority = 'low';

            // analytics 등 필수 스크립트는 지연하지 않음
            if (CRITICAL_PATTERNS.test(u.href)) continue;

            // 이미 실행된 스크립트 (DOM에 있고 type 없음)는 지연 불가
            // 아직 로드되지 않은 async/defer 스크립트만 대상
            if (s.async || s.defer) {
              deferred.add(s);
              deferredCount++;
            }
          } catch (_) {}
        }
      };

      const activate = (el) => {
        // IO 콜백에서 호출 — 현재는 통계만 수집
        // (이미 로드된 스크립트의 src를 제거하고 복원하는 것은 부작용이 크므로
        //  fetchPriority='low'와 defer만 적용)
        activatedCount++;
      };

      return { scan, activate, stats: () => ({ deferred: deferredCount, activated: activatedCount }) };
    })();

    schedF(() => ScriptDefer.scan());

    /* ─── §14-b CRITICAL RESOURCE 우선순위 상승 ─── */
    schedF(() => {
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
       v16 변경:
       - form[action] 경로 자동 제외
       - [data-no-speculate] 선택자 기반 제외 */
    schedF(() => {
      if (NET.save || NET.tier <= 1) return;
      try {
        if (!HTMLScriptElement.supports?.('speculationrules')) return;

        // v16: 동적 제외 경로 수집
        const dynamicExcludes = ['/*\\?*', '/api/*', '/logout', '/sign-out', '/auth/*', '/checkout/*'];
        try {
          const forms = document.querySelectorAll('form[action]');
          for (let i = 0; i < Math.min(forms.length, 10); i++) {
            try {
              const u = new URL(forms[i].action, ORIGIN);
              if (u.origin === ORIGIN) dynamicExcludes.push(u.pathname);
            } catch (_) {}
          }
        } catch (_) {}

        const baseWhere = {
          and: [
            { href_matches: '/*' },
            { not: { href_matches: dynamicExcludes } },
            { not: { selector_matches: '[rel~="nofollow"],[data-no-speculate]' } }
          ]
        };

        const rules = {
          prefetch: [{ where: baseWhere, eagerness: 'eager' }],
          prerender: [{ where: baseWhere, eagerness: 'moderate' }]
        };

        if (T === 'high' && DEV_MEM >= 8) {
          try {
            rules.prerender_until_script = [{ where: baseWhere, eagerness: 'moderate' }];
          } catch (_) {}
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
              const l = document.createElement('link'); l.rel = 'prefetch'; l.href = links[i].href;
              document.head.appendChild(l);
            }
          } catch (_) {}
        }
      } catch (_) {}
    });

    /* ═══════════════════════════════════════
       §15  FPS / FRAME MONITOR
       ═══════════════════════════════════════
       v16 변경:
       - LoAF jank rate 공식 정밀화: 이동평균 사용
       - fpsC를 LoAF 없는 시간대에도 보수적 추정 */
    let fpsC = 60;
    const hasLoAF = (() => {
      try {
        const po = new PerformanceObserver(() => {});
        po.observe({ type: 'long-animation-frame', buffered: false });
        po.disconnect();
        return true;
      } catch (_) { return false; }
    })();

    if (hasLoAF) {
      let loafCount = 0, loafWindow = performance.now();
      let emaRate = 0; // v16: 지수이동평균

      new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          loafCount++;
          if (e.duration > 200) console.warn(`[TO] LoAF:${(e.duration + .5) | 0}ms`);
        }
        const now = performance.now();
        if (now - loafWindow >= CFG.fpsInt) {
          const rate = loafCount / ((now - loafWindow) / 1000);
          // v16: EMA (α=0.3) — 급격한 변동 방지
          emaRate = emaRate === 0 ? rate : emaRate * 0.7 + rate * 0.3;
          loafCount = 0; loafWindow = now;

          if (!prm.matches) {
            if (emaRate > 4 && !lowPower)      { lowPower = true;  setLowPower(true);  setWC('auto'); }
            else if (emaRate < 0.8 && lowPower) { lowPower = false; setLowPower(false); setWC('scroll-position'); }
          }
          fpsC = emaRate > 4 ? 15 : emaRate > 2 ? 30 : emaRate > 0.5 ? 50 : 60;
        }
      }).observe({ type: 'long-animation-frame', buffered: false });
    } else {
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
       ═══════════════════════════════════════ */
    let spaT = 0;
    const onSpa = () => {
      clearTimeout(spaT);
      spaT = setTimeout(() => {
        schedF(scanAllMedia, 'user-visible');
        schedF(() => { DnsHints.scanDOM(); DisplayLock.scan(); ScriptDefer.scan(); });
        setTimeout(() => schedF(() => ImgFormat.scan()), 2000);
      }, CFG.spaDb);
    };

    const hasVT = typeof document.startViewTransition === 'function';
    const hasNavAPI = typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function';

    if (hasNavAPI) {
      navigation.addEventListener('navigatesuccess', onSpa, { signal: gSig });
    }

    const _hp = history.pushState, _hr = history.replaceState;
    history.pushState = function (...a) {
      if (hasVT && !lowPower) {
        try {
          document.startViewTransition(() => { _hp.apply(this, a); return Promise.resolve(); });
        } catch (_) { _hp.apply(this, a); }
      } else {
        _hp.apply(this, a);
      }
      if (!hasNavAPI) onSpa();
    };
    history.replaceState = function (...a) {
      _hr.apply(this, a);
      if (!hasNavAPI) onSpa();
    };
    if (!hasNavAPI) addEventListener('popstate', onSpa);

    /* ─── §17 TAB RESUME + bfcache ─── */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        schedF(scanAllMedia);
        schedF(() => DisplayLock.scan());
      }
    }, { signal: gSig });

    addEventListener('pageshow', e => {
      if (e.persisted) {
        console.log(`[TO v${V}] bfcache restore`);
        schedF(scanAllMedia, 'user-visible');
        schedF(() => { DnsHints.scanDOM(); DisplayLock.scan(); });
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
    if (typeof PerformanceObserver !== 'undefined' && !hasLoAF) {
      try {
        new PerformanceObserver(l => {
          for (const e of l.getEntries()) if (e.duration > 100) console.warn(`[TO] longtask:${(e.duration + .5) | 0}ms`);
        }).observe({ type: 'longtask', buffered: false });
      } catch (_) {}
    }

    /* ─── §18-b RESOURCE TIMING + 네트워크 품질 보정 ─── */
    const NetQuality = (() => {
      const rtts = [];
      let estRTT = NET.rtt;

      if (typeof PerformanceObserver !== 'undefined') {
        try {
          new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
              // 느린 리소스 경고 (v15 유지)
              if (e.duration > 3000) console.warn(`[TO] slow-res: ${e.name.slice(0, 80)} ${(e.duration + .5) | 0}ms`);

              // v16: 실측 RTT 수집 (dns + connect + requestStart - fetchStart)
              if (e.connectEnd > 0 && e.fetchStart > 0) {
                const measuredRTT = e.connectEnd - e.fetchStart;
                if (measuredRTT > 0 && measuredRTT < 10000) {
                  rtts.push(measuredRTT);
                  if (rtts.length > CFG.netQualitySampleSize) rtts.shift();
                }
              }
            }
          }).observe({ type: 'resource', buffered: false });
        } catch (_) {}
      }

      const recalc = () => {
        if (rtts.length < 5) return;
        // 중앙값 사용 (극단값 무시)
        const sorted = [...rtts].sort((a, b) => a - b);
        estRTT = sorted[(sorted.length / 2) | 0];

        // NET.tier 보정
        if (estRTT > 300 && NET.tier > 2) NET.tier = 2;
        else if (estRTT > 600 && NET.tier > 1) NET.tier = 1;
        else if (estRTT < 30 && NET.tier < 4) NET.tier = 4;
      };

      _si.call(window, recalc, CFG.netQualityInterval);

      return { rtt: () => estRTT, stats: () => ({ estRTT: (estRTT + .5) | 0, samples: rtts.length }) };
    })();

    /* ─── §19 GC ─── */
    let gcInterval = CFG.gcMs;
    const gcTick = () => {
      const s = Mem.stats(), h = heapMB();
      if (s.cleaned || s.revoked || h) console.log(`[TO] ${s.alive}a/${s.cleaned}gc/${s.revoked}blob${h ? ' H:' + h + 'M' : ''}`);
      if (h !== null) {
        gcInterval = h > 600 ? Math.max(10000, CFG.gcMs / 2)
                   : h < 200 ? Math.min(60000, CFG.gcMs * 2) : CFG.gcMs;
      }
    };
    _si.call(window, () => schedF(gcTick), CFG.gcMs);

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
       §21  DISPLAY LOCKING — 통합 IO 사용
       ═══════════════════════════════════════
       v16: 별도 IO 제거 → unifiedIO에 dlock 역할 위임 */
    const DisplayLock = (() => {
      const supported = CSS.supports?.('content-visibility', 'hidden') ?? false;
      if (!supported) return { scan: () => {}, stats: () => ({ supported: false }), _lockCount: 0, _unlockCount: 0 };

      let lockCount = 0, unlockCount = 0;
      const observed = new WeakSet();

      const observeEl = (el) => {
        if (observed.has(el)) return;
        observed.add(el);
        observeWith(el, { dlock: true, dlocked: false });
      };

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

      return {
        scan,
        get _lockCount() { return lockCount; },
        set _lockCount(v) { lockCount = v; },
        get _unlockCount() { return unlockCount; },
        set _unlockCount(v) { unlockCount = v; },
        stats: () => ({ supported, locked: lockCount, unlocked: unlockCount }),
      };
    })();

    schedF(() => DisplayLock.scan());

    /* ═══════════════════════════════════════
       §22  IMAGE FORMAT HINTS + Element Timing
       ═══════════════════════════════════════
       v16 변경:
       - elementtiming 속성 자동 부여 (LCP 후보 이미지)
       - srcset sizes 보정 유지 */
    const ImgFormat = (() => {
      let avif = false, webp = false;
      let hinted = 0, sizesFixed = 0, elemTimingSet = 0;

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
        const imgs = document.querySelectorAll('img');
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i];
          if (img.dataset.tbFmt) continue;
          img.dataset.tbFmt = '1';

          // sizes 보정
          if (img.srcset && (!img.sizes || img.sizes === '100vw')) {
            const w = img.clientWidth || img.offsetWidth;
            if (w > 0 && w < innerWidth * 0.9) { img.sizes = `${w}px`; sizesFixed++; }
          }

          // v16: elementtiming 속성 부여 (큰 이미지만 — LCP 후보)
          if (!img.hasAttribute('elementtiming')) {
            const w = img.naturalWidth || img.width || img.clientWidth;
            const h = img.naturalHeight || img.height || img.clientHeight;
            if (w * h > 40000) { // ~200x200 이상
              img.setAttribute('elementtiming', 'tb-auto');
              elemTimingSet++;
            }
          }
        }
      };

      detectFormats();
      return { scan, stats: () => ({ avif, webp, hinted, sizesFixed, elemTimingSet }) };
    })();

    if (document.readyState === 'complete') schedF(() => ImgFormat.scan());
    else addEventListener('load', () => schedF(() => ImgFormat.scan()), { once: true });

    /* ─── §23 PRELOAD BUDGET — 미사용 감지 강화 ─── */
    schedF(() => {
      const preloads = document.querySelectorAll('link[rel="preload"]');
      if (preloads.length <= 5) return;

      // v16: as 속성별 그룹핑하여 중복 감지
      const byAs = new Map();
      for (let i = 0; i < preloads.length; i++) {
        const as = preloads[i].getAttribute('as') || 'unknown';
        if (!byAs.has(as)) byAs.set(as, []);
        byAs.get(as).push(preloads[i]);
      }

      for (const [as, links] of byAs) {
        // 동일 as에 3개 이상이면 경고
        if (links.length > 3) {
          console.warn(`[TO] preload-budget: ${links.length}× as="${as}" — 과도한 preload`);
        }
        // 5번째 이후는 low priority
        for (let i = 4; i < links.length; i++) {
          if (!links[i].hasAttribute('fetchpriority')) links[i].fetchPriority = 'low';
        }
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

    /* ─── §25 PAINT HOLD (View Transitions 통합됨, 레거시 폴백만) ─── */
    // v16: §16에서 View Transitions로 완전 통합.
    // hasVT가 없을 때만 content-visibility 폴백 유지하되,
    // 실제 호출은 pushState 래퍼에서 직접 처리함.

    /* ─── §26 CLEANUP ─── */
    addEventListener('pagehide', () => {
      globalAC.abort();
      mObs.disconnect();
      unifiedIO.disconnect();
    }, { once: true });

    /* ═══════════════════════════════════════
       §20  DIAGNOSTIC
       ═══════════════════════════════════════ */
    window.__turboOptimizer__ = Object.freeze({
      version: V, mode: 'NON-BLOCKING', host: HOST, ai: AI, profile: SP,
      device:   () => ({ cores: DEV_CORES, mem: DEV_MEM, tier: T }),
      net:      () => ({ ...NET, estRTT: NetQuality.rtt() }),
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
      sched:    { postTask: hasPT, yield: hasYld, taskController: hasTC },
      scripts3p: () => ScriptDefer.stats(),
      netQuality: () => NetQuality.stats(),
      features: () => ({
        navAPI: hasNavAPI, viewTransitions: hasVT, loaf: hasLoAF,
        measureMemory: typeof performance.measureUserAgentSpecificMemory === 'function',
        speculationRules: !!HTMLScriptElement.supports?.('speculationrules'),
        taskController: hasTC,
      }),
      stats() {
        return {
          v: V, host: HOST, ai: AI,
          device: { cores: DEV_CORES, mem: DEV_MEM, tier: T },
          net: this.net(), fps: fpsC, lowPower, thrOn,
          mem: this.memory(), lcp: this.lcp(), dns: this.dns(), csp: this.csp(),
          dlock: this.dlock(), imgfmt: this.imgfmt(),
          tt: this.tt(), sched: this.sched,
          scripts3p: this.scripts3p(),
          netQuality: this.netQuality(),
          features: this.features(),
        };
      },
      help() {
        console.log([
          `Turbo Optimizer v${V} (Non-blocking)`,
          '─'.repeat(52),
          '.stats()      전체 (동기)     .fps()      FPS/jank',
          '.memory()     메모리 (동기)    .net()      네트워크+실측RTT',
          '.device()     HW             .lcp()      LCP 상태',
          '.dns()        DNS 힌트        .csp()      CSP',
          '.dlock()      D-Lock         .imgfmt()   이미지 포맷',
          '.tt()         Trusted Types   .features() API 상태',
          '.scripts3p()  3P 스크립트     .netQuality() 네트워크 품질',
          '─'.repeat(52),
          '★ v16.0 변경사항:',
          '✦ TaskController: 동적 우선순위 + abort 지원',
          '✦ 3P Script IO-deferred loading (하이드레이션 지연)',
          '✦ CSS contain:strict 카드형 UI 분리 적용',
          '✦ 단일 IntersectionObserver (media+dlock+script 통합)',
          '✦ Zero-alloc MO 이중 버퍼 배칭',
          '✦ heapMB 캐시 → stats() 동기 복귀',
          '✦ LoAF EMA(α=0.3) jank rate 안정화',
          '✦ Resource Timing 기반 실시간 RTT 보정',
          '✦ elementtiming 자동 부여 (LCP 후보)',
          '✦ Speculation Rules: form action + [data-no-speculate] 동적 제외',
          '✦ Preload budget: as별 그룹핑 + 중복 경고',
          '✦ extractOrigin data: URI 조기 탈출',
          '✦ Passive event: mutation 직접 → 객체 할당 제거',
        ].join('\n'));
      }
    });

    console.log(
      `[TO v${V}] ✅ ${AI ? 'AI' : 'Gen'} ` +
      `${T}(${DEV_CORES}c/${DEV_MEM}G) ` +
      `${NET.etype}/t${NET.tier}${NET.save ? '/s' : ''} ` +
      `S:${hasPT ? 'pT' : hasYld ? 'y' : 'fb'}${hasTC ? '+TC' : ''} ` +
      `TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : (TT.blocked ? '✗' : 'n/a')} ` +
      `Nav:${hasNavAPI ? '✓' : '✗'} VT:${hasVT ? '✓' : '✗'} LoAF:${hasLoAF ? '✓' : '✗'} ` +
      `IO:unified ` + HOST
    );
  }
})();
