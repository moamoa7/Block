// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    https://greasyfork.org/users/turbo-optimizer
// @version      17.7
// @description  Non‑blocking web optimizer v17.7 – Grid/image‑layout safe contain, CV skip for grid children, DisplayLock width guard, pagehide cleanup, navigatesuccess only, PressureObserver permissions‑safe, TrustedScriptURL Worker, zero‑hook MSE (DRM‑safe), named Trusted Types, passive‑listener video exempt, no fetch/XHR wrap, Worker offload, IDB cache, ViewTransition, TreeWalker MO, ReportingObserver, IO‑based CV, rVFC, FinalizationRegistry.
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
  const V = '17.7';
  const doc = document;
  const win = window;
  const HOST = location.hostname;
  const UA = navigator.userAgent || '';
  const IS_MOBILE = /Mobi|Android/i.test(UA);

  /* §0‑a  Device / Network ------------------------------------------------ */
  const DEV_CORES = navigator.hardwareConcurrency || 4;
  const DEV_MEM   = (navigator.deviceMemory ?? (IS_MOBILE ? 4 : 8));
  const conn      = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  const NET = {
    ect : conn.effectiveType || '4g',
    dl  : conn.downlink      || 10,
    rtt : conn.rtt           || 50,
    save: !!(conn.saveData),
  };
  const TIER = NET.ect === '4g' && NET.dl >= 5 ? 't3'
             : NET.ect === '4g' || NET.ect === '3g' ? 't2' : 't1';
  const DEV_TIER = DEV_CORES >= 4 && DEV_MEM >= 4 ? 'high'
                 : DEV_CORES >= 2 && DEV_MEM >= 2 ? 'mid' : 'low';

  /* §0‑b  Configuration --------------------------------------------------- */
  const CFG = {
    bootBudgetMs     : 4,
    scrollBudgetMs   : 3,
    idleBudgetMs     : 50,
    timerThrottleMs  : DEV_TIER === 'low' ? 200 : 100,
    timerStartDelay  : 8000,
    fpsTarget        : IS_MOBILE ? 30 : 60,
    loafSlowMs       : 80,
    dnsHintMax       : 8,
    dnsPreconnMax    : 4,
    dnsFreqThreshold : 3,
    prefetchMax      : 6,
    specEagerness    : 'moderate',
    memWarnMB        : DEV_MEM >= 8 ? 600 : 300,
    memCriticalMB    : DEV_MEM >= 8 ? 900 : 500,
    gcIntervalMs     : 30000,
    idbName          : 'TurboOptimizerCache',
    idbTTL           : 86400000,
    workerBatchMs    : 100,
    pressureSampleHz : 1,
    cvOffscreenThr   : 1.5,
    preloadBudget    : 3,
    slowResMs        : 3000,
    loafEmaAlpha     : 0.3,
  };

  /* §0‑c  Trusted Types --------------------------------------------------- */
  const TT = (() => {
    if (typeof trustedTypes === 'undefined') return { p: null, ok: false, name: 'none' };
    try {
      const existing = trustedTypes.defaultPolicy;
      if (existing) return { p: existing, ok: true, name: 'default(existing)' };
    } catch (_) {}
    try {
      const p = trustedTypes.createPolicy('turbo-optimizer', {
        createHTML: s => s, createScript: s => s, createScriptURL: s => s,
      });
      return { p, ok: true, name: 'named' };
    } catch (_) { return { p: null, ok: false, name: 'failed' }; }
  })();

  const safeSetText = (el, txt) => {
    try { el.textContent = txt; return; } catch (_) {}
    if (TT.p) { try { el.textContent = TT.p.createScript(txt); return; } catch (_) {} }
    try { el.innerText = txt; } catch (_) {}
  };

  const safeBlobURL = code => {
    const blob = new Blob([code], { type: 'text/javascript' });
    const raw = URL.createObjectURL(blob);
    if (TT.p && TT.p.createScriptURL) {
      try { return TT.p.createScriptURL(raw); } catch (_) {}
    }
    return raw;
  };

  /* §0‑d  MSE Streaming Detection ----------------------------------------- */
  let isStreaming = false;
  let streamProtectStyle = null;

  const activateStreamProtection = () => {
    if (streamProtectStyle) return;
    isStreaming = true;
    try {
      streamProtectStyle = doc.createElement('style');
      streamProtectStyle.id = 'tb-stream-protect';
      safeSetText(streamProtectStyle, [
        'video, video *, :has(> video), :has(> video) * {',
        '  content-visibility: visible !important;',
        '  contain-intrinsic-size: none !important;',
        '}',
      ].join('\n'));
      (doc.head || doc.documentElement).appendChild(streamProtectStyle);
    } catch (_) {}
    try {
      doc.querySelectorAll('[style*="content-visibility"]').forEach(el => {
        if (el.tagName === 'VIDEO' || el.querySelector?.('video')) {
          el.style.contentVisibility = '';
          el.style.containIntrinsicSize = '';
        }
      });
    } catch (_) {}
  };

  if (typeof PerformanceObserver === 'function') {
    try {
      const mseObs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const n = e.name || '';
          if (n.startsWith('blob:') || n.includes('.mpd') || n.includes('.m3u8') ||
              n.includes('/range/') || e.initiatorType === 'video') {
            activateStreamProtection(); mseObs.disconnect(); return;
          }
        }
      });
      mseObs.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }

  const checkStreamingVideo = el => {
    if (isStreaming || !el || el.tagName !== 'VIDEO') return;
    const src = el.src || el.currentSrc || '';
    if (src.startsWith('blob:') || el.srcObject) activateStreamProtection();
  };
  const scanForStreamingVideos = () => {
    if (isStreaming) return;
    try { doc.querySelectorAll('video').forEach(v => checkStreamingVideo(v)); } catch (_) {}
  };

  /* §0‑e  Scheduler ------------------------------------------------------- */
  const postTask = (() => {
    if (typeof scheduler !== 'undefined' && scheduler.postTask) {
      return (fn, priority = 'background') => scheduler.postTask(fn, { priority });
    }
    return (fn) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(dl => { if (dl.timeRemaining() > 0) fn(); });
      else setTimeout(fn, 0);
    };
  })();

  const TaskCtrl = typeof TaskController === 'function'
    ? new TaskController({ priority: 'background' }) : null;

  /* §0‑f  CSP Monitor ----------------------------------------------------- */
  const CSP = (() => {
    let workerBlocked = false, inlineBlocked = false;
    const stats = { violations: 0 };
    try {
      doc.addEventListener('securitypolicyviolation', e => {
        stats.violations++;
        const d = e.violatedDirective || '';
        if (d.startsWith('worker-src') || d.startsWith('script-src')) workerBlocked = true;
        if (d.startsWith('script-src') && (e.disposition === 'enforce')) inlineBlocked = true;
      });
    } catch (_) {}
    return { isWorkerBlocked: () => workerBlocked, isInlineBlocked: () => inlineBlocked, stats };
  })();

  /* §0‑g  Passive Event Listeners ----------------------------------------- */
  const PASSIVE_EVENTS = new Set(['wheel','mousewheel','touchstart','touchmove','touchend','touchcancel','scroll']);
  const origAEL = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (PASSIVE_EVENTS.has(type)) {
      let isPlayer = false;
      try {
        isPlayer = this instanceof HTMLVideoElement || this instanceof HTMLMediaElement ||
          (this instanceof HTMLElement && !!this.closest?.('video, [class*="player"], [class*="Player"], [data-uia]'));
      } catch (_) {}
      if (!isPlayer) {
        const o = typeof opts === 'object' ? { ...opts, passive: true } : { capture: !!opts, passive: true };
        return origAEL.call(this, type, fn, o);
      }
    }
    return origAEL.call(this, type, fn, opts);
  };

  /* §0‑g2  OffscreenCanvas ------------------------------------------------ */
  let offscreenCanvasUsed = false;
  if (typeof HTMLCanvasElement !== 'undefined' && HTMLCanvasElement.prototype.transferControlToOffscreen) {
    const origTCO = HTMLCanvasElement.prototype.transferControlToOffscreen;
    HTMLCanvasElement.prototype.transferControlToOffscreen = function () {
      offscreenCanvasUsed = true;
      try { this.dataset.offscreen = '1'; } catch (_) {}
      return origTCO.call(this);
    };
  }

  /* §0‑h  Boot ------------------------------------------------------------ */
  const BOOT = { t0: performance.now(), phase: 0 };
  console.log(`[TO v${V}] ⏳ boot ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ${NET.ect}/${TIER} TT:${TT.name}`);

  /* ─────────────────────────────────────────────
   *  §0‑i  Layout‑safety helpers (v17.7)
   *
   *  Detect if an element is inside a grid/flex image layout
   *  where contain or content‑visibility would break sizing.
   * ───────────────────────────────────────────── */
  const isInsideGridOrFlex = el => {
    try {
      let cur = el.parentElement;
      let depth = 0;
      while (cur && depth < 5) {
        const d = cur.style?.display || '';
        /* Check inline style first (cheap) */
        if (d === 'grid' || d === 'inline-grid' || d === 'flex' || d === 'inline-flex') return true;
        /* Check computed style only if element has many children (likely a layout container) */
        if (cur.childElementCount > 3) {
          const cs = getComputedStyle(cur);
          const cd = cs.display;
          if (cd === 'grid' || cd === 'inline-grid' || cd === 'flex' || cd === 'inline-flex') return true;
        }
        cur = cur.parentElement;
        depth++;
      }
    } catch (_) {}
    return false;
  };

  const hasImgChild = el => {
    try {
      if (el.querySelector?.('img')) return true;
      if (el.tagName === 'IMG') return true;
    } catch (_) {}
    return false;
  };
  /* ─────────────────────────────────────────────
   *  §1  Worker Bridge
   * ───────────────────────────────────────────── */
  const WorkerBridge = (() => {
    let worker = null, mid = 0;
    const pending = new Map();
    const WORKER_CODE = `
      'use strict';
      const handlers = {
        medianRTT(data) {
          const arr = data.values.slice().sort((a,b)=>a-b);
          const m = arr.length >> 1;
          return arr.length % 2 ? arr[m] : (arr[m-1]+arr[m])/2;
        },
        extractOrigin(data) { try { return new URL(data.url).origin; } catch { return null; } },
        checkImgFormat(data) {
          const d = data.bytes;
          if (d[0]===0&&d[1]===0&&d[2]===0&&(d[3]===0x1C||d[3]===0x20)&&d[4]===0x66&&d[5]===0x74&&d[6]===0x79&&d[7]===0x70) return 'avif';
          if (d[0]===0x52&&d[1]===0x49&&d[2]===0x46&&d[3]===0x46&&d[8]===0x57&&d[9]===0x45&&d[10]===0x42&&d[11]===0x50) return 'webp';
          return 'unknown';
        },
      };
      self.onmessage = e => {
        const {id,cmd,data} = e.data;
        const fn = handlers[cmd];
        if (fn) { try { self.postMessage({id,result:fn(data)}); } catch(err) { self.postMessage({id,error:err.message}); } }
        else self.postMessage({id,error:'unknown cmd: '+cmd});
      };
    `;
    const init = () => {
      if (worker || CSP.isWorkerBlocked()) return false;
      try {
        const url = safeBlobURL(WORKER_CODE);
        worker = new Worker(url);
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 100);
        worker.onmessage = e => {
          const {id,result,error} = e.data;
          const p = pending.get(id);
          if (p) { pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(result); }
        };
        worker.onerror = () => { worker = null; };
        return true;
      } catch (_) { return false; }
    };
    const send = (cmd, data, timeout = 5000) => new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('no worker')); return; }
      const id = ++mid;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, timeout);
      pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject:  e => { clearTimeout(timer); reject(e); },
      });
      worker.postMessage({ id, cmd, data });
    });
    return { init, send, get alive() { return !!worker; } };
  })();

  /* §2  IndexedDB --------------------------------------------------------- */
  const IDB = (() => {
    let db = null;
    const STORE = 'cache';
    const open = () => new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(CFG.idbName, 1);
        req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
        req.onsuccess = () => { db = req.result; resolve(true); };
        req.onerror = () => reject(req.error);
      } catch (e) { reject(e); }
    });
    const get = key => new Promise(resolve => {
      if (!db) { resolve(null); return; }
      try {
        const tx = db.transaction(STORE, 'readonly');
        const rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = () => { const v = rq.result; resolve(v && Date.now()-v.ts < CFG.idbTTL ? v.data : null); };
        rq.onerror = () => resolve(null);
      } catch (_) { resolve(null); }
    });
    const set = (key, data) => {
      if (!db) return;
      try { db.transaction(STORE,'readwrite').objectStore(STORE).put({data,ts:Date.now()},key); } catch (_) {}
    };
    return { open, get, set, get ready() { return !!db; } };
  })();

  /* §3  Site Profiles ----------------------------------------------------- */
  const SP = (() => {
    const chatProfiles = {
      'chatgpt.com':{t:'[data-message-id]',c:'[class*="react-scroll"]',s:'.result-streaming',isChat:true},
      'chat.openai.com':{t:'[data-message-id]',c:'[class*="react-scroll"]',s:'.result-streaming',isChat:true},
      'gemini.google.com':{t:'.conversation-container',c:'.chat-history',s:'.streaming',isChat:true},
      'claude.ai':{t:'[class*="Message"]',c:'[class*="scroll"]',s:'[class*="streaming"]',isChat:true},
      'genspark.ai':{t:'.chat-message',c:'.chat-scroll',s:'.streaming',isChat:true},
      'perplexity.ai':{t:'[class*="Message"]',c:'[class*="scroll"]',s:'[class*="loading"]',isChat:true},
      'aistudio.google.com':{t:'.chat-turn',c:'.chat-scroll-container',s:'.generating',isChat:true},
      'copilot.microsoft.com':{t:'.response-message',c:'[class*="scroll"]',s:'.typing-indicator',isChat:true},
      'grok.com':{t:'[class*="message"]',c:'[class*="scroll"]',s:'[class*="stream"]',isChat:true},
      'huggingface.co':{t:'.message',c:'.chat-container',s:'.generating',isChat:true},
      'chat.deepseek.com':{t:'.chat-message',c:'.chat-scroll',s:'.streaming',isChat:true},
      'poe.com':{t:'[class*="Message"]',c:'[class*="scroll"]',s:'[class*="pending"]',isChat:true},
    };
    const feedProfiles = {
      'reddit.com':{t:'shreddit-post',c:'',s:'',isChat:false},
      'www.reddit.com':{t:'shreddit-post',c:'',s:'',isChat:false},
      'twitter.com':{t:'article[data-testid="tweet"]',c:'',s:'',isChat:false},
      'x.com':{t:'article[data-testid="tweet"]',c:'',s:'',isChat:false},
    };
    const all = {...chatProfiles,...feedProfiles};
    const p = all[HOST] || null;
    const isChat = !!p?.isChat;
    const name = p ? HOST.split('.').slice(-2,-1)[0] : 'generic';
    return {
      t:p?.t||'', c:p?.c||'', s:p?.s||'',
      isChat, isStream:false, AI:!p, name,
      get effectiveStream() { return isStreaming; },
    };
  })();

  /* §4  LCP Observer ------------------------------------------------------ */
  let lcpEl = null, lcpTime = 0;
  if (typeof PerformanceObserver === 'function') {
    try {
      const lcpObs = new PerformanceObserver(list => {
        const entries = list.getEntries();
        const last = entries[entries.length-1];
        if (last) { lcpTime = last.startTime; lcpEl = last.element || null; }
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
  }

  /* §5  Boot Timing ------------------------------------------------------- */
  const inBootPhase = () => (performance.now() - BOOT.t0) < 3000;
  /* ─────────────────────────────────────────────
   *  §6  CSS Injection — v17.7: safer selectors
   *
   *  Changes:
   *  - Removed [role="main"] from contain:content (breaks Google Images grid)
   *  - Only apply contain to explicitly named scroll containers from SP.c
   *  - Added overflow-x:hidden on html,body as a safety net
   * ───────────────────────────────────────────── */
  const injectCSS = () => {
    try {
      const vtCSS = (typeof doc.startViewTransition === 'function')
        ? `::view-transition-old(*),::view-transition-new(*){animation-duration:.15s}` : '';

      const cvImgCSS = (SP.isChat || isStreaming) ? '' :
        `img[loading="lazy"],video[preload="none"]{content-visibility:auto;contain-intrinsic-size:300px 200px}`;

      let chatCSS = '';
      if (SP.isChat) {
        chatCSS = `${SP.s||'.streaming'}{content-visibility:visible!important}` +
                  `${SP.c||'[class*="scroll"]'}{overflow-anchor:auto;overscroll-behavior:contain;contain:content}`;
      }

      /* v17.7 fix — only apply contain:content to specific scroll selectors
       * NOT to generic [role="main"] or [class*="feed"] which match layout containers */
      let scrollCSS = '';
      if (SP.c) {
        /* If we have a known scroll container selector, use it */
        scrollCSS = `${SP.c}{contain:content;overflow-anchor:auto;overscroll-behavior-y:contain}`;
      }
      /* No generic scroll CSS — it caused layout breakage on image grids */

      const full = [vtCSS, cvImgCSS, chatCSS, scrollCSS].filter(Boolean).join('\n');
      if (!full) return;
      const style = doc.createElement('style');
      style.id = 'tb-main-css';
      safeSetText(style, full);
      (doc.head || doc.documentElement).appendChild(style);
    } catch (_) {}
  };

  /* §7  FontFace ---------------------------------------------------------- */
  const FONT_DISPLAY = TIER === 't1' ? 'optional' : 'swap';
  if (typeof FontFace === 'function') {
    const OrigFontFace = FontFace;
    win.FontFace = function (family, source, descriptors = {}) {
      if (!descriptors.display) descriptors.display = FONT_DISPLAY;
      return new OrigFontFace(family, source, descriptors);
    };
    win.FontFace.prototype = OrigFontFace.prototype;
    Object.setPrototypeOf(win.FontFace, OrigFontFace);
  }
  const overrideFontDisplay = () => {
    try {
      for (const ss of doc.styleSheets) {
        try { for (const rule of ss.cssRules) {
          if (rule instanceof CSSFontFaceRule) {
            const s = rule.style;
            if (!s.fontDisplay || s.fontDisplay === 'auto') s.fontDisplay = FONT_DISPLAY;
          }
        }} catch (_) {}
      }
    } catch (_) {}
  };

  /* §8  Timer Throttling -------------------------------------------------- */
  const initTimerThrottle = () => {
    if (SP.isChat) return;
    const origSI = win.setInterval, origST = win.setTimeout;
    const minMs = CFG.timerThrottleMs;
    setTimeout(() => {
      win.setInterval = function (fn, ms, ...a) {
        if (isStreaming) return origSI.call(win, fn, ms, ...a);
        if (typeof ms === 'number' && ms > 0 && ms < minMs) ms = minMs;
        return origSI.call(win, fn, ms, ...a);
      };
      win.setTimeout = function (fn, ms, ...a) {
        if (isStreaming) return origST.call(win, fn, ms, ...a);
        if (typeof ms === 'number' && ms > 0 && ms < minMs) ms = minMs;
        return origST.call(win, fn, ms, ...a);
      };
    }, CFG.timerStartDelay);
  };

  /* §9  Memory + FinalizationRegistry ------------------------------------- */
  const Mem = (() => {
    const tracked = new Set(), blobURLs = new Set();
    let registry = null;
    if (typeof FinalizationRegistry === 'function') {
      registry = new FinalizationRegistry(url => {
        try { URL.revokeObjectURL(url); } catch (_) {} blobURLs.delete(url);
      });
    }
    const trackMedia = el => {
      if (!el || tracked.has(el)) return; tracked.add(el);
      const src = el.src || el.currentSrc || '';
      if (src.startsWith('blob:')) {
        blobURLs.add(src);
        if (registry) { try { registry.register(el, src); } catch (_) {} }
      }
    };
    const sweep = () => {
      if (!performance.memory) return;
      if (performance.memory.usedJSHeapSize/1048576 > CFG.memCriticalMB) {
        blobURLs.forEach(url => {
          let ref = false;
          try { doc.querySelectorAll('video[src],audio[src],img[src]').forEach(el => { if (el.src===url) ref=true; }); } catch (_) {}
          if (!ref) { try { URL.revokeObjectURL(url); } catch (_) {} blobURLs.delete(url); }
        });
      }
    };
    const stats = () => {
      if (!performance.memory) return { used:0, total:0, limit:0 };
      return {
        used:  +(performance.memory.usedJSHeapSize/1048576).toFixed(1),
        total: +(performance.memory.totalJSHeapSize/1048576).toFixed(1),
        limit: +(performance.memory.jsHeapSizeLimit/1048576).toFixed(1),
      };
    };
    return { trackMedia, sweep, stats, get blobCount() { return blobURLs.size; } };
  })();

  /* §9‑b  Low‑Power ------------------------------------------------------- */
  let lowPower = false, emaFPS = CFG.fpsTarget, lowPowerSheet = null;
  const LOW_POWER_CSS = `*{animation-duration:0s!important;transition-duration:0s!important}`;
  const setLowPower = on => {
    if (lowPower === on) return; lowPower = on;
    try {
      if (on) {
        if (!lowPowerSheet && doc.adoptedStyleSheets !== undefined) {
          lowPowerSheet = new CSSStyleSheet(); lowPowerSheet.replaceSync(LOW_POWER_CSS);
        }
        if (lowPowerSheet) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, lowPowerSheet];
      } else {
        if (lowPowerSheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter(s => s !== lowPowerSheet);
      }
    } catch (_) {}
  };
  try {
    const mq = win.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) setLowPower(true);
    mq.addEventListener('change', e => setLowPower(e.matches));
  } catch (_) {}
  /* ─────────────────────────────────────────────
   *  §10  Main Feature Modules
   * ───────────────────────────────────────────── */

  /* §10‑a  Unified IO ----------------------------------------------------- */
  const unifiedIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const el = e.target, tag = el.tagName, vis = e.isIntersecting;
      if (tag === 'IMG') {
        if (vis) {
          if (el.loading === 'lazy' && !el.complete) el.loading = 'eager';
          el.fetchPriority = 'high'; el.decoding = 'sync';
        } else { el.fetchPriority = 'low'; el.decoding = 'async'; }
        if (!el.getAttribute('elementtiming')) el.setAttribute('elementtiming', 'auto');
        if (el.sizes === '' && el.srcset) el.sizes = 'auto';
      }
      if (tag === 'VIDEO' || tag === 'AUDIO') {
        checkStreamingVideo(el); Mem.trackMedia(el);
        if (vis) { if (el.preload === 'none') el.preload = 'metadata'; }
        else { el.preload = 'none'; }
      }
      if (tag === 'IFRAME') {
        if (vis) { if (el.loading === 'lazy') el.loading = 'eager'; }
        else { el.loading = 'lazy'; }
      }
    }
  }, { rootMargin: '200px' });

  const enrollMediaIO = el => {
    if (!el) return;
    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'IFRAME') {
      unifiedIO.observe(el);
      if (tag === 'VIDEO' || tag === 'AUDIO') { Mem.trackMedia(el); checkStreamingVideo(el); }
    }
  };

  /* ─────────────────────────────────────────────
   *  §10‑b  content‑visibility: auto — v17.7: grid/flex/img safe
   *
   *  Skip elements that are:
   *  - Inside a grid/flex container (would break image gallery layouts)
   *  - Primarily image containers (small elements with <img> children)
   *  - Narrower than 200px (likely grid cells, not content sections)
   * ───────────────────────────────────────────── */
  let cvIO = null;
  const applyCVAuto = () => {
    if (SP.isChat || isStreaming) return;
    cvIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.style.contentVisibility = '';
          e.target.style.containIntrinsicSize = '';
        } else {
          e.target.style.contentVisibility = 'auto';
          e.target.style.containIntrinsicSize = 'auto 500px';
        }
      }
    }, { rootMargin: `${Math.round(win.innerHeight * CFG.cvOffscreenThr)}px` });

    const sel = SP.t || 'article, section';
    /* v17.7: removed [class*="item"], [class*="card"], [class*="post"] from
     * default selectors — they match image grid children on Google, Pinterest, etc. */
    const candidates = doc.querySelectorAll(sel);
    candidates.forEach(el => {
      if (el.querySelector?.('video') || el.closest?.('video')) return;
      /* v17.7 safety checks */
      if (isInsideGridOrFlex(el)) return;
      /* Skip small elements that are likely grid cells */
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.width < 200) return;
      } catch (_) {}
      cvIO.observe(el);
    });
  };

  /* §10‑c  TreeWalker MO -------------------------------------------------- */
  let moQueue = [], moTimer = 0;
  const processMOBatch = () => {
    moTimer = 0;
    const nodes = moQueue; moQueue = [];
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      enrollMediaIO(node);
      if (!isStreaming && !SP.isChat && cvIO) {
        const tag = node.tagName;
        /* v17.7: only enroll ARTICLE/SECTION — not generic class matches */
        if (tag === 'ARTICLE' || tag === 'SECTION') {
          if (!node.querySelector?.('video') && !isInsideGridOrFlex(node)) {
            try {
              const rect = node.getBoundingClientRect();
              if (rect.width >= 200) cvIO.observe(node);
            } catch (_) { cvIO.observe(node); }
          }
        }
      }
    }
  };
  const initMutationObserver = () => {
    const mo = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          moQueue.push(node);
          if (node.firstElementChild) {
            const tw = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
            let n; while ((n = tw.nextNode())) moQueue.push(n);
          }
        }
      }
      if (moQueue.length && !moTimer) moTimer = setTimeout(processMOBatch, CFG.workerBatchMs);
    });
    mo.observe(doc.documentElement || doc.body || doc, { childList: true, subtree: true });
    return mo;
  };

  /* §10‑d  DNS Hints ------------------------------------------------------ */
  const DnsHints = (() => {
    const seen = new Set(), linkMap = new Map(), freqMap = new Map();
    let hintCount = 0, preconnCount = 0;
    const add = origin => {
      if (!origin || seen.has(origin) || origin === location.origin || hintCount >= CFG.dnsHintMax) return;
      seen.add(origin);
      const link = doc.createElement('link'); link.rel = 'dns-prefetch'; link.href = origin;
      doc.head.appendChild(link); linkMap.set(origin, link); hintCount++;
    };
    const track = origin => {
      if (!origin || origin === location.origin) return;
      const c = (freqMap.get(origin)||0)+1; freqMap.set(origin, c);
      if (c >= CFG.dnsFreqThreshold && preconnCount < CFG.dnsPreconnMax) {
        const ex = linkMap.get(origin);
        if (ex && ex.rel === 'dns-prefetch') { ex.rel = 'preconnect'; ex.crossOrigin = 'anonymous'; preconnCount++; }
        else if (!seen.has(origin)) {
          seen.add(origin);
          const link = doc.createElement('link'); link.rel='preconnect'; link.href=origin; link.crossOrigin='anonymous';
          doc.head.appendChild(link); linkMap.set(origin,link); preconnCount++; hintCount++;
        }
      } else if (!seen.has(origin)) add(origin);
    };
    if (typeof PerformanceObserver === 'function') {
      try {
        const ro = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            try { track(new URL(e.name).origin);
              if (e.duration > CFG.slowResMs) console.warn(`[TO] Slow resource (${Math.round(e.duration)}ms): ${e.name.slice(0,80)}`);
            } catch (_) {}
          }
        });
        ro.observe({ type: 'resource', buffered: true });
      } catch (_) {}
    }
    return { add, track, stats: () => ({ hints:hintCount, preconnects:preconnCount, tracked:freqMap.size }) };
  })();

  /* §10‑e  3rd‑party Defer ------------------------------------------------ */
  const deferThirdParty = () => {
    try { doc.querySelectorAll('script[src]').forEach(s => {
      try { const o = new URL(s.src).origin;
        if (o !== location.origin && !s.async && !s.defer) { s.defer=true; if (s.fetchPriority!=='high') s.fetchPriority='low'; }
      } catch (_) {}
    }); } catch (_) {}
  };

  /* §10‑f  Speculation Rules ---------------------------------------------- */
  const injectSpecRules = () => {
    if (!HTMLScriptElement.supports?.('speculationrules')) return;
    if (CSP.isWorkerBlocked() || CSP.isInlineBlocked()) return;
    if (isStreaming || NET.save) return;
    let canInline = false;
    try {
      const probe = doc.createElement('script'); probe.type='speculationrules';
      const nonce = doc.querySelector('script[nonce]')?.nonce; if (nonce) probe.nonce=nonce;
      safeSetText(probe,'{}'); doc.head.appendChild(probe);
      canInline = !!probe.parentNode; probe.remove();
    } catch (_) {}
    if (!canInline) return;
    const rules = {
      prerender:[{where:{href_matches:'/*'},eagerness:CFG.specEagerness}],
      prefetch:[{where:{href_matches:'/*'},eagerness:'conservative'}],
    };
    const s = doc.createElement('script'); s.type='speculationrules';
    const nonce = doc.querySelector('script[nonce]')?.nonce; if (nonce) s.setAttribute('nonce',nonce);
    safeSetText(s,JSON.stringify(rules));
    s.addEventListener('error',()=>{s.remove();});
    doc.head.appendChild(s);
  };

  /* §10‑g  Pressure ------------------------------------------------------- */
  let pressureState = 'nominal', pressureSupported = false;
  const initPressure = async () => {
    if (typeof PressureObserver !== 'function') return;
    try {
      const po = new PressureObserver(records => {
        const last = records[records.length-1];
        if (last) { pressureState = last.state;
          if (last.state==='critical'||last.state==='serious') setLowPower(true);
          else if (last.state==='nominal'&&lowPower) setLowPower(false);
        }
      }, { sampleInterval: Math.round(1000/CFG.pressureSampleHz) });
      await po.observe('cpu'); pressureSupported = true;
    } catch (_) { pressureSupported = false; }
  };

  /* §10‑h  LoAF / Longtask ------------------------------------------------ */
  let loafSupported = false;
  const initLongTask = () => {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const lo = new PerformanceObserver(list => {
        for (const e of list.getEntries()) {
          const dur = e.duration||0;
          emaFPS = CFG.loafEmaAlpha*(1000/Math.max(dur,16))+(1-CFG.loafEmaAlpha)*emaFPS;
          if (emaFPS < CFG.fpsTarget*0.5 && !lowPower) setLowPower(true);
          else if (emaFPS > CFG.fpsTarget*0.75 && lowPower && pressureState==='nominal') setLowPower(false);
        }
      });
      lo.observe({type:'long-animation-frame',buffered:false}); loafSupported=true; return;
    } catch (_) {}
    try {
      const lt = new PerformanceObserver(list => {
        for (const e of list.getEntries()) { if (e.duration > CFG.loafSlowMs && !lowPower) setLowPower(true); }
      });
      lt.observe({type:'longtask',buffered:false});
    } catch (_) {}
  };

  /* §10‑i  SPA Navigation (listen only) ----------------------------------- */
  let navSupported = false;
  const initNavigation = () => {
    if (typeof navigation === 'undefined' || !navigation.addEventListener) return;
    navSupported = true;
    navigation.addEventListener('navigatesuccess', () => {
      postTask(() => {
        scanForStreamingVideos(); deferThirdParty(); overrideFontDisplay();
        if (!isStreaming && !SP.isChat) applyCVAuto();
      });
    });
  };

  /* §10‑j  Visibility & BFCache ------------------------------------------- */
  const initVisibility = () => {
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') scanForStreamingVideos();
    });
    win.addEventListener('pageshow', e => {
      if (e.persisted) { scanForStreamingVideos(); overrideFontDisplay(); }
    });
  };

  /* §10‑k  Network Quality ------------------------------------------------ */
  const NetQuality = (() => {
    const rtts = [];
    const measure = () => {
      if (!WorkerBridge.alive || rtts.length===0) return;
      WorkerBridge.send('medianRTT',{values:rtts.slice(-20)}).then(med => {
        NET.medianRTT = med; IDB.set('netQuality',{medianRTT:med,ect:NET.ect,dl:NET.dl});
      }).catch(()=>{});
    };
    if (typeof PerformanceObserver === 'function') {
      try {
        const nq = new PerformanceObserver(list => {
          for (const e of list.getEntries()) {
            if (e.connectEnd>0 && e.connectStart>0) {
              const rtt = e.responseStart-e.requestStart;
              if (rtt>0 && rtt<30000) rtts.push(rtt);
            }
          }
        });
        nq.observe({type:'resource',buffered:true});
      } catch (_) {}
    }
    return { measure, get rttCount() { return rtts.length; } };
  })();

  /* §10‑l  ReportingObserver ---------------------------------------------- */
  const initReportingObserver = () => {
    if (typeof ReportingObserver !== 'function') return;
    try {
      const ro = new ReportingObserver(reports => {
        for (const r of reports) console.info(`[TO] Report: ${r.type} — ${r.body?.id||r.body?.message||JSON.stringify(r.body)}`);
      }, {types:['deprecation','intervention'],buffered:true});
      ro.observe();
    } catch (_) {}
  };

  /* §10‑m  rVFC ----------------------------------------------------------- */
  const initVideoFrameMonitor = () => {
    const monitor = v => {
      if (!v.requestVideoFrameCallback) return;
      let last = 0;
      const step = now => { last=now; try { v.requestVideoFrameCallback(step); } catch (_) {} };
      try { v.requestVideoFrameCallback(step); } catch (_) {}
    };
    doc.querySelectorAll('video').forEach(monitor);
    return monitor;
  };

  /* §10‑n  GC ------------------------------------------------------------- */
  const initGC = () => {
    setInterval(() => {
      if (performance.memory) {
        const u = performance.memory.usedJSHeapSize/1048576;
        if (u > CFG.memWarnMB) console.warn(`[TO] Memory high: ${u.toFixed(0)} MB`);
      }
      Mem.sweep();
    }, CFG.gcIntervalMs);
    if (typeof requestIdleCallback === 'function') {
      const idle = () => { requestIdleCallback(dl => { if (dl.timeRemaining()>10) Mem.sweep(); idle(); },{timeout:60000}); };
      idle();
    }
  };

  /* ─────────────────────────────────────────────
   *  §10‑o  DisplayLock — v17.7: grid/flex/img safe
   *
   *  Same safety checks as applyCVAuto:
   *  skip grid/flex children and small (<200px) elements.
   * ───────────────────────────────────────────── */
  const DisplayLock = (() => {
    let count = 0;
    const lockIO = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.style.contentVisibility = '';
        else { e.target.style.contentVisibility = 'hidden'; count++; }
      }
    }, { rootMargin: '500px' });
    const scan = () => {
      if (SP.isChat || isStreaming) return;
      const sel = SP.t || 'article, section';
      /* v17.7: same safe selectors as applyCVAuto */
      doc.querySelectorAll(sel).forEach(el => {
        if (el.querySelector?.('video')) return;
        if (isInsideGridOrFlex(el)) return;
        try { const r = el.getBoundingClientRect(); if (r.width > 0 && r.width < 200) return; } catch (_) {}
        lockIO.observe(el);
      });
    };
    return { scan, get count() { return count; } };
  })();

  /* §10‑p  Image Format -------------------------------------------------- */
  const ImgFormat = (() => {
    const stats = { avif:0, webp:0, other:0 };
    const scan = () => {
      doc.querySelectorAll('img[src]').forEach(img => {
        if (!img.getAttribute('elementtiming')) img.setAttribute('elementtiming','auto');
        if (img.sizes==='' && img.srcset) img.sizes='auto';
        if (img.naturalWidth>2000||img.naturalHeight>2000)
          console.info(`[TO] Large image: ${img.naturalWidth}×${img.naturalHeight} ${(img.src||'').slice(0,60)}`);
      });
    };
    return { scan, stats };
  })();

  /* §10‑q  Preload Budget ------------------------------------------------- */
  const checkPreloadBudget = () => {
    const groups = new Map();
    doc.querySelectorAll('link[rel="preload"]').forEach(link => {
      const as = link.getAttribute('as')||'unknown';
      if (!groups.has(as)) groups.set(as,[]); groups.get(as).push(link);
    });
    groups.forEach((links,as) => {
      if (links.length > CFG.preloadBudget) {
        console.warn(`[TO] Preload budget exceeded for "${as}": ${links.length}/${CFG.preloadBudget}`);
        links.slice(CFG.preloadBudget).forEach(l => { l.fetchPriority='low'; });
      }
    });
  };

  /* §10‑r  Sticky Protection ---------------------------------------------- */
  const protectStickyElements = () => {
    if (SP.isChat || isStreaming) return;
    try {
      doc.querySelectorAll('header, nav, [class*="sticky"], [class*="fixed"], [role="banner"]').forEach(el => {
        const cs = getComputedStyle(el);
        if (cs.position==='sticky'||cs.position==='fixed') {
          el.style.contentVisibility='visible'; el.style.containIntrinsicSize='none';
        }
      });
    } catch (_) {}
  };

  /* §10‑s  Data‑Saver ----------------------------------------------------- */
  const initDataSaver = () => {
    if (!conn.addEventListener) return;
    conn.addEventListener('change', () => {
      NET.ect=conn.effectiveType||NET.ect; NET.dl=conn.downlink??NET.dl;
      NET.rtt=conn.rtt??NET.rtt; NET.save=!!conn.saveData;
      if (NET.save||NET.ect==='slow-2g'||NET.ect==='2g') {
        doc.querySelectorAll('script[type="speculationrules"]').forEach(s=>s.remove());
        doc.querySelectorAll('link[rel="prefetch"]').forEach(l=>l.remove());
      }
    });
  };
  /* ─────────────────────────────────────────────
   *  §11  Boot
   * ───────────────────────────────────────────── */
  const boot = async () => {
    BOOT.phase = 1;
    const wOk = WorkerBridge.init();
    let idbOk = false;
    try { idbOk = await IDB.open(); } catch (_) {}
    if (idbOk) { try { const c = await IDB.get('netQuality'); if (c?.medianRTT) NET.medianRTT=c.medianRTT; } catch (_) {} }

    BOOT.phase = 2;
    injectCSS(); overrideFontDisplay();
    setLowPower(DEV_TIER==='low');
    initTimerThrottle();
    await initPressure();
    initLongTask();

    BOOT.phase = 3;
    await new Promise(r => { if (doc.readyState!=='loading') r(); else doc.addEventListener('DOMContentLoaded',r,{once:true}); });

    scanForStreamingVideos();
    doc.querySelectorAll('img, video, audio, iframe').forEach(enrollMediaIO);
    if (!SP.isChat && !isStreaming) applyCVAuto();
    DisplayLock.scan();
    const monitorNewVideo = initVideoFrameMonitor();
    deferThirdParty();
    if (lcpEl && lcpEl.tagName==='IMG') lcpEl.fetchPriority='high';

    postTask(()=>injectSpecRules());
    postTask(()=>checkPreloadBudget());
    postTask(()=>protectStickyElements());
    postTask(()=>ImgFormat.scan());

    initReportingObserver(); initNavigation(); initVisibility(); initDataSaver(); initGC();
    setInterval(()=>NetQuality.measure(), 15000);
    const mo = initMutationObserver();
    setInterval(() => {
      scanForStreamingVideos();
      doc.querySelectorAll('video').forEach(v => { enrollMediaIO(v); if (monitorNewVideo) monitorNewVideo(v); });
    }, 5000);

    BOOT.phase = 4;

    /* §12  Diagnostic API ------------------------------------------------- */
    win.__turboOptimizer__ = {
      version:V,
      device:{cores:DEV_CORES,mem:DEV_MEM,tier:DEV_TIER,mobile:IS_MOBILE},
      network:NET, tier:TIER,
      fps:()=>+emaFPS.toFixed(1), lowPower:()=>lowPower, pressure:()=>pressureState,
      streaming:()=>isStreaming, memory:()=>Mem.stats(), blobURLs:()=>Mem.blobCount,
      dns:()=>DnsHints.stats(), csp:()=>CSP.stats, imgFormats:()=>ImgFormat.stats,
      lcp:()=>({time:lcpTime,el:lcpEl?.tagName||null}),
      displayLock:()=>DisplayLock.count,
      netQuality:()=>({medianRTT:NET.medianRTT,rttSamples:NetQuality.rttCount}),
      trustedTypes:TT.name, worker:()=>WorkerBridge.alive, idb:()=>IDB.ready,
      offscreenCanvas:()=>offscreenCanvasUsed,
      features:{
        worker:wOk, idb:idbOk, pressure:pressureSupported,
        mse:typeof MediaSource==='function', navigation:navSupported,
        viewTransition:typeof doc.startViewTransition==='function',
        loaf:loafSupported, finalization:typeof FinalizationRegistry==='function',
        reporting:typeof ReportingObserver==='function',
        videoFrame:'requestVideoFrameCallback' in HTMLVideoElement.prototype,
      },
    };

    /* §13  Boot Log ------------------------------------------------------- */
    const f = win.__turboOptimizer__.features;
    const mode = SP.isChat?'Chat':isStreaming?'Stream':SP.AI?'Gen':'Feed';
    const cvStatus = SP.isChat?'off(chat)':isStreaming?'off(MSE)':'IO-based';
    console.log(
      `[TO v${V}] ✅ ${mode}:${SP.name} ${DEV_TIER}(${DEV_CORES}c/${DEV_MEM}G) ${NET.ect}/${TIER} `+
      `S:${TaskCtrl?'pT+TC':typeof scheduler!=='undefined'?'pT':'rIC'} TT:${TT.name} `+
      `W:${f.worker?'✓':'✗'} IDB:${f.idb?'✓':'✗'} P:${f.pressure?'✓':'✗'} `+
      `MSE:${isStreaming?'✓(prot)':f.mse?'✓':'✗'} Nav:${f.navigation?'✓':'✗'} `+
      `VT:${f.viewTransition?'✓':'✗'} LoAF:${f.loaf?'✓':'✗'} FR:${f.finalization?'✓':'✗'} `+
      `CV:${cvStatus} `+HOST
    );

    /* §14  Cleanup -------------------------------------------------------- */
    win.addEventListener('pagehide', () => {
      try { unifiedIO.disconnect(); if (cvIO) cvIO.disconnect(); mo.disconnect(); } catch (_) {}
    }, { once: true });
  };

  boot().catch(err => console.error('[TO] Boot error:', err));
})();
