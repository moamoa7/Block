// ==UserScript==
// @name         Video_Control (v186.24 - Final Patched)
// @namespace    https://github.com/
// @version      186.24
// @description  Optimized WorkQ, Zero-leak Signals, Pure Audio Path with Post-Limiter Boost, Toast/AB-Loop Integrated.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
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

  const SCRIPT_VERSION = '186.24';
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
  function addDisposer(fn) { if (typeof fn === 'function' && !__vscNs.__destroying) DISPOSERS.add(fn); return fn; }

  const __shadowRootCallbacks = new Set();
  const notifyShadowRoot = (sr) => { for (const cb of __shadowRootCallbacks) safe(() => cb(sr)); };

  function clearRuntimeTimers(ns) {
    try { for (const id of ns._timers || []) { try { clearTimeout(id); } catch (_) {} } } catch (_) {}
    try { for (const id of ns._intervals || []) { try { clearInterval(id); } catch (_) {} } } catch (_) {}
    ns._timers = []; ns._intervals = [];
  }

  const safe = (fn) => { try { fn(); } catch (e) { if (/[?&]vsc_debug=1/.test(location.search)) console.warn('[VSC] safe() caught:', e); } };

  function destroyRuntime(ns = __vscNs) {
    if (!ns || ns.__destroying) return;
    ns.__destroying = true;
    const tryCall = (fn) => { try { fn(); } catch (_) {} };
    [
      () => clearRuntimeTimers(ns),
      () => ns.App?.destroy?.(),
      () => ns.Features?.destroyAll?.(),
      () => ns.Store?.destroy?.(),
      () => ns.Registry?.destroy?.(),
      () => ns._spaNavAC?.abort?.(),
      () => ns._globalHooksAC?.abort?.(),
      () => ns._restoreHistory?.(),
      () => ns._restoreAttachShadow?.()
    ].forEach(tryCall);

    const snapshot = [...DISPOSERS];
    DISPOSERS.clear();
    for (let i = snapshot.length - 1; i >= 0; i--) { safe(snapshot[i]); }

    tryCall(() => { if (ns._shadowRootCb) { __shadowRootCallbacks.delete(ns._shadowRootCb); } });
    tryCall(() => { delete window[Symbol.for('__VSC_SPA_PATCHED__')]; });
    tryCall(() => { (ns._menuIds || []).forEach(id => { try { GM_unregisterMenuCommand(id); } catch (_) {} }); });
    ns.__alive = false; ns.__destroying = false;
  }

  if (__vscNs.__alive) destroyRuntime(__vscNs);
  __vscNs.__alive = true;
  __vscNs._menuIds = [];
  __vscNs._timers = [];
  __vscNs._intervals = [];

  const HAS_SCHEDULER_POST = typeof globalThis.scheduler?.postTask === 'function';
  const HAS_SCHEDULER_YIELD = typeof globalThis.scheduler?.yield === 'function';

  const CONFIG = (() => {
    const IS_MOBILE = (function detectMobile() {
      const uad = navigator.userAgentData;
      if (uad && typeof uad.mobile === 'boolean') return uad.mobile;
      if (/iPad/.test(navigator.platform) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))) return true;
      return /Mobi|Android|iPhone/i.test(navigator.userAgent);
    })();
    const VSC_ID = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const DEBUG = /[?&]vsc_debug=1/.test(location.search);
    const FLAGS = Object.seal({ SCHED_ALIGN_TO_VIDEO_FRAMES: false, SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO: true, FILTER_SHARP_SAT_COMP: false, FILTER_FORCE_OPAQUE_BG: true });
    const PIP_FLAGS = Object.freeze({ USE_LEGACY_PIP_FALLBACK: true });
    const STORAGE_FLAGS = Object.freeze({ ALLOW_LOCALSTORAGE_FALLBACK: true });
    const DARK_BAND = Object.freeze({ LV1: 1, LV2: 2, LV3: 3 });
    const VALID_ROTATIONS = [0, 90, 180, 270];
    const SYS = Object.freeze({ SRD: 150 });

    const PRESETS = Object.freeze({
      detail: {
        off: { sharpAdd: 0, sharp2Add: 0, sat: 1.0, microBase: 0.18, microScale: 1/120, fineBase: 0.32, fineScale: 1/24, microAmt: [0.55, 0.10], fineAmt: [0.20, 0.85] },
        Soft: { sharpAdd: 14, sharp2Add: 13, sat: 1.00, microBase: 0.24, microScale: 1/150, fineBase: 0.44, fineScale: 1/28, microAmt: [0.52, 0.12], fineAmt: [0.18, 0.72] },
        Medium: { sharpAdd: 28, sharp2Add: 25, sat: 1.00, microBase: 0.22, microScale: 1/120, fineBase: 0.40, fineScale: 1/24, microAmt: [0.46, 0.10], fineAmt: [0.18, 0.73] },
        Ultra: { sharpAdd: 42, sharp2Add: 37, sat: 0.99, microBase: 0.21, microScale: 1/100, fineBase: 0.37, fineScale: 1/22, microAmt: [0.50, 0.11], fineAmt: [0.20, 0.76] },
        Master: { sharpAdd: 56, sharp2Add: 49, sat: 0.98, microBase: 0.20, microScale: 1/80, fineBase: 0.34, fineScale: 1/18, microAmt: [0.55, 0.12], fineAmt: [0.22, 0.78] }
      },
      bright: {
        0: { gammaF: 1.00, brightAdd: 0 },
        1: { gammaF: 1.02, brightAdd: 1.0 },
        2: { gammaF: 1.05, brightAdd: 2.5 },
        3: { gammaF: 1.09, brightAdd: 4.5 },
        4: { gammaF: 1.14, brightAdd: 7.0 },
        5: { gammaF: 1.20, brightAdd: 10.0 }
      }
    });

    const QUICK_PRESETS = Object.freeze({
      everyday: { presetS: 'Medium', brightLevel: 1, shadowBandMask: 0, temp: 0 },
      movie: { presetS: 'Ultra', brightLevel: 3, shadowBandMask: 1, temp: -7 },
      anime: { presetS: 'Master', brightLevel: 2, shadowBandMask: 0, temp: -15 }
    });

    const DEFAULTS = Object.freeze({
      video: { presetS: 'off', brightLevel: 0, shadowBandMask: 0, temp: 0, rotation: 0 },
      audio: { enabled: false, boost: 0, multiband: false, lufs: false, dialogue: false, stereoWidth: false },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: true, zoomEn: false, advanced: false, timeEn: true, timePos: 1 }
    });

    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_ADV: 'app.advanced', APP_TIME_EN: 'app.timeEn', APP_TIME_POS: 'app.timePos',
      V_PRE_S: 'video.presetS', V_BRIGHT_LV: 'video.brightLevel', V_SHADOW_MASK: 'video.shadowBandMask', V_TEMP: 'video.temp', V_ROTATION: 'video.rotation',
      A_EN: 'audio.enabled', A_BST: 'audio.boost', A_MULTIBAND: 'audio.multiband', A_LUFS: 'audio.lufs', A_DIALOGUE: 'audio.dialogue', A_STEREO_W: 'audio.stereoWidth',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    const SCHEMAS = Object.freeze({
      app: [ { type: 'bool', path: P.APP_ACT }, { type: 'bool', path: P.APP_UI }, { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN }, { type: 'bool', path: P.APP_ADV }, { type: 'bool', path: P.APP_TIME_EN }, { type: 'num', path: P.APP_TIME_POS, min: 0, max: 2, round: true, fallback: () => 1 } ],
      video: [ { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS }, { type: 'num', path: P.V_BRIGHT_LV, min: 0, max: 5, round: true, fallback: () => 0 }, { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 3, round: true, fallback: () => 0 }, { type: 'num', path: P.V_TEMP, min: -50, max: 50, round: true, fallback: () => 0 }, { type: 'enum', path: P.V_ROTATION, values: VALID_ROTATIONS, fallback: () => 0 } ],
      audio: [ { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => 0 }, { type: 'bool', path: P.A_MULTIBAND }, { type: 'bool', path: P.A_LUFS }, { type: 'bool', path: P.A_DIALOGUE }, { type: 'bool', path: P.A_STEREO_W }, { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate } ]
    });

    return Object.freeze({ IS_MOBILE, VSC_ID, DEBUG, FLAGS, PIP_FLAGS, STORAGE_FLAGS, DARK_BAND, VALID_ROTATIONS, SYS, PRESETS, QUICK_PRESETS, DEFAULTS, P, SCHEMAS });
  })();

  __vscNs.CONFIG = CONFIG;
  const FLAGS = CONFIG.FLAGS;
  __vscNs.FLAGS = Object.freeze({ ...FLAGS });

  const PLAYER_CONTAINER_SELECTORS = '.html5-video-player, #movie_player, .shaka-video-container, .dplayer-video-wrap, .vjs-container, .video-js, [class*="player" i], [id*="player" i], [data-player]';
  const SUPPORTS_MOVE_BEFORE = (typeof Node !== 'undefined' && typeof Node.prototype.moveBefore === 'function');
  const getNextRotation = (current) => { const cur = Number(current) || 0; const idx = CONFIG.VALID_ROTATIONS.indexOf(cur); if (idx < 0) return 90; return CONFIG.VALID_ROTATIONS[(idx + 1) % CONFIG.VALID_ROTATIONS.length]; };
  const ROTATION_LABELS = { 0: '정상', 90: '90도', 180: '180도', 270: '270도' };

  const getNS = () => (window && window[Symbol.for('__VSC__')]) || __vscNs || null;
  const getFLAGS = () => getNS()?.FLAGS || FLAGS;
  const OPT_P = { passive: true };
  const OPT_PC = { passive: true, capture: true };

  const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));
  const getSmoothStroke = (color = '#000') => `-webkit-text-stroke: 1.5px ${color}; paint-order: stroke fill;`;
  __vscNs.getSmoothStroke = getSmoothStroke;

  const combineSignals = (...signals) => {
    const existing = signals.filter(Boolean);
    if (existing.length === 0) return AbortSignal.abort();
    if (existing.length === 1) return existing[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(existing);
    if (existing.some(s => s.aborted)) return AbortSignal.abort();

    const ac = new AbortController();
    const onAbort = () => {
      ac.abort();
      for (const s of existing) { try { s.removeEventListener('abort', onAbort); } catch (_) {} }
    };
    for (const s of existing) { s.addEventListener('abort', onAbort, { once: true }); }
    return ac.signal;
  };

  function on(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    if (typeof opts === 'boolean') opts = { capture: opts };
    if (!opts) {
      target.addEventListener(type, fn, { signal: __globalSig });
      return;
    }
    if (opts.signal) {
      const combined = combineSignals(opts.signal, __globalSig);
      target.addEventListener(type, fn, { ...opts, signal: combined });
      return;
    }
    target.addEventListener(type, fn, { ...opts, signal: __globalSig });
  }

  const blockInterference = (el) => {
    if (!el) return;
    const stop = (e) => { e.stopPropagation(); };
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'dblclick'].forEach(evt => { on(el, evt, stop, { passive: false }); });
  };
  __vscNs.blockInterference = blockInterference;

  let shadowEmitterInstalled = false;
  function installShadowRootEmitterIfNeeded() {
    if (shadowEmitterInstalled) return;
    shadowEmitterInstalled = true;
    const proto = Element.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    if (!desc || typeof desc.value !== 'function' || desc.value.__vsc_shadowEmitterPatched) return;
    if (!__vscNs._origAttachShadowDesc) __vscNs._origAttachShadowDesc = desc;
    const orig = desc.value;
    const patched = function(init) { const sr = orig.call(this, init); queueMicrotask(() => notifyShadowRoot(sr)); return sr; };
    Object.defineProperty(patched, '__vsc_shadowEmitterPatched', { value: true });
    Object.defineProperty(patched, '__vsc_shadowEmitterOrig', { value: orig });
    try { Object.defineProperty(proto, 'attachShadow', { ...desc, value: patched }); } catch (_) { try { proto.attachShadow = patched; } catch (__) {} }
    __vscNs._restoreAttachShadow = addDisposer(() => { const d = __vscNs._origAttachShadowDesc; if (d) { try { Object.defineProperty(Element.prototype, 'attachShadow', d); } catch (_) {} } });
  }

  function onPageReady(fn) {
    let ran = false;
    const localAC = new AbortController();
    const sig = combineSignals(localAC.signal, __globalSig);
    const run = () => { if (ran || sig.aborted) return; ran = true; localAC.abort(); safe(fn); };
    if ((document.readyState === 'interactive' || document.readyState === 'complete') && document.body) { run(); return () => localAC.abort(); }
    document.addEventListener('DOMContentLoaded', run, { once: true, signal: sig });
    window.addEventListener('load', run, { once: true, signal: sig });
    return () => localAC.abort();
  }

  const log = { error: (...a) => console.error('[VSC]', ...a), warn: (...a) => console.warn('[VSC]', ...a), info: () => {}, debug: (...a) => { if (CONFIG.DEBUG) console.debug('[VSC]', ...a); } };

  function createEventBus() {
    const target = new EventTarget();
    let _wildcardCount = 0, _destroyed = false;
    const _wrapperMap = new WeakMap();
    return Object.freeze({
      on(event, handler, opts) {
        if (_destroyed || typeof handler !== 'function') return () => {};
        if (event === '*') _wildcardCount++;
        let eventMap = _wrapperMap.get(handler);
        if (!eventMap) { eventMap = new Map(); _wrapperMap.set(handler, eventMap); }
        const wrapper = (e) => handler(e.detail);
        eventMap.set(event, wrapper);
        target.addEventListener(event, wrapper, opts);
        return () => this.off(event, handler);
      },
      once(event, handler, opts) {
        if (_destroyed || typeof handler !== 'function') return () => {};
        let unsub;
        const wrapper = (data) => { unsub?.(); handler(data); };
        unsub = this.on(event, wrapper, opts);
        return unsub;
      },
      emit(event, data) {
        if (_destroyed) return;
        target.dispatchEvent(new CustomEvent(event, { detail: data }));
        if (_wildcardCount > 0 && event !== '*') target.dispatchEvent(new CustomEvent('*', { detail: { event, data } }));
      },
      off(event, handler) {
        if (!handler) return;
        const eventMap = _wrapperMap.get(handler);
        const wrapper = eventMap?.get(event);
        if (wrapper) {
          target.removeEventListener(event, wrapper);
          eventMap.delete(event);
          if (event === '*') _wildcardCount = Math.max(0, _wildcardCount - 1);
          if (eventMap.size === 0) _wrapperMap.delete(handler);
        }
      },
      destroy() { _destroyed = true; _wildcardCount = 0; }
    });
  }

  const PHASE = Object.freeze({ COMPUTE: 0, PROCESS: 1, RENDER: 2 });

  function defineFeature(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new Error('[VSC defineFeature] "name" is required');
    const _name = spec.name, _phase = (typeof spec.phase === 'number') ? spec.phase : PHASE.PROCESS;
    let _deps = null, _initialized = false, _destroyed = false;
    const _unsubs = [];
    const _helpers = Object.freeze({
      subscribe(event, handler) { if (!_deps) throw new Error(`[VSC ${_name}] subscribe() called before init()`); const unsub = _deps.bus.on(event, handler); _unsubs.push(unsub); return unsub; },
      emit(event, data) { if (_deps) _deps.bus.emit(event, data); },
      getSetting(path) { return _deps?.store?.get(path); },
      setSetting(path, value) { _deps?.store?.set(path, value); },
      getActiveVideo() { return _deps?.getActiveVideo?.() || null; }
    });
    const module = {
      getName() { return _name; },
      init(deps) { if (_initialized) return; _deps = deps; _initialized = true; _destroyed = false; if (typeof spec.onInit === 'function') spec.onInit.call(_helpers, deps); },
      update(ctx) { if (!_initialized || _destroyed) return; if (typeof spec.onUpdate === 'function') spec.onUpdate.call(_helpers, ctx); },
      destroy() {
        if (_destroyed) return; _destroyed = true; _initialized = false;
        if (typeof spec.onDestroy === 'function') {
          try {
            const result = spec.onDestroy.call(_helpers);
            if (result && typeof result.catch === 'function') {
              result.catch(e => { if (CONFIG?.DEBUG) console.warn(`[VSC ${_name}] async onDestroy error:`, e); });
            }
          } catch (e) {}
        }
        for (let i = _unsubs.length - 1; i >= 0; i--) { try { _unsubs[i](); } catch (_) {} }
        _unsubs.length = 0; _deps = null;
      },
      getPhase() { return _phase; }, isInitialized() { return _initialized; }, isDestroyed() { return _destroyed; }
    };
    if (spec.methods && typeof spec.methods === 'object') {
      const RESERVED = new Set(['getName', 'init', 'update', 'destroy', 'getPhase', 'isInitialized', 'isDestroyed']);
      for (const [key, fn] of Object.entries(spec.methods)) { if (RESERVED.has(key)) throw new Error(`[VSC] "${key}" reserved`); module[key] = fn; }
    }
    return Object.freeze(module);
  }

  function createFeatureRegistry(bus) {
    const _modules = new Map();
    let _initialized = false, _sortedCache = null, _sortDirty = true;
    function _validate(mod) { const req = ['getName', 'init', 'update', 'destroy']; for (const m of req) { if (typeof mod[m] !== 'function') throw new Error(`[VSC] Missing ${m}()`); } }
    function _getSorted() {
      if (!_sortDirty && _sortedCache) return _sortedCache;
      const entries = [..._modules.entries()];
      entries.sort((a, b) => { const pA = a[1].getPhase ? a[1].getPhase() : PHASE.PROCESS; const pB = b[1].getPhase ? b[1].getPhase() : PHASE.PROCESS; return pA - pB; });
      _sortedCache = entries; _sortDirty = false; return entries;
    }
    return Object.freeze({
      register(module) { _validate(module); const name = module.getName(); if (_modules.has(name)) { try { _modules.get(name).destroy(); } catch (_) {} } _modules.set(name, module); _sortDirty = true; },
      initAll(deps) { if (_initialized) return; _initialized = true; for (const [name, mod] of _getSorted()) { try { mod.init(deps); } catch (e) {} } bus.emit('features:initialized', { count: _modules.size, names: _getSorted().map(([n]) => n) }); },
      updateAll(ctx) { for (const [name, mod] of _getSorted()) { try { mod.update(ctx); } catch (e) {} } },
      destroyAll() { const entries = [..._getSorted()].reverse(); for (const [name, mod] of entries) { try { mod.destroy(); } catch (e) {} } _modules.clear(); _sortedCache = null; _sortDirty = true; _initialized = false; },
      get(name) { return _modules.get(name) || null; }, list() { return _getSorted().map(([n]) => n); }, _debugOrder() { return _getSorted().map(([n, m]) => ({ name: n, phase: m.getPhase?.() ?? 1 })); }
    });
  }

  function tempToRgbGain(temp) {
    const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
    if (Math.abs(t) < 1e-4) return { rs: 1, gs: 1, bs: 1 };
    const r = 1 + 0.10 * t, b = 1 - 0.10 * t, g = 1 - 0.04 * Math.abs(t);
    const m = Math.max(r, g, b); return { rs: r / m, gs: g / m, bs: b / m };
  }

  let __vscLayoutRev = 0;
  let _scrollBumpRaf = 0;
  const bumpLayoutRev = () => { __vscLayoutRev = (__vscLayoutRev + 1) | 0; };
  on(window, 'scroll', () => { if (!_scrollBumpRaf) _scrollBumpRaf = requestAnimationFrame(() => { _scrollBumpRaf = 0; bumpLayoutRev(); }); }, { passive: true, capture: true });
  on(window, 'resize', bumpLayoutRev, { passive: true });
  try { const vv = window.visualViewport; if (vv) { on(vv, 'scroll', () => { if (!_scrollBumpRaf) _scrollBumpRaf = requestAnimationFrame(() => { _scrollBumpRaf = 0; bumpLayoutRev(); }); }, { passive: true }); on(vv, 'resize', bumpLayoutRev, { passive: true }); } } catch (_) {}

  const videoStateMap = new WeakMap();
  const _vStateProto = {
    visible: false, bound: false, applied: false, rect: null, rectT: 0, _rectRev: 0,
    _lastSrc: '', audioFailUntil: 0, desiredRate: undefined, origFilter: undefined,
    origFilterPrio: '', origWebkitFilter: undefined, origWebkitFilterPrio: '',
    lastFilterUrl: undefined, lastTransform: undefined, lastScale: undefined,
    lastRot: undefined, rateState: undefined, visibilityRatio: undefined
  };

  const getVState = (v) => {
    let st = videoStateMap.get(v);
    if (!st) {
      st = Object.create(_vStateProto);
      st.rect = null;
      st.rateState = undefined;
      videoStateMap.set(v, st);
    }
    return st;
  };

  const TOUCHED = {
    videos: new Set(), rateVideos: new Set(),
    prune() {
      for (const v of this.videos) { if (!v.isConnected) this.videos.delete(v); }
      for (const v of this.rateVideos) { if (!v.isConnected) this.rateVideos.delete(v); }
    }
  };

  function getRectCached(v, now) {
    const st = getVState(v);
    if (st.rect && st._rectRev === __vscLayoutRev) return st.rect;
    const fresh = v.getBoundingClientRect(); st.rect = fresh; st.rectT = now; st._rectRev = __vscLayoutRev; return fresh;
  }

  function getViewportSnapshot() {
    const vv = window.visualViewport;
    if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 };
    return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 };
  }

  function createDebounced(fn, ms = 250) {
    let t = null;
    const debounced = (...args) => { if (t !== null) clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    debounced.cancel = () => { if (t !== null) { clearTimeout(t); t = null; } };
    return debounced;
  }

  function initSpaUrlDetector(onChanged) {
    try { __vscNs._spaDetector?.destroy?.(); } catch (_) {}
    const ac = new AbortController(); const sig = combineSignals(ac.signal, __globalSig);
    if (!__vscNs._origHistoryFns) { __vscNs._origHistoryFns = { pushState: history.pushState, replaceState: history.replaceState }; }
    let lastHref = location.href;
    const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
    const restoreHistoryIfOwned = (name, orig) => { try { const cur = history[name]; if (cur && cur.__vsc_wrapped && cur.__vsc_orig === orig) history[name] = orig; } catch (_) {} };
    const destroy = () => { ac.abort(); const o = __vscNs._origHistoryFns; if (!o) return; restoreHistoryIfOwned('pushState', o.pushState); restoreHistoryIfOwned('replaceState', o.replaceState); };
    if (window.navigation && typeof window.navigation.addEventListener === 'function') { const navAC = new AbortController(); __vscNs._spaNavAC = navAC; window.navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: navAC.signal }); on(window, 'popstate', emitIfChanged, { passive: true, signal: navAC.signal }); __vscNs._spaDetector = { destroy }; return __vscNs._spaDetector; }
    const wrap = (name) => {
      const orig = history[name]; if (typeof orig !== 'function' || orig.__vsc_wrapped) return;
      const wrapped = function (...args) { const ret = Reflect.apply(orig, this, args); queueMicrotask(emitIfChanged); return ret; };
      wrapped.__vsc_wrapped = true; wrapped.__vsc_orig = orig; wrapped.__vsc_owner = CONFIG.VSC_ID;
      try { Object.defineProperty(history, name, { value: wrapped, configurable: true, writable: true, enumerable: true }); } catch (_) { try { history[name] = wrapped; } catch (__) {} }
    };
    wrap('pushState'); wrap('replaceState');
    on(window, 'popstate', emitIfChanged, { passive: true, signal: sig });
    __vscNs._spaDetector = { destroy }; __vscNs._restoreHistory = destroy; return __vscNs._spaDetector;
  }

  function createUtils() {
    const SVG_TAGS = new Set(['svg', 'defs', 'filter', 'feColorMatrix', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feGaussianBlur', 'feComposite']);
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

  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0;
    let rvfcId = 0, rvfcTok = 0, rvfcVideo = null, getRvfcVideo = null;
    function cancelRvfc() { rvfcTok++; if (rvfcId) { const v = rvfcVideo instanceof WeakRef ? rvfcVideo.deref() : rvfcVideo; if (v && typeof v.cancelVideoFrameCallback === 'function') { try { v.cancelVideoFrameCallback(rvfcId); } catch (_) {} } } rvfcId = 0; rvfcVideo = null; }
    function clearPending() { if (timer) { clearTimeout(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } cancelRvfc(); }
    function run() {
      rafId = 0; const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun;
      if (!doForce && dt < minIntervalMs) { const wait = Math.max(0, minIntervalMs - dt); if (!timer) timer = setTimeout(timerCb, wait); return; }
      queued = false; lastRun = now;
      if (!applyFn) return;
      const currentVideo = getRvfcVideo?.();
      if (HAS_SCHEDULER_POST && !doForce) {
        const isPlaying = currentVideo && !currentVideo.paused && !currentVideo.ended;
        const priority = isPlaying ? 'user-visible' : 'background';
        globalThis.scheduler.postTask(() => { try { applyFn(false); } catch (_) {} }, { priority }).catch(() => {});
      } else {
        try { applyFn(doForce); } catch (_) {}
      }
    }
    function timerCb() { timer = 0; run(); }
    function queueRaf() { if (!rafId) rafId = requestAnimationFrame(run); }
    function shouldAlignToVideoFrames() { const flags = getFLAGS(); if (flags.SCHED_ALIGN_TO_VIDEO_FRAMES) return true; if (!flags.SCHED_ALIGN_TO_VIDEO_FRAMES_AUTO) return !!getNS()?._schedAlignRvfc; const v = getRvfcVideo?.(); return !!(v && !v.paused && !v.ended && v.readyState >= 2 && document.visibilityState === 'visible' && typeof v.requestVideoFrameCallback === 'function'); }
    function queueRvfc() { if (!shouldAlignToVideoFrames() || rvfcId) return false; const v = getRvfcVideo?.(); if (!v || typeof v.requestVideoFrameCallback !== 'function') return false; const tok = ++rvfcTok; rvfcVideo = typeof WeakRef !== 'undefined' ? new WeakRef(v) : v; rvfcId = v.requestVideoFrameCallback(() => { if (tok !== rvfcTok) return; rvfcId = 0; rvfcVideo = null; run(); }); return true; }
    const request = (immediate = false) => { if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; } if (queued) return; queued = true; clearPending(); if (!queueRvfc()) queueRaf(); };
    return { registerApply: (fn) => { applyFn = fn; }, request, setRvfcSource: (fn) => { getRvfcVideo = fn; }, destroy: () => { clearPending(); applyFn = null; } };
  }

  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };

  function createLocalStore(defaults, scheduler, bus) {
    const state = structuredClone(defaults);
    let rev = 0; const listeners = new Map();
    const storeAC = new AbortController(); const storeSig = combineSignals(storeAC.signal, __globalSig);
    const PREF_KEY = 'vsc_prefs_' + location.hostname;
    let _lastSavedJson = ''; let _lastSavedRev = -1;

    function loadPrefs() {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(PREF_KEY, null);
          if (v == null) return null;
          if (typeof v === 'object') return v;
          if (typeof v === 'string' && v) return v;
        }
      } catch (_) {}
      if (CONFIG.STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) {
        try { return localStorage.getItem(PREF_KEY); } catch (_) {}
      }
      return null;
    }
    function savePrefsRaw(json) { try { if (typeof GM_setValue === 'function') { GM_setValue(PREF_KEY, json); return true; } } catch (_) {} if (CONFIG.STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { localStorage.setItem(PREF_KEY, json); return true; } catch (_) {} } return false; }
    function clearPrefsRaw() { let cleared = false; try { if (typeof GM_deleteValue === 'function') { GM_deleteValue(PREF_KEY); cleared = true; } } catch (_) {} if (CONFIG.STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { localStorage.removeItem(PREF_KEY); cleared = true; } catch (_) {} } return cleared; }
    function mergeKnown(dst, src, defaultsObj) {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(defaultsObj)) {
        if (Object.prototype.hasOwnProperty.call(src, key)) {
          if (typeof defaultsObj[key] === 'boolean') dst[key] = !!src[key];
          else if (typeof defaultsObj[key] === 'number') {
            const n = Number(src[key]);
            dst[key] = Number.isFinite(n) ? n : defaultsObj[key];
          }
          else if (typeof defaultsObj[key] === 'string') dst[key] = typeof src[key] === 'string' ? src[key] : defaultsObj[key];
          else dst[key] = src[key];
        }
      }
    }

    try {
      const saved = loadPrefs();
      if (saved) {
        const parsed = typeof saved === 'object' ? saved : JSON.parse(saved);
        if (parsed.video && !('brightLevel' in parsed.video)) { parsed.video.brightLevel = 0; }
        if (parsed.video && !('temp' in parsed.video)) { parsed.video.temp = 0; }
        if (parsed.video && !('rotation' in parsed.video)) { parsed.video.rotation = 0; }
        mergeKnown(state.video, parsed.video, CONFIG.DEFAULTS.video); mergeKnown(state.audio, parsed.audio, CONFIG.DEFAULTS.audio); mergeKnown(state.playback, parsed.playback, CONFIG.DEFAULTS.playback); mergeKnown(state.app, parsed.app, CONFIG.DEFAULTS.app);
      }
    } catch (e) { log.warn('Invalid prefs detected. Resetting persisted prefs.', e); clearPrefsRaw(); }

    _lastSavedJson = JSON.stringify(state);
    _lastSavedRev = rev;

    let _saveFailCount = 0; const MAX_SAVE_RETRIES = 5; let _saveDisabledUntil = 0;
    function _doSave() {
      if (rev === _lastSavedRev) return;
      const capturedRev = rev;
      const saveInner = () => {
        const now = Date.now(); if (_saveFailCount >= MAX_SAVE_RETRIES) { if (now < _saveDisabledUntil) return; _saveFailCount = Math.max(0, MAX_SAVE_RETRIES - 2); }
        try {
          const json = JSON.stringify(state); if (json === _lastSavedJson) { _lastSavedRev = capturedRev; return; } if (json.length > 16384) return;
          if (!savePrefsRaw(json)) { _saveFailCount++; if (_saveFailCount >= MAX_SAVE_RETRIES) _saveDisabledUntil = now + 60000; return; }
          _lastSavedJson = json; _lastSavedRev = capturedRev; _saveFailCount = 0;
        } catch (e) { _saveFailCount++; if (_saveFailCount >= MAX_SAVE_RETRIES) _saveDisabledUntil = now + 60000; }
      };
      if (navigator.locks && CONFIG.STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) {
        navigator.locks.request(`vsc_save_${location.hostname}`, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) return;
          saveInner();
        }).catch((e) => {
          if (e instanceof DOMException) saveInner();
        });
      } else {
        saveInner();
      }
    }

    const savePrefs = createDebounced(() => { _doSave(); }, 500);
    const flushNow = () => { savePrefs.cancel(); _doSave(); };

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }, { passive: true, signal: storeSig });
    on(window, 'pagehide', () => { flushNow(); if (CONFIG.STORAGE_FLAGS.ALLOW_LOCALSTORAGE_FALLBACK) { try { localStorage.setItem(PREF_KEY, JSON.stringify(state)); } catch (_) {} } }, { passive: true, signal: storeSig });

    const emit = (path, val) => {
      const cbs = listeners.get(path); if (cbs) { for (const cb of cbs) safe(() => cb(val)); }
      const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) { for (const cb of cbsStar) safe(() => cb(val)); } }
    };
    const notifyChange = (path, val) => { rev++; emit(path, val); if (bus) bus.emit('settings:changed', { path, value: val }); savePrefs(); scheduler.request(false); };

    return {
      state, rev: () => rev,
      getCatRef: (cat) => {
        if (CONFIG.DEBUG) {
          return new Proxy(state[cat], {
            set(target, prop, value) {
              console.warn(`[VSC] Direct mutation of state.${cat}.${prop} detected. Use Store.set() instead.`);
              target[prop] = value; return true;
            }
          });
        }
        return state[cat];
      },
      get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; },
      set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); },
      batch: (cat, obj) => {
        let changed = false; const updates = [];
        for (const [k, v] of Object.entries(obj)) {
          if (state[cat][k] !== v) { state[cat][k] = v; changed = true; updates.push([`${cat}.${k}`, v]); }
        }
        if (changed) {
          rev++;
          for (const [path, val] of updates) { emit(path, val); }
          if (bus) bus.emit('settings:changed', { path: `${cat}.*`, value: obj, batch: true });
          savePrefs(); scheduler.request(false);
        }
      },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); },
      destroy: () => { storeAC.abort(); savePrefs.cancel(); try { _doSave(); } catch (_) {} listeners.clear(); }
    };
  }

  function normalizeBySchema(sm, schema) {
    let changed = false;
    const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
    for (const entry of schema) {
      switch (entry.type) {
        case 'bool': set(entry.path, !!sm.get(entry.path)); break;
        case 'enum': { let val = sm.get(entry.path); let coerced = val; if (entry.values.every(v => typeof v === 'number')) { coerced = Number(val); if (Number.isNaN(coerced)) coerced = entry.fallback(); } if (!entry.values.includes(coerced)) { set(entry.path, entry.fallback()); } else if (val !== coerced) { set(entry.path, coerced); } break; }
        case 'num': { let numVal = Number(sm.get(entry.path)); if (Number.isNaN(numVal)) numVal = entry.fallback(); if (entry.round) numVal = Math.round(numVal); set(entry.path, Math.max(entry.min, Math.min(entry.max, numVal))); break; }
      }
    }
    return changed;
  }

  function createRegistry(scheduler, bus) {
    let destroyed = false;
    const videos = new Set(); const visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA; let rev = 0;
    let __refreshQueued = false; let refreshRafId = 0; let rescanTimerId = 0;

    function requestRefreshCoalesced() {
      if (destroyed || __refreshQueued) return;
      __refreshQueued = true;
      refreshRafId = requestAnimationFrame(() => { refreshRafId = 0; __refreshQueued = false; if (destroyed) return; scheduler.request(false); });
    }

    const IO_MARGIN_PX_DYNAMIC = CONFIG.IS_MOBILE ? 80 : Math.min(200, Math.round(innerHeight * 0.10));
    const ioMargin = `${IO_MARGIN_PX_DYNAMIC}px`;
    const IO_THRESHOLDS = [0];

    const IO_SUPPORTS_V2 = (() => {
      try { const test = new IntersectionObserver(() => {}, { trackVisibility: true, delay: 100 }); test.disconnect(); return true; } catch (_) { return false; }
    })();

    const ioOpts = { root: null, threshold: IO_THRESHOLDS, rootMargin: ioMargin };
    if (IO_SUPPORTS_V2) { ioOpts.trackVisibility = true; ioOpts.delay = CONFIG.IS_MOBILE ? 150 : 100; }

    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target;
        if (!videos.has(el)) continue;
        const isVis = e.isIntersecting; const st = getVState(el);
        st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now; st.visibilityRatio = e.intersectionRatio ?? 0; st._rectRev = __vscLayoutRev;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
        else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
      }
      if (changed) { rev++; requestRefreshCoalesced(); }
    }, ioOpts) : null;

    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
      let changed = false; const now = performance.now();
      for (const e of entries) {
        const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el);
        if (st._rectRev === __vscLayoutRev && (now - st.rectT) < 50) continue;
        if (e.contentBoxSize?.[0]) {
          const s = e.contentBoxSize[0];
          st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize };
        } else { st.rect = e.contentRect ? el.getBoundingClientRect() : null; }
        st.rectT = now; st._rectRev = __vscLayoutRev; dirty.videos.add(el); changed = true;
      }
      if (changed) { bumpLayoutRev(); requestRefreshCoalesced(); }
    }) : null;

    const MAX_SHADOW_OBS = 40;
    let baseRoot = null; let baseObserver = null; const shadowObserverMap = new Map();

    function disconnectBaseObserver() { if (!baseObserver) return; try { baseObserver.disconnect(); } catch (_) {} baseObserver = null; }

    function untrackVideo(v) {
      if (!v || v.tagName !== 'VIDEO') return;
      const wasTracked = videos.has(v);
      if (wasTracked) { videos.delete(v); if (bus) bus.emit('video:lost', { video: v }); }
      visible.videos.delete(v); dirtyA.videos.delete(v); dirtyB.videos.delete(v); dirty.videos.add(v);
      io?.unobserve(v); ro?.unobserve(v);
    }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0); videos.add(el);
      if (bus) bus.emit('video:detected', { video: el, isFirst: wasEmpty });
      if (wasEmpty) { queueMicrotask(() => { __vscNs.UIEnsure?.(); }); }
      if (io) { io.observe(el); } else {
        const st = getVState(el);
        let vis = true;
        if (typeof el.checkVisibility === 'function') { try { vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (_) {} }
        st.visible = vis; st.visibilityRatio = vis ? 1.0 : 0;
        if (vis && !visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); }
      }
      ro?.observe(el);
      lazyScanAncestorShadowRoots(el);
    };

    const WorkQ = (() => {
      let active = [], pending = []; let scheduled = false; let activeSet = new Set(), pendingSet = new Set();
      let idleId = 0, rafId = 0, scheduleToken = 0;
      const clearScheduled = () => { scheduled = false; scheduleToken++; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } if (idleId && typeof cancelIdleCallback === 'function') { cancelIdleCallback(idleId); idleId = 0; } };
      const runDrain = (dl, token) => { if (destroyed || token !== scheduleToken) return; drain(dl).catch(e => { if (CONFIG.DEBUG) log.warn('[VSC] WorkQ drain promise rejected:', e); }); };
      const schedule = () => {
        if (destroyed || scheduled) return; scheduled = true; const token = ++scheduleToken;
        if (HAS_SCHEDULER_POST) {
          globalThis.scheduler.postTask(() => { const start = performance.now(); const dl = { timeRemaining: () => Math.max(0, 12 - (performance.now() - start)) }; runDrain(dl, token); }, { priority: 'background' }).catch(() => {});
        } else if (window.requestIdleCallback) { idleId = requestIdleCallback((dl) => { idleId = 0; runDrain(dl, token); }, { timeout: 500 }); }
        else { rafId = requestAnimationFrame((ts) => { rafId = 0; const start = performance.now(); const fakeDl = { timeRemaining: () => Math.max(0, 8 - (performance.now() - start)) }; runDrain(fakeDl, token); }); }
      };
      const enqueue = (n) => { if (destroyed || !n || (n.nodeType !== 1 && n.nodeType !== 11)) return; if (pendingSet.has(n)) return; pendingSet.add(n); pending.push(n); schedule(); };
      const scanNode = (n) => {
        if (!n) return;
        if (n.nodeType === 1) { if (n.tagName === 'VIDEO') { observeVideo(n); return; } try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} return; }
        if (n.nodeType === 11) { try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {} }
      };

      const drain = async (dl) => {
        scheduled = false; [active, pending] = [pending, active]; [activeSet, pendingSet] = [pendingSet, activeSet]; pending.length = 0; pendingSet.clear();
        try {
          if (active.length <= 64) { for (let i = 0; i < active.length; i++) { if (destroyed) return; activeSet.delete(active[i]); scanNode(active[i]); } return; }
          let processed = 0;
          for (let i = 0; i < active.length; i++) {
            const n = active[i]; activeSet.delete(n);
            if ((++processed & 15) === 0) {
              if (destroyed) return;
              if (HAS_SCHEDULER_YIELD) { try { await globalThis.scheduler.yield(); } catch (_) {} if (destroyed) return; }
              else if (dl?.timeRemaining && dl.timeRemaining() < 1) {
                for (let j = i + 1; j < active.length; j++) { const rest = active[j]; if (!pendingSet.has(rest)) { pendingSet.add(rest); pending.push(rest); } }
                schedule(); return;
              }
            }
            scanNode(n);
          }
        } catch (e) {
          if (CONFIG.DEBUG) log.warn('[VSC] WorkQ.drain error:', e);
        } finally {
          active.length = 0; activeSet.clear();
        }
      };
      return Object.freeze({ enqueue, destroy: clearScheduled });
    })();

    function makeObserver(root, onDisconnect) {
      const mo = new MutationObserver((muts) => {
        if (root !== baseRoot && root.host && !root.host.isConnected) { try { mo.disconnect(); } catch (_) {} onDisconnect?.(); return; }
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
      mo.observe(root, { childList: true, subtree: true }); return mo;
    }

    const connectObserver = (root) => {
      if (!root) return; const isBase = root === baseRoot;
      if (isBase) { if (baseObserver) return; baseObserver = makeObserver(root); WorkQ.enqueue(root); return; }
      if (shadowObserverMap.has(root)) return; if (root.host && !root.host.isConnected) return;
      if (shadowObserverMap.size >= MAX_SHADOW_OBS) {
        let evicted = false;
        for (const [sr, mo] of shadowObserverMap) { if (!sr.host || !sr.host.isConnected) { try { mo.disconnect(); } catch (_) {} shadowObserverMap.delete(sr); evicted = true; break; } }
        if (!evicted) { for (const [sr, mo] of shadowObserverMap) { const hasVideo = sr.querySelector?.('video'); if (!hasVideo) { try { mo.disconnect(); } catch (_) {} shadowObserverMap.delete(sr); evicted = true; break; } } }
        if (!evicted) { const oldest = shadowObserverMap.keys().next().value; try { shadowObserverMap.get(oldest).disconnect(); } catch (_) {} shadowObserverMap.delete(oldest); }
      }
      const mo = makeObserver(root, () => shadowObserverMap.delete(root)); shadowObserverMap.set(root, mo); WorkQ.enqueue(root);
    };

    function lazyScanAncestorShadowRoots(videoEl) {
      let node = videoEl; let depth = 0;
      while (node && depth++ < 30) { const root = node.getRootNode?.(); if (root && root !== document && root.host) { connectObserver(root); node = root.host; } else { break; } }
    }

    const refreshObservers = () => {
      disconnectBaseObserver();
      for (const [sr, mo] of [...shadowObserverMap]) {
        if (!sr.host?.isConnected) { try { mo.disconnect(); } catch (_) {} shadowObserverMap.delete(sr); }
        else if (shadowObserverMap.size > 20 && !sr.querySelector?.('video')) { try { mo.disconnect(); } catch (_) {} shadowObserverMap.delete(sr); }
      }
      baseRoot = document.body || document.documentElement; if (baseRoot) { WorkQ.enqueue(baseRoot); connectObserver(baseRoot); }
    };
    refreshObservers();

    const shadowCb = (sr) => { if (sr && (sr instanceof ShadowRoot || sr.nodeType === 11)) { connectObserver(sr); } };
    __shadowRootCallbacks.add(shadowCb); if (__vscNs) __vscNs._shadowRootCb = shadowCb;

    function pruneDisconnectedVideos() {
      let removed = 0;
      for (const el of [...videos]) {
        if (!el?.isConnected) { videos.delete(el); visible.videos.delete(el); dirtyA.videos.delete(el); dirtyB.videos.delete(el); io?.unobserve(el); ro?.unobserve(el); removed++; }
      }
      return removed;
    }

    return {
      videos, visible, rev: () => rev, refreshObservers,
      prune: () => {
        TOUCHED.prune();
        for (const [root, mo] of [...shadowObserverMap]) {
          const host = root.host;
          if (!host || !host.isConnected) { try { mo.disconnect(); } catch (_) {} shadowObserverMap.delete(root); for (const v of [...videos]) { try { if (v.getRootNode() === root) untrackVideo(v); } catch (_) {} } }
        }
        const removed = pruneDisconnectedVideos(); if (removed) rev++;
      },
      consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
      rescanAll: () => {
        if (destroyed) return; if (rescanTimerId) clearTimeout(rescanTimerId);
        rescanTimerId = setTimeout(() => {
          rescanTimerId = 0; if (destroyed) return;
          try {
            const base = document.documentElement || document.body; if (!base) return;
            function* walkRoots(rootBase) {
              if (!rootBase) return; const stack = [rootBase]; const seen = new Set();
              while (stack.length > 0) {
                const r = stack.pop(); if (!r || seen.has(r)) continue; seen.add(r); yield r;
                const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT); let node = walker.nextNode();
                while (node) { if (node.shadowRoot) stack.push(node.shadowRoot); node = walker.nextNode(); }
              }
            }
            for (const r of walkRoots(base)) WorkQ.enqueue(r);
          } catch (_) {}
        }, 0);
      },
      destroy: () => {
        destroyed = true; if (refreshRafId) { cancelAnimationFrame(refreshRafId); refreshRafId = 0; } if (rescanTimerId) { clearTimeout(rescanTimerId); rescanTimerId = 0; }
        WorkQ.destroy(); disconnectBaseObserver();
        for (const mo of shadowObserverMap.values()) { try { mo.disconnect(); } catch (_) {} }
        shadowObserverMap.clear(); try { io?.disconnect(); } catch (_) {} try { ro?.disconnect(); } catch (_) {}
        videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear();
      }
    };
  }
// =================== PART 1 END ===================
// =================== PART 2 START ===================

  const PIP_WINDOW_CSS = `
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; color: #fff; font-family: system-ui, sans-serif; }
    .vsc-pip-root { display: grid; grid-template-rows: minmax(0, 1fr) auto; width: 100%; height: 100%; background: #000; }
    .vsc-pip-stage { min-width: 0; min-height: 0; display: grid; place-items: center; overflow: hidden; background: #000; }
    .vsc-pip-frame { width: 100%; height: 100%; display: grid; place-items: center; background: #000; }
    .vsc-pip-frame video { max-width: 100%; max-height: 100%; width: auto; height: auto; display: block; object-fit: contain; background: #000; }
    .vsc-pip-controls { display: flex; flex-direction: column; background: rgba(18,18,18,.95); border-top: 1px solid rgba(255,255,255,.12); }
    .vsc-pip-bar { display: flex; gap: 6px; padding: 12px; }
    .vsc-pip-btn { flex: 1; min-height: 34px; border: 1px solid rgba(255,255,255,.16); border-radius: 8px; background: #222; color: #fff; font-weight: 700; cursor: pointer; transition: background 0.2s; }
    .vsc-pip-btn:hover { background: #333; }
  `;

  function createPiPManager(AppStore, ApplyReq) {
    class PiPStateManager {
      constructor() { this.reset(); }
      get isActive() { return !!(this.window && !this.window.closed && this.video); }
      reset() {
        this._restoring = false;
        try { this._uiCleanup?.(); } catch (_) {}
        this._uiCleanup = null;
        if (this._ac) { try { this._ac.abort(); } catch (_) {} this._ac = null; }
        this.window = null; this.video = null; this.placeholder = null;
        this.origParent = null; this.origNext = null; this.origContainer = null;
        this.origCss = '';
      }
      saveVideoPosition(video) {
        this.origParent = video.parentNode; this.origNext = video.nextSibling;
        this.origContainer = video.closest(PLAYER_CONTAINER_SELECTORS) || null;
        this.origCss = video.style.cssText;
      }
      restoreVideoPosition(video) {
        if (this.origCss) {
          const tempEl = document.createElement('div'); tempEl.style.cssText = this.origCss;
          for (let i = 0; i < tempEl.style.length; i++) {
            const prop = tempEl.style[i];
            video.style.setProperty(prop, tempEl.style.getPropertyValue(prop), tempEl.style.getPropertyPriority(prop));
          }
        }
        if (this.placeholder?.parentNode?.isConnected) {
          const parent = this.placeholder.parentNode;
          if (SUPPORTS_MOVE_BEFORE) { try { parent.moveBefore(video, this.placeholder); } catch (_) { parent.insertBefore(video, this.placeholder); } }
          else { parent.insertBefore(video, this.placeholder); }
        } else if (this.origParent?.isConnected) {
          const target = this.origNext?.parentNode === this.origParent ? this.origNext : null;
          if (SUPPORTS_MOVE_BEFORE) { try { this.origParent.moveBefore(video, target); } catch (_) { target ? this.origParent.insertBefore(video, target) : this.origParent.appendChild(video); } }
          else { target ? this.origParent.insertBefore(video, target) : this.origParent.appendChild(video); }
        } else { (document.body || document.documentElement)?.appendChild(video); }
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

    function detectPiPCapability() {
      const hasDPiP = (win) => !!(win?.documentPictureInPicture && typeof win.documentPictureInPicture.requestWindow === 'function');
      if (window.top === window) return hasDPiP(window) ? 'top' : 'none';
      let topWin = null; try { topWin = window.top; void topWin.location.href; } catch (_) { return 'legacy-only'; }
      if (hasDPiP(topWin)) return 'delegated';
      if (hasDPiP(window)) return 'top';
      return 'legacy-only';
    }

    function resolvePiPContext() {
      const cap = detectPiPCapability();
      if (cap === 'top') return { dpip: window.documentPictureInPicture, screen: window.screen };
      if (cap === 'delegated') { try { return { dpip: window.top.documentPictureInPicture, screen: window.top.screen }; } catch (_) { return null; } }
      return null;
    }
    function supportsLegacyPiP(video) { return !!(video && typeof video.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false); }
    async function enterLegacyPiP(video) { await video.requestPictureInPicture(); PiPState.reset(); return true; }

    const DOC_PIP_SIZE_KEY = 'vsc_doc_pip_size_v1';
    function loadDocPiPSize() { try { const s = JSON.parse(localStorage.getItem(DOC_PIP_SIZE_KEY)); return s?.w >= 320 && s?.h >= 180 ? s : null; } catch (_) { return null; } }
    function saveDocPiPSize(w, h) { try { localStorage.setItem(DOC_PIP_SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); } catch (_) {} }

    function installPiPWindowUX(pipWindow, video, stage, bar) {
      const doc = pipWindow.document; stage.style.position = 'relative';
      const badge = doc.createElement('div');
      badge.style.cssText = `position:absolute;top:10px;right:10px;z-index:10;padding:6px 10px;border-radius:10px;background:rgba(0,0,0,.55);color:#fff;font:600 12px/1.2 system-ui,sans-serif;pointer-events:none;backdrop-filter:blur(8px);`;
      stage.appendChild(badge);
      const fmt = (t) => { if (!Number.isFinite(t)) return 'LIVE'; const s = Math.floor(t % 60), m = Math.floor((t / 60) % 60), h = Math.floor(t / 3600); if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; return `${m}:${String(s).padStart(2, '0')}`; };
      const renderBadgeOnly = () => { const cur = video.currentTime || 0, dur = video.duration || 0; const durText = Number.isFinite(dur) ? fmt(dur) : 'LIVE'; const size = `${video.videoWidth || 0}\u00D7${video.videoHeight || 0}`; badge.textContent = `${fmt(cur)} / ${durText} \u00B7 ${size}`; };
      let rvfcId = 0, timerId = 0;
      function scheduleRender() { if (!video.paused && !video.ended && typeof video.requestVideoFrameCallback === 'function') { if (timerId) { clearInterval(timerId); timerId = 0; } rvfcId = video.requestVideoFrameCallback(() => { rvfcId = 0; renderBadgeOnly(); scheduleRender(); }); } else if (!timerId) { timerId = setInterval(renderBadgeOnly, video.paused ? 500 : 250); } }
      renderBadgeOnly(); video.addEventListener('play', () => { if (timerId) { clearInterval(timerId); timerId = 0; } scheduleRender(); }); video.addEventListener('pause', () => scheduleRender()); scheduleRender();
      const ro = new ResizeObserver(() => { const h = Math.ceil(bar.getBoundingClientRect().height || 0); stage.style.paddingBottom = `${h + 8}px`; }); ro.observe(bar);
      doc.addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); if (video.paused) video.play().catch(() => {}); else video.pause(); } else if (e.code === 'ArrowLeft') { e.preventDefault(); try { video.currentTime = Math.max(0, video.currentTime - 5); } catch (_) {} } else if (e.code === 'ArrowRight') { e.preventDefault(); try { const maxT = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : video.currentTime + 5; video.currentTime = Math.min(maxT, video.currentTime + 5); } catch (_) {} } });
      const cleanup = () => {
        ro.disconnect(); clearInterval(timerId); timerId = 0;
        if (rvfcId) { try { video.cancelVideoFrameCallback?.(rvfcId); } catch (_) {} rvfcId = 0; }
      };
      pipWindow.addEventListener('pagehide', cleanup, { once: true });
      video.addEventListener('emptied', cleanup, { once: true });
    }

    async function _restoreVideoCommon(video, { adoptNode: shouldAdopt = false } = {}) {
      if (!video || PiPState.video !== video || PiPState._restoring) return; PiPState._restoring = true;
      const savedTime = video.currentTime, wasPlaying = !video.paused; __vscNs.AudioSetTarget?.(null);
      try { if (shouldAdopt && video.ownerDocument !== document) { try { document.adoptNode(video); } catch (e) { log.warn('[VSC] adoptNode failed:', e); } } PiPState.restoreVideoPosition(video); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const applyTime = () => { if (Number.isFinite(savedTime)) { video.currentTime = savedTime; video.dispatchEvent(new Event('timeupdate')); } }; applyTime(); setTimeout(applyTime, 50); setTimeout(applyTime, 150); if (wasPlaying) { try { await video.play(); } catch (_) {} } const st = getVState(video); if (st) { st.lastTransform = undefined; st.lastScale = undefined; st.lastRot = undefined; } __vscNs.AudioSetTarget?.(video); ApplyReq?.hard(); } catch (e) { log.warn('[VSC PiP] restore failed:', e); } finally { PiPState.reset(); }
    }

    async function restoreFromDocumentPiP(video) { return _restoreVideoCommon(video, { adoptNode: true }); }
    async function _restoreFromIframePiP(video) { return _restoreVideoCommon(video, { adoptNode: true }); }

    async function enterDocumentPiP(video) {
      const pipCtx = resolvePiPContext(); if (!pipCtx) throw new Error('Document PiP context unavailable');
      const { dpip, screen: pipScreen } = pipCtx; const wasPlaying = !video.paused; const saved = loadDocPiPSize();
      let pipWindow = null; const isInIframe = (window.top !== window);
      try {
        const nativeW = video.videoWidth || 0, nativeH = video.videoHeight || 0; const displayW = video.clientWidth || 0;
        const availW = pipScreen.availWidth || window.screen.availWidth || 1280, availH = pipScreen.availHeight || window.screen.availHeight || 720;
        const w = Math.max(320, Math.min(saved?.w || Math.round(nativeW / 2) || 640, Math.round(availW * 0.5)));
        const h = Math.max(180, Math.min(saved?.h || Math.round(nativeH / 2) || 360, Math.round(availH * 0.5)));
        pipWindow = await dpip.requestWindow({ width: w, height: h }); __vscNs.AudioSetTarget?.(null);
        PiPState.window = pipWindow; PiPState.video = video; PiPState.saveVideoPosition(video);
        PiPState.placeholder = document.createElement('div');
        const rect = video.getBoundingClientRect(); Object.assign(PiPState.placeholder.style, { width: `${rect.width || 640}px`, height: `${rect.height || 360}px`, background: '#000', display: getComputedStyle(video).display || 'block', boxSizing: 'border-box' });
        PiPState.origParent?.insertBefore(PiPState.placeholder, video);
        const doc = pipWindow.document; const style = doc.createElement('style'); style.textContent = PIP_WINDOW_CSS; doc.head.appendChild(style);
        const root = doc.createElement('div'); root.className = 'vsc-pip-root';
        const stage = doc.createElement('div'); stage.className = 'vsc-pip-stage';
        const frame = doc.createElement('div'); frame.className = 'vsc-pip-frame';
        const controlsWrap = doc.createElement('div'); controlsWrap.className = 'vsc-pip-controls';
        const bar = doc.createElement('div'); bar.className = 'vsc-pip-bar';
        const mkBtn = (label, onClick) => { const b = doc.createElement('button'); b.className = 'vsc-pip-btn'; b.textContent = label; b.addEventListener('click', onClick); return b; };
        const playBtn = mkBtn(video.paused ? '\u25B6 재생' : '\u23F8 일시정지', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
        const backBtn = mkBtn('\u23EA 10s', () => { try { video.currentTime = Math.max(0, video.currentTime - 10); } catch (_) {} });
        const fwdBtn = mkBtn('10s \u23E9', () => { try { const maxT = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.1) : video.currentTime + 10; video.currentTime = Math.min(maxT, video.currentTime + 10); } catch (_) {} });
        const fitBtn = mkBtn('\u2922 맞춤', () => { if (!pipWindow) return; let vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return; const rot = AppStore?.get('video.rotation') || 0; if (rot % 180 !== 0) [vw, vh] = [vh, vw]; const ratio = vw / vh; const curScreen = pipWindow.screen || window.screen; const aw = curScreen.availWidth || 1280, ah = curScreen.availHeight || 720; const stageW = Math.max(320, Math.min(aw * 0.5, 640)); const stageH = Math.round(stageW / ratio); pipWindow.resizeTo(stageW + (pipWindow.outerWidth - pipWindow.innerWidth), stageH + (pipWindow.outerHeight - pipWindow.innerHeight) + 60); });
        const rotateBtn = mkBtn('\uD83D\uDD04 회전', () => { if (!AppStore) return; const nextRot = getNextRotation(AppStore.get('video.rotation')); AppStore.set('video.rotation', nextRot); ApplyReq?.hard(); });
        const closeBtn = mkBtn('\u2715 닫기', () => { exitPiP(video).catch(() => {}); });
        const syncPlayBtn = () => { playBtn.textContent = video.paused ? '\u25B6 재생' : '\u23F8 일시정지'; };
        video.addEventListener('play', syncPlayBtn); video.addEventListener('pause', syncPlayBtn);
        Object.assign(video.style, { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', objectFit: 'contain' });
        frame.append(video); stage.append(frame); bar.append(backBtn, playBtn, fwdBtn, fitBtn, rotateBtn, closeBtn); controlsWrap.append(bar); root.append(stage, controlsWrap); doc.body.append(root);
        installPiPWindowUX(pipWindow, video, stage, controlsWrap);
        let _saveSizeTimer = 0; pipWindow.addEventListener('resize', () => { clearTimeout(_saveSizeTimer); _saveSizeTimer = setTimeout(() => { saveDocPiPSize(pipWindow.innerWidth, pipWindow.innerHeight); }, 500); });
        pipWindow.addEventListener('pagehide', () => { if (isInIframe) _restoreFromIframePiP(video); else restoreFromDocumentPiP(video); }, { once: true });
        PiPState._ac = new AbortController(); return true;
      } catch (e) { try { PiPState.restoreVideoPosition(video); if (pipWindow) pipWindow.close(); } catch (_) {} PiPState.reset(); throw e; }
    }

    async function enterPiP(video) { const cap = detectPiPCapability(); if (cap === 'top' || cap === 'delegated') { try { return await enterDocumentPiP(video); } catch (e) { if (e?.name === 'NotAllowedError') throw e; } } if (CONFIG.PIP_FLAGS.USE_LEGACY_PIP_FALLBACK && supportsLegacyPiP(video)) return await enterLegacyPiP(video); throw new Error('PiP not supported'); }
    async function exitPiP(v = null) { const t = v || PiPState.video; if (PiPState.window) { try { PiPState.window.close(); } catch (_) {} return true; } if (document.pictureInPictureElement) { try { await document.exitPictureInPicture(); return true; } catch (_) {} } return false; }
    let _pipToggleLock = false;
    async function togglePiPFor(video) { if (!video || video.readyState < 2 || _pipToggleLock) return false; _pipToggleLock = true; try { if (PiPState.isActive || document.pictureInPictureElement === video) return await exitPiP(video); return await enterPiP(video); } finally { setTimeout(() => { _pipToggleLock = false; }, 500); } }
    return Object.freeze({ toggle: togglePiPFor, isActive: () => PiPState.isActive, getActiveVideo: getActivePiPVideo, isPiPActiveVideo });
  }

  function chain(...nodes) { for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]); }

  const globalSrcMap = new WeakMap();
  const _srcTokenMap = new Map();
  const _srcFinalizer = new FinalizationRegistry((token) => { const src = _srcTokenMap.get(token); if (src) { try { src.disconnect(); } catch (_) {} _srcTokenMap.delete(token); } });
  function _registerAudioSrc(video, src) { _unregisterAudioSrc(video); const token = Object.create(null); _srcTokenMap.set(token, src); _srcFinalizer.register(video, token, token); globalSrcMap.set(video, { src, token }); }
  function _unregisterAudioSrc(video) { const entry = globalSrcMap.get(video); if (!entry) return; const { src, token } = entry; _srcFinalizer.unregister(token); _srcTokenMap.delete(token); globalSrcMap.delete(video); try { src.disconnect(); } catch (_) {} }
  function _disconnectAllTrackedSources() { for (const [token, src] of _srcTokenMap) { try { src.disconnect(); } catch (_) {} _srcFinalizer.unregister(token); } _srcTokenMap.clear(); }

  const setParamSmooth = (param, val, t, tc = 0.08) => { if(param) { try { param.setTargetAtTime(val, t, tc); } catch (_) { param.value = val; } } };
  const mkBQ = (actx) => (type, freq, Q, gain) => { const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq; if(Q !== undefined) f.Q.value = Q; if(gain !== undefined) f.gain.value = gain; return f; };
  const mkComp = (actx) => (thr, knee, ratio, atk, rel) => { const c = actx.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel; return c; };

  function createStereoWidener(actx) {
    const bq = mkBQ(actx); const input = actx.createGain(), output = actx.createGain(); input.channelCount = 2; input.channelCountMode = 'clamped-max';
    const splitter = actx.createChannelSplitter(2), merger = actx.createChannelMerger(2);
    const midL = actx.createGain(), midR = actx.createGain(), sideL = actx.createGain(), sideR = actx.createGain(), midBus = actx.createGain(), sideBus = actx.createGain();
    midL.gain.value = midR.gain.value = sideL.gain.value = 0.5; sideR.gain.value = -0.5;
    input.connect(splitter); splitter.connect(midL, 0); splitter.connect(sideL, 0); splitter.connect(midR, 1); splitter.connect(sideR, 1);
    midL.connect(midBus); midR.connect(midBus); sideL.connect(sideBus); sideR.connect(sideBus);
    const sideHP1 = bq('highpass', 160, 0.707), sideHP2 = bq('highpass', 160, 0.707), sideShelf = bq('highshelf', 3800, 0.707, 1.0), sideAmp = actx.createGain();
    sideBus.connect(sideHP1); sideHP1.connect(sideHP2); sideHP2.connect(sideShelf); sideShelf.connect(sideAmp);
    const outL = actx.createGain(), outR = actx.createGain(), sideInvR = actx.createGain(); sideInvR.gain.value = -1.0;
    midBus.connect(outL); sideAmp.connect(outL); midBus.connect(outR); sideAmp.connect(sideInvR); sideInvR.connect(outR);
    outL.connect(merger, 0, 0); outR.connect(merger, 0, 1); merger.connect(output);
    return { input, output, sideAmp, setEnabled: (en, pc, t) => { if (getNS()?.CONFIG?.IS_MOBILE) en = false; const target = en ? 1.18 : 1.0; if (pc) pc.sttIfChanged(sideAmp.gain, 'sw.sideAmp', target, t, 0.06); else sideAmp.gain.value = target; } };
  }

  function createAudioParamCache() {
    const _cache = new Map(); return { sttIfChanged(param, key, newVal, time, tc) { const prev = _cache.get(key); if (prev !== undefined && Math.abs(prev - newVal) < 0.005) return; _cache.set(key, newVal); try { param.setTargetAtTime(newVal, time, tc); } catch (_) { param.value = newVal; } }, invalidate: (k) => _cache.delete(k), clear: () => _cache.clear() };
  }

  function buildAudioGraph(audioCtx) {
    const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), makeupGain: audioCtx.createGain(), boostGain: audioCtx.createGain() };
    const sw = createStereoWidener(audioCtx), comp = mkComp(audioCtx)(-18.0, 12.0, 3.0, 0.02, 0.2), lim = mkComp(audioCtx)(-1.0, 1.0, 20.0, 0.001, 0.1);
    n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
    chain(n.inputGain, sw.input); chain(sw.output, comp, n.makeupGain, lim, n.boostGain, n.wetGain, n.masterOut);
    n.masterOut.connect(audioCtx.destination);
    Object.assign(n, { _stereoWidener: sw, _compressor: comp, _limiter: lim, _paramCache: createAudioParamCache() }); return n;
  }

  function createAudioFeature(sm) {
    let ctx, target = null, currentSrc = null, currentNodes = null, loopTok = 0, audioLoopTimerId = 0, gestureHooked = false;
    const _audioAC = new AbortController();
    const updateMix = () => {
      if (!ctx) return; if (audioLoopTimerId) { clearTimeout(audioLoopTimerId); audioLoopTimerId = 0; }
      const tok = ++loopTok, dynAct = !!(sm.get(CONFIG.P.A_EN) && sm.get(CONFIG.P.APP_ACT)), isHooked = !!currentSrc, wetT = (dynAct && isHooked) ? 1 : 0;
      if (currentNodes?._paramCache) { const pc = currentNodes._paramCache; pc.sttIfChanged(currentNodes.dryGain.gain, 'dryGain', 1 - wetT, ctx.currentTime, 0.005); pc.sttIfChanged(currentNodes.wetGain.gain, 'wetGain', wetT, ctx.currentTime, 0.005); }
      if (dynAct && isHooked) runAudioLoop(tok);
    };

    function runAudioLoop(tok) {
      if (tok !== loopTok || !ctx) return; audioLoopTimerId = 0;
      const dynAct = !!(sm.get(CONFIG.P.A_EN) && sm.get(CONFIG.P.APP_ACT)), isHooked = !!currentSrc;
      if (isHooked && currentNodes?._paramCache) {
        const pc = currentNodes._paramCache, bLv = Number(sm.get(CONFIG.P.A_BST)) || 0;
        currentNodes._stereoWidener.setEnabled(dynAct && sm.get(CONFIG.P.A_STEREO_W), pc, ctx.currentTime);
        pc.sttIfChanged(currentNodes.makeupGain.gain, 'makeupGain', dynAct ? 1.30 : 1.0, ctx.currentTime, 0.05);
        pc.sttIfChanged(currentNodes.boostGain.gain, 'boostGain', dynAct ? Math.pow(10, bLv / 20) : 1.0, ctx.currentTime, 0.05);
        pc.sttIfChanged(currentNodes._limiter.threshold, 'limiterThr', -1.0, ctx.currentTime, 0.05);
        const dialogueMode = dynAct && sm.get(CONFIG.P.A_DIALOGUE);
        if (dialogueMode) {
          pc.sttIfChanged(currentNodes._compressor.threshold, 'comp.thr', -24.0, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.ratio, 'comp.ratio', 4.5, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.attack, 'comp.atk', 0.008, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.release, 'comp.rel', 0.15, ctx.currentTime, 0.05);
        } else {
          pc.sttIfChanged(currentNodes._compressor.threshold, 'comp.thr', -18.0, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.ratio, 'comp.ratio', 3.0, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.attack, 'comp.atk', 0.02, ctx.currentTime, 0.05);
          pc.sttIfChanged(currentNodes._compressor.release, 'comp.rel', 0.2, ctx.currentTime, 0.05);
        }
      }
      const isPaused = target && (target.paused || target.ended);
      if (document.hidden) audioLoopTimerId = setTimeout(() => runAudioLoop(tok), 500);
      else if (isPaused) {
        const pauseAC = new AbortController(); const resume = () => { pauseAC.abort(); if (audioLoopTimerId === myFallbackId) audioLoopTimerId = 0; if (tok === loopTok) runAudioLoop(tok); };
        const myFallbackId = setTimeout(resume, 30000); audioLoopTimerId = myFallbackId;
        target.addEventListener('play', resume, { once: true, signal: pauseAC.signal });
      } else audioLoopTimerId = setTimeout(() => { if (tok === loopTok) runAudioLoop(tok); }, 250);
    }

    const setTarget = (v) => {
      if (v == null) { detachCurrentSource(); updateMix(); return; }
      if (v === target && currentSrc) { updateMix(); return; }
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; try { ctx = new AC({ latencyHint: 'interactive' }); currentNodes = buildAudioGraph(ctx); } catch (_) { return; } }
      const connect = (vid) => {
        let s = globalSrcMap.get(vid)?.src;
        if (s && s.context !== ctx) { _unregisterAudioSrc(vid); s = null; }
        if (!s) {
          try { s = ctx.createMediaElementSource(vid); _registerAudioSrc(vid, s); }
          catch (e) {
            const st = getVState(vid);
            st.audioFailUntil = performance.now() + 5000;
            target = vid;
            currentSrc = null;
            updateMix();
            return;
          }
        }
        try { s.disconnect(); } catch (_) {}
        s.connect(currentNodes.inputGain);
        currentSrc = s; target = vid; updateMix();
      };
      if (target && target !== v) detachCurrentSource();
      connect(v);
    };
    const detachCurrentSource = () => { if (currentSrc) { try { currentSrc.disconnect(); } catch (_) {} } currentSrc = null; target = null; };

    return defineFeature({
      name: 'audio', phase: PHASE.PROCESS,
      onInit() { this.subscribe('target:changed', ({ video }) => { const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT)); setTarget((want || currentSrc) ? video : null); }); },
      onUpdate(ctx) {
        const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT));
        const vid = (want || currentSrc) ? (ctx.target || this.getActiveVideo()) : null;
        if (vid && vid !== target) {
          const st = getVState(vid);
          if (performance.now() < (st.audioFailUntil || 0)) return;
        }
        setTarget(vid);
      },
      methods: { warmup: () => { if (ctx?.state === 'suspended') ctx.resume(); }, updateMix, hasCtx: () => !!ctx },
      async onDestroy() { _audioAC.abort(); loopTok++; if (audioLoopTimerId) clearTimeout(audioLoopTimerId); detachCurrentSource(); if (ctx) await ctx.close(); ctx = null; currentNodes = null; }
    });
  }

  function handleExternalRateChange(video) {
    const rSt = getRateState(video); const now = performance.now();
    if (now < (rSt.suppressSyncUntil || 0) || (now - (rSt.lastSetAt || 0)) < 500) return;
    const captured = video.playbackRate; if (!Number.isFinite(captured) || captured < 0.07) return;
    rSt._pendingExternalRate = captured; rSt._pendingExternalT = now;
    if (rSt._externalMtQueued) return;
    rSt._externalMtQueued = true;
    queueMicrotask(() => {
      rSt._externalMtQueued = false;
      const finalRate = rSt._pendingExternalRate;
      const store = getNS()?.Store, app = getNS()?.App;
      if (!store || !app || video !== app.getActiveVideo?.()) return;
      if (Math.abs(finalRate - store.get(CONFIG.P.PB_RATE)) < 0.01) return;
      markInternalRateChange(video, 250);
      store.batch('playback', { rate: finalRate, enabled: true });
    });
  }

  const bindVideoOnce = (v, ApplyReq) => {
    const st = getVState(v); if (st.bound) return; st.bound = true;
    ensureMobileInlinePlaybackHints(v);
    st._ac = new AbortController();
    const opts = { passive: true, signal: combineSignals(st._ac.signal, __globalSig) };
    const reset = () => { queueMicrotask(() => { st.audioFailUntil = 0; st.rect = null; if (st._lastSrc !== v.currentSrc) { st._lastSrc = v.currentSrc; v.style.removeProperty('transform'); v.style.removeProperty('scale'); } ApplyReq.hard(); }); };
    ['loadstart', 'loadedmetadata', 'emptied'].forEach(ev => on(v, ev, reset, opts)); on(v, 'ratechange', () => handleExternalRateChange(v), opts); on(v, 'resize', () => { getNS()?.Filters?.invalidateCache(v); ApplyReq.hard(); }, opts);
  };

  function createRateBackoff() {
    return {
      level: 0, lastAt: 0, attempts: 0, firstAttemptT: 0,
      shouldSkip(now, suppressUntil) { return now < (suppressUntil || 0); },
      recordAttempt(now) {
        if (!this.firstAttemptT || (now - this.firstAttemptT) > 2500) { this.firstAttemptT = now; this.attempts = 0; }
        this.attempts++;
      },
      isOverLimit() { return this.attempts > 4; },
      escalate(now) {
        this.level = Math.min(this.level + 1, 4); this.lastAt = now; this.attempts = 0;
        return now + Math.min(6000, (800 << (this.level - 1))) + ((Math.random() * 500) | 0);
      },
      decay(now) { if (this.level > 0 && (now - this.lastAt) > 1200) this.level--; },
      reset() { this.level = this.attempts = 0; }
    };
  }

  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, backoff: createRateBackoff() };
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) { const st = getRateState(v); const now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  function restoreRateOne(el) { try { const st = getRateState(el); if (!st || st.orig == null) return; const rate = Number(st.orig) > 0.01 ? Number(st.orig) : 1.0; st.orig = null; markInternalRateChange(el, 500); el.playbackRate = rate; } catch (_) {} }
  function ensureMobileInlinePlaybackHints(video) { if (!video || !getNS()?.CONFIG?.IS_MOBILE) return; try { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); } catch(_) {} }

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el), now = performance.now(); if (rSt.backoff.shouldSkip(now, rSt.suppressSyncUntil)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate; if (Object.is(st.desiredRate, desiredRate) && Math.abs(el.playbackRate - desiredRate) < 0.01) { rSt.backoff.decay(now); TOUCHED.rateVideos.add(el); return; }
    rSt.backoff.recordAttempt(now); if (rSt.backoff.isOverLimit()) { rSt.suppressSyncUntil = rSt.backoff.escalate(now); return; }
    st.desiredRate = desiredRate; markInternalRateChange(el, 250); try { el.playbackRate = desiredRate; } catch (_) {}
    requestAnimationFrame(() => { if (!el.isConnected) return; if (Math.abs(el.playbackRate - desiredRate) > 0.01) { markInternalRateChange(el, 250); try { el.playbackRate = desiredRate; } catch (_) {} requestAnimationFrame(() => { if (Math.abs(el.playbackRate - desiredRate) > 0.01) rSt.suppressSyncUntil = rSt.backoff.escalate(performance.now()); else rSt.backoff.decay(performance.now()); }); } else rSt.backoff.decay(performance.now()); });
    TOUCHED.rateVideos.add(el);
  }

// =================== PART 2 END ===================
// =================== PART 3 START ===================

  function batchReadRects(candidates, now) {
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const st = getVState(el);
      if (st.rect && st._rectRev === __vscLayoutRev) continue;
      st.rect = el.getBoundingClientRect();
      st.rectT = now;
      st._rectRev = __vscLayoutRev;
    }
  }

  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, isNeutralParams, isNeutralShadow, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget }) {
    const candidates = scratch; candidates.clear();
    const isApplyAll = !!getNS()?.Store?.get('app.applyAll');

    const addIfConnected = (v) => { if (v?.isConnected) candidates.add(v); };
    for (const v of applySet) addIfConnected(v);
    if (activeTarget) addIfConnected(activeTarget);
    const pipVid = getNS()?.PiPManager?.getActiveVideo();
    if (pipVid) addIfConnected(pipVid);
    for (const v of dirtyVideos) addIfConnected(v);
    for (const v of TOUCHED.videos) addIfConnected(v);
    for (const v of TOUCHED.rateVideos) addIfConnected(v);

    if (candidates.size > 3) {
      batchReadRects(candidates, performance.now());
    }

    for (const el of candidates) {
      if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); const st = getVState(el); if(st) st.desiredRate = undefined; continue; }
      bindVideoOnce(el, ApplyReq);
      const st = getVState(el);
      const isPip = getNS()?.PiPManager?.isPiPActiveVideo(el);
      const shouldApply = applySet.has(el) || el === activeTarget || isPip || isApplyAll;

      if (!shouldApply) {
        if (!st.applied && st.desiredRate === undefined) continue;
        Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el);
        continue;
      }

      const params = getParamsForVideo(el); const vVals = params.video; const shadowVals = params.shadow; const budget = params.budget;
      const videoFxOn = !isNeutralParams(vVals) || !isNeutralShadow(shadowVals) || (vVals.rotation && vVals.rotation !== 0);

      if (videoFxOn) { Adapter.apply(el, vVals, shadowVals, budget.useSvgFilter); TOUCHED.videos.add(el); }
      else { Adapter.clear(el); TOUCHED.videos.delete(el); }

      if (pbActive) { applyPlaybackRate(el, desiredRate); }
      else { if (st.desiredRate !== undefined) { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); } }
    }
  }

  function createPerfGovernor() {
    const perVideo = new WeakMap();
    const MODES = ['low', 'mid', 'high'];
    const MODE_IDX = { low: 0, mid: 1, high: 2 };
    let globalMode = 'high', confirmCount = 0, pendingMode = null, lastTransitionT = 0, emergencyCount = 0;
    const WARMUP_FRAMES = 120, WARMUP_TIME_MS = 10000, SAMPLE_INTERVAL = { high: 5000, mid: 3500, low: 2000 };
    const THRESHOLDS = { downToLow: 0.25, downToMid: 0.15, upToMid: 0.04, upToHigh: 0.015, emergency: 0.40 };
    const EMERGENCY_CONFIRM = 2, CONFIRM_DOWN = 3, CONFIRM_UP = 4, COOLDOWN_DOWN = 8000, COOLDOWN_UP = 3000;

    function transitionTo(newMode) { if (newMode === globalMode) return; globalMode = newMode; lastTransitionT = performance.now(); pendingMode = null; confirmCount = 0; emergencyCount = 0; }
    function tryTransition(candidateMode, now) {
      const currentIdx = MODE_IDX[globalMode], candidateIdx = MODE_IDX[candidateMode];
      const isUpgrade = candidateIdx > currentIdx, cooldown = isUpgrade ? COOLDOWN_UP : COOLDOWN_DOWN;
      if ((now - lastTransitionT) < cooldown) return;
      const requiredConfirms = isUpgrade ? CONFIRM_UP : CONFIRM_DOWN;
      if (pendingMode === candidateMode) { confirmCount++; if (confirmCount >= requiredConfirms) transitionTo(candidateMode); } else { pendingMode = candidateMode; confirmCount = 1; }
    }

    function getWarmupFrames(video) {
      const w = video?.videoWidth || 0;
      if (w >= 3840) return 300;
      if (w >= 1920) return 180;
      return WARMUP_FRAMES;
    }

    function sample(video) {
      if (!video?.getVideoPlaybackQuality) return globalMode;
      const q = video.getVideoPlaybackQuality(), now = performance.now();
      let prev = perVideo.get(video);
      if (!prev) { prev = { t: now, total: q.totalVideoFrames || 0, dropped: q.droppedVideoFrames || 0, warmupStartT: now, settled: false }; perVideo.set(video, prev); return globalMode; }
      if (!prev.settled) {
        const warmupTarget = getWarmupFrames(video);
        const totalSoFar = q.totalVideoFrames || 0, elapsed = now - prev.warmupStartT;
        const w = video?.videoWidth || 0;
        const warmupTimeLimit = w >= 3840 ? 8000 : w >= 1920 ? 6000 : 4000;
        if (totalSoFar < warmupTarget && elapsed < warmupTimeLimit) { prev.t = now; prev.total = totalSoFar; prev.dropped = q.droppedVideoFrames || 0; return globalMode; }
        prev.settled = true; prev.t = now; prev.total = totalSoFar; prev.dropped = q.droppedVideoFrames || 0; return globalMode;
      }
      const interval = SAMPLE_INTERVAL[globalMode] || 1000, dt = now - prev.t;
      if (dt < interval) return globalMode;
      const dTotal = Math.max(0, (q.totalVideoFrames || 0) - prev.total), dDrop = Math.max(0, (q.droppedVideoFrames || 0) - prev.dropped);
      prev.t = now; prev.total = q.totalVideoFrames || 0; prev.dropped = q.droppedVideoFrames || 0;
      if (dTotal < 30) return globalMode;
      const dropRatio = dDrop / dTotal;
      if (dropRatio >= THRESHOLDS.emergency) { emergencyCount++; if (emergencyCount >= EMERGENCY_CONFIRM) transitionTo('low'); return globalMode; } else { emergencyCount = 0; }
      let candidateMode = globalMode;
      if (globalMode === 'high') { if (dropRatio >= THRESHOLDS.downToLow) candidateMode = 'low'; else if (dropRatio >= THRESHOLDS.downToMid) candidateMode = 'mid'; }
      else if (globalMode === 'mid') { if (dropRatio >= THRESHOLDS.downToLow) candidateMode = 'low'; else if (dropRatio < THRESHOLDS.upToHigh) candidateMode = 'high'; }
      else { if (dropRatio < THRESHOLDS.upToHigh) candidateMode = 'high'; else if (dropRatio < THRESHOLDS.upToMid) candidateMode = 'mid'; }
      if (candidateMode !== globalMode) tryTransition(candidateMode, now); else { pendingMode = null; confirmCount = 0; }
      return globalMode;
    }
    return { getBudget(video) { const mode = sample(video); if (mode === 'low') return { mode, sharpMul: 0.50, shadowCap: 1, sigmaMul: 0.80, useSvgFilter: false }; if (mode === 'mid') return { mode, sharpMul: 0.75, shadowCap: 2, sigmaMul: 0.90, useSvgFilter: true }; return { mode, sharpMul: 1.00, shadowCap: 3, sigmaMul: 1.00, useSvgFilter: true }; }, getMode: () => globalMode };
  }

  function computeResolutionSharpMul(video) {
    const nW = video.videoWidth || 0, nH = video.videoHeight || 0, dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0, dpr = Math.max(1, window.devicePixelRatio || 1);
    if (nW < 16 || dW < 16) return 0.0;
    const ratio = Math.max((dW * dpr) / nW, (dH * dpr) / Math.max(1, nH)); let mul = 1.0;
    if (ratio < 0.5) mul = 0.25; else if (ratio < 1.0) mul = 0.25 + (ratio - 0.5) * (0.85 - 0.25) / 0.5; else if (ratio <= 1.5) mul = 1.0; else if (ratio <= 2.5) mul = 1.0 + (ratio - 1.5) * 0.20; else mul = Math.max(0.45, 1.20 - (ratio - 2.5) * 0.20);
    if (nW <= 640 && nH <= 480) mul *= 0.40; else if (nW <= 960) mul *= 0.65;
    if (getNS()?.CONFIG?.IS_MOBILE) mul *= VSC_CLAMP(1.05 / dpr, 0.55, 0.85); else if (dpr >= 1.25) mul *= VSC_CLAMP(1.5 / dpr, 0.75, 1.0);
    return VSC_CLAMP(mul, 0.0, 0.85);
  }

  function _updateFastCache(cache, video, vfUser, nW, nH, dW, dH, budget, result) {
    let fc = cache.get(video); if (!fc) { fc = {}; cache.set(video, fc); }
    Object.assign(fc, { presetS: vfUser.presetS, brightLevel: vfUser.brightLevel, shadowBandMask: vfUser.shadowBandMask, temp: vfUser.temp, rotation: vfUser.rotation || 0, nW, nH, dW, dH, budgetMode: budget.mode, budgetSharpMul: budget.sharpMul, budgetSigmaMul: budget.sigmaMul, result });
  }

  function createVideoParamsMemo() {
    const _srcHashCache = new WeakMap(), _videoFastCache = new WeakMap(), _cache = new Map();
    function getSrcHashCached(video) {
      if (!video) return '0'; const curSrc = video.currentSrc || video.src || ''; if (!curSrc) return '0';
      const entry = _srcHashCache.get(video); if (entry && entry.src === curSrc) return entry.hash;
      let h1 = 2166136261 >>> 0, scanLen = Math.min(curSrc.length, 512);
      for (let i = 0; i < scanLen; i++) { h1 = Math.imul(h1 ^ curSrc.charCodeAt(i), 16777619) >>> 0; }
      const hash = h1.toString(36); _srcHashCache.set(video, { src: curSrc, hash }); return hash;
    }
    return {
      get(vfUser, video, budget) {
        const nW = video?.videoWidth || 0, nH = video?.videoHeight || 0, dW = video?.clientWidth || video?.offsetWidth || 0, dH = video?.clientHeight || video?.offsetHeight || 0, fc = video ? _videoFastCache.get(video) : null;
        if (fc && fc.presetS === vfUser.presetS && fc.brightLevel === vfUser.brightLevel && fc.shadowBandMask === vfUser.shadowBandMask && fc.temp === vfUser.temp && fc.rotation === (vfUser.rotation || 0) && fc.nW === nW && fc.nH === nH && fc.dW === dW && fc.dH === dH && fc.budgetMode === budget.mode && fc.budgetSharpMul === budget.sharpMul && fc.budgetSigmaMul === budget.sigmaMul) return fc.result;
        const sh = getSrcHashCached(video);
        let h1 = 0x811c9dc5 >>> 0;
        const mixStr = (s) => { for (let i = 0; i < s.length; i++) h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0; };
        const mixNum = (n) => { h1 = Math.imul(h1 ^ ((n * 1000) | 0), 0x01000193) >>> 0; };
        const PRESET_HASH = { off: 0, Soft: 1, Medium: 2, Ultra: 3, Master: 4 };
        const BUDGET_HASH = { low: 0, mid: 1, high: 2 };
        mixNum(PRESET_HASH[vfUser.presetS] ?? 99);
        mixNum(vfUser.brightLevel); mixNum(vfUser.shadowBandMask); mixNum(vfUser.temp); mixNum(vfUser.rotation || 0);
        mixNum(nW); mixNum(nH); mixNum(dW); mixNum(dH);
        mixNum(BUDGET_HASH[budget.mode] ?? 99);
        mixNum(budget.sharpMul); mixNum(budget.shadowCap); mixNum(budget.sigmaMul); mixStr(sh);
        const inputKey = h1;
        const mapCached = _cache.get(inputKey);
        if (mapCached) {
          _cache.delete(inputKey); _cache.set(inputKey, mapCached);
          if (video) _updateFastCache(_videoFastCache, video, vfUser, nW, nH, dW, dH, budget, mapCached);
          return mapCached;
        }
        const PRESETS = getNS()?.CONFIG?.PRESETS, detailP = PRESETS.detail[vfUser.presetS || 'off'], brightP = PRESETS.bright[VSC_CLAMP(vfUser.brightLevel || 0, 0, 5)] || PRESETS.bright[0], { rs, gs, bs } = tempToRgbGain(vfUser.temp || 0);
        const finalSharpMul = (video ? computeResolutionSharpMul(video) : 0.0) * budget.sharpMul, finalSigmaScale = (video ? Math.sqrt(Math.max(640, Math.min(3840, dW)) / 1920) : 1.0);
        const videoOut = { sharp: Math.round((detailP.sharpAdd || 0) * finalSharpMul), sharp2: Math.round((detailP.sharp2Add || 0) * finalSharpMul), satF: detailP.sat || 1.0, gamma: brightP.gammaF || 1.0, bright: brightP.brightAdd || 0, contrast: 1.0, temp: vfUser.temp || 0, rotation: vfUser.rotation || 0, gain: 1.0, _sigmaScale: finalSigmaScale * budget.sigmaMul, _refW: Math.max(640, Math.min(3840, dW)), _rs: rs, _gs: gs, _bs: bs, _microBase: detailP.microBase || 0.20, _microScale: detailP.microScale || (1/120), _fineBase: detailP.fineBase || 0.34, _fineScale: detailP.fineScale || (1/24), _microAmt: detailP.microAmt || [0.55, 0.10], _fineAmt: detailP.fineAmt || [0.22, 0.78] };
        const shadowLevel = Math.min(VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0, budget.shadowCap), shadowOut = { level: shadowLevel, active: shadowLevel > 0, factor: 1.0 }, result = { video: videoOut, shadow: shadowOut, budget };
        if (_cache.size >= 16) _cache.delete(_cache.keys().next().value); _cache.set(inputKey, result); if (video) _updateFastCache(_videoFastCache, video, vfUser, nW, nH, dW, dH, budget, result); return result;
      }
    };
  }

  function isNeutralVideoParams(p) { const near = (a, b) => Math.abs((a || 0) - b) <= 1e-4; return ( (p.sharp|0) === 0 && (p.sharp2|0) === 0 && near(p.gamma, 1.0) && near(p.bright, 0.0) && near(p.contrast, 1.0) && near(p.satF, 1.0) && near(p.temp, 0) && near(p._rs, 1.0) && near(p._gs, 1.0) && near(p._bs, 1.0) && near(p.gain, 1.0) && !p.rotation ); }
  function isNeutralShadowParams(sp) { return !sp || !sp.active; }

  function showToast(text) {
    const ns = getNS(); const v = ns?.App?.getActiveVideo();
    const target = v?.parentNode?.isConnected ? v.parentNode : (document.body || document.documentElement);
    if (!target) return;
    let t = target.querySelector('.vsc-toast');
    if (!t) {
      t = document.createElement('div'); t.className = 'vsc-toast';
      t.style.cssText = 'position:absolute;bottom:15%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.82);color:#fff;padding:8px 18px;border-radius:20px;font:600 13.5px/1.3 system-ui,sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.2s ease-in-out;backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);white-space:nowrap;letter-spacing:-0.3px;';
      if (target !== document.body && getComputedStyle(target).position === 'static') target.style.position = 'relative';
      target.appendChild(t);
    }
    t.textContent = text; t.style.opacity = '1';
    clearTimeout(t._tid); t._tid = setTimeout(() => { if (t) t.style.opacity = '0'; }, 1500);
  }
  __vscNs.showToast = showToast;

  function createABLoopFeature() {
    let a = null, b = null;
    return defineFeature({
      name: 'abLoop', phase: PHASE.PROCESS,
      onUpdate(ctx) {
        if (a !== null && b !== null && ctx.target) {
          if (ctx.target.currentTime >= b || ctx.target.currentTime < a - 0.5) ctx.target.currentTime = a;
        }
      },
      methods: {
        toggle() {
          const v = this.getActiveVideo(); if (!v) return;
          if (a === null) { a = v.currentTime; showToast(`반복 시작점(A): ${a.toFixed(1)}s`); }
          else if (b === null) {
            b = v.currentTime; if (b <= a) { const tmp = a; a = b; b = tmp; }
            showToast(`A-B 구간 반복: ${a.toFixed(1)}s ↔ ${b.toFixed(1)}s`);
          } else { a = b = null; showToast('구간 반복 해제'); }
        }
      }
    });
  }

  function createPipelineFeature(Store, Registry, Adapter, ApplyReq, P, Targeting, PerfGovernor, videoParamsMemo) {
    const _applySet = new Set(), _scratchCandidates = new Set(); let _prevPerfMode = 'high';
    return defineFeature({
      name: 'pipeline', phase: PHASE.COMPUTE,
      onUpdate(ctx) {
        const { active, target, vidsDirty, pbActive, isApplyAll, desiredRate } = ctx;
        if (!active) { TOUCHED.videos.forEach(v => { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); }); TOUCHED.rateVideos.forEach(v => { getVState(v).desiredRate = undefined; restoreRateOne(v); }); TOUCHED.videos.clear(); TOUCHED.rateVideos.clear(); return; }
        const vf0 = Store.getCatRef('video'), activeBudget = PerfGovernor.getBudget(target);
        if (activeBudget.mode !== _prevPerfMode) { const isDowngrade = { high: 2, mid: 1, low: 0 }[activeBudget.mode] < { high: 2, mid: 1, low: 0 }[_prevPerfMode]; if (isDowngrade) { this.emit('pipeline:degraded', { mode: activeBudget.mode, prev: _prevPerfMode }); } else { this.emit('pipeline:restored', { mode: activeBudget.mode, prev: _prevPerfMode }); } _prevPerfMode = activeBudget.mode; }
        const getParamsForVideo = (el) => videoParamsMemo.get(vf0, el, (el === target || getNS()?.PiPManager?.isPiPActiveVideo(el)) ? activeBudget : { mode: 'high', sharpMul: 1, shadowCap: 3, sigmaMul: 1, useSvgFilter: true });

        _applySet.clear();
        if (isApplyAll) { for (const v of Registry.visible.videos) _applySet.add(v); }
        if (target) _applySet.add(target);

        const pipVid = getNS()?.PiPManager?.getActiveVideo(); if (pipVid) _applySet.add(pipVid);
        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, getParamsForVideo, isNeutralParams: isNeutralVideoParams, isNeutralShadow: isNeutralShadowParams, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates, activeTarget: target });
      },
      onDestroy() { TOUCHED.videos.forEach(v => { try { Adapter.clear(v); } catch(_){} }); TOUCHED.rateVideos.forEach(v => { try { restoreRateOne(v); } catch(_){} }); TOUCHED.videos.clear(); TOUCHED.rateVideos.clear(); }
    });
  }

  function createFiltersVideoOnly(Utils, config) {
    const { h, clamp } = Utils; const _cssFilterCache = new WeakMap(), urlCache = new WeakMap(), ctxMap = new WeakMap(), _attrCache = new WeakMap(), __vscBgMemo = new WeakMap();

    const _precomputedShadowTables = (() => {
      const CRUSH_MAP = [ null, { power: 1.12, pull: 0.002, slope: 1.02, gamma: 1.02, offset: -0.003 }, { power: 1.24, pull: 0.006, slope: 1.05, gamma: 1.08, offset: -0.008 }, { power: 1.38, pull: 0.010, slope: 1.08, gamma: 1.14, offset: -0.014 } ];
      const tables = new Map();
      for (let level = 1; level <= 3; level++) {
        const p = CRUSH_MAP[level], factor = 1.0;
        const effPower = 1.0 + (p.power - 1.0) * factor, effPull = p.pull * factor, effSlope = 1.0 + (p.slope - 1.0) * factor, effGamma = 1.0 + (p.gamma - 1.0) * factor, effOffset = p.offset * factor;
        const SIZE = 128, arr = new Array(SIZE); let prev = 0;
        for (let i = 0; i < SIZE; i++) {
          const x = i / (SIZE - 1);
          if (x <= 1e-6) { arr[i] = '0'; continue; }
          if (x >= 1.0 - 1e-6) { arr[i] = '1'; continue; }
          const t = Math.max(0, Math.min(1, 1.0 - x / 0.5)); const blend = t * t * (3.0 - 2.0 * t);
          const crushed = Math.pow(x, effPower), pulldown = effPull * (1.0 - x) * (1.0 - x);
          let y = x * (1.0 - blend) + crushed * blend - pulldown;
          y = Math.pow(Math.max(0, y), 1 / effGamma); y = y * effSlope + effOffset; y = Math.max(0, Math.min(1, y));
          if (y <= prev) y = prev + 1e-6; if (y > 1.0) y = 1.0; prev = y;
          arr[i] = String(Math.round(y * 10000) / 10000);
        }
        tables.set(`${level}_1.000`, arr.join(' '));
      }
      return tables;
    })();

    function canUseCssNativeOnly(s, shadowParams) { return !((s.sharp | 0) > 0 || (s.sharp2 | 0) > 0 || (shadowParams && shadowParams.active) || Math.abs(s.bright || 0) > 0.5 || Math.abs((s.gamma || 1) - 1.0) > 0.01 || Math.abs(s.temp || 0) > 1e-4 || Math.abs((s.contrast || 1) - 1.0) > 0.01 || Math.abs((s.satF ?? 1) - 1.0) > 0.01); }
    function buildCssFilterString(s) {
      const parts = []; const brightAdd = s.bright || 0;
      if (Math.abs(brightAdd) > 0.5) parts.push(`brightness(${(1.0 + brightAdd / 250).toFixed(4)})`);
      const con = s.contrast || 1;
      if (Math.abs(con - 1.0) > 0.005) parts.push(`contrast(${con.toFixed(3)})`);
      const gamma = s.gamma || 1;
      if (Math.abs(gamma - 1.0) > 0.01) {
        const a = Math.pow(gamma, 0.5); const b = 1 + (gamma - 1) * 0.15;
        parts.push(`brightness(${a.toFixed(4)})`); parts.push(`contrast(${b.toFixed(4)})`);
      }
      const sat = s.satF ?? 1;
      if (Math.abs(sat - 1.0) > 0.005) parts.push(`saturate(${sat.toFixed(3)})`);
      return parts.join(' ');
    }
    function applyCssNative(el, s) {
      const filterStr = buildCssFilterString(s); const st = getVState(el); const lastApplied = _cssFilterCache.get(el); if (lastApplied === filterStr) return;
      if (!filterStr) { if (st.applied) { if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else el.style.removeProperty('filter'); if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || ''); else el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; } _cssFilterCache.set(el, ''); return; }
      if (!st.applied) { st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || ''; st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || ''; }
      el.style.setProperty('filter', filterStr, 'important'); el.style.setProperty('-webkit-filter', filterStr, 'important'); st.applied = true; st.lastFilterUrl = filterStr; _cssFilterCache.set(el, filterStr);
    }
    function setAttr(node, attr, val) {
      if (!node) return;
      let c = _attrCache.get(node);
      if (!c) { c = new Map(); _attrCache.set(node, c); }
      const strVal = typeof val === 'string' ? val : String(val);
      if (c.get(attr) === strVal) return;
      c.set(attr, strVal); node.setAttribute(attr, strVal);
    }
    function ensureOpaqueBg(video) { if (!video || __vscBgMemo.has(video) || !getFLAGS()?.FILTER_FORCE_OPAQUE_BG) return; try { const cs = getComputedStyle(video).backgroundColor; if (cs === 'transparent' || cs === 'rgba(0, 0, 0, 0)' || cs === 'rgba(0,0,0,0)') { __vscBgMemo.set(video, video.style.backgroundColor || ''); video.style.backgroundColor = '#000'; } else { __vscBgMemo.set(video, null); } } catch (_) {} }
    function restoreOpaqueBg(video) { if (!video) return; const prev = __vscBgMemo.get(video); if (prev === undefined) return; __vscBgMemo.delete(video); if (prev !== null) video.style.backgroundColor = prev; }

    function makeKeyHash(s) {
      let h1 = 0x811c9dc5 >>> 0;
      const mix = (v) => { h1 = Math.imul(h1 ^ (v | 0), 0x01000193) >>> 0; };
      mix(((s.gamma || 1) * 100 + 0.5) | 0);
      mix(((s.contrast || 1) * 100 + 0.5) | 0);
      mix(((s.bright || 0) * 2 + 0.5) | 0);
      mix(((s.satF ?? 1) * 100 + 0.5) | 0);
      mix(s.temp | 0); mix(s.sharp | 0); mix(s.sharp2 | 0);
      mix(((s._sigmaScale || 1) * 50 + 0.5) | 0);
      mix(((s._microBase || 0.18) * 100 + 0.5) | 0);
      mix(((s._fineBase || 0.32) * 100 + 0.5) | 0);
      return h1;
    }

    // [v186.24 복구] 원래의 필터 순서(Sharpening 먼저 적용) 복원
    function buildSvg(root) {
      const fidMain = `vsc-main-${config.VSC_ID}`;
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const mkFuncRGB = (attrs) => [ h('feFuncR', { ns: 'svg', ...attrs }), h('feFuncG', { ns: 'svg', ...attrs }), h('feFuncB', { ns: 'svg', ...attrs }) ];
      const mainFilter = h('filter', { ns: 'svg', id: fidMain, 'color-interpolation-filters': 'sRGB', x: '-8%', y: '-8%', width: '116%', height: '116%' });

      const blurMicro = h('feGaussianBlur', { ns: 'svg', in: 'SourceGraphic', stdDeviation: '0.22', result: 'bMicro' });
      const usmMicro = h('feComposite', { ns: 'svg', in: 'SourceGraphic', in2: 'bMicro', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpMicro' });
      const blurFine = h('feGaussianBlur', { ns: 'svg', in: 'SourceGraphic', stdDeviation: '0.60', result: 'bFine' });
      const usmFine = h('feComposite', { ns: 'svg', in: 'SourceGraphic', in2: 'bFine', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpFine' });
      const blend = h('feComposite', { ns: 'svg', in: 'sharpMicro', in2: 'sharpFine', operator: 'arithmetic', k1: '0', k2: '0.55', k3: '0.45', k4: '0', result: 'sharpOut' });

      const bgFuncs = mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' });
      const bgXfer = h('feComponentTransfer', { ns: 'svg', in: 'sharpOut', result: 'bg' }, ...bgFuncs);

      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const shadowToneXfer = h('feComponentTransfer', { ns: 'svg', in: 'bg', result: 'shadow' }, ...shadowToneFuncs);

      const tempR = h('feFuncR', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }), tempG = h('feFuncG', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' }), tempB = h('feFuncB', { ns: 'svg', type: 'linear', slope: '1', intercept: '0' });
      const tempXfer = h('feComponentTransfer', { ns: 'svg', in: 'shadow', result: 'temp' }, tempR, tempG, tempB);
      const satNode = h('feColorMatrix', { ns: 'svg', in: 'temp', type: 'saturate', values: '1', result: 'final' });

      mainFilter.append(blurMicro, usmMicro, blurFine, usmFine, blend, bgXfer, shadowToneXfer, tempXfer, satNode);
      defs.append(mainFilter);

      const tryAppend = () => { const target = root.body || root.documentElement || root; if (target?.appendChild) { target.appendChild(svg); return true; } return false; };
      if (!tryAppend()) {
        log.warn('[VSC] SVG inject failed immediately. Waiting for DOM...');
        let _fallbackMoId = 0; const mo = new MutationObserver(() => { if (tryAppend()) { mo.disconnect(); clearTimeout(_fallbackMoId); } });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        _fallbackMoId = setTimeout(() => mo.disconnect(), 5000);
        if (typeof __vscNs !== 'undefined' && __vscNs._timers) __vscNs._timers.push(_fallbackMoId);
        if (typeof __globalSig !== 'undefined') { __globalSig.addEventListener('abort', () => { clearTimeout(_fallbackMoId); mo.disconnect(); }, { once: true }); }
      }
      return { fidMain, sharp: { blurMicro, usmMicro, blurFine, usmFine, blend }, color: { bgFuncs, shadowToneFuncs, tmp: { r: tempR, g: tempG, b: tempB }, sats: [satNode] }, st: { lastKey: '', rev: 0, bgKey: '', tempKey: '', satKey: '', blurKey: '', sharpKey: '', shadowKey: '' } };
    }

    function updateSharpNodes(nodes, st, s, sharpTotal) {
      if (sharpTotal > 0) {
        const qSharp = Math.max(0, Math.round(Number(s.sharp || 0))), qSharp2 = Math.max(0, Math.round(Number(s.sharp2 || 0))), sigmaScale = Number(s._sigmaScale) || 1.0;
        const microBase = Number(s._microBase) || 0.18, microScale = Number(s._microScale) || (1/120), fineBase = Number(s._fineBase) || 0.32, fineScale = Number(s._fineScale) || (1/24), microAmtCoeffs = s._microAmt || [0.55, 0.10], fineAmtCoeffs = s._fineAmt || [0.20, 0.85];
        const sigMicro = VSC_CLAMP((microBase + qSharp * microScale) * Math.min(1.0, sigmaScale), 0.30, 1.20), sigFine = VSC_CLAMP((fineBase + qSharp2 * fineScale) * sigmaScale, 0.18, 2.50);
        const microAmt = VSC_CLAMP((qSharp * microAmtCoeffs[0] + qSharp2 * microAmtCoeffs[1]) / 45, 0, 1.5), fineAmt = VSC_CLAMP((qSharp * fineAmtCoeffs[0] + qSharp2 * fineAmtCoeffs[1]) / 24, 0, 1.2);

        const totalAmt = microAmt + fineAmt + 1e-6;
        const microWeight = VSC_CLAMP(0.35 + 0.30 * (microAmt / totalAmt), 0.25, 0.70);
        const fineWeight = 1.0 - microWeight;

        const blurKeyNext = `${sigMicro.toFixed(3)}|${sigFine.toFixed(3)}`; if (st.blurKey !== blurKeyNext) { st.blurKey = blurKeyNext; if (nodes.sharp.blurMicro) setAttr(nodes.sharp.blurMicro, 'stdDeviation', sigMicro.toFixed(3)); if (nodes.sharp.blurFine) setAttr(nodes.sharp.blurFine, 'stdDeviation', sigFine.toFixed(3)); }
        const sharpKeyNext = `${microAmt.toFixed(5)}|${fineAmt.toFixed(5)}`; if (st.sharpKey !== sharpKeyNext) { st.sharpKey = sharpKeyNext; if (nodes.sharp.usmMicro) { setAttr(nodes.sharp.usmMicro, 'k2', (1 + microAmt).toFixed(5)); setAttr(nodes.sharp.usmMicro, 'k3', (-microAmt).toFixed(5)); } if (nodes.sharp.usmFine) { setAttr(nodes.sharp.usmFine, 'k2', (1 + fineAmt).toFixed(5)); setAttr(nodes.sharp.usmFine, 'k3', (-fineAmt).toFixed(5)); } setAttr(nodes.sharp.blend, 'k2', microWeight.toFixed(4)); setAttr(nodes.sharp.blend, 'k3', fineWeight.toFixed(4)); }
      } else {
        const bypassKey = 'bypass'; if (st.sharpKey !== bypassKey) { st.sharpKey = bypassKey; st.blurKey = bypassKey; if (nodes.sharp.blurMicro) setAttr(nodes.sharp.blurMicro, 'stdDeviation', '0'); if (nodes.sharp.blurFine) setAttr(nodes.sharp.blurFine, 'stdDeviation', '0'); if (nodes.sharp.usmMicro) { setAttr(nodes.sharp.usmMicro, 'k2', 1); setAttr(nodes.sharp.usmMicro, 'k3', 0); } if (nodes.sharp.usmFine) { setAttr(nodes.sharp.usmFine, 'k2', 1); setAttr(nodes.sharp.usmFine, 'k3', 0); } setAttr(nodes.sharp.blend, 'k2', 1); setAttr(nodes.sharp.blend, 'k3', 0); }
      }
    }

    function updateColorNodes(nodes, st, s, shadowParams) {
      const brightOffset = VSC_CLAMP((s.bright || 0) / 250, -0.5, 0.5), gammaExp = (1 / VSC_CLAMP(s.gamma || 1, 0.1, 5.0)), bgKey = `${gammaExp.toFixed(4)}|${brightOffset.toFixed(4)}`;
      if (st.bgKey !== bgKey) { st.bgKey = bgKey; for (const fn of nodes.color.bgFuncs) { setAttr(fn, 'exponent', parseFloat(gammaExp.toFixed(4))); setAttr(fn, 'offset', parseFloat(brightOffset.toFixed(4))); } }

      if (shadowParams && shadowParams.active) {
        const level = shadowParams.level || 0, factor = shadowParams.factor !== undefined ? shadowParams.factor : 1.0;
        const shadowKey = `crush_v4|${level}|${factor.toFixed(3)}`;
        if (st.shadowKey !== shadowKey) {
          st.shadowKey = shadowKey;
          const precomputed = _precomputedShadowTables.get(`${level}_${factor.toFixed(3)}`);
          if (precomputed) {
            for (const fn of nodes.color.shadowToneFuncs) setAttr(fn, 'tableValues', precomputed);
          } else {
            const CRUSH_MAP = [ null, { power: 1.12, pull: 0.002, slope: 1.02, gamma: 1.02, offset: -0.003 }, { power: 1.24, pull: 0.006, slope: 1.05, gamma: 1.08, offset: -0.008 }, { power: 1.38, pull: 0.010, slope: 1.08, gamma: 1.14, offset: -0.014 } ];
            const p = CRUSH_MAP[level], effPower = 1.0 + (p.power - 1.0) * factor, effPull = p.pull * factor, effSlope = 1.0 + (p.slope - 1.0) * factor, effGamma = 1.0 + (p.gamma - 1.0) * factor, effOffset = p.offset * factor;
            const SIZE = 128, arr = new Array(SIZE); let prev = 0;
            for (let i = 0; i < SIZE; i++) {
              const x = i / (SIZE - 1); if (x <= 1e-6) { arr[i] = '0'; continue; } if (x >= 1.0 - 1e-6) { arr[i] = '1'; continue; }
              const t = Math.max(0, Math.min(1, 1.0 - x / 0.5)); const blend = t * t * (3.0 - 2.0 * t);
              const crushed = Math.pow(x, effPower), pulldown = effPull * (1.0 - x) * (1.0 - x);
              let y = x * (1.0 - blend) + crushed * blend - pulldown;
              y = Math.pow(Math.max(0, y), 1 / effGamma); y = y * effSlope + effOffset; y = Math.max(0, Math.min(1, y));
              if (y <= prev) y = prev + 1e-6; if (y > 1.0) y = 1.0; prev = y;
              arr[i] = String(Math.round(y * 10000) / 10000);
            }
            for (const fn of nodes.color.shadowToneFuncs) setAttr(fn, 'tableValues', arr.join(' '));
          }
        }
      } else {
        const neutralKey = 'shadow_off'; if (st.shadowKey !== neutralKey) { st.shadowKey = neutralKey; for (const fn of nodes.color.shadowToneFuncs) setAttr(fn, 'tableValues', '0 1'); }
      }

      const satVal = VSC_CLAMP(s.satF ?? 1, 0, 5.0).toFixed(2); if (st.satKey !== satVal) { st.satKey = satVal; for (const satNode of nodes.color.sats) setAttr(satNode, 'values', parseFloat(satVal)); }
      const toneNeutral = (Math.abs(s.temp || 0) < 1e-4) && (Math.abs((s.gain || 1) - 1.0) < 0.02 && Math.abs((s.gamma || 1) - 1.0) < 0.02 && Math.abs(s.bright || 0) < 0.5 && Math.abs((s.contrast || 1) - 1.0) < 0.02 && Math.abs((s.satF ?? 1) - 1.0) < 0.02);
      const rsEff = toneNeutral ? 1.0 : (s._rs || 1), gsEff = toneNeutral ? 1.0 : (s._gs || 1), bsEff = toneNeutral ? 1.0 : (s._bs || 1); const rsStr = rsEff.toFixed(3), gsStr = gsEff.toFixed(3), bsStr = bsEff.toFixed(3), tmk = `${rsStr}|${gsStr}|${bsStr}`;
      if (st.tempKey !== tmk) { st.tempKey = tmk; setAttr(nodes.color.tmp.r, 'slope', parseFloat(rsStr)); setAttr(nodes.color.tmp.g, 'slope', parseFloat(gsStr)); setAttr(nodes.color.tmp.b, 'slope', parseFloat(bsStr)); }
    }

    function prepare(video, s, shadowParams) {
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
      let dc = urlCache.get(root); if (!dc) { dc = { key: '', url: '' }; urlCache.set(root, dc); }
      ensureOpaqueBg(video);
      const qSharp = Math.round(Number(s.sharp || 0)), qSharp2 = Math.round(Number(s.sharp2 || 0)), sharpTotal = qSharp + qSharp2;
      const shadowActive = !!(shadowParams && shadowParams.active); const shadowFactor = shadowActive ? (shadowParams.factor !== undefined ? shadowParams.factor.toFixed(3) : '1.000') : 'off';
      const baseHash = makeKeyHash(s), stableKey = `u|${baseHash}|sh:${shadowActive ? 'lv' + shadowParams.level + '_' + shadowFactor : 'off'}`;
      let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }
      const needReapply = (dc.key !== stableKey);
      if (nodes.st.lastKey !== stableKey) {
        nodes.st.lastKey = stableKey; nodes.st.rev = (nodes.st.rev + 1) | 0;
        updateSharpNodes(nodes, nodes.st, s, sharpTotal); updateColorNodes(nodes, nodes.st, s, shadowParams);
      }
      const combinedUrl = `url(#${nodes.fidMain})`;
      dc.key = stableKey; dc.url = combinedUrl; return { url: combinedUrl, changed: needReapply, rev: nodes.st.rev };
    }

    return {
      invalidateCache: (video) => { try { const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document); const nodes = ctxMap.get(root); if (nodes) { nodes.st.lastKey = ''; nodes.st.blurKey = ''; nodes.st.sharpKey = ''; nodes.st.shadowKey = ''; nodes.st.rev = (nodes.st.rev + 1) | 0; nodes.st.bgKey = ''; nodes.st.tempKey = ''; nodes.st.satKey = ''; } const dc = urlCache.get(root); if (dc) { dc.key = ''; dc.url = ''; } } catch (_) {} },
      prepareCached: (video, s, shadowParams) => { try { return prepare(video, s, shadowParams || null); } catch (e) { return { url: null, changed: false, rev: -1 }; } },
      applyUrl: (el, urlObj) => {
        if (!el) return; const url = typeof urlObj === 'string' ? urlObj : urlObj?.url; const st = getVState(el);
        if (!url) { restoreOpaqueBg(el); if (st.applied) { if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else el.style.removeProperty('filter'); if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || ''); else el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; st.origFilter = st.origWebkitFilter = null; st.origFilterPrio = st.origWebkitFilterPrio = ''; } return; }
        if (!st.applied) { st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || ''; st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || ''; }
        if (st.lastFilterUrl !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }
        st.applied = true; st.lastFilterUrl = url;
      },
      canUseCssNativeOnly, applyCssNative
    };
  }

  function createBackendAdapter(Filters) {
    function compute90Scale(video) {
      const vw = Math.max(1, video.videoWidth || video.clientWidth), vh = Math.max(1, video.videoHeight || video.clientHeight), isPip = getNS()?.PiPManager?.isPiPActiveVideo(video);
      if (isPip) { const frame = video.closest('.vsc-pip-frame') || video.parentElement; if (frame) { const fw = Math.max(1, frame.clientWidth), fh = Math.max(1, frame.clientHeight), fitBefore = Math.min(fw / vw, fh / vh), renderedW = vw * fitBefore, renderedH = vh * fitBefore; return Math.max(0.1, Math.min(Math.min(fw / renderedH, fh / renderedW), 10)); } return Math.max(vw / vh, vh / vw); }
      const container = video.closest(PLAYER_CONTAINER_SELECTORS) || video.parentElement || document.body, cw = Math.max(1, container.clientWidth || video.clientWidth), ch = Math.max(1, container.clientHeight || video.clientHeight);
      return Math.max(0.1, Math.min(Math.min(cw / vh, ch / vw) / Math.min(cw / vw, ch / vh), 10));
    }
    return {
      apply(video, vVals, shadowParams, useSvgFilter = true) {
        const st = getVState(video); const rot = vVals.rotation || 0; let newTransform = '', newScale = '';
        if (rot !== 0) { newTransform = `rotate(${rot}deg)`; if (rot % 180 !== 0) newScale = compute90Scale(video).toFixed(4); }
        if (st.lastTransform !== newTransform || st.lastScale !== newScale) {
          if (newTransform) video.style.setProperty('transform', newTransform, 'important'); else video.style.removeProperty('transform');
          if (newScale) video.style.setProperty('scale', newScale, 'important'); else video.style.removeProperty('scale');
          st.lastTransform = newTransform; st.lastScale = newScale; st.lastRot = rot;
        }
        if (!useSvgFilter || (Filters.canUseCssNativeOnly && Filters.canUseCssNativeOnly(vVals, shadowParams))) { if (st.applied && st.lastFilterUrl && st.lastFilterUrl.includes('url(')) Filters.applyUrl(video, null); Filters.applyCssNative(video, vVals); return; }
        Filters.applyUrl(video, Filters.prepareCached(video, vVals, shadowParams));
      },
      clear(video) {
        const st = getVState(video); if (st.applied) Filters.applyUrl(video, null);
        if (st.lastTransform !== undefined || st.lastScale !== undefined) { video.style.removeProperty('transform'); video.style.removeProperty('scale'); st.lastTransform = undefined; st.lastScale = undefined; st.lastRot = undefined; }
      }
    };
  }

  function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    on(el, 'pointermove', (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); }, { passive: false, signal: ac.signal });
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointerup', up, { signal: ac.signal }); on(el, 'pointercancel', up, { signal: ac.signal });
    return () => ac.abort();
  }

  function seekVideo(video, offset) {
    let minT = 0, maxT = video.duration; const sr = video.seekable;
    if (!Number.isFinite(maxT) || maxT === Infinity) { if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
    const target = VSC_CLAMP(video.currentTime + offset, minT, maxT - 0.1);
    try { video.currentTime = target; } catch (_) { return; }
    const verify = () => { if (Math.abs(video.currentTime - target) > 5.0) { try { video.currentTime = target; } catch (_) {} } };
    video.addEventListener('seeked', verify, { once: true }); setTimeout(() => video.removeEventListener('seeked', verify), 3000);
  }

  function execVideoAction(action, val) { const v = getNS()?.App?.getActiveVideo(); if (!v) return; if (action === 'play') v.play().catch(() => {}); else if (action === 'pause') v.pause(); else if (action === 'seek') seekVideo(v, val); }

  function createUI(sm, registry, ApplyReq, Utils, P, Bus) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null, hasUserDraggedUI = false, _lastUiRotation = 0, uiWakeCtrl = new AbortController(), uiUnsubs = [];
    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const syncUiRotation = (rot) => {
      const deg = Number(rot) || 0; if (deg === _lastUiRotation) return; _lastUiRotation = deg;
      const gearEl = gearHost?.shadowRoot?.querySelector('.gear'); if (gearEl) { if (deg === 0) gearEl.style.removeProperty('--vsc-ui-rot'); else gearEl.style.setProperty('--vsc-ui-rot', `${deg}deg`); }
      const mainEl = container?.shadowRoot?.querySelector('.main'); if (mainEl) { if (deg === 0) { mainEl.style.removeProperty('--vsc-ui-rot'); mainEl.style.removeProperty('--vsc-safe-right'); } else { mainEl.style.setProperty('--vsc-ui-rot', `${deg}deg`); if (deg === 90 || deg === 270) mainEl.style.setProperty('--vsc-safe-right', 'max(160px, calc(env(safe-area-inset-right,0px) + 160px))'); else mainEl.style.removeProperty('--vsc-safe-right'); } queueMicrotask(clampPanelIntoViewport); }
    };
    const detachNodesHard = () => { try { if (container?.isConnected) container.remove(); if (gearHost?.isConnected) gearHost.remove(); } catch (_) {} };
    const allowUiInThisDoc = () => { const hn = location.hostname, pn = location.pathname; if (hn.includes('netflix.com')) return pn.startsWith('/watch'); if (hn.includes('coupangplay.com')) return pn.startsWith('/play'); return true; };
    const getUiRoot = () => { const fs = document.fullscreenElement; return fs ? (fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement || document.body) : fs) : (document.body || document.documentElement); };
    const setAndHint = (path, value) => { if (!Object.is(sm.get(path), value)) { sm.set(path, value); (path === P.APP_ACT || path === P.APP_APPLY_ALL || path.startsWith('video.')) ? ApplyReq.hard() : ApplyReq.soft(); } };
    function bindReactive(btn, paths, apply) { const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false; const sync = () => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); }); }; pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); return sync; }
    function bindActGate(btn, extraPaths, applyFn) {
      return bindReactive(btn, [...(Array.isArray(extraPaths) ? extraPaths : []), P.APP_ACT], (el, ...vals) => {
        const act = vals[vals.length - 1];
        el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act;
        if (applyFn) applyFn(el, ...vals);
      });
    }

    const guardedClick = (fn) => (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; fn(e); };

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      const onChange = (val) => { if (!sm.get(P.APP_ACT)) return; const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === val && val !== offValue) setAndHint(key, offValue); else setAndHint(key, val); };
      for (const it of items) { const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text); b.onclick = (e) => { e.stopPropagation(); onChange(it.value); }; bindReactive(b, [key, P.APP_ACT], (el, v, act) => { const isActive = v === it.value; el.classList.toggle('active', isActive); el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }); row.append(b); }
      if (offValue != null) { const offBtn = h('button', { class: 'pbtn', style: 'flex:0.9' }, 'OFF'); offBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(key, offValue); }; bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => { const isActuallyOff = v === offValue; el.classList.toggle('active', isActuallyOff); el.style.opacity = act ? '1' : (isActuallyOff ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }); row.append(offBtn); }
      return row;
    }

    function renderQuickPresetRow(presets, defaults) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, '모드'));
      const isPresetMatch = (preset) => Object.entries(preset).every(([k, v]) => { const current = sm.get(`video.${k}`); return typeof v === 'number' ? Number(current) === v : current === v; });
      const labels = { everyday: '일반', movie: '영화', anime: '애니' };
      for (const [name, preset] of Object.entries(presets)) {
        const b = h('button', { class: 'pbtn', style: 'flex:1' }, labels[name] || name);
        b.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; sm.batch('video', isPresetMatch(preset) ? defaults : preset); ApplyReq.hard(); };
        const watchPaths = [P.V_PRE_S, P.V_BRIGHT_LV, P.V_SHADOW_MASK, P.V_TEMP, P.APP_ACT];
        bindReactive(b, watchPaths, (el, ...vals) => { const act = vals[vals.length - 1]; const matches = isPresetMatch(preset); el.classList.toggle('active', matches); el.style.opacity = act ? '1' : (matches ? '0.65' : '0.45'); el.disabled = !act; });
        row.append(b);
      }
      const offBtn = h('button', { class: 'pbtn', style: 'flex:0.9' }, 'OFF');
      offBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; sm.batch('video', defaults); ApplyReq.hard(); };
      bindReactive(offBtn, [P.V_PRE_S, P.V_BRIGHT_LV, P.V_SHADOW_MASK, P.V_TEMP, P.APP_ACT], (el, ...vals) => { const act = vals[vals.length - 1]; const isDef = Object.entries(defaults).every(([k, v]) => { const current = sm.get(`video.${k}`); return typeof v === 'number' ? Number(current) === v : current === v; }); el.classList.toggle('active', isDef); el.style.opacity = act ? '1' : (isDef ? '0.65' : '0.45'); el.disabled = !act; });
      row.append(offBtn);
      return row;
    }

    const clampPanelIntoViewport = () => {
      try {
        const mainPanel = container && container.shadowRoot && container.shadowRoot.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI) { mainPanel.style.removeProperty('left'); mainPanel.style.removeProperty('transform'); mainPanel.style.right = 'var(--vsc-safe-right)'; mainPanel.style.top = 'calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2))'; mainPanel.style.display = 'block'; queueMicrotask(() => { const r = mainPanel.getBoundingClientRect(); if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) { mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; } }); return; }
        const r = mainPanel.getBoundingClientRect(), vv = window.visualViewport, vw = vv?.width || window.innerWidth || 0, vh = vv?.height || window.innerHeight || 0, offL = vv?.offsetLeft || 0, offT = vv?.offsetTop || 0;
        if (!vw || !vh) return;
        const left = VSC_CLAMP(r.left, offL + 8, Math.max(offL + 8, offL + vw - (r.width || 300) - 8)), top = VSC_CLAMP(r.top, offT + 8, Math.max(offT + 8, offT + vh - (r.height || 400) - 8));
        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
      } catch (_) {}
    };
    const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root) return; if (!vv) { root.style.setProperty('--vsc-vv-top', '0px'); root.style.setProperty('--vsc-vv-h', `${window.innerHeight}px`); return; } root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
    syncVVVars(); let _clampRafId = 0; const onLayoutChange = () => { if (_clampRafId) return; _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); }); };
    try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); } } catch (_) {}
    on(window, 'resize', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'orientationchange', onLayoutChange, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    on(document, 'fullscreenchange', () => { const isFs = !!document.fullscreenElement; if (isFs) { if (container) container._prevUiState = sm.get(P.APP_UI); if (sm.get(P.APP_UI)) sm.set(P.APP_UI, false); } else { if (container && container._prevUiState) { sm.set(P.APP_UI, true); container._prevUiState = false; } } setTimeout(() => { mount(); clampPanelIntoViewport(); syncUiRotation(sm.get(P.V_ROTATION) || 0); }, 100); }, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) });
    const getMainPanel = () => container && container.shadowRoot && container.shadowRoot.querySelector('.main');
    const __vscSheetCache = new Map();
    function attachShadowStyles(shadowRoot, cssText) { try { if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') { let sheet = __vscSheetCache.get(cssText); if (!sheet) { sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); __vscSheetCache.set(cssText, sheet); } shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]; return; } } catch (_) {} const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl); }

    const build = () => {
      if (container) return; const host = h('div', { id: `vsc-host-${getNS()?.CONFIG?.VSC_ID || 'core'}`, 'data-vsc-ui': '1', 'data-vsc-id': getNS()?.CONFIG?.VSC_ID }); const shadow = host.attachShadow({ mode: 'open' });
      const style = `@property --vsc-vv-top { syntax: "<length>"; inherits: true; initial-value: 0px; } @property --vsc-vv-h { syntax: "<length>"; inherits: true; initial-value: 100vh; } :host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px;--vsc-ui-rot:0deg;--vsc-safe-right:max(70px,calc(env(safe-area-inset-right,0px) + 70px))}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2));right:var(--vsc-safe-right);transform:translateY(-50%) rotate(var(--vsc-ui-rot,0deg));width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:95vh;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;touch-action:pan-y;display:none;content-visibility:auto;contain-intrinsic-size:320px auto}.main.visible{display:block;content-visibility:visible}@supports not ((backdrop-filter:blur(12px)) or (-webkit-backdrop-filter:blur(12px))){.main{background:rgba(25,25,25,.985)}}@media(max-width:520px){.main{top:50%!important;right:var(--vsc-safe-right)!important;left:auto!important;transform:translateY(-50%) rotate(var(--vsc-ui-rot,0deg))!important;width:260px!important;max-height:70vh!important;padding:10px;border-radius:12px;overflow-y:auto}.main::-webkit-scrollbar{width:3px}.main::-webkit-scrollbar-thumb{background:#666;border-radius:10px}.prow{gap:3px;flex-wrap:nowrap;justify-content:center}.btn,.pbtn{min-height:34px;font-size:10.5px;padding:4px 1px;letter-spacing:-0.8px;white-space:nowrap}.header{font-size:12px;padding-bottom:5px}} .header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.body{display:flex;flex-direction:column;gap:10px}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center}.btn.warn{background:#8e44ad;border-color:#8e44ad}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}.btn.fill-active.active{background:var(--ac);border-color:var(--ac);color:#fff}.lab{font-size:12px;font-weight:700}.val{font-size:12px;opacity:.9}.small{font-size:11px;opacity:.75}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
      attachShadowStyles(shadow, style);
      const dragHandle = h('div', { class: 'header', title: '\uB354\uBE14\uD074\uB9AD \uC2DC \uD1B5\uB2C8\uBC14\uD034 \uC606\uC73C\uB85C \uBCF5\uADC0' }, 'VSC 렌더링 제어');

      const quickPresetRow = renderQuickPresetRow(getNS()?.CONFIG?.QUICK_PRESETS || {}, { presetS: 'off', brightLevel: 0, shadowBandMask: 0, temp: 0 });
      const sharpRow = renderButtonRow({ label: '\uC120\uBA85', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: [ { text: 'Soft', value: 'Soft', title: '\uC57D\uD55C \uC120\uBA85\uD654' }, { text: 'Med', value: 'Medium', title: '\uC911\uAC04 \uC120\uBA85\uD654' }, { text: 'Ultra', value: 'Ultra', title: '\uAC15\uD55C \uC120\uBA85\uD654' }, { text: 'MST', value: 'Master', title: '\uCD5C\uC0C1\uC704 \uD574\uC0C1\uB3C4 \uBCF5\uAD6C \uBC0F \uC120\uBA85\uD654' } ] });
      const brightRow = renderButtonRow({ label: '\uBC1D\uAE30', key: P.V_BRIGHT_LV, offValue: 0, toggleActiveToOff: true, items: [ { text: '1', value: 1, title: '\uC57D\uAC04 \uBC1D\uAC8C' }, { text: '2', value: 2, title: '\uBC1D\uAC8C' }, { text: '3', value: 3, title: '\uB9CE\uC774 \uBC1D\uAC8C' }, { text: '4', value: 4, title: '\uAC15\uD558\uAC8C \uBC1D\uAC8C' }, { text: '5', value: 5, title: '\uCD5C\uB300 \uBC1D\uAE30' } ] });

      const pipBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '\uD83D\uDCFA PIP'); pipBtn.onclick = guardedClick(async () => { const v = getNS()?.App?.getActiveVideo(); if(v) await getNS()?.PiPManager?.toggle(v); }); bindActGate(pipBtn, []);
      const zoomBtn = h('button', { id: 'zoom-btn', class: 'btn', style: 'flex: 1;' }, '\uD83D\uDD0D \uC90C'); zoomBtn.onclick = guardedClick(() => { const zm = getNS()?.ZoomManager, v = getNS()?.App?.getActiveVideo(); if (!zm || !v) return; if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); } }); bindActGate(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v));
      const rotateBtn = h('button', { class: 'btn', style: 'flex: 1;' }, '\uD83D\uDD04 회전'); rotateBtn.onclick = guardedClick(() => { const cur = sm.get(P.V_ROTATION), next = getNextRotation(cur); sm.set(P.V_ROTATION, next); queueMicrotask(() => { ApplyReq.hard(); }); }); bindActGate(rotateBtn, [P.V_ROTATION], (el, rot) => el.textContent = `\uD83D\uDD04 ${ROTATION_LABELS[rot] || '정상'}`);

      const pwrBtn = h('button', { class: 'btn', style: 'flex: 1;', onclick: (e) => { e.stopPropagation(); setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); } }, '\u26A1 Power'); bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); });

      const boostBtn = h('button', { id: 'boost-btn', class: 'btn', style: 'flex: 3; font-weight: 800;' }, '\uD83D\uDD0A Audio (Mastering)'); boostBtn.onclick = guardedClick(() => { getNS()?.AudioWarmup?.(); setAndHint(P.A_EN, !sm.get(P.A_EN)); ApplyReq.soft(); }); bindActGate(boostBtn, [P.A_EN], (el, aEn) => { el.classList.toggle('active', !!aEn); el.style.color = aEn ? 'var(--ac)' : '#eee'; });

      const stereoBtn = h('button', { class: 'btn', style: 'flex: 1.2; font-size: 11px;' }, 'Wide'); stereoBtn.onclick = guardedClick(() => { if (!sm.get(P.A_EN)) return; setAndHint(P.A_STEREO_W, !sm.get(P.A_STEREO_W)); });
      bindReactive(stereoBtn, [P.A_STEREO_W, P.A_EN, P.APP_ACT], (el, wEn, aEn, act) => { const on = act && aEn; el.classList.toggle('active', !!(on && wEn)); el.style.opacity = on ? '1' : '0.45'; el.style.cursor = on ? 'pointer' : 'not-allowed'; });

      const advToggleBtn = h('button', { class: 'btn', style: 'width: 100%; margin-bottom: 6px; background: #2c3e50; border-color: #34495e;' }, '\u25BC \uACE0\uAE09 \uC124\uC815 \uC5F4\uAE30'); advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); }; bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '\u25B2 \uACE0\uAE09 \uC124\uC815 \uB2EB\uAE30' : '\u25BC \uACE0\uAE09 \uC124\uC815 \uC5F4\uAE30'; el.style.background = v ? '#34495e' : '#2c3e50'; });
      const shortcutInfo = h('div', { style: 'font-size:10px;opacity:0.5;text-align:center;padding:4px 0;line-height:1.6' }, [ 'Alt+Shift+V: UI 토글 | Alt+Shift+P: PiP 토글', h('br'), 'Alt+Shift+[,]: 속도조절 | Alt+Shift+\\: 속도 리셋', h('br'), 'Alt+Shift+D: 선명순환 | Alt+Shift+B: 밝기순환', h('br'), 'Alt+Shift+R: 회전 | Alt+Shift+S: 스크린샷 | Alt+Shift+A: 구간반복', h('br'), 'Alt+Shift+<,>: 프레임 1단위 이동' ]);

      const boostRow = renderButtonRow({ label: '음량', key: P.A_BST, offValue: 0, toggleActiveToOff: true, items: [ { text: '+3', value: 3 }, { text: '+6', value: 6 }, { text: '+9', value: 9 }, { text: '+12', value: 12 } ] });
      bindReactive(boostRow, [P.A_EN, P.APP_ACT], (el, aEn, act) => { const on = act && aEn; el.style.opacity = on ? '1' : '0.45'; el.style.pointerEvents = on ? 'auto' : 'none'; });

      const advContainer = h('div', { style: 'display: none; flex-direction: column; gap: 0px; content-visibility: auto; contain-intrinsic-size: 0 300px;' }, [ boostRow, renderButtonRow({ label: '\uC554\uBD80', key: P.V_SHADOW_MASK, offValue: 0, toggleActiveToOff: true, items: [ { text: '1\uB2E8', value: getNS()?.CONFIG?.DARK_BAND.LV1, title: '\uC57D\uD55C \uC554\uBD80 \uAC15\uD654' }, { text: '2\uB2E8', value: getNS()?.CONFIG?.DARK_BAND.LV2, title: '\uC911\uAC04 \uC554\uBD80 \uAC15\uD654' }, { text: '3\uB2E8', value: getNS()?.CONFIG?.DARK_BAND.LV3, title: '\uAC15\uD55C \uC554\uBD80 \uAC15\uD654' } ] }), renderButtonRow({ label: '\uC0C9\uC628', key: P.V_TEMP, offValue: 0, toggleActiveToOff: true, items: [ { text: '\uBCF4\uD638', value: 35, title: '\uAC15\uD55C \uB178\uB780\uBE5B (\uD655\uC2E4\uD55C \uB208 \uBCF4\uD638)' }, { text: '\uB530\uB73B', value: 18, title: '\uBD80\uB4DC\uB7EC\uC6B4 \uD654\uBA74 (\uC77C\uC0C1\uC6A9)' }, { text: '\uB9D1\uC74C', value: -15, title: '\uAE68\uB057\uD55C \uD654\uC774\uD2B8 (\uC601\uD654 \uCD94\uCC9C)' }, { text: '\uB0C9\uC0C9', value: -30, title: '\uC950\uD55C \uD30C\uB780\uBE5B (\uC560\uB2C8 \uCD94\uCC9C)' } ] }), h('hr'), renderButtonRow({ label: '\uC2DC\uACC4', key: P.APP_TIME_EN, offValue: false, toggleActiveToOff: true, items: [{ text: '\uD45C\uC2DC (\uC804\uCCB4\uD654\uBA74)', value: true }] }), renderButtonRow({ label: '\uC704\uCE58', key: P.APP_TIME_POS, items: [{ text: '\uC88C', value: 0 }, { text: '\uC911', value: 1 }, { text: '\uC6B0', value: 2 }] }), h('hr'), shortcutInfo ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none');
      const resetBtn = h('button', { class: 'btn' }, '\u21BA \uB9AC\uC14B'); resetBtn.onclick = guardedClick(() => { sm.batch('video', getNS()?.CONFIG?.DEFAULTS.video); sm.batch('audio', getNS()?.CONFIG?.DEFAULTS.audio); sm.batch('playback', getNS()?.CONFIG?.DEFAULTS.playback); ApplyReq.hard(); }); bindActGate(resetBtn, []);

      const rateAdjustRow = h('div', { class: 'prow', style: 'justify-content:center;gap:4px;margin-top:2px;' }, [
        (() => { const decBtn = h('button', { class: 'pbtn', style: 'flex:1;min-height:32px;font-size:12px;' }, '- 0.05'); decBtn.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; const next = Math.max(0.1, Math.round((cur - 0.05) * 100) / 100); setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }); bindActGate(decBtn, []); return decBtn; })(),
        (() => { const rateLabel = h('div', { style: 'flex:2;text-align:center;font-size:13px;font-weight:bold;line-height:32px;' }, '1.00x'); bindReactive(rateLabel, [P.PB_RATE, P.PB_EN], (el, rate, en) => { const r = Number(rate) || 1.0; el.textContent = en ? `${r.toFixed(2)}x` : '1.00x'; el.style.color = en && Math.abs(r - 1.0) > 0.01 ? 'var(--ac)' : '#eee'; }); return rateLabel; })(),
        (() => { const incBtn = h('button', { class: 'pbtn', style: 'flex:1;min-height:32px;font-size:12px;' }, '+ 0.05'); incBtn.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; const next = Math.min(16, Math.round((cur + 0.05) * 100) / 100); setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }); bindActGate(incBtn, []); return incBtn; })(),
        (() => { const offBtn = h('button', { class: 'pbtn', style: 'flex:0.8;min-height:32px;font-size:11px;' }, 'OFF'); offBtn.onclick = guardedClick(() => { sm.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); }); bindActGate(offBtn, [P.PB_EN], (el, en) => el.classList.toggle('active', !en)); return offBtn; })()
      ]);

      const bodyMain = h('div', { id: 'p-main' }, [
        quickPresetRow, sharpRow, brightRow, h('div', { class: 'prow' }, [ pipBtn, zoomBtn, rotateBtn, pwrBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 4px;' }, [ boostBtn, stereoBtn ]),
        h('div', { class: 'prow', style: 'margin-top: 8px;' }, [ h('button', { class: 'btn', style: 'background:#333;', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '\u2715 \uB2EB\uAE30'), resetBtn ]), advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = guardedClick(() => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }); bindActGate(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01)); return b; })),
        rateAdjustRow,
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [ { text: '\u25C0 30s', action: 'seek', val: -30 }, { text: '\u25C0 15s', action: 'seek', val: -15 }, { text: '\u23F8 \uC815\uC9C0', action: 'pause' }, { text: '\u25B6 \uC7AC\uC0DD', action: 'play' }, { text: '15s \u25B6', action: 'seek', val: 15 }, { text: '30s \u25B6', action: 'seek', val: 30 } ].map(cfg => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text); b.onclick = guardedClick(() => execVideoAction(cfg.action, cfg.val)); bindActGate(b, []); return b; }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [ dragHandle, bodyMain ]); shadow.append(mainPanel);
      if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);
      let stopDrag = null; const startPanelDrag = (e) => { if (e.target && e.target.tagName === 'BUTTON') return; if (e.cancelable) e.preventDefault(); stopDrag?.(); hasUserDraggedUI = true; let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect(); mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`; try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(dragHandle, (ev) => { const dx = ev.clientX - startX, dy = ev.clientY - startY, panelRect = mainPanel.getBoundingClientRect(); let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + dx)), nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + dy)); mainPanel.style.left = `${nextLeft}px`; mainPanel.style.top = `${nextTop}px`; }, () => { stopDrag = null; }); };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container); syncUiRotation(sm.get(P.V_ROTATION) || 0);
    };

    const ensureGear = () => {
      if (gearHost) return; gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' }); const shadow = gearHost.attachShadow({ mode: 'open' });
      const style = `.gear{--vsc-ui-rot:0deg;--size:46px;position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%) rotate(var(--vsc-ui-rot,0deg));width:var(--size);height:var(--size);border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;padding:0;margin:0;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease,box-shadow .12s ease;opacity:1;-webkit-tap-highlight-color:transparent;touch-action:manipulation}@media(max-width:768px){.gear{--size:42px;font-size:19px}}@media(max-width:768px) and (orientation:landscape){.gear{top:auto;bottom:max(70px,calc(env(safe-area-inset-bottom,0px)+70px));transform:none}}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) rotate(var(--vsc-ui-rot,0deg)) scale(1.06);box-shadow:0 16px 52px rgba(0,0,0,.65)}}.gear:active{transform:translateY(-50%) rotate(var(--vsc-ui-rot,0deg)) scale(.98)}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}.hint{position:fixed;right:74px;bottom:24px;padding:6px 10px;border-radius:10px;background:rgba(25,25,25,.88);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.82);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transform:translateY(6px);transition:opacity .15s ease,transform .15s ease;pointer-events:none}.gear:hover+.hint{opacity:1;transform:translateY(0)}${getNS()?.CONFIG?.IS_MOBILE ? '.hint{display:none!important}' : ''}`;
      attachShadowStyles(shadow, style); let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '\u2699'); shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
      if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);
      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); const inFs = !!document.fullscreenElement; if (inFs || getNS()?.CONFIG?.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) { gearBtn.style.opacity = '0.35'; } }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); on(window, 'touchstart', wake, { passive: true, signal: combineSignals(uiWakeCtrl.signal, __globalSig) }); bootWakeTimer = setTimeout(wake, 2000);
      const handleGearDrag = (e) => { if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); const startY = e.clientY; const rect = gearBtn.getBoundingClientRect(); try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(gearBtn, (ev) => { const currentY = ev.clientY; if (Math.abs(currentY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) { let newTop = rect.top + (currentY - startY); newTop = Math.max(0, Math.min(window.innerHeight - gearBtn.offsetHeight, newTop)); gearBtn.style.top = `${newTop}px`; } }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); }); };
      on(gearBtn, 'pointerdown', handleGearDrag);
      let lastToggle = 0; const onGearActivate = (e) => { if (dragThresholdMet) { if (e && e.cancelable) e.preventDefault(); return; } const now = performance.now(); if (now - lastToggle < 300) { if (e && e.cancelable) e.preventDefault(); return; } lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI)); };
      on(gearBtn, 'pointerup', (e) => { if (e && e.cancelable) e.preventDefault(); e.stopPropagation?.(); onGearActivate(e); }, { passive: false });
      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear(); syncUiRotation(sm.get(P.V_ROTATION) || 0);
    };

    sub(P.V_ROTATION, (newRot) => { syncUiRotation(newRot); });
    const mount = () => { const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc() || (registry.videos.size === 0 && !sm.get(P.APP_UI))) { detachNodesHard(); return; } ensureGear(); const mainPanel = getMainPanel(); if (sm.get(P.APP_UI)) { build(); const mp = getMainPanel(); if (mp && !mp.classList.contains('visible')) { mp.style.display = 'block'; mp.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { if (mainPanel) { mainPanel.classList.remove('visible'); mainPanel.style.display = 'none'; } } mount(); wakeGear?.(); syncUiRotation(sm.get(P.V_ROTATION) || 0); };
    onPageReady(() => { ensure(); ApplyReq.hard(); });
    return { ensure, destroy: () => { uiUnsubs.forEach(u => u()); uiUnsubs.length = 0; uiWakeCtrl.abort(); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); _lastUiRotation = 0; } };
  }

  function createUIFeature(Store, Registry, ApplyReq, Utils, P, Bus) {
    let uiInst = null;
    return defineFeature({
      name: 'ui', phase: PHASE.RENDER,
      onInit() { uiInst = createUI(Store, Registry, ApplyReq, Utils, P, Bus); this.subscribe('video:detected', () => { uiInst?.ensure(); }); },
      onUpdate() { uiInst?.ensure(); }, onDestroy() { uiInst?.destroy(); }
    });
  }

  function createZoomManager(Store, P) {
    const stateMap = new WeakMap(); let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0;
    let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
    const zoomedVideos = new Set(); let activePointerId = null; const zoomAC = new AbortController(), zsig = combineSignals(zoomAC.signal, __globalSig);
    const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origStyle: '' }; stateMap.set(v, st); } return st; };
    const update = (v) => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active;
        if (st.scale <= 1) { if (st.zoomed) { v.style.cssText = st.origStyle; st.zoomed = false; } st.scale = 1; st.tx = 0; st.ty = 0; zoomedVideos.delete(v); return; }
        if (!st.zoomed) { st.origStyle = v.style.cssText; st.zoomed = true; }
        v.style.cssText = st.origStyle + `; will-change: transform !important; contain: paint !important; backface-visibility: hidden !important; transition: ${panning ? 'none' : 'transform 80ms ease-out'} !important; transform-origin: 0 0 !important; transform: translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)}) !important; cursor: ${panning ? 'grabbing' : 'grab'} !important; z-index: 2147483646 !important; position: relative !important;`; zoomedVideos.add(v);
      });
    };
    function clampPan(v, st) { const r = v.getBoundingClientRect(); if (!r || r.width <= 1 || r.height <= 1) return; const sw = r.width * st.scale, sh = r.height * st.scale; st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75); st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75); }
    const zoomTo = (v, newScale, cx, cy) => { const st = getSt(v), r = v.getBoundingClientRect(); if (!r || r.width <= 1) return; const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale; st.tx = cx - (r.left - st.tx) - ix * newScale; st.ty = cy - (r.top - st.ty) - iy * newScale; st.scale = newScale; update(v); };
    const resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    let unsubAct = null, unsubZoomEn = null;
    if (Store?.sub) { unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } }); unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { for (const v of [...zoomedVideos]) resetZoom(v); zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } }); }
    function getTargetVideo(e) { if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } } const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch && Number.isFinite(touch.clientX) ? touch.clientX : null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch && Number.isFinite(touch.clientY) ? touch.clientY : null); if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; } return __vscNs.App?.getActiveVideo() || null; }
    on(window, 'wheel', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return; const v = getTargetVideo(e); if (!v) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const delta = e.deltaY > 0 ? 0.9 : 1.1; const st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * delta), 10); if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY); }, { passive: false, capture: true, signal: zsig });
    on(window, 'pointerdown', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale <= 1) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty; try { v.setPointerCapture?.(e.pointerId); } catch (_) {} update(v); }, { capture: true, passive: false, signal: zsig });
    on(window, 'pointermove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const st = getSt(activeVideo); if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e], last = events.length ? events[events.length - 1] : e; const nextTx = last.clientX - startX, nextTy = last.clientY - startY; if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) { st.hasPanned = true; } st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo); }, { capture: true, passive: false, signal: zsig });
    function endPointerPan(e) { if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const v = activeVideo; const st = getSt(v); try { v.releasePointerCapture?.(e.pointerId); } catch (_) {} if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); } activePointerId = null; isPanning = false; activeVideo = null; update(v); }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig }); on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'dblclick', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v); }, { capture: true, signal: zsig });
    on(window, 'touchstart', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchmove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; const st = getSt(activeVideo); if (pinchState.active && e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches); let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist)); newScale = Math.min(Math.max(1, newScale), 10); if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; } else { zoomTo(activeVideo, newScale, center.x, center.y); st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy; clampPan(activeVideo, st); update(activeVideo); } pinchState.lastCx = center.x; pinchState.lastCy = center.y; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchend', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { update(activeVideo); activeVideo = null; } }, { passive: false, capture: true, signal: zsig });
    return { resetZoom, zoomTo, isZoomed, setEnabled: () => {}, pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } }, destroy: () => { try { unsubAct?.(); } catch(_) {} try { unsubZoomEn?.(); } catch(_) {} zoomAC.abort(); if (rafId) { cancelAnimationFrame(rafId); rafId = null; } for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; } zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } };
  }

  function createZoomFeature(Store, P) {
    let zm = null;
    return defineFeature({
      name: 'zoom', phase: PHASE.PROCESS,
      onInit() { zm = createZoomManager(Store, P); }, onDestroy() { zm?.destroy(); },
      methods: { pruneDisconnected: () => zm?.pruneDisconnected(), isZoomed: (v) => zm?.isZoomed(v), zoomTo: (v, s, x, y) => zm?.zoomTo(v, s, x, y), resetZoom: (v) => zm?.resetZoom(v) }
    });
  }

  function createTimerFeature() {
    let _rafId = 0, _timerEl = null, _lastSecond = -1, _destroyed = false, _lastLayoutKey = '';

    function computeTimerPosition(rot, pos, vRect, pRect, vWidth) {
      const topOffset = vWidth > 1200 ? 16 : 8;
      const edgeMargin = vWidth > 1200 ? 20 : 10;
      const style = { top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' };
      let transform = rot ? `rotate(${rot === 270 ? -90 : rot}deg)` : '';
      const edges = {
        0:   { main: ['top',     vRect.top - pRect.top + topOffset],   near: ['left',  vRect.left - pRect.left + edgeMargin], far: ['right', pRect.right - vRect.right + edgeMargin], center: ['left', (vRect.left - pRect.left) + vWidth / 2], centerAxis: 'X' },
        90:  { main: ['right',  pRect.right - vRect.right + topOffset], near: ['top',   vRect.top - pRect.top + edgeMargin],   far: ['bottom', pRect.bottom - vRect.bottom + edgeMargin], center: ['top', (vRect.top - pRect.top) + vRect.height / 2], centerAxis: 'Y' },
        180: { main: ['bottom', pRect.bottom - vRect.bottom + topOffset], near: ['right', pRect.right - vRect.right + edgeMargin], far: ['left', vRect.left - pRect.left + edgeMargin], center: ['left', (vRect.left - pRect.left) + vWidth / 2], centerAxis: 'X' },
        270: { main: ['left',    vRect.left - pRect.left + topOffset],   near: ['bottom', pRect.bottom - vRect.bottom + edgeMargin], far: ['top', vRect.top - pRect.top + edgeMargin], center: ['top', (vRect.top - pRect.top) + vRect.height / 2], centerAxis: 'Y' }
      };
      const e = edges[rot] || edges[0];
      style[e.main[0]] = `${Math.max(topOffset, e.main[1])}px`;
      if (pos === 0) style[e.near[0]] = `${Math.max(edgeMargin, e.near[1])}px`;
      else if (pos === 1) { style[e.center[0]] = `${e.center[1]}px`; transform = `translate${e.centerAxis}(-50%) ${transform}`; }
      else style[e.far[0]] = `${Math.max(edgeMargin, e.far[1])}px`;
      return { style, transform: transform.trim() || 'none' };
    }

    function tick() {
      _rafId = 0; if (_destroyed) return; const ns = getNS(); const store = ns?.Store; if (!store) { scheduleNext(); return; }
      const act = store.get('app.active'), timeEn = store.get('app.timeEn'), isFs = !!document.fullscreenElement;
      if (!act || !timeEn || !isFs) { if (_timerEl) _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const activeVideo = ns.App?.getActiveVideo?.(); if (!activeVideo || !activeVideo.isConnected) { if (_timerEl) _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const now = new Date(), curSecond = now.getSeconds(); if (curSecond === _lastSecond && _timerEl && _timerEl.style.display !== 'none') { scheduleNext(); return; } _lastSecond = curSecond;
      const parent = activeVideo.parentNode; if (!parent) { scheduleNext(); return; }
      if (getComputedStyle(parent).position === 'static') { parent.style.position = 'relative'; }
      if (!_timerEl || _timerEl.parentNode !== parent) { if (_timerEl) { try { _timerEl.remove(); } catch (_) {} } _timerEl = document.createElement('div'); _timerEl.className = 'vsc-fs-timer'; const stroke = getNS()?.getSmoothStroke?.('#000000') || '-webkit-text-stroke: 1.5px #000; paint-order: stroke fill;'; _timerEl.style.cssText = `position: absolute; z-index: 2147483647; color: #FFE600; font-family: monospace; font-weight: bold; pointer-events: none; user-select: none; font-variant-numeric: tabular-nums; letter-spacing: 1px; ${stroke} transition: opacity 0.2s, transform 0.2s ease-out; opacity: 0.5;`; parent.appendChild(_timerEl); _lastLayoutKey = ''; }
      _timerEl.style.display = 'block';
      const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(curSecond).padStart(2, '0')}`;
      if (_timerEl.textContent !== timeStr) _timerEl.textContent = timeStr;

      const vRect = activeVideo.getBoundingClientRect(), pRect = parent.getBoundingClientRect(), vWidth = vRect.width, pos = store.get('app.timePos'), rot = store.get('video.rotation') || 0;
      const layoutKey = `${vRect.left|0},${vRect.top|0},${vRect.width|0},${pRect.left|0},${pRect.top|0},${pos},${rot}`;
      if (_lastLayoutKey === layoutKey) { scheduleNext(); return; } _lastLayoutKey = layoutKey;

      _timerEl.style.fontSize = `${vWidth >= 2500 ? 36 : vWidth >= 1900 ? 30 : vWidth >= 1200 ? 24 : 18}px`;

      const { style: posStyle, transform: transformStr } = computeTimerPosition(rot, pos, vRect, pRect, vWidth);
      Object.assign(_timerEl.style, posStyle);
      _timerEl.style.transform = transformStr;

      scheduleNext();
    }
    function scheduleNext() { if (!_destroyed && !_rafId) { _rafId = requestAnimationFrame(tick); } }
    return defineFeature({ name: 'timer', phase: PHASE.RENDER, onInit() { _destroyed = false; this.subscribe('fullscreen:changed', ({ active }) => { if (!active && _timerEl) { _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; } if (active) scheduleNext(); }); scheduleNext(); }, onDestroy() { _destroyed = true; if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; } if (_timerEl) { try { _timerEl.remove(); } catch (_) {} } _timerEl = null; _lastSecond = -1; _lastLayoutKey = ''; } });
  }

  function createPerfNotificationFeature(Utils) {
    let _badgeEl = null, _fadeTimer = 0; const { h } = Utils;
    function showBadge(text, activeVideo) {
      if (!activeVideo || !activeVideo.parentNode) return;
      if (!_badgeEl) { _badgeEl = h('div', { style: `position: absolute; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(231, 76, 60, 0.85); color: white; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: bold; z-index: 2147483647; pointer-events: none; transition: opacity 0.3s, transform 0.3s; opacity: 0; backdrop-filter: blur(4px); border: 1px solid rgba(255,255,255,0.2);` }); }
      if (_badgeEl.parentNode !== activeVideo.parentNode) { activeVideo.parentNode.appendChild(_badgeEl); }
      if (getComputedStyle(activeVideo.parentNode).position === 'static') { activeVideo.parentNode.style.position = 'relative'; }
      _badgeEl.textContent = text; _badgeEl.style.opacity = '1'; _badgeEl.style.transform = 'translateX(-50%) translateY(0)';
      clearTimeout(_fadeTimer); _fadeTimer = setTimeout(() => { if (_badgeEl) { _badgeEl.style.opacity = '0'; _badgeEl.style.transform = 'translateX(-50%) translateY(-10px)'; } }, 3000);
    }
    return defineFeature({ name: 'perfNotification', phase: PHASE.RENDER, onInit() { this.subscribe('pipeline:degraded', ({ mode }) => { showBadge(mode === 'low' ? '⚠ 성능 최적화: 시스템 부하 감지' : '⚠ 부하 감지: 시스템 부하 감지', this.getActiveVideo()); }); }, onDestroy() { clearTimeout(_fadeTimer); if (_badgeEl) { try { _badgeEl.remove(); } catch (_) {} } _badgeEl = null; } });
  }

  function createPiPFeature(Bus) {
    return defineFeature({
      name: 'pip', phase: PHASE.PROCESS,
      onInit() { on(document, 'enterpictureinpicture', (e) => { Bus.emit('pip:changed', { video: e.target, active: true }); }, { capture: true }); on(document, 'leavepictureinpicture', (e) => { Bus.emit('pip:changed', { video: e.target, active: false }); }, { capture: true }); },
      methods: { async toggle() { const v = this.getActiveVideo(); if (v) { const toggleFn = getNS()?.PiPManager?.toggle; if (toggleFn) await toggleFn(v); } } }
    });
  }

  let __vscUserSignalRev = 0;

  function createTargeting(bus) {
    if (bus) bus.on('pip:changed', ({ video, active }) => { });
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
    const isInPlayer = (vid) => { if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true; const root = vid.getRootNode(); if (root instanceof ShadowRoot && root.host) return !!root.host.closest(PLAYER_CONTAINER_SELECTORS); return false; };
    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      const now = performance.now(); const vp = getViewportSnapshot(); let best = null, bestScore = -Infinity;
      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;
        if (typeof v.checkVisibility === 'function') { try { if (!v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return; } catch (_) {} }
        const r = getRectCached(v, now), area = (r?.width || 0) * (r?.height || 0), pip = getNS()?.PiPManager?.isPiPActiveVideo(v), hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);
        if (!pip && !hasDecoded && area < 160 * 120) return;
        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0; if (v.currentTime > 0.2) s += 2.0; s += Math.log2(1 + area / 20000) * 1.1;
        const ptAge = Math.max(0, now - (lastUserPt.t || 0)), userBias = Math.exp(-ptAge / 1800), dx = cx - lastUserPt.x, dy = cy - lastUserPt.y; s += (2.0 * userBias) / (1 + (dx*dx + dy*dy) / 722500);
        const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx*cdx + cdy*cdy) / 810000);
        const isLikelyAd = (vid) => { const parent = vid.closest('[class*="-ad" i],[class*="_ad" i],[class*="ad-" i],[class*="ad_" i],[class^="ad " i],[class$=" ad" i],[id*="-ad" i],[id*="_ad" i],[data-ad],[data-ad-slot]'); if (parent) return true; if (r.width <= 400 && r.height <= 300 && vid.duration > 0 && vid.duration < 60) return true; return false; };
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0; if (isLikelyAd(v)) s -= 5.0; if (!v.controls && !isInPlayer(v)) s -= 1.0;
        if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2); if (pip) s += 3.0;
        if (s > bestScore) { bestScore = s; best = v; }
      };
      for (const v of videos) evalScore(v); const activePip = getNS()?.PiPManager?.getActiveVideo(); if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);
      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) { if (best && stickyTarget !== best && (bestScore < stickyScore + hysteresis)) { return { target: stickyTarget }; } }
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000; return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  function createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus }) {
    Store.sub(P.APP_UI, () => { Scheduler.request(true); });
    Store.sub(P.APP_ACT, (on) => { if (on) { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } });

    let __activeTarget = null, __lastApplyTarget = null;
    let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active;
        const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;

        let pick = Targeting.pickFastActiveOnly(visible.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) pick = Targeting.pickFastActiveOnly(Registry.videos, getNS()?.lastUserPt || {x:0,y:0,t:0}, wantAudioNow);
        if (!pick?.target) { try { const list = Array.from(document.querySelectorAll('video')); pick = { target: list.find(v => v && v.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v && v.readyState >= 2) || null }; } catch (_) {} }

        let nextTarget = pick?.target || __activeTarget;
        if (nextTarget !== __activeTarget) {
          if (Bus) Bus.emit('target:changed', { video: nextTarget, prev: __activeTarget });
          __activeTarget = nextTarget;
        }

        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (targetChanged) {
          if (__lastApplyTarget) { try { getNS()?.Adapter?.clear(__lastApplyTarget); } catch(_) {} }
          if (__activeTarget) { try { getNS()?.Filters?.invalidateCache(__activeTarget); } catch(_) {} }
        }

        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now();
        const pruneInterval = Registry.videos.size > 20 ? 1500 : (Registry.videos.size > 5 ? 3000 : 5000);
        if (vidsDirty.size > 40 || (now - lastPrune > pruneInterval)) { Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); lastPrune = now; }

        Features.updateAll({ active, force, vidsDirty, pbActive, target: __activeTarget, isApplyAll: !!Store.get(P.APP_APPLY_ALL), desiredRate: Store.get(P.PB_RATE) });
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisibilityHandler = null;
    const startTick = () => {
      stopTick();
      tickVisibilityHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) { Scheduler.request(false); } };
      document.addEventListener('visibilitychange', tickVisibilityHandler, { passive: true });
      tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000);
      if (__vscNs._intervals) __vscNs._intervals.push(tickTimer);
    };
    const stopTick = () => {
      if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0;
      if (tickVisibilityHandler) { document.removeEventListener('visibilitychange', tickVisibilityHandler); tickVisibilityHandler = null; }
    };

    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
    if (Store.get(P.APP_ACT)) startTick();

    return Object.freeze({ getActiveVideo: () => __activeTarget, destroy() { stopTick(); try { Features.destroyAll(); } catch(_) {} try { Registry.destroy?.(); } catch(_) {} } });
  }

  const Bus = createEventBus();

  if (CONFIG.DEBUG) {
    Bus.on('*', (payload) => console.log(`%c[VSC Bus] %c${payload.event}`, 'color: #3498db; font-weight: bold;', 'color: #2ecc71;', payload.data || ''));
    setTimeout(() => { Bus.emit('debug:bus_ready', { time: performance.now() }); }, 500);
  }

  const Utils = createUtils();
  const Scheduler = createScheduler(16);
  const Store = createLocalStore(CONFIG.DEFAULTS, Scheduler, Bus);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const PiPManager = createPiPManager(Store, ApplyReq);
  __vscNs.PiPManager = PiPManager;

  const isTop = (window.top === window);
  if (isTop && typeof GM_registerMenuCommand === 'function') {
    const reg = (title, fn) => { const id = GM_registerMenuCommand(title, fn); if (__vscNs._menuIds) __vscNs._menuIds.push(id); };
    reg('🔄 설정 초기화 (Reset All)', () => { if(confirm('모든 VSC 설정을 초기화하시겠습니까?')) { const key = 'vsc_prefs_' + location.hostname; if(typeof GM_deleteValue === 'function') GM_deleteValue(key); localStorage.removeItem(key); location.reload(); } });
    reg('⚡ Power 토글', () => { Store.set(CONFIG.P.APP_ACT, !Store.get(CONFIG.P.APP_ACT)); ApplyReq.hard(); });
    reg('🔊 Audio 토글', () => { Store.set(CONFIG.P.A_EN, !Store.get(CONFIG.P.A_EN)); ApplyReq.hard(); });
    reg('⚙️ UI 열기/닫기', () => { Store.set(CONFIG.P.APP_UI, !Store.get(CONFIG.P.APP_UI)); ApplyReq.hard(); });
    reg('🛠️ 디버그 모드 토글', () => { const url = new URL(location.href); if(url.searchParams.has('vsc_debug')) url.searchParams.delete('vsc_debug'); else url.searchParams.set('vsc_debug','1'); history.replaceState(null, '', url.toString()); location.reload(); });
    reg('📤 설정 내보내기 (Export)', () => {
      const key = 'vsc_prefs_' + location.hostname; let data;
      try { data = typeof GM_getValue === 'function' ? GM_getValue(key, null) : localStorage.getItem(key); } catch (_) {}
      if (!data) { alert('저장된 설정이 없습니다.'); return; }
      const json = typeof data === 'string' ? data : JSON.stringify(data);
      navigator.clipboard.writeText(json).then(() => alert('설정이 클립보드에 복사되었습니다.')).catch(() => { prompt('아래 텍스트를 복사하세요:', json); });
    });
    reg('📥 설정 가져오기 (Import)', () => {
      const input = prompt('설정 JSON을 붙여넣으세요:'); if (!input) return;
      try { JSON.parse(input); const key = 'vsc_prefs_' + location.hostname; if (typeof GM_setValue === 'function') GM_setValue(key, input); else localStorage.setItem(key, input); alert('설정을 가져왔습니다. 페이지를 새로고침합니다.'); location.reload(); } catch (e) { alert('잘못된 JSON 형식입니다: ' + e.message); }
    });
  }

  function bindNormalizer(keys, schema) {
    const run = () => { let changed = normalizeBySchema(Store, schema); if (changed) ApplyReq.hard(); };
    const unsubs = keys.map(k => Store.sub(k, run));
    addDisposer(() => unsubs.forEach(u => u()));
    run();
  }
  for (const [, schema] of Object.entries(CONFIG.SCHEMAS)) { bindNormalizer(schema.map(s => s.path), schema); }

  const Registry = createRegistry(Scheduler, Bus);
  const Targeting = createTargeting(Bus);
  initSpaUrlDetector(createDebounced(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }, CONFIG.SYS.SRD));

  function showScreenshotFlash(video) {
    const parent = video.parentElement;
    if (!parent) return;
    const flash = document.createElement('div');
    flash.style.cssText = `position: absolute; inset: 0; z-index: 2147483647; background: rgba(255,255,255,0.6); pointer-events: none; transition: opacity 0.3s ease-out; opacity: 1;`;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; setTimeout(() => flash.remove(), 400); });
  }

  onPageReady(() => {
    installShadowRootEmitterIfNeeded();
    __vscNs._timers = __vscNs._timers || [];
    const lateRescanDelays = [3000, 10000];
    for (const delay of lateRescanDelays) {
      const id = setTimeout(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); }, delay);
      __vscNs._timers.push(id);
    }

    (function ensureRegistryAfterBodyReady() {
      let ran = false;
      const runOnce = () => { if (ran) return; ran = true; Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); };
      if (document.body) { runOnce(); return; }
      const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
      on(document, 'DOMContentLoaded', runOnce, { once: true });
    })();

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, SVG_MAX_PIX_FAST: 3840 * 2160 });
    const Adapter = createBackendAdapter(Filters); __vscNs.Adapter = Adapter;
    __vscNs.Filters = Filters;

    const videoParamsMemo = createVideoParamsMemo();
    const PerfGovernor = createPerfGovernor();

    const Features = createFeatureRegistry(Bus);
    Features.register(createPipelineFeature(Store, Registry, Adapter, ApplyReq, CONFIG.P, Targeting, PerfGovernor, videoParamsMemo));
    const audioFeat = createAudioFeature(Store, PiPManager); Features.register(audioFeat);
    const zoomFeat = createZoomFeature(Store, CONFIG.P); Features.register(zoomFeat);
    const uiFeat = createUIFeature(Store, Registry, ApplyReq, Utils, CONFIG.P, Bus); Features.register(uiFeat);
    Features.register(createTimerFeature());
    Features.register(createPerfNotificationFeature(Utils));
    const pipFeat = createPiPFeature(Bus); Features.register(pipFeat);
    const abLoopFeat = createABLoopFeature(); Features.register(abLoopFeat);

    __vscNs.Features = Features;
    __vscNs.ZoomManager = zoomFeat;
    __vscNs.AudioWarmup = audioFeat.warmup;

    __vscNs.AudioSetTarget = (v) => { try { Bus.emit('target:changed', { video: v, prev: null }); } catch (_) {} };
    __vscNs.PiPToggle = () => { try { pipFeat.toggle(); } catch (_) {} };
    __vscNs.UIEnsure = () => { try { uiFeat.update(); } catch (_) {} };

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteractionForRetarget() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscUserSignalRev = (__vscUserSignalRev + 1) | 0; Scheduler.request(false); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) {
      on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else { updateLastUserPt(...getPt(e), performance.now()); } signalUserInteractionForRetarget(); }, evt === 'keydown' ? undefined : OPT_P);
    }

    let __VSC_APP__ = null;
    Features.initAll({ bus: Bus, store: Store, getActiveVideo: () => __VSC_APP__?.getActiveVideo() || null });
    __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Features, P: CONFIG.P, Targeting, Bus });
    __vscNs.App = __VSC_APP__;

    ApplyReq.hard();

    const SHORTCUT_MAP = new Map([
      ['KeyV', { needsAct: false, handler: () => { Store.set(CONFIG.P.APP_UI, !Store.get(CONFIG.P.APP_UI)); ApplyReq.hard(); } }],
      ['KeyP', { needsAct: true, handler: async () => { const v = __VSC_APP__?.getActiveVideo(); if (v) await PiPManager.toggle(v); } }],
      ['KeyD', { needsAct: true, handler: () => { const presets = ['off', 'Soft', 'Medium', 'Ultra', 'Master']; const cur = Store.get(CONFIG.P.V_PRE_S); const n = presets[(presets.indexOf(cur) + 1) % presets.length]; Store.set(CONFIG.P.V_PRE_S, n); ApplyReq.hard(); showToast(`선명: ${n}`); } }],
      ['KeyB', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.V_BRIGHT_LV)) || 0; const n = (cur + 1) % 6; Store.set(CONFIG.P.V_BRIGHT_LV, n); ApplyReq.hard(); showToast(`밝기: ${n === 0 ? 'OFF' : n}`); } }],
      ['KeyR', { needsAct: true, handler: () => { const n = getNextRotation(Store.get(CONFIG.P.V_ROTATION)); Store.set(CONFIG.P.V_ROTATION, n); ApplyReq.hard(); showToast(`회전: ${ROTATION_LABELS[n] || '정상'}`); } }],
      ['BracketRight', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.PB_RATE)) || 1.0; const n = Math.min(16, Math.round((cur + 0.05) * 100) / 100); Store.set(CONFIG.P.PB_RATE, n); Store.set(CONFIG.P.PB_EN, true); ApplyReq.hard(); showToast(`배속: ${n.toFixed(2)}x`); } }],
      ['BracketLeft', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.PB_RATE)) || 1.0; const n = Math.max(0.1, Math.round((cur - 0.05) * 100) / 100); Store.set(CONFIG.P.PB_RATE, n); Store.set(CONFIG.P.PB_EN, true); ApplyReq.hard(); showToast(`배속: ${n.toFixed(2)}x`); } }],
      ['Backslash', { needsAct: false, handler: () => { Store.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); showToast('배속 리셋 (1.0x)'); } }],
      ['KeyA', { needsAct: true, handler: () => { Features.get('abLoop')?.toggle?.(); } }],
      ['Period', { needsAct: true, handler: () => { const v = __VSC_APP__?.getActiveVideo(); if (!v) return; v.pause(); v.currentTime = Math.min(v.duration - 0.01, v.currentTime + 1 / 30); showToast(`▶| +1 프레임`); } }],
      ['Comma', { needsAct: true, handler: () => { const v = __VSC_APP__?.getActiveVideo(); if (!v) return; v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); showToast(`|◀ -1 프레임`); } }],
      ['KeyS', { needsAct: true, handler: () => {
        const video = __VSC_APP__?.getActiveVideo();
        if (!video || video.readyState < 2) return;
        const canvas = document.createElement('canvas'), vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh) return;
        canvas.width = vw; canvas.height = vh; const ctx2d = canvas.getContext('2d'); ctx2d.drawImage(video, 0, 0, vw, vh);
        canvas.toBlob((blob) => {
          if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url;
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), domain = location.hostname.replace(/\./g, '_');
          const preset = Store.get(CONFIG.P.V_PRE_S) || 'off'; const bright = Store.get(CONFIG.P.V_BRIGHT_LV) || 0;
          a.download = `vsc_${domain}_${preset}_b${bright}_${ts}.png`; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 5000); showScreenshotFlash(video);
        }, 'image/png');
      } }]
    ]);

    on(window, 'keydown', async (e) => {
      const isEditableTarget = (el) => { if (!el) return false; const tag = el.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable; };
      if (isEditableTarget(e.target) || !e.altKey || !e.shiftKey) return;
      const entry = SHORTCUT_MAP.get(e.code);
      if (!entry) return;
      e.preventDefault(); e.stopPropagation();
      if (entry.needsAct && !Store.get(CONFIG.P.APP_ACT)) return;
      try { await entry.handler(); } catch (_) {}
    }, { capture: true });

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') getNS()?.ApplyReq?.hard(); }, OPT_P);
    window.addEventListener('beforeunload', () => { __VSC_APP__?.destroy(); }, { once: true });

    if (CONFIG.DEBUG) {
      console.log('%c[VSC] Final Feature Execution Order:', 'color: #e67e22; font-weight: bold;');
      console.table(Features._debugOrder());
    }
  });

}

VSC_MAIN();
})();
// =================== PART 3 END ===================
