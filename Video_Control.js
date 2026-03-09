// ==UserScript==
// @name         Video_Control (v182.3 - EventBus & Feature Architecture)
// @namespace    https://github.com/
// @version      182.3
// @description  Video Control: Modern Scheduling, Visibility, PiP Preserve, Zero-Fat, Content-Aware, EventBus.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @exclude      *://claude.ai/*
// @exclude      *://arena.ai/*
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

  const SCRIPT_VERSION = '182.3';

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

  const safe = (fn) => {
    try { fn(); }
    catch (e) { if (/[?&]vsc_debug=1/.test(location.search)) console.warn('[VSC] safe() caught:', e); }
  };

  function destroyRuntime(ns = __vscNs) {
    if (!ns || ns.__destroying) return;
    ns.__destroying = true;

    try { clearRuntimeTimers(ns); } catch (_) {}

    try { ns.App?.destroy?.(); } catch (_) {}
    try { ns.Features?.destroyAll?.(); } catch (_) {}
    try { ns.Store?.destroy?.(); } catch (_) {}
    try { ns.Registry?.destroy?.(); } catch (_) {}

    try { ns._spaNavAC?.abort?.(); } catch (_) {}
    try { ns._globalHooksAC?.abort?.(); } catch (_) {}

    try { ns._restoreHistory?.(); } catch (_) {}
    try { ns._restoreAttachShadow?.(); } catch (_) {}

    const snapshot = [...DISPOSERS];
    DISPOSERS.clear();
    for (let i = snapshot.length - 1; i >= 0; i--) { safe(snapshot[i]); }

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
    SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO: true,
    FILTER_SHARP_SAT_COMP: false,
    FILTER_FORCE_OPAQUE_BG: true
  });
  __vscNs.FLAGS = FLAGS;

  const PIP_FLAGS = Object.freeze({ USE_LEGACY_PIP_FALLBACK: true });
  const PLAYER_CONTAINER_SELECTORS = '.html5-video-player, #movie_player, .shaka-video-container, .dplayer-video-wrap, .vjs-container, .video-js, [class*="player" i], [id*="player" i], [data-player], article, main';

  const getNS = () => (window && window[Symbol.for('__VSC__')]) || __vscNs || null;
  const getFLAGS = () => getNS()?.FLAGS || FLAGS;
  const OPT_P = { passive: true };
  const OPT_PC = { passive: true, capture: true };

  const combineSignals = (...signals) => {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
    const ac = new AbortController();
    for (const sig of signals) {
      if (sig.aborted) { ac.abort(sig.reason); return ac.signal; }
      sig.addEventListener('abort', () => ac.abort(sig.reason), { once: true });
    }
    return ac.signal;
  };

  function on(target, type, fn, opts = {}) {
    if (!target?.addEventListener) return;
    const merged = { ...opts };
    if (!merged.signal) merged.signal = __globalSig;
    try { target.addEventListener(type, fn, merged); }
    catch (_) { try { target.addEventListener(type, fn, !!merged.capture); } catch (__) {} }
  }

  const getSmoothStroke = (color = '#000') => `-webkit-text-stroke: 1.5px ${color}; paint-order: stroke fill;`;
  __vscNs.getSmoothStroke = getSmoothStroke;

  const blockInterference = (el) => {
    if (!el) return;
    const stop = (e) => { e.stopPropagation(); };
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'dblclick'].forEach(evt => {
      on(el, evt, stop, { passive: false });
    });
  };
  __vscNs.blockInterference = blockInterference;

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

    try { Object.defineProperty(proto, 'attachShadow', { ...desc, value: patched }); }
    catch (_) { try { proto.attachShadow = patched; } catch (__) {} }

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
      run(); return () => localAC.abort();
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

  // =========================================================================
  // 🚀 [VSC v181.1 아키텍처 인프라]
  // =========================================================================

  function createEventBus() {
    const _listeners = new Map();
    const _onceListeners = new Map();
    let _destroyed = false;
    const MAX_LISTENERS = 30;

    function _getOrCreate(map, event) {
      let set = map.get(event);
      if (!set) { set = new Set(); map.set(event, set); }
      return set;
    }

    return Object.freeze({
      on(event, handler) {
        if (_destroyed || typeof handler !== 'function') return () => {};
        const set = _getOrCreate(_listeners, event);
        if (set.size >= MAX_LISTENERS) console.warn(`[VSC Bus] Too many listeners for "${event}"`);
        set.add(handler);
        return () => set.delete(handler);
      },
      once(event, handler) {
        if (_destroyed || typeof handler !== 'function') return () => {};
        _getOrCreate(_onceListeners, event).add(handler);
        return () => _onceListeners.get(event)?.delete(handler);
      },
      emit(event, data) {
        if (_destroyed) return;
        const set = _listeners.get(event);
        if (set) for (const fn of set) { try { fn(data); } catch (e) { console.warn('[VSC Bus]', event, e); } }
        const onceSet = _onceListeners.get(event);
        if (onceSet?.size) {
          const snap = [...onceSet]; onceSet.clear();
          for (const fn of snap) { try { fn(data); } catch (e) { console.warn('[VSC Bus once]', event, e); } }
        }
        const wc = _listeners.get('*');
        if (wc) for (const fn of wc) { try { fn({ event, data }); } catch (_) {} }
      },
      off(event, handler) {
        if (handler) { _listeners.get(event)?.delete(handler); _onceListeners.get(event)?.delete(handler); }
        else { _listeners.delete(event); _onceListeners.delete(event); }
      },
      destroy() { _destroyed = true; _listeners.clear(); _onceListeners.clear(); },
      _stats() { const out = {}; for (const [k, v] of _listeners) out[k] = v.size; return out; }
    });
  }

  const PHASE = Object.freeze({
    COMPUTE: 0,
    PROCESS: 1,
    RENDER:  2
  });

  function defineFeature(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) {
      throw new Error('[VSC defineFeature] "name" is required');
    }
    const _name = spec.name;
    const _phase = (typeof spec.phase === 'number') ? spec.phase : PHASE.PROCESS;
    let _deps = null;
    let _initialized = false;
    let _destroyed = false;
    const _unsubs = [];

    const _helpers = Object.freeze({
      subscribe(event, handler) {
        if (!_deps) throw new Error(`[VSC ${_name}] subscribe() called before init()`);
        const unsub = _deps.bus.on(event, handler);
        _unsubs.push(unsub);
        return unsub;
      },
      emit(event, data) { if (_deps) _deps.bus.emit(event, data); },
      getSetting(path) { return _deps?.store?.get(path); },
      setSetting(path, value) { _deps?.store?.set(path, value); },
      getActiveVideo() { return _deps?.getActiveVideo?.() || null; }
    });

    const module = {
      getName() { return _name; },
      init(deps) {
        if (_initialized) return;
        _deps = deps; _initialized = true; _destroyed = false;
        if (typeof spec.onInit === 'function') spec.onInit.call(_helpers, deps);
      },
      update(ctx) {
        if (!_initialized || _destroyed) return;
        if (typeof spec.onUpdate === 'function') spec.onUpdate.call(_helpers, ctx);
      },
      destroy() {
        if (_destroyed) return;
        _destroyed = true; _initialized = false;
        if (typeof spec.onDestroy === 'function') {
          try { spec.onDestroy.call(_helpers); } catch (e) { console.warn(`[VSC ${_name}] onDestroy error:`, e); }
        }
        for (let i = _unsubs.length - 1; i >= 0; i--) { try { _unsubs[i](); } catch (_) {} }
        _unsubs.length = 0; _deps = null;
      },
      getPhase() { return _phase; },
      isInitialized() { return _initialized; },
      isDestroyed() { return _destroyed; }
    };

    if (spec.methods && typeof spec.methods === 'object') {
      const RESERVED = new Set(['getName', 'init', 'update', 'destroy', 'getPhase', 'isInitialized', 'isDestroyed']);
      for (const [key, fn] of Object.entries(spec.methods)) {
        if (RESERVED.has(key)) throw new Error(`[VSC defineFeature] "${key}" is reserved`);
        if (typeof fn !== 'function') throw new Error(`[VSC defineFeature] methods.${key} must be a function`);
        module[key] = fn;
      }
    }
    return Object.freeze(module);
  }

  function createFeatureRegistry(bus) {
    const _modules = new Map();
    let _initialized = false;
    let _sortedCache = null;
    let _sortDirty = true;

    function _validate(mod) {
      const req = ['getName', 'init', 'update', 'destroy'];
      for (const m of req) if (typeof mod[m] !== 'function') throw new Error(`[VSC] Missing ${m}()`);
    }

    function _getSorted() {
      if (!_sortDirty && _sortedCache) return _sortedCache;
      const entries = [..._modules.entries()];
      entries.sort((a, b) => {
        const pA = a[1].getPhase ? a[1].getPhase() : PHASE.PROCESS;
        const pB = b[1].getPhase ? b[1].getPhase() : PHASE.PROCESS;
        return pA - pB;
      });
      _sortedCache = entries; _sortDirty = false;
      return entries;
    }

    return Object.freeze({
      register(module) {
        _validate(module);
        const name = module.getName();
        if (_modules.has(name)) { try { _modules.get(name).destroy(); } catch (_) {} }
        _modules.set(name, module);
        _sortDirty = true;
      },
      initAll(deps) {
        if (_initialized) return;
        _initialized = true;
        for (const [name, mod] of _getSorted()) {
          try { mod.init(deps); } catch (e) { console.warn(`[VSC] "${name}" init failed:`, e); }
        }
        bus.emit('features:initialized', { count: _modules.size, names: _getSorted().map(([n]) => n) });
      },
      updateAll(ctx) {
        for (const [name, mod] of _getSorted()) {
          try { mod.update(ctx); } catch (e) { if (ctx.force) console.warn(`[VSC] "${name}" update failed:`, e); }
        }
      },
      destroyAll() {
        const entries = [..._getSorted()].reverse();
        for (const [name, mod] of entries) {
          try { mod.destroy(); } catch (e) { console.warn(`[VSC] "${name}" destroy:`, e); }
        }
        _modules.clear(); _sortedCache = null; _sortDirty = true; _initialized = false;
      },
      get(name) { return _modules.get(name) || null; },
      list() { return _getSorted().map(([n]) => n); },
      _debugOrder() { return _getSorted().map(([n, m]) => ({ name: n, phase: m.getPhase?.() ?? 1 })); }
    });
  }

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
        visible: false, bound: false, applied: false, desiredRate: undefined,
        audioFailUntil: 0, _lastSrc: '', _ac: null
      };
      videoStateMap.set(v, st);
    }
    return st;
  };

  const DARK_BAND = Object.freeze({ LV1: 1, LV2: 2, LV3: 3 });

  const PRESETS = Object.freeze({
    detail: {
      off: { sharpAdd: 0, sharp2Add: 0, sat: 1.0, microBase: 0.16, microScale: 1/120, fineBase: 0.32, fineScale: 1/24, microAmt: [0.55, 0.10], fineAmt: [0.20, 0.85] },
      Soft: { sharpAdd: 13, sharp2Add: 15, sat: 1.0, microBase: 0.24, microScale: 1/150, fineBase: 0.44, fineScale: 1/28, microAmt: [0.40, 0.08], fineAmt: [0.15, 0.65] },
      Medium: { sharpAdd: 26, sharp2Add: 28, sat: 1.0, microBase: 0.22, microScale: 1/120, fineBase: 0.40, fineScale: 1/24, microAmt: [0.50, 0.10], fineAmt: [0.18, 0.80] },
      Ultra: { sharpAdd: 39, sharp2Add: 38, sat: 0.99, microBase: 0.20, microScale: 1/100, fineBase: 0.36, fineScale: 1/20, microAmt: [0.55, 0.12], fineAmt: [0.20, 0.85] },
      Master: { sharpAdd: 52, sharp2Add: 48, sat: 0.98, microBase: 0.18, microScale: 1/90, fineBase: 0.32, fineScale: 1/18, microAmt: [0.55, 0.14], fineAmt: [0.22, 0.90] }
    },
    bright: {
      0: { gammaF: 1.00, brightAdd: 0 },
      1: { gammaF: 1.02, brightAdd: 1.0 },
      2: { gammaF: 1.05, brightAdd: 2.5 },
      3: { gammaF: 1.10, brightAdd: 5.5 },
      4: { gammaF: 1.18, brightAdd: 9.5 },
      5: { gammaF: 1.28, brightAdd: 14.5 }
    }
  });

  const DEFAULTS = {
    video: { presetS: 'off', brightLevel: 0, shadowBandMask: 0, temp: 0 },
    audio: { enabled: false, boost: 0, multiband: true, lufs: true, dialogue: false, stereoWidth: false },
    playback: { rate: 1.0, enabled: false },
    app: { active: true, uiVisible: false, applyAll: true, zoomEn: false, advanced: false, timeEn: true, timePos: 1 }
  };

  const P = Object.freeze({
    APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_ADV: 'app.advanced',
    APP_TIME_EN: 'app.timeEn', APP_TIME_POS: 'app.timePos',
    V_PRE_S: 'video.presetS', V_BRIGHT_LV: 'video.brightLevel',
    V_SHADOW_MASK: 'video.shadowBandMask', V_TEMP: 'video.temp',
    A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue', A_STEREO_W: 'audio.stereoWidth',
    PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
  });

  const APP_SCHEMA = [
    { type: 'bool', path: P.APP_ACT }, { type: 'bool', path: P.APP_UI }, { type: 'bool', path: P.APP_APPLY_ALL },
    { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_TIME_EN },
    { type: 'num', path: P.APP_TIME_POS, min: 0, max: 2, round: true, fallback: () => 1 }
  ];
  const VIDEO_SCHEMA = [
    { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS },
    { type: 'num', path: P.V_BRIGHT_LV, min: 0, max: 5, round: true, fallback: () => 0 },
    { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 3, round: true, fallback: () => 0 },
    { type: 'num', path: P.V_TEMP, min: -50, max: 50, round: true, fallback: () => 0 }
  ];
  const AUDIO_PLAYBACK_SCHEMA = [
    { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => 0 },
    { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE }, { type: 'bool', path: P.A_STEREO_W },
    { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate }
  ];
  const ALL_SCHEMA = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];
  const ALL_KEYS = ALL_SCHEMA.map(s => s.path);

  class BoundedWeakSet {
    constructor(maxSize, onEvict) {
      this._set = new Set();
      this._max = maxSize;
      this._onEvict = onEvict;
    }
    add(el) {
      if (!el) return;
      if (this._set.has(el)) { this._set.delete(el); this._set.add(el); return; }
      if (this._set.size >= this._max) {
        const oldest = this._set.keys().next().value;
        this._set.delete(oldest);
        this._onEvict?.(oldest);
      }
      this._set.add(el);
    }
    has(el) { return this._set.has(el); }
    delete(el) { return this._set.delete(el); }
    clear() { this._set.clear(); }
    get size() { return this._set.size; }
    [Symbol.iterator]() { return this._set[Symbol.iterator](); }
    forEach(fn) { this._set.forEach(fn); }
  }

  const TOUCHED = {
    videos: new BoundedWeakSet(300, (el) => safe(() => getNS()?.Adapter?.clear(el))),
    rateVideos: new BoundedWeakSet(300, (el) => {
      const st = getVState(el);
      if (st) st.desiredRate = undefined;
      safe(() => { if (typeof restoreRateOne === 'function') restoreRateOne(el); });
    })
  };

  function getRectCached(v, now) {
    const st = getVState(v);
    if (st.rect && st._rectRev === __vscLayoutRev) return st.rect;
    const fresh = v.getBoundingClientRect();
    st.rect = fresh; st.rectT = now; st._rectRev = __vscLayoutRev;
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
      __vscNs._origHistoryFns = { pushState: history.pushState, replaceState: history.replaceState };
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
        if (cur && cur.__vsc_wrapped && cur.__vsc_orig === orig) history[name] = orig;
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
      if (typeof orig !== 'function' || orig.__vsc_wrapped) return;
      const wrapped = function (...args) {
        const ret = Reflect.apply(orig, this, args);
        queueMicrotask(emitIfChanged);
        return ret;
      };
      wrapped.__vsc_wrapped = true; wrapped.__vsc_orig = orig; wrapped.__vsc_owner = CONFIG.VSC_ID;
      try { Object.defineProperty(history, name, { value: wrapped, configurable: true, writable: true, enumerable: true }); }
      catch (_) { try { history[name] = wrapped; } catch (__) {} }
    };

    wrap('pushState'); wrap('replaceState');
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
      lastRun = now;
      if (applyFn) {
        if (typeof scheduler !== 'undefined' && scheduler.postTask && !doForce) {
          scheduler.postTask(() => { try { applyFn(doForce); } catch (_) {} }, { priority: 'user-visible' }).catch(() => {});
        } else {
          try { applyFn(doForce); } catch (_) {}
        }
      }
    }

    function timerCb() { timer = 0; run(); }
    function queueRaf() { if (!rafId) rafId = requestAnimationFrame(run); }

    function shouldAlignToVideoFrames() {
      const flags = getFLAGS();
      if (flags.SCHED_ALIGN_TO_VIDEO_FRAMES) return true;
      if (!flags.SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) return !!getNS()?._schedAlignRvfc;
      const v = getRvfcVideo?.();
      return !!(v && !v.paused && !v.ended && v.readyState >= 2 && document.visibilityState === 'visible' && typeof v.requestVideoFrameCallback === 'function');
    }

    function queueRvfc() {
      if (!shouldAlignToVideoFrames() || rvfcId) return false;
      const v = getRvfcVideo?.();
      if (!v || typeof v.requestVideoFrameCallback !== 'function') return false;

      const tok = ++rvfcTok;
      rvfcVideo = v;
      rvfcId = v.requestVideoFrameCallback(() => {
        if (tok !== rvfcTok) return;
        rvfcId = 0; rvfcVideo = null; run();
      });
      return true;
    }

    const request = (immediate = false) => {
      if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; }
      if (queued) return;
      queued = true; clearPending();
      if (!queueRvfc()) queueRaf();
    };

    return { registerApply: (fn) => { applyFn = fn; }, request, setRvfcSource: (fn) => { getRvfcVideo = fn; }, destroy: () => { clearPending(); applyFn = null; } };
  }

  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };

  const STORAGE_FLAGS = Object.freeze({ ALLOW_LOCALSTORAGE_FALLBACK: true });

  function createLocalStore(defaults, scheduler, bus) {
    let _stateVal;
    try { _stateVal = structuredClone(defaults); } catch (_) { _stateVal = JSON.parse(JSON.stringify(defaults)); }
    const state = _stateVal;
    let rev = 0; const listeners = new Map();
    const storeAC = new AbortController();
    const storeSig = combineSignals(storeAC.signal, __globalSig);
    const PREF_KEY = 'vsc_prefs_' + location.hostname;

    function loadPrefs() {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(PREF_KEY, null); if (typeof v === 'string' && v) return v; } } catch (_) {}
      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { return localStorage.getItem(PREF_KEY); } catch (_) {} }
      return null;
    }

    function savePrefsRaw(json) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(PREF_KEY, json); return true; } } catch (_) {}
      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { localStorage.setItem(PREF_KEY, json); return true; } catch (_) {} }
      return false;
    }

    function clearPrefsRaw() {
      let cleared = false;
      try { if (typeof GM_deleteValue === 'function') { GM_deleteValue(PREF_KEY); cleared = true; } } catch (_) {}
      if (STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { localStorage.removeItem(PREF_KEY); cleared = true; } catch (_) {} }
      return cleared;
    }

    function mergeKnown(dst, src, defaults) {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(defaults)) { if (Object.prototype.hasOwnProperty.call(src, key)) { dst[key] = src[key]; } }
    }

    try {
      const saved = loadPrefs();
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.video && !('brightLevel' in parsed.video)) { parsed.video.brightLevel = 0; }
        if (parsed.video && !('temp' in parsed.video)) { parsed.video.temp = 0; }
        mergeKnown(state.video, parsed.video, DEFAULTS.video);
        mergeKnown(state.audio, parsed.audio, DEFAULTS.audio);
        mergeKnown(state.playback, parsed.playback, DEFAULTS.playback);
        mergeKnown(state.app, parsed.app, DEFAULTS.app);
      }
    } catch (e) { log.warn('Invalid prefs detected. Resetting persisted prefs.', e); clearPrefsRaw(); }

    let _saveFailCount = 0; let _lastSavedJson = ''; const MAX_SAVE_RETRIES = 5; let _saveDisabledUntil = 0;

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
    const flushNow = () => { savePrefs.cancel(); _doSave(); };

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }, { passive: true, signal: storeSig });
    on(window, 'pagehide', flushNow, { passive: true, signal: storeSig });
    on(window, 'beforeunload', flushNow, { once: true, signal: storeSig });

    const emit = (path, val) => {
      const cbs = listeners.get(path); if (cbs) { for (const cb of cbs) safe(() => cb(val)); }
      const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) { for (const cb of cbsStar) safe(() => cb(val)); } }
    };
    const notifyChange = (path, val) => {
      rev++; emit(path, val);
      if (bus) bus.emit('settings:changed', { path, value: val });
      savePrefs(); scheduler.request(false);
    };

    return {
      state, rev: () => rev, getCatRef: (cat) => state[cat],
      get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; },
      set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); },
      batch: (cat, obj) => {
        let changed = false;
        for (const [k, v] of Object.entries(obj)) {
          if (state[cat][k] !== v) {
            state[cat][k] = v; changed = true;
            emit(`${cat}.${k}`, v);
            if (bus) bus.emit('settings:changed', { path: `${cat}.${k}`, value: v });
          }
        }
        if (changed) { rev++; savePrefs(); scheduler.request(false); }
      },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); },
      destroy: () => { storeAC.abort(); savePrefs.cancel(); try { _doSave(); } catch (_) {} listeners.clear(); }
    };
  }

  function normalizeBySchema(sm, schema) {
    let changed = false;
    const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
    for (const { type, path, values, fallback, min, max, round } of schema) {
      switch (type) {
        case 'bool': set(path, !!sm.get(path)); break;
        case 'enum': { const cur = sm.get(path); if (!values.includes(cur)) set(path, fallback()); break; }
        case 'num': {
          let n = Number(sm.get(path));
          if (!Number.isFinite(n)) {
            n = fallback();
            if (!Number.isFinite(n)) n = min;
          }
          if (round) n = Math.round(n);
          set(path, Math.max(min, Math.min(max, n)));
          break;
        }
      }
    }
    return changed;
  }

  function createRegistry(scheduler, bus) {
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

    const IO_MARGIN_PX_DYNAMIC = CONFIG.IS_MOBILE ? 100 : Math.min(300, Math.round(innerHeight * 0.15));
    const ioMargin = `${IO_MARGIN_PX_DYNAMIC}px`;

    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; const isVis = e.isIntersecting || e.intersectionRatio > 0; const st = getVState(el);
        st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
        else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
        if (bus) bus.emit('video:visibility', { video: el, visible: isVis });
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

    function untrackVideo(v) {
      if (!v || v.tagName !== 'VIDEO') return;
      const wasTracked = videos.has(v);
      if (wasTracked) {
        videos.delete(v);
        if (bus) bus.emit('video:lost', { video: v });
      }
      visible.videos.delete(v);
      dirtyA.videos.delete(v);
      dirtyB.videos.delete(v);
      dirty.videos.add(v);
      safe(() => { io?.unobserve(v); ro?.unobserve(v); });
    }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0); videos.add(el);
      if (bus) bus.emit('video:detected', { video: el, isFirst: wasEmpty });
      // 🔥 UIEnsure 복원: 비디오 감지 시 UI 렌더링 생명줄
      if (wasEmpty) { queueMicrotask(() => { safe(() => __vscNs.UIEnsure?.()); }); }
      if (io) io.observe(el); else { const st = getVState(el); st.visible = true; if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } }
      if (ro) safe(() => ro.observe(el));
      lazyScanAncestorShadowRoots(el);
    };

    const WorkQ = (() => {
      let active = [], pending = [];
      let scheduled = false;
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

      const schedule = () => {
        if (destroyed || scheduled) return;
        scheduled = true;
        const token = ++scheduleToken;

        if (typeof scheduler !== 'undefined' && scheduler.postTask) {
          scheduler.postTask(() => { runDrain(undefined, token); }, { priority: 'background', signal: __globalSig }).catch(() => {});
          return;
        }

        if (window.requestIdleCallback) {
          idleId = requestIdleCallback((dl) => { idleId = 0; runDrain(dl, token); }, { timeout: 120 });
        } else {
          rafId = requestAnimationFrame(() => { rafId = 0; runDrain(undefined, token); });
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

      const drain = async (dl) => {
        scheduled = false;
        [active, pending] = [pending, active];
        [activeSet, pendingSet] = [pendingSet, activeSet];
        pending.length = 0; pendingSet.clear();

        const canYield = typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function';
        const start = performance.now();
        const iip = navigator.scheduling?.isInputPending?.bind(navigator.scheduling);
        const maxMs = dl?.timeRemaining ? Math.min(dl.timeRemaining(), 10) : 4;
        let processed = 0;

        for (let i = 0; i < active.length; i++) {
          const n = active[i]; activeSet.delete(n);
          if ((++processed & 15) === 0) {
            if (canYield) {
              try { await scheduler.yield(); } catch (_) {}
              if (destroyed) return;
            } else if ((performance.now() - start) > maxMs || iip?.()) {
              for (let j = i; j < active.length; j++) {
                const rest = active[j];
                if (!pendingSet.has(rest)) { pendingSet.add(rest); pending.push(rest); }
              }
              active.length = 0; schedule(); return;
            }
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
            evicted = true; break;
          }
        }
        if (!evicted) {
          for (const [sr, mo] of shadowObserverMap) {
            const hasVideo = sr.querySelector?.('video');
            if (!hasVideo) {
              try { mo.disconnect(); } catch (_) {}
              shadowObserverMap.delete(sr);
              evicted = true; break;
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
      disconnectBaseObserver();
      for (const [sr, mo] of [...shadowObserverMap]) {
        if (!sr.host?.isConnected) {
          try { mo.disconnect(); } catch (_) {}
          shadowObserverMap.delete(sr);
        }
      }
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
        if (!el?.isConnected) {
          videos.delete(el); visible.videos.delete(el); dirtyA.videos.delete(el); dirtyB.videos.delete(el);
          safe(() => { io?.unobserve(el); ro?.unobserve(el); });
          removed++;
        }
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
        disconnectBaseObserver();
        for (const mo of shadowObserverMap.values()) { try { mo.disconnect(); } catch (_) {} }
        shadowObserverMap.clear();
        try { io?.disconnect(); } catch (_) {} try { ro?.disconnect(); } catch (_) {}
        videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear();
      }
    };
  }
// =================== PART 2 START ===================

  class PiPStateManager {
    constructor() { this.reset(); }
    get isActive() { return !!(this.window && !this.window.closed && this.video); }
    reset() {
      try { this._uiCleanup?.(); } catch (_) {}
      this._uiCleanup = null;
      if (this._ac) { this._ac.abort(); this._ac = null; }
      this.window = null; this.video = null; this.placeholder = null;
      this.origParent = null; this.origNext = null; this.origContainer = null;
      this.origCss = ''; this._restoring = false;
    }
    saveVideoPosition(video) {
      this.origParent = video.parentNode;
      this.origNext = video.nextSibling;
      this.origContainer = video.closest(PLAYER_CONTAINER_SELECTORS) || null;
      this.origCss = video.style.cssText;
    }
    restoreVideoPosition(video) {
      video.style.cssText = this.origCss || '';
      const canMoveBefore = typeof Node.prototype.moveBefore === 'function';

      if (this.placeholder?.parentNode?.isConnected) {
        const parent = this.placeholder.parentNode;
        if (canMoveBefore) {
          try { parent.moveBefore(video, this.placeholder); }
          catch (_) { parent.insertBefore(video, this.placeholder); }
        } else {
          parent.insertBefore(video, this.placeholder);
        }
      } else if (this.origParent?.isConnected) {
        const target = this.origNext?.parentNode === this.origParent ? this.origNext : null;
        if (canMoveBefore) {
          try { this.origParent.moveBefore(video, target); }
          catch (_) { target ? this.origParent.insertBefore(video, target) : this.origParent.appendChild(video); }
        } else {
          target ? this.origParent.insertBefore(video, target) : this.origParent.appendChild(video);
        }
      } else {
        (document.body || document.documentElement)?.appendChild(video);
      }
      this.placeholder?.remove?.();
    }
  }
  const PiPState = new PiPStateManager();

  function getActivePiPVideo() {
    if (PiPState.isActive) return PiPState.video;
    const el = document.pictureInPictureElement;
    return (el instanceof HTMLVideoElement) ? el : null;
  }

  function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

  function supportsDocumentPiP() {
    try { if (window.top !== window) return false; } catch (_) { return false; }
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
  function loadDocPiPSize() { try { const s = JSON.parse(localStorage.getItem(DOC_PIP_SIZE_KEY)); return s?.w >= 320 && s?.h >= 180 ? s : null; } catch (_) { return null; } }
  function saveDocPiPSize(w, h) { try { localStorage.setItem(DOC_PIP_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (_) {} }

  function installPiPWindowUX(pipWindow, video, stage, bar) {
    const doc = pipWindow.document;
    stage.style.position = 'relative';

    const badge = doc.createElement('div');
    badge.style.cssText = `position:absolute;top:10px;right:10px;z-index:10;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.55);color:#fff;font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;backdrop-filter:blur(8px);`;
    stage.appendChild(badge);

    const fmt = (t) => {
      if (!Number.isFinite(t)) return 'LIVE';
      const s = Math.floor(t % 60), m = Math.floor((t / 60) % 60), h = Math.floor(t / 3600);
      if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      return `${m}:${String(s).padStart(2, '0')}`;
    };

    const renderBadge = () => {
      const cur = fmt(video.currentTime || 0), dur = Number.isFinite(video.duration) ? fmt(video.duration) : 'LIVE';
      const size = `${video.videoWidth || 0}\u00D7${video.videoHeight || 0}`;
      badge.textContent = `${cur} / ${dur} \u00B7 ${size}`;
    };

    let rvfcId = 0, timerId = 0;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = () => { renderBadge(); rvfcId = video.requestVideoFrameCallback(onFrame); };
      rvfcId = video.requestVideoFrameCallback(onFrame);
    } else {
      timerId = setInterval(renderBadge, 250);
    }

    const ro = new ResizeObserver(() => {
      const h = Math.ceil(bar.getBoundingClientRect().height || 0);
      stage.style.paddingBottom = `${h + 8}px`;
    });
    ro.observe(bar);

    doc.addEventListener('keydown', (e) => {
      if (e.code === 'Space') { e.preventDefault(); if (video.paused) video.play().catch(() => {}); else video.pause(); }
      else if (e.code === 'ArrowLeft') { e.preventDefault(); try { video.currentTime = Math.max(0, video.currentTime - 5); } catch (_) {} }
      else if (e.code === 'ArrowRight') { e.preventDefault(); try { const maxT = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : video.currentTime + 5; video.currentTime = Math.min(maxT, video.currentTime + 5); } catch (_) {} }
    });

    pipWindow.addEventListener('pagehide', () => {
      ro.disconnect(); clearInterval(timerId);
      if (rvfcId && typeof video.cancelVideoFrameCallback === 'function') { try { video.cancelVideoFrameCallback(rvfcId); } catch (_) {} }
    }, { once: true });

    renderBadge();
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

      // PiP 전환 중에는 일시적으로 오디오 타겟을 뗌 (에러 방지)
      safe(() => getNS()?.AudioSetTarget?.(null));

      PiPState.window = pipWindow;
      PiPState.video = video;
      PiPState.saveVideoPosition(video);

      PiPState.placeholder = document.createElement('div');
      const rect = video.getBoundingClientRect();

      const pw = Math.max(160, rect.width || video.clientWidth || video.offsetWidth || 640);
      const ph = Math.max(90, rect.height || video.clientHeight || video.offsetHeight || 360);

      Object.assign(PiPState.placeholder.style, {
        width: `${pw}px`, height: `${ph}px`, background: '#000',
        display: getComputedStyle(video).display || 'block', boxSizing: 'border-box'
      });

      PiPState.origParent?.insertBefore(PiPState.placeholder, video);

      const doc = pipWindow.document;
      const style = doc.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; }
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; color: #fff; font-family: system-ui, sans-serif; }
        .vsc-pip-root { display: grid; grid-template-rows: minmax(0, 1fr) auto; width: 100%; height: 100%; background: #000; }
        .vsc-pip-stage { min-width: 0; min-height: 0; display: grid; place-items: center; overflow: hidden; background: #000; }
        .vsc-pip-frame { width: 100%; height: 100%; display: grid; place-items: center; background: #000; }
        .vsc-pip-frame video { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; object-fit: contain; background: #000; }
        .vsc-pip-bar { display: flex; gap: 6px; padding: 8px; background: rgba(18,18,18,.92); border-top: 1px solid rgba(255,255,255,.12); }
        .vsc-pip-btn { flex: 1; min-height: 34px; border: 1px solid rgba(255,255,255,.16); border-radius: 10px; background: #222; color: #fff; font-weight: 700; cursor: pointer; }
        .vsc-pip-btn:hover { background: #2a2a2a; }
      `;
      doc.head.appendChild(style);

      const root = doc.createElement('div'); root.className = 'vsc-pip-root';
      const stage = doc.createElement('div'); stage.className = 'vsc-pip-stage';
      const frame = doc.createElement('div'); frame.className = 'vsc-pip-frame';
      const bar = doc.createElement('div'); bar.className = 'vsc-pip-bar';

      const mkBtn = (label, onClick) => { const b = doc.createElement('button'); b.className = 'vsc-pip-btn'; b.textContent = label; b.addEventListener('click', onClick); return b; };

      const playBtn = mkBtn(video.paused ? '\u25B6 \uC7AC\uC0DD' : '\u23F8 \uC77C\uC2DC\uC815\uC9C0', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
      const backBtn = mkBtn('\u23EA 10s', () => { try { video.currentTime = Math.max(0, video.currentTime - 10); } catch (_) {} });
      const fwdBtn = mkBtn('10s \u23E9', () => { try { const maxT = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : video.currentTime + 10; video.currentTime = Math.min(maxT, video.currentTime + 10); } catch (_) {} });

      function getShellHeight() { return Math.ceil(bar.getBoundingClientRect().height || 50); }

      function resizePiPToAspect(scale = 1.0) {
        if (!pipWindow || pipWindow.closed) return;
        const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
        if (!vw || !vh) return;
        const shellH = getShellHeight();
        const maxStageW = Math.floor(screen.availWidth * 0.50 * scale);
        const maxStageH = Math.floor((screen.availHeight * 0.50 - shellH) * scale);
        if (maxStageW < 200 || maxStageH < 100) return;
        const ratio = vw / vh;
        let stageW = maxStageW, stageH = Math.round(stageW / ratio);
        if (stageH > maxStageH) { stageH = maxStageH; stageW = Math.round(stageH * ratio); }
        try {
          const chromeW = pipWindow.outerWidth - pipWindow.innerWidth;
          const chromeH = pipWindow.outerHeight - pipWindow.innerHeight;
          pipWindow.resizeTo(stageW + chromeW, stageH + shellH + chromeH);
        } catch (_) {}
      }

      const fitBtn = mkBtn('\u2922 \uB9DE\uCDA4', () => resizePiPToAspect(1.0));
      const smallBtn = mkBtn('S', () => resizePiPToAspect(0.85));
      const largeBtn = mkBtn('L', () => resizePiPToAspect(1.15));
      const closeBtn = mkBtn('\u2715 \uB2EB\uAE30', () => { exitPiP(video).catch(() => {}); });

      const syncPlayBtn = () => { playBtn.textContent = video.paused ? '\u25B6 \uC7AC\uC0DD' : '\u23F8 \uC77C\uC2DC\uC815\uC9C0'; };
      video.addEventListener('play', syncPlayBtn);
      video.addEventListener('pause', syncPlayBtn);

      PiPState._uiCleanup = () => {
        video.removeEventListener('play', syncPlayBtn);
        video.removeEventListener('pause', syncPlayBtn);
      };

      Object.assign(video.style, { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' });

      frame.append(video); stage.append(frame);
      bar.append(backBtn, playBtn, fwdBtn, fitBtn, smallBtn, largeBtn, closeBtn);
      root.append(stage, bar); doc.body.append(root);

      installPiPWindowUX(pipWindow, video, stage, bar);

      function syncPiPLayout() {
        if (!pipWindow || pipWindow.closed) return;
        const vw = video.videoWidth || 0, vh = video.videoHeight || 0;
        if (!vw || !vh) return;
        frame.style.aspectRatio = `${vw} / ${vh}`;
      }

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      try { const ct = video.currentTime; if (Number.isFinite(ct) && ct > 0) video.currentTime = ct; } catch (_) {}

      if (wasPlaying && video.paused) { try { await video.play(); } catch (_) {} }

      await new Promise(resolve => {
        if (video.readyState >= 3) { resolve(); return; }
        let resolved = false;
        const done = () => { if (resolved) return; resolved = true; resolve(); };
        video.addEventListener('canplay', done, { once: true });
        setTimeout(done, 800);
      });

      safe(() => getNS()?.AudioSetTarget?.(video));
      safe(() => getNS()?.ApplyReq?.hard());

      const pipAC = new AbortController();
      const saveSizeDebounced = createDebounced(() => saveDocPiPSize(pipWindow.innerWidth || 0, pipWindow.innerHeight || 0), 180);

      video.addEventListener('loadedmetadata', syncPiPLayout, { signal: pipAC.signal });
      pipWindow.addEventListener('resize', () => { syncPiPLayout(); saveSizeDebounced(); }, { signal: pipAC.signal });

      pipWindow.addEventListener('pagehide', () => {
        pipAC.abort();
        saveDocPiPSize(pipWindow.innerWidth || 0, pipWindow.innerHeight || 0);
        restoreFromDocumentPiP(video);
      }, { once: true });

      PiPState._ac = pipAC;
      syncPiPLayout();
      if (!saved) { setTimeout(() => resizePiPToAspect(1.0), 100); }

      return true;
    } catch (e) {
      try {
        PiPState.restoreVideoPosition(video);
        if (pipWindow && !pipWindow.closed) { try { pipWindow.close(); } catch (_) {} }
      } catch (_) {}
      PiPState.reset(); throw e;
    }
  }

  async function enterPiP(video) {
    if (!video || video.readyState < 2) throw new Error('Video not ready');
    if (supportsDocumentPiP()) {
      try { return await enterDocumentPiP(video); } catch (e) { log.warn('Document PiP failed, trying Legacy PiP fallback', e); }
    }
    if (PIP_FLAGS.USE_LEGACY_PIP_FALLBACK && supportsLegacyPiP(video)) { return await enterLegacyPiP(video); }
    throw new Error('PiP is not supported in this browser/context');
  }

  async function restoreFromDocumentPiP(video) {
    if (!video) { PiPState.reset(); return; }
    if (PiPState.video !== video) return;
    if (PiPState._restoring) return;

    PiPState._restoring = true;
    const wasPlaying = !video.paused;

    safe(() => getNS()?.AudioSetTarget?.(null));

    try {
      PiPState.restoreVideoPosition(video);

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      try { const ct = video.currentTime; if (Number.isFinite(ct)) video.currentTime = ct; } catch(_) {}

      if (wasPlaying && video.paused) { try { await video.play(); } catch(_) {} }

      safe(() => { getNS()?.AudioSetTarget?.(video); __vscNs.ApplyReq?.hard(); });

    } catch (e) { log.warn('PiP restore failed:', e); }

    PiPState.reset();
  }

  async function exitPiP(preferredVideo = null) {
    const target = (preferredVideo && preferredVideo === PiPState.video) ? preferredVideo : PiPState.video;
    if (PiPState.window) {
      const win = PiPState.window;
      if (win && !win.closed) { try { win.close(); } catch (_) {} }
      if (target && PiPState.video === target && !PiPState._restoring) { restoreFromDocumentPiP(target); }
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
      if (isInDocPiP || isInLegacyPiP) { return await exitPiP(video); }
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} }
      if (PiPState.window && !PiPState.window.closed) {
        const prevWin = PiPState.window;
        try { prevWin.close(); } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
      }
      return await enterPiP(video);
    } finally { _pipToggleLock = false; }
  }

  function chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].connect(nodes[i + 1]);
    }
  }

  const globalSrcMap = new WeakMap();
  const _activeAudioSources = new Set();

  function createStereoWidener(actx) {
    const mkBQ = (type, freq, Q = 0.707, gain) => {
      const f = actx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (Q !== undefined) f.Q.value = Q;
      if (gain !== undefined) f.gain.value = gain;
      return f;
    };

    const input = actx.createGain(), output = actx.createGain();
    input.gain.value = 1.0; output.gain.value = 1.0;
    input.channelCount = 2;
    input.channelCountMode = 'clamped-max';
    input.channelInterpretation = 'speakers';

    const splitter = actx.createChannelSplitter(2);
    const merger = actx.createChannelMerger(2);

    const midL = actx.createGain(); midL.gain.value = 0.5;
    const midR = actx.createGain(); midR.gain.value = 0.5;
    const sideL = actx.createGain(); sideL.gain.value = 0.5;
    const sideR = actx.createGain(); sideR.gain.value = -0.5;

    const midBus = actx.createGain(), sideBus = actx.createGain();

    input.connect(splitter);
    splitter.connect(midL, 0); splitter.connect(sideL, 0);
    splitter.connect(midR, 1); splitter.connect(sideR, 1);
    midL.connect(midBus); midR.connect(midBus);
    sideL.connect(sideBus); sideR.connect(sideBus);

    const sideLow1 = mkBQ('lowpass', 160, 0.707), sideLow2 = mkBQ('lowpass', 160, 0.707);
    const sideHigh = actx.createGain(), sideLowInv = actx.createGain();
    sideLowInv.gain.value = -1.0;

    sideBus.connect(sideHigh); sideBus.connect(sideLow1);
    sideLow1.connect(sideLow2); sideLow2.connect(sideLowInv); sideLowInv.connect(sideHigh);

    const sideShelf = mkBQ('highshelf', 3200, 0.707, 1.5);
    const sideAmp = actx.createGain(); sideAmp.gain.value = 1.0;
    sideHigh.connect(sideShelf); sideShelf.connect(sideAmp);

    const outL = actx.createGain(), outR = actx.createGain(), sideInvR = actx.createGain();
    sideInvR.gain.value = -1.0;

    midBus.connect(outL); sideAmp.connect(outL);
    midBus.connect(outR); sideAmp.connect(sideInvR); sideInvR.connect(outR);

    outL.connect(merger, 0, 0); outR.connect(merger, 0, 1);
    merger.connect(output);

    let _enabled = false;

    function setEnabled(en) {
      _enabled = en;
      const t = actx.currentTime;
      const target = en ? 1.22 : 1.0;
      try { sideAmp.gain.setTargetAtTime(target, t, 0.06); }
      catch (_) { sideAmp.gain.value = target; }
    }

    return { input, output, sideAmp, setEnabled, update: () => {}, isEnabled: () => _enabled };
  }

  const VSC_FINALIZER_WORKLET_SRC = `
class VSCFinalizerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'drive',   defaultValue: 1.15,   minValue: 0.5,   maxValue: 3.0,   automationRate: 'k-rate' },
      { name: 'ceiling', defaultValue: 0.985,  minValue: 0.80,  maxValue: 1.0,   automationRate: 'k-rate' },
      { name: 'mix',     defaultValue: 1.0,    minValue: 0.0,   maxValue: 1.0,   automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.9965, minValue: 0.90,  maxValue: 0.9999,automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    this.gain = 1.0;
    this.rmsAccum = 0; this.rmsCount = 0;
    this.peakAccum = 0; this.peakCount = 0;
    this.shortRms = 0; this.shortPeak = 0;
    this.crestFactor = 0; this.spectralBalance = 0;
    this.frameCounter = 0; this.reportInterval = 24;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output?.length) return true;

    const channels = output.length;
    const frames = output[0].length;
    const drive   = parameters.drive[0];
    const ceiling = parameters.ceiling[0];
    const mix     = parameters.mix[0];
    const release = parameters.release[0];
    const norm = Math.max(1e-6, Math.tanh(drive));

    let blockPeak = 0;
    let blockSumSq = 0;
    let highEnergy = 0;

    for (let ch = 0; ch < channels; ch++) {
      const src = input[ch] || input[0] || new Float32Array(frames);
      const dst = output[ch];
      let prev = 0;
      for (let i = 0; i < frames; i++) {
        const dry = src[i] || 0;
        const wet = Math.tanh(dry * drive) / norm;
        const mixed = dry + (wet - dry) * mix;
        dst[i] = mixed;
        const a = Math.abs(mixed);
        if (a > blockPeak) blockPeak = a;
        blockSumSq += mixed * mixed;
        const diff = mixed - prev;
        highEnergy += diff * diff;
        prev = mixed;
      }
    }

    const targetGain = blockPeak > ceiling ? (ceiling / blockPeak) : 1.0;
    if (targetGain < this.gain) {
      this.gain = targetGain;
    } else {
      this.gain += (1 - this.gain) * (1 - release);
      if (this.gain > 1) this.gain = 1;
    }

    if (this.gain < 0.9999) {
      for (let ch = 0; ch < channels; ch++) {
        const dst = output[ch];
        for (let i = 0; i < frames; i++) dst[i] *= this.gain;
      }
    }

    const blockRms = Math.sqrt(blockSumSq / Math.max(1, channels * frames));
    this.rmsAccum += blockRms; this.rmsCount++;
    this.peakAccum = Math.max(this.peakAccum, blockPeak); this.peakCount++;
    const totalEnergy = blockSumSq / Math.max(1, channels * frames);
    const highRatio = totalEnergy > 1e-10 ? (highEnergy / (channels * frames)) / totalEnergy : 0;

    this.frameCounter++;
    if (this.frameCounter >= this.reportInterval) {
      const avgRms = this.rmsCount > 0 ? this.rmsAccum / this.rmsCount : 1e-6;
      const peak = Math.max(this.peakAccum, 1e-6);
      const crest = avgRms > 1e-5 ? (peak / avgRms) : 20;

      this.port.postMessage({
        rmsDb: 20 * Math.log10(Math.max(avgRms, 1e-6)),
        peakDb: 20 * Math.log10(Math.max(peak, 1e-6)),
        gainReductionDb: 20 * Math.log10(Math.max(this.gain, 1e-6)),
        crestFactor: crest,
        highEnergyRatio: Math.min(1, highRatio),
        avgRmsLinear: avgRms
      });

      this.rmsAccum = 0; this.rmsCount = 0;
      this.peakAccum = 0; this.peakCount = 0;
      this.frameCounter = 0;
    }
    return true;
  }
}
registerProcessor('vsc-finalizer', VSCFinalizerProcessor);
`;

  function createContentClassifier() {
    const CONTENT = Object.freeze({ SILENT: 'silent', DIALOGUE: 'dialogue', MUSIC: 'music', MIXED: 'mixed' });
    let currentType = CONTENT.MIXED;
    let confidence = 0;

    const HISTORY_SIZE = 8;
    const history = new Array(HISTORY_SIZE).fill(null);
    let writeIdx = 0;
    let count = 0;

    const PROFILES = Object.freeze({
      [CONTENT.SILENT]: { drive: 1.0, ceiling: 0.99, release: 0.997, mixTarget: 0.0 },
      [CONTENT.DIALOGUE]: { drive: 1.30, ceiling: 0.975, release: 0.9955 },
      [CONTENT.MUSIC]: { drive: 1.08, ceiling: 0.99, release: 0.998 },
      [CONTENT.MIXED]: { drive: 1.15, ceiling: 0.985, release: 0.9965 }
    });

    function classify(stats) {
      if (!stats) return currentType;
      const rmsDb = stats.rmsDb || -70;
      const crest = stats.crestFactor || 10;
      const highRatio = stats.highEnergyRatio || 0;
      const avgRms = stats.avgRmsLinear || 0;

      if (rmsDb < -50 || avgRms < 0.001) {
        pushResult(CONTENT.SILENT);
        return currentType;
      }

      let dialogueScore = 0;
      let musicScore = 0;

      if (crest < 4.0) dialogueScore += 2;
      else if (crest < 6.0) dialogueScore += 1;
      else if (crest > 10.0) musicScore += 2;
      else if (crest > 7.0) musicScore += 1;

      if (highRatio > 0.35) dialogueScore += 1;
      else if (highRatio < 0.15) musicScore += 1;

      if (rmsDb > -30 && rmsDb < -12) dialogueScore += 1;
      if (rmsDb > -10) musicScore += 1;

      let result;
      if (dialogueScore >= 3 && dialogueScore > musicScore + 1) result = CONTENT.DIALOGUE;
      else if (musicScore >= 3 && musicScore > dialogueScore + 1) result = CONTENT.MUSIC;
      else result = CONTENT.MIXED;

      pushResult(result);
      return currentType;
    }

    function pushResult(type) {
      history[writeIdx] = type;
      writeIdx = (writeIdx + 1) % HISTORY_SIZE;
      if (count < HISTORY_SIZE) count++;

      const counts = {};
      for (let i = 0; i < count; i++) {
        const t = history[i];
        counts[t] = (counts[t] || 0) + 1;
      }

      let bestType = CONTENT.MIXED;
      let bestCount = 0;
      for (const [t, c] of Object.entries(counts)) {
        if (c > bestCount) { bestCount = c; bestType = t; }
      }

      const threshold = Math.ceil(HISTORY_SIZE * 0.6);
      if (bestCount >= threshold) {
        currentType = bestType;
        confidence = bestCount / HISTORY_SIZE;
      }
    }

    function getProfile() { return PROFILES[currentType] || PROFILES[CONTENT.MIXED]; }

    function getAdaptedParams(userDialogueOn, userStereoW) {
      const base = getProfile();
      let drive = base.drive, ceiling = base.ceiling, release = base.release;

      if (userDialogueOn) { drive = Math.max(drive, 1.25); release = Math.min(release, 0.996); }
      if (userStereoW) { ceiling = Math.min(ceiling, 0.975); }
      const mix = currentType === CONTENT.SILENT ? 0.0 : 1.0;

      return { drive, ceiling, release, mix };
    }

    return {
      classify, getProfile, getAdaptedParams, getType: () => currentType, getConfidence: () => confidence,
      reset: () => { currentType = CONTENT.MIXED; confidence = 0; history.fill(null); writeIdx = 0; count = 0; }
    };
  }

  function createAudioFeature(sm) {
    let ctx, target = null, currentSrc = null, inputGain, dryGain, wetGain, masterOut, wetInGain, limiter, currentNodes = null;
    let makeupDbEma = 0, switchTok = 0, gestureHooked = false, loopTok = 0, audioLoopTimerId = 0;

    let finalizerNode = null;
    let workletInitPromise = null;
    const contentClassifier = createContentClassifier();

    async function ensureFinalizerWorklet(audioCtx) {
      if (finalizerNode) return finalizerNode;
      if (!window.isSecureContext || !audioCtx?.audioWorklet) return null;

      if (!workletInitPromise) {
        workletInitPromise = (async () => {
          const blobUrl = URL.createObjectURL(
            new Blob([VSC_FINALIZER_WORKLET_SRC], { type: 'application/javascript' })
          );
          try {
            await audioCtx.audioWorklet.addModule(blobUrl);
            finalizerNode = new AudioWorkletNode(audioCtx, 'vsc-finalizer', {
              numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2]
            });
            return finalizerNode;
          } catch (e) {
            // 🔥 에러 로그를 띄우지 않고 조용히 강력한 기본 컴프레서로 폴백
            return null;
          } finally {
            URL.revokeObjectURL(blobUrl);
          }
        })();
      }
      return workletInitPromise;
    }

    async function attachFinalizerWorklet() {
      if (!ctx || !currentNodes || currentNodes._finalizerAttached) return;
      const node = await ensureFinalizerWorklet(ctx);
      if (!node) return;

      try { currentNodes._stereoWidener.output.disconnect(currentNodes.wetInGain); } catch (_) {}
      currentNodes._stereoWidener.output.connect(node);
      node.connect(currentNodes.wetInGain);

      currentNodes._finalizer = node;
      currentNodes._finalizerAttached = true;
      node.port.onmessage = (e) => {
        currentNodes._awStats = e.data;
        contentClassifier.classify(e.data);
      };
    }

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
        if (st === 'suspended' || st === 'interrupted') { ctx.resume().catch(() => {}); }
      }
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') resumeCtxIfNeeded(); }, { passive: true, signal: _audioSig });
    }

    const clamp = VSC_CLAMP;
    const stt = (param, val, t, tc = 0.08) => { if(param) { try { param.setTargetAtTime(val, t, tc); } catch (_) { param.value = val; } } };
    const mkBQ = (actx, type, freq, Q, gain) => {
      const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      if(Q !== undefined) f.Q.value = Q;
      if(gain !== undefined) f.gain.value = gain;
      return f;
    };
    const mkComp = (actx, thr, knee, ratio, atk, rel) => {
      const c = actx.createDynamicsCompressor();
      c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio;
      c.attack.value = atk; c.release.value = rel;
      return c;
    };

    const onGesture = async () => {
      try {
        if (ctx && ctx.state === 'suspended') await ctx.resume();
        if (ctx && ctx.state === 'running' && gestureHooked) {
          window.removeEventListener('pointerdown', onGesture, true);
          window.removeEventListener('keydown', onGesture, true);
          gestureHooked = false;
        }
      } catch (_) {}
    };
    const ensureGestureResumeHook = () => {
      if (gestureHooked) return;
      gestureHooked = true;
      on(window, 'pointerdown', onGesture, OPT_PC);
      on(window, 'keydown', onGesture, OPT_PC);
    };

    function buildMultibandDynamics(actx) {
      const CROSSOVER_LOW = 200, CROSSOVER_HIGH = 3200;
      const createLR4 = (freq, type) => { const f1 = mkBQ(actx, type, freq, Math.SQRT1_2); const f2 = mkBQ(actx, type, freq, Math.SQRT1_2); f1.connect(f2); return { input: f1, output: f2 }; };
      const input = actx.createGain(), lpLow = createLR4(CROSSOVER_LOW, 'lowpass'), hpLow = createLR4(CROSSOVER_LOW, 'highpass'), lpMid = createLR4(CROSSOVER_HIGH, 'lowpass'), hpHigh = createLR4(CROSSOVER_HIGH, 'highpass');

      input.connect(lpLow.input); input.connect(hpLow.input);
      hpLow.output.connect(lpMid.input); hpLow.output.connect(hpHigh.input);

      const MAKEUP_LOW  = Math.pow(10, 3.0 / 20), MAKEUP_MID  = Math.pow(10, 1.0 / 20), MAKEUP_HIGH = Math.pow(10, 0.5 / 20);
      const compLow  = mkComp(actx, -22, 10, 2.5, 0.030, 0.50), compMid  = mkComp(actx, -18, 10, 2.0, 0.015, 0.18), compHigh = mkComp(actx, -14,  8, 1.8, 0.005, 0.10);

      const gainLow = actx.createGain(); gainLow.gain.value = MAKEUP_LOW;
      const gainMid = actx.createGain(); gainMid.gain.value = MAKEUP_MID;
      const gainHigh = actx.createGain(); gainHigh.gain.value = MAKEUP_HIGH;

      chain(lpLow.output, compLow, gainLow);
      chain(lpMid.output, compMid, gainMid);
      chain(hpHigh.output, compHigh, gainHigh);

      const output = actx.createGain();
      gainLow.connect(output); gainMid.connect(output); gainHigh.connect(output);

      return { input, output, bands: { low: { comp: compLow, gain: gainLow }, mid: { comp: compMid, gain: gainMid }, high: { comp: compHigh, gain: gainHigh } } };
    }

    function createSimpleRMSMeter(actx) {
      const analyser = actx.createAnalyser();
      analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.8;
      const buf = new Float32Array(analyser.fftSize);
      let lastRmsDb = -70;

      return {
        input: analyser,
        measure: () => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 4) sum += buf[i] * buf[i];
          const rms = Math.sqrt(sum / (buf.length / 4));
          lastRmsDb = rms > 1e-5 ? 20 * Math.log10(rms) : -70;
        },
        reset: () => { lastRmsDb = -70; },
        getState: (out) => { out.shortTermLUFS = lastRmsDb; out.momentaryLUFS = lastRmsDb; out.integratedLUFS = lastRmsDb; return out; }
      };
    }

    function createLoudnessNormalizer(actx, rmsMeter) {
      const TARGET_LUFS = -14, MAX_GAIN_DB = 6, MIN_GAIN_DB = -6, SMOOTHING = 0.05, SETTLE_FRAMES = 30;
      const gainNode = actx.createGain(); gainNode.gain.value = 1.0;
      let frameCount = 0, currentGainDb = 0;
      let _lastUpdateTime = 0;
      const _tmp = { momentaryLUFS:-70, shortTermLUFS:-70, integratedLUFS:-70 };

      return {
        node: gainNode,
        attackTC: 0.8,
        releaseTC: 2.5,
        update() {
          const lufs = rmsMeter.getState(_tmp);
          frameCount++; if (frameCount < SETTLE_FRAMES) return;

          const measured = lufs.shortTermLUFS; if (measured <= -60) return;
          const targetGainDb = VSC_CLAMP(TARGET_LUFS - measured, MIN_GAIN_DB, MAX_GAIN_DB);
          const now = actx.currentTime;
          const dt = Math.max(0.01, Math.min(1.0, now - (_lastUpdateTime || now)));
          _lastUpdateTime = now;

          const tc = targetGainDb < currentGainDb ? this.attackTC : this.releaseTC;
          const alpha = 1.0 - Math.exp(-dt / tc);
          currentGainDb += (targetGainDb - currentGainDb) * alpha;
          const linearGain = Math.pow(10, currentGainDb / 20);
          stt(gainNode.gain, linearGain, now, SMOOTHING);
        },
        reset: () => { frameCount = 0; currentGainDb = 0; gainNode.gain.value = 1.0; _lastUpdateTime = 0; rmsMeter.reset(); }
      };
    }

    function buildAudioGraph(audioCtx) {
      const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), limiter: mkComp(audioCtx, -1.0, 0.0, 20.0, 0.001, 0.08) };
      const multiband = buildMultibandDynamics(audioCtx);
      const stereoWidener = createStereoWidener(audioCtx);
      const rmsMeter = createSimpleRMSMeter(audioCtx), loudnessNorm = createLoudnessNormalizer(audioCtx, rmsMeter);

      n.wetInGain = loudnessNorm.node;
      n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
      chain(n.inputGain, multiband.input);
      multiband.output.connect(rmsMeter.input);
      chain(multiband.output, stereoWidener.input);
      chain(stereoWidener.output, n.wetInGain);
      chain(n.wetInGain, n.limiter, n.wetGain, n.masterOut);
      n.masterOut.connect(audioCtx.destination);

      n._multiband = multiband; n._stereoWidener = stereoWidener; n._lufsMeter = rmsMeter; n._loudnessNorm = loudnessNorm;
      return n;
    }

    const ensureCtx = () => {
      if (ctx) {
        if (ctx.state !== 'closed') return true;
        for (const src of _activeAudioSources) {
          try { if (src.context === ctx) src.disconnect(); } catch (_) {}
        }
        _activeAudioSources.clear();
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
      currentNodes = nodes;

      attachFinalizerWorklet().catch(() => {});

      return true;
    };

    function detachCurrentSource() {
      if (currentSrc) {
        safe(() => {
          currentSrc.disconnect();
          // 🔥 버그 수정: 오디오 컨텍스트를 거치지 않을 때는 목적지로 직결시켜야 원래 소리가 납니다.
          if (ctx && ctx.state !== 'closed') {
            currentSrc.connect(ctx.destination);
          }
        });
      }
      currentSrc = null; target = null;
    }

    function disposeSourceForVideo(video) {
      if (!video) return;
      const src = globalSrcMap.get(video);
      if (src) {
        safe(() => src.disconnect());
        globalSrcMap.delete(video);
        _activeAudioSources.delete(src);
      }
      if (target === video) { currentSrc = null; target = null; }
    }

    const _lufsTmp = { momentaryLUFS: -70, shortTermLUFS: -70, integratedLUFS: -70 };

    function runAudioLoop(tok) {
      audioLoopTimerId = 0;
      if (tok !== loopTok || !ctx) return;
      const dynAct = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
      if (!dynAct) return;

      const actuallyEnabled = dynAct && currentSrc;

      if (currentSrc && currentNodes) {
        const mbActive = !!sm.get(P.A_MULTIBAND);

        const needMeter = actuallyEnabled && (!!sm.get(P.A_LUFS) || mbActive || !!sm.get(P.A_DIALOGUE));
        if (needMeter && currentNodes._lufsMeter && ctx.state === 'running') {
          try { currentNodes._lufsMeter.measure(); } catch (e) { log.debug('RMS measure failed', e); }
          const lufsSt = currentNodes._lufsMeter.getState(_lufsTmp);

          if (currentNodes._loudnessNorm && !!sm.get(P.A_LUFS)) {
            const cType = contentClassifier.getType();
            if (cType === 'dialogue') {
              currentNodes._loudnessNorm.attackTC = 0.3;
              currentNodes._loudnessNorm.releaseTC = 1.5;
            } else if (cType === 'music') {
              currentNodes._loudnessNorm.attackTC = 1.5;
              currentNodes._loudnessNorm.releaseTC = 4.0;
            } else {
              currentNodes._loudnessNorm.attackTC = 0.8;
              currentNodes._loudnessNorm.releaseTC = 2.5;
            }
            currentNodes._loudnessNorm.update();
          }
        } else {
          if (currentNodes._loudnessNorm && (!sm.get(P.A_LUFS) || !actuallyEnabled)) {
            stt(currentNodes._loudnessNorm.node.gain, 1.0, ctx.currentTime, 0.05);
          }
        }

        if (currentNodes._stereoWidener) {
          const swEnabled = !!sm.get(P.A_STEREO_W) && dynAct;
          if (currentNodes._stereoWidener.isEnabled() !== swEnabled) {
            currentNodes._stereoWidener.setEnabled(swEnabled);
          }
          if (swEnabled) { currentNodes._stereoWidener.update(); }
          if (swEnabled) {
            stt(currentNodes.limiter.threshold, -1.5, ctx.currentTime, 0.08);
          } else {
            stt(currentNodes.limiter.threshold, -1.0, ctx.currentTime, 0.08);
          }
        }

        if (actuallyEnabled) {
          if (currentNodes._finalizerAttached && currentNodes._awStats) {
            const awGr = currentNodes._awStats.gainReductionDb || 0;
            makeupDbEma += (0 - makeupDbEma) * 0.15;
          } else {
            let redDb = 0;
            if (currentNodes.limiter) {
              const r = currentNodes.limiter.reduction;
              redDb = (typeof r === 'number') ? r : (r?.value ?? 0);
            }
            if (!Number.isFinite(redDb)) redDb = 0;
            const redPos = clamp(-redDb, 0, 15);
            const makeupDbTarget = clamp(redPos * 0.25, 0, 2.5);
            const alpha = makeupDbTarget > makeupDbEma ? 0.10 : 0.18;
            makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
          }
        } else {
          makeupDbEma += (0 - makeupDbEma) * 0.15;
        }
      }

      const userBoost = Math.pow(10, Number(sm.get(P.A_BST) || 0) / 20);
      const makeup = Math.pow(10, makeupDbEma / 20);
      if (wetInGain) {
        const finalGain = actuallyEnabled ? (userBoost * makeup) : 1.0;
        stt(wetInGain.gain, finalGain, ctx.currentTime, 0.02);
      }

      const isPaused = target && (target.paused || target.ended);
      if (document.hidden) {
        audioLoopTimerId = setTimeout(() => runAudioLoop(tok), 500);
      } else if (isPaused) {
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
        const contentType = contentClassifier.getType();
        let targetInterval;

        if (!currentNodes._finalizerAttached) { targetInterval = 0.10; }
        else if (contentType === 'silent') { targetInterval = 1.0; }
        else if (contentType === 'dialogue') { targetInterval = 0.40; }
        else if (contentType === 'music') { targetInterval = 0.60; }
        else { targetInterval = 0.50; }

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
        const dialogueOn = dynAct && !!sm.get(P.A_DIALOGUE);
        if (currentNodes._multiband) {
          const mb = currentNodes._multiband.bands, t = ctx.currentTime;
          if (mbEnabled) {
            stt(mb.low.comp.ratio, 2.5, t, 0.02); stt(mb.mid.comp.ratio, 2.2, t, 0.02); stt(mb.high.comp.ratio, 1.8, t, 0.02);
            if (dialogueOn) { stt(mb.mid.gain.gain, 1.30, t, 0.08); stt(mb.low.gain.gain, 1.25, t, 0.08); stt(mb.high.gain.gain, 1.12, t, 0.08); }
            else { stt(mb.low.gain.gain, 1.41, t, 0.15); stt(mb.mid.gain.gain, 1.12, t, 0.15); stt(mb.high.gain.gain, 1.06, t, 0.15); }
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

        if (currentNodes._finalizer) {
          const adapted = contentClassifier.getAdaptedParams(
            !!sm.get(P.A_DIALOGUE), !!sm.get(P.A_STEREO_W)
          );
          const p = currentNodes._finalizer.parameters;
          const t = ctx.currentTime;
          try { p.get('drive')?.setTargetAtTime(dynAct ? adapted.drive : 1.0, t, 0.15); } catch (_) {}
          try { p.get('ceiling')?.setTargetAtTime(adapted.ceiling, t, 0.08); } catch (_) {}
          try { p.get('mix')?.setTargetAtTime(dynAct ? adapted.mix : 0.0, t, 0.05); } catch (_) {}
          try { p.get('release')?.setTargetAtTime(adapted.release, t, 0.08); } catch (_) {}
        }
      }
      if (dynAct && isHooked) runAudioLoop(tok);
    };

    const setTarget = (v) => {
      ++switchTok;
      if (_activePauseAC) { _activePauseAC.abort(); _activePauseAC = null; }

      if (v == null) {
        if (!ctx) return;
        detachCurrentSource(); updateMix();
        return;
      }

      const st = getVState(v);
      if (st && st.audioFailUntil > performance.now()) {
        detachCurrentSource(); updateMix();
        return;
      }

      if (!ensureCtx()) return;
      if (v === target && currentSrc) { updateMix(); return; }

      const connectWithFallback = (vid) => {
        if (!vid) return;
        let s = globalSrcMap.get(vid);
        let reusable = false;

        if (s) {
          try { reusable = (s.context === ctx && s.context.state !== 'closed'); } catch (_) {}
          if (!reusable) {
            try { s.disconnect(); } catch (_) {}
            globalSrcMap.delete(vid);
            _activeAudioSources.delete(s);
            s = null;
          } else {
            // 재사용 시 기존 destination 직결을 끊고 이펙트 체인으로 돌림
            try { s.disconnect(); } catch (_) {}
          }
        }

        if (!s) {
          try {
            s = ctx.createMediaElementSource(vid);
            globalSrcMap.set(vid, s);
            _activeAudioSources.add(s);
          }
          catch (e) {
            st.audioFailUntil = performance.now() + 10000;
            detachCurrentSource(); updateMix();
            return;
          }
        }

        try { s.disconnect(); } catch (_) {}
        s.connect(inputGain); currentSrc = s; target = vid;
        updateMix();
      };

      if (target !== null && target !== v) { detachCurrentSource(); connectWithFallback(v); }
      else if (!currentSrc) { connectWithFallback(v); }
      else { updateMix(); }
    };

    return defineFeature({
      name: 'audio',
      phase: PHASE.PROCESS,

      onInit() {
        this.subscribe('target:changed', ({ video }) => {
          const act = this.getSetting(P.APP_ACT);
          const wantAudioNow = !!(this.getSetting(P.A_EN) && act);
          const nextAudioTarget = (wantAudioNow || !!ctx || !!currentSrc) ? (video || null) : null;

          if (target !== nextAudioTarget) setTarget(nextAudioTarget);
          else updateMix();
        });
      },

      onUpdate(appCtx) {
        const act = this.getSetting(P.APP_ACT);
        const wantAudioNow = !!(this.getSetting(P.A_EN) && act);
        const video = appCtx?.target || this.getActiveVideo();
        const nextAudioTarget = (wantAudioNow || !!ctx || !!currentSrc) ? (video || null) : null;

        // 🔥 버그 해결: 버튼을 켜거나 껐을 때 즉각적으로 오디오 노드를 붙이거나 뗌
        if (target !== nextAudioTarget) {
          setTarget(nextAudioTarget);
        } else {
          updateMix();
        }
      },

      methods: {
        warmup: () => { if (!ensureCtx()) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
        updateMix: updateMix,
        hasCtx: () => !!ctx,
        isHooked: () => !!currentSrc,
      },

      async onDestroy() {
        try { _audioAC.abort(); } catch (_) {}
        _visResumeHooked = false;
        loopTok++; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
        if (_activePauseAC) { _activePauseAC.abort(); _activePauseAC = null; }

        const prevTarget = target;
        detachCurrentSource();
        if (prevTarget) { disposeSourceForVideo(prevTarget); }

        safe(() => { if (gestureHooked) { window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true); gestureHooked = false; } });
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        ctx = null; currentNodes = null; limiter = null; wetInGain = null; inputGain = null; dryGain = null; wetGain = null; masterOut = null; makeupDbEma = 0; switchTok++;
        finalizerNode = null; workletInitPromise = null;
        contentClassifier.reset();
      }
    });
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp } = Utils;

    function cacheSet(map, key, val, max = 24) {
      if (map.size >= max && !map.has(key)) map.delete(map.keys().next().value);
      map.set(key, val);
    }

    const urlCache    = new WeakMap();
    const ctxMap      = new WeakMap();
    const toneCache   = new Map();
    const _attrCache  = new WeakMap();
    const __vscBgMemo = new WeakMap();

    function canUseCssNativeOnly(s, shadowParams) {
      if ((s.sharp | 0) > 0 || (s.sharp2 | 0) > 0) return false;
      if (shadowParams && shadowParams.active) return false;
      if (Math.abs(s.toe || 0) > 0.01) return false;
      if (Math.abs(s.shoulder || 0) > 0.01) return false;
      if (Math.abs(s.mid || 0) > 0.01) return false;
      if (Math.abs((s.gain || 1) - 1.0) > 0.02) return false;
      if (Math.abs(s.temp || 0) > 0.5) return false;
      return true;
    }

    function buildCssFilterString(s) {
      const parts = [];
      const brightAdd = s.bright || 0;
      if (Math.abs(brightAdd) > 0.5) {
        const cssBright = 1.0 + brightAdd / 250;
        parts.push(`brightness(${cssBright.toFixed(4)})`);
      }
      const con = s.contrast || 1;
      if (Math.abs(con - 1.0) > 0.005) {
        parts.push(`contrast(${con.toFixed(3)})`);
      }
      const gamma = s.gamma || 1;
      if (Math.abs(gamma - 1.0) > 0.01) {
        const gammaBright = Math.pow(gamma, 0.45);
        parts.push(`brightness(${gammaBright.toFixed(4)})`);
      }
      const sat = s.satF ?? 1;
      if (Math.abs(sat - 1.0) > 0.005) {
        parts.push(`saturate(${sat.toFixed(3)})`);
      }
      return parts.length > 0 ? parts.join(' ') : '';
    }

    const _cssFilterCache = new WeakMap();

    function applyCssNative(el, s) {
      const filterStr = buildCssFilterString(s);
      const cached = _cssFilterCache.get(el);

      if (cached === filterStr) return;
      _cssFilterCache.set(el, filterStr);

      const st = getVState(el);

      if (!filterStr) {
        if (st.applied) {
          if (st.origFilter != null && st.origFilter !== '') {
            el.style.setProperty('filter', st.origFilter, st.origFilterPrio || '');
          } else {
            el.style.removeProperty('filter');
          }
          el.style.removeProperty('-webkit-filter');
          st.applied = false;
          st.lastFilterUrl = null;
        }
        return;
      }

      if (!st.applied) {
        st.origFilter = el.style.getPropertyValue('filter');
        st.origFilterPrio = el.style.getPropertyPriority('filter') || '';
        st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter');
        st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || '';
      }

      el.style.setProperty('filter', filterStr, 'important');
      el.style.setProperty('-webkit-filter', filterStr, 'important');
      st.applied = true;
      st.lastFilterUrl = filterStr;
    }

    function setAttr(node, attr, val) {
      if (!node) return;
      let c = _attrCache.get(node);
      if (!c) { c = Object.create(null); _attrCache.set(node, c); }
      if (c[attr] === val || c[attr] === String(val)) return;
      const strVal = String(val);
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

    const _keyBuf = new Int32Array(14);
    const makeKeyBase = (s) => {
      _keyBuf[0]  = (s.gain || 1) / 0.04;
      _keyBuf[1]  = (s.gamma || 1) / 0.01;
      _keyBuf[2]  = (s.contrast || 1) / 0.01;
      _keyBuf[3]  = (s.bright || 0) / 0.2;
      _keyBuf[4]  = (s.satF ?? 1) / 0.01;
      _keyBuf[5]  = (s.mid || 0) / 0.02;
      _keyBuf[6]  = (s.toe || 0) / 0.2;
      _keyBuf[7]  = (s.shoulder || 0) / 0.2;
      _keyBuf[8]  = (s.temp || 0) / 0.2;
      _keyBuf[9]  = s.sharp || 0;
      _keyBuf[10] = s.sharp2 || 0;
      _keyBuf[11] = (s._sigmaScale || 1) * 100;
      _keyBuf[12] = (s._microBase || 0.16) * 1000;
      _keyBuf[13] = (s._fineBase || 0.32) * 1000;
      return _keyBuf.join('|');
    };

    function getToneTableCached(steps, toeN, shoulderN, midN, gain) {
      const tQ = ((toeN + 1) * 500) | 0;
      const sQ = ((shoulderN + 1) * 500) | 0;
      const mQ = ((midN + 1) * 500) | 0;
      const gQ = (gain * 1000) | 0;
      const key = steps * 1e12 + tQ * 1e9 + sQ * 1e6 + mQ * 1e3 + gQ;

      const hit = toneCache.get(key);
      if (hit) return hit;

      if (toeN === 0 && shoulderN === 0 && midN === 0 && Math.abs(gain - 1) < 0.01) {
        cacheSet(toneCache, key, '0 1', 16); return '0 1';
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
          const smooth = u * u * (3 - 2 * u); const w = 1 - smooth;
          x = clamp(x + toeSign * toeAmt * 10.0 * ((toeEnd - x) * w * w), 0, 1);
        }
        if (shAmt > 1e-6 && x > shoulderStart) {
          const tt = (x - shoulderStart) / Math.max(1e-6, 1 - shoulderStart);
          const kk = Math.max(0.7, 1.2 + shAmt * 6.5);
          const shDen = 1 - Math.exp(-kk);
          const shMap = Math.abs(shDen) > 1e-6 ? (1 - Math.exp(-kk * tt)) / shDen : tt;
          x = clamp(shoulderStart + (1 - shoulderStart) * shMap, 0, 1);
        }
        if (x <= prev) { x = prev + Math.min(1e-5, Math.max(0, (1.0 - prev) * 0.5)); }
        if (x > 1.0) x = 1.0;
        prev = x;
        const y = Math.round(x * 100000) / 100000;
        arr[i] = y === 1 ? '1' : (y === 0 ? '0' : String(y));
      }

      const res = arr.join(' ');
      cacheSet(toneCache, key, res, 16);
      return res;
    }

    function buildSvg(root) {
      const fidMain   = `vsc-main-${config.VSC_ID}`;
      const fidShadow = `vsc-shadow-${config.VSC_ID}`;

      const svg  = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' });
      const defs = h('defs', { ns: 'svg' });
      svg.append(defs);

      function mkFuncRGB(attrs) {
        return [ h('feFuncR', { ns: 'svg', ...attrs }), h('feFuncG', { ns: 'svg', ...attrs }), h('feFuncB', { ns: 'svg', ...attrs }) ];
      }

      const mainFilter = h('filter', { ns: 'svg', id: fidMain, 'color-interpolation-filters': 'sRGB', x: '-8%', y: '-8%', width: '116%', height: '116%' });

      const blurMicro = h('feGaussianBlur', { ns: 'svg', in: 'SourceGraphic', stdDeviation: '0.22', result: 'bMicro' });
      const usmMicro  = h('feComposite', { ns: 'svg', in: 'SourceGraphic', in2: 'bMicro', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpMicro' });

      const blurFine = h('feGaussianBlur', { ns: 'svg', in: 'sharpMicro', stdDeviation: '0.60', result: 'bFine' });
      const usmNode  = h('feComposite', { ns: 'svg', in: 'sharpMicro', in2: 'bFine', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpOut' });

      const toneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const toneXfer  = h('feComponentTransfer', { ns: 'svg', in: 'sharpOut', result: 'tone' }, ...toneFuncs);

      const bcFuncs = mkFuncRGB({ type: 'linear', slope: '1', intercept: '0' });
      const bcXfer  = h('feComponentTransfer', { ns: 'svg', in: 'tone', result: 'bc' }, ...bcFuncs);

      const gamFuncs = mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' });
      const gamXfer  = h('feComponentTransfer', { ns: 'svg', in: 'bc', result: 'gam' }, ...gamFuncs);

      const tempR    = h('feFuncR', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
      const tempG    = h('feFuncG', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
      const tempB    = h('feFuncB', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
      const tempXfer = h('feComponentTransfer', { ns: 'svg', in: 'gam', result: 'temp' }, tempR, tempG, tempB);

      const satNode = h('feColorMatrix', { ns: 'svg', in: 'temp', type: 'saturate', values: '1', result: 'final' });

      mainFilter.append(blurMicro, usmMicro, blurFine, usmNode, toneXfer, bcXfer, gamXfer, tempXfer, satNode);

      const shadowFilter = h('filter', { ns: 'svg', id: fidShadow, 'color-interpolation-filters': 'sRGB', x: '-1%', y: '-1%', width: '102%', height: '102%' });
      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const shadowToneXfer = h('feComponentTransfer', { ns: 'svg', in: 'SourceGraphic', result: 'sh_tone' }, ...shadowToneFuncs);
      shadowFilter.append(shadowToneXfer);

      defs.append(mainFilter, shadowFilter);

      const tryAppend = () => {
        const target = root.body || root.documentElement || root;
        if (target?.appendChild) { target.appendChild(svg); return true; }
        return false;
      };

      if (!tryAppend()) {
        let _fallbackMoId = 0;
        const mo = new MutationObserver(() => { if (tryAppend()) { mo.disconnect(); clearTimeout(_fallbackMoId); } });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        _fallbackMoId = setTimeout(() => mo.disconnect(), 5000);
        if (typeof __vscNs !== 'undefined' && __vscNs._timers) __vscNs._timers.push(_fallbackMoId);
        if (typeof __globalSig !== 'undefined') __globalSig.addEventListener('abort', () => { clearTimeout(_fallbackMoId); mo.disconnect(); }, { once: true });
      }

      return {
        fidMain, fidShadow,
        sharp: { blurMicro, usmMicro, blurFine, usmNode },
        color: { toneFuncs, bcFuncs, gamFuncs, tmp: { r: tempR, g: tempG, b: tempB }, sats: [satNode] },
        shadowNodes: { toneFuncs: shadowToneFuncs },
        st: {
          lastKey: '', rev: 0,
          toneKey: '', toneTable: '', bcLinKey: '', gammaKey: '', tempKey: '', satKey: '',
          blurKey: '', sharpKey: '', shadowKey: ''
        }
      };
    }

    function applySharpParams(sharpNodes, st, s) {
      const qSharp  = Math.max(0, Math.round(Number(s.sharp  || 0)));
      const qSharp2 = Math.max(0, Math.round(Number(s.sharp2 || 0)));
      const sigmaScale = Number(s._sigmaScale) || 1.0;

      const microBase  = Number(s._microBase)  || 0.16;
      const microScale = Number(s._microScale) || (1/120);
      const fineBase   = Number(s._fineBase)   || 0.32;
      const fineScale  = Number(s._fineScale)  || (1/24);
      const microAmtCoeffs = s._microAmt || [0.55, 0.10];
      const fineAmtCoeffs  = s._fineAmt  || [0.20, 0.85];

      const sigMicro = VSC_CLAMP((microBase + qSharp * microScale) * Math.min(1.0, sigmaScale), 0.30, 1.20);
      const sigFine = VSC_CLAMP((fineBase + qSharp2 * fineScale) * sigmaScale, 0.18, 2.50);

      const microAmt = Math.max(0, (qSharp * microAmtCoeffs[0] + qSharp2 * microAmtCoeffs[1]) / 45);
      const fineAmt = Math.max(0, (qSharp * fineAmtCoeffs[0] + qSharp2 * fineAmtCoeffs[1]) / 24);

      const blurKeyNext = `${sigMicro.toFixed(3)}|${sigFine.toFixed(3)}`;
      if (st.blurKey !== blurKeyNext) {
        st.blurKey = blurKeyNext;
        if (sharpNodes.blurMicro) setAttr(sharpNodes.blurMicro, 'stdDeviation', sigMicro);
        if (sharpNodes.blurFine)  setAttr(sharpNodes.blurFine,  'stdDeviation', sigFine);
      }

      const sharpKeyNext = `${microAmt.toFixed(5)}|${fineAmt.toFixed(5)}`;
      if (st.sharpKey !== sharpKeyNext) {
        st.sharpKey = sharpKeyNext;
        if (sharpNodes.usmMicro) {
          setAttr(sharpNodes.usmMicro, 'k2', parseFloat((1 + microAmt).toFixed(5)));
          setAttr(sharpNodes.usmMicro, 'k3', parseFloat((-microAmt).toFixed(5)));
        }
        if (sharpNodes.usmNode) {
          setAttr(sharpNodes.usmNode, 'k2', parseFloat((1 + fineAmt).toFixed(5)));
          setAttr(sharpNodes.usmNode, 'k3', parseFloat((-fineAmt).toFixed(5)));
        }
      }
    }

    function applyShadowParams(shadowNodes, st, shadowParams) {
      const level = shadowParams.level || 0;
      const factor = shadowParams.factor !== undefined ? shadowParams.factor : 1.0;
      if (level <= 0) return;

      const shadowKey = `crush_v4|${level}|${factor.toFixed(3)}`;
      if (st.shadowKey === shadowKey) return;
      st.shadowKey = shadowKey;

      const CRUSH_MAP = [ null,
        { power: 1.08, pull: 0.001, slope: 1.01, gamma: 1.01, offset: -0.002 },
        { power: 1.20, pull: 0.005, slope: 1.04, gamma: 1.06, offset: -0.010 },
        { power: 1.35, pull: 0.012, slope: 1.08, gamma: 1.12, offset: -0.020 }
      ];
      const p = CRUSH_MAP[level];
      const effPower = 1.0 + (p.power - 1.0) * factor;
      const effPull = p.pull * factor;
      const effSlope = 1.0 + (p.slope - 1.0) * factor;
      const effGamma = 1.0 + (p.gamma - 1.0) * factor;
      const effOffset = p.offset * factor;

      const SIZE = 128;
      const arr = new Array(SIZE);
      let prev = 0;

      for (let i = 0; i < SIZE; i++) {
        const x = i / (SIZE - 1);
        if (x <= 1e-6) { arr[i] = '0'; continue; }
        if (x >= 1.0 - 1e-6) { arr[i] = '1'; continue; }
        const t = Math.max(0, Math.min(1, 1.0 - x / 0.5));
        const blend = t * t * (3.0 - 2.0 * t);
        const crushed = Math.pow(x, effPower);
        const pulldown = effPull * (1.0 - x) * (1.0 - x);
        let y = x * (1.0 - blend) + crushed * blend - pulldown;
        y = Math.pow(Math.max(0, y), 1 / effGamma);
        y = y * effSlope + effOffset;
        y = Math.max(0, Math.min(1, y));
        if (y <= prev) y = prev + 1e-6;
        if (y > 1.0) y = 1.0;
        prev = y;
        arr[i] = String(Math.round(y * 10000) / 10000);
      }
      for (const fn of shadowNodes.toneFuncs) setAttr(fn, 'tableValues', arr.join(' '));
    }

    function prepare(video, s, shadowParams) {
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);

      let dc = urlCache.get(root);
      if (!dc) { dc = { key: '', url: '' }; urlCache.set(root, dc); }

      ensureOpaqueBg(video);

      const qSharp  = Math.round(Number(s.sharp  || 0));
      const qSharp2 = Math.round(Number(s.sharp2 || 0));
      const sharpTotal = qSharp + qSharp2;

      const shadowActive = !!(shadowParams && shadowParams.active);
      const shadowFactor = shadowActive ? (shadowParams.factor !== undefined ? shadowParams.factor.toFixed(3) : '1.000') : 'off';
      const stableKey = `unified|${makeKeyBase(s)}|sh:${shadowActive ? 'lv' + shadowParams.level + '_' + shadowFactor : 'off'}`;

      let nodes = ctxMap.get(root);
      if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }

      const needReapply = (dc.key !== stableKey);

      if (nodes.st.lastKey !== stableKey) {
        nodes.st.lastKey = stableKey; nodes.st.rev = (nodes.st.rev + 1) | 0;

        const st     = nodes.st;
        const common = nodes.color;
        const steps  = 64;

        if (sharpTotal > 0) {
          applySharpParams(nodes.sharp, st, s);
        } else {
          const bypassKey = 'bypass';
          if (st.sharpKey !== bypassKey) {
            st.sharpKey = bypassKey;
            if (nodes.sharp.usmMicro) {
              setAttr(nodes.sharp.usmMicro, 'k2', 1);
              setAttr(nodes.sharp.usmMicro, 'k3', 0);
            }
            setAttr(nodes.sharp.usmNode, 'k2', 1);
            setAttr(nodes.sharp.usmNode, 'k3', 0);
          }
        }

        const gainQ  = (s.gain || 1) < 1.4 ? 0.06 : 0.08;
        const toeQ   = Math.round(VSC_CLAMP((s.toe || 0) / TOE_DIVISOR, -1, 1) / 0.02) * 0.02;
        const shQ    = Math.round(VSC_CLAMP((s.shoulder || 0) / 16, -1, 1) / 0.02) * 0.02;
        const midQ   = Math.round(VSC_CLAMP(s.mid || 0, -1, 1) / 0.02) * 0.02;
        const rawGain = s.gain || 1;
        const gainQ2 = Math.abs(rawGain - 1.0) < 0.02 ? 1.0 : Math.round(rawGain / gainQ) * gainQ;

        const tk = `${steps}|${toeQ}|${shQ}|${midQ}|${gainQ2}`;
        const table = st.toneKey !== tk ? getToneTableCached(steps, toeQ, shQ, midQ, gainQ2) : st.toneTable;

        if (st.toneKey !== tk) { st.toneKey = tk; st.toneTable = table; for (const fn of common.toneFuncs) setAttr(fn, 'tableValues', table); }

        const con         = VSC_CLAMP(s.contrast || 1, 0.1, 5.0);
        const brightOffset = VSC_CLAMP((s.bright || 0) / 250, -0.5, 0.5);
        const intercept   = VSC_CLAMP(0.5 * (1 - con) + brightOffset, -5, 5);
        const bcLinKey    = `${con.toFixed(3)}|${intercept.toFixed(4)}`;
        if (st.bcLinKey !== bcLinKey) { st.bcLinKey = bcLinKey; for (const fn of common.bcFuncs) { setAttr(fn, 'slope', parseFloat(con.toFixed(3))); setAttr(fn, 'intercept', parseFloat(intercept.toFixed(4))); } }

        const gk = (1 / VSC_CLAMP(s.gamma || 1, 0.1, 5.0)).toFixed(4);
        if (st.gammaKey !== gk) { st.gammaKey = gk; for (const fn of common.gamFuncs) setAttr(fn, 'exponent', parseFloat(gk)); }

        const satVal = VSC_CLAMP(s.satF ?? 1, 0, 5.0).toFixed(2);
        if (st.satKey !== satVal) { st.satKey = satVal; for (const satNode of common.sats) setAttr(satNode, 'values', parseFloat(satVal)); }

        const toneNeutral = (Math.abs(s.temp || 0) < 1e-4) && (Math.abs((s.gain || 1) - 1.0) < 0.02 && Math.abs(s.toe || 0) < 0.01 && Math.abs(s.shoulder || 0) < 0.01 && Math.abs(s.mid || 0) < 0.01 && Math.abs((s.gamma || 1) - 1.0) < 0.02 && Math.abs(s.bright || 0) < 0.5 && Math.abs((s.contrast || 1) - 1.0) < 0.02 && Math.abs((s.satF ?? 1) - 1.0) < 0.02);
        const rsEff = toneNeutral ? 1.0 : (s._rs || 1), gsEff = toneNeutral ? 1.0 : (s._gs || 1), bsEff = toneNeutral ? 1.0 : (s._bs || 1);
        const rsStr = rsEff.toFixed(3), gsStr = gsEff.toFixed(3), bsStr = bsEff.toFixed(3);
        const tmk = `${rsStr}|${gsStr}|${bsStr}`;
        if (st.tempKey !== tmk) { st.tempKey = tmk; setAttr(common.tmp.r, 'slope', parseFloat(rsStr)); setAttr(common.tmp.g, 'slope', parseFloat(gsStr)); setAttr(common.tmp.b, 'slope', parseFloat(bsStr)); }

        if (shadowActive) applyShadowParams(nodes.shadowNodes, st, shadowParams);
      }

      const mainUrl = `url(#${nodes.fidMain})`;
      const shadowUrl = shadowActive ? `url(#${nodes.fidShadow})` : '';
      const combinedUrl = shadowActive ? `${shadowUrl} ${mainUrl}` : mainUrl;

      dc.key = stableKey; dc.url = combinedUrl;
      return { url: combinedUrl, changed: needReapply, rev: nodes.st.rev };
    }

    return {
      invalidateCache: (video) => {
        try {
          const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
          const nodes = ctxMap.get(root);
          if (nodes) {
            nodes.st.lastKey = ''; nodes.st.blurKey = ''; nodes.st.sharpKey = ''; nodes.st.shadowKey = '';
            nodes.st.rev = (nodes.st.rev + 1) | 0;
            nodes.st.toneKey = ''; nodes.st.toneTable = ''; nodes.st.bcLinKey = '';
            nodes.st.gammaKey = ''; nodes.st.tempKey = ''; nodes.st.satKey = '';
          }
          const dc = urlCache.get(root); if (dc) { dc.key = ''; dc.url = ''; }
        } catch (_) {}
      },
      prepareCached: (video, s, shadowParams) => { try { return prepare(video, s, shadowParams || null); } catch (e) { return { url: null, changed: false, rev: -1 }; } },
      applyUrl: (el, urlObj) => {
        if (!el) return;
        const url = typeof urlObj === 'string' ? urlObj : urlObj?.url; const st = getVState(el);
        if (!url) {
          restoreOpaqueBg(el);
          if (st.applied) {
            if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else el.style.removeProperty('filter');
            if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || ''); else el.style.removeProperty('-webkit-filter');
            st.applied = false; st.lastFilterUrl = null; st.origFilter = st.origWebkitFilter = null; st.origFilterPrio = st.origWebkitFilterPrio = '';
          }
          return;
        }
        if (!st.applied) { st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || ''; st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || ''; }
        if (st.lastFilterUrl !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }
        st.applied = true; st.lastFilterUrl = url;
      },
      canUseCssNativeOnly,
      applyCssNative
    };
  }

  function createBackendAdapter(Filters) {
    return {
      apply(video, vVals, shadowParams, useSvgFilter = true) {
        if (!useSvgFilter || (Filters.canUseCssNativeOnly && Filters.canUseCssNativeOnly(vVals, shadowParams))) {
          Filters.applyCssNative(video, vVals);
          return;
        }

        const svgResult = Filters.prepareCached(video, vVals, shadowParams);
        Filters.applyUrl(video, svgResult);
      },
      clear(video) {
        const st = getVState(video);
        if (st.applied) Filters.applyUrl(video, null);
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

  function createUI(sm, registry, ApplyReq, Utils, P, Bus) {
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

    // 🔥 [복구 완료] 실제 영상 시청 페이지 체크
    const allowUiInThisDoc = () => {
      const hn = location.hostname;
      const pn = location.pathname;
      if (hn.includes('netflix.com')) return pn.startsWith('/watch');
      if (hn.includes('coupangplay.com')) return pn.startsWith('/play');
      return true;
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
      _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); });
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

      const dragHandle = h('div', { class: 'header', title: '\uB354\uBE14\uD074\uB9AD \uC2DC \uD1B1\uB2C8\uBC14\uD034 \uC606\uC73C\uB85C \uBCF5\uADC0' }, 'VSC 렌더링 제어');

      const sharpRow = renderButtonRow({
        label: '\uC120\uBA85', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true,
        items: [ { text: 'Soft', value: 'Soft', title: '\uC57D\uD55C \uC120\uBA85\uD654' }, { text: 'Med', value: 'Medium', title: '\uC911\uAC04 \uC120\uBA85\uD654' }, { text: 'Ultra', value: 'Ultra', title: '\uAC15\uD55C \uC120\uBA85\uD654' }, { text: 'MST', value: 'Master', title: '\uCD5C\uC0C1\uC704 \uD574\uC0C1\uB3C4 \uBCF5\uAD6C \uBC0F \uC120\uBA85\uD654' } ]
      });

      const brightRow = renderButtonRow({
        label: '\uBC1D\uAE30', key: P.V_BRIGHT_LV, offValue: 0, toggleActiveToOff: true,
        items: [
          { text: '1', value: 1, title: '\uC57D\uAC04 \uBC1D\uAC8C' },
          { text: '2', value: 2, title: '\uBC1D\uAC8C' },
          { text: '3', value: 3, title: '\uB9CE\uC774 \uBC1D\uAC8C' },
          { text: '4', value: 4, title: '\uAC15\uD558\uAC8C \uBC1D\uAC8C' },
          { text: '5', value: 5, title: '\uCD5C\uB300 \uBC1D\uAE30' }
        ]
      });

      const pipBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '\uD83D\uDCFA PIP');
      pipBtn.onclick = async (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; const v = getNS()?.App?.getActiveVideo(); if(v) await togglePiPFor(v); };
      bindReactive(pipBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 1;' }, '\uD83D\uDD0D \uC90C');
      zoomBtn.onclick = (e) => {
        e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
        const zm = getNS()?.ZoomManager; const v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return;
        if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); }
        else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); }
      };
      bindReactive(zoomBtn, [P.APP_ZOOM_EN, P.APP_ACT], (el, v, act) => { el.classList.toggle('active', !!v); el.style.opacity = act ? '1' : (v ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const pwrBtn = h('button', { class: 'btn', style: 'flex: 1;', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '\u26A1 Power');
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); }, sm, sub);

      const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 1.0; font-weight: 800;' }, '\uD83D\uDD0A Audio (Dyn+RMS+Wide)');
      boostBtn.onclick = (e) => {
        e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
        if (getNS()?.AudioWarmup) getNS().AudioWarmup();
        const isCurrentlyOn = sm.get(P.A_EN); const nextState = !isCurrentlyOn;
        sm.batch('audio', { enabled: nextState, stereoWidth: nextState, multiband: true, lufs: true });
        ApplyReq.hard();
      };
      bindReactive(boostBtn, [P.A_EN, P.APP_ACT], (el, aEn, act) => { el.classList.toggle('active', !!aEn); el.style.color = aEn ? 'var(--ac)' : '#eee'; el.style.opacity = act ? '1' : '0.45'; el.disabled = !act; }, sm, sub);

      const dialogueBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '\uD83D\uDDE3\uFE0F \uB300\uD654 \uAC15\uC870');
      dialogueBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; if(sm.get(P.A_EN)) setAndHint(P.A_DIALOGUE, !sm.get(P.A_DIALOGUE)); };
      bindReactive(dialogueBtn, [P.A_DIALOGUE, P.A_EN, P.APP_ACT], (el, dOn, aEn, act) => { el.classList.toggle('active', !!dOn); const usable = !!aEn && !!act; el.style.opacity = usable ? '1' : (dOn ? '0.65' : '0.35'); el.style.cursor = usable ? 'pointer' : 'not-allowed'; el.disabled = !usable; }, sm, sub);

      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '\u25BC \uACE0\uAE09 \uC124\uC815 \uC5F4\uAE30');
      advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
      bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '\u25B2 \uACE0\uAE09 \uC124\uC815 \uB2EB\uAE30' : '\u25BC \uACE0\uAE09 \uC124\uC815 \uC5F4\uAE30'; el.style.background = v ? '#34495e' : '#2c3e50'; }, sm, sub);

      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px;' }, [
        renderButtonRow({ label: '\uC554\uBD80', key: P.V_SHADOW_MASK, offValue: 0, toggleActiveToOff: true, items: [ { text: '1\uB2E8', value: DARK_BAND.LV1, title: '\uC57D\uD55C \uC554\uBD80 \uAC15\uD654' }, { text: '2\uB2E8', value: DARK_BAND.LV2, title: '\uC911\uAC04 \uC554\uBD80 \uAC15\uD654' }, { text: '3\uB2E8', value: DARK_BAND.LV3, title: '\uAC15\uD55C \uC554\uBD80 \uAC15\uD654' } ] }),
        renderButtonRow({ label: '\uC0C9\uC628', key: P.V_TEMP, offValue: 0, toggleActiveToOff: true, items: [
          { text: '\uBCF4\uD638', value: 30,  title: '\uAC15\uD55C \uB178\uB780\uB07C (\uD655\uC2E4\uD55C \uB208 \uBCF4\uD638)' },
          { text: '\uB530\uB73B', value: 15,  title: '\uBD80\uB4DC\uB7EC\uC6B4 \uD654\uBA74 (\uC77C\uC0C1\uC6A9)' },
          { text: '\uB9D1\uC74C', value: -10, title: '\uAE68\uB057\uD55C \uD654\uC774\uD2B8 (\uC601\uD654 \uCD94\uCC9C)' },
          { text: '\uB0C9\uC0C9', value: -25, title: '\uC950\uD55C \uD30C\uB780\uB07C (\uC560\uB2C8 \uCD94\uCC9C)' }
        ] }),
        h('hr'),
        renderButtonRow({ label: '\uC2DC\uACC4', key: P.APP_TIME_EN, offValue: false, toggleActiveToOff: true, items: [{ text: '\uD45C\uC2DC (\uC804\uCCB4\uD654\uBA74)', value: true }] }),
        renderButtonRow({ label: '\uC704\uCE58', key: P.APP_TIME_POS, items: [{ text: '\uC88C', value: 0 }, { text: '\uC911', value: 1 }, { text: '\uC6B0', value: 2 }] }),
        h('hr')
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none', sm, sub);

      const resetBtn = h('button', { class: 'btn' }, '\u21BA \uB9AC\uC14B');
      resetBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); ApplyReq.hard(); };
      bindReactive(resetBtn, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);

      const bodyMain = h('div', { id: 'p-main' }, [
        sharpRow, brightRow,
        h('div', { class: 'prow' }, [ pipBtn, zoomBtn, pwrBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 4px;' }, [ boostBtn, dialogueBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 8px;' }, [ h('button', { class: 'btn', style: 'background:#333;', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '\u2715 \uB2EB\uAE30'), resetBtn ]),
        advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x');
          b.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); };
          bindReactive(b, [P.PB_RATE, P.PB_EN, P.APP_ACT], (el, rate, en, act) => { const isActive = !!en && Math.abs(Number(rate || 1) - s) < 0.01; el.classList.toggle('active', isActive); el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);
          return b;
        })),
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [
          { text: '\u25C0 30s', action: 'seek', val: -30 }, { text: '\u25C0 15s', action: 'seek', val: -15 }, { text: '\u23F8 \uC815\uC9C0', action: 'pause' }, { text: '\u25B6 \uC7AC\uC0DD', action: 'play' }, { text: '15s \u25B6', action: 'seek', val: 15 }, { text: '30s \u25B6', action: 'seek', val: 30 }
        ].map(cfg => {
          const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text);
          b.onclick = (e) => {
            e.stopPropagation(); if (!sm.get(P.APP_ACT)) return;
            const v = getNS()?.App?.getActiveVideo(); if (!v) return;
            if (cfg.action === 'play') { v.play().catch(() => {}); }
            else if (cfg.action === 'pause') { v.pause(); }
            else if (cfg.action === 'seek') {
              const isLive = !Number.isFinite(v.duration); let minT = 0, maxT = v.duration;
              if (isLive || v.duration === Infinity) { const sr = v.seekable; if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
              let target = v.currentTime + cfg.val; if (cfg.val > 0 && target >= maxT) target = maxT - 0.1;
              target = Math.max(minT, Math.min(maxT, target)); try { v.currentTime = target; } catch (_) {}
              let fallbackTimer = 0; const onSeeked = () => { v.removeEventListener('seeked', onSeeked); clearTimeout(fallbackTimer); if (Math.abs(v.currentTime - target) > 5.0) { try { v.currentTime = target; } catch (_) {} } };
              v.addEventListener('seeked', onSeeked, { once: true }); fallbackTimer = setTimeout(() => { v.removeEventListener('seeked', onSeeked); }, 3000);
            }
          };
          bindReactive(b, [P.APP_ACT], (el, act) => { el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }, sm, sub);
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
      if (gearHost) return;
      gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' });
      const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${getNS()?.CONFIG?.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
      attachShadowStyles(shadow, style);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '\u2699'); shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);

      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.15'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.();
        const startY = e.clientY; const rect = gearBtn.getBoundingClientRect();
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
        lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI));
      };
      on(gearBtn, 'pointerup', (e) => { safe(() => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); }); onGearActivate(e); }, { passive: false });

      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; const gearTarget = document.fullscreenElement || document.body || document.documentElement; try { if (gearHost && gearHost.parentNode !== gearTarget) gearTarget.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== gearTarget) gearTarget.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };

    // 🔥 실제 동작 통제 로직
    const ensure = () => {
      // 경로가 안 맞거나 비디오가 없으면 기어를 숨김
      if (!allowUiInThisDoc() || (registry.videos.size === 0 && !sm.get(P.APP_UI))) {
        detachNodesHard();
        return;
      }

      ensureGear();

      const mainPanel = getMainPanel();
      if (sm.get(P.APP_UI)) {
        build();
        const mp = getMainPanel();
        if (mp && !mp.classList.contains('visible')) {
          mp.style.display = 'block';
          mp.classList.add('visible');
          queueMicrotask(clampPanelIntoViewport);
        }
      } else {
        if (mainPanel) {
          mainPanel.classList.remove('visible');
          mainPanel.style.display = 'none';
        }
      }

      mount();
      safe(() => wakeGear?.());
    };

    onPageReady(() => { safe(() => { ensure(); ApplyReq.hard(); }); });

    return { ensure, destroy: () => { uiUnsubs.forEach(u => safe(u)); uiUnsubs.length = 0; safe(() => uiWakeCtrl.abort()); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
  }

  function createUIFeature(Store, Registry, ApplyReq, Utils, P, Bus) {
    let uiInst = null;
    return defineFeature({
      name: 'ui',
      phase: PHASE.RENDER,
      onInit() {
        uiInst = createUI(Store, Registry, ApplyReq, Utils, P, Bus);
        this.subscribe('video:detected', () => { uiInst?.ensure(); });
      },
      onUpdate() { uiInst?.ensure(); },
      onDestroy() { uiInst?.destroy(); }
    });
  }

  function createZoomManager(Store, P) {
    const stateMap = new WeakMap();
    let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    const zoomedVideos = new Set();
    let activePointerId = null;

    const zoomAC = new AbortController();
    const zsig = combineSignals(zoomAC.signal, __globalSig);

    const getSt = (v) => {
      let st = stateMap.get(v);
      if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origStyle: '' }; stateMap.set(v, st); }
      return st;
    };

    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const st = getSt(v);
        const panning = isPanning || pinchState.active;

        if (st.scale <= 1) {
          if (st.zoomed) {
            v.style.cssText = st.origStyle;
            st.zoomed = false;
          }
          st.scale = 1;
          st.tx = 0;
          st.ty = 0;
          zoomedVideos.delete(v);
          return;
        }

        if (!st.zoomed) {
          st.origStyle = v.style.cssText;
          st.zoomed = true;
        }

        v.style.cssText =
          st.origStyle +
          `; will-change: transform !important;
             contain: paint !important;
             backface-visibility: hidden !important;
             transition: ${panning ? 'none' : 'transform 80ms ease-out'} !important;
             transform-origin: 0 0 !important;
             transform: translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)}) !important;
             cursor: ${panning ? 'grabbing' : 'grab'} !important;
             z-index: 2147483646 !important;
             position: relative !important;`;

        zoomedVideos.add(v);
      });
    };

    function clampPan(v, st) {
      const r = v.getBoundingClientRect();
      if (!r || r.width <= 1 || r.height <= 1) return;
      const sw = r.width * st.scale, sh = r.height * st.scale;
      st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75);
      st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75);
    }

    const zoomTo = (v, newScale, cx, cy) => {
      const st = getSt(v);
      const r = v.getBoundingClientRect();
      if (!r || r.width <= 1) return;
      const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale;
      st.tx = cx - (r.left - st.tx) - ix * newScale;
      st.ty = cy - (r.top - st.ty) - iy * newScale;
      st.scale = newScale; update(v);
    };

    const resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

    let unsubAct = null, unsubZoomEn = null;
    if (Store?.sub) {
      unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } });
      unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { for (const v of [...zoomedVideos]) resetZoom(v); zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } });
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
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v);
      let newScale = Math.min(Math.max(1, st.scale * delta), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'pointerdown', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v); if (st.scale <= 1) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false;
      startX = e.clientX - st.tx; startY = e.clientY - st.ty;
      try { v.setPointerCapture?.(e.pointerId); } catch (_) {}
      update(v);
    }, { capture: true, passive: false, signal: zsig });

    on(window, 'pointermove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const st = getSt(activeVideo);
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
      const last = events.length ? events[events.length - 1] : e;
      const nextTx = last.clientX - startX;
      const nextTy = last.clientY - startY;
      if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) { st.hasPanned = true; }
      st.tx = nextTx; st.ty = nextTy;
      clampPan(activeVideo, st); update(activeVideo);
    }, { capture: true, passive: false, signal: zsig });

    function endPointerPan(e) {
      if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const v = activeVideo; const st = getSt(v);
      try { v.releasePointerCapture?.(e.pointerId); } catch (_) {}
      if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activePointerId = null; isPanning = false; activeVideo = null; update(v);
    }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });

    on(window, 'dblclick', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return;
      e.preventDefault(); e.stopPropagation();
      const st = getSt(v);
      if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true, signal: zsig });

    on(window, 'touchstart', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      const v = getTargetVideo(e); if (!v) return;
      const st = getSt(v);
      if (e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale;
        const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
      }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchmove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
        let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; }
        else {
          zoomTo(activeVideo, newScale, center.x, center.y);
          st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
          clampPan(activeVideo, st); update(activeVideo);
        }
        pinchState.lastCx = center.x; pinchState.lastCy = center.y;
      }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchend', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return;
      if (e.touches.length < 2) pinchState.active = false;
      if (e.touches.length === 0) { update(activeVideo); activeVideo = null; }
    }, { passive: false, capture: true, signal: zsig });

    return {
      resetZoom, zoomTo, isZoomed, setEnabled: () => {},
      pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } },
      destroy: () => {
        try { unsubAct?.(); } catch(_) {} try { unsubZoomEn?.(); } catch(_) {}
        zoomAC.abort();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; }
        zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null;
      }
    };
  }

  function createZoomFeature(Store, P) {
    let zm = null;
    return defineFeature({
      name: 'zoom', phase: PHASE.PROCESS,
      onInit() { zm = createZoomManager(Store, P); },
      onDestroy() { zm?.destroy(); },
      methods: {
        pruneDisconnected: () => zm?.pruneDisconnected(),
        isZoomed: (v) => zm?.isZoomed(v),
        zoomTo: (v, s, x, y) => zm?.zoomTo(v, s, x, y),
        resetZoom: (v) => zm?.resetZoom(v)
      }
    });
  }

// =================== PART 2 END ===================
// =================== PART 3 START ===================

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); ensureMobileInlinePlaybackHints(v);

    const softResetTransientFlags = () => {
      st.audioFailUntil = 0; st.rect = null; st.rectT = 0; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; }
      if (st.rateState) { st.rateState.orig = null; st.rateState.lastSetAt = 0; st.rateState.suppressSyncUntil = 0; st.rateState.backoff?.reset?.(); }
      ApplyReq.hard();
    };
    const combinedSignal = combineSignals(st._ac.signal, __globalSig); const opts = { passive: true, signal: combinedSignal };

    const videoEvents = [
      ['loadstart', softResetTransientFlags],
      ['loadedmetadata', softResetTransientFlags],
      ['emptied', softResetTransientFlags],
      ['seeking', () => ApplyReq.hard()],
      ['play', () => { ApplyReq.hard(); }],
      ['ratechange', () => {
        const rSt = getRateState(v); const now = performance.now();
        if ((now - (rSt.lastSetAt || 0)) < 180 || now < (rSt.suppressSyncUntil || 0)) return;
        const desired = st.desiredRate;
        if (Number.isFinite(desired) && Math.abs(v.playbackRate - desired) < 0.05) return;
        const store = getNS()?.Store; if (!store) return;
        const activeVideo = getNS()?.App?.getActiveVideo?.();
        if (!activeVideo || v !== activeVideo) return;
        const cur = v.playbackRate;
        if (Number.isFinite(cur) && cur > 0) { store.batch('playback', { rate: cur, enabled: true }); }
      }]
    ];
    for (const [ev, fn] of videoEvents) on(v, ev, fn, opts);
  };

  function createRateBackoff(maxLevel = 5) {
    return {
      level: 0, lastAt: 0, attempts: 0, firstAttemptT: 0,
      shouldSkip(now, suppressUntil) { return now < (suppressUntil || 0); },
      recordAttempt(now) {
        if (!this.firstAttemptT || (now - this.firstAttemptT) > 2500) {
          this.firstAttemptT = now;
          this.attempts = 0;
        }
        this.attempts++;
      },
      isOverLimit() { return this.attempts > 6; },
      escalate(now) {
        this.level = Math.min(this.level + 1, maxLevel);
        this.lastAt = now;
        this.attempts = 0;
        const ms = Math.min(30000, (1000 * (2 ** (this.level - 1))) | 0);
        return now + ms + ((Math.random() * 220) | 0);
      },
      decay(now) {
        if (this.level > 0 && (now - this.lastAt) > 1200) {
          this.level = Math.max(0, this.level - 1);
        }
      },
      reset() {
        this.level = 0; this.lastAt = 0;
        this.attempts = 0; this.firstAttemptT = 0;
      }
    };
  }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) {
      st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, backoff: createRateBackoff(5) };
    }
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) {
    const st = getRateState(v); const now = performance.now();
    st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
  }

  function restoreRateOne(el) {
    try {
      const st = getRateState(el);
      if (!st || st.orig == null) return;
      const nextRate = Number.isFinite(st.orig) && st.orig > 0 ? st.orig : 1.0;
      st.orig = null; markInternalRateChange(el, 220); el.playbackRate = nextRate;
    } catch (_) {}
  }

  function ensureMobileInlinePlaybackHints(video) {
    if (!video || !getNS()?.CONFIG?.IS_MOBILE) return;
    safe(() => {
      if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
      if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
    });
  }

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el); const now = performance.now();
    if (rSt.backoff.shouldSkip(now, rSt.suppressSyncUntil)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate;

    const rateMatches = Math.abs(el.playbackRate - desiredRate) < 0.01;
    if (Object.is(st.desiredRate, desiredRate) && rateMatches) {
      rSt.backoff.decay(now);
      TOUCHED.rateVideos.add(el);
      return;
    }

    rSt.backoff.recordAttempt(now);

    if (rSt.backoff.isOverLimit()) {
      rSt.suppressSyncUntil = rSt.backoff.escalate(now);
      return;
    }

    st.desiredRate = desiredRate; markInternalRateChange(el, 250);
    try { el.playbackRate = desiredRate; } catch (_) {}

    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
        markInternalRateChange(el, 250);
        try { el.playbackRate = desiredRate; } catch (_) {}
        requestAnimationFrame(() => {
          if (!el.isConnected) return;
          if (Math.abs(el.playbackRate - desiredRate) > 0.01) {
            rSt.suppressSyncUntil = rSt.backoff.escalate(performance.now());
          } else { rSt.backoff.decay(performance.now()); }
        });
      } else { rSt.backoff.decay(performance.now()); }
    });
    TOUCHED.rateVideos.add(el);
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, isNeutralParams, isNeutralShadow, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget }) {
    const candidates = scratch; candidates.clear();

    if (dirtyVideos.size > 0) dirtyVideos.forEach(v => candidates.add(v));
    applySet.forEach(v => candidates.add(v));

    if (TOUCHED.videos.size > 0) {
      TOUCHED.videos.forEach(v => { if (!candidates.has(v)) candidates.add(v); });
    }
    if (TOUCHED.rateVideos.size > 0) {
      TOUCHED.rateVideos.forEach(v => { if (!candidates.has(v)) candidates.add(v); });
    }

    const isApplyAll = !!getNS()?.Store?.get('app.applyAll');

    for (const el of candidates) {
      if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); continue; }
      bindVideoOnce(el, ApplyReq);

      const st = getVState(el);
      const shouldApply = applySet.has(el) && (isApplyAll || st.visible !== false || el === activeTarget || isPiPActiveVideo(el));

      if (!shouldApply) {
        if (!st.applied && st.desiredRate === undefined) continue;
        Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el);
        continue;
      }

      const params = getParamsForVideo(el);
      const vVals = params.video; const shadowVals = params.shadow; const budget = params.budget;
      const videoFxOn = !isNeutralParams(vVals) || !isNeutralShadow(shadowVals);

      if (videoFxOn) {
        Adapter.apply(el, vVals, shadowVals, budget.useSvgFilter);
        TOUCHED.videos.add(el);
      }
      else { Adapter.clear(el); TOUCHED.videos.delete(el); }

      if (pbActive) { applyPlaybackRate(el, desiredRate); }
      else {
        if (st.desiredRate !== undefined) { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
      }
    }
  }

  function createPerfGovernor() {
    const perVideo = new WeakMap();
    const MODES = ['low', 'mid', 'high'];
    const MODE_IDX = { low: 0, mid: 1, high: 2 };

    let globalMode = 'high';
    let confirmCount = 0;
    let pendingMode = null;
    let lastTransitionT = 0;

    // 1. 샘플링 간격을 대폭 늘림 (자주 검사 안 함)
    const SAMPLE_INTERVAL = { high: 5000, mid: 3000, low: 2000 };

    // 2. 프레임 드랍 변경
    const THRESHOLDS = {
      downToMid: 0.20,  // 프레임 20%가 사라져야 '중간'으로 강등
      downToLow: 0.30,  // 프레임 30%가 사라져야 '최저'로 강등
      upToMid: 0.05,
      upToHigh: 0.02,
      emergency: 0.40   // 프레임 40%가 되면 비상 모드
    };

    // 3. 확정 횟수를 늘림 (순간적인 렉은 '실수'로 간주하고 무시)
    const CONFIRM_DOWN = 5; // 5번 연속으로 프레임이 개판이어야 비로소 하향 조정
    // 하향 조절 쿨다운을 늘려 일시적 렉에 등급이 훅 떨어지는 걸 막습니다.
    const COOLDOWN_DOWN = 10000; // 한번 High면 웬만해선 10초간 등급 안 낮춤

    // 상향 복구 쿨다운을 줄여서 성능이 돌아오면 즉시 화질을 복구합니다.
    const COOLDOWN_UP = 500;     // 0.5초만 사양 여유 생기면 바로 원상복구

    function transitionTo(newMode) {
      if (newMode === globalMode) return;
      globalMode = newMode; lastTransitionT = performance.now(); pendingMode = null; confirmCount = 0;
    }

    function tryTransition(candidateMode, now) {
      const currentIdx = MODE_IDX[globalMode]; const candidateIdx = MODE_IDX[candidateMode];
      const isUpgrade = candidateIdx > currentIdx; const cooldown = isUpgrade ? COOLDOWN_UP : COOLDOWN_DOWN;
      if ((now - lastTransitionT) < cooldown) return;
      const requiredConfirms = isUpgrade ? CONFIRM_UP : CONFIRM_DOWN;
      if (pendingMode === candidateMode) {
        confirmCount++; if (confirmCount >= requiredConfirms) { transitionTo(candidateMode); }
      } else { pendingMode = candidateMode; confirmCount = 1; }
    }

    function sample(video) {
      if (!video?.getVideoPlaybackQuality) return globalMode;
      const q = video.getVideoPlaybackQuality(); const now = performance.now();
      const prev = perVideo.get(video);
      if (!prev) { perVideo.set(video, { t: now, total: q.totalVideoFrames || 0, dropped: q.droppedVideoFrames || 0 }); return globalMode; }
      const interval = SAMPLE_INTERVAL[globalMode] || 1000; const dt = now - prev.t;
      if (dt < interval) return globalMode;
      const dTotal = Math.max(0, (q.totalVideoFrames || 0) - prev.total);
      const dDrop = Math.max(0, (q.droppedVideoFrames || 0) - prev.dropped);
      prev.t = now; prev.total = q.totalVideoFrames || 0; prev.dropped = q.droppedVideoFrames || 0;
      if (dTotal < 12) return globalMode;
      const dropRatio = dDrop / dTotal;
      if (dropRatio >= THRESHOLDS.emergency) { transitionTo('low'); return globalMode; }
      let candidateMode = globalMode;
      if (globalMode === 'high') {
        if (dropRatio >= THRESHOLDS.downToLow) candidateMode = 'low'; else if (dropRatio >= THRESHOLDS.downToMid) candidateMode = 'mid';
      } else if (globalMode === 'mid') {
        if (dropRatio >= THRESHOLDS.downToLow) candidateMode = 'low'; else if (dropRatio < THRESHOLDS.upToHigh) candidateMode = 'high';
      } else {
        if (dropRatio < THRESHOLDS.upToHigh) candidateMode = 'high'; else if (dropRatio < THRESHOLDS.upToMid) candidateMode = 'mid';
      }
      if (candidateMode !== globalMode) { tryTransition(candidateMode, now); } else { pendingMode = null; confirmCount = 0; }
      return globalMode;
    }

    function getBudget(video) {
      const mode = sample(video);
      // 🔥 요청하신 성능 차감(Fallback) 로직 완벽 복원
      if (mode === 'low') return { mode, sharpMul: 0.50, shadowCap: 1, sigmaMul: 0.80, useSvgFilter: false };
      if (mode === 'mid') return { mode, sharpMul: 0.75, shadowCap: 2, sigmaMul: 0.90, useSvgFilter: true };
      return { mode, sharpMul: 1.00, shadowCap: 3, sigmaMul: 1.00, useSvgFilter: true };
    }
    return { getBudget, getMode: () => globalMode };
  }

  // ──────────────────────────────────────────────
  // ① RESOLUTION LAYER
  // ──────────────────────────────────────────────
  function computeResolutionSharpMul(video) {
    const nW = video.videoWidth || 0;
    const nH = video.videoHeight || 0;
    const dW = video.clientWidth || video.offsetWidth || 0;
    const dH = video.clientHeight || video.offsetHeight || 0;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const isMobile = CONFIG.IS_MOBILE;

    if (nW < 16 || dW < 16) return 0.0;

    const effectiveDisplayW = dW * dpr;
    const effectiveDisplayH = dH * dpr;
    const ratioW = effectiveDisplayW / nW;
    const ratioH = effectiveDisplayH / Math.max(1, nH);
    const ratio = Math.max(ratioW, ratioH);

    let mul = 1.0;
    if (ratio < 0.5) mul = 0.3;
    else if (ratio < 1.0) mul = 0.3 + (ratio - 0.5) * (0.85 - 0.3) / 0.5;
    else if (ratio <= 1.5) mul = 1.0;
    else if (ratio <= 3.0) mul = 1.0 + (ratio - 1.5) * 0.25;
    else { mul = 1.375 - (ratio - 3.0) * 0.15; mul = Math.max(0.6, mul); }

    if (nW <= 640 && nH <= 480) mul *= 0.55;
    else if (nW <= 960) mul *= 0.75;

    if (isMobile) mul *= VSC_CLAMP(1.05 / dpr, 0.55, 0.85);
    else if (dpr >= 1.25) mul *= VSC_CLAMP(1.5 / dpr, 0.75, 1.0);

    return VSC_CLAMP(mul, 0.0, 0.5);
  }

  // ──────────────────────────────────────────────
  // ③ CONTENT LAYER v2 (180.6.1에서 복원 완료)
  // ──────────────────────────────────────────────
  function createContentAwareSharpTuner() {
    let canvas = null;
    let ctx2d = null;
    let lastAnalysisT = 0;
    let cachedMultiplier = 1.0;
    let failCount = 0;

    let _trackedSrc = '';
    let _lastComplexity = 0.5;
    const EMA_ALPHA = 0.35;

    const ANALYSIS_INTERVAL = 3000;
    const MAX_FAILS = 3;
    const SAMPLE_W = 64;
    const SAMPLE_H = 36;

    function checkSourceChange(video) {
      const src = video.currentSrc || video.src || '';
      if (src !== _trackedSrc) {
        _trackedSrc = src;
        cachedMultiplier = 1.0;
        _lastComplexity = 0.5;
        lastAnalysisT = 0;
        failCount = 0;
        return true;
      }
      return false;
    }

    function analyzeDetailDensity(video) {
      checkSourceChange(video);

      const now = performance.now();
      if (now - lastAnalysisT < ANALYSIS_INTERVAL) return cachedMultiplier;
      if (failCount >= MAX_FAILS) return cachedMultiplier;
      lastAnalysisT = now;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return cachedMultiplier;

      if (!canvas) {
        try {
          canvas = new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
          ctx2d = canvas.getContext('2d', { willReadFrequently: true });
        } catch (_) {
          canvas = document.createElement('canvas');
          canvas.width = SAMPLE_W;
          canvas.height = SAMPLE_H;
          ctx2d = canvas.getContext('2d', { willReadFrequently: true });
        }
      }

      try {
        ctx2d.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
        const imgData = ctx2d.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
        const data = imgData.data;

        let edgeSum = 0;
        let colorVariance = 0;
        let pixelCount = 0;

        for (let y = 1; y < SAMPLE_H - 1; y++) {
          for (let x = 1; x < SAMPLE_W - 1; x++) {
            const idx = (y * SAMPLE_W + x) * 4;

            const lum  = data[idx] * 0.299 + data[idx+1] * 0.587 + data[idx+2] * 0.114;
            const lumL = data[idx-4] * 0.299 + data[idx-3] * 0.587 + data[idx-2] * 0.114;
            const lumR = data[idx+4] * 0.299 + data[idx+5] * 0.587 + data[idx+6] * 0.114;
            const lumU = data[((y-1)*SAMPLE_W+x)*4] * 0.299 + data[((y-1)*SAMPLE_W+x)*4+1] * 0.587 + data[((y-1)*SAMPLE_W+x)*4+2] * 0.114;
            const lumD = data[((y+1)*SAMPLE_W+x)*4] * 0.299 + data[((y+1)*SAMPLE_W+x)*4+1] * 0.587 + data[((y+1)*SAMPLE_W+x)*4+2] * 0.114;

            const gx = lumR - lumL;
            const gy = lumD - lumU;
            edgeSum += Math.sqrt(gx * gx + gy * gy);

            const cr = data[idx], cg = data[idx+1], cb = data[idx+2];
            const diffR = Math.abs(cr - data[idx-4]) + Math.abs(cr - data[idx+4]);
            const diffG = Math.abs(cg - data[idx-3]) + Math.abs(cg - data[idx+5]);
            const diffB = Math.abs(cb - data[idx-2]) + Math.abs(cb - data[idx+6]);
            colorVariance += (diffR + diffG + diffB) / 6;

            pixelCount++;
          }
        }

        const avgEdge = edgeSum / Math.max(1, pixelCount);
        const avgColorVar = colorVariance / Math.max(1, pixelCount);

        const edgeScore = VSC_CLAMP((avgEdge - 3.0) / 10.0, 0.0, 1.0);
        const colorScore = VSC_CLAMP((avgColorVar - 4.0) / 16.0, 0.0, 1.0);
        const complexity = edgeScore * 0.7 + colorScore * 0.3;

        const rawMul = 0.55 + complexity * 0.55;

        if (cachedMultiplier === 1.0 && lastAnalysisT === now) {
          cachedMultiplier = rawMul;
        } else {
          cachedMultiplier += (rawMul - cachedMultiplier) * EMA_ALPHA;
        }

        _lastComplexity += (complexity - _lastComplexity) * EMA_ALPHA;
        failCount = 0;

      } catch (_) {
        failCount++;
      }

      return cachedMultiplier;
    }

    function getSigmaHint() {
      if (_lastComplexity <= 0.5) {
        return 0.85 + _lastComplexity * 0.30;
      } else {
        return 1.00 + (_lastComplexity - 0.5) * 0.10;
      }
    }

    function reset() {
      cachedMultiplier = 1.0;
      _lastComplexity = 0.5;
      lastAnalysisT = 0;
      failCount = 0;
      _trackedSrc = '';
    }

    return {
      analyzeDetailDensity,
      getMultiplier: () => cachedMultiplier,
      getSigmaHint,
      getComplexity: () => _lastComplexity,
      reset
    };
  }

  // ──────────────────────────────────────────────
  // 파이프라인 통합
  // ──────────────────────────────────────────────
  function createVideoParamsMemo() {
    const contentTuner = createContentAwareSharpTuner();

    function computeBaseSigmaScale(video) {
      const dW = video.clientWidth || video.offsetWidth || 0;
      if (dW < 16) return 1.0;
      const refW = Math.max(640, Math.min(3840, dW));
      return Math.sqrt(refW / 1920);
    }

    function srcHash(video) {
      const s = video?.currentSrc || video?.src || '';
      if (!s) return '0';
      let h = 5381;
      for (let i = 0, len = Math.min(s.length, 200); i < len; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      }
      return String(h >>> 0);
    }

    const _cache = new Map();
    const MAX_MEMO = 16;

    return {
      get(vfUser, video, budget) {
        const nW = video?.videoWidth || 0, nH = video?.videoHeight || 0;
        const dW = video?.clientWidth || video?.offsetWidth || 0;
        const dH = video?.clientHeight || video?.offsetHeight || 0;

        const sh = video ? srcHash(video) : '0';

        const inputKey = [
          vfUser.presetS, vfUser.brightLevel, vfUser.shadowBandMask, vfUser.temp,
          nW, nH, dW, dH, budget.mode, budget.sharpMul, budget.shadowCap, budget.sigmaMul, sh
        ].join('|');

        const cached = _cache.get(inputKey);
        if (cached) {
          if (video && video.readyState >= 2) {
            const freshContentMul = contentTuner.analyzeDetailDensity(video);
            if (Math.abs(freshContentMul - (cached._lastContentMul || 1.0)) > 0.05) {
              _cache.delete(inputKey);
            } else {
              return cached;
            }
          } else {
            return cached;
          }
        }

        const detailP = PRESETS.detail[vfUser.presetS || 'off'];
        const brightP = PRESETS.bright[VSC_CLAMP(vfUser.brightLevel || 0, 0, 5)] || PRESETS.bright[0];
        const userTemp = vfUser.temp || 0;
        const { rs, gs, bs } = tempToRgbGain(userTemp);

        const resMul = video ? computeResolutionSharpMul(video) : 0.0;
        const perfMul = budget.sharpMul;
        const contentMul = (video && video.readyState >= 2) ? contentTuner.analyzeDetailDensity(video) : 1.0;

        // 🔥 불필요한 감쇄 로직 삭제: 순수하게 성능/해상도/콘텐츠 배율만 적용
        const finalSharpMul = resMul * perfMul * contentMul;

        const baseSigma = video ? computeBaseSigmaScale(video) : 1.0;
        const sigmaHint = contentTuner.getSigmaHint();
        const finalSigmaScale = baseSigma * sigmaHint;

        // 🔥 colorFactor 로직 자체를 삭제하고 프리셋 설정값(detailP, brightP)을 100% 그대로 사용
        const videoOut = {
          sharp:    Math.round((detailP.sharpAdd  || 0) * finalSharpMul),
          sharp2:   Math.round((detailP.sharp2Add || 0) * finalSharpMul),
          satF:     detailP.sat || 1.0,           // 억제 없이 프리셋 값 그대로
          gamma:    brightP.gammaF || 1.0,        // 억제 없이 프리셋 값 그대로
          bright:   brightP.brightAdd || 0,       // 억제 없이 프리셋 값 그대로
          contrast: 1.0,
          temp:      userTemp,
          gain:      1.0,
          mid:       0,
          toe:       0,
          shoulder: 0,
          _sigmaScale: finalSigmaScale * budget.sigmaMul,
          _refW: Math.max(640, Math.min(3840, dW)),
          _rs: rs, _gs: gs, _bs: bs,
          _microBase:  detailP.microBase  || 0.16,
          _microScale: detailP.microScale || (1/120),
          _fineBase:   detailP.fineBase   || 0.32,
          _fineScale:  detailP.fineScale  || (1/24),
          _microAmt:   detailP.microAmt   || [0.55, 0.10],
          _fineAmt:    detailP.fineAmt    || [0.20, 0.85]
        };

        const sLevel = VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0;
        const shadowLevel = Math.min(sLevel, budget.shadowCap);
        const shadowOut = {
          level: shadowLevel,
          active: shadowLevel > 0,
          factor: 1.0 // 항상 최대 효율 유지
        };

        const result = {
          video: videoOut,
          shadow: shadowOut,
          budget,
          _lastContentMul: contentMul
        };

        if (_cache.size >= MAX_MEMO) _cache.delete(_cache.keys().next().value);
        _cache.set(inputKey, result);
        return result;
      },
      resetContentAnalysis() {
        contentTuner.reset();
      }
    };
  }

  function isNeutralVideoParams(p) {
    const near = (a, b, eps = 1e-4) => Math.abs((a || 0) - b) <= eps;
    return (
      (p.sharp|0) === 0 && (p.sharp2|0) === 0 &&
      near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) && near(p.satF, 1.0) &&
      near(p.temp, 0) &&
      near(p._rs, 1.0) && near(p._gs, 1.0) && near(p._bs, 1.0) &&
      near(p.gain, 1.0) && near(p.mid, 0.0) && near(p.toe, 0.0) && near(p.shoulder, 0.0)
    );
  }

  function isNeutralShadowParams(sp) { return !sp || !sp.active; }

  // 🔥 PATCH 5: pipeline:degraded 매 사이클 이벤트 스팸 방지
  function createPipelineFeature(Store, Registry, Adapter, ApplyReq, P, Targeting, PerfGovernor, videoParamsMemo) {
    const _applySet = new Set();
    const _scratchCandidates = new Set();
    let _prevPerfMode = 'high';

    return defineFeature({
      name: 'pipeline',
      phase: PHASE.COMPUTE,
      onUpdate(ctx) {
        const { active, target, vidsDirty, pbActive, isApplyAll, desiredRate } = ctx;

        if (!active) {
          TOUCHED.videos.forEach(v => { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); });
          TOUCHED.rateVideos.forEach(v => { getVState(v).desiredRate = undefined; restoreRateOne(v); });
          TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
          return;
        }

        const vf0 = Store.getCatRef('video');
        const activeBudget = PerfGovernor.getBudget(target);

        // 이전 성능 상태와 다를 때만 이벤트 발행 (CPU 최적화)
        if (activeBudget.mode !== _prevPerfMode) {
          const isDowngrade = { high: 2, mid: 1, low: 0 }[activeBudget.mode] < { high: 2, mid: 1, low: 0 }[_prevPerfMode];
          if (isDowngrade) {
            this.emit('pipeline:degraded', { mode: activeBudget.mode, prev: _prevPerfMode });
          } else {
            this.emit('pipeline:restored', { mode: activeBudget.mode, prev: _prevPerfMode });
          }
          _prevPerfMode = activeBudget.mode;
        }

        const getParamsForVideo = (el) => {
          const budget = (el === target || isPiPActiveVideo(el))
            ? activeBudget
            : { mode: 'high', sharpMul: 1, shadowCap: 3, sigmaMul: 1, useSvgFilter: true };
          return videoParamsMemo.get(vf0, el, budget);
        };

        _applySet.clear();
        if (isApplyAll) { for (const v of Registry.visible.videos) _applySet.add(v); }
        else if (target) { _applySet.add(target); }

        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, getParamsForVideo, isNeutralParams: isNeutralVideoParams, isNeutralShadow: isNeutralShadowParams, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates, activeTarget: target });
      },
      onDestroy() {
        TOUCHED.videos.forEach(v => { try { Adapter.clear(v); } catch(_){} });
        TOUCHED.rateVideos.forEach(v => { try { restoreRateOne(v); } catch(_){} });
        TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
      }
    });
  }

  function createTimerFeature() {
    let _intervalId = null;
    let _timerEl = null;

    return defineFeature({
      name: 'timer',
      phase: PHASE.RENDER,
      onInit() {
        this.subscribe('fullscreen:changed', ({ active }) => {
          if (!active && _timerEl) _timerEl.style.display = 'none';
        });
        _intervalId = setInterval(() => {
          const act = this.getSetting('app.active'), timeEn = this.getSetting('app.timeEn'), isFs = !!document.fullscreenElement;
          if (!act || !timeEn || !isFs) { if (_timerEl) _timerEl.style.display = 'none'; return; }

          const activeVideo = this.getActiveVideo();
          if (!activeVideo || !activeVideo.isConnected) { if (_timerEl) _timerEl.style.display = 'none'; return; }
          const parent = activeVideo.parentNode; if (!parent) return;

          if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
          }

          if (!_timerEl || _timerEl.parentNode !== parent) {
            if (_timerEl) { try { _timerEl.remove(); } catch(_) {} }
            _timerEl = document.createElement('div');
            _timerEl.className = 'vsc-fs-timer';
            const stroke = getNS()?.getSmoothStroke?.('#000000') || '-webkit-text-stroke: 1.5px #000; paint-order: stroke fill;';
            _timerEl.style.cssText = `position: absolute; z-index: 2147483647; color: #FFE600; font-family: monospace; font-weight: bold; pointer-events: none; user-select: none; font-variant-numeric: tabular-nums; letter-spacing: 1px; ${stroke} transition: opacity 0.2s; opacity: 0.5;`;
            parent.appendChild(_timerEl);
          }
          _timerEl.style.display = 'block';

          const now = new Date();
          const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
          if (_timerEl.textContent !== timeStr) _timerEl.textContent = timeStr;

          const vRect = activeVideo.getBoundingClientRect(), pRect = parent.getBoundingClientRect(), vWidth = vRect.width;
          _timerEl.style.fontSize = `${vWidth >= 2500 ? 36 : vWidth >= 1900 ? 30 : vWidth >= 1200 ? 24 : 18}px`;

          const topOffset = vWidth > 1200 ? 16 : 8;
          _timerEl.style.top = `${Math.max(topOffset, (vRect.top - pRect.top) + topOffset)}px`;

          const pos = this.getSetting('app.timePos'), edgeMargin = vWidth > 1200 ? 20 : 10;
          if (pos === 0) { _timerEl.style.left = `${Math.max(edgeMargin, (vRect.left - pRect.left) + edgeMargin)}px`; _timerEl.style.right = 'auto'; _timerEl.style.transform = 'none'; }
          else if (pos === 1) { _timerEl.style.left = `${(vRect.left - pRect.left) + (vWidth / 2)}px`; _timerEl.style.right = 'auto'; _timerEl.style.transform = 'translateX(-50%)'; }
          else { _timerEl.style.right = `${Math.max(edgeMargin, (pRect.right - vRect.right) + edgeMargin)}px`; _timerEl.style.left = 'auto'; _timerEl.style.transform = 'none'; }
        }, 1000);
      },
      onDestroy() {
        if (_intervalId) clearInterval(_intervalId);
        if (_timerEl) { try { _timerEl.remove(); } catch (_) {} }
        _intervalId = null; _timerEl = null;
      }
    });
  }

  function createPerfNotificationFeature(Utils) {
    let _badgeEl = null;
    let _fadeTimer = 0;
    const { h } = Utils;

    function showBadge(text, activeVideo) {
      if (!activeVideo || !activeVideo.parentNode) return;

      if (!_badgeEl) {
        _badgeEl = h('div', {
          style: `position: absolute; top: 20px; left: 50%; transform: translateX(-50%);
                  background: rgba(231, 76, 60, 0.85); color: white; padding: 6px 14px;
                  border-radius: 20px; font-size: 13px; font-weight: bold; z-index: 2147483647;
                  pointer-events: none; transition: opacity 0.3s, transform 0.3s; opacity: 0;
                  backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2);`
        });
      }

      if (_badgeEl.parentNode !== activeVideo.parentNode) {
        activeVideo.parentNode.appendChild(_badgeEl);
      }
      if (getComputedStyle(activeVideo.parentNode).position === 'static') {
        activeVideo.parentNode.style.position = 'relative';
      }

      _badgeEl.textContent = text;
      _badgeEl.style.opacity = '1';
      _badgeEl.style.transform = 'translateX(-50%) translateY(0)';

      clearTimeout(_fadeTimer);
      _fadeTimer = setTimeout(() => {
        if (_badgeEl) {
          _badgeEl.style.opacity = '0';
          _badgeEl.style.transform = 'translateX(-50%) translateY(-10px)';
        }
      }, 3000);
    }

    return defineFeature({
      name: 'perfNotification',
      phase: PHASE.RENDER,
      onInit() {
        this.subscribe('pipeline:degraded', ({ mode }) => {
          showBadge(mode === 'low' ? '⚠ 성능 최적화: 시스템 부하 감지' : '⚠ 부하 감지: 시스템 부하 감지', this.getActiveVideo());
        });
      },
      onDestroy() {
        clearTimeout(_fadeTimer);
        if (_badgeEl) { try { _badgeEl.remove(); } catch(_) {} }
        _badgeEl = null;
      }
    });
  }

  function createPiPFeature(Bus) {
    return defineFeature({
      name: 'pip',
      phase: PHASE.PROCESS,
      onInit() {
        on(document, 'enterpictureinpicture', (e) => {
          Bus.emit('pip:changed', { video: e.target, active: true });
        }, { capture: true });

        on(document, 'leavepictureinpicture', (e) => {
          Bus.emit('pip:changed', { video: e.target, active: false });
        }, { capture: true });
      },
      methods: {
        async toggle() {
          const v = this.getActiveVideo();
          if (v) await togglePiPFor(v);
        }
      }
    });
  }

  let __vscUserSignalRev = 0;

  // 🔥 Targeting 호이스팅 에러 해결을 위해 Assembly 섹션에서 위로 이동한 후 사용
  function createTargeting(bus) {
    if (bus) bus.on('pip:changed', ({ video, active }) => { /* 추후 PiP Feature 연동 시 사용 */ });
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;

    const isInPlayer = (vid) => {
      if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true;
      const root = vid.getRootNode();
      if (root instanceof ShadowRoot && root.host) return !!root.host.closest(PLAYER_CONTAINER_SELECTORS);
      return false;
    };

    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      const now = performance.now(); const vp = getViewportSnapshot();
      let best = null, bestScore = -Infinity;

      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;

        if (typeof v.checkVisibility === 'function') {
          try {
            if (!v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return;
          } catch (_) {}
        }

        const r = getRectCached(v, now);
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

  function createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus }) {
    Store.sub(P.APP_UI, () => { Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); });

    let __activeTarget = null, __lastApplyTarget = null;
    let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;
        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        const wantAudioNow = !!(Store.get(P.A_EN) && active);
        const pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        let pick = Targeting.pickFastActiveOnly(visible.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) pick = Targeting.pickFastActiveOnly(Registry.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) {
          try {
            const list = Array.from(document.querySelectorAll('video'));
            pick = { target: list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null };
          } catch (_) {}
        }

        let nextTarget = pick?.target || __activeTarget;
        if (nextTarget !== __activeTarget) {
          if (Bus) Bus.emit('target:changed', { video: nextTarget, prev: __activeTarget });
          __activeTarget = nextTarget;
        }

        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now();
        if (vidsDirty.size > 40 || (now - lastPrune > 2000)) {
          Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); lastPrune = now;
        }

        Features.updateAll({
          active, force, vidsDirty, pbActive,
          target: __activeTarget,
          isApplyAll: !!Store.get(P.APP_APPLY_ALL),
          desiredRate: Store.get(P.PB_RATE)
        });

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
      getActiveVideo: () => __activeTarget,
      destroy() {
        stopTick();
        safe(() => Features.destroyAll());
        safe(() => Registry.destroy?.());
      }
    });
  }

  // =========================================================================
  // ⚙️ VSC 조립 및 초기화 (Assembly)
  // =========================================================================
  const Bus = createEventBus();

  if (CONFIG.DEBUG) {
    Bus.on('*', (payload) => console.log(`%c[VSC Bus] %c${payload.event}`, 'color: #3498db; font-weight: bold;', 'color: #2ecc71;', payload.data || ''));
    setTimeout(() => { Bus.emit('debug:bus_ready', { time: performance.now() }); }, 500);
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(32);
  const Store = createLocalStore(DEFAULTS, Scheduler, Bus);

  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const isTop = (window.top === window);
  if (isTop && typeof GM_registerMenuCommand === 'function') {
    const reg = (title, fn) => { const id = GM_registerMenuCommand(title, fn); if (__vscNs._menuIds) __vscNs._menuIds.push(id); };
    reg('🔄 설정 초기화 (Reset All)', () => { if(confirm('모든 VSC 설정을 초기화하시겠습니까?')) { const key = 'vsc_prefs_' + location.hostname; if(typeof GM_deleteValue === 'function') GM_deleteValue(key); localStorage.removeItem(key); location.reload(); } });
    reg('⚡ Power 토글', () => { Store.set(P.APP_ACT, !Store.get(P.APP_ACT)); ApplyReq.hard(); });
    reg('🔊 Audio 토글', () => { Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); });
    reg('⚙️ UI 열기/닫기', () => { Store.set(P.APP_UI, !Store.get(P.APP_UI)); ApplyReq.hard(); });
    reg('🛠️ 디버그 모드 토글', () => { const url = new URL(location.href); if(url.searchParams.has('vsc_debug')) url.searchParams.delete('vsc_debug'); else url.searchParams.set('vsc_debug', '1'); location.href = url.toString(); });
  }

  function bindNormalizer(keys, schema) {
    const run = () => { let changed = normalizeBySchema(Store, schema); if (changed) ApplyReq.hard(); };
    keys.forEach(k => Store.sub(k, run)); run();
  }
  bindNormalizer(ALL_KEYS, ALL_SCHEMA);

  const Registry = createRegistry(Scheduler, Bus);
  const Targeting = createTargeting(Bus);
  initSpaUrlDetector(createDebounced(() => { safe(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }, SYS.SRD));

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();
    __vscNs._timers = __vscNs._timers || [];
    const lateRescanDelays = [3000, 10000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => { safe(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); }); }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; safe(() => { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    __vscNs.CONFIG = CONFIG; __vscNs.FLAGS = Object.freeze({ ...FLAGS });

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters); __vscNs.Adapter = Adapter;

    const videoParamsMemo = createVideoParamsMemo();
    const PerfGovernor = createPerfGovernor();

    const Features = createFeatureRegistry(Bus);

    Features.register(createPipelineFeature(Store, Registry, Adapter, ApplyReq, P, Targeting, PerfGovernor, videoParamsMemo));
    const audioFeat = createAudioFeature(Store);
    Features.register(audioFeat);
    const zoomFeat = createZoomFeature(Store, P);
    Features.register(zoomFeat);
    const uiFeat = createUIFeature(Store, Registry, ApplyReq, Utils, P, Bus);
    Features.register(uiFeat);
    Features.register(createTimerFeature());
    Features.register(createPerfNotificationFeature(Utils));
    const pipFeat = createPiPFeature(Bus);
    Features.register(pipFeat);

    __vscNs.Features = Features;
    __vscNs.ZoomManager = zoomFeat;
    __vscNs.AudioWarmup = audioFeat.warmup;

    // 🔥 PATCH 6: PiP 전환 시 AudioSetTarget을 통해 EventBus 트리거 우회
    __vscNs.AudioSetTarget = (v) => { try { Bus.emit('target:changed', { video: v, prev: null }); } catch (_) {} };
    __vscNs.PiPToggle = () => { try { pipFeat.toggle(); } catch (_) {} };

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT< 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; safe(() => Scheduler.request(false)); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
      on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
    }

    const __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus });
    __vscNs.App = __VSC_APP__;

    Features.initAll({ bus: Bus, store: Store, getActiveVideo: () => __VSC_APP__.getActiveVideo() });

    if (getFLAGS().SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) {
      const can = typeof HTMLVideoElement !== 'undefined' && typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function';
      if (can) __vscNs._schedAlignRvfc = true;
    }
    Scheduler.setRvfcSource(() => __VSC_APP__.getActiveVideo() || null);

    ApplyReq.hard();

    on(window, 'keydown', async (e) => {
      const isEditableTarget = (el) => { if(!el) return false; const tag = el.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable; };
      if (isEditableTarget(e.target)) return;

      if (e.altKey && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); e.stopPropagation(); safe(() => { const st = getNS()?.Store; if (st) { st.set(P.APP_UI, !st.get(P.APP_UI)); ApplyReq.hard(); } }); return; }
      if (e.altKey && e.shiftKey && e.code === 'KeyP') {
        if (!getNS()?.Store?.get(P.APP_ACT)) return; e.preventDefault(); e.stopPropagation();
        const v = __VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v);
        return;
      }
      if (e.altKey && e.shiftKey && e.code === 'KeyS') {
        e.preventDefault(); e.stopPropagation();
        const v = __VSC_APP__?.getActiveVideo();
        if (!v || v.readyState < 2) return;
        const w = v.videoWidth || v.clientWidth || 1920, h = v.videoHeight || v.clientHeight || 1080;
        const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        try {
          canvas.getContext('2d').drawImage(v, 0, 0, w, h);
          canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob), a = document.createElement('a');
            a.href = url; a.download = `vsc-capture-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
            a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
          }, 'image/png');
        } catch (_) { log.warn('Screenshot blocked by CORS.'); }
      }
    }, { capture: true });

    on(document, 'fullscreenchange', () => { if (typeof Bus !== 'undefined') Bus.emit('fullscreen:changed', { active: !!document.fullscreenElement }); }, OPT_P);
    on(document, 'visibilitychange', () => { safe(() => { if (document.visibilityState === 'visible') getNS()?.ApplyReq?.hard(); }); }, OPT_P);
    window.addEventListener('beforeunload', () => { safe(() => __VSC_APP__?.destroy()); }, { once: true });

    if (CONFIG.DEBUG) {
      console.log('%c[VSC] Final Feature Execution Order:', 'color: #e67e22; font-weight: bold;');
      console.table(Features._debugOrder());
    }
  });

}
VSC_MAIN();
})();
