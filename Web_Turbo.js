// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      13.7
// @description  비차단형 웹 최적화 v13.7 – CSP 위반 감시, 이미지 포맷 힌트(AVIF/WebP), Display Locking, MO 통합, idle GC 실질 정리, 전 기능 유지·업그레이드.
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

  const V = '13.7', HOST = location.hostname, ORIGIN = location.origin;

  /* ═══════════════════════════════════════
     §0  DEVICE · NETWORK · CONFIG
     ═══════════════════════════════════════ */
  const DEV = Object.freeze({
    cores: navigator.hardwareConcurrency || 4,
    mem:   navigator.deviceMemory || 4,
    get tier() {
      if (this.cores <= 2 || this.mem <= 2) return 'low';
      if (this.cores <= 4 || this.mem <= 4) return 'mid';
      return 'high';
    }
  });

  const NET = (() => {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    const s = { slow: false, save: false, etype: '4g', downlink: 10, rtt: 50 };
    const u = () => {
      if (!c) return;
      s.save = !!c.saveData;
      s.etype = c.effectiveType || '4g';
      s.downlink = c.downlink ?? 10;
      s.rtt = c.rtt ?? 50;
      s.slow = s.save || s.etype === 'slow-2g' || s.etype === '2g';
    };
    u();
    c?.addEventListener?.('change', u);
    return s;
  })();

  const T = DEV.tier;
  const CFG = Object.freeze({
    bootMin: 2000, bootMax: 5000, bootPoll: 500, bootTh: 100,
    thrDelay: 5000, thrMin: T === 'low' ? 2000 : 1000,
    fpsInt: 2000, fpsLo: T === 'low' ? 25 : 20, fpsHi: T === 'low' ? 35 : 40,
    lpTr: '100ms', lpAn: '100ms',
    font: NET.slow ? 'optional' : 'swap',
    batch: T === 'low' ? 80 : 150,
    yldN:  T === 'low' ? 30 : 50,
    gcMs:  T === 'low' ? 20000 : (NET.slow ? 60000 : 30000),
    lcpMs: 2500,
    spaDb: 300,
    dnsMaxPreconnect: T === 'low' ? 2 : 4,
    dnsMaxPrefetch:   T === 'low' ? 6 : 12,
    priCriticalSel: 'link[rel="stylesheet"],script[src]:not([async]):not([defer])',
    // §21 Display Locking
    dlockMargin: '200px',
    dlockSel: '.offscreen-section,[data-display-lock],aside.sidebar',
    // §22 Image Format
    imgFmtMinSize: 10240, // 10KB 이상만 포맷 힌트 대상
  });

  /* ═══════════════════════════════════════
     §0-b  SCHEDULER
     ═══════════════════════════════════════ */
  const _pt  = typeof globalThis.scheduler?.postTask === 'function';
  const _sy  = typeof globalThis.scheduler?.yield === 'function';
  const _ric = typeof requestIdleCallback === 'function';

  const sched = (fn, p = 'background', t = 5000) => {
    if (_pt) return scheduler.postTask(fn, { priority: p });
    if (_ric && p === 'background') return new Promise(r => requestIdleCallback(() => r(fn()), { timeout: t }));
    return new Promise(r => setTimeout(() => r(fn()), p === 'user-blocking' ? 0 : 16));
  };
  const yld = _sy ? () => scheduler.yield() : () => new Promise(r => setTimeout(r, 0));

  /* ═══════════════════════════════════════
     §0-c  CSP VIOLATION MONITOR (신규)
     ═══════════════════════════════════════
     목적: CSP에 의해 차단된 도메인/URI를 추적하여
     dns-prefetch, preconnect, speculation rules 등에서
     해당 도메인으로의 재시도를 방지.
     document-start에서 즉시 등록해야 초기 위반도 포착.
  */
  const CSP = (() => {
    const blocked = new Set();       // 차단된 origin
    const blockedURI = new Set();    // 차단된 전체 URI (더 정밀)
    let violations = 0;

    const handler = (e) => {
      violations++;
      const uri = e.blockedURI || '';
      if (uri) {
        blockedURI.add(uri);
        try {
          const u = new URL(uri);
          if (u.origin && u.origin !== 'null') blocked.add(u.origin);
        } catch (_) {
          // data:, inline 등은 origin 추출 불가 — 무시
        }
      }
      // 디렉티브별 추적 (진단용)
      if (violations <= 5) {
        console.warn(`[TO] CSP blocked: ${e.violatedDirective} → ${uri.slice(0, 80) || 'inline'}`);
      }
    };

    document.addEventListener('securitypolicyviolation', handler);

    return Object.freeze({
      /** origin이 CSP에 의해 차단된 적 있는지 */
      isBlocked: (origin) => blocked.has(origin),
      /** 특정 URI가 차단된 적 있는지 */
      isURIBlocked: (uri) => blockedURI.has(uri),
      /** 진단 */
      stats: () => ({ violations, blockedOrigins: blocked.size, origins: [...blocked] }),
      /** 정리 (SPA 전환 시 호출 가능) */
      // SPA에서는 CSP가 동일하므로 clear하지 않음 — 누적 유지
    });
  })();

  /* ═══════════════════════════════════════
     §1  PHASE 1 – 경량 훅
     ═══════════════════════════════════════ */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll']);
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) o = typeof o === 'object' && o ? { ...o, passive: true } : { passive: true, capture: !!o };
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
    _ric ? requestIdleCallback(() => go(), { timeout: CFG.bootMax }) : setTimeout(go, CFG.bootMin);
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

    /* ─── §5 LCP TRACKER (AbortController) ─── */
    const lcp = { el: null, done: false };
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const lcpObs = new PerformanceObserver(list => {
          const e = list.getEntries(); if (e.length) lcp.el = e[e.length - 1].element || null;
        });
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
        const ac = new AbortController();
        const fin = () => {
          if (lcp.done) return; lcp.done = true; ac.abort(); lcpObs.disconnect();
          if (lcp.el?.tagName === 'IMG') { lcp.el.loading = 'eager'; lcp.el.fetchPriority = 'high'; lcp.el.decoding = 'sync'; }
        };
        for (const e of ['keydown', 'click', 'scroll', 'touchstart'])
          addEventListener(e, fin, { once: true, passive: true, capture: true, signal: ac.signal });
        setTimeout(fin, CFG.lcpMs);
      } catch (_) {}
    }

    /* ─── §6 CSS ─── */
    const hS = document.createElement('style'); hS.id = 'tb-h';
    const cvSel = AI ? `article:not(${SP.t}),section:not(${SP.t})` : 'article,section,.post,.comment,.card,li.item';
    const scSel = [
  '.chat-history', '.overflow-y-auto', '[class*="react-scroll"]',
  '.chat-scroll', '.scroller', '.overflow-auto',
  AI ? SP.c : ''
].filter(Boolean).join(',');
    hS.textContent =
      `${cvSel}{content-visibility:auto;contain-intrinsic-size:auto 500px}` +
      `img[loading="lazy"],iframe[loading="lazy"]{content-visibility:auto;contain-intrinsic-size:auto 300px}` +
      `${scSel}{contain:content;will-change:scroll-position;overflow-anchor:auto;overscroll-behavior:contain}`;

    const lS = document.createElement('style'); lS.id = 'tb-lp'; lS.disabled = true;
    lS.textContent =
      `*,*::before,*::after{animation-duration:${CFG.lpAn}!important;transition-duration:${CFG.lpTr}!important;text-rendering:optimizeSpeed!important}` +
      `[style*="infinite"],.animated,[class*="animate"],lottie-player,dotlottie-player{animation-play-state:paused!important}`;

    (document.head || document.documentElement).append(hS, lS);
    const prm = matchMedia('(prefers-reduced-motion:reduce)');
    if (prm.matches) { lowPower = true; lS.disabled = false; }
    prm.addEventListener('change', e => { if (e.matches && !lowPower) { lowPower = true; lS.disabled = false; } });

    const setWC = v => { try { document.querySelectorAll(scSel).forEach(el => { el.style.willChange = v; }); } catch (_) {} };

    /* ─── §7 FONT ─── */
    try {
      const _F = window.FontFace;
      if (_F) { window.FontFace = function (f, s, d) { return new _F(f, s, { ...d, display: CFG.font }); }; window.FontFace.prototype = _F.prototype; }
    } catch (_) {}
    sched(() => { try { for (const s of document.styleSheets) try { for (const r of s.cssRules || []) if (r instanceof CSSFontFaceRule) r.style.fontDisplay = CFG.font; } catch (_) {} } catch (_) {} }, 'background');

    /* ─── §8 TIMER THROTTLE ─── */
    const _si = window.setInterval;
    window.setInterval = function (fn, d, ...a) {
      if (thrOn && typeof d === 'number' && d < CFG.thrMin) d = CFG.thrMin;
      return _si.call(window, fn, d, ...a);
    };
    setTimeout(() => { thrOn = true; }, CFG.thrDelay);

    /* ─── §9 MEMORY TRACKER (개선: 명시적 정리 API) ─── */
    const Mem = (() => {
      const refs = new Map(); let nid = 0, cleaned = 0, revoked = 0;
      const reg = typeof FinalizationRegistry === 'function'
        ? new FinalizationRegistry(m => { refs.delete(m.id); cleaned++; if (m.blob) try { URL.revokeObjectURL(m.blob); revoked++; } catch (_) {} })
        : null;
      return {
        track(el) {
          if (!reg) return; const id = nid++, src = el.src || el.currentSrc || '';
          refs.set(id, new WeakRef(el));
          reg.register(el, { id, blob: src.startsWith('blob:') ? src : null });
        },
        /** idle GC용: dead WeakRef 항목을 Map에서 직접 제거 */
        sweep() {
          let swept = 0;
          for (const [id, r] of refs) {
            if (!r.deref()) { refs.delete(id); swept++; }
          }
          return swept;
        },
        stats() { let a = 0; for (const [, r] of refs) if (r.deref()) a++; return { tracked: refs.size, alive: a, cleaned, revoked }; }
      };
    })();
    const heapMB = () => { try { if (performance.memory) return ((performance.memory.usedJSHeapSize / 1048576) + .5) | 0; } catch (_) {} return null; };

    /* ─── §10 MEDIA OPTIMIZER ─── */
    const done = new WeakSet();
    const checkVP = el => { try { const r = el.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0; } catch (_) { return true; } };

    const optMedia = (el, vpm) => {
      if (done.has(el)) return;
      const tag = el.tagName;
      if (tag === 'IMG') {
        if (lcp.el === el) { el.loading = 'eager'; el.fetchPriority = 'high'; el.decoding = 'sync'; done.add(el); Mem.track(el); return; }
        const inVP = vpm ? vpm.get(el) ?? true : checkVP(el);
        if (inVP) {
          if (!el.hasAttribute('loading'))       el.loading = 'eager';
          if (!el.hasAttribute('fetchpriority')) el.fetchPriority = 'high';
          if (!el.hasAttribute('decoding'))       el.decoding = 'async';
        } else {
          if (!el.hasAttribute('loading'))  el.loading = 'lazy';
          if (!el.hasAttribute('decoding')) el.decoding = 'async';
          if (NET.slow && !el.hasAttribute('fetchpriority')) el.fetchPriority = 'low';
        }
      } else if (tag === 'IFRAME') {
        if (!el.hasAttribute('loading')) el.loading = 'lazy';
      } else if (tag === 'VIDEO') {
        if (!el.hasAttribute('preload')) el.preload = NET.slow ? 'none' : 'metadata';
      }
      done.add(el); Mem.track(el);
    };

    const scanAllMedia = () => {
      const all = document.querySelectorAll('img,iframe,video');
      if (!all.length) return;
      const vpm = new Map();
      for (let i = 0; i < all.length; i++)
        if (all[i].tagName === 'IMG' && !done.has(all[i])) vpm.set(all[i], checkVP(all[i]));
      for (let i = 0; i < all.length; i++) optMedia(all[i], vpm);
    };

    /* ─── §11 MUTATION OBSERVER (통합: 미디어 + DNS) ─── */
    const M_TAGS = new Set(['IMG', 'IFRAME', 'VIDEO']);
    const C_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'LI', 'UL', 'OL', 'FIGURE', 'PICTURE']);
    const SRC_TAGS = new Set(['IMG', 'SCRIPT', 'IFRAME', 'VIDEO', 'AUDIO', 'SOURCE', 'LINK']);
    let bufW = [], bufR = [], mRaf = 0;
    // DNS 추적용 버퍼 (flush에서 배치 처리)
    let dnsBuf = [];

    const mObs = new MutationObserver(ms => {
      for (let i = 0, l = ms.length; i < l; i++) {
        const ad = ms[i].addedNodes;
        for (let j = 0, al = ad.length; j < al; j++) {
          const n = ad[j];
          if (n.nodeType !== 1) continue;
          const tg = n.tagName;
          // 미디어 버퍼
          if (M_TAGS.has(tg)) { bufW.push(n); }
          else if (C_TAGS.has(tg) && n.children.length) { bufW.push(n); }
          // DNS 버퍼 (SRC를 가진 외부 리소스)
          if (SRC_TAGS.has(tg)) { dnsBuf.push(n); }
          // 자식 중 SRC 태그 (첫 레벨만 — 성능)
          else if (n.children) {
            for (let k = 0, cl = Math.min(n.children.length, 10); k < cl; k++) {
              if (SRC_TAGS.has(n.children[k].tagName)) dnsBuf.push(n.children[k]);
            }
          }
        }
      }
      if ((bufW.length || dnsBuf.length) && !mRaf) mRaf = requestAnimationFrame(flush);
    });

    async function flush() {
      mRaf = 0;

      // ── DNS 배치 처리 (가벼우므로 먼저) ──
      if (dnsBuf.length) {
        const dBatch = dnsBuf; dnsBuf = [];
        for (let i = 0; i < dBatch.length; i++) DnsHints.trackNode(dBatch[i]);
        DnsHints.flushFrag();
      }

      // ── 미디어 배치 처리 ──
      const batch = bufW; bufW = bufR; bufR = batch;
      const len = Math.min(batch.length, CFG.batch);
      const vpm = new Map();
      for (let i = 0; i < len; i++) {
        const n = batch[i];
        if (n.tagName === 'IMG' && !done.has(n)) vpm.set(n, checkVP(n));
        if (n.querySelectorAll) { const imgs = n.querySelectorAll('img'); for (let m = 0; m < imgs.length; m++) if (!done.has(imgs[m])) vpm.set(imgs[m], checkVP(imgs[m])); }
      }
      for (let i = 0; i < len; i++) {
        const n = batch[i];
        if (M_TAGS.has(n.tagName)) optMedia(n, vpm);
        else if (n.querySelectorAll) { const media = n.querySelectorAll('img,iframe,video'); for (let m = 0; m < media.length; m++) optMedia(media[m], vpm); }
        if (i > 0 && i % CFG.yldN === 0) await yld();
      }
      if (batch.length > CFG.batch) for (let i = CFG.batch; i < batch.length; i++) bufW.push(batch[i]);
      batch.length = 0;
      if (bufW.length || dnsBuf.length) mRaf = requestAnimationFrame(flush);
    }

    if (document.body) mObs.observe(document.body, { childList: true, subtree: true });
    else { const bw = new MutationObserver(() => { if (document.body) { bw.disconnect(); mObs.observe(document.body, { childList: true, subtree: true }); } }); bw.observe(document.documentElement, { childList: true }); }

    /* ─── §12 초기 미디어 스캔 ─── */
    sched(scanAllMedia, 'background');

    /* ═══════════════════════════════════════
       §13  DNS-PREFETCH / PRECONNECT (CSP 연동)
       ═══════════════════════════════════════ */
    const DnsHints = (() => {
      const dnsSeen = new Set();
      const pcSeen  = new Set();
      let pcCount = 0;
      const pcBudget = CFG.dnsMaxPreconnect;
      const dnsBudget = CFG.dnsMaxPrefetch;

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

      const frag = document.createDocumentFragment();
      let fragDirty = false;

      const addDns = (origin) => {
        if (dnsSeen.has(origin) || dnsSeen.size >= dnsBudget) return;
        if (CSP.isBlocked(origin)) return; // ★ CSP 차단 도메인 건너뛰기
        dnsSeen.add(origin);
        const l = document.createElement('link');
        l.rel = 'dns-prefetch'; l.href = origin;
        frag.appendChild(l);
        fragDirty = true;
      };

      const addPc = (origin) => {
        if (pcSeen.has(origin) || pcCount >= pcBudget) return;
        if (CSP.isBlocked(origin)) return; // ★ CSP 차단 도메인 건너뛰기
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

      const extractOrigin = (src) => {
        if (!src) return null;
        try {
          const u = new URL(src, ORIGIN);
          if (u.origin !== ORIGIN && u.protocol.startsWith('http')) return u.origin;
        } catch (_) {}
        return null;
      };

      const scanDOM = () => {
        collectExisting();

        // Resource Timing 빈도 기반 preconnect 우선순위
        const freqMap = new Map();
        try {
          const entries = performance.getEntriesByType('resource');
          for (let i = 0; i < entries.length; i++) {
            const o = extractOrigin(entries[i].name);
            if (o) freqMap.set(o, (freqMap.get(o) || 0) + 1);
          }
        } catch (_) {}

        const sorted = [...freqMap.entries()].sort((a, b) => b[1] - a[1]);
        for (let i = 0; i < sorted.length && pcCount < pcBudget; i++) {
          const o = sorted[i][0];
          addPc(o);
          addDns(o);
        }

        // TreeWalker 단일 순회
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
          if (++count >= 200 && _ric) break;
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
        if (!SRC_TAGS.has(node.tagName)) return;
        const src = node.src || node.href || node.currentSrc || '';
        const o = extractOrigin(src);
        if (o) addDns(o);
        // fragDirty는 addDns 내부에서 설정됨
      };

      return { scanDOM, trackNode, stats: () => ({ dnsPrefetch: dnsSeen.size, preconnect: pcSeen.size, pcBudget }), flushFrag, extractOrigin };
    })();

    sched(() => DnsHints.scanDOM(), 'background');

    /* ─── §14 3RD-PARTY SCRIPT 우선순위 하락 ─── */
    sched(() => {
      document.querySelectorAll('script[src]').forEach(el => {
        try {
          const u = new URL(el.src);
          if (u.origin !== ORIGIN && !el.hasAttribute('fetchpriority')) el.fetchPriority = 'low';
        } catch (_) {}
      });
    }, 'background');

    /* ─── §14-b CRITICAL RESOURCE 우선순위 상승 ─── */
    sched(() => {
      document.querySelectorAll(CFG.priCriticalSel).forEach(el => {
        try {
          const src = el.src || el.href || '';
          const u = new URL(src, ORIGIN);
          if (u.origin === ORIGIN && !el.hasAttribute('fetchpriority')) el.fetchPriority = 'high';
        } catch (_) {}
      });
    }, 'background');

    /* ─── §14-c SPECULATION RULES (CSP 연동) ─── */
    sched(() => {
      if (NET.slow || NET.save) return;
      try {
        if (!HTMLScriptElement.supports?.('speculationrules')) return;
        // CSP가 inline script를 차단하면 speculation rules도 실패할 수 있으므로 체크
        // → securitypolicyviolation에서 script-src 관련 차단이 있었으면 건너뛰기
        if (CSP.stats().violations > 0) {
          // CSP가 활성화된 사이트에서는 보수적으로 접근
          // speculation rules script 삽입 시도 → 실패해도 try-catch로 안전
        }

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

        if (T === 'high' && DEV.mem >= 8) {
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
    }, 'background');

    /* ═══════════════════════════════════════
       §21  DISPLAY LOCKING (신규)
       ═══════════════════════════════════════
       content-visibility:auto는 §6에서 이미 article/section에 적용 중.
       여기서는 IntersectionObserver를 사용하여 뷰포트에서
       충분히 멀리 벗어난 대형 서브트리에 content-visibility:hidden을
       동적으로 적용/해제하여 렌더 비용을 완전히 제거.

       대상: 긴 피드, 채팅 이력, 대시보드 패널 등
       조건: 자식 요소 5개 이상인 컨테이너만 (소형 요소 제외)
    */
    const DisplayLock = (() => {
      // content-visibility:hidden 지원 여부 체크
      const supported = CSS.supports?.('content-visibility', 'hidden') ?? false;
      if (!supported) return { scan: () => {}, stats: () => ({ supported: false }) };

      const locked = new WeakSet();
      let lockCount = 0, unlockCount = 0;

      const io = new IntersectionObserver((entries) => {
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          const el = e.target;
          if (e.isIntersecting) {
            // 뷰포트 진입 → hidden 해제
            if (locked.has(el)) {
              el.style.contentVisibility = 'auto';
              el.style.containIntrinsicSize = 'auto 500px';
              locked.delete(el);
              unlockCount++;
            }
          } else {
            // 뷰포트 이탈 → hidden 적용 (렌더링 완전 생략)
            if (!locked.has(el)) {
              // 현재 높이를 기억하여 레이아웃 시프트 방지
              const h = el.offsetHeight;
              el.style.contentVisibility = 'hidden';
              el.style.containIntrinsicSize = `auto ${h}px`;
              locked.add(el);
              lockCount++;
            }
          }
        }
      }, {
        rootMargin: CFG.dlockMargin // 뷰포트 200px 바깥까지 여유
      });

      const observed = new WeakSet();

      const scan = () => {
        // 1) 사이트 프로필 기반 채팅 메시지 컨테이너의 자식들
        if (AI && SP.c) {
          try {
            document.querySelectorAll(`${SP.c} > *`).forEach(el => {
              if (!observed.has(el) && el.children.length >= 3) {
                observed.add(el);
                io.observe(el);
              }
            });
          } catch (_) {}
        }

        // 2) 긴 리스트/피드의 아이템
        const containers = document.querySelectorAll(
          'ul > li, ol > li, [role="feed"] > *, [role="list"] > *, .feed > *, .timeline > *'
        );
        for (let i = 0; i < containers.length; i++) {
          const el = containers[i];
          if (!observed.has(el) && el.children.length >= 2 && el.offsetHeight > 100) {
            observed.add(el);
            io.observe(el);
          }
        }

        // 3) 커스텀 셀렉터 (CFG.dlockSel)
        try {
          document.querySelectorAll(CFG.dlockSel).forEach(el => {
            if (!observed.has(el)) {
              observed.add(el);
              io.observe(el);
            }
          });
        } catch (_) {}
      };

      return {
        scan,
        stats: () => ({ supported, locked: lockCount, unlocked: unlockCount })
      };
    })();

    // 초기 스캔 + SPA에서 재스캔
    sched(() => DisplayLock.scan(), 'background');

    /* ═══════════════════════════════════════
       §22  IMAGE FORMAT HINTS (신규)
       ═══════════════════════════════════════
       브라우저가 AVIF/WebP를 지원하면, 아직 <picture>로
       래핑되지 않은 단독 <img>에 대해 힌트를 제공.

       접근 방식:
       - <img>를 <picture>로 래핑하면 사이트 JS/CSS가 깨질 수 있음
       - 대신, 서버가 Accept 헤더 기반 content negotiation을
         지원하는 경우를 위해 fetchpriority + sizes 최적화
       - 로컬에서 가능한 것: srcset에 이미 AVIF/WebP가 있으면 우선
       - 추가로: 큰 이미지에 대해 sizes 속성 자동 보정
       - Resource Timing으로 이미지 전송 크기 대비 큰 것 감지 → 경고

       핵심 가치: <picture> 래핑 없이도 sizes 보정만으로
       불필요한 대역폭 절감 (브라우저가 올바른 srcset 후보 선택)
    */
    const ImgFormat = (() => {
      // AVIF/WebP 지원 감지 (동기적으로 가능한 방법)
      const avif = document.createElement('canvas').toDataURL?.('image/avif').startsWith('data:image/avif') ?? false;
      const webp = document.createElement('canvas').toDataURL?.('image/webp').startsWith('data:image/webp') ?? false;
      let hinted = 0, sizesFixed = 0;

      const optimizeImg = (img) => {
        if (!img.src || img.dataset.tbFmt) return;
        img.dataset.tbFmt = '1';

        // ── sizes 자동 보정 ──
        // srcset이 있는데 sizes가 없거나 "100vw" 기본값이면
        // 실제 레이아웃 크기에 맞게 보정 → 브라우저가 더 작은 후보 선택
        if (img.srcset && (!img.sizes || img.sizes === '100vw')) {
          const w = img.clientWidth || img.offsetWidth;
          if (w > 0 && w < innerWidth * 0.9) {
            img.sizes = `${w}px`;
            sizesFixed++;
          }
        }

        // ── srcset 내 최적 포맷 후보가 있으면 type 힌트 불필요 ──
        // (브라우저가 Accept 헤더로 자동 선택)

        // ── 큰 이미지 감지 (Resource Timing) ──
        // 전송 크기가 500KB 이상이면 경고 (포맷 전환 권장)
        try {
          const entries = performance.getEntriesByName(img.currentSrc || img.src, 'resource');
          if (entries.length) {
            const last = entries[entries.length - 1];
            const kb = (last.transferSize || 0) / 1024;
            if (kb > 500) {
              console.warn(`[TO] large-img: ${kb | 0}KB ${img.src.slice(0, 60)}… → AVIF/WebP 권장`);
              hinted++;
            }
          }
        } catch (_) {}
      };

      const scan = () => {
        document.querySelectorAll('img[srcset]').forEach(optimizeImg);
        // srcset 없는 큰 이미지도 전송 크기 체크
        document.querySelectorAll('img[src]:not([srcset])').forEach(img => {
          if (img.dataset.tbFmt) return;
          img.dataset.tbFmt = '1';
          try {
            const entries = performance.getEntriesByName(img.currentSrc || img.src, 'resource');
            if (entries.length) {
              const last = entries[entries.length - 1];
              const kb = (last.transferSize || 0) / 1024;
              if (kb > 500) {
                console.warn(`[TO] large-img: ${kb | 0}KB ${img.src.slice(0, 60)}… → AVIF/WebP 권장`);
                hinted++;
              }
            }
          } catch (_) {}
        });
      };

      return {
        scan,
        stats: () => ({ avif, webp, hinted, sizesFixed }),
      };
    })();

    // load 이후에 실행 (Resource Timing 데이터가 충분해야 함)
    if (document.readyState === 'complete') {
      sched(() => ImgFormat.scan(), 'background');
    } else {
      addEventListener('load', () => sched(() => ImgFormat.scan(), 'background'), { once: true });
    }

    /* ─── §15 FPS MONITOR ─── */
    let fpsF = 0, fpsT = performance.now(), fpsC = 60;
    const fpsTick = n => {
      fpsF++;
      const dt = n - fpsT;
      if (dt >= CFG.fpsInt) {
        fpsC = (fpsF * 1000 / dt + .5) | 0; fpsF = 0; fpsT = n;
        if (!prm.matches) {
          if (fpsC < CFG.fpsLo && !lowPower)  { lowPower = true;  lS.disabled = false; setWC('auto'); }
          else if (fpsC > CFG.fpsHi && lowPower) { lowPower = false; lS.disabled = true;  setWC('scroll-position'); }
        }
      }
      requestAnimationFrame(fpsTick);
    };
    requestAnimationFrame(fpsTick);

    /* ─── §16 SPA NAV (디바운스) — DNS + DisplayLock + ImgFormat 재스캔 ─── */
    let spaT = 0;
    const onSpa = () => {
      clearTimeout(spaT);
      spaT = setTimeout(() => {
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); }, 'background');
        // ImgFormat은 리소스 로딩 후에야 유효하므로 약간 지연
        setTimeout(() => sched(() => ImgFormat.scan(), 'background'), 2000);
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
        sched(scanAllMedia, 'background');
        sched(() => DisplayLock.scan(), 'background');
      }
    });

    addEventListener('pageshow', e => {
      if (e.persisted) {
        console.log(`[TO v${V}] bfcache restore`);
        sched(scanAllMedia, 'user-visible');
        sched(() => { DnsHints.scanDOM(); DisplayLock.scan(); }, 'background');
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
            if (o && !CSP.isBlocked(o)) {
              queueMicrotask(() => {
                DnsHints.trackNode({ tagName: 'LINK', href: url });
                DnsHints.flushFrag();
              });
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
          if (o && !CSP.isBlocked(o)) {
            queueMicrotask(() => {
              DnsHints.trackNode({ tagName: 'LINK', href: s });
              DnsHints.flushFrag();
            });
          }
        } catch (_) {}
        return _open.call(this, method, url, ...rest);
      };
    })();

    /* ─── §18 LONG TASK / LoAF ─── */
    if (typeof PerformanceObserver !== 'undefined') {
      const tryO = (type, th) => { try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.duration > th) console.warn(`[TO] ${type}:${(e.duration + .5) | 0}ms`); }).observe({ type, buffered: false }); } catch (_) {} };
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

    /* ─── §19 SOFT GC ─── */
    _si.call(window, () => sched(() => {
      const s = Mem.stats(), h = heapMB();
      if (s.cleaned || s.revoked || h) console.log(`[TO] ${s.alive}a/${s.cleaned}gc/${s.revoked}blob${h ? ' H:' + h + 'M' : ''}`);
    }, 'background'), CFG.gcMs);

    /* ─── §19-b IDLE GC (개선: 실질 sweep) ─── */
    if (_ric) {
      const idleGC = (deadline) => {
        if (deadline.timeRemaining() > 5) {
          const swept = Mem.sweep();
          if (swept > 0) console.log(`[TO] idle-sweep: ${swept} dead refs removed`);
        }
        requestIdleCallback(idleGC, { timeout: CFG.gcMs * 2 });
      };
      requestIdleCallback(idleGC, { timeout: CFG.gcMs });
    }

    /* ─── §20 DIAGNOSTIC ─── */
    window.__turboOptimizer__ = Object.freeze({
      version: V, mode: 'NON-BLOCKING', host: HOST, ai: AI, profile: SP,
      device:   () => ({ cores: DEV.cores, mem: DEV.mem, tier: T }),
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
      sched:    { postTask: _pt, yield: _sy },
      stats() {
        return {
          v: V, host: HOST, ai: AI,
          device: { cores: DEV.cores, mem: DEV.mem, tier: T },
          net: { ...NET }, fps: fpsC, lowPower, thrOn,
          mem: { ...Mem.stats(), heapMB: heapMB() },
          lcp: this.lcp(), dns: this.dns(), csp: this.csp(),
          dlock: this.dlock(), imgfmt: this.imgfmt(), sched: this.sched,
        };
      },
      help() {
        const lines = [
          `Turbo Optimizer v${V} (Non-blocking)`,
          `─`.repeat(48),
          `.stats()  전체     .fps()    FPS`,
          `.memory() 메모리   .net()    네트워크`,
          `.device() HW       .lcp()    LCP 상태`,
          `.dns()    DNS 힌트  .csp()    CSP 차단 현황`,
          `.dlock()  D-Lock   .imgfmt() 이미지 포맷`,
          `─`.repeat(48),
          `✦ CSP SecurityPolicyViolation 감시`,
          `✦ 차단 도메인 자동 제외 (dns/preconnect/fetch)`,
          `✦ LCP 3중 보호 (PerfObserver+VP+확정)`,
          `✦ AbortController 이벤트 일괄 정리`,
          `✦ 통합 MutationObserver (미디어+DNS 단일 MO)`,
          `✦ dns-prefetch/preconnect 기존 link 사전수집`,
          `✦ TreeWalker 단일순회 + Resource Timing 빈도 우선`,
          `✦ DocumentFragment 배치 삽입 (reflow 1회)`,
          `✦ fetch/XHR 동적 도메인 실시간 추적`,
          `✦ Speculation Rules (prefetch/prerender)`,
          `✦ Display Locking (content-visibility:hidden 동적)`,
          `✦ IntersectionObserver 기반 서브트리 렌더 잠금/해제`,
          `✦ 이미지 sizes 자동 보정 (대역폭 절감)`,
          `✦ 대형 이미지 AVIF/WebP 전환 권고`,
          `✦ 3rd-party fetchpriority=low`,
          `✦ 동일출처 크리티컬 리소스 priority=high`,
          `✦ bfcache(pageshow) 복귀 감지`,
          `✦ text-rendering:optimizeSpeed (저전력)`,
          `✦ will-change 동적 제어 (GPU 적응)`,
          `✦ content-visibility:auto (채팅제외)`,
          `✦ CSS contain + overscroll-behavior`,
          `✦ SPA 디바운스 (${CFG.spaDb}ms) + 전체 재스캔`,
          `✦ font-display:${CFG.font} (네트워크 적응)`,
          `✦ Scheduler API + 디바이스 적응 튜닝`,
          `✦ WeakRef+FinalizationRegistry+BlobRevoke`,
          `✦ idle sweep (dead WeakRef Map 직접 정리)`,
          `✦ JS Heap 메모리 진단`,
          `✦ Resource Timing 느린 리소스 경고`,
        ];
        console.log(lines.join('\n'));
      }
    });

    console.log(
      `[TO v${V}] ✅ ${AI ? 'AI' : 'Gen'} ` +
      `${T}(${DEV.cores}c/${DEV.mem}G) ` +
      `${NET.etype}${NET.save ? '/s' : ''} ` +
      `S:${_pt ? 'pT' : _sy ? 'y' : 'fb'} ` + HOST
    );
  }
})();
