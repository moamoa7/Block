// ==UserScript==
// @name         Video_Control (v178.9.47 - Performance & Stability Overhaul)
// @namespace    https://github.com/
// @version      178.9.47
// @description  Video Control: Tone Safe, Bass Widener, Pointer Zoom, PiP Aspect Ratio UI.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://poooo.ml/*
// @exclude      *://tvwiki*.net/*
// @exclude      *://tvmon.site/*
// @exclude      *://tvhot.store/*
// @exclude      *://claude.ai/*
// @exclude      *://arena.ai/*
// @exclude      *://supjav.com/*
// @exclude      *://javgg.net/*
// @exclude      *://sextb.date/*
// @exclude      *://7tv*.com/*
// @exclude      *://*.sogirl.so/*
// @exclude      *://*.4kjav.co/*
// @exclude      *://www.youtube.com/live_chat*
// @exclude      *://www.youtube.com/live_chat_replay*
// @run-at       document-start
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @allFrames    true
// ==/UserScript==

(function () {
'use strict';

function VSC_MAIN() {
  if (location.protocol === 'javascript:') return;

  const SCRIPT_VERSION = '178.9.47';

  const VSC_BOOT_KEY = Symbol.for(`VSC_BOOT_LOCK_${SCRIPT_VERSION}`);
  if (window[VSC_BOOT_KEY]) return;
  window[VSC_BOOT_KEY] = true;

  const VSC_NS_NEW = Symbol.for('__VSC__');
  if (!window[VSC_NS_NEW]) window[VSC_NS_NEW] = {};
  const __vscNs = window[VSC_NS_NEW];
  __vscNs.__version = SCRIPT_VERSION;

  const __globalHooksAC = new AbortController();
  const __globalSig = __globalHooksAC.signal;
  __vscNs._globalHooksAC = __globalHooksAC;

  const DISPOSERS = __vscNs._disposers || (__vscNs._disposers = new Set());
  function addDisposer(fn) {
    if (typeof fn === 'function') DISPOSERS.add(fn);
    return fn;
  }

  function clearRuntimeTimers(ns) {
    try {
      for (const id of ns._timers || []) { try { clearTimeout(id); } catch (_) {} }
    } catch (_) {}
    try {
      for (const id of ns._intervals || []) { try { clearInterval(id); } catch (_) {} }
    } catch (_) {}
    ns._timers = [];
    ns._intervals = [];
  }

  function destroyRuntime(ns = __vscNs) {
    if (!ns || ns.__destroying) return;
    ns.__destroying = true;

    try { clearRuntimeTimers(ns); } catch (_) {}

    try { ns.App?.destroy?.(); } catch (_) {}
    try { ns.Store?.destroy?.(); } catch (_) {}
    try { ns.AutoScene?.destroy?.(); } catch (_) {}
    try { ns.ZoomManager?.destroy?.(); } catch (_) {}
    try { ns.TimerManager?.destroy?.(); } catch (_) {}
    try { ns.Registry?.destroy?.(); } catch (_) {}

    try { ns._spaNavAC?.abort?.(); } catch (_) {}
    try { ns._globalHooksAC?.abort?.(); } catch (_) {}

    try { ns._restoreHistory?.(); } catch (_) {}
    try { ns._restoreAttachShadow?.(); } catch (_) {}
    try { ns._restoreVideoFsPatch?.(); } catch (_) {}

    for (const fn of [...DISPOSERS].reverse()) { safe(fn); }
    DISPOSERS.clear();

    try {
      if (ns._shadowRootCb && typeof __shadowRootCallbacks !== 'undefined') {
        __shadowRootCallbacks.delete(ns._shadowRootCb);
      }
    } catch (_) {}

    try { delete window[Symbol.for('__VSC_SPA_PATCHED__')]; } catch (_) {}

    try {
      (ns._menuIds || []).forEach(id => {
        try { GM_unregisterMenuCommand(id); } catch (_) {}
      });
    } catch (_) {}

    ns.__alive = false;
    ns.__destroying = false;
  }

  if (__vscNs.__alive) {
    destroyRuntime(__vscNs);
  }
  __vscNs.__alive = true;
  __vscNs._menuIds = [];
  __vscNs._timers = [];
  __vscNs._intervals = [];

  const SYS = Object.freeze({ WFC: 5000, SRD: 220 });
  const TOE_DIVISOR = 12;

  const FLAGS = Object.seal({
    SCHED_ALIGN_TO_VIDEO_FRAMES: false,
    SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO: false,
    FILTER_SHARP_SAT_COMP: false,
    FILTER_FORCE_OPAQUE_BG: true,
    FS_REDIRECT_TO_PARENT: false,
    UI_EXPENSIVE_SHADOW_PROBE: false
  });
  __vscNs.FLAGS = FLAGS;

  const getNS = () => (window && window[Symbol.for('__VSC__')]) || __vscNs || null;
  const getFLAGS = () => getNS()?.FLAGS || FLAGS;
  const safe = (fn) => { try { fn(); } catch (_) {} };
  const OPT_P = { passive: true };
  const OPT_PC = { passive: true, capture: true };

  function combineSignals(...signals) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    const ac = new AbortController();
    for (const sig of signals) {
      if (sig.aborted) { ac.abort(sig.reason); return ac.signal; }
      sig.addEventListener('abort', () => ac.abort(sig.reason ?? new DOMException('Signal aborted', 'AbortError')), { once: true });
    }
    return ac.signal;
  }

  function on(target, type, fn, opts = {}) {
    if (!target?.addEventListener) return;
    const merged = { ...opts };
    const sig = merged.signal || __globalSig;
    try { target.addEventListener(type, fn, { ...merged, signal: sig }); }
    catch (_) { try { target.addEventListener(type, fn, !!merged.capture); } catch (__) {} }
  }

  const getSmoothStroke = (color = '#000') => `text-shadow: 1px 1px 0 ${color}, -1px -1px 0 ${color}, 1px -1px 0 ${color}, -1px 1px 0 ${color}, 0px 1px 0 ${color}, 0px -1px 0 ${color}, 1px 0px 0 ${color}, -1px 0px 0 ${color};`;
  __vscNs.getSmoothStroke = getSmoothStroke;

  const blockInterference = (el) => {
    if (!el) return;
    const stop = (e) => { e.stopPropagation(); };
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'dblclick'].forEach(evt => {
      on(el, evt, stop, { passive: false });
    });
  };
  __vscNs.blockInterference = blockInterference;

  (function initVideoFsPatch() {
    const proto = HTMLVideoElement?.prototype;
    if (!proto) return;

    const reqFns = [
      'requestFullscreen',
      'webkitRequestFullscreen',
      'mozRequestFullScreen',
      'msRequestFullscreen'
    ];

    __vscNs._origVideoFsFns ||= new Map();

    function ensureVideoFsPatched() {
      for (const k of reqFns) {
        const orig = proto[k];
        if (typeof orig !== 'function' || orig.__vsc_patched) continue;

        if (!__vscNs._origVideoFsFns.has(k)) {
          __vscNs._origVideoFsFns.set(k, orig);
        }

        const wrapped = function (...args) {
          let p = this.closest('[class*="player"], [id*="player"], [data-player]');
          if (!p) {
            const root = this.getRootNode?.();
            if (root instanceof window.ShadowRoot && root.host) {
              p = root.host.closest('[class*="player"], [id*="player"], [data-player]') || root.host;
            }
          }
          p = p || this.parentElement;

          const fn = p && (p[k] || p.requestFullscreen);
          return fn ? fn.apply(p, args) : orig.apply(this, args);
        };

        wrapped.__vsc_patched = true;
        wrapped.__vsc_orig = orig;

        try { proto[k] = wrapped; } catch (_) {}
      }
    }

    function restoreVideoFsPatch() {
      const map = __vscNs._origVideoFsFns;
      if (!map) return;

      for (const [k, orig] of map) {
        try {
          const cur = proto[k];
          if (cur && cur.__vsc_patched && cur.__vsc_orig === orig) {
            proto[k] = orig;
          }
        } catch (_) {}
      }
    }

    __vscNs._ensureVideoFsPatch = ensureVideoFsPatched;
    __vscNs._restoreVideoFsPatch = restoreVideoFsPatch;

    if (getFLAGS()?.FS_REDIRECT_TO_PARENT) {
      ensureVideoFsPatched();
    }
  })();

  let shadowEmitterInstalled = false;
  const __shadowRootCallbacks = new Set();
  const notifyShadowRoot = (sr) => { for (const cb of __shadowRootCallbacks) safe(() => cb(sr)); };

  function installShadowRootEmitterIfNeeded() {
    if (shadowEmitterInstalled) return;
    shadowEmitterInstalled = true;

    const proto = Element.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    if (!desc || typeof desc.value !== 'function') return;

    if (desc.value.__vsc_shadowEmitterPatched) return;
    if (!__vscNs._origAttachShadowDesc) __vscNs._origAttachShadowDesc = desc;

    const orig = desc.value;
    const patched = function(init) {
      const sr = orig.call(this, init);
      queueMicrotask(() => notifyShadowRoot(sr));
      return sr;
    };

    Object.defineProperty(patched, '__vsc_shadowEmitterPatched', { value: true });
    Object.defineProperty(patched, '__vsc_shadowEmitterOrig', { value: orig });

    try {
      Object.defineProperty(proto, 'attachShadow', { ...desc, value: patched });
    } catch (_) {
      try { proto.attachShadow = patched; } catch (__) {}
    }

    __vscNs._restoreAttachShadow = addDisposer(() => {
      const d = __vscNs._origAttachShadowDesc;
      if (!d) return;
      try { Object.defineProperty(Element.prototype, 'attachShadow', d); } catch (_) {}
    });
  }

  function onPageReady(fn) {
    let ran = false;
    const localAC = new AbortController();
    const sig = combineSignals(localAC.signal, __globalSig);

    const run = () => {
      if (ran || sig.aborted) return;
      ran = true;
      localAC.abort();
      safe(fn);
    };

    if ((document.readyState === 'interactive' || document.readyState === 'complete') && document.body) {
      run();
      return () => localAC.abort();
    }

    document.addEventListener('DOMContentLoaded', run, { once: true, signal: sig });
    window.addEventListener('load', run, { once: true, signal: sig });

    return () => localAC.abort();
  }

  function detectMobile() {
    const uad = navigator.userAgentData;
    if (uad && typeof uad.mobile === 'boolean') return uad.mobile;
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  }

  const CONFIG = Object.freeze({
    IS_MOBILE: detectMobile(),
    VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)),
    DEBUG: /[?&]vsc_debug=1/.test(location.search)
  });

  const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

  const log = {
    error: (...a) => console.error('[VSC]', ...a),
    warn: (...a) => console.warn('[VSC]', ...a),
    info: () => {},
    debug: (...a) => { if (CONFIG.DEBUG) console.debug('[VSC]', ...a); }
  };

  function tempToRgbGain(temp) {
    const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
    if (Math.abs(t) < 1e-4) return { rs: 1, gs: 1, bs: 1 };
    const r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t);
    const m = Math.max(r, g, b);
    return { rs: r / m, gs: g / m, bs: b / m };
  }

  let __vscLayoutRev = 0;
  const bumpLayoutRev = () => { __vscLayoutRev = (__vscLayoutRev + 1) | 0; };
  on(window, 'scroll', bumpLayoutRev, { passive: true, capture: true });
  on(window, 'resize', bumpLayoutRev, { passive: true });
  try {
    const vv = window.visualViewport;
    if (vv) {
      on(vv, 'scroll', bumpLayoutRev, { passive: true });
      on(vv, 'resize', bumpLayoutRev, { passive: true });
    }
  } catch (_) {}

  const videoStateMap = new WeakMap();

  const getVState = (v) => {
    let st = videoStateMap.get(v);
    if (!st) {
      st = {
        visible: false, rect: null, rectT: 0, _rectRev: -1, bound: false,
        applied: false, lastFilterUrl: null, rateState: null, desiredRate: undefined,
        audioFailUntil: 0, _ac: null, _lastSrc: '',
        origFilter: null, origFilterPrio: '',
        origWebkitFilter: null, origWebkitFilterPrio: '',
        filterRev: -1, _filterResRev: -1, fxBackend: null
      };
      videoStateMap.set(v, st);
    }
    return st;
  };

  const DARK_BAND = Object.freeze({ LV1: 1, LV2: 2, LV3: 3 });

  const PRESETS = Object.freeze({
    detail: {
      off:    { sharpAdd: 0,  sharp2Add: 0,  clarityAdd: 0,  sat: 1.0 },
      Soft:   { sharpAdd: 15, sharp2Add: 20, clarityAdd: 2,  sat: 0.99 },
      Medium: { sharpAdd: 35, sharp2Add: 45, clarityAdd: 4,  sat: 0.98 },
      Ultra:  { sharpAdd: 55, sharp2Add: 65, clarityAdd: 6,  sat: 0.97 }
    },
    grade: {
      brOFF: { gammaF: 1.00, brightAdd: 0 },
      S: { gammaF: 1.03, brightAdd: 2.0 },
      M: { gammaF: 1.08, brightAdd: 5.0 },
      L: { gammaF: 1.15, brightAdd: 9.0 },
      DS: { gammaF: 1.05, brightAdd: 3.5 },
      DM: { gammaF: 1.12, brightAdd: 7.5 },
      DL: { gammaF: 1.22, brightAdd: 11.0 }
    }
  });

  const DEFAULTS = {
    video: { presetS: 'off', presetB: 'brOFF', shadowBandMask: 0, brightStepLevel: 0 },
    audio: { enabled: false, boost: 0, multiband: true, lufs: true, dialogue: false, stereoWidth: false },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false, applyAll: true, zoomEn: false, autoScene: false, autoScenePreset: 'Normal', advanced: false, timeEn: true, timePos: 1 }
  };

  const P = Object.freeze({
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_AUTO_SCENE_PRESET: 'app.autoScenePreset', APP_ADV: 'app.advanced',
    APP_TIME_EN: 'app.timeEn', APP_TIME_POS: 'app.timePos',
    V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel',
    A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue', A_STEREO_W: 'audio.stereoWidth',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  });

  const APP_SCHEMA = [ { type: 'bool', path: P.APP_ACT }, { type: 'bool', path: P.APP_UI }, { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'enum', path: P.APP_AUTO_SCENE_PRESET, values: ['Soft', 'Normal', 'Strong'], fallback: () => 'Normal' }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_TIME_EN }, { type: 'num', path: P.APP_TIME_POS, min: 0, max: 2, round: true, fallback: () => 1 } ];
  const VIDEO_SCHEMA = [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 3, round: true, fallback: () => 0 }, { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 } ];
  const AUDIO_PLAYBACK_SCHEMA = [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => 0 }, { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE }, { type: 'bool', path: P.A_STEREO_W }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ];
  const ALL_SCHEMA = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];
  const ALL_KEYS = ALL_SCHEMA.map(s => s.path);

  const TOUCHED = { videos: new Set(), rateVideos: new Set() };
  const TOUCHED_MAX = 300;

  function touchedAdd(set, el) {
    if (!el) return;
    if (set.has(el)) set.delete(el);
    set.add(el);
    if (set.size > TOUCHED_MAX) {
      const excess = set.size - Math.floor(TOUCHED_MAX * 0.75);
      let removed = 0;
      for (const old of set) {
        if (removed >= excess) break;
        if (!old.isConnected) {
          set.delete(old);
          if (set === TOUCHED.videos) safe(() => __vscNs.Adapter?.clear(old));
          safe(() => {
            const st = getVState(old);
            if (st) st.desiredRate = undefined;
            if (typeof restoreRateOne === 'function') restoreRateOne(old);
          });
          removed++;
        }
      }
      while (set.size > TOUCHED_MAX) {
        const old = set.keys().next().value;
        set.delete(old);
        if (set === TOUCHED.videos) safe(() => __vscNs.Adapter?.clear(old));
        safe(() => {
          const st = getVState(old);
          if (st) st.desiredRate = undefined;
          if (typeof restoreRateOne === 'function') restoreRateOne(old);
        });
      }
    }
  }

  function getRectCached(v, now, maxAgeMs = 800) {
    const st = getVState(v);
    const r = st.rect;
    if (r && st._rectRev === __vscLayoutRev && (now - (st.rectT || 0)) <= maxAgeMs) return r;
    const fresh = v.getBoundingClientRect();
    st.rect = fresh;
    st.rectT = now;
    st._rectRev = __vscLayoutRev;
    return fresh;
  }

  function getViewportSnapshot() {
    const vv = window.visualViewport;
    if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 };
    return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
  }

  function createDebounced(fn, ms = 250) {
    let t = null;
    const debounced = (...args) => {
      if (t !== null) clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
    debounced.cancel = () => { if (t !== null) { clearTimeout(t); t = null; } };
    return debounced;
  }

  function initSpaUrlDetector(onChanged) {
    try { __vscNs._spaDetector?.destroy?.(); } catch (_) {}

    const ac = new AbortController();
    const sig = combineSignals(ac.signal, __globalSig);

    if (!__vscNs._origHistoryFns) {
      __vscNs._origHistoryFns = {
        pushState: history.pushState,
        replaceState: history.replaceState
      };
    }

    let lastHref = location.href;
    const emitIfChanged = () => {
      const next = location.href;
      if (next === lastHref) return;
      lastHref = next;
      onChanged();
    };

    const restoreHistoryIfOwned = (name, orig) => {
      try {
        const cur = history[name];
        if (cur && cur.__vsc_wrapped && cur.__vsc_orig === orig) {
          history[name] = orig;
        }
      } catch (_) {}
    };

    const destroy = () => {
      ac.abort();
      const o = __vscNs._origHistoryFns;
      if (!o) return;
      restoreHistoryIfOwned('pushState', o.pushState);
      restoreHistoryIfOwned('replaceState', o.replaceState);
    };

    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      const navAC = new AbortController();
      __vscNs._spaNavAC = navAC;
      window.navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: navAC.signal });
      on(window, 'popstate', emitIfChanged, { passive: true, signal: navAC.signal });
      __vscNs._spaDetector = { destroy };
      return __vscNs._spaDetector;
    }

    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== 'function') return;
      if (orig.__vsc_wrapped) return;

      const wrapped = function (...args) {
        const ret = Reflect.apply(orig, this, args);
        queueMicrotask(emitIfChanged);
        return ret;
      };
      wrapped.__vsc_wrapped = true;
      wrapped.__vsc_orig = orig;
      wrapped.__vsc_owner = CONFIG.VSC_ID;

      try {
        Object.defineProperty(history, name, {
          value: wrapped, configurable: true, writable: true, enumerable: true
        });
      } catch (_) {
        try { history[name] = wrapped; } catch (__) {}
      }
    };

    wrap('pushState');
    wrap('replaceState');
    on(window, 'popstate', emitIfChanged, { passive: true, signal: sig });

    __vscNs._spaDetector = { destroy };
    __vscNs._restoreHistory = destroy;
    return __vscNs._spaDetector;
  }

  function createUtils() {
    const SVG_TAGS = new Set(['svg','defs','filter','feColorMatrix','feComponentTransfer','feFuncR','feFuncG','feFuncB','feGaussianBlur','feComposite']);
    return {
      clamp: VSC_CLAMP,
      h: (tag, props = {}, ...children) => {
        const isSvg = SVG_TAGS.has(tag) || props.ns === 'svg';
        const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), v); }
          else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
          else if (k === 'class') { el.className = v; }
          else if (v !== false && v != null && k !== 'ns') { el.setAttribute(k, v); }
        }
        children.flat().forEach(c => { if (c != null) el.append(c); });
        return el;
      }
    };
  }

  function createScheduler(minIntervalMs = 32) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
    let rvfcId = 0, rvfcTok = 0, rvfcVideo = null, getRvfcVideo = null;

    function cancelRvfc() {
      rvfcTok++;
      if (rvfcId && rvfcVideo && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
        try { rvfcVideo.cancelVideoFrameCallback(rvfcId); } catch (_) {}
      }
      rvfcId = 0; rvfcVideo = null;
    }

    function clearPending() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      cancelRvfc();
    }

    function run() {
      rafId = 0; queued = false;
      const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun;
      if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; }
      lastRun = now; if (applyFn) { try { applyFn(doForce); } catch (_) {} }
    }

    function timerCb() { timer = 0; run(); }
    function queueRaf() { if (!rafId) rafId = requestAnimationFrame(run); }

    function shouldAlignToVideoFrames() {
      const flags = getFLAGS();
      if (flags.SCHED_ALIGN_TO_VIDEO_FRAMES) return true;

      if (!flags.SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) {
        return !!getNS()?._schedAlignRvfc;
      }

      const v = getRvfcVideo?.();
      return !!(
        v &&
        !v.paused &&
        !v.ended &&
        v.readyState >= 2 &&
        document.visibilityState === 'visible' &&
        typeof v.requestVideoFrameCallback === 'function'
      );
    }

    function queueRvfc() {
      if (!shouldAlignToVideoFrames() || rvfcId) return false;

      const v = getRvfcVideo?.();
      if (!v || typeof v.requestVideoFrameCallback !== 'function') return false;

      const tok = ++rvfcTok;
      rvfcVideo = v;

      rvfcId = v.requestVideoFrameCallback(() => {
        if (tok !== rvfcTok) return;
        rvfcId = 0;
        rvfcVideo = null;
        run();
      });

      return true;
    }

    const request = (immediate = false) => {
      if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; }
      if (queued) return;
      queued = true; clearPending();
      if (!queueRvfc()) queueRaf();
    };

    return {
      registerApply: (fn) => { applyFn = fn; },
      request,
      setRvfcSource: (fn) => { getRvfcVideo = fn; },
      destroy: () => { clearPending(); applyFn = null; }
    };
  }

  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };

  const STORAGE_FLAGS = Object.freeze({
    ALLOW_LOCALSTORAGE_FALLBACK: true
  });

  function createLocalStore(defaults, scheduler) {
    let _stateVal;
    try { _stateVal = structuredClone(defaults); } catch (_) { _stateVal = JSON.parse(JSON.stringify(defaults)); }
    const state = _stateVal;
    let rev = 0; const listeners = new Map();
    const storeAC = new AbortController();
    const storeSig = combineSignals(storeAC.signal, __globalSig);
    const PREF_KEY = 'vsc_prefs_' + location.hostname;

    function loadPrefs() {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(PREF_KEY, null);
          if (typeof v === 'string' && v) return v;
        }
      } catch (_) {}

      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) {
        try { return localStorage.getItem(PREF_KEY); } catch (_) {}
      }
      return null;
    }

    function savePrefsRaw(json) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(PREF_KEY, json);
          return true;
        }
      } catch (_) {}

      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) {
        try {
          localStorage.setItem(PREF_KEY, json);
          return true;
        } catch (_) {}
      }
      return false;
    }

    function clearPrefsRaw() {
      let cleared = false;
      try {
        if (typeof GM_deleteValue === 'function') {
          GM_deleteValue(PREF_KEY);
          cleared = true;
        }
      } catch (_) {}

      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) {
        try {
          localStorage.removeItem(PREF_KEY);
          cleared = true;
        } catch (_) {}
      }
      return cleared;
    }

    function mergeKnown(dst, src, defaults) {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(defaults)) {
        if (Object.prototype.hasOwnProperty.call(src, key)) {
          dst[key] = src[key];
        }
      }
    }

    try {
      const saved = loadPrefs();
      if (saved) {
        const parsed = JSON.parse(saved);
        mergeKnown(state.video, parsed.video, DEFAULTS.video);
        mergeKnown(state.audio, parsed.audio, DEFAULTS.audio);
        mergeKnown(state.playback, parsed.playback, DEFAULTS.playback);
        mergeKnown(state.app, parsed.app, DEFAULTS.app);
      }
    } catch (e) {
      log.warn('Invalid prefs detected. Resetting persisted prefs.', e);
      clearPrefsRaw();
    }

    let _saveFailCount = 0; let _lastSavedJson = ''; const MAX_SAVE_RETRIES = 5;
    let _saveDisabledUntil = 0;

    function _doSave() {
      const now = Date.now();
      if (_saveFailCount >= MAX_SAVE_RETRIES) {
        if (now < _saveDisabledUntil) return;
        _saveFailCount = Math.max(0, MAX_SAVE_RETRIES - 2);
      }
      try {
        const json = JSON.stringify(state);
        if (json === _lastSavedJson) return;
        if (json.length > 8192) { log.warn('Settings too large, skipping save'); return; }
        if (!savePrefsRaw(json)) {
          _saveFailCount++;
          if (_saveFailCount >= MAX_SAVE_RETRIES) _saveDisabledUntil = now + 60000;
          return;
        }
        _lastSavedJson = json; _saveFailCount = 0;
      } catch (e) {
        _saveFailCount++;
        if (_saveFailCount >= MAX_SAVE_RETRIES) _saveDisabledUntil = now + 60000;
      }
    }

    const savePrefs = createDebounced(() => { _doSave(); }, 1000);

    const flushNow = () => {
      savePrefs.cancel();
      _doSave();
    };

    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    }, { passive: true, signal: storeSig });

    on(window, 'pagehide', flushNow, { passive: true, signal: storeSig });
    on(window, 'beforeunload', flushNow, { once: true, signal: storeSig });

    const emit = (path, val) => {
      const cbs = listeners.get(path); if (cbs) { for (const cb of cbs) safe(() => cb(val)); }
      const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) { for (const cb of cbsStar) safe(() => cb(val)); } }
    };
    const notifyChange = (path, val) => { rev++; emit(path, val); savePrefs(); scheduler.request(false); };

    return {
      state, rev: () => rev, getCatRef: (cat) => state[cat],
      get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; },
      set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); },
      batch: (cat, obj) => { let changed = false; for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); } } if (changed) { rev++; savePrefs(); scheduler.request(false); } },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); },

      destroy: () => {
        storeAC.abort();
        savePrefs.cancel();
        try { _doSave(); } catch (_) {}
        listeners.clear();
      }
    };
  }

  function normalizeBySchema(sm, schema) {
    let changed = false;
    const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
    for (const { type, path, values, fallback, min, max, round } of schema) {
      switch (type) {
        case 'bool': set(path, !!sm.get(path)); break;
        case 'enum': { const cur = sm.get(path); if (!values.includes(cur)) set(path, fallback()); break; }
        case 'num': { let n = Number(sm.get(path)); if (!Number.isFinite(n)) n = fallback(); if (round) n = Math.round(n); set(path, Math.max(min, Math.min(max, n))); break; }
      }
    }
    return changed;
  }

// --- PART 1 END ---
// --- PART 2 START ---
  const PLAYER_CONTAINER_SELECTORS = '[class*=player],[class*=Player],[id*=player],[class*=video-container],[data-player]';

  const PIP_FLAGS = Object.freeze({
    SAFE_PIP_RESTORE: false,
    USE_LEGACY_PIP_FALLBACK: true
  });

  const PiPState = {
    window: null, video: null, placeholder: null,
    origParent: null, origNext: null, origContainer: null,
    origCss: '', _ac: null, _watcherId: null, _restoring: false, _uiCleanup: null,
    reset() {
      try { this._uiCleanup?.(); } catch (_) {}
      this._uiCleanup = null;
      if (this._ac) { this._ac.abort(); this._ac = null; }
      if (this._watcherId) { clearInterval(this._watcherId); this._watcherId = null; }
      Object.assign(this, {
        window: null, video: null, placeholder: null,
        origParent: null, origNext: null, origContainer: null,
        origCss: '', _ac: null, _watcherId: null, _restoring: false, _uiCleanup: null
      });
    }
  };

  function checkAndCleanupClosedPiP() {
    if (PiPState.window && PiPState.window.closed && PiPState.video) {
      restoreFromDocumentPiP(PiPState.video);
    }
  }

  function startPiPWatcher() {
    if (PiPState._watcherId) return;
    PiPState._watcherId = setInterval(() => {
      if (!PiPState.window) { clearInterval(PiPState._watcherId); PiPState._watcherId = null; return; }
      checkAndCleanupClosedPiP();
    }, 1000);
  }

  function getActivePiPVideo() {
    if (PiPState.video && PiPState.window && !PiPState.window.closed) return PiPState.video;
    const el = document.pictureInPictureElement;
    return (el instanceof HTMLVideoElement) ? el : null;
  }

  function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

  function supportsDocumentPiP() {
    try {
      if (window.top !== window) return false;
    } catch (_) {
      return false;
    }
    return !!(window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function');
  }

  function supportsLegacyPiP(video) {
    return !!(video && typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false);
  }

  async function enterLegacyPiP(video) {
    await video.requestPictureInPicture();
    PiPState.reset();
    return true;
  }

  const DOC_PIP_SIZE_KEY = 'vsc_doc_pip_size_v1';

  function loadDocPiPSize() {
    try {
      const raw = localStorage.getItem(DOC_PIP_SIZE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Number.isFinite(parsed.w) || !Number.isFinite(parsed.h)) return null;
      return {
        w: Math.max(320, Math.round(parsed.w)),
        h: Math.max(180, Math.round(parsed.h))
      };
    } catch (_) {
      return null;
    }
  }

  function saveDocPiPSize(win) {
    try {
      localStorage.setItem(DOC_PIP_SIZE_KEY, JSON.stringify({
        w: Math.round(win.innerWidth || 0),
        h: Math.round(win.innerHeight || 0)
      }));
    } catch (_) {}
  }

  function waitForDocPiPClose(win, timeout = 2000) {
    return new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        if (!win || win.closed || PiPState.window !== win) {
          resolve(true);
          return;
        }
        if ((performance.now() - started) >= timeout) {
          resolve(false);
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  async function enterDocumentPiP(video) {
    const wasPlaying = !video.paused;
    const saved = loadDocPiPSize();
    let pipWindow = null;

    try {
      const nativeW = video.videoWidth || 0, nativeH = video.videoHeight || 0;
      const displayW = video.clientWidth || 0, displayH = video.clientHeight || 0;
      const fallbackW = nativeW > 0 ? Math.round(nativeW / 2) : (displayW > 0 ? displayW : 640);
      const fallbackH = nativeH > 0 ? Math.round(nativeH / 2) : (displayH > 0 ? displayH : 360);

      const maxW = Math.round(screen.availWidth * 0.5), maxH = Math.round(screen.availHeight * 0.5);
      const w = Math.max(320, Math.min(saved?.w || fallbackW, maxW));
      const h = Math.max(180, Math.min(saved?.h || fallbackH, maxH));

      pipWindow = await window.documentPictureInPicture.requestWindow({ width: w, height: h });

      safe(() => getNS()?.AudioSetTarget?.(null));

      PiPState.window = pipWindow;
      PiPState.video = video;
      PiPState.origParent = video.parentNode;
      PiPState.origNext = video.nextSibling;
      PiPState.origContainer =
        video.closest(PLAYER_CONTAINER_SELECTORS) ||
        (video.getRootNode?.() instanceof ShadowRoot
          ? video.getRootNode().host?.closest?.(PLAYER_CONTAINER_SELECTORS)
          : null) ||
        null;

      PiPState.origCss = video.style.cssText;
      PiPState.placeholder = document.createElement('div');

      const rect = video.getBoundingClientRect();
      const pw = rect.width || video.clientWidth || video.offsetWidth || 640;
      const ph = rect.height || video.clientHeight || video.offsetHeight || 360;

      Object.assign(PiPState.placeholder.style, {
        width: `${pw}px`,
        height: `${ph}px`,
        background: '#000',
        display: getComputedStyle(video).display || 'block',
        boxSizing: 'border-box'
      });

      PiPState.origParent?.insertBefore(PiPState.placeholder, video);

      const doc = pipWindow.document;

      const style = doc.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; }
        html, body {
          margin: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: #000;
          color: #fff;
          font-family: system-ui, sans-serif;
        }
        .vsc-pip-root {
          display: grid;
          grid-template-rows: minmax(0, 1fr) auto;
          width: 100%;
          height: 100%;
          background: #000;
        }
        .vsc-pip-stage {
          min-width: 0;
          min-height: 0;
          display: grid;
          place-items: center;
          overflow: hidden;
          background: #000;
        }
        .vsc-pip-frame {
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          background: #000;
        }
        .vsc-pip-frame video {
          max-width: 100%;
          max-height: 100%;
          width: auto;
          height: auto;
          display: block;
          object-fit: contain;
          background: #000;
        }
        .vsc-pip-bar {
          display: flex;
          gap: 6px;
          padding: 8px;
          background: rgba(18,18,18,.92);
          border-top: 1px solid rgba(255,255,255,.12);
        }
        .vsc-pip-btn {
          flex: 1;
          min-height: 34px;
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 10px;
          background: #222;
          color: #fff;
          font-weight: 700;
          cursor: pointer;
        }
        .vsc-pip-btn:hover { background: #2a2a2a; }
      `;
      doc.head.appendChild(style);

      const root = doc.createElement('div');
      root.className = 'vsc-pip-root';

      const stage = doc.createElement('div');
      stage.className = 'vsc-pip-stage';

      const frame = doc.createElement('div');
      frame.className = 'vsc-pip-frame';

      const bar = doc.createElement('div');
      bar.className = 'vsc-pip-bar';

      const mkBtn = (label, onClick) => {
        const b = doc.createElement('button');
        b.className = 'vsc-pip-btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
      };

      const playBtn = mkBtn(video.paused ? '▶ 재생' : '⏸ 일시정지', () => {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      });

      const backBtn = mkBtn('⏪ 10s', () => {
        try { video.currentTime = Math.max(0, video.currentTime - 10); } catch (_) {}
      });

      const fwdBtn = mkBtn('10s ⏩', () => {
        try {
          const maxT = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : video.currentTime + 10;
          video.currentTime = Math.min(maxT, video.currentTime + 10);
        } catch (_) {}
      });

      function getShellHeight() {
        return Math.ceil(bar.getBoundingClientRect().height || 50);
      }

      function resizePiPToAspect(scale = 1.0) {
        if (!pipWindow || pipWindow.closed) return;

        const vw = video.videoWidth || 0;
        const vh = video.videoHeight || 0;
        if (!vw || !vh) return;

        const shellH = getShellHeight();
        const maxStageW = Math.floor(screen.availWidth * 0.50 * scale);
        const maxStageH = Math.floor((screen.availHeight * 0.50 - shellH) * scale);

        if (maxStageW < 200 || maxStageH < 100) return;

        const ratio = vw / vh;

        let stageW = maxStageW;
        let stageH = Math.round(stageW / ratio);

        if (stageH > maxStageH) {
          stageH = maxStageH;
          stageW = Math.round(stageH * ratio);
        }

        const targetInnerW = stageW;
        const targetInnerH = stageH + shellH;

        try {
          const chromeW = pipWindow.outerWidth - pipWindow.innerWidth;
          const chromeH = pipWindow.outerHeight - pipWindow.innerHeight;
          pipWindow.resizeTo(targetInnerW + chromeW, targetInnerH + chromeH);
        } catch (_) {}
      }

      const fitBtn = mkBtn('⤢ 맞춤', () => resizePiPToAspect(1.0));
      const smallBtn = mkBtn('S', () => resizePiPToAspect(0.85));
      const largeBtn = mkBtn('L', () => resizePiPToAspect(1.15));

      const closeBtn = mkBtn('✕ 닫기', () => {
        exitPiP(video).catch(() => {});
      });

      const syncPlayBtn = () => {
        playBtn.textContent = video.paused ? '▶ 재생' : '⏸ 일시정지';
      };

      video.addEventListener('play', syncPlayBtn);
      video.addEventListener('pause', syncPlayBtn);

      PiPState._uiCleanup = () => {
        video.removeEventListener('play', syncPlayBtn);
        video.removeEventListener('pause', syncPlayBtn);
      };

      Object.assign(video.style, {
        maxWidth: '100%',
        maxHeight: '100%',
        width: 'auto',
        height: 'auto',
        objectFit: 'contain'
      });

      frame.append(video);
      stage.append(frame);
      bar.append(backBtn, playBtn, fwdBtn, fitBtn, smallBtn, largeBtn, closeBtn);
      root.append(stage, bar);
      doc.body.append(root);

      function syncPiPLayout() {
        if (!pipWindow || pipWindow.closed) return;
        const vw = video.videoWidth || 0;
        const vh = video.videoHeight || 0;
        if (!vw || !vh) return;
        frame.style.aspectRatio = `${vw} / ${vh}`;
      }

      await new Promise(resolve => requestAnimationFrame(resolve));
      safe(() => getNS()?.AudioSetTarget?.(video));

      if (wasPlaying && video.paused) {
        video.play().catch(() => {});
      }
      safe(() => getNS()?.ApplyReq?.hard());

      const pipAC = new AbortController();
      const saveSizeDebounced = createDebounced(() => saveDocPiPSize(pipWindow), 180);

      video.addEventListener('loadedmetadata', syncPiPLayout, { signal: pipAC.signal });

      pipWindow.addEventListener('resize', () => {
        syncPiPLayout();
        saveSizeDebounced();
      }, { signal: pipAC.signal });

      pipWindow.addEventListener('pagehide', () => {
        pipAC.abort();
        saveDocPiPSize(pipWindow);
        restoreFromDocumentPiP(video);
      }, { once: true });

      PiPState._ac = pipAC;
      startPiPWatcher();

      syncPiPLayout();
      if (!saved) {
        setTimeout(() => resizePiPToAspect(1.0), 100);
      }

      return true;
    } catch (e) {
      try {
        video.style.cssText = PiPState.origCss || '';

        if (PiPState.origParent && video.parentNode !== PiPState.origParent) {
          if (PiPState.origNext && PiPState.origNext.parentNode === PiPState.origParent) {
            PiPState.origParent.insertBefore(video, PiPState.origNext);
          } else if (PiPState.placeholder?.parentNode === PiPState.origParent) {
            PiPState.origParent.insertBefore(video, PiPState.placeholder);
          } else {
            PiPState.origParent.appendChild(video);
          }
        }

        PiPState.placeholder?.remove?.();
        if (pipWindow && !pipWindow.closed) {
          try { pipWindow.close(); } catch (_) {}
        }
      } catch (_) {}

      PiPState.reset();
      throw e;
    }
  }

  async function enterPiP(video) {
    if (!video || video.readyState < 2) throw new Error('Video not ready');

    if (supportsDocumentPiP()) {
      try {
        return await enterDocumentPiP(video);
      } catch (e) {
        log.warn('Document PiP failed, trying Legacy PiP fallback', e);
      }
    }

    if (PIP_FLAGS.USE_LEGACY_PIP_FALLBACK && supportsLegacyPiP(video)) {
      return await enterLegacyPiP(video);
    }

    throw new Error('PiP is not supported in this browser/context');
  }

  function getRestoreCandidates() {
    const out = [];
    const origRoot = PiPState.origParent?.getRootNode?.() || document;

    const push = (node) => {
      if (!node?.isConnected) return;
      try {
        const nodeRoot = node.getRootNode?.() || document;
        if (nodeRoot !== origRoot) return;
      } catch (_) {
        return;
      }
      out.push(node);
    };

    push(PiPState.placeholder?.parentNode);
    push(PiPState.origParent);
    push(PiPState.origContainer);

    if (typeof origRoot.querySelectorAll === 'function') {
      for (const c of origRoot.querySelectorAll(PLAYER_CONTAINER_SELECTORS)) {
        push(c);
      }
    }

    return [...new Set(out)];
  }

  function restoreFromDocumentPiP(video) {
    if (!video) { PiPState.reset(); return; }
    if (PiPState.video !== video) return;
    if (PiPState._restoring) return;

    PiPState._restoring = true;
    const wasPlaying = !video.paused;

    safe(() => getNS()?.AudioSetTarget?.(null));

    let restored = false;
    let requiresAsyncRetry = false;

    try {
      video.style.cssText = PiPState.origCss || '';

      if (PiPState.placeholder?.parentNode?.isConnected) {
        PiPState.placeholder.parentNode.insertBefore(video, PiPState.placeholder);
        PiPState.placeholder.remove();
        restored = true;
      } else {
        for (const c of getRestoreCandidates()) {
          if (!c?.isConnected) continue;
          if (c === PiPState.origParent) {
            if (PiPState.origNext && PiPState.origNext.parentNode === c) {
              c.insertBefore(video, PiPState.origNext);
            } else {
              c.appendChild(video);
            }
            restored = true;
            break;
          }
          if (!c.querySelector('video')) {
            c.appendChild(video);
            restored = true;
            break;
          }
        }
      }

      if (!restored) {
        requiresAsyncRetry = true;
        video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
        (document.body || document.documentElement)?.appendChild(video);

        let retryId = 0;
        let retryCount = 0;
        const stopRetry = () => { if (retryId) { clearInterval(retryId); retryId = 0; } };

        const retryRestore = () => {
          try {
            for (const c of getRestoreCandidates()) {
              if (c?.isConnected && !c.querySelector('video')) {
                video.style.cssText = PiPState.origCss || '';
                c.appendChild(video);
                stopRetry();
                PiPState.reset();
                safe(() => {
                  getNS()?.AudioSetTarget?.(video);
                  __vscNs.ApplyReq?.hard();
                });
                if (wasPlaying && video.paused) video.play().catch(() => {});
                return true;
              }
            }
          } catch (_) {}
          return false;
        };

        retryId = setInterval(() => {
          if (++retryCount > 10 || !video.isConnected) {
            stopRetry();
            PiPState.reset();
            safe(() => __vscNs.ApplyReq?.hard());
            return;
          }
          retryRestore();
        }, 500);
      } else {
        safe(() => {
          getNS()?.AudioSetTarget?.(video);
          __vscNs.ApplyReq?.hard();
        });
        if (wasPlaying && video.paused) video.play().catch(() => {});
      }
    } catch (e) {
      log.warn('PiP restore failed:', e);
    }

    if (!requiresAsyncRetry) {
      PiPState.reset();
    }
  }

  async function exitPiP(preferredVideo = null) {
    const target = (preferredVideo && preferredVideo === PiPState.video) ? preferredVideo : PiPState.video;

    if (PiPState.window) {
      const win = PiPState.window;

      if (win && !win.closed) {
        try { win.close(); } catch (_) {}

        waitForDocPiPClose(win, 2000).then((closed) => {
          if (closed && target && PiPState.video === target && !PiPState._restoring) {
            restoreFromDocumentPiP(target);
          }
        }).catch(() => {});

        return true;
      }

      if (target) {
        restoreFromDocumentPiP(target);
      }
      return true;
    }

    if (document.pictureInPictureElement && document.exitPictureInPicture) {
      try { await document.exitPictureInPicture(); return true; } catch (_) {}
    }
    return false;
  }

  let _pipToggleLock = false;
  async function togglePiPFor(video) {
    if (!video || video.readyState < 2 || _pipToggleLock) return false;
    _pipToggleLock = true;
    try {
      const isInDocPiP = PiPState.window && !PiPState.window.closed && PiPState.video === video;
      const isInLegacyPiP = document.pictureInPictureElement === video;

      if (isInDocPiP || isInLegacyPiP) {
        return await exitPiP(video);
      }

      if (document.pictureInPictureElement && document.exitPictureInPicture) {
        try { await document.exitPictureInPicture(); } catch (_) {}
      }

      if (PiPState.window && !PiPState.window.closed) {
        const prevWin = PiPState.window;
        try { prevWin.close(); } catch (_) {}

        const closed = await waitForDocPiPClose(prevWin, 2000);
        if (!closed) return false;
      }

      return await enterPiP(video);
    } finally {
      _pipToggleLock = false;
    }
  }

  function createTargeting() {
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;

    const isInPlayer = (vid) => {
      if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true;
      const root = vid.getRootNode();
      if (root instanceof ShadowRoot && root.host) {
        return !!root.host.closest(PLAYER_CONTAINER_SELECTORS);
      }
      return false;
    };

    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      const now = performance.now(); const vp = getViewportSnapshot();
      let best = null, bestScore = -Infinity;

      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;

        const r = getRectCached(v, now, 800);
        const area = (r?.width || 0) * (r?.height || 0);
        const pip = isPiPActiveVideo(v);
        const hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);

        if (!pip && !hasDecoded && area < 160 * 120) return;

        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;
        if (v.currentTime > 0.2) s += 2.0;
        s += Math.log2(1 + area / 20000) * 1.1;

        const ptAge = Math.max(0, now - (lastUserPt.t || 0)); const userBias = Math.exp(-ptAge / 1800);
        const dx = cx - lastUserPt.x, dy = cy - lastUserPt.y; s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500);
        const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);

        const isLikelyAd = (vid) => { const parent = vid.closest('[class*=ad],[class*=Ad],[id*=ad],[data-ad]'); if (parent) return true; if (r.width <= 400 && r.height <= 300 && vid.duration < 60) return true; return false; };
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
        if (isLikelyAd(v)) s -= 5.0; if (!v.controls && !isInPlayer(v)) s -= 1.0;
        if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
        if (pip) s += 3.0;

        if (s > bestScore) { bestScore = s; best = v; }
      };

      for (const v of videos) evalScore(v);
      const activePip = getActivePiPVideo(); if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);

      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
        if (best && stickyTarget !== best && (bestScore < stickyScore + hysteresis)) { return { target: stickyTarget }; }
      }
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000;
      return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  function createRegistry(scheduler) {
    let destroyed = false;
    const videos = new Set(), visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
    let __refreshQueued = false;
    let refreshRafId = 0;
    let rescanTimerId = 0;

    function requestRefreshCoalesced() {
      if (destroyed || __refreshQueued) return;
      __refreshQueued = true;
      refreshRafId = requestAnimationFrame(() => {
        refreshRafId = 0;
        __refreshQueued = false;
        if (destroyed) return;
        scheduler.request(false);
      });
    }

    const IO_MARGIN_PX = 200;
    const ioMargin = `${IO_MARGIN_PX}px`;
    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el);
        st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
        else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
      }
      if (changed) { rev++; requestRefreshCoalesced(); }
    }, { root: null, threshold: 0.01, rootMargin: ioMargin }) : null;

    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el);
        if (e.contentBoxSize?.[0]) { const s = e.contentBoxSize[0]; st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize }; }
        else { st.rect = e.contentRect ? el.getBoundingClientRect() : null; }
        st.rectT = now; dirty.videos.add(el); changed = true;
      }
      if (changed) requestRefreshCoalesced();
    }) : null;

    const MAX_SHADOW_OBS = 40;
    let baseRoot = null;
    let baseObserver = null;
    const shadowObserverMap = new Map();

    function disconnectBaseObserver() {
      if (!baseObserver) return;
      try { baseObserver.disconnect(); } catch (_) {}
      baseObserver = null;
    }

    function disconnectShadowObservers() {
      for (const mo of shadowObserverMap.values()) {
        try { mo.disconnect(); } catch (_) {}
      }
      shadowObserverMap.clear();
    }

    function untrackVideo(v) {
      if (!v || v.tagName !== 'VIDEO') return;
      if (videos.has(v)) videos.delete(v);
      visible.videos.delete(v);
      dirtyA.videos.delete(v);
      dirtyB.videos.delete(v);
      dirty.videos.add(v);
      safe(() => { io?.unobserve(v); ro?.unobserve(v); });
    }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0); videos.add(el);
      if (wasEmpty) { queueMicrotask(() => { safe(() => __vscNs.UIEnsure?.()); }); }
      if (io) io.observe(el); else { const st = getVState(el); st.visible = true; if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } }
      if (ro) safe(() => ro.observe(el)); lazyScanAncestorShadowRoots(el);
    };

    const WorkQ = (() => {
      let active = [], pending = [], scheduled = false;
      let activeSet = new Set(), pendingSet = new Set();
      let idleId = 0, rafId = 0, scheduleToken = 0;

      const clearScheduled = () => {
        scheduled = false; scheduleToken++;
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (idleId && typeof cancelIdleCallback === 'function') { cancelIdleCallback(idleId); idleId = 0; }
      };

      const runDrain = (dl, token) => {
        if (destroyed || token !== scheduleToken) return;
        drain(dl);
      };

      function fallbackSchedule(run) {
        if (destroyed) return;
        if (window.requestIdleCallback) {
          idleId = requestIdleCallback((dl) => { idleId = 0; run(dl); }, { timeout: 120 });
        } else {
          rafId = requestAnimationFrame(() => { rafId = 0; run(undefined); });
        }
      }

      const schedule = () => {
        if (destroyed || scheduled) return;
        scheduled = true;
        const token = ++scheduleToken;
        const run = (dl) => runDrain(dl, token);
        const schedulerApi = globalThis.scheduler;
        if (schedulerApi && typeof schedulerApi.postTask === 'function') {
          schedulerApi.postTask(() => run(undefined), { priority: 'background' }).catch(() => fallbackSchedule(run));
        } else {
          fallbackSchedule(run);
        }
      };

      const enqueue = (n) => {
        if (destroyed || !n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
        if (pendingSet.has(n) || activeSet.has(n)) return;
        pendingSet.add(n); pending.push(n);
        schedule();
      };

      const scanNode = (n) => {
        if (!n) return;
        if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; }
        if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
      };

      const drain = (dl) => {
        scheduled = false;
        [active, pending] = [pending, active];
        [activeSet, pendingSet] = [pendingSet, activeSet];
        pending.length = 0; pendingSet.clear();

        const start = performance.now(); const isInputPending = navigator.scheduling?.isInputPending?.bind(navigator.scheduling); let checkCount = 0;
        const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 && (++checkCount % 8 !== 0 || !(isInputPending?.())) : () => (performance.now() - start) < 6 && (++checkCount % 8 !== 0 || !(isInputPending?.()));

        for (let i = 0; i < active.length; i++) {
          const n = active[i]; activeSet.delete(n);
          if (!budget()) {
            for (let j = i; j < active.length; j++) {
              const rest = active[j];
              if (!pendingSet.has(rest)) { pendingSet.add(rest); pending.push(rest); }
            }
            active.length = 0; schedule(); return;
          }
          scanNode(n);
        }
        active.length = 0; activeSet.clear();
      };
      return Object.freeze({ enqueue, destroy: clearScheduled });
    })();

    function makeObserver(root, onDisconnect) {
      const mo = new MutationObserver((muts) => {
        if (root !== baseRoot && root.host && !root.host.isConnected) {
          try { mo.disconnect(); } catch (_) {}
          onDisconnect?.(); return;
        }
        let touchedVideoTree = false;
        for (const m of muts) {
          if (m.addedNodes?.length) { for (const n of m.addedNodes) { if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue; WorkQ.enqueue(n); } }
          if (m.removedNodes?.length) {
            let changed = false;
            for (const n of m.removedNodes) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'VIDEO') { untrackVideo(n); changed = true; continue; }
              const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null;
              if (list?.length) { for (let i = 0; i < list.length; i++) untrackVideo(list[i]); changed = true; }
            }
            if (changed) touchedVideoTree = true;
          }
        }
        if (touchedVideoTree) requestRefreshCoalesced();
      });
      mo.observe(root, { childList: true, subtree: true });
      return mo;
    }

    const connectObserver = (root) => {
      if (!root) return;
      const isBase = root === baseRoot;
      if (isBase) { if (baseObserver) return; baseObserver = makeObserver(root); WorkQ.enqueue(root); return; }
      if (shadowObserverMap.has(root)) return;
      if (root.host && !root.host.isConnected) return;

      if (shadowObserverMap.size >= MAX_SHADOW_OBS) {
        let evicted = false;
        for (const [sr, mo] of shadowObserverMap) {
          if (!sr.host || !sr.host.isConnected) {
            try { mo.disconnect(); } catch (_) {}
            shadowObserverMap.delete(sr);
            evicted = true;
            break;
          }
        }
        if (!evicted) {
          for (const [sr, mo] of shadowObserverMap) {
            const hasVideo = sr.querySelector?.('video');
            if (!hasVideo) {
              try { mo.disconnect(); } catch (_) {}
              shadowObserverMap.delete(sr);
              evicted = true;
              break;
            }
          }
        }
        if (!evicted) {
          const oldest = shadowObserverMap.keys().next().value;
          try { shadowObserverMap.get(oldest).disconnect(); } catch (_) {}
          shadowObserverMap.delete(oldest);
        }
      }

      const mo = makeObserver(root, () => shadowObserverMap.delete(root));
      shadowObserverMap.set(root, mo);
      WorkQ.enqueue(root);
    };

    function lazyScanAncestorShadowRoots(videoEl) {
      let node = videoEl; let depth = 0;
      while (node && depth++ < 30) { const root = node.getRootNode?.(); if (root && root !== document && root.host) { connectObserver(root); node = root.host; } else { break; } }
    }

    const refreshObservers = () => {
      disconnectBaseObserver(); disconnectShadowObservers();
      baseRoot = document.body || document.documentElement;
      if (baseRoot) { WorkQ.enqueue(baseRoot); connectObserver(baseRoot); }
    };
    refreshObservers();

    const shadowCb = (sr) => { if (sr && (sr instanceof ShadowRoot || sr.nodeType === 11)) { connectObserver(sr); } };
    __shadowRootCallbacks.add(shadowCb);
    if (__vscNs) __vscNs._shadowRootCb = shadowCb;

    function pruneDisconnectedVideos() {
      let removed = 0;
      for (const el of [...videos]) {
        if (el?.isConnected) continue;
        videos.delete(el);
        visible.videos.delete(el);
        dirtyA.videos.delete(el);
        dirtyB.videos.delete(el);
        safe(() => io?.unobserve(el));
        safe(() => ro?.unobserve(el));
        removed++;
      }
      return removed;
    }

    return {
      videos, visible, rev: () => rev, refreshObservers,
      prune: () => {
        for (const [root, mo] of [...shadowObserverMap]) {
          const host = root.host;
          if (!host || !host.isConnected) {
            try { mo.disconnect(); } catch (_) {}
            shadowObserverMap.delete(root);
            for (const v of [...videos]) {
              try { if (v.getRootNode() === root) untrackVideo(v); } catch (_) {}
            }
          }
        }
        const removed = pruneDisconnectedVideos();
        if (removed) rev++;
      },
      consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
      rescanAll: () => {
        if (destroyed) return;
        if (rescanTimerId) clearTimeout(rescanTimerId);
        rescanTimerId = setTimeout(() => {
          rescanTimerId = 0;
          if (destroyed) return;
          try {
            const base = document.documentElement || document.body; if (!base) return;
            function* walkRoots(rootBase) {
              if (!rootBase) return;
              const stack = [rootBase];
              const seen = new Set();
              while (stack.length > 0) {
                const r = stack.pop();
                if (!r || seen.has(r)) continue;
                seen.add(r);
                yield r;
                const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
                let node = walker.nextNode();
                while (node) {
                  if (node.shadowRoot) stack.push(node.shadowRoot);
                  node = walker.nextNode();
                }
              }
            }
            for (const r of walkRoots(base)) WorkQ.enqueue(r);
          } catch (_) {}
        }, 0);
      },
      destroy: () => {
        destroyed = true;
        if (refreshRafId) { cancelAnimationFrame(refreshRafId); refreshRafId = 0; }
        if (rescanTimerId) { clearTimeout(rescanTimerId); rescanTimerId = 0; }
        WorkQ.destroy();
        disconnectBaseObserver(); disconnectShadowObservers();
        try { io?.disconnect(); } catch (_) {} try { ro?.disconnect(); } catch (_) {}
        videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear();
      }
    };
  }

  let _softClipCurve = null;
  function getSoftClipCurve() {
    if (_softClipCurve) return _softClipCurve;
    const n = 1024, knee = 0.88, drive = 3.5, tanhD = Math.tanh(drive); const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x); curve[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh(drive * (ax - knee) / Math.max(1e-6, 1 - knee)) / tanhD); }
    _softClipCurve = curve; return curve;
  }
  function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); }
  const globalSrcMap = new WeakMap();

  function createStereoWidener(actx) {
    const mkBQ = (type, freq, Q = 0.707, gain) => {
      const f = actx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (Q !== undefined) f.Q.value = Q;
      if (gain !== undefined) f.gain.value = gain;
      return f;
    };

    const input = actx.createGain();
    const output = actx.createGain();
    input.gain.value = 1.0;
    output.gain.value = 1.0;

    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';

    const splitter = actx.createChannelSplitter(2);
    const merger = actx.createChannelMerger(2);

    const midL = actx.createGain();  midL.gain.value =  0.5;
    const midR = actx.createGain();  midR.gain.value =  0.5;
    const sideL = actx.createGain(); sideL.gain.value =  0.5;
    const sideR = actx.createGain(); sideR.gain.value = -0.5;

    const midBus = actx.createGain();
    const sideBus = actx.createGain();

    input.connect(splitter);

    splitter.connect(midL, 0);
    splitter.connect(sideL, 0);
    splitter.connect(midR, 1);
    splitter.connect(sideR, 1);

    midL.connect(midBus);
    midR.connect(midBus);

    sideL.connect(sideBus);
    sideR.connect(sideBus);

    const sideLow1 = mkBQ('lowpass', 160, 0.707);
    const sideLow2 = mkBQ('lowpass', 160, 0.707);

    const sideHigh = actx.createGain();
    const sideLowInv = actx.createGain();
    sideLowInv.gain.value = -1.0;

    sideBus.connect(sideHigh);
    sideBus.connect(sideLow1);
    sideLow1.connect(sideLow2);
    sideLow2.connect(sideLowInv);
    sideLowInv.connect(sideHigh);

    const sideShelf = mkBQ('highshelf', 3200, 0.707, 1.5);

    const sideAmp = actx.createGain();
    sideAmp.gain.value = 1.0;

    sideHigh.connect(sideShelf);
    sideShelf.connect(sideAmp);

    const outL = actx.createGain();
    const outR = actx.createGain();
    const sideInvR = actx.createGain();
    sideInvR.gain.value = -1.0;

    midBus.connect(outL);
    sideAmp.connect(outL);

    midBus.connect(outR);
    sideAmp.connect(sideInvR);
    sideInvR.connect(outR);

    outL.connect(merger, 0, 0);
    outR.connect(merger, 0, 1);
    merger.connect(output);

    const monoDetector = actx.createAnalyser();
    monoDetector.fftSize = 256;
    monoDetector.smoothingTimeConstant = 0.85;
    sideAmp.connect(monoDetector);
    const _monoBuffer = new Float32Array(monoDetector.fftSize);

    let _enabled = false;
    let _width = 1.25;
    let _effectiveWidth = 1.0;
    let _monoSmooth = 0;

    function isMono() {
      try {
        monoDetector.getFloatTimeDomainData(_monoBuffer);
        let sumSq = 0;
        for (let i = 0; i < _monoBuffer.length; i++) sumSq += _monoBuffer[i] * _monoBuffer[i];
        return (sumSq / _monoBuffer.length) < 1e-8;
      } catch (_) {
        return false;
      }
    }

    function setWidth(w) {
      _width = Math.max(0.85, Math.min(1.9, w));
      if (_enabled) {
        try { sideAmp.gain.setTargetAtTime(_width, actx.currentTime, 0.06); }
        catch (_) { sideAmp.gain.value = _width; }
      }
    }

    function setEnabled(en) {
      _enabled = en;
      const t = actx.currentTime;
      const target = en ? _width : 1.0;
      try { sideAmp.gain.setTargetAtTime(target, t, 0.06); }
      catch (_) { sideAmp.gain.value = target; }
      if (en && Math.abs(_width - 1.22) > 0.01) setWidth(1.22);
    }

    function update() {
      if (!_enabled) return;

      const mono = isMono();
      const monoTarget = mono ? 1.0 : 0.0;
      _monoSmooth += (monoTarget - _monoSmooth) * 0.08;

      _effectiveWidth = _width * (1.0 - _monoSmooth * 0.9) + 1.0 * (_monoSmooth * 0.9);

      try { sideAmp.gain.setTargetAtTime(_effectiveWidth, actx.currentTime, 0.10); }
      catch (_) { sideAmp.gain.value = _effectiveWidth; }
    }

    return {
      input,
      output,
      sideAmp,
      setEnabled,
      setWidth,
      update,
      isMono,
      getWidth: () => _width,
      isEnabled: () => _enabled
    };
  }

  function createAudio(sm) {
    let ctx, target = null, currentSrc = null, inputGain, dryGain, wetGain, masterOut, wetInGain, limiter, hpf, currentNodes = null;
    let makeupDbEma = 0, switchTimer = 0, switchTok = 0, gestureHooked = false, loopTok = 0, audioLoopTimerId = 0;

    let _activePauseAC = null;
    let _visResumeHooked = false;
    const _audioAC = new AbortController();
    const _audioSig = combineSignals(_audioAC.signal, __globalSig);

    function ensureVisibilityResumeHook() {
      if (_visResumeHooked) return;
      _visResumeHooked = true;

      function resumeCtxIfNeeded() {
        if (!ctx) return;
        const st = ctx.state;
        if (st === 'suspended' || st === 'interrupted') {
          ctx.resume().catch(() => {});
        }
      }

      on(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          resumeCtxIfNeeded();
        }
      }, { passive: true, signal: _audioSig });
    }

    const clamp = VSC_CLAMP;

    const stt = (param, val, t, tc = 0.08) => { if(param) { try { param.setTargetAtTime(val, t, tc); } catch (_) { param.value = val; } } };
    const mkBQ = (actx, type, freq, Q, gain) => { const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if(Q !== undefined) f.Q.value = Q; if(gain !== undefined) f.gain.value = gain; return f; };
    const mkComp = (actx, thr, knee, ratio, atk, rel) => { const c = actx.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel; return c; };

    const onGesture = async () => { try { if (ctx && ctx.state === 'suspended') await ctx.resume(); if (ctx && ctx.state === 'running' && gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } } catch (_) {} };
    const ensureGestureResumeHook = () => { if (gestureHooked) return; gestureHooked = true; on(window, 'pointerdown', onGesture, OPT_PC); on(window, 'keydown', onGesture, OPT_PC); };

    function createDynamicCinemaEQ(actx) {
      const bands = { sub: mkBQ(actx, 'lowshelf', 80, 0.8, 0), impact: mkBQ(actx, 'peaking', 55, 1.2, 0), cut: mkBQ(actx, 'peaking', 300, 0.8, 0), voice: mkBQ(actx, 'peaking', 3200, 1.2, 0), air: mkBQ(actx, 'highshelf', 10000, 0.7, 0) };
      const input = actx.createGain(), output = actx.createGain(); chain(input, bands.sub, bands.impact, bands.cut, bands.voice, bands.air, output);
      const BASE_CINEMA = { sub: 3.0, impact: 2.0, cut: -2.0, voice: 2.0, air: -0.5 };
      const PROFILES = Object.freeze({ cinema: BASE_CINEMA, cinemaWithMultiband: Object.freeze({ sub: 1.5, impact: 1.0, cut: -2.0, voice: 1.5, air: -0.25 }), neutral: Object.freeze({ sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }) });
      let activeProfile = 'cinema', staticDialogueOffset = { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 };
      const applyGains = () => { const profile = PROFILES[activeProfile] || PROFILES.neutral, t = actx.currentTime; for (const name of Object.keys(bands)) { const gain = VSC_CLAMP((profile[name] || 0) + (staticDialogueOffset[name] || 0), -12, 12); stt(bands[name].gain, gain, t, 0.08); } };
      return { input, output, bands, setProfile: (name) => { activeProfile = name; applyGains(); }, setDialogueOffset: (offset) => { if (staticDialogueOffset.voice === offset.voice) return; staticDialogueOffset = offset; applyGains(); }, setProfileAndDialogue: (profileName, dialogueOffset) => { let changed = activeProfile !== profileName; if (changed) activeProfile = profileName; if (staticDialogueOffset.sub !== dialogueOffset.sub || staticDialogueOffset.impact !== dialogueOffset.impact || staticDialogueOffset.cut !== dialogueOffset.cut || staticDialogueOffset.voice !== dialogueOffset.voice || staticDialogueOffset.air !== dialogueOffset.air) { staticDialogueOffset = dialogueOffset; changed = true; } if (changed) applyGains(); } };
    }

    function buildMultibandDynamics(actx) {
      const CROSSOVER_LOW = 200, CROSSOVER_HIGH = 3200;
      const createLR4 = (freq, type) => { const f1 = mkBQ(actx, type, freq, Math.SQRT1_2); const f2 = mkBQ(actx, type, freq, Math.SQRT1_2); f1.connect(f2); return { input: f1, output: f2 }; };
      const input = actx.createGain(), lpLow = createLR4(CROSSOVER_LOW, 'lowpass'), hpLow = createLR4(CROSSOVER_LOW, 'highpass'), lpMid = createLR4(CROSSOVER_HIGH, 'lowpass'), hpHigh = createLR4(CROSSOVER_HIGH, 'highpass');
      input.connect(lpLow.input); input.connect(hpLow.input); hpLow.output.connect(lpMid.input); hpLow.output.connect(hpHigh.input);
      const MAKEUP_LOW  = Math.pow(10, 0.3 / 20);
      const MAKEUP_MID  = Math.pow(10, 0.7 / 20);
      const MAKEUP_HIGH = Math.pow(10, 0.3 / 20);
      const compLow  = mkComp(actx, -22, 10, 2.5, 0.030, 0.50), compMid  = mkComp(actx, -18, 10, 2.0, 0.015, 0.18), compHigh = mkComp(actx, -14,  8, 1.8, 0.005, 0.10);
      const gainLow = actx.createGain();  gainLow.gain.value = MAKEUP_LOW;
      const gainMid = actx.createGain();  gainMid.gain.value = MAKEUP_MID;
      const gainHigh = actx.createGain(); gainHigh.gain.value = MAKEUP_HIGH;
      chain(lpLow.output, compLow, gainLow); chain(lpMid.output, compMid, gainMid); chain(hpHigh.output, compHigh, gainHigh);
      const output = actx.createGain(); gainLow.connect(output); gainMid.connect(output); gainHigh.connect(output);
      return { input, output, bands: { low: { comp: compLow, gain: gainLow }, mid: { comp: compMid, gain: gainMid }, high: { comp: compHigh, gain: gainHigh } } };
    }

    function createLUFSMeter(actx) {
      const preFilter = mkBQ(actx, 'highshelf', 1681, 0.7071, 4.0), hpf = mkBQ(actx, 'highpass', 38, 0.5), meterAnalyser = actx.createAnalyser();
      meterAnalyser.fftSize = 2048;
      meterAnalyser.smoothingTimeConstant = 0;
      chain(preFilter, hpf, meterAnalyser);
      const buffer = new Float32Array(meterAnalyser.fftSize);
      const M_N = 20, S_N = 150; const mMean = new Float32Array(M_N), mDt = new Float32Array(M_N); const sMean = new Float32Array(S_N), sDt = new Float32Array(S_N);
      const state = { mIdx: 0, mFill: 0, mSumW: 0, mSumDt: 0, sIdx: 0, sFill: 0, sSumW: 0, sSumDt: 0, integratedSum: 0, integratedCount: 0, momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70, _pushCount: 0 };

      function recomputeSums() {
        let mW = 0, mD = 0;
        const mLen = Math.min(state.mFill, M_N);
        for (let i = 0; i < mLen; i++) { mW += mMean[i] * mDt[i]; mD += mDt[i]; }
        state.mSumW = mW; state.mSumDt = mD;
        let sW = 0, sD = 0;
        const sLen = Math.min(state.sFill, S_N);
        for (let i = 0; i < sLen; i++) { sW += sMean[i] * sDt[i]; sD += sDt[i]; }
        state.sSumW = sW; state.sSumDt = sD;
      }

      function pushRing(meanSq, dt) {
        { const i = state.mIdx; mMean[i] = meanSq; mDt[i] = dt; state.mIdx = (i + 1) % M_N; state.mFill = Math.min(M_N, state.mFill + 1); }
        { const i = state.sIdx; sMean[i] = meanSq; sDt[i] = dt; state.sIdx = (i + 1) % S_N; state.sFill = Math.min(S_N, state.sFill + 1); }
        recomputeSums();
      }

      function measure() {
        const dt = meterAnalyser.fftSize / (actx.sampleRate || 48000); meterAnalyser.getFloatTimeDomainData(buffer);
        let sumSq = 0; for (let i = 0; i < buffer.length; i++) sumSq += buffer[i] * buffer[i]; const meanSq = sumSq / buffer.length;
        pushRing(meanSq, dt);
        const mMeanSq = state.mSumDt > 0 ? state.mSumW / state.mSumDt : 0; const sMeanSq = state.sSumDt > 0 ? state.sSumW / state.sSumDt : 0;
        state.momentaryLUFS = mMeanSq > 1e-10 ? -0.691 + 10 * Math.log10(mMeanSq) : -70; state.shortTermLUFS = sMeanSq > 1e-10 ? -0.691 + 10 * Math.log10(sMeanSq) : -70;
        if (state.momentaryLUFS > -70 && state.momentaryLUFS > state.integratedLUFS - 10) { state.integratedSum += meanSq; state.integratedCount++; const intMean = state.integratedSum / state.integratedCount; state.integratedLUFS = intMean > 1e-10 ? -0.691 + 10 * Math.log10(intMean) : -70; }
      }

      return {
        input: preFilter, measure,
        reset: () => { mMean.fill(0); mDt.fill(0); sMean.fill(0); sDt.fill(0); Object.assign(state, { mIdx:0, mFill:0, mSumW:0, mSumDt:0, sIdx:0, sFill:0, sSumW:0, sSumDt:0, integratedSum:0, integratedCount:0, momentaryLUFS:-70, shortTermLUFS:-70, integratedLUFS:-70, _pushCount:0 }); },
        getState: (out) => { if (!out) return { momentaryLUFS: state.momentaryLUFS, shortTermLUFS: state.shortTermLUFS, integratedLUFS: state.integratedLUFS }; out.momentaryLUFS = state.momentaryLUFS; out.shortTermLUFS = state.shortTermLUFS; out.integratedLUFS = state.integratedLUFS; return out; }
      };
    }

    function createLoudnessNormalizer(actx, lufsMeter) {
      const TARGET_LUFS = -14, MAX_GAIN_DB = 6, MIN_GAIN_DB = -6, SMOOTHING = 0.05, SETTLE_FRAMES = 30;
      const ATTACK_TC = 0.8, RELEASE_TC = 2.5;
      const gainNode = actx.createGain(); gainNode.gain.value = 1.0; let frameCount = 0, currentGainDb = 0;
      let _lastUpdateTime = 0;
      const _tmp = { momentaryLUFS:-70, shortTermLUFS:-70, integratedLUFS:-70 };
      function update() {
        const lufs = lufsMeter.getState(_tmp); frameCount++; if (frameCount < SETTLE_FRAMES) return;
        const measured = lufs.shortTermLUFS; if (measured <= -60) return;
        const targetGainDb = VSC_CLAMP(TARGET_LUFS - measured, MIN_GAIN_DB, MAX_GAIN_DB);
        const now = actx.currentTime;
        const dt = Math.max(0.01, Math.min(1.0, now - (_lastUpdateTime || now)));
        _lastUpdateTime = now;
        const tc = targetGainDb < currentGainDb ? ATTACK_TC : RELEASE_TC;
        const alpha = 1.0 - Math.exp(-dt / tc);
        currentGainDb += (targetGainDb - currentGainDb) * alpha;
        const linearGain = Math.pow(10, currentGainDb / 20); stt(gainNode.gain, linearGain, now, SMOOTHING);
      }
      return { node: gainNode, update, reset: () => { frameCount = 0; currentGainDb = 0; gainNode.gain.value = 1.0; _lastUpdateTime = 0; lufsMeter.reset(); } };
    }

    function createDialogueBoostProfile() {
      const PROFILES = Object.freeze({ off: { sub: 0, impact: 0, cut: 0, voice: 0, air: 0 }, dialogueBoost: { sub: -1.5, impact: -0.5, cut: -2.0, voice: 1.5, air: 0.5 } });
      return { getProfile(enabled) { return enabled ? PROFILES.dialogueBoost : PROFILES.off; } };
    }

    function buildAudioGraph(audioCtx) {
      const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), hpf: mkBQ(audioCtx, 'highpass', 35, 0.707), limiter: mkComp(audioCtx, -1.0, 0.0, 20.0, 0.001, 0.08), clipper: audioCtx.createWaveShaper() };
      n.clipper.curve = getSoftClipCurve(); try { n.clipper.oversample = '2x'; } catch (_) {}
      const dynamicEQ = createDynamicCinemaEQ(audioCtx), multiband = buildMultibandDynamics(audioCtx);
      const stereoWidener = createStereoWidener(audioCtx);
      const lufsMeter = createLUFSMeter(audioCtx), loudnessNorm = createLoudnessNormalizer(audioCtx, lufsMeter);
      n._dialogueProfile = createDialogueBoostProfile(); n.wetInGain = loudnessNorm.node;
      n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
      chain(n.inputGain, n.hpf, dynamicEQ.input); chain(dynamicEQ.output, multiband.input);
      multiband.output.connect(lufsMeter.input);
      chain(multiband.output, stereoWidener.input);
      chain(stereoWidener.output, n.wetInGain);
      chain(n.wetInGain, n.clipper, n.limiter); chain(n.limiter, n.wetGain, n.masterOut);
      n.masterOut.connect(audioCtx.destination);
      n._dynamicEQ = dynamicEQ; n._multiband = multiband; n._stereoWidener = stereoWidener; n._lufsMeter = lufsMeter; n._loudnessNorm = loudnessNorm; return n;
    }

    const ensureCtx = () => {
      if (ctx) {
        if (ctx.state !== 'closed') return true;
        if (currentSrc) {
          safe(() => currentSrc.disconnect());
          if (target) globalSrcMap.delete(target);
        }
        currentSrc = null; target = null; currentNodes = null;
        ctx = null;
      }

      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;

      try { ctx = new AC({ latencyHint: 'balanced', sampleRate: 48000 }); }
      catch (_) {
        try { ctx = new AC({ latencyHint: 'balanced' }); }
        catch (__) { try { ctx = new AC(); } catch (___) { return false; } }
      }

      if (!ctx || typeof ctx.createMediaElementSource !== 'function') {
        try { ctx?.close?.(); } catch (_) {}
        ctx = null; return false;
      }

      currentSrc = null; target = null; ensureGestureResumeHook();
      ensureVisibilityResumeHook();
      const nodes = buildAudioGraph(ctx);
      inputGain = nodes.inputGain; dryGain = nodes.dryGain; wetGain = nodes.wetGain;
      masterOut = nodes.masterOut; wetInGain = nodes.wetInGain; limiter = nodes.limiter;
      hpf = nodes.hpf; currentNodes = nodes;
      return true;
    };

    function detachCurrentSource() {
      if (currentSrc) {
        safe(() => currentSrc.disconnect());
      }
      currentSrc = null;
      target = null;
    }

    function disposeSourceForVideo(video) {
      if (!video) return;
      const src = globalSrcMap.get(video);
      if (src) {
        safe(() => src.disconnect());
        globalSrcMap.delete(video);
      }
      if (target === video) {
        currentSrc = null;
        target = null;
      }
    }

    const _lufsTmp = { momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };

    function runAudioLoop(tok) {
      audioLoopTimerId = 0; if (tok !== loopTok || !ctx) return;
      const dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)); if (!dynAct) return;
      const actuallyEnabled = dynAct && currentSrc;

      if (currentSrc && currentNodes) {
        const mbActive = !!sm.get(P.A_MULTIBAND);
        const needMeter = !!sm.get(P.A_LUFS) || mbActive || !!sm.get(P.A_DIALOGUE);
        if (needMeter && currentNodes._lufsMeter && actuallyEnabled && ctx.state === 'running') {
          try { currentNodes._lufsMeter.measure(); } catch (e) { log.debug('LUFS measure failed', e); }
        }

        const lufsSt = currentNodes._lufsMeter.getState(_lufsTmp);
        const db = lufsSt.momentaryLUFS > -70 ? lufsSt.momentaryLUFS : -100;

        if (currentNodes._dynamicEQ && currentNodes._multiband) {
          const dialogueOn = !!sm.get(P.A_DIALOGUE); const profile = currentNodes._dialogueProfile.getProfile(dialogueOn); const t = ctx.currentTime;
          currentNodes._dynamicEQ.setProfileAndDialogue(mbActive ? 'cinemaWithMultiband' : 'cinema', profile);
          const mb = currentNodes._multiband.bands;
          if (dialogueOn) { stt(mb.mid.gain.gain, 1.15, t, 0.08); stt(mb.low.gain.gain, 0.92, t, 0.08); stt(mb.high.gain.gain, 1.05, t, 0.08); } else { stt(mb.low.gain.gain, 1.0, t, 0.15); stt(mb.mid.gain.gain, 1.0, t, 0.15); stt(mb.high.gain.gain, 1.0, t, 0.15); }
        } else if (currentNodes._dynamicEQ) { currentNodes._dynamicEQ.setProfile(mbActive ? 'cinemaWithMultiband' : 'cinema'); }

        if (currentNodes._loudnessNorm && !!sm.get(P.A_LUFS) && actuallyEnabled) {
          currentNodes._loudnessNorm.update();
        }

        if (currentNodes._stereoWidener) {
          const swEnabled = !!sm.get(P.A_STEREO_W) && dynAct;
          if (currentNodes._stereoWidener.isEnabled() !== swEnabled) {
            currentNodes._stereoWidener.setEnabled(swEnabled);
          }
          if (swEnabled) {
            currentNodes._stereoWidener.update();
          }
          if (swEnabled) {
            stt(currentNodes.limiter.threshold, -1.5, ctx.currentTime, 0.08);
          } else {
            stt(currentNodes.limiter.threshold, -1.0, ctx.currentTime, 0.08);
          }
        }

        if (actuallyEnabled) {
          let redDb = 0;
          if (mbActive && currentNodes._multiband) {
            const rl = Math.abs(Number(currentNodes._multiband.bands.low.comp.reduction) || 0), rm = Math.abs(Number(currentNodes._multiband.bands.mid.comp.reduction) || 0), rh = Math.abs(Number(currentNodes._multiband.bands.high.comp.reduction) || 0);
            redDb = -(rl * 0.25 + rm * 0.50 + rh * 0.25);
          } else if (currentNodes.limiter) { const r = currentNodes.limiter.reduction; redDb = (typeof r === 'number') ? r : (r?.value ?? 0); }
          if (!Number.isFinite(redDb)) redDb = 0;
          const redPos = clamp(-redDb, 0, 15);
          const stLufs = lufsSt.shortTermLUFS, intLufs = lufsSt.integratedLUFS;
          let gateMult = 1.0; if (intLufs <= -65) gateMult = 0.0; else if (stLufs < -50) gateMult = 0.0; else if (stLufs < -40) gateMult = clamp((stLufs + 50) / 10.0, 0, 1);
          const makeupDbTarget = clamp(redPos * 0.30, 0, 3.5) * gateMult;
          const alpha = makeupDbTarget > makeupDbEma ? 0.08 : 0.15; makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
        } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }
      }
      const userBoost = Math.pow(10, Number(sm.get(P.A_BST) || 0) / 20), makeup = Math.pow(10, makeupDbEma / 20);
      if (wetInGain) { const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0; stt(wetInGain.gain, finalGain, ctx.currentTime, 0.02); }

      const isPaused = target && (target.paused || target.ended);
      if (document.hidden) { audioLoopTimerId = setTimeout(() => runAudioLoop(tok), 500); }
      else if (isPaused) {
        if (target && !target.ended) {
          const currentTarget = target;
          const pauseAC = new AbortController();
          _activePauseAC = pauseAC;
          const pauseSig = pauseAC.signal;

          const myFallbackId = setTimeout(() => {
            pauseAC.abort();
            if (audioLoopTimerId === myFallbackId) audioLoopTimerId = 0;
            if (tok === loopTok) runAudioLoop(tok);
          }, 30000);
          audioLoopTimerId = myFallbackId;

          const resume = () => {
            pauseAC.abort();
            clearTimeout(myFallbackId);
            if (audioLoopTimerId === myFallbackId) audioLoopTimerId = 0;
            if (tok === loopTok) runAudioLoop(tok);
          };
          currentTarget.addEventListener('play', resume, { once: true, signal: pauseSig });
          currentTarget.addEventListener('seeked', resume, { once: true, signal: pauseSig });
        }
      } else {
        const needFast = !!sm.get(P.A_LUFS) || !!sm.get(P.A_MULTIBAND) || !!sm.get(P.A_DIALOGUE) || !!sm.get(P.A_STEREO_W);
        const targetInterval = needFast ? 0.10 : 0.25;
        const delayMs = Math.max(16, (targetInterval * 1000) - 8);
        audioLoopTimerId = setTimeout(() => {
          audioLoopTimerId = 0;
          if (tok === loopTok) runAudioLoop(tok);
        }, delayMs);
      }
    }

    const updateMix = () => {
      if (!ctx) return; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
      if (_activePauseAC) { _activePauseAC.abort(); _activePauseAC = null; }
      const tok = ++loopTok, dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT)), isHooked = !!currentSrc;
      const wetTarget = (dynAct && isHooked) ? 1 : 0, dryTarget = 1 - wetTarget;
      stt(dryGain.gain, dryTarget, ctx.currentTime, 0.005); stt(wetGain.gain, wetTarget, ctx.currentTime, 0.005);
      if (currentNodes) {
        const mbEnabled = dynAct && !!sm.get(P.A_MULTIBAND);
        if (currentNodes._multiband) {
          const mb = currentNodes._multiband.bands, t = ctx.currentTime;
          if (mbEnabled) {
            stt(mb.low.comp.ratio, 2.5, t, 0.02); stt(mb.mid.comp.ratio, 2.2, t, 0.02); stt(mb.high.comp.ratio, 1.8, t, 0.02);
          } else {
            stt(mb.low.comp.ratio, 1.0, t, 0.05); stt(mb.mid.comp.ratio, 1.0, t, 0.05); stt(mb.high.comp.ratio, 1.0, t, 0.05);
            stt(mb.low.gain.gain, 1.0, t, 0.05); stt(mb.mid.gain.gain, 1.0, t, 0.05); stt(mb.high.gain.gain, 1.0, t, 0.05);
          }
        }
        if (currentNodes._loudnessNorm && (!sm.get(P.A_LUFS) || !dynAct)) {
          stt(currentNodes._loudnessNorm.node.gain, 1.0, ctx.currentTime, 0.05); currentNodes._loudnessNorm.reset();
        }
        if (currentNodes._stereoWidener && !dynAct) {
          currentNodes._stereoWidener.setEnabled(false);
        }
      }
      if (dynAct && isHooked) runAudioLoop(tok);
    };

    async function destroy() {
      try { _audioAC.abort(); } catch (_) {}
      _visResumeHooked = false;
      loopTok++; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
      if (_activePauseAC) { _activePauseAC.abort(); _activePauseAC = null; }

      const prevTarget = target;
      detachCurrentSource();
      if (prevTarget) {
        disposeSourceForVideo(prevTarget);
      }

      safe(() => { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } });
      try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
      ctx = null; currentNodes = null; limiter = null; wetInGain = null; inputGain = null; dryGain = null; wetGain = null; masterOut = null; hpf = null; makeupDbEma = 0; switchTok++;
    }

    return {
      warmup: () => { if (!ensureCtx()) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },

      setTarget: (v) => {
        ++switchTok;

        if (v == null) {
          if (!ctx) return;
          detachCurrentSource();
          updateMix();
          return;
        }

        const st = getVState(v);

        if (st && st.audioFailUntil > performance.now()) {
          detachCurrentSource();
          updateMix();
          return;
        }

        if (!ensureCtx()) return;

        if (v === target && currentSrc) {
          updateMix();
          return;
        }

        const connectWithFallback = (vid) => {
          if (!vid) return;

          let s = globalSrcMap.get(vid);
          let reusable = false;

          if (s) {
            try {
              reusable = (s.context === ctx && s.context.state !== 'closed');
            } catch (_) {}
            if (!reusable) {
              try { s.disconnect(); } catch (_) {}
              globalSrcMap.delete(vid);
              s = null;
            }
          }

          if (!s) {
            try {
              s = ctx.createMediaElementSource(vid);
              globalSrcMap.set(vid, s);
            } catch (e) {
              st.audioFailUntil = performance.now() + 10000;
              detachCurrentSource();
              updateMix();
              return;
            }
          }

          try { s.disconnect(); } catch (_) {}
          s.connect(inputGain);
          currentSrc = s;
          target = vid;
          updateMix();
        };

        if (target !== null && target !== v) {
          detachCurrentSource();
          connectWithFallback(v);
        } else if (!currentSrc) {
          connectWithFallback(v);
        } else {
          updateMix();
        }
      },
      update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy
    };
  }

  function createAutoSceneManager(Store, P, Scheduler) {
    const AUTO = { cur: { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 } };
    const AUTO_PRESETS = Object.freeze({
      Soft:   { br: 1.15, ct: 1.02, sat: 1.00, sharpScale: 1.05 },
      Normal: { br: 1.25, ct: 1.04, sat: 1.00, sharpScale: 1.10 },
      Strong: { br: 1.35, ct: 1.06, sat: 1.00, sharpScale: 1.15 }
    });

    function update() {
      const act = !!Store.get(P.APP_ACT);
      const en  = act && !!Store.get(P.APP_AUTO_SCENE);
      if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; }
      else { const k = Store.get(P.APP_AUTO_SCENE_PRESET) || 'Normal'; AUTO.cur = { ...(AUTO_PRESETS[k] || AUTO_PRESETS.Normal) }; }
      if (act) Scheduler.request(true);
    }

    const unsubs = [ Store.sub(P.APP_AUTO_SCENE, update), Store.sub(P.APP_AUTO_SCENE_PRESET, update), Store.sub(P.APP_ACT, update) ];

    return {
      getMods: () => AUTO.cur, start: update,
      stop: () => { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; Scheduler.request(true); },
      destroy: () => { unsubs.forEach(u => safe(u)); AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, sharpScale: 1.0 }; }
    };
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp } = Utils;
    const clamp01 = (x) => (x < 0 ? 0 : (x > 1 ? 1 : x));

    function createLRU(max = 192) {
      const m = new Map();
      return {
        get: (k) => {
          const v = m.get(k);
          if (v !== undefined) {
            m.delete(k); m.set(k, v);
          }
          return v;
        },
        set(k, v) {
          if (m.has(k)) m.delete(k);
          m.set(k, v);
          if (m.size > max) m.delete(m.keys().next().value);
        }
      };
    }

    const urlCache      = new WeakMap();
    const ctxMap        = new WeakMap();
    const toneCache     = createLRU(96);
    const haloCache     = createLRU(48);
    const edgeMaskCache = createLRU(48);
    const _attrCache    = new WeakMap();
    const __vscBgMemo   = new WeakMap();

    function setAttr(node, attr, val) {
      if (!node) return;
      let c = _attrCache.get(node);
      if (!c) { c = Object.create(null); _attrCache.set(node, c); }
      if (typeof val === 'number') {
        if (typeof c[attr] === 'number' && Math.abs(c[attr] - val) < 1e-7) return;
        c[attr] = val;
        node.setAttribute(attr, String(val));
        return;
      }
      const strVal = val == null ? '' : String(val);
      if (c[attr] === strVal) return;
      c[attr] = strVal;
      node.setAttribute(attr, strVal);
    }

    function ensureOpaqueBg(video) {
      if (!video || __vscBgMemo.has(video) || !getFLAGS()?.FILTER_FORCE_OPAQUE_BG) return;
      try {
        const cs = getComputedStyle(video).backgroundColor;
        if (cs === 'transparent' || cs === 'rgba(0, 0, 0, 0)' || cs === 'rgba(0,0,0,0)') {
          __vscBgMemo.set(video, video.style.backgroundColor || '');
          video.style.backgroundColor = '#000';
        } else {
          __vscBgMemo.set(video, null);
        }
      } catch (_) {}
    }

    function restoreOpaqueBg(video) {
      if (!video) return;
      const prev = __vscBgMemo.get(video);
      if (prev === undefined) return;
      __vscBgMemo.delete(video);
      if (prev !== null) video.style.backgroundColor = prev;
    }

    const HALO_TABLE_SIZE = 64;
    function buildHaloTable(strength) {
      if (strength < 0.005) return '0 1';
      const qStrength = Math.round(strength * 100) / 100;
      const cacheKey = `hv3|${qStrength}`;
      const cached = haloCache.get(cacheKey);
      if (cached) return cached;

      const arr = new Array(HALO_TABLE_SIZE);
      const knee = Math.max(0.005, qStrength * 0.05);

      for (let i = 0; i < HALO_TABLE_SIZE; i++) {
        const x = i / (HALO_TABLE_SIZE - 1);
        let y = x;
        if (x < knee) {
          const t = x / knee;
          y = knee * t * t;
        } else if (x > 1 - knee) {
          const t = (1 - x) / knee;
          y = 1 - knee * t * t;
        }
        arr[i] = Math.round(VSC_CLAMP(y, 0, 1) * 10000) / 10000;
      }

      const result = arr.join(' ');
      haloCache.set(cacheKey, result);
      return result;
    }

    const EDGE_MASK_SIZE = 64;
    function buildEdgeMaskTable(sensitivity, threshold) {
      if (sensitivity < 0.01) return '1 1';
      const qSens = Math.round(sensitivity * 100) / 100;
      const qThr  = Math.round(threshold * 1000) / 1000;
      const cacheKey = `em|${qSens}|${qThr}`;
      const cached = edgeMaskCache.get(cacheKey);
      if (cached) return cached;

      const arr = new Array(EDGE_MASK_SIZE);
      for (let i = 0; i < EDGE_MASK_SIZE; i++) {
        const x = i / (EDGE_MASK_SIZE - 1);
        const dist = Math.abs(x - 0.5) * 2;
        const t = Math.max(0, dist - qThr) / Math.max(1e-6, 1 - qThr);
        const scaled = Math.min(1, t * qSens);
        const y = scaled * scaled * (3 - 2 * scaled);
        arr[i] = Math.round(y * 10000) / 10000;
      }

      const result = arr.join(' ');
      edgeMaskCache.set(cacheKey, result);
      return result;
    }

    const makeKeyBase = (s) => [
      Math.round(s.gain / 0.04),     Math.round(s.gamma / 0.01),
      Math.round(s.contrast / 0.01), Math.round(s.bright / 0.2),
      Math.round(s.satF / 0.01),     Math.round(s.mid / 0.02),
      Math.round(s.toe / 0.2),       Math.round(s.shoulder / 0.2),
      Math.round(s.temp / 0.2),      Math.round(s.sharp),
      Math.round(s.sharp2),          Math.round(s.clarity),
      Math.round((s._sigmaScale || 1) * 100)
    ].join('|');

    function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
      const key = `${steps}|${toeN}|${shoulderN}|${midN}|${gain}`;
      const hit = toneCache.get(key);
      if (hit) return hit;

      if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) {
        toneCache.set(key, '0 1');
        return '0 1';
      }

      const arr = new Array(steps);
      const g = Math.log2(Math.max(1e-6, gain)) * 0.90;
      const denom = Math.abs(g) > 1e-6 ? (1 - Math.exp(-g)) : 0;
      const useExp = Math.abs(denom) > 1e-6;
      const toeEnd = 0.10 + Math.abs(toeN) * 0.06;
      const toeAmt = Math.abs(toeN);
      const toeSign = toeN >= 0 ? 1 : -1;
      const shoulderStart = 0.90 - shoulderN * 0.10;
      const shAmt = Math.abs(shoulderN);
      let prev = 0;

      for (let i = 0; i < steps; i++) {
        const x0 = i / (steps - 1);
        let x = useExp ? (1 - Math.exp(-g * x0)) / denom : x0;
        x = clamp(x + midN * 0.06 * (4 * x * (1 - x)), 0, 1);
        if (toeAmt > 1e-6) {
          const u = clamp((x - 0) / Math.max(1e-6, toeEnd - 0), 0, 1);
          const smooth = u * u * (3 - 2 * u);
          const w = 1 - smooth;
          x = clamp(x + toeSign * toeAmt * 10.0 * ((toeEnd - x) * w * w), 0, 1);
        }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, 1 - shoulderStart);
          const kk = Math.max(0.7, 1.2 + shAmt * 6.5);
          const shDen = 1 - Math.exp(-kk);
          const shMap = Math.abs(shDen) > 1e-6 ? (1 - Math.exp(-kk * tt)) / shDen : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        if (x <= prev) {
          x = prev + Math.min(1e-5, Math.max(0, (1.0 - prev) * 0.5));
        }
        if (x > 1.0) x = 1.0;
        prev = x;
        const y = Math.round(x * 100000) / 100000;
        arr[i] = y === 1 ? '1' : (y === 0 ? '0' : String(y));
      }

      const res = arr.join(' ');
      toneCache.set(key, res);
      return res;
    }

    function buildSvg(root) {
      const fidLite   = `vsc-lite-${config.VSC_ID}`;
      const fidSharp  = `vsc-sharp-${config.VSC_ID}`;
      const fidShadow = `vsc-shadow-${config.VSC_ID}`;

      const svg  = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' });
      const defs = h('defs', { ns: 'svg' });
      svg.append(defs);

      const mkFuncRGB = (attrs) => ['R', 'G', 'B'].map(c => h(`feFunc${c}`, { ns: 'svg', ...attrs }));

      const mkColorChain = (prefix, inN) => {
        const toneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
        const toneXfer  = h('feComponentTransfer', { ns: 'svg', in: inN,            result: `${prefix}_t` }, ...toneFuncs);
        const bcFuncs   = mkFuncRGB({ type: 'linear', slope: '1', intercept: '0' });
        const bcXfer    = h('feComponentTransfer', { ns: 'svg', in: `${prefix}_t`, result: `${prefix}_b` }, ...bcFuncs);
        const gamFuncs  = mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' });
        const gamXfer   = h('feComponentTransfer', { ns: 'svg', in: `${prefix}_b`, result: `${prefix}_g` }, ...gamFuncs);
        return { nodes: [toneXfer, bcXfer, gamXfer], toneFuncs, bcFuncs, gamFuncs };
      };

      const mkTempSat = (prefix, inN) => {
        const tempR    = h('feFuncR', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const tempG    = h('feFuncG', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const tempB    = h('feFuncB', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
        const tempXfer = h('feComponentTransfer', { ns: 'svg', in: inN,              result: `${prefix}_tm` }, tempR, tempG, tempB);
        const satNode  = h('feColorMatrix',        { ns: 'svg', in: `${prefix}_tm`, type: 'saturate', values: '1', result: `${prefix}_s` });
        return { nodes: [tempXfer, satNode], tempR, tempG, tempB, satNode };
      };

      const liteFilter = h('filter', {
        ns: 'svg', id: fidLite,
        'color-interpolation-filters': 'sRGB',
        x: '-1%', y: '-1%', width: '102%', height: '102%'
      });
      const liteCC = mkColorChain('l', 'SourceGraphic');
      const liteTS = mkTempSat('l', 'l_g');
      liteFilter.append(...liteCC.nodes, ...liteTS.nodes);

      const shadowFilter = h('filter', {
        ns: 'svg', id: fidShadow,
        'color-interpolation-filters': 'sRGB',
        x: '-1%', y: '-1%', width: '102%', height: '102%'
      });

      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const shadowToneXfer = h('feComponentTransfer', {
        ns: 'svg', in: 'SourceGraphic', result: 'sh_tone'
      }, ...shadowToneFuncs);

      const shadowBcFuncs = mkFuncRGB({ type: 'linear', slope: '1', intercept: '0' });
      const shadowBcXfer = h('feComponentTransfer', {
        ns: 'svg', in: 'sh_tone', result: 'sh_bc'
      }, ...shadowBcFuncs);

      const shadowGamFuncs = mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' });
      const shadowGamXfer = h('feComponentTransfer', {
        ns: 'svg', in: 'sh_bc', result: 'sh_gam'
      }, ...shadowGamFuncs);

      shadowFilter.append(shadowToneXfer, shadowBcXfer, shadowGamXfer);

      const MAT_Y  = '0.2126 0.7152 0.0722 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0';
      const MAT_UV = '0 0 0 0 0  -0.1146 -0.3854 0.5 0 0.5  0.5 -0.4542 -0.0458 0 0.5  0 0 0 1 0';
      const MAT_RGB = '1 0 1.5748 0 -0.7874  1 -0.1873 -0.4681 0 0.3277  1 1.8556 0 0 -0.9278  0 0 0 1 0';

      const sharpFilter = h('filter', {
        ns: 'svg', id: fidSharp,
        'color-interpolation-filters': 'sRGB',
        x: '-8%', y: '-8%', width: '116%', height: '116%'
      });

      const sOpaque = h('feComponentTransfer', { ns: 'svg', in: 'SourceGraphic', result: 's_opaque' },
        h('feFuncA', { ns: 'svg', type: 'linear', slope: '0', intercept: '1' })
      );

      const sLuma = h('feColorMatrix', {
        ns: 'svg', in: 's_opaque', type: 'matrix', values: MAT_Y, result: 's_Y'
      });
      const sChroma = h('feColorMatrix', {
        ns: 'svg', in: 's_opaque', type: 'matrix', values: MAT_UV, result: 's_CbCr'
      });

      const sBlurFine = h('feGaussianBlur', {
        ns: 'svg', in: 's_Y', stdDeviation: '0.6',
        edgeMode: 'duplicate', result: 's_bFine'
      });
      const sBlurClarity = h('feGaussianBlur', {
        ns: 'svg', in: 's_Y', stdDeviation: '8',
        edgeMode: 'duplicate', result: 's_bClarity'
      });

      const sDetailBiased = h('feComposite', {
        ns: 'svg', in: 's_Y', in2: 's_bFine',
        operator: 'arithmetic', k1: '0', k2: '0.5', k3: '-0.5', k4: '0.5',
        result: 's_det'
      });

      const sEdgeFuncs = mkFuncRGB({ type: 'table', tableValues: '1 1' });
      const sEdgeMask = h('feComponentTransfer', {
        ns: 'svg', in: 's_det', result: 's_emask'
      }, ...sEdgeFuncs);

      const sModDetail = h('feComposite', {
        ns: 'svg', in: 's_det', in2: 's_emask',
        operator: 'arithmetic', k1: '1', k2: '0', k3: '-0.5', k4: '0.5',
        result: 's_mdet'
      });

      const sYFineUSM = h('feComposite', {
        ns: 'svg', in: 's_Y', in2: 's_mdet',
        operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0',
        result: 's_Yfine_raw'
      });

      const sHaloFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const sHaloSuppress = h('feComponentTransfer', {
        ns: 'svg', in: 's_Yfine_raw', result: 's_Yfine'
      }, ...sHaloFuncs);

      const sMidDetail = h('feComposite', {
        ns: 'svg', in: 's_bFine', in2: 's_bClarity',
        operator: 'arithmetic',
        k1: '0', k2: '0.5', k3: '-0.5', k4: '0.5', // 0.5 중심으로 인코딩
        result: 's_mid'
      });

      const sClarityAdd = h('feComposite', {
        ns: 'svg', in: 's_Yfine', in2: 's_mid',
        operator: 'arithmetic',
        k1: '0', k2: '1', k3: '0', k4: '0', // k3, k4는 아래에서 동적 할당
        result: 's_Ysharp'
      });

      const sRecombine = h('feComposite', {
        ns: 'svg', in: 's_Ysharp', in2: 's_CbCr',
        operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0',
        result: 's_YUV'
      });
      const sToRGB = h('feColorMatrix', {
        ns: 'svg', in: 's_YUV', type: 'matrix', values: MAT_RGB, result: 's_sharp_rgb'
      });

      const sharpCC = mkColorChain('s', 's_sharp_rgb');
      const sharpTS = mkTempSat('s', 's_g');

      const sRestoreAlpha = h('feComposite', {
        ns: 'svg', in: 's_s', in2: 'SourceGraphic',
        operator: 'in', result: 's_final'
      });

      sharpFilter.append(
        sOpaque,
        sLuma, sChroma,
        sBlurFine, sBlurClarity,
        sDetailBiased,
        sEdgeMask,
        sModDetail,
        sYFineUSM,
        sHaloSuppress,
        sMidDetail,
        sClarityAdd,
        sRecombine, sToRGB,
        ...sharpCC.nodes,
        ...sharpTS.nodes,
        sRestoreAlpha
      );

      defs.append(liteFilter, shadowFilter, sharpFilter);

      const tryAppend = () => {
        const target = root.body || root.documentElement || root;
        if (target?.appendChild) { target.appendChild(svg); return true; }
        return false;
      };
      if (!tryAppend()) {
        let _fallbackMoId = 0;
        const mo = new MutationObserver(() => {
          if (tryAppend()) { mo.disconnect(); clearTimeout(_fallbackMoId); }
        });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        _fallbackMoId = setTimeout(() => mo.disconnect(), 5000);
        if (typeof __vscNs !== 'undefined' && __vscNs._timers) __vscNs._timers.push(_fallbackMoId);
        if (typeof __globalSig !== 'undefined') {
          __globalSig.addEventListener('abort', () => { clearTimeout(_fallbackMoId); mo.disconnect(); }, { once: true });
        }
      }

      const commonByTier = {
        lite: {
          toneFuncs: liteCC.toneFuncs, bcLinFuncs: liteCC.bcFuncs, gamFuncs: liteCC.gamFuncs,
          tmp: { r: liteTS.tempR, g: liteTS.tempG, b: liteTS.tempB }, sats: [liteTS.satNode]
        },
        sharp: {
          toneFuncs: sharpCC.toneFuncs, bcLinFuncs: sharpCC.bcFuncs, gamFuncs: sharpCC.gamFuncs,
          tmp: { r: sharpTS.tempR, g: sharpTS.tempG, b: sharpTS.tempB }, sats: [sharpTS.satNode]
        }
      };

      const sharpDetail = {
        blurFine: sBlurFine, blurClarity: sBlurClarity,
        fineUSM: sYFineUSM, haloFuncs: sHaloFuncs,
        clarityAdd: sClarityAdd, edgeFuncs: sEdgeFuncs
      };

      const shadowNodes = {
        toneFuncs: shadowToneFuncs,
        bcFuncs:   shadowBcFuncs,
        gamFuncs:  shadowGamFuncs
      };

      return {
        fidLite, fidSharp, fidShadow,
        commonByTier, sharpDetail, shadowNodes,
        st: {
          lastKey: '', rev: 0,
          commonTier: {
            lite:  { toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '' },
            sharp: { toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '' }
          },
          blurKey: '', sharpKey: '', haloKey: '', lcKey: '', emKey: '',
          shadowKey: ''
        }
      };
    }

    function applySharpParams(sharpDetail, st, s) {
      const qSharp   = Math.round(Number(s.sharp    || 0));
      const qSharp2  = Math.round(Number(s.sharp2  || 0));
      const qClarity = Math.round(Number(s.clarity || 0));
      const sigmaScale = Number(s._sigmaScale) || 1.0;

      const aFine   = Math.max(0, qSharp / 35);
      const sigFine = VSC_CLAMP((0.3 + qSharp2 / 24) * sigmaScale, 0, 3.5);
      const lcBase     = clamp01(qClarity / 60);
      const aClarity   = lcBase * 0.28;
      const sigClarity = VSC_CLAMP((6 + lcBase * 12) * sigmaScale, 0, 22);
      const haloStrength = VSC_CLAMP(aFine * 0.51, 0, 0.35);

      const sensAdj = sigmaScale > 1.2 ? 0.85 : 1.0;
      const adaptSens      = VSC_CLAMP((2.5 + aFine * 1.8) * sensAdj, 0, 6);
      const adaptThreshold = VSC_CLAMP(0.06 - aFine * 0.008, 0.02, 0.12);

      const blurKeyNext = `${sigFine.toFixed(3)}|${sigClarity.toFixed(1)}`;
      if (st.blurKey !== blurKeyNext) {
        st.blurKey = blurKeyNext;
        if (sharpDetail.blurFine) setAttr(sharpDetail.blurFine, 'stdDeviation', sigFine);
        if (sharpDetail.blurClarity) setAttr(sharpDetail.blurClarity, 'stdDeviation', sigClarity);
      }

      const sharpKeyNext = aFine.toFixed(5);
      if (st.sharpKey !== sharpKeyNext) {
        st.sharpKey = sharpKeyNext;
        if (sharpDetail.fineUSM) {
          setAttr(sharpDetail.fineUSM, 'k2', 1);
          setAttr(sharpDetail.fineUSM, 'k3', parseFloat((2 * aFine).toFixed(5)));
          setAttr(sharpDetail.fineUSM, 'k4', parseFloat((-aFine).toFixed(5)));
        }
      }

      const emKeyNext = `${Math.round(adaptSens * 100)}|${Math.round(adaptThreshold * 1000)}`;
      if ((st.emKey || '') !== emKeyNext) {
        st.emKey = emKeyNext;
        const table = buildEdgeMaskTable(adaptSens, adaptThreshold);
        if (sharpDetail.edgeFuncs) {
          for (const fn of sharpDetail.edgeFuncs) setAttr(fn, 'tableValues', table);
        }
      }

      const qStrength = Math.round(haloStrength * 100) / 100;
      const haloKeyNext = `${Math.round(qStrength * 100)}`;
      if (st.haloKey !== haloKeyNext) {
        st.haloKey = haloKeyNext;
        const table = buildHaloTable(qStrength);
        if (sharpDetail.haloFuncs) {
          for (const fn of sharpDetail.haloFuncs) setAttr(fn, 'tableValues', table);
        }
      }

      const lcKeyNext = `${aClarity.toFixed(5)}|${sigClarity.toFixed(1)}`;
      if (st.lcKey !== lcKeyNext) {
        st.lcKey = lcKeyNext;
        if (sharpDetail.clarityAdd) {
          // k3: 0.5 기준의 엣지를 다시 2배 증폭 (인코딩 시 0.5 곱했으므로)
          setAttr(sharpDetail.clarityAdd, 'k3', parseFloat((aClarity * 2).toFixed(5)));
          // k4: 0.5 오프셋으로 인해 발생하는 전체 밝기 상승분을 정확히 상쇄
          setAttr(sharpDetail.clarityAdd, 'k4', parseFloat((-aClarity).toFixed(5)));
        }
      }
    }

    function applyShadowParams(shadowNodes, st, shadowParams) {
      const level = shadowParams.level || 0;
      if (level <= 0) return;

      const shadowKey = `crush_v2|${level}`;
      if (st.shadowKey === shadowKey) return;
      st.shadowKey = shadowKey;

      const CRUSH = [
        null,
        { power: 1.12, pull: 0.002 },
        { power: 1.22, pull: 0.006 },
        { power: 1.38, pull: 0.015 },
      ];
      const p = CRUSH[level];
      const RANGE = 0.50, SIZE = 128;
      const arr = new Array(SIZE);
      let prev = 0;

      for (let i = 0; i < SIZE; i++) {
        const x = i / (SIZE - 1);
        if (x <= 1e-6) { arr[i] = '0'; continue; }
        if (x >= 1.0 - 1e-6) { arr[i] = '1'; continue; }
        const t = Math.max(0, Math.min(1, 1.0 - x / RANGE));
        const blend = t * t * (3.0 - 2.0 * t);
        const crushed = Math.pow(x, p.power);
        const pulldown = p.pull * (1.0 - x) * (1.0 - x);
        let y = x * (1.0 - blend) + crushed * blend - pulldown;
        y = Math.max(0, Math.min(1, y));
        if (y <= prev) y = prev + 1e-6;
        if (y > 1.0) y = 1.0;
        prev = y;
        arr[i] = String(Math.round(y * 100000) / 100000);
      }
      for (const fn of shadowNodes.toneFuncs) setAttr(fn, 'tableValues', arr.join(' '));

      const slopeByLevel = [1.0, 1.02, 1.05, 1.10];
      const offsetByLevel = [0, -0.005, -0.015, -0.030];
      for (const fn of shadowNodes.bcFuncs) {
        setAttr(fn, 'slope', slopeByLevel[level]);
        setAttr(fn, 'intercept', offsetByLevel[level]);
      }

      const gammaExpByLevel = [1.0, 1.02, 1.08, 1.15];
      for (const fn of shadowNodes.gamFuncs) setAttr(fn, 'exponent', gammaExpByLevel[level]);
    }

    function prepare(video, s, shadowParams) {
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument)
        ? video.getRootNode()
        : (video.ownerDocument || document);

      let dc = urlCache.get(root);
      if (!dc) { dc = { key: '', url: '' }; urlCache.set(root, dc); }

      ensureOpaqueBg(video);

      const qSharp   = Math.round(Number(s.sharp    || 0));
      const qSharp2  = Math.round(Number(s.sharp2   || 0));
      const qClarity = Math.round(Number(s.clarity  || 0));
      const sharpTotal = qSharp + qSharp2 + qClarity;
      const tier = sharpTotal > 0 ? 'sharp' : 'lite';

      const shadowActive = !!(shadowParams && shadowParams.active);

      const stableKey = `${tier}|${makeKeyBase(s)}|sh:${shadowActive ? 'lv' + (shadowParams.level || 0) : 'off'}`;

      let nodes = ctxMap.get(root);
      if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }

      const needReapply = (dc.key !== stableKey);

      if (nodes.st.lastKey !== stableKey) {
        nodes.st.lastKey = stableKey;
        nodes.st.rev = (nodes.st.rev + 1) | 0;

        const st     = nodes.st;
        const cst    = st.commonTier[tier];
        const common = nodes.commonByTier[tier];
        const steps  = 128;

        const gainQ  = (s.gain || 1) < 1.4 ? 0.06 : 0.08;
        const toeQ   = Math.round(VSC_CLAMP((s.toe || 0) / TOE_DIVISOR, -1, 1) / 0.02) * 0.02;
        const shQ    = Math.round(VSC_CLAMP((s.shoulder || 0) / 16, -1, 1) / 0.02) * 0.02;
        const midQ   = Math.round(VSC_CLAMP(s.mid || 0, -1, 1) / 0.02) * 0.02;

        const rawGain = s.gain || 1;
        const gainQ2 = Math.abs(rawGain - 1.0) < 0.02 ? 1.0 : Math.round(rawGain / gainQ) * gainQ;

        const tk     = `${steps}|${toeQ}|${shQ}|${midQ}|${gainQ2}`;
        const table  = cst.toneKey !== tk
          ? getToneTableCached(steps, toeQ, shQ, midQ, gainQ2)
          : cst.toneTable;

        if (cst.toneKey !== tk) {
          cst.toneKey = tk; cst.toneTable = table;
          for (const fn of common.toneFuncs) setAttr(fn, 'tableValues', table);
        }

        const con         = VSC_CLAMP(s.contrast || 1, 0.1, 5.0);
        const brightOffset = VSC_CLAMP((s.bright || 0) / 250, -0.5, 0.5);
        const intercept   = VSC_CLAMP(0.5 * (1 - con) + brightOffset, -5, 5);
        const bcLinKey    = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
        if (cst.bcLinKey !== bcLinKey) {
          cst.bcLinKey = bcLinKey;
          for (const fn of common.bcLinFuncs) {
            setAttr(fn, 'slope', parseFloat(con.toFixed(3)));
            setAttr(fn, 'intercept', parseFloat(intercept.toFixed(4)));
          }
        }

        const gk = (1 / VSC_CLAMP(s.gamma || 1, 0.1, 5.0)).toFixed(4);
        if (cst.gammaKey !== gk) {
          cst.gammaKey = gk;
          for (const fn of common.gamFuncs) setAttr(fn, 'exponent', parseFloat(gk));
        }

        const satVal = VSC_CLAMP(s.satF ?? 1, 0, 5.0).toFixed(2);
        if (cst.satKey !== satVal) {
          cst.satKey = satVal;
          for (const satNode of common.sats) setAttr(satNode, 'values', parseFloat(satVal));
        }

        const toneNeutral = (
          Math.abs((s.gain || 1) - 1.0) < 0.02 &&
          Math.abs(s.toe || 0) < 0.01 &&
          Math.abs(s.shoulder || 0) < 0.01 &&
          Math.abs(s.mid || 0) < 0.01 &&
          Math.abs((s.gamma || 1) - 1.0) < 0.02 &&
          Math.abs(s.bright || 0) < 0.5 &&
          Math.abs((s.contrast || 1) - 1.0) < 0.02 &&
          Math.abs((s.satF ?? 1) - 1.0) < 0.02
        );
        const rsEff = toneNeutral ? 1.0 : (s._rs || 1);
        const gsEff = toneNeutral ? 1.0 : (s._gs || 1);
        const bsEff = toneNeutral ? 1.0 : (s._bs || 1);

        const rsStr = rsEff.toFixed(3), gsStr = gsEff.toFixed(3), bsStr = bsEff.toFixed(3);
        const tmk = `${rsStr}|${gsStr}|${bsStr}`;
        if (cst.tempKey !== tmk) {
          cst.tempKey = tmk;
          setAttr(common.tmp.r, 'slope', parseFloat(rsStr));
          setAttr(common.tmp.g, 'slope', parseFloat(gsStr));
          setAttr(common.tmp.b, 'slope', parseFloat(bsStr));
        }

        if (tier === 'sharp') {
          applySharpParams(nodes.sharpDetail, st, s);
        }

        if (shadowActive) {
          applyShadowParams(nodes.shadowNodes, st, shadowParams);
        }
      }

      const mainUrl = tier === 'lite' ? `url(#${nodes.fidLite})` : `url(#${nodes.fidSharp})`;
      const shadowUrl = shadowActive ? `url(#${nodes.fidShadow})` : '';

      const combinedUrl = shadowActive ? `${shadowUrl} ${mainUrl}` : mainUrl;

      dc.key = stableKey;
      dc.url = combinedUrl;

      return { url: combinedUrl, changed: needReapply, rev: nodes.st.rev };
    }

    return {
      invalidateCache: (video) => {
        try {
          const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument)
            ? video.getRootNode() : (video.ownerDocument || document);
          const nodes = ctxMap.get(root);
          if (nodes) {
            nodes.st.lastKey = ''; nodes.st.blurKey = '';
            nodes.st.sharpKey = ''; nodes.st.haloKey = ''; nodes.st.lcKey = '';
            nodes.st.emKey = ''; nodes.st.shadowKey = '';
            nodes.st.rev = (nodes.st.rev + 1) | 0;
            for (const tierKey of ['lite', 'sharp']) {
              const cst = nodes.st.commonTier[tierKey];
              if (cst) {
                cst.toneKey = ''; cst.toneTable = '';
                cst.bcLinKey = ''; cst.gammaKey = '';
                cst.tempKey = ''; cst.satKey = '';
              }
            }
          }
          const dc = urlCache.get(root);
          if (dc) { dc.key = ''; dc.url = ''; }
        } catch (_) {}
      },

      prepareCached: (video, s, shadowParams) => {
        try { return prepare(video, s, shadowParams || null); }
        catch (e) {
          if (typeof log !== 'undefined') log.warn('filter prepare failed:', e);
          return { url: null, changed: false, rev: -1 };
        }
      },

      applyUrl: (el, urlObj) => {
        if (!el) return;
        const url = typeof urlObj === 'string' ? urlObj : urlObj?.url;
        const st = getVState(el);
        if (!url) {
          restoreOpaqueBg(el);
          if (st.applied) {
            if (st.origFilter != null && st.origFilter !== '')
              el.style.setProperty('filter', st.origFilter, st.origFilterPrio || '');
            else el.style.removeProperty('filter');
            if (st.origWebkitFilter != null && st.origWebkitFilter !== '')
              el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || '');
            else el.style.removeProperty('-webkit-filter');
            st.applied = false; st.lastFilterUrl = null; st.filterRev = -1;
            st.origFilter = st.origWebkitFilter = null;
            st.origFilterPrio = st.origWebkitFilterPrio = '';
          }
          return;
        }
        if (!st.applied) {
          st.origFilter        = el.style.getPropertyValue('filter');
          st.origFilterPrio    = el.style.getPropertyPriority('filter') || '';
          st.origWebkitFilter  = el.style.getPropertyValue('-webkit-filter');
          st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || '';
        }
        const nextRev = (typeof urlObj === 'object' && typeof urlObj.rev === 'number')
          ? urlObj.rev : -1;
        if (st.lastFilterUrl !== url) {
          el.style.setProperty('filter', url, 'important');
          el.style.setProperty('-webkit-filter', url, 'important');
        }
        st.applied = true; st.lastFilterUrl = url; st.filterRev = nextRev;
      },

      clear: (el) => {
        if (!el) return;
        const st = getVState(el);
        restoreOpaqueBg(el);
        if (!st.applied) return;
        if (st.origFilter != null && st.origFilter !== '')
          el.style.setProperty('filter', st.origFilter, st.origFilterPrio || '');
        else el.style.removeProperty('filter');
        if (st.origWebkitFilter != null && st.origWebkitFilter !== '')
          el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || '');
        else el.style.removeProperty('-webkit-filter');
        st.applied = false; st.lastFilterUrl = null; st.filterRev = -1;
        st.origFilter = st.origWebkitFilter = null;
        st.origFilterPrio = st.origWebkitFilterPrio = '';
      }
    };
  }
// --- PART 2 END ---
// --- PART 3 START ---

  function createBackendAdapter(Filters) {
    return {
      apply(video, vVals, shadowParams) {
        const svgResult = Filters.prepareCached(video, vVals, shadowParams);
        Filters.applyUrl(video, svgResult);
        const st = getVState(video);
        st.fxBackend = st.applied ? 'svg' : null;
      },
      clear(video) {
        const st = getVState(video);
        if (st.applied || st.fxBackend === 'svg') Filters.clear(video);
        st.fxBackend = null;
      }
    };
  }

  function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    const move = (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); };
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointermove', move, { passive: false, signal: ac.signal });
    on(el, 'pointerup', up, { signal: ac.signal });
    on(el, 'pointercancel', up, { signal: ac.signal });
    return () => { ac.abort(); };
  }

  function createUI(sm, registry, ApplyReq, Utils, P) {
    const { h } = Utils;
    let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null;
    let hasUserDraggedUI = false;
    const uiWakeCtrl = new AbortController();
    const uiUnsubs = [];

    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const detachNodesHard = () => {
      try { if (container?.isConnected) container.remove(); } catch (_) {}
      try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {}
    };

    let _allowCache = { v: false, t: 0, lastVideoCount: -1 };
    const ALLOW_TTL_NO_VIDEO = 3000;
    const ALLOW_TTL_HAS_VIDEO = 800;

    const allowUiInThisDoc = () => {
      const now = performance.now();
      const vc = registry.videos.size;
      const ttl = vc > 0 ? ALLOW_TTL_HAS_VIDEO : ALLOW_TTL_NO_VIDEO;
      if (vc === _allowCache.lastVideoCount && (now - _allowCache.t) < ttl) return _allowCache.v;

      let ok = false;
      if (vc > 0) ok = true;
      else {
        try {
          ok = !!document.querySelector('video');
          if (!ok) ok = !!document.querySelector('[class*=player],[id*=player],[data-player]');
        } catch (_) { ok = false; }
      }
      _allowCache = { v: ok, t: now, lastVideoCount: vc };
      return ok;
    };

    safe(() => {
      if (typeof CSS === 'undefined' || !CSS.registerProperty) return;
      for (const prop of [
        { name: '--__vsc171-vv-top', syntax: '<length>', inherits: true, initialValue: '0px' },
        { name: '--__vsc171-vv-h', syntax: '<length>', inherits: true, initialValue: '100vh' }
      ]) { try { CSS.registerProperty(prop); } catch (_) {} }
    });

    function setAndHint(path, value) {
      const prev = sm.get(path);
      const changed = !Object.is(prev, value);
      if (changed) sm.set(path, value);
      (changed ? ApplyReq.hard() : ApplyReq.soft());
    }

    const getUiRoot = () => {
      const fs = document.fullscreenElement || null;
      if (fs) {
        if (fs.tagName === 'VIDEO') return fs.parentElement || document.documentElement || document.body;
        return fs;
      }
      return document.body || document.documentElement;
    };

    function bindReactive(btn, paths, apply, sm, sub) {
      const pathArr = Array.isArray(paths) ? paths : [paths];
      let pending = false;
      const sync = () => {
        if (pending) return;
        pending = true;
        queueMicrotask(() => { pending = false; if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); });
      };
      pathArr.forEach(p => sub(p, sync));
      if (btn) apply(btn, ...pathArr.map(p => sm.get(p)));
      return sync;
    }

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false, isBitmask = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      for (const it of items) {
        const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text);
        b.onclick = (e) => {
          e.stopPropagation();
          if (!sm.get(P.APP_ACT)) return;
          if (isBitmask) {
            sm.set(key, ((Number(sm.get(key)) | 0) ^ it.value) & 7);
          } else {
            const cur = sm.get(key);
            if (toggleActiveToOff && offValue !== undefined && cur === it.value && it.value !== offValue) setAndHint(key, offValue);
            else setAndHint(key, it.value);
          }
          ApplyReq.hard();
        };
        bindReactive(b, [key, P.APP_ACT], (el, v, act) => {
          const isActive = isBitmask ? (((Number(v) | 0) & it.value) !== 0) : v === it.value;
          el.classList.toggle('active', isActive);
          el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
          el.style.cursor = act ? 'pointer' : 'not-allowed';
          el.disabled = !act;
        }, sm, sub);
        row.append(b);
      }
      if (offValue != null || isBitmask) {
        const offBtn = h('button', { class: 'pbtn', style: isBitmask ? 'flex:0.9' : 'flex:1' }, 'OFF');
        offBtn.onclick = (e) => {
          e.stopPropagation();
          if (!sm.get(P.APP_ACT)) return;
          sm.set(key, isBitmask ? 0 : offValue);
          ApplyReq.hard();
        };
        bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => {
          const isActuallyOff = isBitmask ? (Number(v)|0) === 0 : v === offValue;
          el.classList.toggle('active', isActuallyOff);
          el.style.opacity = act ? '1' : (isActuallyOff ? '0.65' : '0.45');
          el.style.cursor = act ? 'pointer' : 'not-allowed';
          el.disabled = !act;
        }, sm, sub);
        row.append(offBtn);
      }
      return row;
    }

    const clampVal = (v, a, b) => (v < a ? a : (v > b ? b : v));

    const clampPanelIntoViewport = () => {
      try {
        if (!container) return;
        const mainPanel = container.shadowRoot && container.shadowRoot.querySelector('.main');
        if (!mainPanel || mainPanel.style.display === 'none') return;

        if (!hasUserDraggedUI) {
          mainPanel.style.left = ''; mainPanel.style.top = ''; mainPanel.style.right = ''; mainPanel.style.bottom = ''; mainPanel.style.transform = '';
          queueMicrotask(() => {
            const r = mainPanel.getBoundingClientRect();
            if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) {
              mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; mainPanel.style.transform = 'translateY(-50%)';
            }
          });
          return;
        }

        const r = mainPanel.getBoundingClientRect();
        if (!r.width && !r.height) return;

        const vv = window.visualViewport, vw = (vv && vv.width) ? vv.width : (window.innerWidth || document.documentElement.clientWidth || 0), vh = (vv && vv.height) ? vv.height : (window.innerHeight || document.documentElement.clientHeight || 0);
        const offL = (vv && typeof vv.offsetLeft === 'number') ? vv.offsetLeft : 0, offT = (vv && typeof vv.offsetTop === 'number') ? vv.offsetTop : 0;

        if (!vw || !vh) return;
        const w = r.width || 300, panH = r.height || 400;
        const left = clampVal(r.left, offL + 8, Math.max(offL + 8, offL + vw - w - 8)), top = clampVal(r.top, offT + 8, Math.max(offT + 8, offT + vh - panH - 8));

        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
      } catch (_) {}
    };

    const syncVVVars = () => {
      try {
        const root = document.documentElement, vv = window.visualViewport;
        if (!root) return;
        if (!vv) { root.style.setProperty('--__vsc171-vv-top', '0px'); root.style.setProperty('--__vsc171-vv-h', `${window.innerHeight}px`); return; }
        root.style.setProperty('--__vsc171-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--__vsc171-vv-h', `${Math.round(vv.height)}px`);
      } catch (_) {}
    };

    syncVVVars();

    let _clampRafId = 0;
    const onLayoutChange = () => {
      if (_clampRafId) return;
      _clampRafId = requestAnimationFrame(() => {
        _clampRafId = 0;
        clampPanelIntoViewport();
      });
    };

    try {
      const vv = window.visualViewport;
      if (vv) {
        on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
        on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
      }
    } catch (_) {}

    on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    on(document, 'fullscreenchange', () => { setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });

    const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');

    const __vscSheetCache = new Map();
    function attachShadowStyles(shadowRoot, cssText) {
      try {
        if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') {
          let sheet = __vscSheetCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __vscSheetCache.set(cssText, sheet);
          }
          shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
          return;
        }
      } catch (_) {}
      const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl);
    }

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${getNS()?.CONFIG?.VSC_ID || 'core'}`, 'data-vsc-ui': '1', 'data-vsc-id': getNS()?.CONFIG?.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' });
      const style = `
        @property --__vsc171-vv-top { syntax: "<length>"; inherits: true; initial-value: 0px; }
        @property --__vsc171-vv-h { syntax: "<length>"; inherits: true; initial-value: 100vh; }
        :host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--__vsc171-vv-top,0px) + (var(--__vsc171-vv-h,100vh) / 2));right:max(70px,calc(env(safe-area-inset-right,0px) + 70px));transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:85vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px 400px}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:50%!important;right:70px!important;left:auto!important;transform:translateY(-50%)!important;width:260px!important;max-height:70vh!important;padding:10px;border-radius:12px;overflow-y:auto}.main::-webkit-scrollbar{width:3px}.main::-webkit-scrollbar-thumb{background:#666;border-radius:10px}.prow{gap:3px;flex-wrap:nowrap;justify-content:center}.btn,.pbtn{min-height:34px;font-size:10.5px;padding:4px 1px;letter-spacing:-0.8px;white-space:nowrap}.header{font-size:12px;padding-bottom:5px}} .header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.slider{width:100%}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}
      `;
      attachShadowStyles(shadow, style);

      const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

      const autoSceneRow = h('div', { class: 'prow' }, [
        h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '톤'),
        ...['Soft', 'Normal', 'Strong'].map(p => {
          const b = h('button', { class: 'pbtn', style: 'flex:1' }, p);
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            const curEn = sm.get(P.APP_AUTO_SCENE);
            const curPre = sm.get(P.APP_AUTO_SCENE_PRESET);
            if (curEn && curPre === p) setAndHint(P.APP_AUTO_SCENE, false);
            else {
              if (!curEn) setAndHint(P.APP_AUTO_SCENE, true);
              setAndHint(P.APP_AUTO_SCENE_PRESET, p);
            }
          };
          bindReactive(b, [P.APP_AUTO_SCENE, P.APP_AUTO_SCENE_PRESET, P.APP_ACT], (el, en, pre, act) => {
            const isActive = !!en && pre === p;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        }),
        (() => {
          const offBtn = h('button', { class: 'pbtn', style: 'flex:0.8' }, 'OFF');
          offBtn.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            setAndHint(P.APP_AUTO_SCENE, false);
          };
          bindReactive(offBtn, [P.APP_AUTO_SCENE, P.APP_ACT], (el, en, act) => {
            const isActive = !en;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return offBtn;
        })()
      ]);

      const sharpRow = renderButtonRow({
        label: '선명',
        key: P.V_PRE_S,
        offValue: 'off',
        toggleActiveToOff: true,
        items: [
          { text: 'Soft',   value: 'Soft',   title: '약한 선명화' },
          { text: 'Medium', value: 'Medium', title: '중간 선명화' },
          { text: 'Ultra',  value: 'Ultra',  title: '강한 선명화 (Adaptive)' }
        ]
      });

      const pipBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '📺 PIP');
      pipBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        const v = getNS()?.App?.getActiveVideo(); if(v) await togglePiPFor(v);
      };
      bindReactive(pipBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 1;' }, '🔍 줌');
      zoomBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        const zm = getNS()?.ZoomManager; const v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return;
        if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); }
        else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); }
      };
      bindReactive(zoomBtn, [P.APP_ZOOM_EN, P.APP_ACT], (el, v, act) => {
        el.classList.toggle('active', !!v);
        el.style.opacity = act ? '1' : (v ? '0.65' : '0.45');
        el.style.cursor = act ? 'pointer' : 'not-allowed';
        el.disabled = !act;
      }, sm, sub);

      const pwrBtn = h('button', { class: 'btn', style: 'flex: 1;', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '⚡ Power');
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); }, sm, sub);

      const boostBtn = h('button', {
        id: 'boost-btn',
        class: 'btn',
        style: 'flex: 1.5; font-weight: 800;'
      }, '🔊 Brickwall (EQ+Dyn+Stereo)');

      boostBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        if (getNS()?.AudioWarmup) getNS().AudioWarmup();

        const isCurrentlyOn = sm.get(P.A_EN);
        const nextState = !isCurrentlyOn;

        sm.batch('audio', {
          enabled: nextState,
          stereoWidth: nextState,
          multiband: true,
          lufs: true
        });
        ApplyReq.hard();
      };

      bindReactive(boostBtn, [P.A_EN, P.APP_ACT], (el, aEn, act) => {
        el.classList.toggle('active', !!aEn);
        el.style.color = aEn ? 'var(--ac)' : '#eee';
        el.style.opacity = act ? '1' : '0.45';
        el.disabled = !act;
      }, sm, sub);

      const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '🗣️ 대화 강조');
      dialogueBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE));
      };
      bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN, P.APP_ACT], (el, dOn, aEn, act) => {
        el.classList.toggle('active', !!dOn);
        const usable = !!aEn && !!act;
        el.style.opacity = usable ? '1' : (dOn ? '0.65' : '0.35');
        el.style.cursor = usable ? 'pointer' : 'not-allowed';
        el.disabled = !usable;
      }, sm, sub);

      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '▼ 고급 설정 열기');
      advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
      bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
        renderButtonRow({
          label: '암부',
          key: P.V_SHADOW_MASK,
          offValue: 0,
          toggleActiveToOff: true,
          items: [
            { text: '1단', value: DARK_BAND.LV1, title: '약한 암부 강화' },
            { text: '2단', value: DARK_BAND.LV2, title: '중간 암부 강화' },
            { text: '3단', value: DARK_BAND.LV3, title: '강한 암부 강화' }
          ]
        }),
        renderButtonRow({ label: '밝기1', key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
        renderButtonRow({ label: '밝기2', key: P.V_PRE_B, offValue: 'brOFF', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'brOFF').map(k => ({ text: k, value: k })) }),
        h('hr'),
        renderButtonRow({ label: '시계', key: P.APP_TIME_EN, offValue: false, toggleActiveToOff: true, items: [{ text: '표시 (전체화면)', value: true }] }),
        renderButtonRow({ label: '위치', key: P.APP_TIME_POS, items: [{ text: '좌', value: 0 }, { text: '중', value: 1 }, { text: '우', value: 2 }] }),
        h('hr')
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

      const resetBtn = h('button', { class: 'btn' }, '↺ 리셋');
      resetBtn.onclick = (e) => {
        e.stopPropagation();
        if (!sm.get(P.APP_ACT)) return;
        sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); ApplyReq.hard();
      };
      bindReactive(resetBtn, [P.APP_ACT], (el, act) => {
        el.style.opacity = act ? '1' : '0.45';
        el.style.cursor = act ? 'pointer' : 'not-allowed';
        el.disabled = !act;
      }, sm, sub);

      const bodyMain = h('div', { id: 'p-main' }, [
        autoSceneRow,
        sharpRow,
        h('div', { class: 'prow' }, [ pipBtn, zoomBtn, pwrBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 4px;' }, [ boostBtn, dialogueBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 8px;' }, [
          h('button', { class: 'btn', style: 'background:#333;', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕ 닫기'),
          resetBtn
        ]),
        advToggleBtn,
        advContainer,
        h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true);
          };
          bindReactive(b, [P.PB_RATE, P.PB_EN, P.APP_ACT], (el, rate, en, act) => {
            const isActive = !!en && Math.abs(Number(rate || 1) - s) < 0.01;
            el.classList.toggle('active', isActive);
            el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45');
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        })),
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [
          { text: '◀ 30s', action: 'seek', val: -30 },
          { text: '◀ 15s', action: 'seek', val: -15 },
          { text: '⏸ 정지', action: 'pause' },
          { text: '▶ 재생', action: 'play' },
          { text: '15s ▶', action: 'seek', val: 15 },
          { text: '30s ▶', action: 'seek', val: 30 }
        ].map(cfg => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text);
          b.onclick = (e) => {
            e.stopPropagation();
            if (!sm.get(P.APP_ACT)) return;
            const v = getNS()?.App?.getActiveVideo(); if (!v) return;
            if (cfg.action === 'play') { v.play().catch(() => {}); }
            else if (cfg.action === 'pause') { v.pause(); }
            else if (cfg.action === 'seek') {
              const isLive = !Number.isFinite(v.duration); let minT = 0, maxT = v.duration;
              if (isLive || v.duration === Infinity) { const sr = v.seekable; if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
              let target = v.currentTime + cfg.val; if (cfg.val > 0 && target >= maxT) target = maxT - 0.1;
              target = Math.max(minT, Math.min(maxT, target)); try { v.currentTime = target; } catch (_) {}
              let fallbackTimer = 0;
              const onSeeked = () => {
                v.removeEventListener('seeked', onSeeked);
                clearTimeout(fallbackTimer);
                if (Math.abs(v.currentTime - target) > 5.0) { try { v.currentTime = target; } catch (_) {} }
              };
              v.addEventListener('seeked', onSeeked, { once: true });
              fallbackTimer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); }, 3000);
            }
          };
          bindReactive(b, [P.APP_ACT], (el, act) => {
            el.style.opacity = act ? '1' : '0.45';
            el.style.cursor = act ? 'pointer' : 'not-allowed';
            el.disabled = !act;
          }, sm, sub);
          return b;
        }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]);
      shadow.append(mainPanel);

      if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);

      let stopDrag = null;
      const startPanelDrag = (e) => {
        if (e.target && e.target.tagName === 'BUTTON') return;
        if (e.cancelable) e.preventDefault();
        stopDrag?.(); hasUserDraggedUI = true;
        let startX = e.clientX, startY = e.clientY;
        const rect = mainPanel.getBoundingClientRect();
        mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`;
        try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(dragHandle, (ev) => {
          const dx = ev.clientX - startX, dy = ev.clientY - startY, panelRect = mainPanel.getBoundingClientRect();
          let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx));
          let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy));
          mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`;
        }, () => { stopDrag = null; });
      };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (!allowUiInThisDoc()) { if (gearHost) gearHost.style.display = 'none'; return; }
      if (gearHost) { gearHost.style.display = 'block'; return; }
      gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${getNS()?.CONFIG?.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
      attachShadowStyles(shadow, style);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '⚙'); shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));

      if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);

      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.();
        const startY = e.clientY;
        const rect = gearBtn.getBoundingClientRect();
        try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(gearBtn, (ev) => {
          const currentY = ev.clientY;
          if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); }
          if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop)); gearBtn.style.top = `${newTop}px`; }
        }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
      };
      on(gearBtn, 'pointerdown', handleGearDrag);

      let lastToggle = 0;
      const onGearActivate = (e) => {
        if (dragThresholdMet) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
        const now = performance.now();
        if (now - lastToggle < 300) { safe(() => { if (e && e.cancelable) e.preventDefault(); }); return; }
        lastToggle = now;
        setAndHint(P.APP_UI, !sm.get(P.APP_UI));
      };
      on(gearBtn, 'pointerup', (e) => {
        safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); });
        onGearActivate(e);
      }, { passive: false });

      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; const gearTarget = document.fullscreenElement || document.body || document.documentElement; try { if (gearHost && gearHost.parentNode !== gearTarget) gearTarget.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== gearTarget) gearTarget.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc()) { detachNodesHard(); return; } ensureGear(); if (sm.get(P.APP_UI)) { build(); const mainPanel = getMainPanel(); if (mainPanel && !mainPanel.classList.contains('visible')) { mainPanel.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { const mainPanel = getMainPanel(); if (mainPanel) mainPanel.classList.remove('visible'); } mount(); safe(() => wakeGear?.()); };
    onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });
    if (getNS()) getNS().UIEnsure = ensure;
    return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
  }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) {
      st.rateState = {
        orig: null, lastSetAt: 0, suppressSyncUntil: 0, _setAttempts: 0, _firstAttemptT: 0,
        _backoffLv: 0, _lastBackoffAt: 0
      };
    }
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) {
    const st = getRateState(v);
    const now = performance.now();
    st.lastSetAt = now;
    st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
  }

  function restoreRateOne(el) {
    try {
      const st = getRateState(el);
      if (!st || st.orig == null) return;
      const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
      st.orig = null;
      markInternalRateChange(el, 220);
      el.playbackRate = nextRate;
    } catch (_) {}
  }

  function ensureMobileInlinePlaybackHints(video) {
    if (!video || !getNS()?.CONFIG?.IS_MOBILE) return;
    safe(() => {
      if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
      if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
    });
  }

  function createZoomManager(Store, P) {
    const stateMap = new WeakMap();
    let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    let touchListenersAttached = false;
    const zoomAC = new AbortController();
    const zsig = combineSignals(zoomAC.signal, __globalSig);
    const zoomedVideos = new Set();

    let activePointerId = null;

    function getLatestPointerPoint(e) {
      try {
        const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
        const last = (list && list.length) ? list[list.length - 1] : e;
        return { x: last.clientX, y: last.clientY };
      } catch (_) {
        return { x: e.clientX, y: e.clientY };
      }
    }

    const getSt = (v) => {
      let st = stateMap.get(v);
      if (!st) {
        st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origZIndex: '', origPosition: '', origComputedPosition: '', _cachedPosition: null, _lastTransition: null };
        stateMap.set(v, st);
      }
      return st;
    }

    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active;
        if (st.scale <= 1) {
          if (st.zoomed) {
            v.style.transform = ''; v.style.transformOrigin = ''; v.style.cursor = '';
            v.style.zIndex = st.origZIndex; v.style.position = st.origPosition;
            v.style.transition = ''; st.zoomed = false; st.origComputedPosition = '';
          }
          st.scale = 1; st.tx = 0; st.ty = 0;
          zoomedVideos.delete(v);
        } else {
          if (!st.zoomed) {
            st.origZIndex = v.style.zIndex; st.origPosition = v.style.position;
            if (!st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
            st.origComputedPosition = st._cachedPosition; st.zoomed = true;
            if (st.origComputedPosition === 'static') v.style.position = 'relative';
          }
          const wantTransition = panning ? 'none' : 'transform 0.1s ease-out';
          if (st._lastTransition !== wantTransition) { v.style.transition = wantTransition; st._lastTransition = wantTransition; }
          v.style.transformOrigin = '0 0';
          v.style.transform = `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
          v.style.cursor = panning ? 'grabbing' : 'grab';
          v.style.zIndex = '2147483646';
          zoomedVideos.add(v);
        }
      });
    };

    function clampPan(v, st) {
      const rect = getRectCached(v, performance.now(), 300);
      if (!rect || rect.width <= 1 || rect.height <= 1) return;
      const scaledW = rect.width * st.scale, scaledH = rect.height * st.scale;
      const minVisibleFraction = 0.25;
      const minVisW = rect.width * minVisibleFraction, minVisH = rect.height * minVisibleFraction;
      const maxTx = rect.width - minVisW, minTx = -(scaledW - minVisW - rect.width);
      const maxTy = rect.height - minVisH, minTy = -(scaledH - minVisH - rect.height);
      st.tx = Math.max(Math.min(st.tx, maxTx), minTx);
      st.ty = Math.max(Math.min(st.ty, maxTy), minTy);
    }

    const zoomTo = (v, newScale, clientX, clientY) => {
      const st = getSt(v);
      if (!st.zoomed && !st._cachedPosition) { try { st._cachedPosition = getComputedStyle(v).position; } catch (_) { st._cachedPosition = 'static'; } }
      const rect = getRectCached(v, performance.now(), 150);
      if (!rect || rect.width <= 1 || rect.height <= 1) return;
      const ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale;
      st.tx = clientX - (rect.left - st.tx) - ix * newScale;
      st.ty = clientY - (rect.top - st.ty) - iy * newScale;
      st.scale = newScale;
      update(v);
    };

    function clearZoomStyles(v, st) {
      try {
        v.style.transform = '';
        v.style.transformOrigin = '';
        v.style.cursor = '';
        v.style.zIndex = st?.origZIndex || '';
        v.style.position = st?.origPosition || '';
        v.style.transition = '';
      } catch (_) {}
      if (st) {
        st.scale = 1; st.tx = 0; st.ty = 0;
        st.zoomed = false; st._cachedPosition = null; st._lastTransition = null;
      }
    }

    const resetZoom = (v) => {
      if (!v) return;
      const st = getSt(v);
      zoomedVideos.delete(v);
      clearZoomStyles(v, st);
    };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let unsubAct = null, unsubZoomEn = null;

    if (Store?.sub) {
      unsubAct = Store.sub(P.APP_ACT, (act) => {
        if (!act) {
          for (const v of [...zoomedVideos]) {
            resetZoom(v);
          }
          isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null;
        }
      });
      unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => {
        if (en) {
          if (CONFIG.IS_MOBILE) attachTouchListeners();
        } else {
          for (const v of [...zoomedVideos]) {
            resetZoom(v);
          }
          zoomedVideos.clear();
          isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null;
        }
      });
    }

    function getTargetVideo(e) {
      if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
      const touch = e.touches?.[0];
      const cx = Number.isFinite(e.clientX) ? e.clientX : (touch && Number.isFinite(touch.clientX) ? touch.clientX : null);
      const cy = Number.isFinite(e.clientY) ? e.clientY : (touch && Number.isFinite(touch.clientY) ? touch.clientY : null);
      if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; }
      return __vscNs.App?.getActiveVideo() || null;
    }

    on(window, 'wheel', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v);
      let newScale = Math.min(Math.max(1, st.scale * delta), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'pointerdown', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (e.pointerType === 'touch') return;
      if (!e.altKey) return;

      const v = getTargetVideo(e);
      if (!v) return;

      const st = getSt(v);
      if (st.scale <= 1) return;

      const pt = getLatestPointerPoint(e);

      if (e.cancelable) {
        e.preventDefault();
        e.stopPropagation();
      }

      activeVideo = v;
      activePointerId = e.pointerId;
      isPanning = true;
      st.hasPanned = false;

      startX = pt.x - st.tx;
      startY = pt.y - st.ty;

      try { v.setPointerCapture?.(e.pointerId); } catch (_) {}
      update(v);
    }, { capture: true, passive: false, signal: zsig });

    on(window, 'pointermove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!isPanning || !activeVideo) return;
      if (e.pointerId !== activePointerId) return;

      const pt = getLatestPointerPoint(e);
      const st = getSt(activeVideo);

      if (e.cancelable) {
        e.preventDefault();
        e.stopPropagation();
      }

      const nextTx = pt.x - startX;
      const nextTy = pt.y - startY;

      if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) {
        st.hasPanned = true;
      }

      st.tx = nextTx;
      st.ty = nextTy;

      clampPan(activeVideo, st);
      update(activeVideo);
    }, { capture: true, passive: false, signal: zsig });

    function endPointerPan(e) {
      if (e.pointerType === 'touch') return;
      if (!isPanning || !activeVideo) return;
      if (e.pointerId !== activePointerId) return;

      const v = activeVideo;
      const st = getSt(v);

      try { v.releasePointerCapture?.(e.pointerId); } catch (_) {}

      if (st.hasPanned && e.cancelable) {
        e.preventDefault();
        e.stopPropagation();
      }

      activePointerId = null;
      isPanning = false;
      activeVideo = null;

      update(v);
    }

    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });

    on(window, 'dblclick', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true, signal: zsig });

    const touchstartHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
      } else if (e.touches.length === 1 && st.scale > 1) {
        activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
      }
    };

    const touchmoveHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
        let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; isPanning = false; activeVideo = null; }
        else {
          zoomTo(activeVideo, newScale, center.x, center.y);
          st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
          clampPan(activeVideo, st); update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      } else if (isPanning && e.touches.length === 1) {
        if (e.cancelable) e.preventDefault();
        const dx = e.touches[0].clientX - startX - st.tx, dy = e.touches[0].clientY - startY - st.ty;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.hasPanned = true;
        st.tx = e.touches[0].clientX - startX; st.ty = e.touches[0].clientY - startY;
        clampPan(activeVideo, st); update(activeVideo);
      }
    };

    const touchendHandler = (e) => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      if (!activeVideo) return;
      if (e.touches.length < 2) pinchState.active = false;
      if (e.touches.length === 0) {
        if (isPanning && getSt(activeVideo).hasPanned && e.cancelable) e.preventDefault();
        isPanning = false; update(activeVideo); activeVideo = null;
      }
    };

    const attachTouchListeners = () => {
      if (touchListenersAttached) return; touchListenersAttached = true;
      on(window, 'touchstart', touchstartHandler, { passive: false, capture: true, signal: zsig });
      on(window, 'touchmove', touchmoveHandler, { passive: false, capture: true, signal: zsig });
      on(window, 'touchend', touchendHandler, { passive: false, capture: true, signal: zsig });
    };

    if (CONFIG.IS_MOBILE) {
      if (Store?.get(P.APP_ZOOM_EN)) attachTouchListeners();
    } else {
      attachTouchListeners();
    }

    return {
      resetZoom, zoomTo, isZoomed, setEnabled: (en) => { if (en) attachTouchListeners(); },
      pruneDisconnected: () => {
        for (const v of [...zoomedVideos]) {
          if (!v?.isConnected) resetZoom(v);
        }
      },
      destroy: () => {
        try { unsubAct?.(); } catch(_) {}
        try { unsubZoomEn?.(); } catch(_) {}
        zoomAC.abort(); touchListenersAttached = false;
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        for (const v of [...zoomedVideos]) {
          clearZoomStyles(v, getSt(v));
        }
        zoomedVideos.clear();
        isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null;
      }
    };
  }

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);
    const softResetTransientFlags = () => {
      st.audioFailUntil = 0; st.rect = null; st.rectT = 0; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; }
      if (st.rateState) {
        st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState._setAttempts = 0; st.rateState._firstAttemptT = 0;
        st.rateState._backoffLv = 0; st.rateState._lastBackoffAt = 0;
      }
      ApplyReq.hard();
    };
    const combinedSignal = combineSignals(st._ac.signal, __globalSig); const opts = { passive: true, signal: combinedSignal };
    const videoEvents = [['loadstart', softResetTransientFlags], ['loadedmetadata', softResetTransientFlags], ['emptied', softResetTransientFlags], ['seeking', () => ApplyReq.hard()], ['play', () => ApplyReq.hard()], ['ratechange', () => { const rSt = getRateState(v); const now = performance.now(); if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return; const st = getVState(v); const desired = st.desiredRate; if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return; const store = getNS()?.Store; if (!store) return; const activeVideo = getNS()?.App?.getActiveVideo?.(); if (!activeVideo || v !== activeVideo) return; const cur = v.playbackRate; if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); } }]];
    for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
  };

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el);
    const now = performance.now();

    if (now < (rSt.suppressSyncUntil || 0)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate;

    const rateMatches = Math.abs(el.playbackRate - desiredRate) < 0.01;

    if (Object.is(st.desiredRate, desiredRate) && rateMatches) {
      if ((rSt._backoffLv | 0) > 0 && (now - (rSt._lastBackoffAt || 0)) > 1200) {
        rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
      touchedAdd(TOUCHED.rateVideos, el);
      return;
    }

    if (!rSt._firstAttemptT || (now - rSt._firstAttemptT) > 2500) {
      rSt._firstAttemptT = now;
      rSt._setAttempts = 0;
    }

    rSt._setAttempts++;

    if (rSt._setAttempts > 6) {
      const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
      rSt._backoffLv = lv;
      rSt._lastBackoffAt = now;
      const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
      rSt.suppressSyncUntil = now + backoffMs + ((Math.random() * 220) | 0);
      rSt._setAttempts = 0;
      return;
    }

    st.desiredRate = desiredRate;
    markInternalRateChange(el, 250);

    try { el.playbackRate = desiredRate; } catch (_) {}

    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
        markInternalRateChange(el, 250);
        try { el.playbackRate = desiredRate; } catch (_) {}
        requestAnimationFrame(() => {
          if (!el.isConnected) return;
          if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
            const n2 = performance.now();
            const lv = Math.min(((rSt._backoffLv | 0) + 1), 5);
            rSt._backoffLv = lv;
            rSt._lastBackoffAt = n2;
            const backoffMs = Math.min(30000, (1000 * (2 ** (lv - 1))) | 0);
            const until = n2 + backoffMs + ((Math.random() * 220) | 0);
            rSt.suppressSyncUntil = Math.max(rSt.suppressSyncUntil || 0, until);
            rSt._setAttempts = 0;
          } else {
            if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
          }
        });
      } else {
        if ((rSt._backoffLv | 0) > 0) rSt._backoffLv = Math.max(0, (rSt._backoffLv | 0) - 1);
      }
    });
    touchedAdd(TOUCHED.rateVideos, el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, isNeutralParams, isNeutralShadow, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget }) {
    const candidates = scratch;
    candidates.clear();

    const addV = (v) => { if (v) candidates.add(v); };
    dirtyVideos.forEach(addV);
    applySet.forEach(addV);
    TOUCHED.videos.forEach(addV);
    TOUCHED.rateVideos.forEach(addV);

    const isApplyAll = !!getNS()?.Store?.get('app.applyAll');

    for (const el of candidates) {
      if (!el.isConnected) {
        TOUCHED.videos.delete(el);
        TOUCHED.rateVideos.delete(el);
        continue;
      }

      bindVideoOnce(el, ApplyReq);

      const st = getVState(el);
      const shouldApply = applySet.has(el) && (isApplyAll || st.visible !== false || el === activeTarget || isPiPActiveVideo(el));

      if (!shouldApply) {
        if (!st.applied && !st.fxBackend && st.desiredRate === undefined) continue;
        Adapter.clear(el);
        TOUCHED.videos.delete(el);
        st.desiredRate = undefined;
        restoreRateOne(el);
        TOUCHED.rateVideos.delete(el);
        continue;
      }

      const params = getParamsForVideo(el);
      const vVals = params.video;
      const shadowVals = params.shadow;

      const videoFxOn = !isNeutralParams(vVals) || !isNeutralShadow(shadowVals);

      if (videoFxOn) {
        Adapter.apply(el, vVals, shadowVals);
        touchedAdd(TOUCHED.videos, el);
      } else {
        Adapter.clear(el);
        TOUCHED.videos.delete(el);
      }

      if (pbActive) {
        applyPlaybackRate(el, desiredRate);
      } else {
        if (st.desiredRate !== undefined) {
          st.desiredRate = undefined;
          restoreRateOne(el);
          TOUCHED.rateVideos.delete(el);
        }
      }
    }
  }

  const FIXED_TEMP = -7;
  const { rs: FIXED_RS, gs: FIXED_GS, bs: FIXED_BS } = tempToRgbGain(FIXED_TEMP);

  function createVideoParamsMemo() {
    function computePreScaling(video) {
      if (!video) return { sharpScale: 1.0, clarityScale: 1.0, sigmaScale: 1.0, refW: 1920 };

      const nativeW = video.videoWidth  || 0;
      const nativeH = video.videoHeight || 0;
      const displayW = video.clientWidth  || video.offsetWidth  || 0;
      const displayH = video.clientHeight || video.offsetHeight || 0;

      if (nativeW < 16 || displayW < 16) {
        return { sharpScale: 1.0, clarityScale: 1.0, sigmaScale: 1.0, refW: 1920 };
      }

      const scaleRatioW = displayW / nativeW;
      const scaleRatioH = displayH / Math.max(1, nativeH);
      const scaleRatio = Math.max(scaleRatioW, scaleRatioH);

      let sharpScale, clarityScale;
      if (scaleRatio >= 1.0) {
        const t = VSC_CLAMP((scaleRatio - 1.0) / 2.0, 0, 1);
        sharpScale  = 1.0 + t * 0.4;
        clarityScale = 1.0 + t * 0.3;
      } else {
        const t = VSC_CLAMP((1.0 - scaleRatio) / 0.5, 0, 1);
        sharpScale  = 1.0 - t * 0.4;
        clarityScale = 1.0 - t * 0.3;
      }

      const refW = Math.max(640, Math.min(3840, displayW));
      const sigmaScale = Math.sqrt(refW / 1920);

      return { sharpScale, clarityScale, sigmaScale, refW };
    }

    const _preScaleCache = new WeakMap();

    function getPreScaling(video) {
      if (!video) return { sharpScale: 1.0, clarityScale: 1.0, sigmaScale: 1.0, refW: 1920 };

      const cached = _preScaleCache.get(video);
      const nW = video.videoWidth || 0;
      const nH = video.videoHeight || 0;
      const dW = video.clientWidth || video.offsetWidth || 0;
      const dH = video.clientHeight || video.offsetHeight || 0;

      if (cached && cached._nW === nW && cached._nH === nH && cached._dW === dW && cached._dH === dH) {
        return cached;
      }

      const result = computePreScaling(video);
      result._nW = nW;
      result._nH = nH;
      result._dW = dW;
      result._dH = dH;
      _preScaleCache.set(video, result);
      return result;
    }

    const _cache = new Map();
    const MAX_MEMO = 16;

    return {
      get(vfUser, video) {
        const nW = video?.videoWidth || 0;
        const nH = video?.videoHeight || 0;
        const dW = video?.clientWidth || video?.offsetWidth || 0;
        const dH = video?.clientHeight || video?.offsetHeight || 0;

        const inputKey = [
          vfUser.presetS,
          vfUser.presetB,
          vfUser.shadowBandMask,
          vfUser.brightStepLevel,
          nW, nH, dW, dH
        ].join('|');

        const cached = _cache.get(inputKey);
        if (cached) return cached;

        const detailP = PRESETS.detail[vfUser.presetS || 'off'];
        const gradeP  = PRESETS.grade[vfUser.presetB || 'brOFF'];

        const ps = getPreScaling(video);

        const videoOut = {
          sharp:    Math.round((detailP.sharpAdd  || 0) * ps.sharpScale),
          sharp2:   Math.round((detailP.sharp2Add || 0) * ps.sharpScale),
          clarity:  Math.round((detailP.clarityAdd || 0) * ps.clarityScale),
          satF:     detailP.sat || 1.0,
          gamma:    gradeP.gammaF || 1.0,
          bright:   gradeP.brightAdd || 0,
          contrast: 1.0,
          temp:     FIXED_TEMP,
          gain:     1.0,
          mid:      0,
          toe:      0,
          shoulder: 0,
          _sigmaScale: ps.sigmaScale,
          _refW: ps.refW,
          _rs: FIXED_RS, _gs: FIXED_GS, _bs: FIXED_BS
        };

        const brStep = vfUser.brightStepLevel || 0;
        if (brStep > 0) {
          videoOut.bright += brStep * 3.5;
          videoOut.gamma *= (1.0 + brStep * 0.025);
        }

        const sLevel = VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0;
        let shadowOut = { level: 0, active: false };

        if (sLevel > 0) {
          shadowOut = { level: sLevel, active: true };
        }

        const result = { video: videoOut, shadow: shadowOut };
        if (_cache.size >= MAX_MEMO) {
          const oldest = _cache.keys().next().value;
          _cache.delete(oldest);
        }
        _cache.set(inputKey, result);
        return result;
      }
    };
  }

  function isNeutralVideoParams(p) {
    const near = (a, b, eps = 1e-4) => Math.abs((a || 0) - b) <= eps;
    return (
      (p.sharp|0) === 0 && (p.sharp2|0) === 0 && (p.clarity|0) === 0 &&
      near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) &&
      near(p.satF, 1.0) &&
      near(p.temp, FIXED_TEMP) &&
      near(p._rs, FIXED_RS) &&
      near(p._gs, FIXED_GS) &&
      near(p._bs, FIXED_BS) &&
      near(p.gain, 1.0) &&
      near(p.mid, 0.0) && near(p.toe, 0.0) && near(p.shoulder, 0.0)
    );
  }

  function isNeutralShadowParams(sp) {
    return !sp || !sp.active;
  }

  let __vscUserSignalRev = 0;

  function createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting }) {
    UI.ensure(); Store.sub(P.APP_UI, () => { UI.ensure(); Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });

    let __activeTarget = null, __lastApplyTarget = null, __lastAudioTarget = null;
    let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;
    const videoParamsMemo = createVideoParamsMemo();

    const _applySet = new Set();
    const _scratchCandidates = new Set();

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;

        if (!active) {
          for (const v of TOUCHED.videos) { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); }
          for (const v of TOUCHED.rateVideos) { getVState(v).desiredRate = undefined; restoreRateOne(v); }
          TOUCHED.videos.clear();
          TOUCHED.rateVideos.clear();
          Audio.update();
          __lastAudioTarget = null;
          return;
        }

        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        let pick = Targeting.pickFastActiveOnly(visible.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) { pick = Targeting.pickFastActiveOnly(Registry.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow); }
        if (!pick?.target) {
          let domV = null;
          try {
            const list = Array.from(document.querySelectorAll('video'));
            domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null;
          } catch (_) {}
          pick = { target: domV };
        }

        let nextTarget = pick.target;
        if (!nextTarget) { if (__activeTarget) nextTarget = __activeTarget; } if (nextTarget !== __activeTarget) __activeTarget = nextTarget;
        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now();
        const dirtySize = vidsDirty.size;
        if (dirtySize > 40 || (now - lastPrune > 2000)) {
          Registry.prune();
          getNS()?.ZoomManager?.pruneDisconnected?.();
          lastPrune = now;
        }

        const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.()) ? (__activeTarget || null) : null;
        if (nextAudioTarget !== __lastAudioTarget) { Audio.setTarget(nextAudioTarget); __lastAudioTarget = nextAudioTarget; } Audio.update();

        const vf0 = Store.getCatRef('video');
        const autoScene = getNS()?.AutoScene;
        const isAutoSceneActive = autoScene && Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT);
        const mods = isAutoSceneActive ? autoScene.getMods() : null;

        const getParamsForVideo = (el) => {
          const rawParams = videoParamsMemo.get(vf0, el);
          let videoParams = rawParams.video;
          let shadowParams = rawParams.shadow;

          if (mods && (mods.br !== 1.0 || mods.ct !== 1.0 || mods.sat !== 1.0 || mods.sharpScale !== 1.0)) {
            const autoSceneVVals = { ...videoParams };
            const uBr = autoSceneVVals.gain || 1.0, aSF = Math.max(0.2, 1.0 - Math.abs(uBr - 1.0) * 3.0);
            autoSceneVVals.gain = uBr * (1.0 + (mods.br - 1.0) * aSF);
            autoSceneVVals.contrast = (autoSceneVVals.contrast || 1.0) * (1.0 + (mods.ct - 1.0) * aSF);
            autoSceneVVals.satF = (autoSceneVVals.satF || 1.0) * (1.0 + (mods.sat - 1.0) * aSF);
            const userSharpTotal = (autoSceneVVals.sharp || 0) + (autoSceneVVals.sharp2 || 0) + (autoSceneVVals.clarity || 0), sharpASF = Math.max(0.3, 1.0 - (userSharpTotal / 80) * 0.5);
            const combinedSharpScale = (1.0 + (mods.sharpScale - 1.0) * sharpASF);
            autoSceneVVals.sharp = (autoSceneVVals.sharp || 0) * combinedSharpScale;
            autoSceneVVals.sharp2 = (autoSceneVVals.sharp2 || 0) * combinedSharpScale;
            autoSceneVVals.clarity = (autoSceneVVals.clarity || 0) * combinedSharpScale;
            videoParams = autoSceneVVals;
          }
          return { video: videoParams, shadow: shadowParams };
        };

        const applyToAllVisibleVideos = !!Store.get(P.APP_APPLY_ALL);
        _applySet.clear();

        if (applyToAllVisibleVideos) {
          for (const v of Registry.visible.videos) _applySet.add(v);
        } else if (__activeTarget) {
          _applySet.add(__activeTarget);
        }

        const desiredRate = Store.get(P.PB_RATE);
        reconcileVideoEffects({
          applySet: _applySet,
          dirtyVideos: vidsDirty,
          getParamsForVideo,
          isNeutralParams: isNeutralVideoParams,
          isNeutralShadow: isNeutralShadowParams,
          desiredRate,
          pbActive,
          Adapter,
          ApplyReq,
          scratch: _scratchCandidates,
          activeTarget: __activeTarget
        });

        UI.ensure();
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisibilityHandler = null;
    const startTick = () => {
      stopTick(); tickVisibilityHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) { Scheduler.request(false); } };
      document.addEventListener('visibilitychange', tickVisibilityHandler, { passive: true });
      tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000);
    };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; if (tickVisibilityHandler) { document.removeEventListener('visibilitychange', tickVisibilityHandler); tickVisibilityHandler = null; } };

    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();

    return Object.freeze({
      getActiveVideo() {
        if (__activeTarget && __activeTarget.isConnected) return __activeTarget;
        let domV = null;
        try {
          const list = Array.from(document.querySelectorAll('video'));
          domV = list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null;
        } catch (_) {}
        if (domV && domV !== __activeTarget) {
          __activeTarget = domV;
          queueMicrotask(() => { if (__activeTarget === domV) Scheduler.request(false); });
        }
        return domV || __activeTarget || null;
      },
      getQualityScale() { return 1.0; },
      destroy() {
        stopTick();
        safe(() => UI.destroy?.());
        safe(() => { Audio.setTarget(null); Audio.destroy?.(); });
        safe(() => getNS()?.AutoScene?.destroy?.());
        safe(() => getNS()?.ZoomManager?.destroy?.());
        safe(() => getNS()?.TimerManager?.destroy?.());
        safe(() => Registry.destroy?.());

        safe(() => {
          for (const v of TOUCHED.videos) { try { Adapter.clear(v); } catch(_){} }
          for (const v of TOUCHED.rateVideos) { try { restoreRateOne(v); } catch(_){} }
          TOUCHED.videos.clear();
          TOUCHED.rateVideos.clear();
        });
      }
    });
  }

  function createTimerManager(Store, P) {
    let timerEl = null;
    let intervalId = null;

    function updateTimer() {
      const act = Store.get(P.APP_ACT);
      const timeEn = Store.get(P.APP_TIME_EN);
      const isFs = !!document.fullscreenElement;

      if (!act || !timeEn || !isFs) {
        if (timerEl) timerEl.style.display = 'none';
        return;
      }

      const activeVideo = getNS()?.App?.getActiveVideo();
      if (!activeVideo || !activeVideo.isConnected) {
        if (timerEl) timerEl.style.display = 'none';
        return;
      }

      const parent = activeVideo.parentNode;
      if (!parent) return;

      if (!timerEl || timerEl.parentNode !== parent) {
        if (timerEl) { try { timerEl.remove(); } catch(_) {} }
        timerEl = document.createElement('div');
        timerEl.className = 'vsc-fs-timer';
        const stroke = getNS()?.getSmoothStroke('#000000');
        timerEl.style.cssText = `
          position: absolute;
          z-index: 2147483647;
          color: #FFE600;
          font-family: 'LXGW WenKai Mono TC', ui-monospace, Consolas, monospace;
          font-weight: bold;
          pointer-events: none;
          user-select: none;
          font-variant-numeric: tabular-nums;
          letter-spacing: 1px;
          ${stroke}
          transition: opacity 0.2s;
          opacity: 0.5;
        `;
        parent.appendChild(timerEl);
      }

      timerEl.style.display = 'block';

      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
      if (timerEl.textContent !== timeStr) timerEl.textContent = timeStr;

      const vRect = activeVideo.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      const vWidth = vRect.width;

      let dynamicSize = 24;
      if (vWidth >= 2500) dynamicSize = 36;
      else if (vWidth >= 1900) dynamicSize = 30;
      else if (vWidth >= 1200) dynamicSize = 24;
      else dynamicSize = 18;
      timerEl.style.fontSize = `${dynamicSize}px`;

      const topOffset = vWidth > 1200 ? 16 : 8;
      const top = (vRect.top - pRect.top) + topOffset;
      timerEl.style.top = `${top > topOffset ? top : topOffset}px`;

      const pos = Store.get(P.APP_TIME_POS);
      const edgeMargin = vWidth > 1200 ? 20 : 10;

      if (pos === 0) {
        const left = (vRect.left - pRect.left) + edgeMargin;
        timerEl.style.left = `${left > edgeMargin ? left : edgeMargin}px`;
        timerEl.style.right = 'auto';
        timerEl.style.transform = 'none';
      } else if (pos === 1) {
        const left = (vRect.left - pRect.left) + (vRect.width / 2);
        timerEl.style.left = `${left}px`;
        timerEl.style.right = 'auto';
        timerEl.style.transform = 'translateX(-50%)';
      } else {
        const right = (pRect.right - vRect.right) + edgeMargin;
        timerEl.style.right = `${right > edgeMargin ? right : edgeMargin}px`;
        timerEl.style.left = 'auto';
        timerEl.style.transform = 'none';
      }
    }

    intervalId = setInterval(updateTimer, 1000);
    if (typeof __vscNs !== 'undefined' && __vscNs._intervals) __vscNs._intervals.push(intervalId);

    return {
      destroy: () => { if (intervalId) clearInterval(intervalId); if (timerEl) { try { timerEl.remove(); } catch (_) {} } }
    };
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(32);
  const Store = createLocalStore(DEFAULTS, Scheduler);

  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const isTop = (window.top === window);

  if (isTop && typeof GM_registerMenuCommand === 'function') {
    const reg = (title, fn) => {
      const id = GM_registerMenuCommand(title, fn);
      if (__vscNs._menuIds) __vscNs._menuIds.push(id);
    };

    reg('🔄 설정 초기화 (Reset All)', () => {
      if(confirm('모든 VSC 설정을 초기화하시겠습니까? (현재 도메인)')) {
        const key = 'vsc_prefs_' + location.hostname;
        if(typeof GM_deleteValue === 'function') GM_deleteValue(key);
        localStorage.removeItem(key);
        location.reload();
      }
    });

    reg('⚡ Power 토글', () => { Store.set(P.APP_ACT, !Store.get(P.APP_ACT)); ApplyReq.hard(); });
    reg('🎬 AutoScene 토글', () => { Store.set(P.APP_AUTO_SCENE, !Store.get(P.APP_AUTO_SCENE)); ApplyReq.hard(); });
    reg('🔊 Audio 토글', () => { Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); });
    reg('⚙️ UI 열기/닫기', () => { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); });
    reg('🛠️ 디버그 모드 토글', () => {
      const url = new URL(location.href);
      if(url.searchParams.has('vsc_debug')) url.searchParams.delete('vsc_debug');
      else url.searchParams.set('vsc_debug', '1');
      location.href = url.toString();
    });
  }

  function bindNormalizer(keys, schema) {
    const run = () => {
      let changed = normalizeBySchema(Store, schema);
      if (changed) ApplyReq.hard();
    };
    keys.forEach(k => Store.sub(k, run)); run();
  }
  bindNormalizer(ALL_KEYS, ALL_SCHEMA);

  const Registry = createRegistry(Scheduler);
  const Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();

    __vscNs._timers = __vscNs._timers || [];
    const lateRescanDelays = [3000, 10000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => {
        safe(() => {
          if (delay > 3000 && Registry.videos.size > 0) return;
          Registry.rescanAll(); Scheduler.request(true); safe(() => getNS()?.UIEnsure?.());
        });
      }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    const AutoScene = createAutoSceneManager(Store, P, Scheduler); __vscNs.AutoScene = AutoScene;

    __vscNs.CONFIG = CONFIG;
    __vscNs.FLAGS = Object.freeze({ ...FLAGS });

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter;

    const Audio = createAudio(Store);
    __vscNs.AudioWarmup = Audio.warmup;
    __vscNs.AudioSetTarget = (v) => {
      try {
        Audio.setTarget(v || null);
        Audio.update();
      } catch (_) {}
    };

    let ZoomManager = createZoomManager(Store, P); __vscNs.ZoomManager = ZoomManager;

    const UI = createUI(Store, Registry, ApplyReq, Utils, P);

    const TimerManager = createTimerManager(Store, P); __vscNs.TimerManager = TimerManager;

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT< 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false)); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
      on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
    }

    const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, ApplyReq, Adapter, Audio, UI, Utils, P, Targeting });
    __vscNs.App = __VSC_APP__;

    if (getFLAGS().SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) {
      const can = typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      if (can) __vscNs._schedAlignRvfc = true;
    }
    Scheduler.setRvfcSource(() => __VSC_APP__.getActiveVideo() || null);

    AutoScene.start();
    ApplyReq.hard();

    on(window, 'keydown', async (e) => {
      const isEditableTarget = (el) => { if(!el) return false; const tag = el.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable; };
      if (isEditableTarget(e.target)) return;
      if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); safe(() => { const st = getNS()?.Store; if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); } }); return; }
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        if (!getNS()?.Store?.get(P.APP_ACT)) return;
        e.preventDefault(); e.stopPropagation();
        const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v);
      }
    }, { capture: true });

    on(document, 'visibilitychange', () => { safe(() => checkAndCleanupClosedPiP()); safe(() => { if (document.visibilityState === 'visible') getNS()?.ApplyReq?.hard(); }); }, OPT_P);
    window.addEventListener('beforeunload', () => { safe(() => __VSC_APP__?.destroy()); }, { once: true });
  });

}
VSC_MAIN();
})();
