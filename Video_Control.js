// ==UserScript==
// @name         Video_Control (v31.7.6)
// @namespace    https://github.com/moamoa7
// @version      31.7.6
// @description  v31.7.6: 수동 조정 파라미터 재조정 (2/3) toe / mid / shoulder / gamma / contrast
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://*.cloudflare.com/cdn-cgi/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @allFrames    true
// ==/UserScript==

(function () {
  'use strict';

  if (!window.chrome && !navigator.userAgentData) return;
  if (location.href.includes('/cdn-cgi/') || location.protocol === 'about:' || location.href === 'about:blank') return;
  if (window.__vsc_booted) return;
  window.__vsc_booted = true;

  const __internal = window.__vsc_internal || (window.__vsc_internal = {});
  const IS_MOBILE = navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);
  const VSC_ID = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
  const VSC_VERSION = '31.7.6';
  const DEBUG = false;

  const log = {
    info: DEBUG ? (...a) => console.info('[VSC]', ...a) : () => {},
    warn: (...a) => console.warn('[VSC]', ...a),
    error: (...a) => console.error('[VSC]', ...a)
  };

  function normalizeHostname(hostname) {
    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) return hostname;
    let norm = parts;
    if (norm[0] === 'www') norm = norm.slice(1);
    return norm.join('.');
  }
  const STORAGE_KEY = 'vsc_v2_' + normalizeHostname(location.hostname) + (location.pathname.startsWith('/shorts') ? '_shorts' : '');
  const CLAMP = (v, min, max) => v < min ? min : v > max ? max : v;

  // (1) getSharpProfile - autoBase 하향 & cap 하향
function getSharpProfile(nW) {
    if (nW > 2560) return { cap: 0.20, diagRatio: 0.60, autoBase: 0.12 };  // cap 0.25→0.20
    if (nW > 1920) return { cap: 0.18, diagRatio: 0.65, autoBase: 0.10 };  // cap 0.22→0.18
    const autoBase = nW <= 640 ? 0.14    // 0.18→0.14
                   : nW <= 960 ? 0.12    // 0.14→0.12
                   : nW <= 1280 ? 0.12   // 0.13→0.12 (통일)
                   : 0.12;
    return { cap: 0.16, diagRatio: 0.707, autoBase };  // cap 0.18→0.16
}
  const SHARP_CAP_DEFAULT = 0.16;

  function onFsChange(fn) {
    document.addEventListener('fullscreenchange', fn);
    document.addEventListener('webkitfullscreenchange', fn);
  }

  function checkNeedsSvg(s) {
    const hasSharp = Math.abs(s.sharp || 0) > 0.005;
    const hasTone = (
      Math.abs(s.toe      || 0) > 0.001 ||
      Math.abs(s.mid      || 0) > 0.001 ||
      Math.abs(s.shoulder || 0) > 0.001 ||
      Math.abs((s.gain     || 1) - 1) > 0.005 ||
      Math.abs((s.gamma    || 1) - 1) > 0.005 ||
      Math.abs((s.contrast || 1) - 1) > 0.005
    );
    return hasSharp || hasTone || Math.abs(s.temp || 0) > 0.5 || Math.abs(s.tint || 0) > 0.5;
  }

  function applyFilterStyles(el, filterStr) {
    if (!el?.style) return;
    el.style.setProperty('filter', filterStr, 'important');
  }
  function clearFilterStyles(el) {
    if (!el?.style) return;
    el.style.removeProperty('filter');
  }

  const _SHIELD_EVENTS = ['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','touchstart','touchmove','touchend','click','dblclick','contextmenu'];
  function shieldHost(hostEl) {
    for (const evt of _SHIELD_EVENTS) {
      hostEl.addEventListener(evt, (e) => {
        e.stopPropagation();
       }, { capture: false, passive: true });
    }
  }

  const PRESETS = Object.freeze({
    detail: {
      none: { label: 'OFF' },
      off:  { label: 'AUTO' },
      S:    { sharpAdd: 4,  sharp2Add: 2,  clarityAdd: 2,  label: '1단' },
      M:    { sharpAdd: 7,  sharp2Add: 4,  clarityAdd: 4,  label: '2단' },
      L:  { sharpAdd: 8,  sharp2Add: 4,  clarityAdd: 4,  label: '3단' },  // 10→8
      XL: { sharpAdd: 10, sharp2Add: 5,  clarityAdd: 4,  label: '4단' },  // 12→10, 5→4
    }
  });
  const _PRESET_SHARP_LUT = {};
  for (const [key, d] of Object.entries(PRESETS.detail)) {
    if (key === 'none' || key === 'off') continue;
    _PRESET_SHARP_LUT[key] = (d.sharpAdd + d.sharp2Add * 0.6 + d.clarityAdd * 0.4) * 0.01;
  }

  function tempTintToRgbGain(temp, tint) {
    const t = CLAMP((Number(temp) || 0) * 0.02, -1, 1);
    const n = CLAMP((Number(tint) || 0) * 0.02, -1, 1);
    if (Math.abs(t) < 0.001 && Math.abs(n) < 0.001) return { rs: 1, gs: 1, bs: 1 };
    let r = 1 + 0.14 * t + 0.06 * n;
    let g = 1 - 0.005 * Math.abs(t) - 0.14 * n;
    let b = 1 - 0.14 * t + 0.06 * n;
    const maxCh = Math.max(r, g, b);
    return { rs: r / maxCh, gs: g / maxCh, bs: b / maxCh };
  }

const MANUAL_PRESETS = [
  { n: 'OFF',  v: [ 0,  0,  0,  0,  0,  0,   0,   0,   0] },
  { n: '보정', v: [ 0,  0,  5,  0,  0,  -5,   0,  10,   5] },
  { n: '필름', v: [14,  0,  4,  8, -2,-12,  -8,   4,   3] },
  { n: '블버', v: [ 0,  0,  8, -4,  2, -6,  -3,  12,   6] },
  { n: '애니', v: [ 0,  0,  6,  0,  0,  6,  -4,   6,   3] },
  { n: 'MAX', v: [ 30,  20,  5,  0,  0,  -10, -10,  20,  5] },
];

  const DEFAULTS = {
    video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0, manualTemp: 0, manualTint: 0, manualSat: 0, manualGamma: 0, manualContrast: 0, manualGain: 0, manualPreGain: 100 },
    audio: { enabled: false, strength: 50, surroundWidth: 0, clarity: 0, boost: 100 },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false }
  };
  const P = {
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible',
    V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
    V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery',
    V_MAN_BRT: 'video.manualBright', V_MAN_TEMP: 'video.manualTemp',
    V_MAN_TINT: 'video.manualTint', V_MAN_SAT: 'video.manualSat',
    V_MAN_GAMMA: 'video.manualGamma', V_MAN_CON: 'video.manualContrast',
    V_MAN_GAIN: 'video.manualGain',
    V_MAN_PREGAIN: 'video.manualPreGain',
    A_EN: 'audio.enabled', A_STR: 'audio.strength',
    A_SURROUND: 'audio.surroundWidth',
    A_CLARITY: 'audio.clarity', A_BOOST: 'audio.boost',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  };

  const MANUAL_PATHS = [P.V_MAN_SHAD, P.V_MAN_REC, P.V_MAN_BRT, P.V_MAN_TEMP, P.V_MAN_TINT, P.V_MAN_SAT, P.V_MAN_GAMMA, P.V_MAN_CON, P.V_MAN_GAIN];
  const MANUAL_KEYS = MANUAL_PATHS.map(p => p.split('.')[1]);

  function createLocalStore(defaults, scheduler) {
    let rev = 0;
    const _kc = Object.create(null);
    const listeners = new Map();
    const state = JSON.parse(JSON.stringify(defaults));
    const emit = (key, val) => { const a = listeners.get(key); if (a) for (const fn of a) try { fn(val); } catch (_) {} };
    const _resolve = (p) => _kc[p] || (_kc[p] = p.split('.'));
    return {
      state, rev: () => rev,
      get: (p) => { const pts = _resolve(p); return pts.length > 1 ? state[pts[0]]?.[pts[1]] : state[pts[0]]; },
      set: (p, val) => {
        if (typeof val === 'number' && Number.isNaN(val)) return;
        const pts = _resolve(p);
        const [c, k] = pts;
        if (k == null) { log.warn('[Store] single-level key 미지원:', p); return; }
        if (Object.is(state[c]?.[k], val)) return;
        state[c][k] = val; rev++; emit(p, val); scheduler.request();
      },
      batch: (cat, obj) => {
        let changed = false;
        const pending = [];
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number' && Number.isNaN(v)) continue;
          if (!Object.is(state[cat]?.[k], v)) {
            state[cat][k] = v;
            changed = true;
            pending.push([`${cat}.${k}`, v]);
          }
        }
        if (changed) {
          rev++;
          for (const [path, val] of pending) emit(path, val);
          scheduler.request();
        }
      },
      sub: (k, f) => {
        if (!listeners.has(k)) listeners.set(k, new Set());
        listeners.get(k).add(f);
        return () => listeners.get(k).delete(f);
      },
      load: (data) => {
        if (!data) return;
        for (const c of Object.keys(defaults)) {
          if (data[c] != null && typeof data[c] === 'object') {
            for (const [k, v] of Object.entries(data[c])) {
              if (k in defaults[c] && typeof v === typeof defaults[c][k]) {
                state[c][k] = v;
              }
            }
          }
        }
        rev++;
      }
    };
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SVG_TAGS = new Set(['svg','defs','filter','feComponentTransfer','feFuncR','feFuncG','feFuncB','feFuncA','feConvolveMatrix','feColorMatrix','feGaussianBlur','feMerge','feMergeNode','feComposite','feBlend','feTurbulence','g','path','circle','rect','line','text','polyline','polygon']);

  function h(tag, props = {}, ...children) {
    const isSvg = props.ns === 'svg' || SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'ns') continue;
      if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'class') { el.setAttribute('class', v); }
      else if (v !== false && v != null) el.setAttribute(k, String(v));
    }
    children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  function createScheduler() {
    let queued = false, applyFn = null, pendingHidden = false;
    const signalFns = new Set();

    function doFrame() {
      queued = false;
      if (applyFn) try { applyFn(); } catch (_) {}
      for (const fn of signalFns) try { fn(); } catch (_) {}
    }

    const self = {
      registerApply: fn => { applyFn = fn; },
      onSignal: fn => {
        signalFns.add(fn);
        return () => signalFns.delete(fn);
      },
      request: () => {
        if (queued) return;
        if (document.hidden) { pendingHidden = true; return; }
        queued = true;
        requestAnimationFrame(doFrame);
      }
    };

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && pendingHidden) {
        pendingHidden = false;
        self.request();
      }
    }, { passive: true });

    return self;
  }

  function createRegistry(scheduler) {
    const videos = new Set();
    const shadowRootsLRU = [];
    const observedShadowHosts = new WeakSet();
    const SHADOW_MAX = 16;
    const observers = new Set();
    const shadowMOs = new WeakMap();
    const videoListeners = new WeakMap();
    const rvfcHandles = new WeakMap();

    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => { for (const e of entries) { if (e.isIntersecting || e.intersectionRatio > 0) { scheduler.request(); return; } } }, { root: null, threshold: [0, 0.05, 0.5], rootMargin: '150px' }) : null;
    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => { for (const e of entries) { if (e.target.tagName === 'VIDEO') { scheduler.request(); return; } } }) : null;

    const isVscNode = (n) => { if (!n || n.nodeType !== 1) return false; return !!(n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host' || n.id === 'vsc-osd'); };

    let _onLoadstartCallback = null;
    function setOnLoadstartCallback(fn) { _onLoadstartCallback = fn; }

    function observeVideo(el) {
      if (!el || el.tagName !== 'VIDEO' || videos.has(el)) return;
      videos.add(el);
      const req = () => { scheduler.request(); };
      let lastFW = 0, lastFH = 0;
      let rvfcHandle = 0;
      let rvfcRunning = false;

      function cancelRVFC() {
        if (rvfcHandle) { try { el.cancelVideoFrameCallback(rvfcHandle); } catch(_){} rvfcHandle = 0; }
        rvfcRunning = false;
      }
      function vfcTick(now, meta) {
        if (!el.isConnected) { cancelRVFC(); return; }
        const fw = meta.width || el.videoWidth || 0;
        const fh = meta.height || el.videoHeight || 0;
        if (fw !== lastFW || fh !== lastFH) { lastFW = fw; lastFH = fh; scheduler.request(); }
        rvfcHandle = el.requestVideoFrameCallback(vfcTick);
      }
      function startRVFC() {
        if (rvfcRunning) return;
        rvfcRunning = true; lastFW = 0; lastFH = 0;
        rvfcHandle = el.requestVideoFrameCallback(vfcTick);
      }
      rvfcHandles.set(el, { getHandle: () => rvfcHandle });

      const onEncrypted = () => { el.dataset.vscDrm = "1"; scheduler.request(); };
      const onWaitingForKey = () => { el.dataset.vscDrm = "1"; scheduler.request(); };
      const onPlaying = () => { startRVFC(); };
      const onSeeked = () => { cancelRVFC(); startRVFC(); };
      const onLoadedMetadata = () => { cancelRVFC(); startRVFC(); req(); };
      const onPause = () => { cancelRVFC(); };
      const onResize = req;
      const onLoadstart = () => {
        cancelRVFC();
        delete el.dataset.vscDrm; delete el.dataset.vscPbFail; delete el.dataset.vscPbRetry; delete el.dataset.vscCorsFail; delete el.dataset.vscAudioCorsFail; delete el.dataset.vscPermBypass; delete el.dataset.vscMesFail;
        if (_onLoadstartCallback) try { _onLoadstartCallback(el); } catch (_) {}
        req();
      };

      const listenerDefs = [
        ['encrypted', onEncrypted], ['waitingforkey', onWaitingForKey],
        ['playing', onPlaying], ['seeked', onSeeked],
        ['loadedmetadata', onLoadedMetadata], ['pause', onPause],
        ['ended', onPause], ['resize', onResize], ['loadstart', onLoadstart]
      ];
      for (const [evt, fn] of listenerDefs) el.addEventListener(evt, fn, { passive: true });
      videoListeners.set(el, listenerDefs);
      if (io) io.observe(el);
      if (ro) ro.observe(el);
      req();
    }

    function addShadowRoot(host) {
      if (!host?.shadowRoot || observedShadowHosts.has(host)) return false;
      observedShadowHosts.add(host);
      if (shadowRootsLRU.length >= SHADOW_MAX) {
        const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
        let evicted;
        if (idx >= 0) { evicted = shadowRootsLRU.splice(idx, 1)[0]; if (evicted?.host) observedShadowHosts.delete(evicted.host); }
        else { evicted = shadowRootsLRU.shift(); if (evicted?.host) observedShadowHosts.delete(evicted.host); }
        if (evicted?.root) { const mo = shadowMOs.get(evicted.root); if (mo) { try { mo.disconnect(); } catch (_) {} shadowMOs.delete(evicted.root); } }
      }
      shadowRootsLRU.push({ host, root: host.shadowRoot });
      connectObserver(host.shadowRoot);
      return true;
    }

    function scanNode(n) {
      if (!n) return;
      if (n.nodeType === 1) {
        if (n.tagName === 'VIDEO') { observeVideo(n); return; }
        if (n.shadowRoot && addShadowRoot(n)) scanNode(n.shadowRoot);
        if (!n.childElementCount) return;
        try { const vs = n.getElementsByTagName('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {}
      } else if (n.nodeType === 11) { try { const vs = n.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
    }

    const workQ = []; let workScheduled = false;
    function scheduleWork() {
      if (workScheduled) return; workScheduled = true;
      const doWork = () => { workScheduled = false; const batch = workQ.splice(0, 20); for (const n of batch) scanNode(n); if (workQ.length > 0) scheduleWork(); };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(doWork, { timeout: 120 }); else setTimeout(doWork, 0);
    }
    function enqueue(n) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
      if (n.nodeType === 1 && n.tagName !== 'VIDEO' && !n.shadowRoot && !n.childElementCount) return;
      if (workQ.length > 500) return;
      workQ.push(n); scheduleWork();
    }

    function connectObserver(root) {
      if (!root) return;
      const mo = new MutationObserver((muts) => {
        let touchedVideo = false;
        for (const m of muts) {
          if (m.addedNodes?.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; if (n.nodeType === 1 && isVscNode(n)) continue; enqueue(n); if (!touchedVideo && n.nodeType === 1) { if (n.tagName === 'VIDEO') touchedVideo = true; else if (n.childElementCount) { try { const l = n.getElementsByTagName('video'); if (l?.length) touchedVideo = true; } catch (_) {} } } } }
          if (!touchedVideo && m.removedNodes?.length) { for (const n of m.removedNodes) { if (n?.nodeType === 1 && (n.tagName === 'VIDEO' || n.querySelector?.('video'))) { touchedVideo = true; break; } } }
        }
        if (touchedVideo) scheduler.request();
      });
      mo.observe(root, { childList: true, subtree: true });
      if (root instanceof ShadowRoot) shadowMOs.set(root, mo); else observers.add(mo);
      enqueue(root);
    }

    const root = document.body || document.documentElement;
    if (root) { connectObserver(root); }
    if (!document.body && document.documentElement) {
      const earlyMo = new MutationObserver(() => { if (document.body) { earlyMo.disconnect(); connectObserver(document.body); } });
      earlyMo.observe(document.documentElement, { childList: true });
    }

    function scanShadowRoots() {
      try {
        const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT, { acceptNode: function(node) { return node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP; } });
        let el; while (el = walker.nextNode()) { if (addShadowRoot(el)) scanNode(el.shadowRoot); }
      } catch (_) {}
    }

    let _purgeCallback = null;
    function setPurgeCallback(fn) { _purgeCallback = fn; }

    function cleanup() {
      const dead = [];
      for (const el of videos) { if (!el?.isConnected) dead.push(el); }
      for (const el of dead) {
        videos.delete(el); clearFilterStyles(el);
        const rvfc = rvfcHandles.get(el);
        if (rvfc) { try { el.cancelVideoFrameCallback(rvfc.getHandle()); } catch (_) {} rvfcHandles.delete(el); }
        if (io) try { io.unobserve(el); } catch (_) {}
        if (ro) try { ro.unobserve(el); } catch (_) {}
        const ls = videoListeners.get(el);
        if (ls) { for (const [evt, fn] of ls) el.removeEventListener(evt, fn); videoListeners.delete(el); }
      }
      for (let i = shadowRootsLRU.length - 1; i >= 0; i--) {
        const entry = shadowRootsLRU[i];
        if (!entry.host?.isConnected) {
          if (_purgeCallback && entry.root) try { _purgeCallback(entry.root); } catch (_) {}
          const mo = entry.root ? shadowMOs.get(entry.root) : null;
          if (mo) { try { mo.disconnect(); } catch (_) {} shadowMOs.delete(entry.root); }
          if (entry.host) observedShadowHosts.delete(entry.host);
          shadowRootsLRU.splice(i, 1);
        }
      }
      if (dead.length) scheduler.request();
    }

    return { videos, shadowRootsLRU, rescanAll: () => scanNode(document.body || document.documentElement), cleanup, scanShadowRoots, setPurgeCallback, setOnLoadstartCallback };
  }

  function createTargeting() {
    return {
      pick: (videos) => {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        if (fsEl) {
          if (fsEl.tagName === 'VIDEO' && videos.has(fsEl)) return fsEl;
          for (const v of videos) { if (v.isConnected && fsEl.contains(v)) return v; }
        }
        let best = null, bestScore = -Infinity;
        for (const v of videos) {
          if (!v.isConnected) continue;
          const dW = v.clientWidth || 0, dH = v.clientHeight || 0, area = dW * dH;
          if (area === 0 && v.readyState === 0 && v.paused) continue;
          let s = Math.log2(1 + Math.max(0, area));
          if (!v.paused && !v.ended) s += 25;
          if (v.currentTime > 0) s += 5;
          if (!v.muted && v.volume > 0.01) s += 5;
          if (s > bestScore) { bestScore = s; best = v; }
        }
        return best;
      }
    };
  }

  function createAudio(store, scheduler) {
    let ctx = null;
    let splitter = null, merger = null;
    let delayL = null, delayR = null, crossGainLR = null, crossGainRL = null, dryGainL = null, dryGainR = null;
    let eqLow = null, eqMid = null, eqHigh = null;
    let routeGain = null;
    let comp = null, limiter = null, makeupGain = null;
    let compBypass = null;
    let boostGain = null;
    let masterOut = null;
    let fullDryPath = null;
    let currentSrc = null, targetVideo = null;
    let currentMode = 'none';
    let currentRouteIsProcessed = false;
    const mesMap = new WeakMap();
    const streamMap = new WeakMap();
    let bypassMode = false;
    let generation = 0;

    const jwCache = new WeakMap();
    function detectJWPlayer(video) {
      if (!video) return false;
      if (jwCache.has(video)) return jwCache.get(video);
      let result = false;
      if (typeof window.jwplayer === 'function') { try { if (window.jwplayer()?.getContainer?.()) result = true; } catch (_) {} }
      if (!result) { let el = video.parentElement, depth = 0; while (el && depth < 10) { if (el.classList?.contains('jwplayer') || el.id?.startsWith('jwplayer') || el.classList?.contains('jw-wrapper') || el.querySelector?.(':scope > .jw-media, :scope > .jw-controls')) { result = true; break; } el = el.parentElement; depth++; } }
      if (!result && video.src?.startsWith('blob:')) { if (document.querySelector('script[src*="jwplayer"]') || document.querySelector('[class*="jw-"]')) result = true; }
      jwCache.set(video, result); return result;
    }

    function canConnect(video) {
      if (!video) return false;
      if (video.dataset.vscPermBypass === "1") return false;
      if (detectJWPlayer(video) && video.dataset.vscAudioCorsFail === "1") return false;
      if (video.dataset.vscMesFail === "1" && video.dataset.vscAudioCorsFail === "1") return false;
      return true;
    }

    const isAnyAudioActive = () => store.get(P.A_EN) || Number(store.get(P.A_SURROUND)) > 0 || Number(store.get(P.A_CLARITY)) > 0 || Number(store.get(P.A_BOOST)) !== 100;

    function initCtx() {
      if (ctx) return true;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try { ctx = new AC({ latencyHint: 'playback' }); } catch (_) { return false; }
      try { ctx.addEventListener('statechange', () => { if (ctx.state === 'running') scheduler.request(); }); } catch (_) {}

      splitter = ctx.createChannelSplitter(2); merger = ctx.createChannelMerger(2);
      delayL = ctx.createDelay(0.05); delayR = ctx.createDelay(0.05);
      crossGainLR = ctx.createGain(); crossGainRL = ctx.createGain();
      dryGainL = ctx.createGain(); dryGainR = ctx.createGain();
      dryGainL.gain.value = 1; dryGainR.gain.value = 1;
      crossGainLR.gain.value = 0; crossGainRL.gain.value = 0;
      splitter.connect(dryGainL, 0); splitter.connect(dryGainR, 1);
      dryGainL.connect(merger, 0, 0); dryGainR.connect(merger, 0, 1);
      splitter.connect(delayL, 0); splitter.connect(delayR, 1);
      delayL.connect(crossGainLR); delayR.connect(crossGainRL);
      crossGainLR.connect(merger, 0, 1); crossGainRL.connect(merger, 0, 0);

      eqLow = ctx.createBiquadFilter(); eqLow.type = 'lowshelf'; eqLow.frequency.value = 200; eqLow.gain.value = 0;
      eqMid = ctx.createBiquadFilter(); eqMid.type = 'peaking'; eqMid.frequency.value = 2500; eqMid.Q.value = 1.2; eqMid.gain.value = 0;
      eqHigh = ctx.createBiquadFilter(); eqHigh.type = 'highshelf'; eqHigh.frequency.value = 8000; eqHigh.gain.value = 0;
      routeGain = ctx.createGain(); routeGain.gain.value = 1;
      merger.connect(eqLow); eqLow.connect(eqMid); eqMid.connect(eqHigh); eqHigh.connect(routeGain);

      comp = ctx.createDynamicsCompressor();
      makeupGain = ctx.createGain(); makeupGain.gain.value = 1;
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3.0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.15; limiter.knee.value = 2;
      compBypass = ctx.createGain(); compBypass.gain.value = 1;
      boostGain = ctx.createGain(); boostGain.gain.value = 1;
      masterOut = ctx.createGain(); masterOut.gain.value = 1;
      comp.connect(makeupGain); makeupGain.connect(limiter); limiter.connect(boostGain);
      compBypass.connect(boostGain); boostGain.connect(masterOut); masterOut.connect(ctx.destination);
      fullDryPath = ctx.createGain(); fullDryPath.gain.value = 1; fullDryPath.connect(ctx.destination);

      applyStrength(Number(store.get(P.A_STR) ?? 50));
      applySurroundWidth(Number(store.get(P.A_SURROUND)) || 0);
      applyClarity(Number(store.get(P.A_CLARITY)) || 0);
      applyBoost(Number(store.get(P.A_BOOST)) ?? 100);
      routeCompressor();
      return true;
    }

    function routeCompressor() {
      if (!routeGain || !comp || !compBypass) return;
      try { routeGain.disconnect(); } catch (_) {}
      if (store.get(P.A_EN)) { routeGain.connect(comp); } else { routeGain.connect(compBypass); }
    }

    function applyStrength(strength) {
      if (!comp || !makeupGain || !ctx) return;
      const s = CLAMP(strength, 0, 100) / 100;
      if (s === 0) { comp.threshold.value = 0; comp.ratio.value = 1; comp.knee.value = 40; comp.attack.value = 0.02; comp.release.value = 0.25; try { makeupGain.gain.setTargetAtTime(1, ctx.currentTime, 0.05); } catch (_) { makeupGain.gain.value = 1; } return; }
      comp.threshold.value = -8 - s * 24; comp.ratio.value = 1.5 + s * 10.5; comp.knee.value = 16 - s * 10; comp.attack.value = 0.005 + (1 - s) * 0.015; comp.release.value = 0.30 + (1 - s) * 0.20;
      const threshAbs = Math.abs(comp.threshold.value); const makeupDb = threshAbs * (1 - 1 / comp.ratio.value) * 0.4; const gain = Math.pow(10, makeupDb / 20);
      try { makeupGain.gain.setTargetAtTime(CLAMP(gain, 1, 3), ctx.currentTime, 0.05); } catch (_) { makeupGain.gain.value = CLAMP(gain, 1, 3); }
    }

    function applySurroundWidth(width) {
      if (!ctx || !crossGainLR) return;
      const w = CLAMP(width, 0, 100) / 100; const crossLevel = w * 0.4; const dry = Math.sqrt(1 - crossLevel * crossLevel);
      try { crossGainLR.gain.setTargetAtTime(crossLevel, ctx.currentTime, 0.05); crossGainRL.gain.setTargetAtTime(crossLevel, ctx.currentTime, 0.05); dryGainL.gain.setTargetAtTime(dry, ctx.currentTime, 0.05); dryGainR.gain.setTargetAtTime(dry, ctx.currentTime, 0.05); delayL.delayTime.setTargetAtTime(0.005 + w * 0.015, ctx.currentTime, 0.05); delayR.delayTime.setTargetAtTime(0.008 + w * 0.020, ctx.currentTime, 0.05); }
      catch (_) { crossGainLR.gain.value = crossLevel; crossGainRL.gain.value = crossLevel; dryGainL.gain.value = dry; dryGainR.gain.value = dry; delayL.delayTime.value = 0.005 + w * 0.015; delayR.delayTime.value = 0.008 + w * 0.020; }
    }

    function applyClarity(clarity) {
      if (!ctx || !eqLow) return;
      const c = CLAMP(clarity, 0, 100) / 100;
      try { eqLow.gain.setTargetAtTime(-4 * c, ctx.currentTime, 0.05); eqMid.gain.setTargetAtTime(6 * c, ctx.currentTime, 0.05); eqHigh.gain.setTargetAtTime(3 * c, ctx.currentTime, 0.05); }
      catch (_) { eqLow.gain.value = -4 * c; eqMid.gain.value = 6 * c; eqHigh.gain.value = 3 * c; }
    }

    function applyBoost(boostPercent) {
      if (!ctx || !boostGain) return;
      const gain = CLAMP(boostPercent, 100, 300) / 100;
      try { boostGain.gain.setTargetAtTime(gain, ctx.currentTime, 0.05); } catch (_) { boostGain.gain.value = gain; }
    }

    function enterBypass(video, reason) {
      if (bypassMode) return; bypassMode = true; currentMode = 'bypass'; currentRouteIsProcessed = false;
      if (video && ctx && currentSrc) {
        try { currentSrc.disconnect(); } catch (_) {}
        if (currentSrc.__vsc_isCaptureStream) { if (currentSrc.__vsc_originalVolume != null) try { video.volume = currentSrc.__vsc_originalVolume; } catch (_) {} if (video.muted && currentSrc.__vsc_originalMuted === false) try { video.muted = false; } catch (_) {} const stream = currentSrc.__vsc_captureStream; if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); }
        else { try { currentSrc.connect(ctx.destination); } catch (_) {} }
      }
      currentSrc = null;
    }
    function exitBypass() { if (!bypassMode) return; bypassMode = false; }

    function connectViaCaptureStream(video) {
      if (!ctx || video.dataset.vscAudioCorsFail === "1") return null;
      let s = streamMap.get(video);
      if (s) { if (s.context === ctx) return s; if (currentSrc === s) { currentSrc = null; currentMode = 'none'; } try { s.disconnect(); } catch (_) {} if (s.__vsc_captureStream) { s.__vsc_captureStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); } streamMap.delete(video); }
      const captureFn = video.captureStream || video.mozCaptureStream;
      if (typeof captureFn !== 'function') return null;
      const originalMuted = video.muted, originalVolume = video.volume;
      let stream;
      try { stream = captureFn.call(video); } catch (e) { if (e.name === 'SecurityError' || e.message?.includes('cross-origin')) { video.dataset.vscAudioCorsFail = "1"; return null; } return null; }
      if (stream.getAudioTracks().length === 0) { setTimeout(() => { if (stream.getAudioTracks().length > 0) scheduler.request(); }, 500); return null; }
      try { const source = ctx.createMediaStreamSource(stream); source.__vsc_isCaptureStream = true; source.__vsc_captureStream = stream; source.__vsc_originalMuted = originalMuted; source.__vsc_originalVolume = originalVolume; video.muted = true; streamMap.set(video, source); return source; }
      catch (e) { stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); return null; }
    }

    function connectViaMES(video) {
      if (!ctx || video.dataset.vscMesFail === "1") return null;
      let s = mesMap.get(video);
      if (s) { if (s.context === ctx) return s; mesMap.delete(video); return null; }
      try { s = ctx.createMediaElementSource(video); mesMap.set(video, s); return s; }
      catch (e) { video.dataset.vscMesFail = "1"; return null; }
    }

    function connectSource(video) {
      if (!video || !ctx) return false;
      if (!canConnect(video)) { enterBypass(video, 'pre-check'); return false; }
      const isJW = detectJWPlayer(video);
      let source = null;
      if (isJW) { source = connectViaCaptureStream(video); if (!source) { video.dataset.vscPermBypass = "1"; enterBypass(video, 'JW fail'); return false; } }
      else { source = connectViaMES(video); if (!source) { source = connectViaCaptureStream(video); if (!source) { enterBypass(video, 'all fail'); return false; } } }
      try { source.disconnect(); } catch (_) {}
      const wantProcessed = isAnyAudioActive();
      if (wantProcessed) { source.connect(splitter); } else { source.connect(fullDryPath); }
      currentSrc = source; currentMode = source.__vsc_isCaptureStream ? 'stream' : 'mes'; currentRouteIsProcessed = wantProcessed;
      exitBypass(); return true;
    }

    function fadeOutThen(gen, fn, cleanupFn) {
      if (!ctx || !masterOut || ctx.state === 'closed') { if (gen === generation) try { fn(); } catch (_) {} else if (cleanupFn) try { cleanupFn(); } catch (_) {} return; }
      try { const t = ctx.currentTime; masterOut.gain.cancelScheduledValues(t); masterOut.gain.setValueAtTime(masterOut.gain.value, t); masterOut.gain.linearRampToValueAtTime(0, t + 0.04); } catch (_) { try { masterOut.gain.value = 0; } catch (__) {} }
      setTimeout(() => {
        if (gen !== generation) { if (cleanupFn) try { cleanupFn(); } catch (_) {} return; }
        try { fn(); } catch (_) {}
        if (ctx && masterOut && ctx.state !== 'closed') { try { const t2 = ctx.currentTime; masterOut.gain.cancelScheduledValues(t2); masterOut.gain.setValueAtTime(masterOut.gain.value, t2); masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04); } catch (_) { try { masterOut.gain.value = 1; } catch (__) {} } }
      }, 60);
    }

    function disconnectCurrent(vid) {
      if (!currentSrc) return;
      const target = vid || targetVideo;
      if (currentSrc.__vsc_isCaptureStream && target) {
        if (currentSrc.__vsc_originalVolume != null) try { target.volume = currentSrc.__vsc_originalVolume; } catch (_) {}
        if (target.muted && currentSrc.__vsc_originalMuted === false) try { target.muted = false; } catch (_) {}
        const stream = currentSrc.__vsc_captureStream; if (stream) stream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        streamMap.delete(target);
      }
      try { currentSrc.disconnect(); } catch (_) {}
      if (!currentSrc.__vsc_isCaptureStream && ctx && ctx.state !== 'closed') { try { currentSrc.connect(ctx.destination); } catch (_) {} }
      currentSrc = null; currentMode = 'none'; currentRouteIsProcessed = false;
    }

    function restoreOrphanedStream(video) {
      if (!video) return; const s = streamMap.get(video); if (!s || !s.__vsc_isCaptureStream) return;
      if (s.__vsc_originalVolume != null) try { video.volume = s.__vsc_originalVolume; } catch (_) {}
      if (video.muted && s.__vsc_originalMuted === false) try { video.muted = false; } catch (_) {}
      if (s.__vsc_captureStream) s.__vsc_captureStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} });
      try { s.disconnect(); } catch (_) {} streamMap.delete(video);
    }

    function updateMix() {
      if (!ctx || bypassMode) return; routeCompressor();
      if (currentSrc) { const wantProcessed = isAnyAudioActive(); if (wantProcessed === currentRouteIsProcessed) return; try { currentSrc.disconnect(); } catch (_) {} if (wantProcessed) { currentSrc.connect(splitter); } else { currentSrc.connect(fullDryPath); } currentRouteIsProcessed = wantProcessed; }
      else if (targetVideo?.isConnected && isAnyAudioActive() && canConnect(targetVideo)) { connectSource(targetVideo); }
    }

    function setTarget(video) {
      if (video === targetVideo) { if (bypassMode) { if (!canConnect(video)) return; exitBypass(); if (connectSource(video)) { updateMix(); return; } return; } if (currentSrc) { updateMix(); return; } if (canConnect(video)) { if (!initCtx()) return; if (connectSource(video)) updateMix(); } return; }
      const gen = ++generation; const active = isAnyAudioActive();
      if (!active) { const oldTarget = targetVideo; if (currentSrc || targetVideo) { fadeOutThen(gen, () => { disconnectCurrent(oldTarget); targetVideo = video; if (bypassMode) { bypassMode = false; currentMode = 'none'; currentRouteIsProcessed = false; } }, () => restoreOrphanedStream(oldTarget)); } else { targetVideo = video; if (bypassMode) { bypassMode = false; currentMode = 'none'; currentRouteIsProcessed = false; } } return; }
      if (!initCtx()) { targetVideo = video; return; }
      if (video && !canConnect(video)) { const oldTarget = targetVideo; fadeOutThen(gen, () => { disconnectCurrent(oldTarget); targetVideo = video; if (!bypassMode) { bypassMode = true; currentMode = 'bypass'; currentRouteIsProcessed = false; } }, () => restoreOrphanedStream(oldTarget)); return; }
      const oldTarget = targetVideo;
      fadeOutThen(gen, () => { disconnectCurrent(oldTarget); if (bypassMode) { bypassMode = false; currentMode = 'none'; currentRouteIsProcessed = false; } targetVideo = video; if (!video) { updateMix(); return; } connectSource(video); updateMix(); }, () => restoreOrphanedStream(oldTarget));
    }

    function onVideoLoadstart(video) {
      jwCache.delete(video); const s = streamMap.get(video);
      if (s) { if (s.__vsc_captureStream) s.__vsc_captureStream.getAudioTracks().forEach(t => { try { t.stop(); } catch (_) {} }); try { s.disconnect(); } catch (_) {} streamMap.delete(video); if (currentSrc === s) { currentSrc = null; currentMode = 'none'; currentRouteIsProcessed = false; } }
    }

    let gestureHooked = false;
    const onGesture = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); if (ctx?.state === 'running' && gestureHooked) { for (const evt of ['pointerdown','keydown','click']) window.removeEventListener(evt, onGesture, true); gestureHooked = false; } };
    function ensureGestureHook() { if (gestureHooked) return; gestureHooked = true; for (const evt of ['pointerdown','keydown','click']) window.addEventListener(evt, onGesture, { passive: true, capture: true }); }
    ensureGestureHook();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && ctx?.state === 'suspended') { ctx.resume().then(() => { if (ctx.state === 'running') return; setTimeout(() => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); }, 120); }).catch(() => {}); }
    }, { passive: true });

    return { setTarget, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!(currentSrc || bypassMode), isBypassed: () => bypassMode, applyStrength, applySurroundWidth, applyClarity, applyBoost, routeCompressor, onVideoLoadstart };
  }

  function createFilters() {
    const ctxMap = new WeakMap();
    const toneCache = new Map();
    const appliedFilter = new WeakMap();
    const TONE_CACHE_MAX = 32;

    function getToneTable(steps, gain, contrast, gamma, toe, mid, shoulder) {
      const key = `${steps}|${Math.round(gain*100)}|${Math.round(contrast*100)}|${Math.round(gamma*100)}|t${Math.round(toe*1000)}|m${Math.round(mid*1000)}|s${Math.round(shoulder*1000)}`;
      if (toneCache.has(key)) return toneCache.get(key);
      const ev = Math.log2(Math.max(1e-6, gain)); const g = ev * 0.90; const useFilmicCurve = Math.abs(g) > 0.01; const denom = useFilmicCurve ? (1 - Math.exp(-g)) : 1;
      const out = new Array(steps); let prev = 0;
      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1); let x = useFilmicCurve ? (1 - Math.exp(-g * x0)) / denom : x0;
        const shadowGuard = x0 < 0.20 ? x0 / 0.20 : 1.0; const localContrast = 1 + (contrast - 1) * shadowGuard;
        const pivot = 0.45; const intercept = pivot * (1 - localContrast);
        x = x * localContrast + intercept; x = CLAMP(x, 0, 1);
        if (toe > 0.001 && x0 < 0.40) { const t = x0 / 0.40; x = x + toe * (1 - t) * (t * t) * (1 - x); }
        if (mid > 0.001) { const mc = 0.45, sig = 0.18; const mw = Math.exp(-((x0 - mc) ** 2) / (2 * sig * sig)); const delta = (x0 - mc) * mid * mw * 1.5; const appliedDelta = delta > 0 ? delta : delta * 0.15; x = CLAMP(x + appliedDelta, 0, 1); }
        if (shoulder > 0.001) { const hw = x0 > 0.4 ? (x0 - 0.4) / 0.6 : 0; x = CLAMP(x + shoulder * 0.6 * x0 + shoulder * hw * hw * 0.5 * (1 - x), 0, 1); }
        if (Math.abs(gamma - 1) > 0.001) x = Math.pow(x, gamma);
        if (x < prev) x = prev; prev = x; out[i] = (x).toFixed(4);
      }
      const res = out.join(' ');
      if (toneCache.size >= TONE_CACHE_MAX) { const first = toneCache.keys().next(); if (!first.done) toneCache.delete(first.value); }
      toneCache.set(key, res); return res;
    }

    function mkXfer(attrs, funcDefaults, withAlpha = true) {
      const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs }); const refs = {};
      const channels = ['R', 'G', 'B']; if (withAlpha) channels.push('A');
      for (const ch of channels) { const fa = { ns: 'svg' }; if (ch === 'A') fa.type = 'identity'; else { for (const [k, v] of Object.entries(funcDefaults)) fa[k] = v; } refs[ch] = h(`feFunc${ch}`, fa); xfer.append(refs[ch]); }
      return { el: xfer, refs };
    }

    function buildSvg(root) {
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
      const defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const fid = `vsc-f-${VSC_ID}`;
      const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });

      const feTurb = h('feTurbulence', { ns: 'svg', type: 'fractalNoise', baseFrequency: '0.75', numOctaves: '1', seed: String(Math.trunc(Math.random() * 1000)), result: 'rawNoise' });
      const feGrayNoise = h('feColorMatrix', { ns: 'svg', type: 'saturate', values: '0', in: 'rawNoise', result: 'monoNoise' });
      const feAddNoise = h('feComposite', { ns: 'svg', operator: 'arithmetic', k1: '0', k2: '1', k3: '0.008', k4: '-0.004', in: 'SourceGraphic', in2: 'monoNoise', result: 'dithered' });

      const toneResult = mkXfer({ in: 'dithered', result: 'tone' }, { type: 'table', tableValues: '0 1' });
      const tempResult = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
      const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'tmp', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
      const fSat = h('feColorMatrix', { ns: 'svg', in: 'conv', type: 'saturate', values: '1.0', result: 'final' });

      filter.append(feTurb, feGrayNoise, feAddNoise, toneResult.el, tempResult.el, fConv, fSat);
      defs.append(filter);

      const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
      if (target?.appendChild) target.appendChild(svg);
      return {
        fid, svg, fConv,
        toneFuncsRGB: [toneResult.refs.R, toneResult.refs.G, toneResult.refs.B].filter(Boolean),
        tempFuncR: tempResult.refs.R, tempFuncG: tempResult.refs.G, tempFuncB: tempResult.refs.B,
        fSat,
        st: { toneKey: '', sharpKey: '', tempKey: '', satKey: '', satInputKey: '', _h1: -1, _h2: -1, _h3: -1, _h4: -1, _h5: -1, _h6: -1, _h7: -1, _h8: -1, _h9: -1, _h10: -1, _h11: -1 }
      };
    }

    function purge(root) {
      const ctx = ctxMap.get(root);
      if (ctx) { try { ctx.svg.remove(); } catch (_) {} ctxMap.delete(root); try { const videos = root.querySelectorAll?.('video') || []; for (const v of videos) appliedFilter.delete(v); } catch (_) {} }
    }

    function prepare(video, s) {
      const rn = video?.getRootNode?.();
      const root = (rn instanceof ShadowRoot) ? rn : (video?.ownerDocument || document);

      const preGainSlope = s._preGain || 1;
      const preGainCss = (Math.abs(preGainSlope - 1) > 0.001) ? `brightness(${preGainSlope.toFixed(3)})` : '';

      if (!s._needsSvg) {
        if (video && ctxMap.has(root)) purge(root);
        const parts = [];
        if (preGainCss) parts.push(preGainCss);
        if (Math.abs(s._cssBr - 1) > 0.001) parts.push(`brightness(${s._cssBr.toFixed(4)})`);
        if (Math.abs(s._cssCt - 1) > 0.001) parts.push(`contrast(${s._cssCt.toFixed(4)})`);
        if (Math.abs(s._cssSat - 1) > 0.001) parts.push(`saturate(${s._cssSat.toFixed(4)})`);
        return parts.length > 0 ? parts.join(' ') : 'none';
      }
      let ctx = ctxMap.get(root);
      if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
      else if (!ctx.svg.isConnected) { const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root); if (target?.appendChild) target.appendChild(ctx.svg); }
      const st = ctx.st;

      const h1 = Math.round((s.sharp || 0) * 1000);
      const h2 = Math.round((s._diagRatio || 0.707) * 1000);
      const h3 = Math.round((s.toe || 0) * 1000);
      const h4 = Math.round((s.mid || 0) * 1000);
      const h5 = Math.round((s.shoulder || 0) * 1000);
      const h6 = Math.round((s.gain || 1) * 1000);
      const h7 = Math.round((s.gamma || 1) * 1000);
      const h8 = Math.round((s.contrast || 1) * 1000);
      const h9 = s.temp | 0;
      const h10 = s.tint | 0;
      const h11 = Math.round((s._cssSat || 1) * 1000);

      if (st._h1 === h1 && st._h2 === h2 && st._h3 === h3 && st._h4 === h4 &&
          st._h5 === h5 && st._h6 === h6 && st._h7 === h7 && st._h8 === h8 &&
          st._h9 === h9 && st._h10 === h10 && st._h11 === h11) {
        return preGainCss ? `${preGainCss} url(#${ctx.fid})` : `url(#${ctx.fid})`;
      }
      st._h1 = h1; st._h2 = h2; st._h3 = h3; st._h4 = h4; st._h5 = h5;
      st._h6 = h6; st._h7 = h7; st._h8 = h8; st._h9 = h9; st._h10 = h10; st._h11 = h11;

      if (video) appliedFilter.delete(video);

      const toneTable = getToneTable(256, s.gain || 1, s.contrast || 1, 1 / CLAMP(s.gamma || 1, 0.1, 5), s.toe || 0, s.mid || 0, s.shoulder || 0);
      if (st.toneKey !== toneTable) { st.toneKey = toneTable; for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable); }

      const tempTintKey = `${s.temp}|${s.tint}`;
      if (st.tempKey !== tempTintKey) { st.tempKey = tempTintKey; const colorGain = tempTintToRgbGain(s.temp, s.tint); ctx.tempFuncR.setAttribute('slope', colorGain.rs); ctx.tempFuncG.setAttribute('slope', colorGain.gs); ctx.tempFuncB.setAttribute('slope', colorGain.bs); }

      const sharpCap = s._sharpCap || SHARP_CAP_DEFAULT; const diagRatio = s._diagRatio || 0.707;
      const totalS = CLAMP(Number(s.sharp || 0), 0, sharpCap);
      let kernelStr = '0,0,0, 0,1,0, 0,0,0';
      if (totalS >= 0.005) { const edge = -totalS; const diag = edge * diagRatio; const center = 1 - 4 * edge - 4 * diag; kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`; }
      if (st.sharpKey !== kernelStr) { st.sharpKey = kernelStr; ctx.fConv.setAttribute('kernelMatrix', kernelStr); }

      const satInput = totalS >= 0.005 ? 'conv' : 'tmp';
      if (st.satInputKey !== satInput) { st.satInputKey = satInput; ctx.fSat.setAttribute('in', satInput); }

      const desatMul = totalS > 0.008 ? CLAMP(1 - totalS * 0.1, 0.90, 1) : 1;
      const satVal = CLAMP(s._cssSat * desatMul, 0.4, 1.8).toFixed(3);
      if (st.satKey !== satVal) { st.satKey = satVal; ctx.fSat.setAttribute('values', satVal); }

      return preGainCss ? `${preGainCss} url(#${ctx.fid})` : `url(#${ctx.fid})`;
    }

    return {
      prepare,
      apply: (el, filterStr) => { if (!el) return; if (filterStr === 'none') { if (appliedFilter.get(el) === 'none') return; clearFilterStyles(el); appliedFilter.set(el, 'none'); return; } if (appliedFilter.get(el) === filterStr) return; applyFilterStyles(el, filterStr); appliedFilter.set(el, filterStr); },
      clear: (el) => { if (appliedFilter.get(el) === 'none') return; clearFilterStyles(el); appliedFilter.set(el, 'none'); },
      purge
    };
  }

  // ⭐ 수정 부분 1: createVideoParams에서 배수 조정
  function createVideoParams(Store) {
    const cache = new WeakMap();
    function computeSharpMul(video) {
      const nW = video.videoWidth | 0; let dW = video.clientWidth, dH = video.clientHeight;
      if (!dW || !dH) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12, sharpProfile: getSharpProfile(nW) };
      const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);
      if (dW < 16) return { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12, sharpProfile: getSharpProfile(nW) };
      const nH = video.videoHeight | 0; const ratioW = (dW * dpr) / nW; const ratioH = (nH > 16 && dH > 16) ? (dH * dpr) / nH : ratioW; const ratio = Math.min(ratioW, ratioH);
      let mul = ratio <= 0.30 ? 0.40 : ratio <= 0.60 ? 0.40 + (ratio - 0.30) / 0.30 * 0.30 : ratio <= 1.00 ? 0.70 + (ratio - 0.60) / 0.40 * 0.30 : ratio <= 1.80 ? 1.00 : ratio <= 4.00 ? 1.00 - (ratio - 1.80) / 2.20 * 0.30 : 0.65;
      const sharpProfile = getSharpProfile(nW); const rawAutoBase = sharpProfile.autoBase;
      if (IS_MOBILE) mul = Math.max(mul, 0.60);
      return { mul: CLAMP(mul, 0, 1), autoBase: CLAMP(rawAutoBase * mul, 0, sharpProfile.cap), rawAutoBase, sharpProfile };
    }
    return {
      get: (video) => {
        const storeRev = Store.rev();
        const nW = video ? (video.videoWidth | 0) : 0;
        const dW = video ? (video.clientWidth || 0) : 0;
        const dH = video ? (video.clientHeight || 0) : 0;
        const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 4);
        if (video && nW >= 16) { const cached = cache.get(video); if (cached && cached.rev === storeRev && cached.nW === nW && cached.dW === dW && cached.dH === dH && cached.dpr === dpr) return cached.out; }
        const out = { gain: 1, gamma: 1, contrast: 1, toe: 0, mid: 0, shoulder: 0, temp: 0, tint: 0, sharp: 0, _cssBr: 1, _cssCt: 1, _cssSat: 1, _needsSvg: false, _sharpCap: SHARP_CAP_DEFAULT, _diagRatio: 0.707, _preGain: 1 };
        const presetS = Store.get(P.V_PRE_S);
        const mix = CLAMP(Number(Store.get(P.V_PRE_MIX)) || 1, 0, 1);
        const { mul, autoBase, rawAutoBase, sharpProfile } = video ? computeSharpMul(video) : { mul: 0.5, autoBase: 0.10, rawAutoBase: 0.12, sharpProfile: getSharpProfile(0) };
        const platformScale = IS_MOBILE ? 0.7 : 1.0;
        const finalMul = ((mul === 0 && presetS !== 'off') ? 0.50 : mul) * platformScale;
        out._sharpCap = sharpProfile.cap; out._diagRatio = sharpProfile.diagRatio;

        if (presetS === 'off') { out.sharp = autoBase * 0.45 * platformScale; }
        else if (presetS !== 'none') { const resFactor = CLAMP(rawAutoBase / 0.12, 0.58, 1.25); out.sharp = (_PRESET_SHARP_LUT[presetS] || 0) * mix * finalMul * resFactor; }
        out.sharp = CLAMP(out.sharp, 0, sharpProfile.cap);

        const mShad = CLAMP(Number(Store.get(P.V_MAN_SHAD) ?? 0), 0, 100);
        const mRec = CLAMP(Number(Store.get(P.V_MAN_REC) ?? 0), 0, 100);
        const mBrt = CLAMP(Number(Store.get(P.V_MAN_BRT) ?? 0), 0, 100);
        const mTemp = CLAMP(Number(Store.get(P.V_MAN_TEMP) ?? 0), -50, 50);
        const mTint = CLAMP(Number(Store.get(P.V_MAN_TINT) ?? 0), -50, 50);
        const mSat = CLAMP(Number(Store.get(P.V_MAN_SAT) ?? 0), -50, 50);
        const mGamma = CLAMP(Number(Store.get(P.V_MAN_GAMMA) ?? 0), -30, 30);
        const mCon = CLAMP(Number(Store.get(P.V_MAN_CON) ?? 0), -30, 30);
        const mGain = CLAMP(Number(Store.get(P.V_MAN_GAIN) ?? 0), -30, 30);
        const mPreGain = CLAMP(Number(Store.get(P.V_MAN_PREGAIN) ?? 100), 10, 200);

        // ▼ 권장 (원래의 약 2/3 수준 — 체감 가능하면서 과하지 않은 선)
        out.toe      = mShad * 0.0027;          // 0~100 → 0~0.27
        out.mid      = mRec  * 0.0024;          // 0~100 → 0~0.24
        out.shoulder = mBrt  * 0.0030;          // 0~100 → 0~0.30
        out.gamma    = 1 + mGamma * (-0.0055);  // ±30 → 0.835~1.165
        out.contrast = 1 + mCon   *  0.0055;   // ±30 → 0.835~1.165
        out.gain = Math.pow(2, mGain * 0.03);
        out._preGain = mPreGain / 100;

        out._needsSvg = checkNeedsSvg(out);
        if (out._needsSvg) { out._cssBr = 1.0; out._cssCt = 1.0; }
        else { out._cssBr = 1 + (mBrt * 0.001); out._cssCt = 1 + (mRec * 0.001); }
        out._cssSat = CLAMP(1 + mSat * 0.012, 0.4, 1.8);
        if (video && nW >= 16) cache.set(video, { rev: storeRev, nW, dW, dH, dpr, out });
        return out;
      }
    };
  }

  function createOSD() {
    let el = null, timerId = 0;
    return {
      show: (text, ms = 1200) => {
        if (!document.body) return;
        const root = document.fullscreenElement || document.documentElement || document.body;
        if (!el) { el = document.createElement('div'); el.id = 'vsc-osd'; el.setAttribute('data-vsc-ui', '1'); el.style.cssText = 'position:fixed!important;top:48px!important;left:50%!important;transform:translateX(-50%)!important;background:rgba(12,12,18,0.92)!important;color:rgba(255,255,255,0.95)!important;padding:10px 28px!important;border-radius:14px!important;border:1px solid rgba(0,229,255,0.15)!important;font:600 13px/1.4 system-ui,sans-serif!important;z-index:2147483647!important;pointer-events:none!important;opacity:0!important;transition:opacity 0.2s,transform 0.3s!important;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 20px rgba(0,229,255,0.08)!important;text-align:center!important;'; }
        if (el.parentNode !== root) root.appendChild(el);
        el.textContent = text;
        requestAnimationFrame(() => { el.style.setProperty('opacity', '1', 'important'); });
        clearTimeout(timerId);
        timerId = setTimeout(() => { if (el) el.style.setProperty('opacity', '0', 'important'); }, ms);
      }
    };
  }

  function createUI(Store, Audio, Registry, Scheduler, OSD, Filters) {
    let panelHost = null, panelEl = null, quickBarHost = null;
    let activeTab = 'video', panelOpen = false;
    let _shadow = null, _qbarShadow = null;
    const tabFns = [];
    const tabSignalCleanups = [];
    const globalSignalCleanups = [];

    const TAB_ICONS = {
      video: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, h('rect', { ns: 'svg', x: 2, y: 4, width: 16, height: 16, rx: 2 }), h('path', { ns: 'svg', d: 'M22 7l-6 4 6 4z' })),
      audio: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, h('path', { ns: 'svg', d: 'M11 5L6 9H2v6h4l5 4V5z' }), h('path', { ns: 'svg', d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
      playback: () => h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, h('circle', { ns: 'svg', cx: '12', cy: '12', r: '10' }), h('polygon', { ns: 'svg', points: '10 8 16 12 10 16' }))
    };
    const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생' };

    const CSS_VARS = `
    :host { position: fixed !important; contain: none !important; overflow: visible !important; isolation: isolate; z-index: 2147483647 !important;
      --vsc-glass: rgba(12, 12, 18, 0.72); --vsc-glass-blur: blur(24px) saturate(200%); --vsc-glass-border: rgba(255, 255, 255, 0.06);
      --vsc-neon: #00e5ff; --vsc-neon-glow: 0 0 12px rgba(0, 229, 255, 0.35), 0 0 40px rgba(0, 229, 255, 0.08); --vsc-neon-soft: rgba(0, 229, 255, 0.15); --vsc-neon-border: rgba(0, 229, 255, 0.25); --vsc-neon-dim: rgba(0, 229, 255, 0.08);
      --vsc-purple: #b47aff; --vsc-amber: #ffbe46; --vsc-green: #4cff8e;
      --vsc-text: rgba(255, 255, 255, 0.92); --vsc-text-dim: rgba(255, 255, 255, 0.50); --vsc-text-muted: rgba(255, 255, 255, 0.28);
      --vsc-shadow-panel: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(255, 255, 255, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset; --vsc-shadow-fab: 0 6px 20px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.04);
      --vsc-radius-sm: 6px; --vsc-radius-md: 10px; --vsc-radius-xl: 18px; --vsc-radius-pill: 9999px;
      --vsc-font: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; --vsc-font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      --vsc-font-sm: 11px; --vsc-font-md: 13px;
      --vsc-touch-min: ${IS_MOBILE ? '44px' : '34px'}; --vsc-touch-slider: ${IS_MOBILE ? '20px' : '14px'}; --vsc-panel-width: 380px; --vsc-panel-right: ${IS_MOBILE ? '56px' : '52px'}; --vsc-panel-max-h: 82vh; --vsc-qbar-right: ${IS_MOBILE ? '6px' : '10px'};
      --vsc-ease-out: cubic-bezier(0.16, 1, 0.3, 1); --vsc-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
      font-family: var(--vsc-font) !important; font-size: var(--vsc-font-md) !important; color: var(--vsc-text) !important; -webkit-font-smoothing: antialiased; }`;

    const PANEL_CSS = `${CSS_VARS}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; color: inherit; }
    .panel { pointer-events: none; position: fixed !important; right: calc(var(--vsc-panel-right) + 12px) !important; top: 50% !important; width: var(--vsc-panel-width) !important; max-height: var(--vsc-panel-max-h) !important; background: var(--vsc-glass) !important; border: 1px solid var(--vsc-glass-border) !important; border-radius: var(--vsc-radius-xl) !important; backdrop-filter: var(--vsc-glass-blur) !important; -webkit-backdrop-filter: var(--vsc-glass-blur) !important; box-shadow: var(--vsc-shadow-panel) !important; display: flex !important; flex-direction: column !important; overflow: hidden !important; user-select: none !important; opacity: 0 !important; transform: translate(16px, -50%) scale(0.92) !important; transition: opacity 0.3s var(--vsc-ease-out), transform 0.4s var(--vsc-ease-spring) !important; overscroll-behavior: none !important; }
    .panel.open { opacity: 1 !important; transform: translate(0, -50%) scale(1) !important; pointer-events: auto !important; }
    .panel::before { content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px; background: linear-gradient(90deg, transparent, var(--vsc-neon), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
    .hdr { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.04); gap: 10px; }
    .hdr .tl { font-weight: 800; font-size: 16px; letter-spacing: 1.5px; text-transform: uppercase; background: linear-gradient(135deg, var(--vsc-neon), var(--vsc-purple)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .tabs { display: flex; border-bottom: 1px solid rgba(255,255,255,0.04); position: relative; padding: 0 4px; }
    .tabs::after { content: ''; position: absolute; bottom: 0; height: 2px; background: var(--vsc-neon); box-shadow: var(--vsc-neon-glow); border-radius: 1px; transition: left 0.3s var(--vsc-ease-out), width 0.3s var(--vsc-ease-out); left: var(--tab-indicator-left, 0); width: var(--tab-indicator-width, 25%); }
    .tab { flex: 1; padding: 10px 0; text-align: center; font-size: var(--vsc-font-sm); font-weight: 600; letter-spacing: 0.6px; cursor: pointer; opacity: 0.35; transition: opacity 0.2s, color 0.2s; display: flex; align-items: center; justify-content: center; gap: 4px; text-transform: uppercase; }
    .tab svg { opacity: 0.6; flex-shrink: 0; width: 14px; height: 14px; stroke: currentColor; }
    .tab:hover { opacity: 0.65; } .tab.on { opacity: 1; color: var(--vsc-neon); }
    .tab.on svg { opacity: 1; filter: drop-shadow(0 0 4px rgba(0,229,255,0.4)); stroke: var(--vsc-neon); }
    .body { overflow-y: auto; overflow-x: hidden; flex: 1; padding: 12px 16px 18px; scrollbar-width: thin; scrollbar-color: rgba(0,229,255,0.15) transparent; text-align: left; overscroll-behavior: none; -webkit-overflow-scrolling: touch; }
    .body::-webkit-scrollbar { width: 4px; } .body::-webkit-scrollbar-thumb { background: rgba(0,229,255,0.2); border-radius: 2px; }
    .row { display: flex; align-items: center; justify-content: space-between; padding: 5px 0; min-height: var(--vsc-touch-min); }
    .row label { font-size: 12px; opacity: 0.75; flex: 0 0 auto; max-width: 48%; font-weight: 500; }
    .row .ctrl { display: flex; align-items: center; gap: 6px; flex: 1; justify-content: flex-end; }
    input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; max-width: 140px; height: 4px; border-radius: 2px; outline: none; cursor: pointer; background: transparent; margin: 0; }
    input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--vsc-neon) 0%, var(--vsc-neon) var(--fill, 50%), rgba(255,255,255,0.08) var(--fill, 50%)); }
    input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: var(--vsc-touch-slider); height: var(--vsc-touch-slider); border-radius: 50%; background: var(--vsc-neon); cursor: pointer; border: 2px solid rgba(0,0,0,0.3); box-shadow: 0 0 8px rgba(0,229,255,0.4); margin-top: calc((4px - var(--vsc-touch-slider)) / 2); }
    .val { font-family: var(--vsc-font-mono); font-size: var(--vsc-font-sm); min-width: 38px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.85; color: var(--vsc-neon); }
    .tgl { position: relative; width: 46px; height: 24px; border-radius: var(--vsc-radius-pill); background: rgba(255,255,255,0.08); cursor: pointer; transition: background 0.3s, box-shadow 0.3s; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.06); }
    .tgl.on { background: var(--vsc-neon-soft); border-color: var(--vsc-neon-border); box-shadow: 0 0 12px rgba(0,229,255,0.2); }
    .tgl::after { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: rgba(255,255,255,0.6); transition: transform 0.3s var(--vsc-ease-spring), background 0.3s, box-shadow 0.3s; }
    .tgl.on::after { transform: translateX(22px); background: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.6); }
    .btn { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: var(--vsc-radius-md); color: var(--vsc-text); padding: 4px 10px; font-size: 11px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); min-height: var(--vsc-touch-min); min-width: 44px; display: inline-flex; align-items: center; justify-content: center; font-weight: 500; }
    .btn:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.12); }
    .chips { padding: 4px 0; display: flex; gap: 5px; justify-content: space-between; }
    .chip { display: inline-flex; align-items: center; justify-content: center; padding: 5px 6px; min-height: var(--vsc-touch-min); min-width: 38px; flex: 1; font-size: 11px; font-weight: 500; border-radius: var(--vsc-radius-sm); cursor: pointer; background: rgba(255,255,255,0.03); border: 1px solid var(--vsc-glass-border); transition: all 0.2s var(--vsc-ease-out); text-align: center; }
    .chip:hover { background: rgba(255,255,255,0.07); }
    .chip.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 8px rgba(0,229,255,0.1); }
    .sep { height: 1px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent); margin: 8px 0; }
    .rate-display { font-family: var(--vsc-font-mono); font-size: 32px; font-weight: 800; text-align: center; padding: 8px 0; background: linear-gradient(135deg, #fff, var(--vsc-neon)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; filter: drop-shadow(0 0 12px rgba(0,229,255,0.2)); }
    .fine-row { display: flex; gap: 4px; justify-content: center; padding: 4px 0; }
    .fine-btn { padding: 2px 4px; min-height: 24px; min-width: 32px; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); }
    .fine-btn:hover { background: rgba(255,255,255,0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
    .fine-btn.active { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); }
    .info-bar { font-family: var(--vsc-font-mono); font-size: 12px; opacity: 0.8; padding: 4px 0 6px; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; color: var(--vsc-neon); text-align: left; }
    .section-label { font-size: 11px; opacity: 0.5; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; padding: 6px 0 2px; }
    .preset-grid { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 0; }
    .preset-grid .fine-btn { flex: 0 0 calc(20% - 3.2px); min-width: 0; text-align: center; justify-content: center; display: inline-flex; align-items: center; padding: 4px 2px; font-size: 10px; }
    .hint { font-size: 10px; opacity: 0.5; padding: 4px 0; text-align: left; line-height: 1.5; }
    .hint.warn { opacity: 0.7; color: var(--vsc-amber); }
    .pg-row { display: flex; gap: 3px; padding: 4px 0; flex-wrap: wrap; justify-content: center; }
    .pg-btn { padding: 4px 0; min-height: 28px; min-width: 0; flex: 1; border-radius: var(--vsc-radius-sm); border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.6); font-family: var(--vsc-font-mono); font-size: 10px; cursor: pointer; transition: all 0.15s var(--vsc-ease-out); text-align: center; }
    .pg-btn:hover { background: rgba(255,255,255,0.08); color: var(--vsc-neon); border-color: var(--vsc-neon-border); }
    .pg-btn.on { background: var(--vsc-neon-dim); border-color: var(--vsc-neon-border); color: var(--vsc-neon); box-shadow: 0 0 6px rgba(0,229,255,0.15); }
    .pg-btn.default { border-color: rgba(255,255,255,0.12); color: rgba(255,255,255,0.8); }
    @media (max-width: 600px) { :host { --vsc-panel-width: calc(100vw - 80px); --vsc-panel-right: 60px; } }
    @media (max-width: 400px) { :host { --vsc-panel-width: calc(100vw - 64px); --vsc-panel-right: 52px; } }`;

    function getMountTarget() {
      const fs = document.fullscreenElement || document.webkitFullscreenElement;
      if (fs) { if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement; if (fs.shadowRoot) return document.documentElement; return fs; }
      return document.documentElement || document.body;
    }
    const HOST_STYLE_BASE = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;z-index:2147483647!important;pointer-events:none!important;contain:none!important;overflow:visible!important;';
    const HOST_STYLE_NORMAL = HOST_STYLE_BASE + 'width:0!important;height:0!important;';
    const HOST_STYLE_FS = HOST_STYLE_BASE + 'right:0!important;bottom:0!important;width:100%!important;height:100%!important;';
    let _lastMount = null, _qbarHasVideo = false, _lastIsFs = null;

    function reparent() {
      if (!quickBarHost) return; const target = getMountTarget(); if (!target) return;
      const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (target !== _lastMount) { _lastMount = target; if (quickBarHost.parentNode !== target) try { target.appendChild(quickBarHost); } catch (_) {} if (panelHost && panelHost.parentNode !== target) try { target.appendChild(panelHost); } catch (_) {} }
      if (_lastIsFs !== isFs) { _lastIsFs = isFs; const style = isFs ? HOST_STYLE_FS : HOST_STYLE_NORMAL; quickBarHost.style.cssText = style; if (panelHost) panelHost.style.cssText = style; if (!_qbarHasVideo) quickBarHost.style.setProperty('display', 'none', 'important'); }
      if (panelHost && panelOpen && panelEl) panelEl.style.pointerEvents = 'auto';
    }
    function onFullscreenChange() { reparent(); Scheduler.request(); setTimeout(reparent, 80); setTimeout(reparent, 400); if (!document.fullscreenElement && !document.webkitFullscreenElement) { _lastMount = null; _lastIsFs = null; } }
    function updateQuickBarVisibility() {
      if (!quickBarHost) return;
      let has = Registry.videos.size > 0;
      if (!has) try { has = !!document.querySelector('video'); } catch (_) {}
      if (!has && Registry.shadowRootsLRU) { for (const it of Registry.shadowRootsLRU) { if (it.host?.isConnected && it.root) { try { if (it.root.querySelector('video')) { has = true; break; } } catch (_) {} } } }
      if (has && !_qbarHasVideo) { _qbarHasVideo = true; quickBarHost.style.removeProperty('display'); }
      else if (!has && _qbarHasVideo) { _qbarHasVideo = false; quickBarHost.style.setProperty('display', 'none', 'important'); if (panelOpen) togglePanel(false); }
    }
    function updateTabIndicator(tabBar, tabName) { if (!tabBar) return; const tabs = tabBar.querySelectorAll('.tab'); const idx = ['video','audio','playback'].indexOf(tabName); if (idx < 0) return; const tabEl = tabs[idx]; if (!tabEl) return; requestAnimationFrame(() => { const barRect = tabBar.getBoundingClientRect(); const tabRect = tabEl.getBoundingClientRect(); tabBar.style.setProperty('--tab-indicator-left', `${tabRect.left - barRect.left}px`); tabBar.style.setProperty('--tab-indicator-width', `${tabRect.width}px`); tabs.forEach(t => t.classList.toggle('on', t.dataset.t === tabName)); }); }

    function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
    function mkSep() { return h('div', { class: 'sep' }); }

    function mkSlider(path, min, max, step, onChange) {
      const s = step || ((max - min) / 100); const digits = s >= 1 ? 0 : 2;
      const inp = h('input', { type: 'range', min, max, step: s }); const valEl = h('span', { class: 'val' });
      let lastRendered;
      function updateUI(v) { inp.value = String(v); valEl.textContent = Number(v).toFixed(digits); inp.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`); }
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); lastRendered = v; Store.set(path, v); updateUI(v); if (onChange) onChange(v); });
      const sync = () => { const raw = Number(Store.get(path) ?? min); const v = Number.isNaN(raw) ? min : raw; if (v === lastRendered) return; lastRendered = v; updateUI(v); };
      tabFns.push(sync); sync(); return [inp, valEl];
    }

    function mkToggle(path, onChange) {
      const el = h('div', { class: 'tgl', tabindex: '0', role: 'switch', 'aria-checked': 'false' });
      function sync() { const on = !!Store.get(path); el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); }
      el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); });
      tabFns.push(sync); sync(); return el;
    }

    // ⭐ 수정 부분 2: mkSliderWithFine에서 step: 0.5로 변경
    function mkSliderWithFine(label, path, min, max, step, fineStep) {
      const [slider, valEl] = mkSlider(path, min, max, step);
      const mkFine = (d, t) => { const b = h('button', { class: 'fine-btn', style: 'font-size:11px' }, t); b.addEventListener('click', () => { Store.set(path, CLAMP(Math.round((Number(Store.get(path) || 0) + d) * 100) / 100, min, max)); }); return b; };
      const resetBtn = h('button', { class: 'fine-btn', style: 'min-width:24px;font-size:10px;opacity:.6' }, '0');
      resetBtn.addEventListener('click', () => { Store.set(path, 0); });
      return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn)));
    }

    function mkChipRow(label, path, chips, onSelectOverride) {
      const wrap = h('div', {}); if (label) wrap.append(h('label', { style: 'font-size:11px;opacity:.6;display:block;margin-bottom:3px' }, label));
      const row = h('div', { class: 'chips' });
      for (const ch of chips) row.appendChild(h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l));
      row.addEventListener('click', e => { const chip = e.target.closest('.chip'); if (!chip) return; const val = chip.dataset.v; const parsed = isNaN(Number(val)) ? val : Number(val); if (onSelectOverride) { onSelectOverride(parsed); } else { Store.set(path, parsed); } for (const c of row.children) c.classList.toggle('on', c.dataset.v === val); });
      const sync = () => { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); };
      wrap.appendChild(row); tabFns.push(sync); sync(); return wrap;
    }

    function mkFineButtons(path, steps, min, max) {
      const row = h('div', { class: 'fine-row' });
      for (const d of steps) { const btn = h('button', { class: 'fine-btn' }, `${d > 0 ? '+' : ''}${d}`); btn.addEventListener('click', () => { Store.batch('playback', { rate: CLAMP((Number(Store.get(path)) || 1) + d, min, max), enabled: true }); }); row.appendChild(btn); }
      return row;
    }

    function buildPreGainButtons() {
      const wrap = h('div', {});
      const headerRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0 2px' });
      const label = h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '프리 게인');
      headerRow.append(label);
      wrap.append(headerRow);

      const ctrlRow = h('div', { style: 'display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 0' });

      const btnDown = h('button', { class: 'fine-btn', style: 'font-size:14px;min-width:36px;min-height:36px' }, '◀');
      const valDisplay = h('span', { style: 'font-family:var(--vsc-font-mono);font-size:18px;font-weight:700;color:var(--vsc-neon);min-width:52px;text-align:center' }, '100%');
      const btnUp = h('button', { class: 'fine-btn', style: 'font-size:14px;min-width:36px;min-height:36px' }, '▶');
      const resetBtn = h('button', { class: 'fine-btn', style: 'font-size:10px;min-width:36px;opacity:.6' }, '100');

      const STEP = 1;
      const MIN = 1;
      const MAX = 200;

      btnDown.addEventListener('click', () => {
        const cur = Number(Store.get(P.V_MAN_PREGAIN) ?? 100);
        Store.set(P.V_MAN_PREGAIN, CLAMP(cur - STEP, MIN, MAX));
      });
      btnUp.addEventListener('click', () => {
        const cur = Number(Store.get(P.V_MAN_PREGAIN) ?? 100);
        Store.set(P.V_MAN_PREGAIN, CLAMP(cur + STEP, MIN, MAX));
      });
      resetBtn.addEventListener('click', () => {
        Store.set(P.V_MAN_PREGAIN, 100);
      });

      ctrlRow.append(btnDown, valDisplay, btnUp, resetBtn);

      const sync = () => {
        const cur = Number(Store.get(P.V_MAN_PREGAIN) ?? 100);
        valDisplay.textContent = `${cur}%`;
        valDisplay.style.color = cur < 100 ? 'var(--vsc-amber)' : cur > 100 ? 'var(--vsc-green)' : 'var(--vsc-neon)';
      };
      tabFns.push(sync);

      wrap.append(ctrlRow);
      wrap.append(h('div', { class: 'hint' }, '◀ 내리기: 밝은 영상 보정 체감↑ │ ▶ 올리기: 어두운 영상 │ 1% 단위'));
      return wrap;
    }

    function buildInfoBar() {
      const el = h('div', { class: 'info-bar' });
      const update = () => { const v = __internal._activeVideo; const p = Store.get(P.V_PRE_S); const lbl = p === 'none' ? 'OFF' : p === 'off' ? 'AUTO' : PRESETS.detail[p]?.label || p; if (!v?.isConnected) { el.textContent = `영상 없음 │ 샤프닝: ${lbl}`; return; } const nW = v.videoWidth || 0, nH = v.videoHeight || 0, dW = v.clientWidth || 0, dH = v.clientHeight || 0; const resTag = nW > 2560 ? ' [4K+]' : nW > 1920 ? ' [QHD]' : ''; const pg = Number(Store.get(P.V_MAN_PREGAIN) ?? 100); const pgTag = pg !== 100 ? ` │ PG:${pg}%` : ''; el.textContent = nW ? `원본 ${nW}×${nH}${resTag} → 출력 ${dW}×${dH} │ 샤프닝: ${lbl}${pgTag}` : `로딩 대기중... │ 샤프닝: ${lbl}`; };
      tabFns.push(update);
      return el;
    }

    function buildPresetGrid() {
      const wrap = h('div', {});
      const headerRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0 2px' });
      const label = h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '톤 보정');
      const offBtn = h('button', { class: 'fine-btn', style: 'font-size:10px;min-width:36px' }, 'OFF');
      offBtn.addEventListener('click', () => {
        const obj = {};
        for (let i = 0; i < MANUAL_KEYS.length; i++) obj[MANUAL_KEYS[i]] = 0;
        Store.batch('video', obj);
      });
      headerRow.append(label, offBtn);
      wrap.append(headerRow);

      const grid = h('div', { class: 'preset-grid' });
      const presets = MANUAL_PRESETS.filter(p => p.n !== 'OFF');
      const buttons = presets.map(p => {
        const btn = h('button', { class: 'fine-btn' }, p.n);
        btn.addEventListener('click', () => {
          const obj = {};
          for (let i = 0; i < MANUAL_KEYS.length; i++) obj[MANUAL_KEYS[i]] = p.v[i];
          Store.batch('video', obj);
        });
        grid.appendChild(btn);
        return { btn, values: p.v };
      });

      const offValues = MANUAL_PRESETS[0].v;
      const syncGrid = () => {
        const cur = MANUAL_PATHS.map(p => Store.get(p));
        const isOff = cur.every((v, i) => v === offValues[i]);
        offBtn.classList.toggle('active', isOff);
        for (const { btn, values } of buttons) { const match = cur.every((v, i) => v === values[i]); btn.classList.toggle('active', match); }
      };
      tabFns.push(syncGrid);
      wrap.append(grid);
      return wrap;
    }

    function buildRateDisplay() { const el = h('div', { class: 'rate-display' }); const sync = () => { el.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }; tabFns.push(sync); sync(); return el; }

    function buildAudioStatus() {
      const el = h('div', { class: 'hint' }, '상태: 대기');
      const update = () => {
        const enabled = Store.get(P.A_EN); const surround = Number(Store.get(P.A_SURROUND)) > 0; const clarity = Number(Store.get(P.A_CLARITY)) > 0; const boost = Number(Store.get(P.A_BOOST)) !== 100;
        const hooked = Audio.isHooked(), bypassed = Audio.isBypassed();
        if (!Audio.hasCtx()) { el.textContent = '상태: 대기'; }
        else if (!enabled && !surround && !clarity && !boost) { el.textContent = '상태: 비활성 (오디오 처리 OFF)'; }
        else if (hooked && !bypassed) { const parts = []; if (enabled) parts.push('평준화'); if (surround) parts.push('공간감'); if (clarity) parts.push('선명도'); if (boost) parts.push('부스트'); el.textContent = `상태: 활성 (${parts.join(' + ')} 처리 중)`; }
        else if (bypassed) { el.textContent = '상태: 바이패스 (원본 출력)'; }
        else { el.textContent = '상태: 준비 (연결 대기)'; }
      };
      tabFns.push(update); return el;
    }

    function buildVideoSchema() {
      return [
        { type: 'widget', build: buildInfoBar },
        { type: 'sep' },
        { type: 'chips', label: '디테일 프리셋', path: P.V_PRE_S, items: Object.keys(PRESETS.detail).map(k => ({ v: k, l: PRESETS.detail[k].label || k })) },
        { type: 'slider', label: '강도 믹스', path: P.V_PRE_MIX, min: 0, max: 1, step: 0.1 },
        { type: 'sep' },
        { type: 'widget', build: buildPresetGrid },
        { type: 'sep' },
        { type: 'widget', build: buildPreGainButtons },
        { type: 'sep' },
        { type: 'sectionLabel', text: '수동 조정' },
        // ⭐ step: 0.5로 변경 (암부 부스트, 디테일 복원, 노출 보정, 노출 게인)
        { type: 'fineSlider', label: '암부 부스트', path: P.V_MAN_SHAD, min: 0, max: 100, step: 0.5, fine: 0.5 },
        { type: 'fineSlider', label: '디테일 복원', path: P.V_MAN_REC, min: 0, max: 100, step: 0.5, fine: 0.5 },
        { type: 'fineSlider', label: '노출 보정', path: P.V_MAN_BRT, min: 0, max: 100, step: 0.5, fine: 0.5 },
        { type: 'fineSlider', label: '노출 게인', path: P.V_MAN_GAIN, min: -30, max: 30, step: 0.5, fine: 0.5 },
        // ⭐ step: 0.5로 변경 (감마, 콘트라스트)
        { type: 'fineSlider', label: '감마', path: P.V_MAN_GAMMA, min: -30, max: 30, step: 0.5, fine: 0.5 },
        { type: 'fineSlider', label: '콘트라스트', path: P.V_MAN_CON, min: -30, max: 30, step: 0.5, fine: 0.5 },
        { type: 'sep' },
        { type: 'sectionLabel', text: '색상 보정' },
        { type: 'fineSlider', label: '색온도', path: P.V_MAN_TEMP, min: -50, max: 50, step: 1, fine: 1 },
        { type: 'fineSlider', label: '틴트', path: P.V_MAN_TINT, min: -50, max: 50, step: 1, fine: 1 },
        { type: 'fineSlider', label: '채도', path: P.V_MAN_SAT, min: -50, max: 50, step: 1, fine: 1 },
      ];
    }

    const TAB_SCHEMA = {
      video: buildVideoSchema(),
      audio: [
        { type: 'sectionLabel', text: '볼륨 평준화 (야간 모드)' },
        { type: 'toggle', label: '평준화 ON/OFF', path: P.A_EN },
        { type: 'chips', label: '평준화 강도', path: P.A_STR, items: [{ v: 0, l: 'OFF' }, { v: 20, l: '20%' }, { v: 40, l: '40%' }, { v: 60, l: '60%' }, { v: 80, l: '80%' }, { v: 100, l: '100%' }] },
        { type: 'hint', text: '큰 소리는 줄이고 작은 소리는 키워서 볼륨 편차를 줄입니다. 야간 시청 시 유용합니다.' },
        { type: 'sep' },
        { type: 'sectionLabel', text: '공간감 (헤드폰/이어폰)' },
        { type: 'chips', label: '공간감', path: P.A_SURROUND, items: [{ v: 0, l: 'OFF' }, { v: 20, l: '20' }, { v: 40, l: '40' }, { v: 60, l: '60' }, { v: 80, l: '80' }, { v: 100, l: '100' }] },
        { type: 'hint', text: '헤드폰/이어폰 착용 시 효과적입니다. 스피커 출력 시에는 OFF를 권장합니다.' },
        { type: 'sep' },
        { type: 'sectionLabel', text: '대화 선명도' },
        { type: 'chips', label: '대화 선명도', path: P.A_CLARITY, items: [{ v: 0, l: 'OFF' }, { v: 20, l: '20' }, { v: 40, l: '40' }, { v: 60, l: '60' }, { v: 80, l: '80' }, { v: 100, l: '100' }] },
        { type: 'hint', text: '대사가 잘 안 들릴 때 올려보세요. 저음을 줄이고 대화 주파수(2.5kHz)를 강조합니다.' },
        { type: 'sep' },
        { type: 'sectionLabel', text: '볼륨 부스트' },
        { type: 'chips', label: '볼륨 부스트', path: P.A_BOOST, items: [{ v: 100, l: '100%' }, { v: 150, l: '150%' }, { v: 200, l: '200%' }, { v: 250, l: '250%' }, { v: 300, l: '300%' }] },
        { type: 'hint', text: '소리가 너무 작은 영상에서 볼륨을 100% 이상으로 증폭합니다. 리미터가 클리핑을 방지합니다.' },
        { type: 'sep' },
        { type: 'widget', build: buildAudioStatus },
      ],
      playback: [
        { type: 'toggle', label: '속도 제어', path: P.PB_EN },
        { type: 'widget', build: buildRateDisplay },
        { type: 'chips', path: P.PB_RATE, onSelect: v => { Store.batch('playback', { rate: v, enabled: true }); }, items: [0.25,0.5,1.0,1.25,1.5,2.0,3.0,5.0].map(p => ({ v: p, l: `${p}×` })) },
        { type: 'fineButtons', path: P.PB_RATE, steps: [-0.25,-0.05,0.05,0.25], min: 0.07, max: 5 },
        { type: 'slider', label: '속도 슬라이더', path: P.PB_RATE, min: 0.07, max: 5, step: 0.01, onChange: () => Store.set(P.PB_EN, true) },
      ]
    };

    function renderSchema(schema, container) {
      for (const item of schema) {
        switch (item.type) {
          case 'sep': container.append(mkSep()); break;
          case 'sectionLabel': container.append(h('div', { class: 'section-label' }, item.text)); break;
          case 'hint': container.append(h('div', { class: `hint${item.cls ? ' ' + item.cls : ''}` }, item.text)); break;
          case 'slider': container.append(mkRow(item.label, ...mkSlider(item.path, item.min, item.max, item.step, item.onChange))); break;
          case 'fineSlider': container.append(mkSliderWithFine(item.label, item.path, item.min, item.max, item.step, item.fine)); break;
          case 'toggle': container.append(mkRow(item.label, mkToggle(item.path, item.onChange))); break;
          case 'chips': container.append(mkChipRow(item.label || '', item.path, item.items, item.onSelect)); break;
          case 'fineButtons': container.append(mkFineButtons(item.path, item.steps, item.min, item.max)); break;
          case 'widget': container.append(item.build()); break;
        }
      }
    }

    function buildQuickBar() {
      if (quickBarHost) return;
      quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: HOST_STYLE_NORMAL }); quickBarHost.style.setProperty('display', 'none', 'important');
      shieldHost(quickBarHost);
      _qbarShadow = quickBarHost.attachShadow({ mode: 'closed' });
      const qStyle = document.createElement('style');
      qStyle.textContent = `${CSS_VARS} .qbar { pointer-events:none; position:fixed!important; top:50%!important; right:var(--vsc-qbar-right)!important; transform:translateY(-50%)!important; display:flex!important; align-items:center!important; z-index:2147483647!important; } .qbar .qb-main { pointer-events:auto; width:46px; height:46px; border-radius:50%; background:var(--vsc-glass); border:1px solid rgba(255,255,255,0.08); opacity:${IS_MOBILE ? '0' : '0.1'}; transition:all 0.3s var(--vsc-ease-out); box-shadow:var(--vsc-shadow-fab); display:flex; align-items:center; justify-content:center; cursor:pointer; backdrop-filter:blur(16px) saturate(180%); -webkit-tap-highlight-color:transparent; } @media (hover: hover) and (pointer: fine) { .qbar:hover .qb-main { opacity:1; transform:scale(1.08); border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); } .qbar:hover .qb-main svg { stroke:var(--vsc-neon)!important; } } .qbar .qb-main.touch-reveal { opacity:0.85!important; border-color:var(--vsc-neon-border); box-shadow:var(--vsc-shadow-fab),var(--vsc-neon-glow); } .qbar .qb-main.touch-reveal svg { stroke:var(--vsc-neon)!important; } .qbar svg { width:22px; height:22px; fill:none; stroke:#fff!important; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; display:block!important; pointer-events:none!important; }`;
      _qbarShadow.appendChild(qStyle);
      const bar = h('div', { class: 'qbar' }); const mainBtn = h('div', { class: 'qb qb-main' });
      mainBtn.appendChild(h('svg', { ns: 'svg', viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, h('circle', { ns: 'svg', cx: '12', cy: '12', r: '3' }), h('path', { ns: 'svg', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })));
      mainBtn.addEventListener('click', e => { e.preventDefault(); togglePanel(); }); bar.append(mainBtn); _qbarShadow.appendChild(bar); getMountTarget().appendChild(quickBarHost);
      if (IS_MOBILE) { let touchRevealTimer = 0; const revealGear = () => { mainBtn.classList.add('touch-reveal'); clearTimeout(touchRevealTimer); touchRevealTimer = setTimeout(() => { mainBtn.classList.remove('touch-reveal'); }, 2500); }; document.addEventListener('touchstart', revealGear, { passive: true }); mainBtn.addEventListener('touchstart', () => { mainBtn.classList.add('touch-reveal'); clearTimeout(touchRevealTimer); }, { passive: true }); }
    }

    function buildPanel() {
      if (panelHost) return;
      panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host', style: HOST_STYLE_NORMAL });
      shieldHost(panelHost);
      _shadow = panelHost.attachShadow({ mode: 'closed' });
      _shadow.appendChild(h('style', {}, PANEL_CSS));
      panelEl = h('div', { class: 'panel' });
      panelEl.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
      panelEl.style.overscrollBehavior = 'none';
      const closeBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '✕');
      closeBtn.addEventListener('click', () => togglePanel(false));
      panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), closeBtn));
      const tabBar = h('div', { class: 'tabs' });
      ['video','audio','playback'].forEach(t => { const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t }); tab.append(TAB_ICONS[t]?.() || '', h('span', {}, TAB_LABELS[t])); tab.addEventListener('click', () => { activeTab = t; renderTab(); }); tabBar.appendChild(tab); });
      panelEl.appendChild(tabBar);
      const bodyEl = h('div', { class: 'body' }); bodyEl.style.overscrollBehavior = 'none'; panelEl.appendChild(bodyEl);
      _shadow.appendChild(panelEl); getMountTarget().appendChild(panelHost);
    }

    function renderTab() {
      const body = _shadow?.querySelector('.body'); if (!body) return;
      body.textContent = ''; tabSignalCleanups.forEach(c => c()); tabSignalCleanups.length = 0; tabFns.length = 0;
      const schema = TAB_SCHEMA[activeTab]; if (schema) renderSchema(schema, body);
      tabFns.forEach(f => f()); updateTabIndicator(_shadow.querySelector('.tabs'), activeTab);
      tabSignalCleanups.push(Scheduler.onSignal(() => { if (panelOpen) tabFns.forEach(f => f()); }));
    }

    function togglePanel(force) {
      buildPanel(); panelOpen = force !== undefined ? force : !panelOpen;
      if (panelOpen) { panelEl.classList.add('open'); panelEl.style.pointerEvents = 'auto'; renderTab(); }
      else { panelEl.classList.remove('open'); tabSignalCleanups.forEach(c => c()); tabSignalCleanups.length = 0; tabFns.length = 0; setTimeout(() => { if (!panelOpen) panelEl.style.pointerEvents = 'none'; }, 300); }
    }

    buildQuickBar(); updateQuickBarVisibility();
    globalSignalCleanups.push(Scheduler.onSignal(updateQuickBarVisibility));
    setInterval(() => { if (document.hidden) return; updateQuickBarVisibility(); if (quickBarHost?.parentNode !== getMountTarget()) reparent(); }, 2000);
    setInterval(() => { if (document.hidden) return; if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { Registry.scanShadowRoots(); Registry.cleanup(); }, { timeout: 500 }); else { Registry.scanShadowRoots(); Registry.cleanup(); } }, 5000);
    onFsChange(onFullscreenChange);

    return { togglePanel, syncAll: () => tabFns.forEach(f => f()) };
  }

  function bootstrap() {
    const Scheduler = createScheduler();
    const Store = createLocalStore(DEFAULTS, Scheduler);
    try { const saved = GM_getValue(STORAGE_KEY); if (saved) Store.load(JSON.parse(saved)); } catch (_) {}
    let saveTimer = 0, lastSavedRev = 0;
    Scheduler.onSignal(() => { const currentRev = Store.rev(); if (currentRev === lastSavedRev) return; if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = 0; lastSavedRev = Store.rev(); try { GM_setValue(STORAGE_KEY, JSON.stringify(Store.state)); } catch (_) {} }, 300); });

    const Registry = createRegistry(Scheduler);
    const Targeting = createTargeting();
    const Audio = createAudio(Store, Scheduler);
    const OSD = createOSD();
    const Params = createVideoParams(Store);
    const Filters = createFilters();
    Registry.setPurgeCallback((root) => Filters.purge(root));
    Registry.setOnLoadstartCallback((video) => Audio.onVideoLoadstart(video));

    Store.sub(P.A_EN, () => { Audio.update(); });
    Store.sub(P.A_STR, (v) => { Audio.applyStrength(Number(v) ?? 50); });
    Store.sub(P.A_SURROUND, (v) => { Audio.applySurroundWidth(v); Audio.update(); });
    Store.sub(P.A_CLARITY, (v) => { Audio.applyClarity(v); Audio.update(); });
    Store.sub(P.A_BOOST, (v) => { Audio.applyBoost(v); Audio.update(); });

    const apply = () => {
      if (!Store.get(P.APP_ACT)) {
        for (const v of Registry.videos) Filters.clear(v);
        if (__internal._activeVideo?.isConnected && Store.get(P.PB_EN)) { try { __internal._activeVideo.playbackRate = 1.0; } catch (_) {} }
        Audio.setTarget(null); __internal._activeVideo = null; return;
      }
      const target = Targeting.pick(Registry.videos);
      const prevTarget = __internal._activeVideo;
      __internal._activeVideo = target || null;
      if (target) {
        if (prevTarget && prevTarget !== target && prevTarget.isConnected && Store.get(P.PB_EN)) { try { prevTarget.playbackRate = 1.0; } catch (_) {} }
        Audio.setTarget(target);
        if (Store.get(P.PB_EN)) {
          const rate = CLAMP(Number(Store.get(P.PB_RATE)) || 1, 0.07, 5);
          if (Math.abs(target.playbackRate - rate) > 0.001) {
            if (target.dataset.vscPbFail !== "1") { if (!(target.dataset.vscDrm === "1" && target.readyState >= 1)) { try { target.playbackRate = rate; delete target.dataset.vscPbRetry; } catch (_) { if (target.dataset.vscPbRetry === "1") { target.dataset.vscPbFail = "1"; } else { target.dataset.vscPbRetry = "1"; } } } }
          }
        }
      } else {
        if (prevTarget && prevTarget.isConnected && Store.get(P.PB_EN)) { try { prevTarget.playbackRate = 1.0; } catch (_) {} }
        Audio.setTarget(null);
      }
      for (const v of Registry.videos) {
        if (!v.isConnected) continue;
        if (v !== target) { Filters.clear(v); continue; }
        const dW = v.clientWidth || 0, dH = v.clientHeight || 0;
        if (dW < 80 || dH < 45) { Filters.clear(v); continue; }
        const params = Params.get(v);
        const filterStr = Filters.prepare(v, params);
        Filters.apply(v, filterStr);
      }
    };
    Scheduler.registerApply(apply);
    Store.sub(P.PB_EN, (enabled) => { if (!enabled && __internal._activeVideo?.isConnected) try { __internal._activeVideo.playbackRate = 1.0; } catch (_) {} });

    createUI(Store, Audio, Registry, Scheduler, OSD, Filters);
    __internal.Store = Store; __internal._activeVideo = null;
    try { GM_registerMenuCommand('VSC ON/OFF 토글', () => { const current = Store.get(P.APP_ACT); Store.set(P.APP_ACT, !current); OSD.show(Store.get(P.APP_ACT) ? 'VSC ON' : 'VSC OFF', 1000); }); } catch (_) {}
    Registry.rescanAll(); apply();
    log.info(`[VSC] v${VSC_VERSION} booted.`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  else bootstrap();
})();
