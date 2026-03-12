// ==UserScript==
// @name         Video_Control (v188.5 - Light Version)
// @namespace    https://github.com/
// @version      188.5
// @description  Deep optimized: Core utilities, polling fallback, hybrid CSS/SVG filter, legacy bloated code removed.
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

  const SCRIPT_VERSION = '188.5';
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

  /* ── Utility Helpers ─────────────────────────────────────────── */
  const safe = (fn) => { try { fn(); } catch (e) { if (/[?&]vsc_debug=1/.test(location.search)) console.warn('[VSC] safe() caught:', e); } };
  const disconnectSafe = (node) => { try { node?.disconnect(); } catch (_) {} };
  const removeSafe = (el) => { try { el?.remove(); } catch (_) {} };
  const safeRunAll = (...fns) => { for (const fn of fns) safe(fn); };

  function clearRuntimeTimers(ns) {
    for (const id of ns._timers || []) safe(() => clearTimeout(id));
    for (const id of ns._intervals || []) safe(() => clearInterval(id));
    ns._timers = []; ns._intervals = [];
  }

  function destroyRuntime(ns = __vscNs) {
    if (!ns || ns.__destroying) return;
    ns.__destroying = true;
    safeRunAll(
      () => clearRuntimeTimers(ns),
      () => ns.App?.destroy?.(),
      () => ns.Features?.destroyAll?.(),
      () => ns.Store?.destroy?.(),
      () => ns.Registry?.destroy?.(),
      () => ns._spaNavAC?.abort?.(),
      () => ns._globalHooksAC?.abort?.()
    );
    const snapshot = [...DISPOSERS];
    DISPOSERS.clear();
    for (let i = snapshot.length - 1; i >= 0; i--) safe(snapshot[i]);
    safeRunAll(
      () => { (ns._menuIds || []).forEach(id => { try { GM_unregisterMenuCommand(id); } catch (_) {} }); }
    );
    ns.__alive = false; ns.__destroying = false;
  }

  if (__vscNs.__alive) destroyRuntime(__vscNs);
  __vscNs.__alive = true;
  __vscNs._menuIds = [];
  __vscNs._timers = [];
  __vscNs._intervals = [];

  /* ── CONFIG ──────────────────────────────────────────────────── */
  const CONFIG = (() => {
    const IS_MOBILE = (() => {
      const uad = navigator.userAgentData;
      if (uad && typeof uad.mobile === 'boolean') return uad.mobile;
      if (/iPad/.test(navigator.platform) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))) return true;
      return /Mobi|Android|iPhone/i.test(navigator.userAgent);
    })();
    const VSC_ID = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);
    const DEBUG = /[?&]vsc_debug=1/.test(location.search);
    const FLAGS = Object.seal({ FILTER_FORCE_OPAQUE_BG: true });
    const DARK_BAND = Object.freeze({ LV1: 1, LV2: 2, LV3: 3 });

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

    const DEFAULTS = Object.freeze({
      video: { presetS: 'off', brightLevel: 0, shadowBandMask: 0, temp: 0 },
      audio: { enabled: false, boost: 0 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: true, zoomEn: false, advanced: false, timeEn: true, timePos: 1 }
    });

    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_ADV: 'app.advanced', APP_TIME_EN: 'app.timeEn', APP_TIME_POS: 'app.timePos',
      V_PRE_S: 'video.presetS', V_BRIGHT_LV: 'video.brightLevel', V_SHADOW_MASK: 'video.shadowBandMask', V_TEMP: 'video.temp',
      A_EN: 'audio.enabled', A_BST: 'audio.boost',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    return Object.freeze({ IS_MOBILE, VSC_ID, DEBUG, FLAGS, DARK_BAND, PRESETS, DEFAULTS, P });
  })();

  __vscNs.CONFIG = CONFIG;
  const FLAGS = CONFIG.FLAGS;
  __vscNs.FLAGS = Object.freeze({ ...FLAGS });

  /* ── Constants & Small Utilities ─────────────────────────────── */
  const PLAYER_CONTAINER_SELECTORS = '.html5-video-player, #movie_player, .shaka-video-container, .dplayer-video-wrap, .vjs-container, .video-js, [data-player], [id*="player" i], [class*="player" i]';
  const OPT_P = { passive: true };
  const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

  /* ── Signal Combining ────────────────────────────────────────── */
  const combineSignals = (...signals) => {
    const existing = signals.filter(Boolean);
    if (existing.length === 0) return AbortSignal.abort();
    if (existing.length === 1) return existing[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(existing);
    const ac = new AbortController();
    const onAbort = () => { ac.abort(); for (const s of existing) s.removeEventListener('abort', onAbort); };
    for (const s of existing) s.addEventListener('abort', onAbort, { once: true });
    return ac.signal;
  };

  /* ── Event Binding ───────────────────────────────────────────── */
  function on(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    if (typeof opts === 'boolean') opts = { capture: opts };
    const merged = opts ? { ...opts } : {};
    merged.signal = merged.signal ? combineSignals(merged.signal, __globalSig) : __globalSig;
    target.addEventListener(type, fn, merged);
  }

  const blockInterference = (el) => {
    if (!el) return;
    const stop = (e) => { e.stopPropagation(); };
    for (const evt of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'contextmenu', 'dblclick']) {
      on(el, evt, stop, { passive: false });
    }
  };
  __vscNs.blockInterference = blockInterference;

  /* ── Page Ready ──────────────────────────────────────────────── */
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

  const log = {
    error: (...a) => console.error('[VSC]', ...a),
    warn: (...a) => console.warn('[VSC]', ...a),
    debug: (...a) => { if (CONFIG.DEBUG) console.debug('[VSC]', ...a); }
  };

  /* ── EventBus ────────────────────────────────────────────────── */
  function createEventBus() {
    const target = new EventTarget();
    let _destroyed = false;
    const _wrapperMap = new WeakMap();
    return Object.freeze({
      on(event, handler, opts) {
        if (_destroyed || typeof handler !== 'function') return () => {};
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
      },
      off(event, handler) {
        if (!handler) return;
        const eventMap = _wrapperMap.get(handler);
        const wrapper = eventMap?.get(event);
        if (wrapper) { target.removeEventListener(event, wrapper); eventMap.delete(event); }
      },
      destroy() { _destroyed = true; }
    });
  }

  /* ── Feature System ──────────────────────────────────────────── */
  const PHASE = Object.freeze({ COMPUTE: 0, PROCESS: 1, RENDER: 2 });

  function defineFeature(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new Error('[VSC defineFeature] "name" is required');
    const _name = spec.name, _phase = (typeof spec.phase === 'number') ? spec.phase : PHASE.PROCESS;
    let _deps = null, _initialized = false, _destroyed = false;
    const _unsubs = [];
    const module = {
      getName() { return _name; },
      getPhase() { return _phase; },
      isInitialized() { return _initialized; },
      subscribe(event, handler) { if (!_deps) throw new Error(`[VSC ${_name}] subscribe() called before init()`); const unsub = _deps.bus.on(event, handler); _unsubs.push(unsub); return unsub; },
      emit(event, data) { if (_deps) _deps.bus.emit(event, data); },
      getSetting(path) { return _deps?.store?.get(path); },
      setSetting(path, value) { _deps?.store?.set(path, value); },
      getActiveVideo() { return _deps?.getActiveVideo?.() || null; },
      init(deps) {
        if (_initialized) return;
        _deps = deps; _initialized = true; _destroyed = false;
        if (typeof spec.onInit === 'function') spec.onInit.call(module, deps);
      },
      update(ctx) { if (_initialized && !_destroyed && typeof spec.onUpdate === 'function') spec.onUpdate.call(module, ctx); },
      destroy() {
        if (_destroyed) return; _destroyed = true; _initialized = false;
        if (typeof spec.onDestroy === 'function') {
          try {
            const result = spec.onDestroy.call(module);
            if (result && typeof result.catch === 'function') result.catch(e => { if (CONFIG?.DEBUG) console.warn(`[VSC ${_name}] async onDestroy error:`, e); });
          } catch (_) {}
        }
        for (let i = _unsubs.length - 1; i >= 0; i--) safe(_unsubs[i]);
        _unsubs.length = 0; _deps = null;
      }
    };
    if (spec.methods && typeof spec.methods === 'object') {
      const RESERVED = new Set(['getName', 'init', 'update', 'destroy', 'getPhase', 'isInitialized', 'subscribe', 'emit', 'getSetting', 'setSetting', 'getActiveVideo']);
      for (const [key, fn] of Object.entries(spec.methods)) { if (RESERVED.has(key)) throw new Error(`[VSC] "${key}" reserved`); module[key] = fn; }
    }
    return Object.freeze(module);
  }

  function createFeatureRegistry(bus) {
    const _modules = new Map();
    let _initialized = false, _sortedCache = null, _sortDirty = true;
    function _validate(mod) { for (const m of ['getName', 'init', 'update', 'destroy']) { if (typeof mod[m] !== 'function') throw new Error(`[VSC] Missing ${m}()`); } }
    function _getSorted() {
      if (!_sortDirty && _sortedCache) return _sortedCache;
      const entries = [..._modules.entries()];
      entries.sort((a, b) => (a[1].getPhase?.() ?? PHASE.PROCESS) - (b[1].getPhase?.() ?? PHASE.PROCESS));
      _sortedCache = entries; _sortDirty = false; return entries;
    }
    return Object.freeze({
      register(module) { _validate(module); const name = module.getName(); if (_modules.has(name)) safe(() => _modules.get(name).destroy()); _modules.set(name, module); _sortDirty = true; },
      initAll(deps) { if (_initialized) return; _initialized = true; for (const [, mod] of _getSorted()) safe(() => mod.init(deps)); bus.emit('features:initialized', { count: _modules.size, names: _getSorted().map(([n]) => n) }); },
      updateAll(ctx) { for (const [, mod] of _getSorted()) safe(() => mod.update(ctx)); },
      destroyAll() { const entries = [..._getSorted()].reverse(); for (const [, mod] of entries) safe(() => mod.destroy()); _modules.clear(); _sortedCache = null; _sortDirty = true; _initialized = false; },
      get(name) { return _modules.get(name) || null; },
      list() { return _getSorted().map(([n]) => n); },
      _debugOrder() { return _getSorted().map(([n, m]) => ({ name: n, phase: m.getPhase?.() ?? 1 })); }
    });
  }

  /* ── Layout Revision Tracking ────────────────────────────────── */
  let __vscLayoutRev = 0;
  let _scrollBumpRaf = 0;
  const bumpLayoutRev = () => { __vscLayoutRev = (__vscLayoutRev + 1) | 0; };
  const bumpLayoutRevThrottled = () => { if (!_scrollBumpRaf) _scrollBumpRaf = requestAnimationFrame(() => { _scrollBumpRaf = 0; bumpLayoutRev(); }); };
  on(window, 'scroll', bumpLayoutRevThrottled, { passive: true, capture: true });
  on(window, 'resize', bumpLayoutRev, { passive: true });
  try {
    const vv = window.visualViewport;
    if (vv) { on(vv, 'scroll', bumpLayoutRevThrottled, { passive: true }); on(vv, 'resize', bumpLayoutRev, { passive: true }); }
  } catch (_) {}

  /* ── Video State Map ─────────────────────────────────────────── */
  const videoStateMap = new WeakMap();
  const _vStateProto = {
    visible: false, bound: false, applied: false, rect: null, _rectRev: 0,
    audioFailUntil: 0, desiredRate: undefined, origFilter: undefined,
    origFilterPrio: '', origWebkitFilter: undefined, origWebkitFilterPrio: '',
    lastFilterUrl: undefined, lastTransform: undefined, lastScale: undefined,
    rateState: undefined
  };

  const getVState = (v) => {
    let st = videoStateMap.get(v);
    if (!st) { st = Object.create(_vStateProto); st.rect = null; st.rateState = undefined; videoStateMap.set(v, st); }
    return st;
  };

  const TOUCHED = { videos: new Set(), rateVideos: new Set() };

  function getRectCached(v, now) {
    const st = getVState(v);
    if (st.rect && st._rectRev === __vscLayoutRev) return st.rect;
    const fresh = v.getBoundingClientRect(); st.rect = fresh; st._rectRev = __vscLayoutRev; return fresh;
  }

  /* ── Debounce ────────────────────────────────────────────────── */
  function createDebounced(fn, ms = 250) {
    let t = null;
    const debounced = (...args) => { if (t !== null) clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
    return debounced;
  }

  /* ── SPA URL Detector (Simplified) ───────────────────────────── */
  function initSpaUrlDetector(onChanged) {
    try { __vscNs._spaDetector?.destroy?.(); } catch (_) {}
    const ac = new AbortController();
    const sig = combineSignals(ac.signal, __globalSig);
    let lastHref = location.href;
    let pollId = 0;

    const emitIfChanged = () => {
      const next = location.href;
      if (next === lastHref) return;
      lastHref = next;
      onChanged();
    };

    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: sig });
    }
    on(window, 'popstate', emitIfChanged, { passive: true, signal: sig });

    if (!window.navigation) {
      pollId = setInterval(emitIfChanged, 500);
      if (__vscNs._intervals) __vscNs._intervals.push(pollId);
    }

    const destroy = () => { ac.abort(); if (pollId) clearInterval(pollId); };
    __vscNs._spaDetector = { destroy };
    return __vscNs._spaDetector;
  }

  /* ── DOM Utilities ───────────────────────────────────────────── */
  function createUtils() {
    const SVG_TAGS = new Set(['svg', 'defs', 'filter', 'feColorMatrix', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feGaussianBlur', 'feComposite']);
    return {
      clamp: VSC_CLAMP,
      h: (tag, props = {}, ...children) => {
        const isSvg = SVG_TAGS.has(tag) || props.ns === 'svg';
        const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
          if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
          else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
          else if (k === 'class') el.className = v;
          else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v);
        }
        children.flat().forEach(c => { if (c != null) el.append(c); });
        return el;
      }
    };
  }

  /* ── Simplified Scheduler ────────────────────────────────────── */
  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, rafId = 0, timer = 0;
    function clearPending() {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }
    function run() {
      rafId = 0; const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun;
      if (!doForce && dt < minIntervalMs) {
        if (!timer) timer = setTimeout(() => { timer = 0; run(); }, Math.max(0, minIntervalMs - dt));
        return;
      }
      queued = false; lastRun = now;
      if (applyFn) safe(() => applyFn(doForce));
    }
    const request = (immediate = false) => {
      if (immediate) { force = true; clearPending(); queued = true; rafId = requestAnimationFrame(run); return; }
      if (queued) return; queued = true; clearPending(); rafId = requestAnimationFrame(run);
    };
    return { registerApply: (fn) => { applyFn = fn; }, request, destroy: () => { clearPending(); applyFn = null; } };
  }

  /* ── Store ───────────────────────────────────────────────────── */
  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };

  function createLocalStore(defaults, scheduler, bus) {
    const state = structuredClone(defaults);
    let rev = 0; const listeners = new Map();
    const storeAC = new AbortController(); const storeSig = combineSignals(storeAC.signal, __globalSig);
    const PREF_KEY = 'vsc_prefs_' + location.hostname;
    let _lastSavedJson = '', _lastSavedRev = rev;

    function loadPrefs() {
      try { if (typeof GM_getValue === 'function') { const v = GM_getValue(PREF_KEY, null); if (v != null) return typeof v === 'object' ? v : JSON.parse(v); } } catch (_) {}
      try { const s = localStorage.getItem(PREF_KEY); return s ? JSON.parse(s) : null; } catch (_) {}
      return null;
    }
    function savePrefsRaw(json) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(PREF_KEY, json); return true; } } catch (_) {}
      try { localStorage.setItem(PREF_KEY, json); return true; } catch (_) {}
      return false;
    }
    function clearPrefsRaw() {
      let cleared = false;
      try { if (typeof GM_deleteValue === 'function') { GM_deleteValue(PREF_KEY); cleared = true; } } catch (_) {}
      try { localStorage.removeItem(PREF_KEY); cleared = true; } catch (_) {}
      return cleared;
    }
    function mergeKnown(dst, src, defaultsObj) {
      if (!src || typeof src !== 'object') return;
      for (const key of Object.keys(defaultsObj)) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        if (typeof defaultsObj[key] === 'boolean') dst[key] = !!src[key];
        else if (typeof defaultsObj[key] === 'number') { const n = Number(src[key]); dst[key] = Number.isFinite(n) ? n : defaultsObj[key]; }
        else if (typeof defaultsObj[key] === 'string') dst[key] = typeof src[key] === 'string' ? src[key] : defaultsObj[key];
        else dst[key] = src[key];
      }
    }

    try {
      const parsed = loadPrefs();
      if (parsed && typeof parsed === 'object') {
        if (parsed.video && !('brightLevel' in parsed.video)) parsed.video.brightLevel = 0;
        if (parsed.video && !('temp' in parsed.video)) parsed.video.temp = 0;
        mergeKnown(state.video, parsed.video, CONFIG.DEFAULTS.video);
        mergeKnown(state.audio, parsed.audio, CONFIG.DEFAULTS.audio);
        mergeKnown(state.playback, parsed.playback, CONFIG.DEFAULTS.playback);
        mergeKnown(state.app, parsed.app, CONFIG.DEFAULTS.app);
      }
    } catch (e) { log.warn('Invalid prefs detected. Resetting.', e); clearPrefsRaw(); }

    _lastSavedJson = JSON.stringify(state);

    function _doSave() {
      if (rev === _lastSavedRev) return;
      const json = JSON.stringify(state);
      if (json === _lastSavedJson || json.length > 16384) return;
      _lastSavedRev = rev;
      if (savePrefsRaw(json)) _lastSavedJson = json;
    }

    const savePrefs = createDebounced(() => _doSave(), 500);
    const flushNow = () => _doSave();

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }, { passive: true, signal: storeSig });
    on(window, 'pagehide', () => flushNow(), { passive: true, signal: storeSig });

    const emit = (path, val) => {
      const cbs = listeners.get(path); if (cbs) for (const cb of cbs) safe(() => cb(val));
      const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) for (const cb of cbsStar) safe(() => cb(val)); }
    };
    const notifyChange = (path, val) => { rev++; emit(path, val); if (bus) bus.emit('settings:changed', { path, value: val }); savePrefs(); scheduler.request(false); };

    return {
      state, rev: () => rev,
      getCatRef: (cat) => state[cat],
      get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; },
      set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); },
      batch: (cat, obj) => {
        let changed = false; const updates = [];
        for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; changed = true; updates.push([`${cat}.${k}`, v]); } }
        if (changed) { rev++; for (const [path, val] of updates) emit(path, val); if (bus) bus.emit('settings:changed', { path: `${cat}.*`, value: obj, batch: true }); savePrefs(); scheduler.request(false); }
      },
      sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); },
      destroy: () => { storeAC.abort(); try { _doSave(); } catch (_) {} listeners.clear(); }
    };
  }

  /* ── Registry (Simplified Shadow DOM) ────────────────────────── */
  function createRegistry(scheduler, bus) {
    let destroyed = false;
    const videos = new Set(), visible = { videos: new Set() };
    let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA;
    let rev = 0, __refreshQueued = false, refreshRafId = 0, rescanTimerId = 0;

    function requestRefreshCoalesced() {
      if (destroyed || __refreshQueued) return;
      __refreshQueued = true;
      refreshRafId = requestAnimationFrame(() => { refreshRafId = 0; __refreshQueued = false; if (!destroyed) scheduler.request(false); });
    }

    const IO_MARGIN_PX = CONFIG.IS_MOBILE ? 80 : Math.min(200, Math.round(innerHeight * 0.10));
    const ioOpts = { root: null, threshold: [0], rootMargin: `${IO_MARGIN_PX}px` };

    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target;
        if (!videos.has(el)) continue;
        const isVis = e.isIntersecting; const st = getVState(el);
        st.visible = isVis; st.rect = e.boundingClientRect; st._rectRev = __vscLayoutRev;
        if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
        else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
      }
      if (changed) { rev++; requestRefreshCoalesced(); }
    }, ioOpts) : null;

    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const el = e.target; if (!el || el.tagName !== 'VIDEO') continue;
        const st = getVState(el);
        if (e.contentBoxSize?.[0]) {
          const s = e.contentBoxSize[0];
          st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize };
        } else { st.rect = e.contentRect ? el.getBoundingClientRect() : null; }
        st._rectRev = __vscLayoutRev; dirty.videos.add(el); changed = true;
      }
      if (changed) { bumpLayoutRev(); requestRefreshCoalesced(); }
    }) : null;

    const MAX_SHADOW_OBS = 5;
    let baseRoot = null, baseObserver = null;
    const shadowObserverMap = new Map();

    function disconnectBaseObserver() { if (!baseObserver) return; disconnectSafe(baseObserver); baseObserver = null; }

    function untrackVideo(v) {
      if (!v || v.tagName !== 'VIDEO') return;
      const wasTracked = videos.has(v);
      if (wasTracked) { videos.delete(v); if (bus) bus.emit('video:lost', { video: v }); }
      visible.videos.delete(v); dirtyA.videos.delete(v); dirtyB.videos.delete(v); dirty.videos.add(v);
      io?.unobserve(v); ro?.unobserve(v);
    }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0);
      videos.add(el);
      if (bus) bus.emit('video:detected', { video: el, isFirst: wasEmpty });
      if (wasEmpty) queueMicrotask(() => { __vscNs.UIEnsure?.(); });
      if (io) { io.observe(el); } else {
        const st = getVState(el);
        let vis = true;
        if (typeof el.checkVisibility === 'function') { try { vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (_) {} }
        st.visible = vis;
        if (vis && !visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); }
      }
      ro?.observe(el);
      lazyScanAncestorShadowRoots(el);
    };

    const WorkQ = (() => {
      let pending = new Set();
      let scheduled = false;
      let rafId = 0;
      const scanNode = (n) => {
        if (!n) return;
        if (n.nodeType === 1 && n.tagName === 'VIDEO') { observeVideo(n); return; }
        if (n.nodeType === 1 || n.nodeType === 11) {
          const vs = n.querySelectorAll?.('video');
          if (vs?.length) for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
        }
      };
      const flush = () => {
        rafId = 0; scheduled = false;
        const batch = pending;
        pending = new Set();
        for (const n of batch) { if (destroyed) return; scanNode(n); }
      };
      return Object.freeze({
        enqueue(n) {
          if (destroyed || !n) return;
          pending.add(n);
          if (!scheduled) { scheduled = true; rafId = requestAnimationFrame(flush); }
        },
        destroy() { if (rafId) cancelAnimationFrame(rafId); pending.clear(); scheduled = false; }
      });
    })();

    function makeObserver(root, onDisconnect) {
      const mo = new MutationObserver((muts) => {
        if (root !== baseRoot && root.host && !root.host.isConnected) { disconnectSafe(mo); onDisconnect?.(); return; }
        let touchedVideoTree = false;
        for (const m of muts) {
          if (m.addedNodes?.length) for (const n of m.addedNodes) { if (n && (n.nodeType === 1 || n.nodeType === 11)) WorkQ.enqueue(n); }
          if (m.removedNodes?.length) {
            for (const n of m.removedNodes) {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'VIDEO') { untrackVideo(n); touchedVideoTree = true; continue; }
              const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null;
              if (list?.length) { for (let i = 0; i < list.length; i++) untrackVideo(list[i]); touchedVideoTree = true; }
            }
          }
        }
        if (touchedVideoTree) requestRefreshCoalesced();
      });
      mo.observe(root, { childList: true, subtree: true }); return mo;
    }

    const connectObserver = (root) => {
      if (!root) return; const isBase = root === baseRoot;
      if (isBase) { if (baseObserver) return; baseObserver = makeObserver(root); WorkQ.enqueue(root); return; }
      if (shadowObserverMap.has(root)) return;
      if (root.host && !root.host.isConnected) return;
      if (shadowObserverMap.size >= MAX_SHADOW_OBS) {
        let evicted = false;
        for (const [sr, mo] of shadowObserverMap) { if (!sr.host || !sr.host.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(sr); evicted = true; break; } }
        if (!evicted) { for (const [sr, mo] of shadowObserverMap) { if (!sr.querySelector?.('video')) { disconnectSafe(mo); shadowObserverMap.delete(sr); evicted = true; break; } } }
        if (!evicted) { const oldest = shadowObserverMap.keys().next().value; disconnectSafe(shadowObserverMap.get(oldest)); shadowObserverMap.delete(oldest); }
      }
      const mo = makeObserver(root, () => shadowObserverMap.delete(root));
      shadowObserverMap.set(root, mo);
      WorkQ.enqueue(root);
    };

    function lazyScanAncestorShadowRoots(videoEl) {
      let node = videoEl, depth = 0;
      while (node && depth++ < 30) { const root = node.getRootNode?.(); if (root && root !== document && root.host) { connectObserver(root); node = root.host; } else break; }
    }

    const refreshObservers = () => {
      disconnectBaseObserver();
      for (const [sr, mo] of [...shadowObserverMap]) {
        if (!sr.host?.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(sr); }
        else if (shadowObserverMap.size > 2 && !sr.querySelector?.('video')) { disconnectSafe(mo); shadowObserverMap.delete(sr); }
      }
      baseRoot = document.body || document.documentElement;
      if (baseRoot) { WorkQ.enqueue(baseRoot); connectObserver(baseRoot); }
    };
    refreshObservers();

    function startVideoPolling() {
      const pollId = setInterval(() => {
        if (!__vscNs.__alive || destroyed) { clearInterval(pollId); return; }
        const allVideos = document.querySelectorAll('video');
        for (let i = 0; i < allVideos.length; i++) observeVideo(allVideos[i]);
        for (const [sr] of shadowObserverMap) {
          if (!sr.host?.isConnected) continue;
          const vs = sr.querySelectorAll('video');
          for (let i = 0; i < vs.length; i++) observeVideo(vs[i]);
        }
      }, 3000);
      if (__vscNs._intervals) __vscNs._intervals.push(pollId);
      return pollId;
    }
    const pollTimer = startVideoPolling();

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
        for (const [root, mo] of [...shadowObserverMap]) {
          const host = root.host;
          if (!host || !host.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(root); for (const v of [...videos]) { try { if (v.getRootNode() === root) untrackVideo(v); } catch (_) {} } }
        }
        const removed = pruneDisconnectedVideos(); if (removed) rev++;
      },
      consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
      rescanAll: () => {
        if (destroyed) return;
        if (rescanTimerId) clearTimeout(rescanTimerId);
        rescanTimerId = setTimeout(() => {
          rescanTimerId = 0; if (destroyed) return;
          try {
            const base = document.documentElement || document.body; if (!base) return;
            function* walkRoots(rootBase) {
              if (!rootBase) return; const stack = [rootBase]; const seen = new Set();
              while (stack.length > 0) {
                const r = stack.pop(); if (!r || seen.has(r)) continue; seen.add(r); yield r;
                const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
                let node = walker.nextNode();
                while (node) { if (node.shadowRoot) stack.push(node.shadowRoot); node = walker.nextNode(); }
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
        if (pollTimer) clearInterval(pollTimer);
        WorkQ.destroy(); disconnectBaseObserver();
        for (const mo of shadowObserverMap.values()) disconnectSafe(mo);
        shadowObserverMap.clear(); disconnectSafe(io); disconnectSafe(ro);
        videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear();
      }
    };
  }

// =================== PART 1 END ===================
/* ── Audio Utilities (Simplified) ────────────────────────────── */
  const audioSourceMap = new WeakMap();

  function getOrCreateAudioSource(ctx, video) {
    const existing = audioSourceMap.get(video);
    if (existing) {
      if (existing.context === ctx) return existing;
      return existing;
    }
    const src = ctx.createMediaElementSource(video);
    audioSourceMap.set(video, src);
    return src;
  }

  function detachAudioSource(video) {
    const src = audioSourceMap.get(video);
    if (src) { disconnectSafe(src); audioSourceMap.delete(video); }
  }

  function createAudioParamCache() {
    const _cache = new Map();
    return {
      sttIfChanged(param, key, newVal, time, tc) {
        const prev = _cache.get(key);
        if (prev !== undefined && Math.abs(prev - newVal) < 0.005) return;
        _cache.set(key, newVal);
        try { param.setTargetAtTime(newVal, time, tc); } catch (_) { param.value = newVal; }
      },
      invalidate: (k) => _cache.delete(k),
      clear: () => _cache.clear()
    };
  }

  const mkComp = (actx) => (thr, knee, ratio, atk, rel) => {
    const c = actx.createDynamicsCompressor();
    c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel;
    return c;
  };

  function buildAudioGraph(audioCtx) {
    const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), boostGain: audioCtx.createGain() };
    const comp = mkComp(audioCtx)(-18.0, 12.0, 3.0, 0.02, 0.2);
    const lim = mkComp(audioCtx)(-1.0, 1.0, 20.0, 0.001, 0.1);

    n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
    n.inputGain.connect(comp); comp.connect(n.boostGain); n.boostGain.connect(lim); lim.connect(n.wetGain); n.wetGain.connect(n.masterOut);
    n.masterOut.connect(audioCtx.destination);

    Object.assign(n, { _compressor: comp, _limiter: lim, _paramCache: createAudioParamCache() });
    return n;
  }

  function createAudioFeature(sm) {
    let ctx, target = null, currentSrc = null, currentNodes = null;
    const _audioAC = new AbortController();

    const syncMixAndParams = () => {
      if (!ctx || !currentNodes) return;
      const pc = currentNodes._paramCache;
      const dynAct = !!(sm.get(CONFIG.P.A_EN) && sm.get(CONFIG.P.APP_ACT));
      const isHooked = !!currentSrc;
      const wetT = (dynAct && isHooked) ? 1 : 0;

      pc.sttIfChanged(currentNodes.dryGain.gain, 'dryGain', 1 - wetT, ctx.currentTime, 0.005);
      pc.sttIfChanged(currentNodes.wetGain.gain, 'wetGain', wetT, ctx.currentTime, 0.005);
      if (!dynAct || !isHooked) return;

      const bLv = Number(sm.get(CONFIG.P.A_BST)) || 0;
      pc.sttIfChanged(currentNodes.boostGain.gain, 'boostGain', Math.pow(10, bLv / 20), ctx.currentTime, 0.05);

      pc.sttIfChanged(currentNodes._compressor.threshold, 'comp.thr', -18.0, ctx.currentTime, 0.05);
      pc.sttIfChanged(currentNodes._compressor.ratio, 'comp.ratio', 3.0, ctx.currentTime, 0.05);
    };

    const setTarget = (v) => {
      if (v == null) { detachCurrentSource(); syncMixAndParams(); return; }
      if (v === target && currentSrc) { syncMixAndParams(); return; }
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        try { ctx = new AC({ latencyHint: 'interactive' }); currentNodes = buildAudioGraph(ctx); } catch (_) { return; }
      }
      const connect = (vid) => {
        let s = audioSourceMap.get(vid);
        if (s && s.context !== ctx) { detachAudioSource(vid); s = null; }
        if (!s) {
          try { s = getOrCreateAudioSource(ctx, vid); }
          catch (e) { getVState(vid).audioFailUntil = performance.now() + 5000; target = vid; currentSrc = null; syncMixAndParams(); return; }
        }
        disconnectSafe(s); s.connect(currentNodes.inputGain);
        currentSrc = s; target = vid; syncMixAndParams();
      };
      if (target && target !== v) detachCurrentSource();
      connect(v);
    };

    const detachCurrentSource = () => { if (currentSrc) disconnectSafe(currentSrc); currentSrc = null; target = null; };

    return defineFeature({
      name: 'audio', phase: PHASE.PROCESS,
      onInit() { this.subscribe('target:changed', ({ video }) => { const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT)); setTarget((want || currentSrc) ? video : null); }); },
      onUpdate(ctx) {
        const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT));
        const vid = (want || currentSrc) ? (ctx.target || this.getActiveVideo()) : null;
        if (vid && vid !== target) { const st = getVState(vid); if (performance.now() < (st.audioFailUntil || 0)) return; }
        setTarget(vid);
      },
      methods: { warmup: () => { if (ctx?.state === 'suspended') ctx.resume(); }, syncMixAndParams, hasCtx: () => !!ctx },
      async onDestroy() { _audioAC.abort(); detachCurrentSource(); if (ctx) await ctx.close(); ctx = null; currentNodes = null; }
    });
  }

  /* ── Playback Rate Management ────────────────────────────────── */
  function getRateState(v) {
    const st = getVState(v);
    if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, retryCount: 0 };
    return st.rateState;
  }

  function markInternalRateChange(v, ms = 300) {
    const st = getRateState(v), now = performance.now();
    st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms);
  }

  function restoreRateOne(el) {
    try {
      const st = getRateState(el); if (!st || st.orig == null) return;
      const rate = Number(st.orig) > 0.01 ? Number(st.orig) : 1.0;
      st.orig = null; markInternalRateChange(el, 500); el.playbackRate = rate;
    } catch (_) {}
  }

  function handleExternalRateChange(video, storeRef) {
    const rSt = getRateState(video), now = performance.now();
    if (now < (rSt.suppressSyncUntil || 0) || (now - (rSt.lastSetAt || 0)) < 500) return;
    const captured = video.playbackRate;
    if (!Number.isFinite(captured) || captured < 0.07) return;
    rSt._pendingExternalRate = captured; rSt._pendingExternalT = now;
    if (rSt._externalMtQueued) return;
    rSt._externalMtQueued = true;
    queueMicrotask(() => {
      rSt._externalMtQueued = false;
      const finalRate = rSt._pendingExternalRate, activeVideo = __vscNs.App?.getActiveVideo?.();
      if (!storeRef || !activeVideo || video !== activeVideo) return;
      if (Math.abs(finalRate - storeRef.get(CONFIG.P.PB_RATE)) < 0.01) return;
      markInternalRateChange(video, 250);
      storeRef.batch('playback', { rate: finalRate, enabled: true });
    });
  }

  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el), now = performance.now();
    if (now < (rSt.suppressSyncUntil || 0)) return;
    if (rSt.orig == null) rSt.orig = el.playbackRate;
    if (Object.is(st.desiredRate, desiredRate) && Math.abs(el.playbackRate - desiredRate) < 0.01) { rSt.retryCount = 0; TOUCHED.rateVideos.add(el); return; }
    if (rSt.retryCount > 6) { rSt.suppressSyncUntil = now + Math.min(6000, 800 << Math.min(rSt.retryCount - 6, 3)); rSt.retryCount = 0; return; }
    st.desiredRate = desiredRate; markInternalRateChange(el, 250);
    try { el.playbackRate = desiredRate; } catch (_) {}
    rSt.retryCount++;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      if (Math.abs(el.playbackRate - desiredRate) > 0.01) { markInternalRateChange(el, 250); try { el.playbackRate = desiredRate; } catch (_) {} rSt.retryCount++; } else { rSt.retryCount = 0; }
    });
    TOUCHED.rateVideos.add(el);
  }

  /* ── Video Binding ───────────────────────────────────────────── */
  function ensureMobileInlinePlaybackHints(video) { if (!video || !CONFIG.IS_MOBILE) return; try { if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', ''); } catch (_) {} }

  const bindVideoOnce = (v, ApplyReq, storeRef) => {
    const st = getVState(v); if (st.bound) return; st.bound = true;
    ensureMobileInlinePlaybackHints(v);
    st._ac = new AbortController();
    const opts = { passive: true, signal: combineSignals(st._ac.signal, __globalSig) };
    const reset = () => { queueMicrotask(() => { st.audioFailUntil = 0; st.rect = null; ApplyReq.hard(); }); };
    for (const ev of ['loadstart', 'loadedmetadata', 'emptied']) on(v, ev, reset, opts);
    on(v, 'ratechange', () => handleExternalRateChange(v, storeRef), opts);
    on(v, 'resize', () => { __vscNs.Filters?.invalidateCache(v); ApplyReq.hard(); }, opts);
  };

  function batchReadRects(candidates) {
    for (const el of candidates) {
      if (!el.isConnected) continue;
      const st = getVState(el);
      if (st.rect && st._rectRev === __vscLayoutRev) continue;
      st.rect = el.getBoundingClientRect(); st._rectRev = __vscLayoutRev;
    }
  }

  /* ── Reconcile Video Effects ─────────────────────────────────── */
  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget, storeRef }) {
    const candidates = scratch; candidates.clear();
    const isApplyAll = !!storeRef?.get('app.applyAll');
    const addIfConnected = (v) => { if (v?.isConnected && !candidates.has(v)) candidates.add(v); };

    for (const v of applySet) addIfConnected(v);
    if (activeTarget) addIfConnected(activeTarget);
    for (const v of dirtyVideos) addIfConnected(v);
    if (TOUCHED.videos.size > 0) for (const v of TOUCHED.videos) addIfConnected(v);
    if (TOUCHED.rateVideos.size > 0) for (const v of TOUCHED.rateVideos) addIfConnected(v);

    if (candidates.size > 3) batchReadRects(candidates);

    for (const el of candidates) {
      if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); const st = getVState(el); if (st) st.desiredRate = undefined; continue; }
      bindVideoOnce(el, ApplyReq, storeRef);
      const st = getVState(el);
      const shouldApply = applySet.has(el) || el === activeTarget || isApplyAll;
      if (!shouldApply) {
        if (!st.applied && st.desiredRate === undefined) continue;
        Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el);
        continue;
      }
      const params = getParamsForVideo(el);
      Adapter.apply(el, params.video, params.shadow);
      TOUCHED.videos.add(el);
      if (pbActive) applyPlaybackRate(el, desiredRate);
      else if (st.desiredRate !== undefined) { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
    }
  }

  /* ── Resolution-Aware Sharpening Multiplier ──────────────────── */
  function computeResolutionSharpMul(video) {
    const nW = video.videoWidth || 0, nH = video.videoHeight || 0, dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0, dpr = Math.max(1, window.devicePixelRatio || 1);
    if (nW < 16 || dW < 16) return 0.0;
    const ratio = Math.max((dW * dpr) / nW, (dH * dpr) / Math.max(1, nH));
    let mul = 1.0;
    if (ratio < 0.5) mul = 0.25; else if (ratio < 1.0) mul = 0.25 + (ratio - 0.5) * (0.85 - 0.25) / 0.5;
    else if (ratio <= 1.5) mul = 1.0; else if (ratio <= 2.5) mul = 1.0 + (ratio - 1.5) * 0.20;
    else mul = Math.max(0.45, 1.20 - (ratio - 2.5) * 0.20);
    if (nW <= 640 && nH <= 480) mul *= 0.40; else if (nW <= 960) mul *= 0.65;
    if (CONFIG.IS_MOBILE) mul *= VSC_CLAMP(1.05 / dpr, 0.55, 0.85); else if (dpr >= 1.25) mul *= VSC_CLAMP(1.5 / dpr, 0.75, 1.0);
    return VSC_CLAMP(mul, 0.0, 0.85);
  }

  /* ── Static Budget & Params Memo ─────────────────────────────── */
  const StaticBudget = Object.freeze({ mode: 'high', sharpMul: 1.00, shadowCap: 3, sigmaMul: 1.00, useSvgFilter: true });

  function createVideoParamsMemo() {
    const _cache = new WeakMap();
    return {
      get(vfUser, video, budget) {
        const dW = video?.clientWidth || video?.offsetWidth || 0;
        const cacheKey = `${vfUser.presetS}|${vfUser.brightLevel}|${vfUser.shadowBandMask}|${vfUser.temp}`;
        if (video) { const prev = _cache.get(video); if (prev && prev.key === cacheKey) return prev.result; }

        const detailP = CONFIG.PRESETS.detail[vfUser.presetS || 'off'];
        const brightP = CONFIG.PRESETS.bright[VSC_CLAMP(vfUser.brightLevel || 0, 0, 5)] || CONFIG.PRESETS.bright[0];
        const finalSharpMul = (video ? computeResolutionSharpMul(video) : 0.0) * budget.sharpMul;
        const finalSigmaScale = (video ? Math.sqrt(Math.max(640, Math.min(3840, dW)) / 1920) : 1.0);

        const videoOut = {
          sharp: Math.round((detailP.sharpAdd || 0) * finalSharpMul),
          sharp2: Math.round((detailP.sharp2Add || 0) * finalSharpMul),
          satF: detailP.sat || 1.0, gamma: brightP.gammaF || 1.0, bright: brightP.brightAdd || 0,
          contrast: 1.0, temp: vfUser.temp || 0,
          _sigmaScale: finalSigmaScale * budget.sigmaMul, _refW: Math.max(640, Math.min(3840, dW)),
          _microBase: detailP.microBase || 0.20, _microScale: detailP.microScale || (1/120),
          _fineBase: detailP.fineBase || 0.34, _fineScale: detailP.fineScale || (1/24),
          _microAmt: detailP.microAmt || [0.55, 0.10], _fineAmt: detailP.fineAmt || [0.22, 0.78]
        };
        const shadowLevel = Math.min(VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0, budget.shadowCap);
        const shadowOut = { level: shadowLevel, active: shadowLevel > 0, factor: 1.0 };
        const result = { video: videoOut, shadow: shadowOut, budget };
        if (video) _cache.set(video, { key: cacheKey, result });
        return result;
      }
    };
  }

  /* ── Toast ───────────────────────────────────────────────────── */
  function showToast(text) {
    const v = __vscNs.App?.getActiveVideo();
    const target = v?.parentNode?.isConnected ? v.parentNode : (document.body || document.documentElement);
    if (!target) return;
    let t = target.querySelector('.vsc-toast');
    if (!t) {
      t = document.createElement('div'); t.className = 'vsc-toast';
      t.style.cssText = 'position:absolute;bottom:15%;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.82);color:#fff;padding:8px 18px;border-radius:20px;font:600 13.5px/1.3 system-ui,sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.2s ease-in-out;backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,0.15);white-space:pre-line;letter-spacing:-0.3px;';
      if (target !== document.body && getComputedStyle(target).position === 'static') target.style.position = 'relative';
      target.appendChild(t);
    }
    t.textContent = text; t.style.opacity = '1';
    clearTimeout(t._tid); t._tid = setTimeout(() => { if (t) t.style.opacity = '0'; }, 1500);
  }
  __vscNs.showToast = showToast;

  /* ── A-B Loop Feature ────────────────────────────────────────── */
  function createABLoopFeature() {
    let a = null, b = null;
    return defineFeature({
      name: 'abLoop', phase: PHASE.PROCESS,
      onUpdate(ctx) { if (a !== null && b !== null && ctx.target) { if (ctx.target.currentTime >= b || ctx.target.currentTime < a - 0.5) ctx.target.currentTime = a; } },
      methods: {
        toggle() {
          const v = this.getActiveVideo(); if (!v) return;
          if (a === null) { a = v.currentTime; showToast(`반복 시작점(A): ${a.toFixed(1)}s`); }
          else if (b === null) { b = v.currentTime; if (b <= a) { const tmp = a; a = b; b = tmp; } showToast(`A-B 구간 반복: ${a.toFixed(1)}s ↔ ${b.toFixed(1)}s`); }
          else { a = b = null; showToast('구간 반복 해제'); }
        }
      }
    });
  }

  /* ── Pipeline Feature ────────────────────────────────────────── */
  function createPipelineFeature(Store, Registry, Adapter, ApplyReq, Targeting, videoParamsMemo) {
    const _applySet = new Set(), _scratchCandidates = new Set();
    return defineFeature({
      name: 'pipeline', phase: PHASE.COMPUTE,
      onUpdate(ctx) {
        const { active, target, vidsDirty, pbActive, isApplyAll, desiredRate } = ctx;
        if (!active) {
          TOUCHED.videos.forEach(v => { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); });
          TOUCHED.rateVideos.forEach(v => { getVState(v).desiredRate = undefined; restoreRateOne(v); });
          TOUCHED.videos.clear(); TOUCHED.rateVideos.clear(); return;
        }
        const vf0 = Store.getCatRef('video');
        const getParamsForVideo = (el) => videoParamsMemo.get(vf0, el, StaticBudget);
        _applySet.clear();
        if (isApplyAll) for (const v of Registry.visible.videos) _applySet.add(v);
        if (target) _applySet.add(target);

        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, getParamsForVideo, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates, activeTarget: target, storeRef: Store });
      },
      onDestroy() {
        TOUCHED.videos.forEach(v => safe(() => Adapter.clear(v)));
        TOUCHED.rateVideos.forEach(v => safe(() => restoreRateOne(v)));
        TOUCHED.videos.clear(); TOUCHED.rateVideos.clear();
      }
    });
  }

  /* ── Seek Helper ─────────────────────────────────────────────── */
  function seekVideo(video, offset) {
    const sr = video.seekable; let minT = 0, maxT = video.duration;
    const isLive = !Number.isFinite(maxT);
    if (isLive) { if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); }
    const safeEnd = maxT - (isLive ? 2.0 : 0.1);
    const target = VSC_CLAMP(video.currentTime + offset, minT, safeEnd);
    try { video.currentTime = target; } catch (_) {}
  }
  function execVideoAction(action, val) { const v = __vscNs.App?.getActiveVideo(); if (!v) return; if (action === 'play') v.play().catch(() => {}); else if (action === 'pause') v.pause(); else if (action === 'seek') seekVideo(v, val); }

  /* ── SVG Filter Engine (Hybrid) ──────────────────────────────── */
  function createFiltersVideoOnly(Utils, config) {
    const { h } = Utils;
    const _cssFilterCache = new WeakMap(), urlCache = new WeakMap(), ctxMap = new WeakMap(), __vscBgMemo = new WeakMap();

    function buildCssFilterString(s) {
      const parts = [];
      const gamma = s.gamma || 1, brightAdd = s.bright || 0;
      let bf = 1.0;
      if (Math.abs(brightAdd) > 0.5) bf *= (1.0 + brightAdd / 250);
      if (Math.abs(gamma - 1.0) > 0.01) bf *= Math.pow(gamma, 0.5);
      if (Math.abs(bf - 1.0) > 0.001) parts.push(`brightness(${bf.toFixed(4)})`);

      let cf = s.contrast || 1;
      if (Math.abs(gamma - 1.0) > 0.01) cf *= (1 + (gamma - 1) * 0.15);
      if (Math.abs(cf - 1.0) > 0.005) parts.push(`contrast(${cf.toFixed(4)})`);

      const sat = s.satF ?? 1;
      if (Math.abs(sat - 1.0) > 0.005) parts.push(`saturate(${sat.toFixed(3)})`);

      const temp = s.temp || 0;
      if (Math.abs(temp) > 1) {
        const hueShift = temp * -0.3;
        const sepiaAmount = temp > 0 ? Math.min(temp / 100, 0.15) : 0;
        if (sepiaAmount > 0.01) parts.push(`sepia(${sepiaAmount.toFixed(3)})`);
        if (Math.abs(hueShift) > 0.5) parts.push(`hue-rotate(${hueShift.toFixed(1)}deg)`);
      }
      return parts.join(' ');
    }

    function needsSvgFilter(s, shadowParams) { return (s.sharp | 0) > 0 || (s.sharp2 | 0) > 0 || (shadowParams && shadowParams.active); }

    function applyCssNative(el, s) {
      const filterStr = buildCssFilterString(s); const st = getVState(el);
      if (_cssFilterCache.get(el) === filterStr) return;
      if (!filterStr) {
        if (st.applied) {
          if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else el.style.removeProperty('filter');
          if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || ''); else el.style.removeProperty('-webkit-filter');
          st.applied = false; st.lastFilterUrl = null;
        }
        _cssFilterCache.set(el, ''); return;
      }
      if (!st.applied) { st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || ''; st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || ''; }
      el.style.setProperty('filter', filterStr, 'important'); el.style.setProperty('-webkit-filter', filterStr, 'important');
      st.applied = true; st.lastFilterUrl = filterStr; _cssFilterCache.set(el, filterStr);
    }

    function ensureOpaqueBg(video) {
      if (!video || __vscBgMemo.has(video) || !FLAGS.FILTER_FORCE_OPAQUE_BG) return;
      try { const cs = getComputedStyle(video).backgroundColor; const isTransparent = !cs || cs === 'transparent' || cs.endsWith(', 0)') || cs.endsWith(',0)');
        if (isTransparent) { __vscBgMemo.set(video, video.style.backgroundColor || ''); video.style.backgroundColor = '#000'; } else { __vscBgMemo.set(video, null); }
      } catch (_) {}
    }
    function restoreOpaqueBg(video) { if (!video) return; const prev = __vscBgMemo.get(video); if (prev === undefined) return; __vscBgMemo.delete(video); if (prev !== null) video.style.backgroundColor = prev; }

    function buildSvg(root) {
      const fidMain = `vsc-main-${config.VSC_ID}`;
      const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const mkFuncRGB = (attrs) => [h('feFuncR', { ns: 'svg', ...attrs }), h('feFuncG', { ns: 'svg', ...attrs }), h('feFuncB', { ns: 'svg', ...attrs })];
      const mainFilter = h('filter', { ns: 'svg', id: fidMain, 'color-interpolation-filters': 'sRGB', x: '-8%', y: '-8%', width: '116%', height: '116%' });

      const bgFuncs = mkFuncRGB({ type: 'gamma', amplitude: '1', exponent: '1', offset: '0' });
      const bgXfer = h('feComponentTransfer', { ns: 'svg', in: 'SourceGraphic', result: 'bg' }, ...bgFuncs);

      const blurMicro = h('feGaussianBlur', { ns: 'svg', in: 'bg', stdDeviation: '0.22', result: 'bMicro' });
      const usmMicro = h('feComposite', { ns: 'svg', in: 'bg', in2: 'bMicro', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpMicro' });
      const blurFine = h('feGaussianBlur', { ns: 'svg', in: 'bg', stdDeviation: '0.60', result: 'bFine' });
      const usmFine = h('feComposite', { ns: 'svg', in: 'bg', in2: 'bFine', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpFine' });
      const blend = h('feComposite', { ns: 'svg', in: 'sharpMicro', in2: 'sharpFine', operator: 'arithmetic', k1: '0', k2: '0.55', k3: '0.45', k4: '0', result: 'sharpOut' });

      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' });
      const shadowToneXfer = h('feComponentTransfer', { ns: 'svg', in: 'sharpOut', result: 'shadow' }, ...shadowToneFuncs);
      const satNode = h('feColorMatrix', { ns: 'svg', in: 'shadow', type: 'saturate', values: '1', result: 'final' });

      mainFilter.append(bgXfer, blurMicro, usmMicro, blurFine, usmFine, blend, shadowToneXfer, satNode);
      defs.append(mainFilter);

      const tryAppend = () => { const tgt = root.body || root.documentElement || root; if (tgt?.appendChild) { tgt.appendChild(svg); return true; } return false; };
      if (!tryAppend()) {
        let _fallbackMoId = 0; const mo = new MutationObserver(() => { if (tryAppend()) { mo.disconnect(); clearTimeout(_fallbackMoId); } });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        _fallbackMoId = setTimeout(() => mo.disconnect(), 5000); if (__vscNs._timers) __vscNs._timers.push(_fallbackMoId);
      }
      return { fidMain, sharp: { blurMicro, usmMicro, blurFine, usmFine, blend }, color: { bgFuncs, shadowToneFuncs, sats: [satNode] }, st: { lastKey: '', rev: 0, bgKey: '', satKey: '', blurKey: '', sharpKey: '', shadowKey: '' } };
    }

    function updateSharpNodes(nodes, st, s, sharpTotal) {
      if (sharpTotal > 0) {
        const qSharp = Math.max(0, Math.round(Number(s.sharp || 0))), qSharp2 = Math.max(0, Math.round(Number(s.sharp2 || 0))), sigmaScale = Number(s._sigmaScale) || 1.0;
        const microBase = Number(s._microBase) || 0.18, microScale = Number(s._microScale) || (1/120), fineBase = Number(s._fineBase) || 0.32, fineScale = Number(s._fineScale) || (1/24);
        const microAmtCoeffs = s._microAmt || [0.55, 0.10], fineAmtCoeffs = s._fineAmt || [0.20, 0.85];
        const sigMicro = VSC_CLAMP((microBase + qSharp * microScale) * Math.min(1.0, sigmaScale), 0.30, 1.20);
        const sigFine = VSC_CLAMP((fineBase + qSharp2 * fineScale) * sigmaScale, 0.18, 2.50);
        const microAmt = VSC_CLAMP((qSharp * microAmtCoeffs[0] + qSharp2 * microAmtCoeffs[1]) / 45, 0, 1.5), fineAmt = VSC_CLAMP((qSharp * fineAmtCoeffs[0] + qSharp2 * fineAmtCoeffs[1]) / 24, 0, 1.2);
        const totalAmt = microAmt + fineAmt + 1e-6, microWeight = VSC_CLAMP(0.35 + 0.30 * (microAmt / totalAmt), 0.25, 0.70), fineWeight = 1.0 - microWeight;
        const blurKeyNext = `${sigMicro.toFixed(3)}|${sigFine.toFixed(3)}`;
        if (st.blurKey !== blurKeyNext) { st.blurKey = blurKeyNext; nodes.sharp.blurMicro.setAttribute('stdDeviation', sigMicro.toFixed(3)); nodes.sharp.blurFine.setAttribute('stdDeviation', sigFine.toFixed(3)); }
        const sharpKeyNext = `${microAmt.toFixed(5)}|${fineAmt.toFixed(5)}`;
        if (st.sharpKey !== sharpKeyNext) { st.sharpKey = sharpKeyNext; nodes.sharp.usmMicro.setAttribute('k2', (1 + microAmt).toFixed(5)); nodes.sharp.usmMicro.setAttribute('k3', (-microAmt).toFixed(5)); nodes.sharp.usmFine.setAttribute('k2', (1 + fineAmt).toFixed(5)); nodes.sharp.usmFine.setAttribute('k3', (-fineAmt).toFixed(5)); nodes.sharp.blend.setAttribute('k2', microWeight.toFixed(4)); nodes.sharp.blend.setAttribute('k3', fineWeight.toFixed(4)); }
      } else {
        const bypassKey = 'bypass';
        if (st.sharpKey !== bypassKey) { st.sharpKey = bypassKey; st.blurKey = bypassKey; nodes.sharp.blurMicro.setAttribute('stdDeviation', '0'); nodes.sharp.blurFine.setAttribute('stdDeviation', '0'); nodes.sharp.usmMicro.setAttribute('k2', 1); nodes.sharp.usmMicro.setAttribute('k3', 0); nodes.sharp.usmFine.setAttribute('k2', 1); nodes.sharp.usmFine.setAttribute('k3', 0); nodes.sharp.blend.setAttribute('k2', 1); nodes.sharp.blend.setAttribute('k3', 0); }
      }
    }

    function updateColorNodes(nodes, st, s, shadowParams) {
      const brightOffset = VSC_CLAMP((s.bright || 0) / 250, -0.5, 0.5), gammaExp = 1 / VSC_CLAMP(s.gamma || 1, 0.1, 5.0);
      const bgKey = `${gammaExp.toFixed(4)}|${brightOffset.toFixed(4)}`;
      if (st.bgKey !== bgKey) { st.bgKey = bgKey; for (const fn of nodes.color.bgFuncs) { fn.setAttribute('exponent', parseFloat(gammaExp.toFixed(4))); fn.setAttribute('offset', parseFloat(brightOffset.toFixed(4))); } }

      if (shadowParams && shadowParams.active) {
        const level = shadowParams.level || 0, factor = shadowParams.factor !== undefined ? shadowParams.factor : 1.0;
        const shadowKey = `crush_v4|${level}|${factor.toFixed(3)}`;
        if (st.shadowKey !== shadowKey) { st.shadowKey = shadowKey; for (const fn of nodes.color.shadowToneFuncs) fn.setAttribute('tableValues', '0 0.05 0.15 0.3 0.5 0.75 1'); }
      } else {
        const neutralKey = 'shadow_off';
        if (st.shadowKey !== neutralKey) { st.shadowKey = neutralKey; for (const fn of nodes.color.shadowToneFuncs) fn.setAttribute('tableValues', '0 1'); }
      }

      const satVal = VSC_CLAMP(s.satF ?? 1, 0, 5.0).toFixed(2);
      if (st.satKey !== satVal) { st.satKey = satVal; for (const satNode of nodes.color.sats) satNode.setAttribute('values', parseFloat(satVal)); }
    }

    function prepare(video, s, shadowParams) {
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
      let dc = urlCache.get(root); if (!dc) { dc = { key: '', url: '' }; urlCache.set(root, dc); }
      ensureOpaqueBg(video);
      const sharpTotal = Math.round(Number(s.sharp || 0)) + Math.round(Number(s.sharp2 || 0)), shadowActive = !!(shadowParams && shadowParams.active);
      const stableKey = `u|${s.sharp}|${s.sharp2}|${(s.gamma||1).toFixed(3)}|${(s.bright||0).toFixed(1)}|${(s.satF??1).toFixed(2)}|sh:${shadowActive ? 'lv' + shadowParams.level : 'off'}`;
      let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }
      const needReapply = (dc.key !== stableKey);
      if (nodes.st.lastKey !== stableKey) { nodes.st.lastKey = stableKey; nodes.st.rev = (nodes.st.rev + 1) | 0; updateSharpNodes(nodes, nodes.st, s, sharpTotal); updateColorNodes(nodes, nodes.st, s, shadowParams); }
      const combinedUrl = `url(#${nodes.fidMain})`; dc.key = stableKey; dc.url = combinedUrl;
      return { url: combinedUrl, changed: needReapply, rev: nodes.st.rev };
    }

    return {
      invalidateCache: (video) => { try { const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document); const nodes = ctxMap.get(root); if (nodes) { nodes.st.lastKey = ''; nodes.st.blurKey = ''; nodes.st.sharpKey = ''; nodes.st.shadowKey = ''; nodes.st.rev = (nodes.st.rev + 1) | 0; nodes.st.bgKey = ''; nodes.st.satKey = ''; } const dc = urlCache.get(root); if (dc) { dc.key = ''; dc.url = ''; } } catch (_) {} },
      prepareCached: (video, s, shadowParams) => { try { return prepare(video, s, shadowParams || null); } catch (e) { return { url: null, changed: false, rev: -1 }; } },
      applyUrl: (el, urlObj) => {
        if (!el) return; const url = typeof urlObj === 'string' ? urlObj : urlObj?.url; const st = getVState(el);
        if (!url) { restoreOpaqueBg(el); if (st.applied) { if (st.origFilter != null && st.origFilter !== '') el.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else el.style.removeProperty('filter'); if (st.origWebkitFilter != null && st.origWebkitFilter !== '') el.style.setProperty('-webkit-filter', st.origWebkitFilter, st.origWebkitFilterPrio || ''); else el.style.removeProperty('-webkit-filter'); st.applied = false; st.lastFilterUrl = null; st.origFilter = st.origWebkitFilter = null; st.origFilterPrio = st.origWebkitFilterPrio = ''; } return; }
        if (!st.applied) { st.origFilter = el.style.getPropertyValue('filter'); st.origFilterPrio = el.style.getPropertyPriority('filter') || ''; st.origWebkitFilter = el.style.getPropertyValue('-webkit-filter'); st.origWebkitFilterPrio = el.style.getPropertyPriority('-webkit-filter') || ''; }
        if (st.lastFilterUrl !== url) { el.style.setProperty('filter', url, 'important'); el.style.setProperty('-webkit-filter', url, 'important'); }
        st.applied = true; st.lastFilterUrl = url;
      },
      needsSvgFilter, applyCssNative
    };
  }

  /* ── Backend Adapter (Hybrid) ────────────────────────────────── */
  function createBackendAdapter(Filters) {
    return {
      apply(video, vVals, shadowParams) {
        const st = getVState(video);
        if (Filters.needsSvgFilter(vVals, shadowParams)) {
          Filters.applyUrl(video, Filters.prepareCached(video, vVals, shadowParams));
        } else {
          if (st.applied && st.lastFilterUrl && st.lastFilterUrl.includes('url(')) Filters.applyUrl(video, null);
          Filters.applyCssNative(video, vVals);
        }
      },
      clear(video) { const st = getVState(video); if (st.applied) Filters.applyUrl(video, null); }
    };
  }

  /* ── Element Drag Helper ─────────────────────────────────────── */
  function bindElementDrag(el, onMove, onEnd) {
    const ac = new AbortController();
    on(el, 'pointermove', (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); }, { passive: false, signal: ac.signal });
    const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); };
    on(el, 'pointerup', up, { signal: ac.signal }); on(el, 'pointercancel', up, { signal: ac.signal });
    return () => ac.abort();
  }

  /* ── UI Builder (Simplified) ─────────────────────────────────── */
  function createUI(sm, registry, ApplyReq, Utils, P, Bus) {
    const { h } = Utils;
    let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null, hasUserDraggedUI = false;
    const uiWakeCtrl = new AbortController(), uiUnsubs = [];
    const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };

    const detachNodesHard = () => { removeSafe(container); removeSafe(gearHost); };
    const allowUiInThisDoc = () => { const hn = location.hostname, pn = location.pathname; if (hn.includes('netflix.com')) return pn.startsWith('/watch'); if (hn.includes('coupangplay.com')) return pn.startsWith('/play'); return true; };
    const getUiRoot = () => { const fs = document.fullscreenElement; return fs ? (fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement || document.body) : fs) : (document.body || document.documentElement); };
    const setAndHint = (path, value) => { if (!Object.is(sm.get(path), value)) { sm.set(path, value); (path === P.APP_ACT || path === P.APP_APPLY_ALL || path.startsWith('video.')) ? ApplyReq.hard() : ApplyReq.soft(); } };

    function bindReactive(btn, paths, apply) {
      const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false, destroyed = false;
      const sync = () => { if (pending || destroyed) return; pending = true; queueMicrotask(() => { pending = false; if (!destroyed && btn?.isConnected !== false) apply(btn, ...pathArr.map(p => sm.get(p))); }); };
      pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p)));
      return sync;
    }

    function bindActGate(btn, extraPaths, applyFn) {
      return bindReactive(btn, [...(Array.isArray(extraPaths) ? extraPaths : []), P.APP_ACT], (el, ...vals) => {
        const act = vals[vals.length - 1]; el.style.opacity = act ? '1' : '0.45'; el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act;
        if (applyFn) applyFn(el, ...vals);
      });
    }

    const guardedClick = (fn) => (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; fn(e); };

    function renderButtonRow({ label, items, key, offValue = null, toggleActiveToOff = false }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px;width:35px;line-height:34px;font-weight:bold' }, label));
      const onChange = (val) => { if (!sm.get(P.APP_ACT)) return; const cur = sm.get(key); if (toggleActiveToOff && offValue !== undefined && cur === val && val !== offValue) setAndHint(key, offValue); else setAndHint(key, val); };
      for (const it of items) {
        const b = h('button', { class: 'pbtn', style: 'flex:1', title: it.title || '' }, it.text); b.onclick = (e) => { e.stopPropagation(); onChange(it.value); };
        bindReactive(b, [key, P.APP_ACT], (el, v, act) => { const isActive = v === it.value; el.classList.toggle('active', isActive); el.style.opacity = act ? '1' : (isActive ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }); row.append(b);
      }
      if (offValue != null) {
        const offBtn = h('button', { class: 'pbtn', style: 'flex:0.9' }, 'OFF'); offBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(key, offValue); };
        bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => { const isOff = v === offValue; el.classList.toggle('active', isOff); el.style.opacity = act ? '1' : (isOff ? '0.65' : '0.45'); el.style.cursor = act ? 'pointer' : 'not-allowed'; el.disabled = !act; }); row.append(offBtn);
      }
      return row;
    }

    function renderActionRow(defs) {
      const row = h('div', { class: 'prow' });
      for (const def of defs) {
        const btn = h('button', { class: 'btn', style: `flex:${def.flex || 1}` }, def.text);
        if (def.guard !== false) btn.onclick = guardedClick(def.click); else btn.onclick = (e) => { e.stopPropagation(); def.click(e); };
        if (def.bindPaths) {
          const allPaths = [...def.bindPaths]; if (def.guard !== false && !allPaths.includes(P.APP_ACT)) allPaths.push(P.APP_ACT);
          if (def.guard !== false) { bindActGate(btn, def.bindPaths, def.render ? (el, ...vals) => def.render(el, ...vals) : undefined); } else { bindReactive(btn, allPaths, def.render || (() => {})); }
        } else if (def.guard !== false) bindActGate(btn, []);
        row.append(btn);
      }
      return row;
    }

    const clampPanelIntoViewport = () => {
      try {
        const mainPanel = container?.shadowRoot?.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI) { mainPanel.style.removeProperty('left'); mainPanel.style.removeProperty('transform'); mainPanel.style.right = 'var(--vsc-safe-right)'; mainPanel.style.top = 'calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2))'; mainPanel.style.display = 'block'; queueMicrotask(() => { const r = mainPanel.getBoundingClientRect(); if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) { mainPanel.style.right = '70px'; mainPanel.style.top = '50%'; } }); return; }
        const r = mainPanel.getBoundingClientRect(), vv = window.visualViewport, vw = vv?.width || window.innerWidth || 0, vh = vv?.height || window.innerHeight || 0, offL = vv?.offsetLeft || 0, offT = vv?.offsetTop || 0;
        if (!vw || !vh) return;
        const left = VSC_CLAMP(r.left, offL + 8, Math.max(offL + 8, offL + vw - (r.width || 300) - 8)), top = VSC_CLAMP(r.top, offT + 8, Math.max(offT + 8, offT + vh - (r.height || 400) - 8));
        if (Math.abs(r.left - left) < 1 && Math.abs(r.top - top) < 1) return;
        mainPanel.style.right = 'auto'; mainPanel.style.transform = 'none'; mainPanel.style.left = `${left}px`; mainPanel.style.top = `${top}px`;
      } catch (_) {}
    };

    const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root) return; if (!vv) { root.style.setProperty('--vsc-vv-top', '0px'); root.style.setProperty('--vsc-vv-h', `${window.innerHeight}px`); return; } root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
    syncVVVars();

    let _clampRafId = 0;
    const onLayoutChange = () => { if (_clampRafId) return; _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); }); };
    const uiSig = combineSignals(uiWakeCtrl.signal, __globalSig);
    try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); } } catch (_) {}
    on(window, 'resize', onLayoutChange, { passive: true, signal: uiSig }); on(window, 'orientationchange', onLayoutChange, { passive: true, signal: uiSig });
    on(document, 'fullscreenchange', () => {
      const isFs = !!document.fullscreenElement;
      if (isFs) { if (container) container._prevUiState = sm.get(P.APP_UI); if (sm.get(P.APP_UI)) sm.set(P.APP_UI, false); } else { if (container?._prevUiState) { sm.set(P.APP_UI, true); container._prevUiState = false; } }
      setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100);
    }, { passive: true, signal: uiSig });

    const getMainPanel = () => container?.shadowRoot?.querySelector('.main');
    function attachShadowStyles(shadowRoot, cssText) { try { if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') { const sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]; return; } } catch (_) {} const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl); }

    const PANEL_CSS = `@property --vsc-vv-top{syntax:"<length>";inherits:true;initial-value:0px}@property --vsc-vv-h{syntax:"<length>";inherits:true;initial-value:100vh}:host{--bg:rgba(25,25,25,.96);--c:#eee;--b:1px solid #666;--btn-bg:#222;--ac:#3498db;--br:12px;--vsc-safe-right:max(70px,calc(env(safe-area-inset-right,0px) + 70px))}*,*::before,*::after{box-sizing:border-box}.main{position:fixed;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2));right:var(--vsc-safe-right);transform:translateY(-50%);width:min(320px,calc(100vw - 24px));background:var(--bg);backdrop-filter:blur(12px);color:var(--c);padding:15px;border-radius:16px;z-index:2147483647;border:1px solid #555;font-family:sans-serif;box-shadow:0 12px 48px rgba(0,0,0,.7);overflow-y:auto;max-height:95vh;-webkit-overflow-scrolling:touch;display:none}.main.visible{display:block}@media(max-width:520px){.main{top:50%!important;right:var(--vsc-safe-right)!important;left:auto!important;transform:translateY(-50%)!important;width:260px!important;max-height:70vh!important;padding:10px;border-radius:12px}.main::-webkit-scrollbar{width:3px}.main::-webkit-scrollbar-thumb{background:#666;border-radius:10px}.prow{gap:3px;flex-wrap:nowrap;justify-content:center}.btn,.pbtn{min-height:34px;font-size:10.5px;padding:4px 1px;letter-spacing:-0.8px;white-space:nowrap}.header{font-size:12px;padding-bottom:5px}}.header{display:flex;justify-content:center;margin-bottom:12px;cursor:move;border-bottom:2px solid #444;padding-bottom:8px;font-size:14px;font-weight:700}.row{display:flex;align-items:center;justify-content:space-between;gap:10px}.btn{flex:1;border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 0;border-radius:var(--br);cursor:pointer;font-weight:700;display:flex;align-items:center;justify-content:center}.prow{display:flex;gap:6px;align-items:center}.pbtn{border:var(--b);background:var(--btn-bg);color:var(--c);padding:10px 6px;border-radius:var(--br);cursor:pointer;font-weight:700}.btn.active,.pbtn.active{background:var(--btn-bg);border-color:var(--ac);color:var(--ac)}hr{border:0;border-top:1px solid rgba(255,255,255,.14);margin:8px 0}`;
    const GEAR_CSS = `.gear{--size:46px;position:fixed;top:50%;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px));transform:translateY(-50%);width:var(--size);height:var(--size);border-radius:50%;background:rgba(25,25,25,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.18);color:#fff;display:flex;align-items:center;justify-content:center;font:700 22px/1 sans-serif;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 12px 44px rgba(0,0,0,.55);user-select:none;transition:transform .12s ease,opacity .3s ease;opacity:1;-webkit-tap-highlight-color:transparent}.gear.open{outline:2px solid rgba(52,152,219,.85);opacity:1!important}.gear.inactive{opacity:.45}`;

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${CONFIG.VSC_ID}`, 'data-vsc-ui': '1', 'data-vsc-id': CONFIG.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, PANEL_CSS);
      const dragHandle = h('div', { class: 'header', title: '더블클릭 시 톱니바퀴 옆으로 복귀' }, 'VSC 렌더링 제어');

      const sharpRow = renderButtonRow({ label: '선명', key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: [{ text: 'Soft', value: 'Soft' }, { text: 'Med', value: 'Medium' }, { text: 'Ultra', value: 'Ultra' }, { text: 'MST', value: 'Master' }] });
      const brightRow = renderButtonRow({ label: '밝기', key: P.V_BRIGHT_LV, offValue: 0, toggleActiveToOff: true, items: [{ text: '1', value: 1 }, { text: '2', value: 2 }, { text: '3', value: 3 }, { text: '4', value: 4 }, { text: '5', value: 5 }] });

      const toolRow = renderActionRow([
        { text: '\uD83D\uDD0D 줌', flex: 1, bindPaths: [P.APP_ZOOM_EN], render: (el, v) => el.classList.toggle('active', !!v), click: () => { const zm = __vscNs.ZoomManager, v = __vscNs.App?.getActiveVideo(); if (!zm || !v) return; if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); } } },
        { text: '\u26A1 Power', flex: 1, guard: false, bindPaths: [P.APP_ACT], render: (el, v) => { el.style.color = v ? '#2ecc71' : '#e74c3c'; el.classList.toggle('active', !!v); }, click: () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)) }
      ]);

      const boostBtn = h('button', { class: 'btn', style: 'flex:3;font-weight:800;' }, '\uD83D\uDD0A Audio (Mastering)');
      boostBtn.onclick = guardedClick(() => { __vscNs.AudioWarmup?.(); setAndHint(P.A_EN, !sm.get(P.A_EN)); ApplyReq.soft(); });
      bindActGate(boostBtn, [P.A_EN], (el, aEn) => { el.classList.toggle('active', !!aEn); el.style.color = aEn ? 'var(--ac)' : '#eee'; });

      const advToggleBtn = h('button', { class: 'btn', style: 'width:100%;margin-bottom:6px;background:#2c3e50;border-color:#34495e;' }, '\u25BC 고급 설정 열기');
      advToggleBtn.onclick = (e) => { e.stopPropagation(); setAndHint(P.APP_ADV, !sm.get(P.APP_ADV)); };
      bindReactive(advToggleBtn, [P.APP_ADV], (el, v) => { el.textContent = v ? '\u25B2 고급 설정 닫기' : '\u25BC 고급 설정 열기'; el.style.background = v ? '#34495e' : '#2c3e50'; });

      const boostRow = renderButtonRow({ label: '음량', key: P.A_BST, offValue: 0, toggleActiveToOff: true, items: [{ text: '+3', value: 3 }, { text: '+6', value: 6 }, { text: '+9', value: 9 }, { text: '+12', value: 12 }] });
      bindReactive(boostRow, [P.A_EN, P.APP_ACT], (el, aEn, act) => { const on = act && aEn; el.style.opacity = on ? '1' : '0.45'; el.style.pointerEvents = on ? 'auto' : 'none'; });

      const advContainer = h('div', { style: 'display:none;flex-direction:column;gap:0px;' }, [
        boostRow,
        renderButtonRow({ label: '암부', key: P.V_SHADOW_MASK, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: CONFIG.DARK_BAND.LV1 }, { text: '2단', value: CONFIG.DARK_BAND.LV2 }, { text: '3단', value: CONFIG.DARK_BAND.LV3 }] }),
        renderButtonRow({ label: '색온', key: P.V_TEMP, offValue: 0, toggleActiveToOff: true, items: [{ text: '보호', value: 35 }, { text: '따뜻', value: 18 }, { text: '맑음', value: -15 }, { text: '냉색', value: -30 }] }),
        h('hr'), renderButtonRow({ label: '시계', key: P.APP_TIME_EN, offValue: false, toggleActiveToOff: true, items: [{ text: '표시 (전체화면)', value: true }] }),
        renderButtonRow({ label: '위치', key: P.APP_TIME_POS, items: [{ text: '좌', value: 0 }, { text: '중', value: 1 }, { text: '우', value: 2 }] })
      ]);
      bindReactive(advContainer, [P.APP_ADV], (el, v) => el.style.display = v ? 'flex' : 'none');

      const resetBtn = h('button', { class: 'btn' }, '\u21BA 리셋');
      resetBtn.onclick = guardedClick(() => { sm.batch('video', CONFIG.DEFAULTS.video); sm.batch('audio', CONFIG.DEFAULTS.audio); sm.batch('playback', CONFIG.DEFAULTS.playback); ApplyReq.hard(); });
      bindActGate(resetBtn, []);

      const rateAdjustRow = h('div', { class: 'prow', style: 'justify-content:center;gap:4px;margin-top:2px;' }, [
        (() => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:32px;font-size:12px;' }, '- 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.max(0.1, Math.round((cur - 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); bindActGate(b, []); return b; })(),
        (() => { const lbl = h('div', { style: 'flex:2;text-align:center;font-size:13px;font-weight:bold;line-height:32px;' }, '1.00x'); bindReactive(lbl, [P.PB_RATE, P.PB_EN], (el, rate, en) => { const r = Number(rate) || 1.0; el.textContent = en ? `${r.toFixed(2)}x` : '1.00x'; el.style.color = en && Math.abs(r - 1.0) > 0.01 ? 'var(--ac)' : '#eee'; }); return lbl; })(),
        (() => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:32px;font-size:12px;' }, '+ 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.min(16, Math.round((cur + 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); bindActGate(b, []); return b; })(),
        (() => { const b = h('button', { class: 'pbtn', style: 'flex:0.8;min-height:32px;font-size:11px;' }, 'OFF'); b.onclick = guardedClick(() => { sm.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); }); bindActGate(b, [P.PB_EN], (el, en) => el.classList.toggle('active', !en)); return b; })()
      ]);

      const bodyMain = h('div', { id: 'p-main' }, [
        sharpRow, brightRow, toolRow,
        h('div', { class: 'prow', style: 'margin-top:4px;' }, [boostBtn]),
        h('div', { class: 'prow', style: 'margin-top:8px;' }, [h('button', { class: 'btn', style: 'background:#333;', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '\u2715 닫기'), resetBtn]),
        advToggleBtn, advContainer, h('hr'),
        h('div', { class: 'prow', style: 'justify-content:center;gap:4px;flex-wrap:wrap;' }, [0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:36px;' }, s + 'x'); b.onclick = guardedClick(() => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }); bindActGate(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01)); return b; })),
        rateAdjustRow,
        h('div', { class: 'prow', style: 'justify-content:center;gap:2px;margin-top:4px;' }, [{ text: '\u25C0 30s', action: 'seek', val: -30 }, { text: '\u25C0 15s', action: 'seek', val: -15 }, { text: '\u23F8 정지', action: 'pause' }, { text: '\u25B6 재생', action: 'play' }, { text: '15s \u25B6', action: 'seek', val: 15 }, { text: '30s \u25B6', action: 'seek', val: 30 }].map(cfg => { const b = h('button', { class: 'pbtn', style: 'flex:1;min-height:34px;font-size:11px;padding:0 2px;' }, cfg.text); b.onclick = guardedClick(() => execVideoAction(cfg.action, cfg.val)); bindActGate(b, []); return b; }))
      ]);

      const mainPanel = h('div', { class: 'main' }, [dragHandle, bodyMain]); shadow.append(mainPanel);
      if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);

      let stopDrag = null;
      const startPanelDrag = (e) => {
        if (e.target?.tagName === 'BUTTON') return; if (e.cancelable) e.preventDefault();
        stopDrag?.(); hasUserDraggedUI = true; let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect();
        mainPanel.style.transform = 'none'; mainPanel.style.top = `${rect.top}px`; mainPanel.style.right = 'auto'; mainPanel.style.left = `${rect.left}px`;
        try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(dragHandle, (ev) => { const dx = ev.clientX - startX, dy = ev.clientY - startY, pr = mainPanel.getBoundingClientRect(); mainPanel.style.left = `${Math.max(0, Math.min(window.innerWidth - pr.width, rect.left + dx))}px`; mainPanel.style.top = `${Math.max(0, Math.min(window.innerHeight - pr.height, rect.top + dy))}px`; }, () => { stopDrag = null; });
      };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (gearHost) return; gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;isolation:isolate;' });
      const shadow = gearHost.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, GEAR_CSS);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '\u2699'); shadow.append(gearBtn);
      if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);

      const wake = () => { if (gearBtn) gearBtn.style.opacity = '1'; clearTimeout(fadeTimer); if (!!document.fullscreenElement || CONFIG.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.35'; }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: uiSig }); on(window, 'touchstart', wake, { passive: true, signal: uiSig }); bootWakeTimer = setTimeout(wake, 2000);

      const handleGearDrag = (e) => {
        if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); const startY = e.clientY, rect = gearBtn.getBoundingClientRect();
        try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {}
        stopDrag = bindElementDrag(gearBtn, (ev) => { if (Math.abs(ev.clientY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; } if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) gearBtn.style.top = `${Math.max(0, Math.min(window.innerHeight - gearBtn.offsetHeight, rect.top + (ev.clientY - startY)))}px`; }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
      };
      on(gearBtn, 'pointerdown', handleGearDrag);
      let lastToggle = 0; on(gearBtn, 'pointerup', (e) => { if (e.cancelable) e.preventDefault(); e.stopPropagation?.(); if (dragThresholdMet) return; const now = performance.now(); if (now - lastToggle < 300) return; lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI)); }, { passive: false });
      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); };
      sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc() || (registry.videos.size === 0 && !sm.get(P.APP_UI))) { detachNodesHard(); return; } ensureGear(); const mainPanel = getMainPanel(); if (sm.get(P.APP_UI)) { build(); const mp = getMainPanel(); if (mp && !mp.classList.contains('visible')) { mp.style.display = 'block'; mp.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { if (mainPanel) { mainPanel.classList.remove('visible'); mainPanel.style.display = 'none'; } } mount(); wakeGear?.(); };
    onPageReady(() => { ensure(); ApplyReq.hard(); });
    return { ensure, destroy: () => { uiUnsubs.forEach(u => u()); uiUnsubs.length = 0; uiWakeCtrl.abort(); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); detachNodesHard(); } };
  }

  function createUIFeature(Store, Registry, ApplyReq, Utils, P, Bus) {
    let uiInst = null;
    return defineFeature({ name: 'ui', phase: PHASE.RENDER, onInit() { uiInst = createUI(Store, Registry, ApplyReq, Utils, P, Bus); this.subscribe('video:detected', () => uiInst?.ensure()); }, onUpdate() { uiInst?.ensure(); }, onDestroy() { uiInst?.destroy(); } });
  }

  /* ── Zoom Manager ────────────────────────────────────────────── */
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
        v.style.cssText = st.origStyle + `; will-change: transform !important; contain: paint !important; backface-visibility: hidden !important; transition: ${panning ? 'none' : 'transform 80ms ease-out'} !important; transform-origin: 0 0 !important; transform: translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)}) !important; cursor: ${panning ? 'grabbing' : 'grab'} !important; z-index: 2147483646 !important; position: relative !important;`;
        zoomedVideos.add(v);
      });
    };
    function clampPan(v, st) { const r = v.getBoundingClientRect(); if (!r || r.width <= 1 || r.height <= 1) return; const sw = r.width * st.scale, sh = r.height * st.scale; st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75); st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75); }
    const zoomTo = (v, newScale, cx, cy) => { const st = getSt(v), r = v.getBoundingClientRect(); if (!r || r.width <= 1) return; const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale; st.tx = cx - (r.left - st.tx) - ix * newScale; st.ty = cy - (r.top - st.ty) - iy * newScale; st.scale = newScale; update(v); };
    const resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); };
    const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
    const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

    let unsubAct = null, unsubZoomEn = null;
    if (Store?.sub) {
      const resetAll = () => { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; };
      unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) resetAll(); });
      unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { resetAll(); zoomedVideos.clear(); } });
    }

    function getTargetVideo(e) {
      if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
      const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null);
      if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; }
      return __vscNs.App?.getActiveVideo() || null;
    }

    on(window, 'wheel', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return;
      const v = getTargetVideo(e); if (!v) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
      if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'pointerdown', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale <= 1) return;
      if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty;
      try { v.setPointerCapture?.(e.pointerId); } catch (_) {} update(v);
    }, { capture: true, passive: false, signal: zsig });

    on(window, 'pointermove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const st = getSt(activeVideo); if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e], last = events[events.length - 1] || e;
      const nextTx = last.clientX - startX, nextTy = last.clientY - startY;
      if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
      st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo);
    }, { capture: true, passive: false, signal: zsig });

    function endPointerPan(e) {
      if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
      const v = activeVideo, st = getSt(v); try { v.releasePointerCapture?.(e.pointerId); } catch (_) {}
      if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
      activePointerId = null; isPanning = false; activeVideo = null; update(v);
    }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig }); on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });

    on(window, 'dblclick', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return;
      const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation();
      const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
    }, { capture: true, signal: zsig });

    on(window, 'touchstart', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return;
      const v = getTargetVideo(e); if (!v) return;
      if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const st = getSt(v); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; const c = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 }; pinchState.lastCx = c.x; pinchState.lastCy = c.y; }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchmove', e => {
      if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return;
      const st = getSt(activeVideo);
      if (pinchState.active && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const dist = getTouchDist(e.touches), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        let newScale = Math.min(Math.max(1, pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist))), 10);
        if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; }
        else { zoomTo(activeVideo, newScale, cx, cy); st.tx += cx - pinchState.lastCx; st.ty += cy - pinchState.lastCy; clampPan(activeVideo, st); update(activeVideo); }
        pinchState.lastCx = cx; pinchState.lastCy = cy;
      }
    }, { passive: false, capture: true, signal: zsig });

    on(window, 'touchend', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { update(activeVideo); activeVideo = null; } }, { passive: false, capture: true, signal: zsig });

    return { resetZoom, zoomTo, isZoomed, setEnabled: () => {}, pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } }, destroy: () => { safe(() => unsubAct?.()); safe(() => unsubZoomEn?.()); zoomAC.abort(); if (rafId) { cancelAnimationFrame(rafId); rafId = null; } for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; } zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } };
  }

  function createZoomFeature(Store, P) { let zm = null; return defineFeature({ name: 'zoom', phase: PHASE.PROCESS, onInit() { zm = createZoomManager(Store, P); }, onDestroy() { zm?.destroy(); }, methods: { pruneDisconnected: () => zm?.pruneDisconnected(), isZoomed: (v) => zm?.isZoomed(v), zoomTo: (v, s, x, y) => zm?.zoomTo(v, s, x, y), resetZoom: (v) => zm?.resetZoom(v) } }); }

  /* ── Timer Feature ───────────────────────────────────────────── */
  function createTimerFeature() {
    let _rafId = 0, _timerEl = null, _lastSecond = -1, _destroyed = false, _lastLayoutKey = '';
    function computeTimerPosition(pos, vRect, pRect, vWidth) {
      const topOffset = vWidth > 1200 ? 16 : 8, edgeMargin = vWidth > 1200 ? 20 : 10; const style = { top: 'auto', bottom: 'auto', left: 'auto', right: 'auto' }; let transform = '';
      style['top'] = `${Math.max(topOffset, vRect.top - pRect.top + topOffset)}px`;
      if (pos === 0) style['left'] = `${Math.max(edgeMargin, vRect.left - pRect.left + edgeMargin)}px`; else if (pos === 1) { style['left'] = `${(vRect.left - pRect.left) + vWidth / 2}px`; transform = `translateX(-50%)`; } else style['right'] = `${Math.max(edgeMargin, pRect.right - vRect.right + edgeMargin)}px`;
      return { style, transform: transform || 'none' };
    }
    function tick() {
      _rafId = 0; if (_destroyed) return; const store = __vscNs.Store; if (!store) { scheduleNext(); return; }
      const act = store.get('app.active'), timeEn = store.get('app.timeEn'), isFs = !!document.fullscreenElement;
      if (!act || !timeEn || !isFs) { if (_timerEl) _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const activeVideo = __vscNs.App?.getActiveVideo?.(); if (!activeVideo?.isConnected) { if (_timerEl) _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const now = new Date(), curSecond = now.getSeconds(); if (curSecond === _lastSecond && _timerEl && _timerEl.style.display !== 'none') { scheduleNext(); return; }
      _lastSecond = curSecond; const parent = activeVideo.parentNode; if (!parent) { scheduleNext(); return; }
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      if (!_timerEl || _timerEl.parentNode !== parent) { removeSafe(_timerEl); _timerEl = document.createElement('div'); _timerEl.className = 'vsc-fs-timer'; _timerEl.style.cssText = `position:absolute;z-index:2147483647;color:#FFE600;font-family:monospace;font-weight:bold;pointer-events:none;user-select:none;font-variant-numeric:tabular-nums;letter-spacing:1px;-webkit-text-stroke: 1.5px #000000; paint-order: stroke fill;transition:opacity 0.2s,transform 0.2s ease-out;opacity:0.5;`; parent.appendChild(_timerEl); _lastLayoutKey = ''; }
      _timerEl.style.display = 'block'; const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(curSecond).padStart(2, '0')}`;
      if (_timerEl.textContent !== timeStr) _timerEl.textContent = timeStr;
      const vRect = activeVideo.getBoundingClientRect(), pRect = parent.getBoundingClientRect(), vWidth = vRect.width, pos = store.get('app.timePos');
      const layoutKey = `${vRect.left | 0},${vRect.top | 0},${vRect.width | 0},${pRect.left | 0},${pRect.top | 0},${pos}`;
      if (_lastLayoutKey === layoutKey) { scheduleNext(); return; }
      _lastLayoutKey = layoutKey; _timerEl.style.fontSize = `${vWidth >= 2500 ? 36 : vWidth >= 1900 ? 30 : vWidth >= 1200 ? 24 : 18}px`;
      const { style: posStyle, transform: transformStr } = computeTimerPosition(pos, vRect, pRect, vWidth);
      Object.assign(_timerEl.style, posStyle); _timerEl.style.transform = transformStr; scheduleNext();
    }
    function scheduleNext() { if (!_destroyed && !_rafId) _rafId = requestAnimationFrame(tick); }
    return defineFeature({ name: 'timer', phase: PHASE.RENDER, onInit() { _destroyed = false; this.subscribe('fullscreen:changed', ({ active }) => { if (!active && _timerEl) { _timerEl.style.display = 'none'; _lastSecond = -1; _lastLayoutKey = ''; } if (active) scheduleNext(); }); scheduleNext(); }, onDestroy() { _destroyed = true; if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; } removeSafe(_timerEl); _timerEl = null; _lastSecond = -1; _lastLayoutKey = ''; } });
  }

  /* ── Targeting ───────────────────────────────────────────────── */
  function createTargeting() {
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
    const isInPlayer = (vid) => { if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true; const root = vid.getRootNode(); if (root instanceof ShadowRoot && root.host) return !!root.host.closest(PLAYER_CONTAINER_SELECTORS); return false; };
    function getViewportSnapshot() { const vv = window.visualViewport; if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }
    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      if (videos.size === 0) return { target: null };
      if (videos.size === 1) { const v = videos.values().next().value; return { target: (v?.readyState >= 1) ? v : null }; }
      const now = performance.now(), vp = getViewportSnapshot(); let best = null, bestScore = -Infinity;
      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;
        if (typeof v.checkVisibility === 'function') { try { if (!v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return; } catch (_) {} }
        const r = v.getBoundingClientRect(), area = (r?.width || 0) * (r?.height || 0), hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);
        if (!hasDecoded && area < 160 * 120) return;
        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;
        if (v.currentTime > 0.2) s += 2.0; s += Math.log2(1 + area / 20000) * 1.1;
        const ptAge = Math.max(0, now - (lastUserPt.t || 0)), userBias = Math.exp(-ptAge / 1800), dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
        s += (2.0 * userBias) / (1 + (dx * dx + dy * dy) / 722500); const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx * cdx + cdy * cdy) / 810000);
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
        if (!v.controls && !isInPlayer(v)) s -= 1.0; if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);
        if (s > bestScore) { bestScore = s; best = v; }
      };
      for (const v of videos) evalScore(v);
      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget?.isConnected && now < stickyUntil && best && stickyTarget !== best && bestScore < stickyScore + hysteresis) return { target: stickyTarget };
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000; return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  /* ── App Controller ──────────────────────────────────────────── */
  function createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus }) {
    Store.sub(P.APP_UI, () => Scheduler.request(true));
    Store.sub(P.APP_ACT, (on) => { if (on) { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } });

    let __activeTarget = null, __lastApplyTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active, sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscNs.__vscUserSignalRev || 0;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos;
        const userPt = __vscNs.lastUserPt || { x: 0, y: 0, t: 0 };

        let pick = Targeting.pickFastActiveOnly(visible.videos, userPt, wantAudioNow);
        if (!pick?.target) pick = Targeting.pickFastActiveOnly(Registry.videos, userPt, wantAudioNow);
        if (!pick?.target) { try { const list = Array.from(document.querySelectorAll('video')); pick = { target: list.find(v => v?.readyState >= 2 && !v.paused && !v.ended) || list.find(v => v?.readyState >= 2) || null }; } catch (_) {} }

        let nextTarget = pick?.target || __activeTarget;
        if (nextTarget !== __activeTarget) { if (Bus) Bus.emit('target:changed', { video: nextTarget, prev: __activeTarget }); __activeTarget = nextTarget; }

        const targetChanged = __activeTarget !== __lastApplyTarget;
        if (targetChanged) { if (__lastApplyTarget) safe(() => __vscNs.Adapter?.clear(__lastApplyTarget)); if (__activeTarget) safe(() => __vscNs.Filters?.invalidateCache(__activeTarget)); }
        if (!force && vidsDirty.size === 0 && !targetChanged && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
        lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev; __lastApplyTarget = __activeTarget;

        const now = performance.now(), pruneInterval = Registry.videos.size > 20 ? 1500 : (Registry.videos.size > 5 ? 3000 : 5000);
        if (vidsDirty.size > 40 || (now - lastPrune > pruneInterval)) { Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); lastPrune = now; }
        Features.updateAll({ active, force, vidsDirty, pbActive, target: __activeTarget, isApplyAll: !!Store.get(P.APP_APPLY_ALL), desiredRate: Store.get(P.PB_RATE) });
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisHandler = null;
    const startTick = () => { stopTick(); tickVisHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) Scheduler.request(false); }; document.addEventListener('visibilitychange', tickVisHandler, { passive: true }); tickTimer = setInterval(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000); if (__vscNs._intervals) __vscNs._intervals.push(tickTimer); };
    const stopTick = () => { if (!tickTimer) return; clearInterval(tickTimer); tickTimer = 0; if (tickVisHandler) { document.removeEventListener('visibilitychange', tickVisHandler); tickVisHandler = null; } };
    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();
    return Object.freeze({ getActiveVideo: () => __activeTarget, destroy() { stopTick(); safe(() => Features.destroyAll()); safe(() => Registry.destroy?.()); } });
  }

  /* ── Bootstrap ───────────────────────────────────────────────── */
  const Bus = createEventBus();
  const Utils = createUtils();
  const Scheduler = createScheduler(16);
  const Store = createLocalStore(CONFIG.DEFAULTS, Scheduler, Bus);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  if (window.top === window && typeof GM_registerMenuCommand === 'function') {
    const reg = (title, fn) => { const id = GM_registerMenuCommand(title, fn); if (__vscNs._menuIds) __vscNs._menuIds.push(id); };
    reg('\u2328\uFE0F 단축키 안내', () => { alert(['[Alt+Shift 조합]', 'V: UI 열기/닫기', 'D/B: 선명/밝기', 'S: 스크린샷', 'A: 구간반복', '[/]: 배속조절', '\\: 배속 리셋', '</>: 프레임 이동'].join('\n')); });
    reg('\uD83D\uDD04 설정 초기화 (Reset All)', () => { if (confirm('모든 설정을 초기화할까요?')) { const key = 'vsc_prefs_' + location.hostname; if (typeof GM_deleteValue === 'function') GM_deleteValue(key); localStorage.removeItem(key); location.reload(); } });
  }

  const Registry = createRegistry(Scheduler, Bus);
  const Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }, 150));

  function showScreenshotFlash(video) {
    const parent = video.parentElement; if (!parent) return;
    const flash = document.createElement('div'); flash.style.cssText = 'position:absolute;inset:0;z-index:2147483647;background:rgba(255,255,255,0.6);pointer-events:none;transition:opacity 0.3s ease-out;opacity:1;';
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative'; parent.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; setTimeout(() => flash.remove(), 400); });
  }

  onPageReady(() => {
    __vscNs._timers = __vscNs._timers || [];
    for (const delay of [3000, 10000]) { const id = setTimeout(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); }, delay); __vscNs._timers.push(id); }
    (function ensureRegistryAfterBodyReady() {
      let ran = false; const runOnce = () => { if (ran) return; ran = true; Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); };
      if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } });
      try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {}
      on(document, 'DOMContentLoaded', runOnce, { once: true });
    })();

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID });
    const Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter; __vscNs.Filters = Filters;

    const videoParamsMemo = createVideoParamsMemo();
    const Features = createFeatureRegistry(Bus);
    Features.register(createPipelineFeature(Store, Registry, Adapter, ApplyReq, Targeting, videoParamsMemo));

    const audioFeat = createAudioFeature(Store); Features.register(audioFeat);
    const zoomFeat = createZoomFeature(Store, CONFIG.P); Features.register(zoomFeat);
    const uiFeat = createUIFeature(Store, Registry, ApplyReq, Utils, CONFIG.P, Bus); Features.register(uiFeat);
    Features.register(createTimerFeature());
    Features.register(createABLoopFeature());

    __vscNs.Features = Features; __vscNs.ZoomManager = zoomFeat; __vscNs.AudioWarmup = audioFeat.warmup;
    __vscNs.AudioSetTarget = (v) => safe(() => Bus.emit('target:changed', { video: v, prev: null }));
    __vscNs.UIEnsure = () => safe(() => uiFeat.update());

    let __vscLastUserSignalT = 0;
    __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
    __vscNs.__vscUserSignalRev = 0;
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteraction() { const now = performance.now(); if (now - __vscLastUserSignalT < 24) return; __vscLastUserSignalT = now; __vscNs.__vscUserSignalRev = (__vscNs.__vscUserSignalRev + 1) | 0; Scheduler.request(false); }

    for (const [evt, getPt] of [
      ['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]],
      ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]
    ]) { on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else updateLastUserPt(...getPt(e), performance.now()); signalUserInteraction(); }, evt === 'keydown' ? undefined : OPT_P); }

    let __VSC_APP__ = null;
    Features.initAll({ bus: Bus, store: Store, getActiveVideo: () => __VSC_APP__?.getActiveVideo() || null });
    __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Features, P: CONFIG.P, Targeting, Bus });
    __vscNs.App = __VSC_APP__; ApplyReq.hard();

    const SHORTCUT_MAP = new Map([
      ['KeyV', { needsAct: false, handler: () => { Store.set(CONFIG.P.APP_UI, !Store.get(CONFIG.P.APP_UI)); ApplyReq.hard(); } }],
      ['KeyD', { needsAct: true, handler: () => { const presets = ['off', 'Soft', 'Medium', 'Ultra', 'Master']; const cur = Store.get(CONFIG.P.V_PRE_S); const n = presets[(presets.indexOf(cur) + 1) % presets.length]; Store.set(CONFIG.P.V_PRE_S, n); ApplyReq.hard(); showToast(`선명: ${n}`); } }],
      ['KeyB', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.V_BRIGHT_LV)) || 0; const n = (cur + 1) % 6; Store.set(CONFIG.P.V_BRIGHT_LV, n); ApplyReq.hard(); showToast(`밝기: ${n === 0 ? 'OFF' : n}`); } }],
      ['BracketRight', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.PB_RATE)) || 1.0; const n = Math.min(16, Math.round((cur + 0.05) * 100) / 100); Store.set(CONFIG.P.PB_RATE, n); Store.set(CONFIG.P.PB_EN, true); ApplyReq.hard(); showToast(`배속: ${n.toFixed(2)}x`); } }],
      ['BracketLeft', { needsAct: true, handler: () => { const cur = Number(Store.get(CONFIG.P.PB_RATE)) || 1.0; const n = Math.max(0.1, Math.round((cur - 0.05) * 100) / 100); Store.set(CONFIG.P.PB_RATE, n); Store.set(CONFIG.P.PB_EN, true); ApplyReq.hard(); showToast(`배속: ${n.toFixed(2)}x`); } }],
      ['Backslash', { needsAct: false, handler: () => { Store.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); showToast('배속 리셋 (1.0x)'); } }],
      ['KeyA', { needsAct: true, handler: () => Features.get('abLoop')?.toggle?.() }],
      ['Period', { needsAct: true, handler: () => { const v = __VSC_APP__?.getActiveVideo(); if (!v) return; v.pause(); v.currentTime = Math.min(v.duration - 0.01, v.currentTime + 1 / 30); showToast('\u25B6| +1 프레임'); } }],
      ['Comma', { needsAct: true, handler: () => { const v = __VSC_APP__?.getActiveVideo(); if (!v) return; v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); showToast('|\u25C0 -1 프레임'); } }],
      ['KeyS', { needsAct: true, handler: () => {
        const video = __VSC_APP__?.getActiveVideo(); if (!video || video.readyState < 2) return;
        const canvas = document.createElement('canvas'), vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
        canvas.width = vw; canvas.height = vh; canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);
        canvas.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19), domain = location.hostname.replace(/\./g, '_'); a.download = `vsc_${domain}_${Store.get(CONFIG.P.V_PRE_S) || 'off'}_b${Store.get(CONFIG.P.V_BRIGHT_LV) || 0}_${ts}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); showScreenshotFlash(video); }, 'image/png');
      } }]
    ]);

    on(window, 'keydown', async (e) => {
      const isEditable = (el) => { if (!el) return false; const tag = el.tagName; return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable; };
      if (isEditable(e.target) || !e.altKey || !e.shiftKey) return;
      const entry = SHORTCUT_MAP.get(e.code); if (!entry) return;
      e.preventDefault(); e.stopPropagation(); if (entry.needsAct && !Store.get(CONFIG.P.APP_ACT)) return;
      try { await entry.handler(); } catch (_) {}
    }, { capture: true });

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') ApplyReq.hard(); }, OPT_P);
    window.addEventListener('beforeunload', () => __VSC_APP__?.destroy(), { once: true });
  });

}

VSC_MAIN();
})();
