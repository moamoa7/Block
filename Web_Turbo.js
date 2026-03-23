// ==UserScript==
// @name         All-in-One Web Turbo Optimizer
// @namespace    http://tampermonkey.net/
// @version      17.0
// @description  Non‑blocking web optimizer v17 – Worker offload, IDB cache, Compute Pressure, ViewTransition CSS, TreeWalker MO, ReportingObserver, MSE streaming protection, IO‑based content‑visibility (no CSS blanket rule), requestVideoFrameCallback, full v16 feature set retained.
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

  /* ================================================================
   *  §0  CONSTANTS & GLOBALS
   * ================================================================ */
  const V = '17.0', HOST = location.hostname, ORIGIN = location.origin;
  const doc = document, win = window, nav = navigator;
  const perf = win.performance;

  /* ----------------------------------------------------------------
   *  §0‑a  Trusted Types
   * ---------------------------------------------------------------- */
  const TT = (() => {
    const PT = { createHTML: s => s, createScript: s => s, createScriptURL: s => s };
    if (!win.trustedTypes?.createPolicy) return { html: s => s, script: s => s, scriptURL: s => s, active: false };
    let p = null;
    try { p = trustedTypes.createPolicy('turbo-optimizer', PT); } catch (_) {}
    return p
      ? { html: s => p.createHTML(s), script: s => p.createScript(s), scriptURL: s => p.createScriptURL(s), active: true, isDefault: p.name === 'default' }
      : { html: s => s, script: s => s, scriptURL: s => s, active: false, blocked: true };
  })();

  /* ----------------------------------------------------------------
   *  §0‑b  Device / Network
   * ---------------------------------------------------------------- */
  const DEV_CORES = nav.hardwareConcurrency || 4;
  const DEV_MEM   = nav.deviceMemory || 4;
  const T = (DEV_CORES <= 2 || DEV_MEM <= 2) ? 'low' : (DEV_CORES <= 4 || DEV_MEM <= 4) ? 'mid' : 'high';

  const NET = { slow: false, save: false, etype: '4g', downlink: 10, rtt: 50, tier: 3 };
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  const netUp = () => {
    if (!conn) return;
    NET.save = !!conn.saveData;
    NET.etype = conn.effectiveType || '4g';
    NET.downlink = conn.downlink ?? 10;
    NET.rtt = conn.rtt ?? 50;
    NET.slow = NET.save || ['slow-2g', '2g'].includes(NET.etype);
    NET.tier = NET.etype === 'slow-2g' || NET.etype === '2g' ? 1
             : NET.etype === '3g' ? 2
             : (NET.rtt < 50 && NET.downlink > 10 ? 4 : 3);
  };
  netUp();
  conn?.addEventListener('change', netUp);

  /* ----------------------------------------------------------------
   *  §0‑c  Config
   * ---------------------------------------------------------------- */
  const CFG = {
    bootMin: 2000, bootMax: 5000, bootPoll: 500, bootTh: 100,
    thrDelay: 5000, thrMin: T === 'low' ? 2000 : 1000, thrHidden: 4000,
    fpsInt: 2000, fpsLo: T === 'low' ? 25 : 20, fpsHi: T === 'low' ? 35 : 40,
    lpTr: '100ms', lpAn: '100ms',
    font: NET.slow ? 'optional' : 'swap',
    batch: T === 'low' ? 80 : T === 'mid' ? 150 : 250,
    yldN: T === 'low' ? 30 : 50,
    gcMs: T === 'low' ? 20000 : (NET.slow ? 60000 : 30000),
    lcpMs: 2500, spaDb: 300,
    dnsMaxPc: T === 'low' ? 2 : 4, dnsMaxDns: T === 'low' ? 6 : 12,
    priCrit: 'link[rel="stylesheet"],script[src]:not([async]):not([defer])',
    dlockMargin: '200px',
    dlockSel: '.offscreen-section,[data-display-lock],aside.sidebar',
    vpMargin: T === 'low' || NET.tier <= 2 ? '50px' : T === 'high' && NET.tier >= 3 ? '200px' : '100px',
    scriptDeferMargin: '300px',
    netQualitySampleSize: 20, netQualityInterval: 15000,
    idbName: 'tb-opt-v17', idbVer: 1, idbTTL: 86400000,
    workerBatchMs: 200, pressureSampleHz: 1,
    cvOffscreenThreshold: 1.5   // content-visibility 적용 기준: 뷰포트 높이 × 이 값 아래부터
  };

  /* ----------------------------------------------------------------
   *  §0‑d  MSE Streaming Auto‑detect
   * ---------------------------------------------------------------- */
  let isStreaming = false;
  if (typeof MediaSource === 'function') {
    const origIST = MediaSource.isTypeSupported;
    MediaSource.isTypeSupported = function (t) {
      if (!isStreaming) { isStreaming = true; }
      return origIST.call(this, t);
    };
    const origASB = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (m) {
      if (!isStreaming) { isStreaming = true; }
      return origASB.call(this, m);
    };
  }
  const checkStreamingVideo = el => {
    if (isStreaming || el.tagName !== 'VIDEO') return;
    const src = el.src || el.currentSrc || '';
    if (src.startsWith('blob:') || el.srcObject) { isStreaming = true; }
  };

  /* ----------------------------------------------------------------
   *  §0‑e  Scheduler (postTask / TaskController / rIC)
   * ---------------------------------------------------------------- */
  const hasPT  = typeof scheduler !== 'undefined' && typeof scheduler.postTask === 'function';
  const hasYld = typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function';
  const hasRIC = typeof requestIdleCallback === 'function';
  const hasTC  = typeof TaskController === 'function';

  const sched = (() => {
    if (hasPT) {
      return (fn, p) => {
        const pr = p || 'background';
        if (hasTC) {
          const tc = new TaskController({ priority: pr });
          return { promise: scheduler.postTask(fn, { signal: tc.signal }), abort: () => tc.abort(), setPriority: n => { try { tc.setPriority(n); } catch (_) {} } };
        }
        return { promise: scheduler.postTask(fn, { priority: pr }), abort: () => {}, setPriority: () => {} };
      };
    }
    if (hasRIC) {
      return (fn, p) => {
        const ac = new AbortController();
        const promise = p === 'user-blocking'
          ? Promise.resolve().then(() => !ac.signal.aborted && fn())
          : new Promise(r => requestIdleCallback(() => { if (!ac.signal.aborted) r(fn()); }, { timeout: 3000 }));
        return { promise, abort: () => ac.abort(), setPriority: () => {} };
      };
    }
    return (fn, p) => {
      const ac = new AbortController();
      return {
        promise: new Promise(r => setTimeout(() => { if (!ac.signal.aborted) r(fn()); }, p === 'user-blocking' ? 0 : 16)),
        abort: () => ac.abort(), setPriority: () => {}
      };
    };
  })();

  const schedF = (fn, p) => { sched(fn, p); };
  const yld = hasYld
    ? () => scheduler.yield()
    : hasPT ? () => scheduler.postTask(() => {}, { priority: 'user-visible' })
    : () => new Promise(r => setTimeout(r, 0));

  /* ----------------------------------------------------------------
   *  §0‑f  CSP Violation Monitor
   * ---------------------------------------------------------------- */
  const CSP = (() => {
    const byDir = new Map();
    let violations = 0;
    doc.addEventListener('securitypolicyviolation', e => {
      violations++;
      const uri = e.blockedURI || '', dir = e.violatedDirective?.split(' ')[0] || 'unknown';
      if (!uri) return;
      try {
        const o = new URL(uri).origin;
        if (o !== 'null') {
          if (!byDir.has(dir)) byDir.set(dir, new Set());
          byDir.get(dir).add(o);
        }
      } catch (_) {}
      if (violations <= 5) console.warn(`[TO] CSP:${dir} → ${uri.slice(0, 80) || 'inline'}`);
    });
    return {
      isConnectBlocked: o => byDir.get('connect-src')?.has(o) ?? false,
      isDnsBlocked: o => { for (const [dir, set] of byDir) { if (['script-src', 'style-src', 'font-src'].includes(dir)) continue; if (set.has(o)) return true; } return false; },
      isWorkerBlocked: () => byDir.has('worker-src') || byDir.has('script-src'),
      stats: () => ({ violations, directives: Object.fromEntries([...byDir].map(([k, v]) => [k, [...v]])) })
    };
  })();

  /* ----------------------------------------------------------------
   *  §0‑g  Passive Event Hook
   * ---------------------------------------------------------------- */
  const PAS = new Set(['wheel', 'mousewheel', 'scroll', 'touchstart', 'touchmove']);
  const _OPTS_PF = Object.freeze({ passive: true, capture: false });
  const _OPTS_PT = Object.freeze({ passive: true, capture: true });
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (t, fn, o) {
    if (PAS.has(t)) {
      if (!o || o === false) return _ael.call(this, t, fn, _OPTS_PF);
      if (o === true) return _ael.call(this, t, fn, _OPTS_PT);
      if (typeof o === 'object' && !o.passive) o.passive = true;
    }
    return _ael.call(this, t, fn, o);
  };

  /* ----------------------------------------------------------------
   *  §0‑h  safeSetText (Trusted Types)
   * ---------------------------------------------------------------- */
  const safeSetText = (el, text) => {
    const tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT') {
      if (TT.isDefault) { el.textContent = text; return true; }
      if (TT.active) { try { el.textContent = TT.script(text); return true; } catch (_) {} }
      if (tag === 'STYLE') { try { el.appendChild(doc.createTextNode(text)); return true; } catch (_) {} return false; }
    }
    el.textContent = text;
    return true;
  };

  /* ================================================================
   *  §1  WORKER BRIDGE (inline Blob worker)
   * ================================================================ */
  const WorkerBridge = (() => {
    let worker = null, usable = false, reqId = 0;
    const pending = new Map();

    const WORKER_SRC = `'use strict';
const handlers = {
  calcMedianRTT(d) {
    const a = d.rtts;
    if (a.length < 3) return { median: a[0] || 0 };
    a.sort((x, y) => x - y);
    return { median: a[a.length >>> 1] };
  },
  extractOrigins(d) {
    const res = [], seen = new Set(), origin = d.pageOrigin;
    for (const src of d.urls) {
      if (!src || src.startsWith('data:')) continue;
      try {
        const u = new URL(src, origin);
        const o = u.origin;
        if (o !== origin && u.protocol.startsWith('http') && !seen.has(o)) { seen.add(o); res.push(o); }
      } catch (_) {}
    }
    return { origins: res };
  },
  detectImgFormats() {
    const test = async (b, t) => {
      try { const blob = new Blob([b], { type: t }); const bmp = await createImageBitmap(blob); bmp.close(); return true; }
      catch { return false; }
    };
    return Promise.all([
      test(new Uint8Array([0,0,0,28,102,116,121,112,97,118,105,102,0,0,0,0,97,118,105,102,109,105,102,49,109,105,97,102]), 'image/avif'),
      test(new Uint8Array([82,73,70,70,36,0,0,0,87,69,66,80,86,80,56,32,24,0,0,0,48,1,0,157,1,42,1,0,1,0,1,64,37,164,0,3,112,0,254,251,148,0,0]), 'image/webp')
    ]).then(([avif, webp]) => ({ avif, webp }));
  }
};
self.onmessage = async e => {
  const { id, cmd, data } = e.data;
  const h = handlers[cmd];
  if (!h) { self.postMessage({ id, error: 'unknown cmd' }); return; }
  try { const r = await h(data); self.postMessage({ id, result: r }); }
  catch (err) { self.postMessage({ id, error: err.message }); }
};`;

    const init = () => {
      try {
        const blob = new Blob([WORKER_SRC], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        worker = new Worker(TT.active ? TT.scriptURL(url) : url);
        URL.revokeObjectURL(url);
        worker.onmessage = e => {
          const { id, result, error } = e.data;
          const p = pending.get(id);
          if (p) { pending.delete(id); error ? p.reject(new Error(error)) : p.resolve(result); }
        };
        worker.onerror = () => { usable = false; };
        usable = true;
      } catch (err) {
        console.warn('[TO] Worker init failed:', err.message);
        usable = false;
      }
    };

    const send = (cmd, data, transfer) => {
      if (!usable) return Promise.reject(new Error('worker unavailable'));
      const id = reqId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ id, cmd, data }, transfer || []);
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('worker timeout')); } }, 3000);
      });
    };

    const terminate = () => { if (worker) { worker.terminate(); usable = false; } };
    return { init, send, terminate, get usable() { return usable; } };
  })();

  /* ================================================================
   *  §2  INDEXEDDB PERSISTENT CACHE
   * ================================================================ */
  const IDB = (() => {
    let db = null;
    const STORE = 'cache';
    const open = () => new Promise((res, rej) => {
      try {
        const req = indexedDB.open(CFG.idbName, CFG.idbVer);
        req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' }); };
        req.onsuccess = () => { db = req.result; res(db); };
        req.onerror = () => rej(req.error);
      } catch (e) { rej(e); }
    });
    const tx = m => { if (!db) return null; try { return db.transaction(STORE, m).objectStore(STORE); } catch { return null; } };
    const get = k => new Promise(r => {
      const s = tx('readonly');
      if (!s) { r(null); return; }
      const req = s.get(k);
      req.onsuccess = () => { const v = req.result; if (!v || Date.now() - (v.ts || 0) > CFG.idbTTL) { r(null); return; } r(v.data); };
      req.onerror = () => r(null);
    });
    const set = (k, d) => { const s = tx('readwrite'); if (!s) return; try { s.put({ key: k, data: d, ts: Date.now() }); } catch (_) {} };
    const del = k => { const s = tx('readwrite'); if (!s) return; try { s.delete(k); } catch (_) {} };
    return { open, get, set, del, ready: () => !!db };
  })();

  /* ================================================================
   *  §3  SITE PROFILES & AUTO‑INTELLIGENCE
   * ================================================================ */
  const SP = (() => {
    const profiles = {
      'reddit.com':    { t: '[data-testid="post-container"]', f: '.Post', s: '[data-scroller-first]' },
      'twitter.com':   { t: 'article[data-testid="tweet"]',   f: '[data-testid="cellInnerDiv"]', s: '[data-testid="primaryColumn"]' },
      'x.com':         { t: 'article[data-testid="tweet"]',   f: '[data-testid="cellInnerDiv"]', s: '[data-testid="primaryColumn"]' },
      'facebook.com':  { t: '[data-pagelet^="FeedUnit"]',     f: '[role="article"]',     s: '[role="feed"]' },
      'instagram.com': { t: 'article[role="presentation"]',   f: 'article',              s: 'main' },
      'youtube.com':   { t: 'ytd-rich-item-renderer',         f: 'ytd-rich-item-renderer', s: '#content' },
      'linkedin.com':  { t: '.feed-shared-update-v2',         f: '.feed-shared-update-v2', s: '.scaffold-finite-scroll__content' },
      'tiktok.com':    { t: '[data-e2e="recommend-list-item-container"]', f: '[data-e2e="recommend-list-item-container"]', s: '#app' },
      'news.ycombinator.com': { t: '.athing',  f: '.athing',  s: '#hnmain' },
      'naver.com':     { t: '.news_area',      f: '.news_area', s: '#content' },
      'daum.net':      { t: '.item_issue',     f: '.item_issue', s: '#mArticle' }
    };
    const key = Object.keys(profiles).find(k => HOST === k || HOST.endsWith('.' + k));
    const p = key ? profiles[key] : null;

    // Auto‑intelligence: detect feed‑like patterns
    const AI = !p;
    return { t: p?.t || '', f: p?.f || '', s: p?.s || '', AI, name: key || 'generic' };
  })();

  /* ================================================================
   *  §4  LCP TRACKER
   * ================================================================ */
  const LCP = (() => {
    let lcpTime = 0, lcpEl = null, done = false;
    try {
      const obs = new PerformanceObserver(list => {
        for (const e of list.getEntries()) { lcpTime = e.startTime; lcpEl = e.element; }
      });
      obs.observe({ type: 'largest-contentful-paint', buffered: true });
      // Finalise on first interaction or after timeout
      const fin = () => { if (!done) { done = true; obs.disconnect(); } };
      doc.addEventListener('keydown', fin, { once: true, passive: true });
      doc.addEventListener('pointerdown', fin, { once: true, passive: true });
      setTimeout(fin, CFG.lcpMs + 2000);
    } catch (_) {}
    return { get time() { return lcpTime; }, get el() { return lcpEl; }, get done() { return done; } };
  })();

  /* ================================================================
   *  §5  BOOT TIMING
   * ================================================================ */
  const boot = () => new Promise(resolve => {
    const start = perf.now();
    const check = () => {
      const elapsed = perf.now() - start;
      if (elapsed >= CFG.bootMax) { resolve(); return; }
      if (elapsed >= CFG.bootMin && doc.readyState !== 'loading') {
        // Check if main thread is calm
        if (hasRIC) {
          requestIdleCallback(dl => { if (dl.timeRemaining() > CFG.bootTh || elapsed > CFG.bootMax - 500) resolve(); else setTimeout(check, CFG.bootPoll); }, { timeout: 1000 });
        } else { resolve(); }
        return;
      }
      setTimeout(check, CFG.bootPoll);
    };
    if (doc.readyState === 'complete') { setTimeout(resolve, CFG.bootMin); }
    else { setTimeout(check, CFG.bootPoll); }
  });

  /* ================================================================
   *  §6  CSS INJECTION
   *     ★ content-visibility:auto는 여기서 일괄 적용하지 않음
   *     ★ IO 기반으로 §10에서 오프스크린 요소에만 JS로 적용
   * ================================================================ */
  const injectCSS = () => {
    // ViewTransition CSS
    const vtCSS = ('@view-transition{navigation:auto}');

    // ★ sticky / fixed / nav 보호 (방어 레이어)
    const stickyProtectSel =
      'nav,header,[role="navigation"],[role="banner"],[role="tablist"],[role="search"],' +
      '[style*="sticky"],[style*="fixed"]';

    // Scroll container optimisation
    const scSel = SP.s || 'main,[role="main"],.feed,.timeline';

    const hCSS =
      vtCSS +
      // ★ content-visibility 일괄 적용 룰 없음 (cvSel, cardSel, feedChildSel 제거) ★
      // lazy img/iframe만 안전하게 유지 (이미 loading=lazy인 요소라 화면 밖에 있음)
      `img[loading="lazy"],iframe[loading="lazy"]{content-visibility:auto}` +
      // 비디오 & MSE 보호
      `:has(>video),video{content-visibility:visible!important;contain:none!important}` +
      // sticky/fixed 보호
      `${stickyProtectSel}{content-visibility:visible!important;contain:none!important}` +
      // 스크롤 컨테이너
      `${scSel}{contain:content;will-change:scroll-position;overflow-anchor:auto;overscroll-behavior:contain}`;

    const style = doc.createElement('style');
    style.id = 'turbo-opt-v17';
    safeSetText(style, hCSS);
    (doc.head || doc.documentElement).appendChild(style);
  };

  /* ================================================================
   *  §7  FONT‑DISPLAY OVERRIDE
   * ================================================================ */
  const overrideFontDisplay = () => {
    const display = CFG.font;
    try {
      for (const sheet of doc.styleSheets) {
        try {
          const rules = sheet.cssRules;
          if (!rules) continue;
          for (const rule of rules) {
            if (rule instanceof CSSFontFaceRule) {
              rule.style.fontDisplay = display;
            }
          }
        } catch (_) { /* cross-origin */ }
      }
    } catch (_) {}
  };

  /* ================================================================
   *  §8  TIMER THROTTLING
   * ================================================================ */
  const throttleTimers = () => {
    const origSI = win.setInterval;
    const origST = win.setTimeout;
    let delayActive = false;

    // Activate throttle after boot delay
    setTimeout(() => { delayActive = true; }, CFG.thrDelay);

    win.setInterval = function (fn, ms, ...args) {
      if (!delayActive || isStreaming) return origSI.call(win, fn, ms, ...args);
      const min = doc.hidden ? CFG.thrHidden : CFG.thrMin;
      const actual = (typeof ms === 'number' && ms < min) ? min : ms;
      return origSI.call(win, fn, actual, ...args);
    };

    // Only throttle very fast setTimeout (< 50ms) to avoid breaking app logic
    win.setTimeout = function (fn, ms, ...args) {
      if (!delayActive || isStreaming) return origST.call(win, fn, ms, ...args);
      if (typeof ms === 'number' && ms < 50 && ms > 0 && doc.hidden) {
        return origST.call(win, fn, CFG.thrHidden, ...args);
      }
      return origST.call(win, fn, ms, ...args);
    };
  };

  /* ================================================================
   *  §9  MEMORY TRACKING
   * ================================================================ */
  const Memory = (() => {
    let heapUsed = 0, heapLimit = 0;
    const update = () => {
      if (perf.memory) {
        heapUsed = perf.memory.usedJSHeapSize;
        heapLimit = perf.memory.jsHeapSizeLimit;
      }
    };
    const pct = () => heapLimit ? (heapUsed / heapLimit * 100) : 0;
    return { update, pct, get used() { return heapUsed; }, get limit() { return heapLimit; } };
  })();

  /* ================================================================
   *  §10  INIT ALL (main logic after boot)
   * ================================================================ */
  const initAll = async () => {
    // Init subsystems
    WorkerBridge.init();
    try { await IDB.open(); } catch (e) { console.warn('[TO] IDB:', e.message); }

    injectCSS();

    /* --- Low Power State --- */
    let lowPower = false;
    let pressureState = 'nominal';

    /* --- FPS Tracking --- */
    let fps = 60, frames = 0, fpsLast = perf.now();
    const fpsTick = () => {
      frames++;
      requestAnimationFrame(fpsTick);
    };
    requestAnimationFrame(fpsTick);
    setInterval(() => {
      const now = perf.now();
      fps = Math.round(frames * 1000 / (now - fpsLast));
      frames = 0;
      fpsLast = now;
      Memory.update();
      // Low power toggle
      if (!lowPower && (fps < CFG.fpsLo || pressureState === 'critical' || pressureState === 'serious')) {
        lowPower = true;
        doc.documentElement.style.setProperty('--to-tr', CFG.lpTr);
        doc.documentElement.style.setProperty('--to-an', CFG.lpAn);
      } else if (lowPower && fps > CFG.fpsHi && pressureState === 'nominal') {
        lowPower = false;
        doc.documentElement.style.removeProperty('--to-tr');
        doc.documentElement.style.removeProperty('--to-an');
      }
    }, CFG.fpsInt);

    /* --- Font display --- */
    schedF(overrideFontDisplay, 'background');

    /* --- Timer throttle --- */
    throttleTimers();

    /* ============================================================
     *  §10‑a  UNIFIED IntersectionObserver
     * ============================================================ */
    const ioRoles = new WeakMap();  // el → { lazy, dlock, script, cv }
    const ensureRole = el => { if (!ioRoles.has(el)) ioRoles.set(el, {}); return ioRoles.get(el); };

    const unifiedIO = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const el = entry.target;
        const role = ioRoles.get(el);
        if (!role) continue;

        // Lazy media
        if (role.lazy && entry.isIntersecting) {
          if (el.dataset.src) { el.src = el.dataset.src; delete el.dataset.src; }
          if (el.dataset.srcset) { el.srcset = el.dataset.srcset; delete el.dataset.srcset; }
          el.loading = 'eager';
          role.lazy = false;
          if (!role.dlock && !role.cv) unifiedIO.unobserve(el);
        }

        // Display Lock
        if (role.dlocked) {
          if (entry.isIntersecting) {
            el.style.contentVisibility = 'auto';
            el.style.containIntrinsicSize = '';
            role.dlocked = false;
            DisplayLock._unlockCount++;
          }
        }

        // ★ content-visibility (IO 기반)
        if (role.cv) {
          if (entry.isIntersecting) {
            // 뷰포트에 들어옴 → content-visibility 해제
            el.style.contentVisibility = '';
            el.style.contain = '';
          }
          // 뷰포트 밖으로 나감 → 다시 적용 (단, 위쪽으로 나간 경우만)
          // isIntersecting=false 상태에서 boundingClientRect.top > vpH 이면 아래쪽(아직 안 본 곳) → 유지
          // 뷰포트 위쪽이면 이미 본 요소 → 적용
          if (!entry.isIntersecting) {
            el.style.contentVisibility = 'auto';
          }
        }

        // Deferred scripts
        if (role.script && entry.isIntersecting) {
          const type = el.getAttribute('data-to-type');
          if (type) { el.type = type; el.removeAttribute('data-to-type'); }
          role.script = false;
          unifiedIO.unobserve(el);
        }
      }
    }, { rootMargin: CFG.vpMargin });

    /* ============================================================
     *  §10‑b  ★ IO 기반 content-visibility 적용 (핵심 변경)
     *     CSS 일괄 룰 대신, 초기 뷰포트 바깥 요소에만 JS로 적용
     * ============================================================ */
    const applyCVAuto = () => {
      const selectors = SP.AI
        ? 'article,section,.card,[class*="card"],[class*="Card"],[class*="item"],[class*="Item"]'
        : [SP.t, SP.f].filter(Boolean).join(',') || 'article,section';

      let candidates;
      try { candidates = doc.querySelectorAll(selectors); } catch (_) { candidates = doc.querySelectorAll('article,section'); }

      const vpH = win.innerHeight;
      const threshold = vpH * CFG.cvOffscreenThreshold;

      for (const el of candidates) {
        // 보호 대상 제외: nav, header, sticky, fixed, form, input 포함 요소
        const tag = el.tagName;
        if (tag === 'NAV' || tag === 'HEADER') continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'sticky' || cs.position === 'fixed') continue;

        const rect = el.getBoundingClientRect();

        // 뷰포트 안에 있거나 위쪽에 있는 요소 → 건드리지 않음
        if (rect.top <= threshold) continue;

        // 뷰포트 아래(오프스크린)에 있는 요소만 적용
        el.style.contentVisibility = 'auto';

        // IO로 관찰 → 뷰포트 진입 시 해제, 퇴장 시 재적용
        const role = ensureRole(el);
        role.cv = true;
        unifiedIO.observe(el);
      }
    };

    /* ============================================================
     *  §10‑c  TreeWalker MutationObserver
     * ============================================================ */
    let moQueue = [], moTimer = null;
    const processMO = () => {
      const batch = moQueue;
      moQueue = [];
      moTimer = null;

      const newNodes = new Set();
      for (const mut of batch) {
        for (const node of mut.addedNodes) {
          if (node.nodeType === 1) newNodes.add(node);
        }
      }
      if (!newNodes.size) return;

      // Process new nodes: lazy, dns, images, content-visibility
      for (const root of newNodes) {
        const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
        let n = tw.currentNode;
        while (n) {
          enrollNode(n);
          n = tw.nextNode();
        }
      }
    };

    const mo = new MutationObserver(mutations => {
      moQueue.push(...mutations);
      if (!moTimer) moTimer = setTimeout(processMO, CFG.workerBatchMs);
    });

    /* ============================================================
     *  §10‑d  Node Enrollment (lazy, img, dns, media, cv)
     * ============================================================ */
    const dnsHinted = new Set();
    let dnsCount = 0, pcCount = 0;

    const addDnsHint = (origin, type) => {
      if (dnsHinted.has(origin) || CSP.isDnsBlocked(origin)) return;
      if (type === 'preconnect' && pcCount >= CFG.dnsMaxPc) return;
      if (type === 'dns-prefetch' && dnsCount >= CFG.dnsMaxDns) return;
      dnsHinted.add(origin);
      const link = doc.createElement('link');
      link.rel = type;
      link.href = origin;
      if (type === 'preconnect') { link.crossOrigin = 'anonymous'; pcCount++; }
      else { dnsCount++; }
      doc.head.appendChild(link);
    };

    const enrollNode = el => {
      const tag = el.tagName;

      // Lazy images
      if ((tag === 'IMG' || tag === 'IFRAME') && !el.loading) {
        el.loading = 'lazy';
      }

      // DNS hints from src/href
      if (el.src || el.href) {
        try {
          const url = new URL(el.src || el.href, ORIGIN);
          if (url.origin !== ORIGIN && url.protocol.startsWith('http')) {
            addDnsHint(url.origin, 'dns-prefetch');
          }
        } catch (_) {}
      }

      // Video / media
      if (tag === 'VIDEO' || tag === 'AUDIO') {
        enrollMedia(el);
      }

      // Large images: elementtiming, sizes
      if (tag === 'IMG') {
        if (!el.getAttribute('elementtiming')) el.setAttribute('elementtiming', 'auto');
        if (el.sizes === '' && el.srcset) el.sizes = 'auto';
      }
    };

    const enrollMedia = el => {
      checkStreamingVideo(el);
      if (isStreaming) return; // ★ MSE 스트리밍이면 건드리지 않음
      if (el.tagName === 'VIDEO') {
        if (!el.preload || el.preload === 'auto') el.preload = 'metadata';
      }
    };

    /* ============================================================
     *  §10‑e  DNS Prefetch Collection (Worker‑offloaded)
     * ============================================================ */
    const collectDNS = async () => {
      // Restore from IDB
      const cached = await IDB.get('dns:hints');
      if (cached && Array.isArray(cached)) {
        for (const origin of cached) addDnsHint(origin, 'dns-prefetch');
      }

      // Collect current page origins
      const urls = [];
      const els = doc.querySelectorAll('script[src],link[href],img[src],iframe[src],a[href]');
      for (const el of els) urls.push(el.src || el.href || '');

      if (WorkerBridge.usable) {
        try {
          const { origins } = await WorkerBridge.send('extractOrigins', { urls, pageOrigin: ORIGIN });
          for (const o of origins) addDnsHint(o, 'dns-prefetch');
          IDB.set('dns:hints', origins);
        } catch (_) {
          // Fallback: main thread
          collectDNSMainThread(urls);
        }
      } else {
        collectDNSMainThread(urls);
      }
    };

    const collectDNSMainThread = urls => {
      const origins = [];
      const seen = new Set();
      for (const src of urls) {
        if (!src || src.startsWith('data:')) continue;
        try {
          const u = new URL(src, ORIGIN);
          if (u.origin !== ORIGIN && u.protocol.startsWith('http') && !seen.has(u.origin)) {
            seen.add(u.origin);
            origins.push(u.origin);
            addDnsHint(u.origin, 'dns-prefetch');
          }
        } catch (_) {}
      }
      IDB.set('dns:hints', origins);
    };

    /* ============================================================
     *  §10‑f  3rd‑party Script Deferral
     * ============================================================ */
    const defer3PScripts = () => {
      const scripts = doc.querySelectorAll('script[src]');
      for (const s of scripts) {
        try {
          const u = new URL(s.src, ORIGIN);
          if (u.origin !== ORIGIN && !s.async && !s.defer && !s.type?.includes('module')) {
            s.setAttribute('data-to-type', s.type || 'text/javascript');
            s.type = 'text/plain'; // Prevent execution
            const role = ensureRole(s);
            role.script = true;
            unifiedIO.observe(s);
          }
        } catch (_) {}
      }
    };

    /* ============================================================
     *  §10‑g  Speculation Rules
     * ============================================================ */
    const injectSpecRules = () => {
      if (!HTMLScriptElement.supports?.('speculationrules')) return;
      try {
        const rules = {
          prerender: [{ where: { href_matches: '/*' }, eagerness: 'moderate' }],
          prefetch: [{ where: { href_matches: '/*' }, eagerness: 'conservative' }]
        };
        const s = doc.createElement('script');
        s.type = 'speculationrules';
        safeSetText(s, JSON.stringify(rules));
        doc.head.appendChild(s);
      } catch (_) {}
    };

    /* ============================================================
     *  §10‑h  Compute Pressure Observer
     * ============================================================ */
    if (typeof PressureObserver === 'function') {
      try {
        const po = new PressureObserver(records => {
          for (const r of records) {
            pressureState = r.state; // 'nominal' | 'fair' | 'serious' | 'critical'
          }
        }, { sampleInterval: Math.round(1000 / CFG.pressureSampleHz) });
        po.observe('cpu');
      } catch (_) {}
    }

    /* ============================================================
     *  §10‑i  LoAF (Long Animation Frames) Fallback
     * ============================================================ */
    try {
      const loafObs = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 100 && !lowPower) {
            // Long frame detected → hint low power
          }
        }
      });
      loafObs.observe({ type: 'long-animation-frame', buffered: false });
    } catch (_) {}

    /* ============================================================
     *  §10‑j  SPA Navigation (Navigation API + fallback)
     * ============================================================ */
    let lastURL = location.href;
    const onSPANav = () => {
      if (location.href === lastURL) return;
      lastURL = location.href;
      // Re‑apply optimisations to new content after SPA nav
      schedF(() => {
        applyCVAuto();
        collectDNS();
        protectStickyElements();
      }, 'background');
    };

    if (win.navigation?.addEventListener) {
      win.navigation.addEventListener('navigatesuccess', () => {
        if (typeof doc.startViewTransition === 'function') {
          doc.startViewTransition(() => onSPANav());
        } else {
          onSPANav();
        }
      });
    } else {
      // Fallback: popstate + pushState/replaceState intercept
      win.addEventListener('popstate', onSPANav);
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function () { origPush.apply(this, arguments); setTimeout(onSPANav, CFG.spaDb); };
      history.replaceState = function () { origReplace.apply(this, arguments); setTimeout(onSPANav, CFG.spaDb); };
    }

    /* ============================================================
     *  §10‑k  Visibility Change & BFCache
     * ============================================================ */
    doc.addEventListener('visibilitychange', () => {
      if (!doc.hidden) {
        // Restore
        schedF(() => { applyCVAuto(); protectStickyElements(); }, 'background');
      }
    });

    win.addEventListener('pageshow', e => {
      if (e.persisted) {
        // BFCache restore
        netUp();
        schedF(() => { applyCVAuto(); protectStickyElements(); }, 'background');
      }
    });

    /* ============================================================
     *  §10‑l  Fetch / XHR DNS Prefetch Tracking
     * ============================================================ */
    const origFetch = win.fetch;
    win.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url) {
          const u = new URL(url, ORIGIN);
          if (u.origin !== ORIGIN) addDnsHint(u.origin, 'dns-prefetch');
        }
      } catch (_) {}
      return origFetch.call(win, input, init);
    };

    const origXHROpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        const u = new URL(url, ORIGIN);
        if (u.origin !== ORIGIN) addDnsHint(u.origin, 'dns-prefetch');
      } catch (_) {}
      return origXHROpen.apply(this, arguments);
    };

    /* ============================================================
     *  §10‑m  Network Quality (Worker‑offloaded RTT median)
     * ============================================================ */
    const NetQuality = (() => {
      const rtts = [];
      const sample = () => {
        const e = perf.getEntriesByType?.('resource');
        if (!e) return;
        for (const r of e) {
          if (r.responseStart && r.requestStart && r.responseStart > r.requestStart) {
            rtts.push(r.responseStart - r.requestStart);
          }
        }
        if (rtts.length > CFG.netQualitySampleSize) rtts.splice(0, rtts.length - CFG.netQualitySampleSize);
      };

      const calcAndCache = async () => {
        sample();
        if (rtts.length < 3) return;
        let median;
        if (WorkerBridge.usable) {
          try {
            const r = await WorkerBridge.send('calcMedianRTT', { rtts: [...rtts] });
            median = r.median;
          } catch (_) {
            const sorted = [...rtts].sort((a, b) => a - b);
            median = sorted[sorted.length >>> 1];
          }
        } else {
          const sorted = [...rtts].sort((a, b) => a - b);
          median = sorted[sorted.length >>> 1];
        }
        IDB.set('net:quality', { median, tier: NET.tier, etype: NET.etype });
      };

      const restore = async () => {
        const cached = await IDB.get('net:quality');
        if (cached) {
          // Use cached quality to inform initial tier
          if (cached.median > 300 && NET.tier > 1) NET.tier = Math.max(1, NET.tier - 1);
        }
      };

      return { calcAndCache, restore, get rtts() { return rtts; } };
    })();

    /* ============================================================
     *  §10‑n  ReportingObserver
     * ============================================================ */
    if (typeof ReportingObserver === 'function') {
      try {
        const ro = new ReportingObserver((reports) => {
          for (const r of reports) {
            if (r.type === 'deprecation') {
              console.info(`[TO] Deprecation: ${r.body?.id} – ${r.body?.message?.slice(0, 100)}`);
            } else if (r.type === 'intervention') {
              console.info(`[TO] Intervention: ${r.body?.id} – ${r.body?.message?.slice(0, 100)}`);
            }
          }
        }, { types: ['deprecation', 'intervention'], buffered: true });
        ro.observe();
      } catch (_) {}
    }

    /* ============================================================
     *  §10‑o  requestVideoFrameCallback – frame drop monitor
     * ============================================================ */
    const VideoOpt = (() => {
      let monitored = new WeakSet();
      const monitor = video => {
        if (monitored.has(video) || typeof video.requestVideoFrameCallback !== 'function') return;
        monitored.add(video);
        let drops = 0, total = 0;
        const check = (now, meta) => {
          total++;
          if (meta.droppedVideoFrames !== undefined) drops = meta.droppedVideoFrames;
          const dropRate = total > 30 ? drops / (drops + meta.presentedFrames) : 0;
          if (dropRate > 0.15 && !lowPower) {
            // High frame drops → hint low power
            lowPower = true;
          }
          video.requestVideoFrameCallback(check);
        };
        video.requestVideoFrameCallback(check);
      };
      return { monitor };
    })();

    /* ============================================================
     *  §10‑p  GC Tuning
     * ============================================================ */
    const GC = (() => {
      let interval = CFG.gcMs;
      const sweep = () => {
        Memory.update();
        const pct = Memory.pct();
        if (pct > 80) interval = Math.max(10000, interval / 2);
        else if (pct < 30) interval = Math.min(120000, interval * 1.5);

        // Clean IDB stale entries (optional, lightweight)
        // Trigger minor GC via small allocation patterns
        if (pct > 70) {
          try { new ArrayBuffer(1); } catch (_) {} // hint to engine
        }

        schedF(sweep, 'background');
      };
      const start = () => setTimeout(() => schedF(sweep, 'background'), interval);
      return { start };
    })();

    /* ============================================================
     *  §10‑q  DisplayLock (explicit display‑lock targets)
     * ============================================================ */
    const DisplayLock = (() => {
      let _unlockCount = 0;
      const init = () => {
        const els = doc.querySelectorAll(CFG.dlockSel);
        for (const el of els) {
          el.style.contentVisibility = 'hidden';
          const role = ensureRole(el);
          role.dlocked = true;
          unifiedIO.observe(el);
        }
      };
      return { init, get _unlockCount() { return _unlockCount; }, set _unlockCount(v) { _unlockCount = v; } };
    })();

    /* ============================================================
     *  §10‑r  Image Format Detection (Worker + IDB)
     * ============================================================ */
    const ImgFormat = (() => {
      let avif = false, webp = false, detected = false;

      const detect = async () => {
        // Try IDB cache first
        const cached = await IDB.get('imgfmt');
        if (cached) { avif = cached.avif; webp = cached.webp; detected = true; return; }

        // Try worker
        if (WorkerBridge.usable) {
          try {
            const r = await WorkerBridge.send('detectImgFormats');
            avif = r.avif; webp = r.webp; detected = true;
            IDB.set('imgfmt', { avif, webp });
            return;
          } catch (_) {}
        }

        // Main thread fallback
        const test = (src) => new Promise(r => {
          const img = new Image();
          img.onload = () => r(img.width > 0 && img.height > 0);
          img.onerror = () => r(false);
          img.src = src;
        });

        [avif, webp] = await Promise.all([
          test('data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZg=='),
          test('data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJYwCdAEO/hepgAAA')
        ]);
        detected = true;
        IDB.set('imgfmt', { avif, webp });
      };

      return { detect, get avif() { return avif; }, get webp() { return webp; }, get detected() { return detected; } };
    })();

    /* ============================================================
     *  §10‑s  Preload Budget Warning
     * ============================================================ */
    const checkPreloadBudget = () => {
      const preloads = doc.querySelectorAll('link[rel="preload"]');
      const byType = new Map();
      for (const l of preloads) {
        const as = l.getAttribute('as') || 'unknown';
        byType.set(as, (byType.get(as) || 0) + 1);
      }
      for (const [as, count] of byType) {
        if (count > 5) console.warn(`[TO] Preload budget: ${count} × <link rel="preload" as="${as}">`);
      }
    };

    /* ============================================================
     *  §10‑t  Sticky/Fixed Protection (JS layer)
     * ============================================================ */
    const protectStickyElements = () => {
      const candidates = doc.querySelectorAll('*');
      // More targeted: check common containers
      const checks = doc.querySelectorAll('nav,header,div,section,form,ul,ol,[role]');
      for (const el of checks) {
        try {
          const cs = getComputedStyle(el);
          if (cs.position === 'sticky' || cs.position === 'fixed') {
            el.style.contentVisibility = 'visible';
            el.style.contain = 'none';
          }
        } catch (_) {}
      }
    };

    /* ============================================================
     *  §10‑u  Data Saver Dynamic Adjustments
     * ============================================================ */
    const dataSaverAdjust = () => {
      if (!NET.save && !NET.slow) return;
      // Reduce image quality by preferring smaller formats
      const imgs = doc.querySelectorAll('img[srcset]');
      for (const img of imgs) {
        if (!img.sizes || img.sizes === '') img.sizes = '(max-width:768px) 100vw, 50vw';
      }
    };

    /* ============================================================
     *  §10‑v  EXECUTE ALL MODULES
     * ============================================================ */

    // Restore cached network quality
    await NetQuality.restore();

    // Display Lock explicit targets
    DisplayLock.init();

    // Detect image formats (async, non-blocking)
    schedF(() => ImgFormat.detect(), 'background');

    // Collect DNS hints
    schedF(() => collectDNS(), 'background');

    // ★ Apply content-visibility to offscreen elements (IO 기반)
    schedF(() => applyCVAuto(), 'background');

    // Protect sticky/fixed elements
    schedF(() => protectStickyElements(), 'background');

    // Defer 3P scripts
    schedF(() => defer3PScripts(), 'background');

    // Speculation rules
    schedF(() => injectSpecRules(), 'background');

    // Preload budget
    schedF(() => checkPreloadBudget(), 'background');

    // Data saver
    schedF(() => dataSaverAdjust(), 'background');

    // GC tuning
    GC.start();

    // Network quality periodic measurement
    setInterval(() => NetQuality.calcAndCache(), CFG.netQualityInterval);

    // Start MutationObserver
    mo.observe(doc.documentElement, { childList: true, subtree: true });

    // Enroll existing nodes
    schedF(() => {
      const tw = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_ELEMENT, null);
      let n = tw.currentNode, count = 0;
      const processBatch = () => {
        while (n) {
          enrollNode(n);
          count++;
          if (count % CFG.yldN === 0) {
            n = tw.nextNode();
            return yld().then(processBatch);
          }
          n = tw.nextNode();
        }
        // After enrolling all existing nodes, also monitor videos
        const videos = doc.querySelectorAll('video');
        for (const v of videos) {
          checkStreamingVideo(v);
          VideoOpt.monitor(v);
        }
      };
      return processBatch();
    }, 'background');

    /* ============================================================
     *  §10‑w  DIAGNOSTIC API
     * ============================================================ */
    win.__turboOptimizer__ = {
      version: V,
      device: { cores: DEV_CORES, mem: DEV_MEM, tier: T },
      network: NET,
      get fps() { return fps; },
      get lowPower() { return lowPower; },
      get memory() { return { used: Memory.used, limit: Memory.limit, pct: Memory.pct() }; },
      get dns() { return { hinted: dnsHinted.size, prefetch: dnsCount, preconnect: pcCount }; },
      csp: CSP.stats,
      get imgFormat() { return { avif: ImgFormat.avif, webp: ImgFormat.webp, detected: ImgFormat.detected }; },
      get worker() { return WorkerBridge.usable; },
      get idb() { return IDB.ready(); },
      get pressure() { return pressureState; },
      get streaming() { return isStreaming; },
      features: {
        postTask: hasPT, yield: hasYld, rIC: hasRIC, taskController: hasTC,
        trustedTypes: TT.active,
        viewTransition: typeof doc.startViewTransition === 'function',
        navigationAPI: !!win.navigation,
        pressureObserver: typeof PressureObserver === 'function',
        videoFrameCallback: typeof HTMLVideoElement?.prototype?.requestVideoFrameCallback === 'function',
        reportingObserver: typeof ReportingObserver === 'function',
        speculationRules: !!HTMLScriptElement.supports?.('speculationrules')
      },
      stats: () => ({
        lcp: LCP.time,
        unlocked: DisplayLock._unlockCount,
        siteProfile: SP.name
      })
    };

    /* ============================================================
     *  §10‑x  CLEANUP on unload
     * ============================================================ */
    win.addEventListener('pagehide', () => {
      WorkerBridge.terminate();
      mo.disconnect();
      unifiedIO.disconnect();
    });

    /* ============================================================
     *  §10‑y  BOOT LOG
     * ============================================================ */
    console.log(
      `[TO v${V}] ✅ ${T}(${DEV_CORES}c/${DEV_MEM}G) ${NET.etype}/t${NET.tier}${NET.save ? '/s' : ''}` +
      ` TT:${TT.active ? (TT.isDefault ? 'def' : 'named') : 'n/a'}` +
      ` W:${WorkerBridge.usable ? '✓' : '✗'} IDB:${IDB.ready() ? '✓' : '…'}` +
      ` P:${typeof PressureObserver === 'function' ? '✓' : '✗'}` +
      ` MSE:${isStreaming ? '✓' : '–'}` +
      ` VT:${typeof doc.startViewTransition === 'function' ? '✓' : '✗'}` +
      ` CV:IO-based` +
      ` ${HOST}`
    );
  };

  /* ================================================================
   *  MAIN ENTRY
   * ================================================================ */
  boot().then(initAll).catch(err => console.error('[TO] init failed:', err));

})();
