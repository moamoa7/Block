// ==UserScript==
// @name         Video_Control (v191.0 - Master Revision)
// @namespace    https://github.com/moamoa7
// @version      191.0
// @description  Perfected cache (ok.ru), Bulletproof Timer (Polling+Fix), Stable UI, CSS Transition Engine, Zero Leak, Audited.
// @match        *://*/*
// @exclude      *://*.google.com/recaptcha/*
// @exclude      *://*.hcaptcha.com/*
// @exclude      *://*.arkoselabs.com/*
// @exclude      *://accounts.google.com/*
// @exclude      *://*.stripe.com/*
// @exclude      *://*.paypal.com/*
// @exclude      *://challenges.cloudflare.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @allFrames    true
// ==/UserScript==

(function () {
'use strict';

function VSC_MAIN() {
  if (location.protocol === 'javascript:') return;

  const SCRIPT_VERSION = '191.0';
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

  /* ── Shadow DOM Emitter ───────────────────────────────────────── */
  const _origAttach = Element.prototype.attachShadow;
  if (typeof _origAttach === 'function' && !_origAttach.__vsc_patched) {
    Element.prototype.attachShadow = function(init) {
      const sr = _origAttach.call(this, init);
      if (__vscNs._onShadow) queueMicrotask(() => __vscNs._onShadow(this, sr));
      return sr;
    };
    Element.prototype.attachShadow.__vsc_patched = true;
  }

  /* ── Utility Helpers ─────────────────────────────────────────── */
  const safe = (fn) => { try { fn(); } catch (e) { if (/[?&]vsc_debug=1/.test(location.search)) console.warn('[VSC] safe() caught:', e); } };
  const disconnectSafe = (node) => node?.disconnect?.();
  const removeSafe = (el) => { try { el?.remove(); } catch (_) {} };

  const setTimer = (fn, ms) => {
    const id = setTimeout(fn, ms);
    if (!__globalSig.aborted) {
      __globalSig.addEventListener('abort', () => clearTimeout(id), { once: true });
    }
    return id;
  };

  const setRecurring = (fn, ms) => {
    const id = setInterval(() => {
      if (__globalSig.aborted) { clearInterval(id); return; }
      fn();
    }, ms);
    __globalSig.addEventListener('abort', () => clearInterval(id), { once: true });
    return id;
  };

  const postIdleTask = (typeof globalThis.scheduler?.postTask === 'function')
    ? (fn) => scheduler.postTask(fn, { priority: 'background' })
    : (fn) => setTimeout(fn, 0);

  function destroyRuntime(ns = __vscNs) {
    if (!ns || ns.__destroying) return;
    ns.__destroying = true;
    safe(() => ns.App?.destroy?.());
    safe(() => ns.Features?.destroyAll?.());
    safe(() => ns.Store?.destroy?.());
    safe(() => ns.Registry?.destroy?.());
    safe(() => ns._spaNavAC?.abort?.());
    safe(() => ns._globalHooksAC?.abort?.());
    ns.__alive = false; ns.__destroying = false;
  }

  if (__vscNs.__alive) destroyRuntime(__vscNs);
  __vscNs.__alive = true;

  /* ── CONFIG ──────────────────────────────────────────────────── */
  const CONFIG = (() => {
    const IS_MOBILE = (() => { const uad = navigator.userAgentData; if (uad && typeof uad.mobile === 'boolean') return uad.mobile; if (/iPad/.test(navigator.platform) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform))) return true; return /Mobi|Android|iPhone/i.test(navigator.userAgent); })();
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
      bright: { 0: { gammaF: 1.00, brightAdd: 0 }, 1: { gammaF: 1.05, brightAdd: 1.0 }, 2: { gammaF: 1.075, brightAdd: 1.5 }, 3: { gammaF: 1.10, brightAdd: 2.0 }, 4: { gammaF: 1.125, brightAdd: 2.5 }, 5: { gammaF: 1.150, brightAdd: 3.0 } }
    });
    const DEFAULTS = Object.freeze({ video: { presetS: 'off', brightLevel: 0, shadowBandMask: 0, temp: 0 }, audio: { enabled: false, boost: 0 }, playback: { rate: 1.0, enabled: false }, app: { active: true, uiVisible: false, applyAll: true, zoomEn: false, advanced: false, timeEn: true, timePos: 1, kbEnabled: true } });
    const P = Object.freeze({ APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll', APP_ZOOM_EN: 'app.zoomEn', APP_ADV: 'app.advanced', APP_TIME_EN: 'app.timeEn', APP_TIME_POS: 'app.timePos', APP_KB_EN: 'app.kbEnabled', V_PRE_S: 'video.presetS', V_BRIGHT_LV: 'video.brightLevel', V_SHADOW_MASK: 'video.shadowBandMask', V_TEMP: 'video.temp', A_EN: 'audio.enabled', A_BST: 'audio.boost', PB_RATE: 'playback.rate', PB_EN: 'playback.enabled' });
    return Object.freeze({ IS_MOBILE, VSC_ID, DEBUG, FLAGS, DARK_BAND, PRESETS, DEFAULTS, P });
  })();

  __vscNs.CONFIG = CONFIG; const FLAGS = CONFIG.FLAGS; __vscNs.FLAGS = Object.freeze({ ...FLAGS });

  /* ── Constants & Small Utilities ─────────────────────────────── */
  const PLAYER_CONTAINER_SELECTORS = '.html5-video-player, #movie_player, .shaka-video-container, .dplayer-video-wrap, .vjs-container, .video-js, [data-player]';
  const OPT_P = { passive: true };
  const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));
  const combineSignals = (...signals) => {
    const existing = signals.filter(Boolean);
    if (existing.length === 0) return undefined;
    if (existing.length === 1) return existing[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(existing);
    const ac = new AbortController();
    for (const s of existing) {
      if (s.aborted) { ac.abort(s.reason); return ac.signal; }
      s.addEventListener('abort', () => ac.abort(s.reason), { once: true });
    }
    return ac.signal;
  };

  /* ── Event Binding ───────────────────────────────────────────── */
  function on(target, type, fn, opts) {
    if (!target?.addEventListener) return;
    const o = typeof opts === 'boolean' ? { capture: opts } : (opts ? { ...opts } : {});
    o.signal = o.signal ? combineSignals(o.signal, __globalSig) : __globalSig;
    target.addEventListener(type, fn, o);
  }
  const blockInterference = (el) => {
    if (!el) return;
    const stop = (e) => { e.stopPropagation(); };
    for (const evt of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick']) {
      on(el, evt, stop, { passive: true });
    }
    on(el, 'wheel', stop, { passive: false });
  };
  __vscNs.blockInterference = blockInterference;

  function onPageReady(fn) {
    let ran = false; const localAC = new AbortController(); const sig = combineSignals(localAC.signal, __globalSig);
    const run = () => { if (ran || sig?.aborted) return; ran = true; localAC.abort(); safe(fn); };
    if ((document.readyState === 'interactive' || document.readyState === 'complete') && document.body) { run(); return () => localAC.abort(); }
    document.addEventListener('DOMContentLoaded', run, { once: true, signal: sig }); window.addEventListener('load', run, { once: true, signal: sig }); return () => localAC.abort();
  }
  const log = { error: (...a) => console.error('[VSC]', ...a), warn: (...a) => console.warn('[VSC]', ...a), debug: (...a) => { if (CONFIG.DEBUG) console.debug('[VSC]', ...a); } };

  /* ── EventBus (Optimized Map/Set) ────────────────────────────── */
  function createEventBus() {
    const _listeners = new Map(); let _destroyed = false;
    return Object.freeze({
      on(event, handler) { if (_destroyed || typeof handler !== 'function') return () => {}; let set = _listeners.get(event); if (!set) { set = new Set(); _listeners.set(event, set); } set.add(handler); return () => set.delete(handler); },
      once(event, handler) { if (_destroyed || typeof handler !== 'function') return () => {}; let unsub; const wrapper = (data) => { unsub?.(); handler(data); }; unsub = this.on(event, wrapper); return unsub; },
      emit(event, data) { if (_destroyed) return; const set = _listeners.get(event); if (set) for (const fn of set) safe(() => fn(data)); },
      off(event, handler) { _listeners.get(event)?.delete(handler); },
      destroy() { _destroyed = true; _listeners.clear(); }
    });
  }

  /* ── Feature System ──────────────────────────────────────────── */
  const PHASE = Object.freeze({ COMPUTE: 0, PROCESS: 1, RENDER: 2 });
  function defineFeature(spec) {
    const _name = spec.name, _phase = (typeof spec.phase === 'number') ? spec.phase : PHASE.PROCESS; let _deps = null, _initialized = false, _destroyed = false; const _unsubs = [];
    const module = {
      getName() { return _name; }, getPhase() { return _phase; }, isInitialized() { return _initialized; },
      subscribe(event, handler) { const unsub = _deps.bus.on(event, handler); _unsubs.push(unsub); return unsub; }, emit(event, data) { if (_deps) _deps.bus.emit(event, data); }, getSetting(path) { return _deps?.store?.get(path); }, setSetting(path, value) { _deps?.store?.set(path, value); }, getActiveVideo() { return _deps?.getActiveVideo?.() || null; },
      init(deps) { if (_initialized) return; _deps = deps; _initialized = true; _destroyed = false; if (typeof spec.onInit === 'function') spec.onInit.call(module, deps); },
      update(ctx) { if (_initialized && !_destroyed && typeof spec.onUpdate === 'function') spec.onUpdate.call(module, ctx); },
      destroy() { if (_destroyed) return; _destroyed = true; _initialized = false; if (typeof spec.onDestroy === 'function') { try { const res = spec.onDestroy.call(module); if (res && typeof res.catch === 'function') res.catch(e => log.warn(e)); } catch (_) {} } for (const unsub of _unsubs) safe(unsub); _unsubs.length = 0; _deps = null; }
    };
    if (spec.methods) Object.assign(module, spec.methods); return Object.freeze(module);
  }
  function createFeatureRegistry(bus) {
    const _modules = new Map(); let _initialized = false; let _sorted = [];
    const resort = () => { _sorted = [..._modules.values()].sort((a, b) => (a.getPhase?.() ?? 1) - (b.getPhase?.() ?? 1)); };
    return Object.freeze({
      register(module) { const name = module.getName(); if (_modules.has(name)) safe(() => _modules.get(name).destroy()); _modules.set(name, module); resort(); },
      initAll(deps) { if (_initialized) return; _initialized = true; for (const mod of _sorted) safe(() => mod.init(deps)); bus.emit('features:initialized'); },
      updateAll(ctx) { for (const mod of _sorted) safe(() => mod.update(ctx)); },
      destroyAll() { for (let i = _sorted.length - 1; i >= 0; i--) safe(() => _sorted[i].destroy()); _modules.clear(); _sorted = []; _initialized = false; },
      get(name) { return _modules.get(name) || null; }
    });
  }

  /* ── Layout Revision Tracking ────────────────────────────────── */
  let __vscLayoutRev = 0, _scrollBumpRaf = 0;
  const bumpLayoutRev = () => { __vscLayoutRev = (__vscLayoutRev + 1) | 0; };
  const bumpLayoutRevThrottled = () => { if (!_scrollBumpRaf) _scrollBumpRaf = requestAnimationFrame(() => { _scrollBumpRaf = 0; bumpLayoutRev(); }); };
  on(window, 'scroll', bumpLayoutRevThrottled, { passive: true, capture: true }); on(window, 'resize', bumpLayoutRev, { passive: true });
  try { const vv = window.visualViewport; if (vv) { on(vv, 'scroll', bumpLayoutRevThrottled, { passive: true }); on(vv, 'resize', bumpLayoutRev, { passive: true }); } } catch (_) {}

  /* ── Video State Map (Flat Object Refactor) ──────────────────── */
  const videoStateMap = new WeakMap();
  const getVState = (v) => {
    let st = videoStateMap.get(v);
    if (!st) { st = { visible: false, bound: false, applied: false, rect: null, _rectRev: 0, audioFailUntil: 0, desiredRate: undefined, origFilter: undefined, origFilterPrio: '', lastFilterUrl: undefined, rateState: undefined }; videoStateMap.set(v, st); }
    return st;
  };
  const TOUCHED = { videos: new Set(), rateVideos: new Set() };

  /* ── Debounce ────────────────────────────────────────────────── */
  function createDebounced(fn, ms = 250) {
    let t = 0;
    const debounced = (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = 0; fn(...args); }, ms);
    };
    debounced.cancel = () => { if (t) { clearTimeout(t); t = 0; } };
    return debounced;
  }

  /* ── SPA URL Detector ────────────────────────────────────────── */
  function initSpaUrlDetector(onChanged) {
    try { __vscNs._spaDetector?.destroy?.(); } catch (_) {}
    const ac = new AbortController(), sig = combineSignals(ac.signal, __globalSig);
    let lastHref = location.href, pollId = 0; const origHistory = {};
    const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };

    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: sig });
    } else {
      for (const method of ['pushState', 'replaceState']) {
        const orig = history[method];
        if (typeof orig === 'function' && !orig.__vsc_patched) {
          origHistory[method] = orig;
          history[method] = function(...args) { const res = orig.apply(this, args); queueMicrotask(emitIfChanged); return res; };
          history[method].__vsc_patched = true;
        }
      }
      pollId = setRecurring(emitIfChanged, 1000);
    }
    on(window, 'popstate', emitIfChanged, { passive: true, signal: sig });
    const destroy = () => { ac.abort(); if (pollId) clearInterval(pollId); onChanged.cancel?.(); for (const [method, orig] of Object.entries(origHistory)) { if (history[method]?.__vsc_patched) { history[method] = orig; delete history[method].__vsc_patched; } } };
    __vscNs._spaDetector = { destroy }; return __vscNs._spaDetector;
  }

  /* ── DOM Utilities ───────────────────────────────────────────── */
  function createUtils() {
    const SVG_TAGS = new Set(['svg', 'defs', 'filter', 'feColorMatrix', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feGaussianBlur', 'feComposite']);
    return { clamp: VSC_CLAMP, h: (tag, props = {}, ...children) => { const isSvg = SVG_TAGS.has(tag) || props.ns === 'svg'; const el = isSvg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v); else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); } else if (k === 'class') el.className = v; else if (v !== false && v != null && k !== 'ns') el.setAttribute(k, v); } children.flat().forEach(c => { if (c != null) el.append(c); }); return el; } };
  }

  /* ── Simplified Scheduler ────────────────────────────────────── */
  function createScheduler(minIntervalMs = 16) {
    let queued = false, force = false, applyFn = null, lastRun = 0, rafId = 0, timer = 0;
    function clearPending() { if (timer) { clearTimeout(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    function run() { rafId = 0; const now = performance.now(); const doForce = force; force = false; const dt = now - lastRun; if (!doForce && dt < minIntervalMs) { if (!timer) timer = setTimer(() => { timer = 0; run(); }, Math.max(0, minIntervalMs - dt)); return; } queued = false; lastRun = now; if (applyFn) safe(() => applyFn(doForce)); }
    const request = (immediate = false) => { if (immediate) { force = true; clearPending(); queued = true; rafId = requestAnimationFrame(run); return; } if (queued) return; queued = true; clearPending(); rafId = requestAnimationFrame(run); };
    return { registerApply: (fn) => { applyFn = fn; }, request, destroy: () => { clearPending(); applyFn = null; } };
  }

  /* ── Store ───────────────────────────────────────────────────── */
  const parsePath = (p) => { const dot = p.indexOf('.'); return dot < 0 ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)]; };
  function createLocalStore(defaults, scheduler, bus) {
    const state = structuredClone(defaults); let rev = 0; const listeners = new Map(); const storeAC = new AbortController(); const storeSig = combineSignals(storeAC.signal, __globalSig); const PREF_KEY = 'vsc_prefs_' + location.hostname; let _lastSavedJson = '', _lastSavedRev = rev;
    const VALID_PRESETS = new Set(Object.keys(CONFIG.PRESETS.detail));
    function loadPrefs() { try { if (typeof GM_getValue === 'function') { const v = GM_getValue(PREF_KEY, null); if (v != null) return typeof v === 'object' ? v : JSON.parse(v); } } catch (_) {} try { const s = localStorage.getItem(PREF_KEY); return s ? JSON.parse(s) : null; } catch (_) {} return null; }
    function savePrefsRaw(json) { try { if (typeof GM_setValue === 'function') { GM_setValue(PREF_KEY, json); return true; } } catch (_) {} try { localStorage.setItem(PREF_KEY, json); return true; } catch (_) {} return false; }
    function mergeKnown(dst, src, defaultsObj, validators) { if (!src || typeof src !== 'object') return; for (const key of Object.keys(defaultsObj)) { if (!Object.prototype.hasOwnProperty.call(src, key)) continue; const v = src[key], def = defaultsObj[key]; if (typeof def === 'boolean') dst[key] = !!v; else if (typeof def === 'number') { const n = Number(v); dst[key] = Number.isFinite(n) ? n : def; } else if (typeof def === 'string') { const validator = validators?.[key]; if (validator) dst[key] = validator(v) ? v : def; else dst[key] = typeof v === 'string' ? v : def; } else dst[key] = v; } }
    try { const parsed = loadPrefs(); if (parsed && typeof parsed === 'object') { mergeKnown(state.video, parsed.video, CONFIG.DEFAULTS.video, { presetS: (v) => typeof v === 'string' && VALID_PRESETS.has(v) }); mergeKnown(state.audio, parsed.audio, CONFIG.DEFAULTS.audio); mergeKnown(state.playback, parsed.playback, CONFIG.DEFAULTS.playback); mergeKnown(state.app, parsed.app, CONFIG.DEFAULTS.app); } } catch (e) { log.warn('Invalid prefs detected. Resetting.'); }
    _lastSavedJson = JSON.stringify(state);
    function _doSave() { if (rev === _lastSavedRev) return; const json = JSON.stringify(state); if (json === _lastSavedJson || json.length > 16384) return; _lastSavedRev = rev; if (savePrefsRaw(json)) _lastSavedJson = json; }
    const savePrefs = createDebounced(() => _doSave(), 500); const flushNow = () => _doSave();
    on(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') flushNow(); }, { passive: true, signal: storeSig }); on(window, 'pagehide', () => flushNow(), { passive: true, signal: storeSig });
    const emit = (path, val) => { const cbs = listeners.get(path); if (cbs) for (const cb of cbs) safe(() => cb(val)); const dot = path.indexOf('.'); if (dot > 0) { const catStar = path.slice(0, dot) + '.*'; const cbsStar = listeners.get(catStar); if (cbsStar) for (const cb of cbsStar) safe(() => cb(val)); } };
    const notifyChange = (path, val) => { rev++; emit(path, val); if (bus) bus.emit('settings:changed', { path, value: val }); savePrefs(); scheduler.request(false); };
    return { state, rev: () => rev, getCatRef: (cat) => state[cat], get: (p) => { const [cat, key] = parsePath(p); return key ? state[cat]?.[key] : state[cat]; }, set: (p, val) => { const [cat, key] = parsePath(p); const target = key ? state[cat] : state; const prop = key || cat; if (Object.is(target[prop], val)) return; target[prop] = val; notifyChange(p, val); }, batch: (cat, obj) => { let changed = false; const updates = []; for (const [k, v] of Object.entries(obj)) { if (state[cat][k] !== v) { state[cat][k] = v; changed = true; updates.push([`${cat}.${k}`, v]); } } if (changed) { rev++; for (const [path, val] of updates) emit(path, val); if (bus) bus.emit('settings:changed', { path: `${cat}.*`, value: obj, batch: true }); savePrefs(); scheduler.request(false); } }, sub: (k, f) => { let s = listeners.get(k); if (!s) { s = new Set(); listeners.set(k, s); } s.add(f); return () => listeners.get(k)?.delete(f); }, destroy: () => { storeAC.abort(); try { _doSave(); } catch (_) {} listeners.clear(); savePrefs.cancel?.(); } };
  }

  /* ── Registry ────────────────────────────────────────────────── */
  function createRegistry(scheduler, bus) {
    let destroyed = false; const videos = new Set(), visible = { videos: new Set() }; let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA; let rev = 0, __refreshQueued = false, refreshRafId = 0, rescanTimerId = 0;
    function requestRefreshCoalesced() { if (destroyed || __refreshQueued) return; __refreshQueued = true; refreshRafId = requestAnimationFrame(() => { refreshRafId = 0; __refreshQueued = false; if (!destroyed) scheduler.request(false); }); }
    const IO_MARGIN_PX = CONFIG.IS_MOBILE ? 80 : Math.min(200, Math.round(innerHeight * 0.10)); const ioOpts = { root: null, threshold: [0], rootMargin: `${IO_MARGIN_PX}px` };
    const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => { let changed = false; for (const e of entries) { const el = e.target; if (!videos.has(el)) continue; const isVis = e.isIntersecting; const st = getVState(el); st.visible = isVis; st.rect = e.boundingClientRect; st._rectRev = __vscLayoutRev; if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } } else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } } } if (changed) { rev++; requestRefreshCoalesced(); } }, ioOpts) : null;
    const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));
    const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => { let changed = false; for (const e of entries) { const el = e.target; if (!el || el.tagName !== 'VIDEO') continue; const st = getVState(el); if (e.contentBoxSize?.[0]) { const s = e.contentBoxSize[0]; st.rect = { width: s.inlineSize, height: s.blockSize, left: st.rect?.left ?? 0, top: st.rect?.top ?? 0, right: (st.rect?.left ?? 0) + s.inlineSize, bottom: (st.rect?.top ?? 0) + s.blockSize }; } else { st.rect = e.contentRect ? el.getBoundingClientRect() : null; } st._rectRev = __vscLayoutRev; dirty.videos.add(el); changed = true; } if (changed) { bumpLayoutRev(); requestRefreshCoalesced(); } }) : null;

    const MAX_SHADOW_OBS = 5; let baseRoot = null, baseObserver = null; const shadowObserverMap = new Map();
    function disconnectBaseObserver() { if (!baseObserver) return; disconnectSafe(baseObserver); baseObserver = null; }
    function untrackVideo(v) { if (!v || v.tagName !== 'VIDEO') return; const wasTracked = videos.has(v); if (wasTracked) { videos.delete(v); if (bus) bus.emit('video:lost', { video: v }); } visible.videos.delete(v); dirtyA.videos.delete(v); dirtyB.videos.delete(v); dirty.videos.add(v); io?.unobserve(v); ro?.unobserve(v); }

    const observeVideo = (el) => {
      if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
      const wasEmpty = (videos.size === 0); videos.add(el);
      if (bus) bus.emit('video:detected', { video: el, isFirst: wasEmpty });
      if (wasEmpty) queueMicrotask(() => { __vscNs.UIEnsure?.(); });
      if (io) { io.observe(el); } else { const st = getVState(el); let vis = true; if (typeof el.checkVisibility === 'function') { try { vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (_) {} } st.visible = vis; if (vis && !visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); requestRefreshCoalesced(); } }
      ro?.observe(el);
    };

    const WorkQ = (() => {
      let pending = new Set(), scheduled = false, rafId = 0;
      const scanNode = (n) => { if (!n) return; if (n.nodeType === 1 && n.tagName === 'VIDEO') { observeVideo(n); return; } if (n.nodeType === 1 || n.nodeType === 11) { const vs = n.querySelectorAll?.('video'); if (vs?.length) for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } };
      const flush = () => { rafId = 0; scheduled = false; const batch = pending; pending = new Set(); for (const n of batch) { if (destroyed) return; scanNode(n); } };
      return Object.freeze({ enqueue(n) { if (destroyed || !n) return; pending.add(n); if (!scheduled) { scheduled = true; rafId = requestAnimationFrame(flush); } }, destroy() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } pending.clear(); scheduled = false; } });
    })();

    function makeObserver(root, onDisconnect) {
      const mo = new MutationObserver((muts) => {
        if (root !== baseRoot && root.host && !root.host.isConnected) { disconnectSafe(mo); onDisconnect?.(); return; }
        let touchedVideoTree = false;
        for (const m of muts) {
          if (m.addedNodes?.length) for (const n of m.addedNodes) { if (n && (n.nodeType === 1 || n.nodeType === 11)) WorkQ.enqueue(n); }
          if (m.removedNodes?.length) { for (const n of m.removedNodes) { if (!n || n.nodeType !== 1) continue; if (n.tagName === 'VIDEO') { untrackVideo(n); touchedVideoTree = true; continue; } const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (list?.length) { for (let i = 0; i < list.length; i++) untrackVideo(list[i]); touchedVideoTree = true; } } }
        }
        if (touchedVideoTree) requestRefreshCoalesced();
      }); mo.observe(root, { childList: true, subtree: true }); return mo;
    }

    const connectObserver = (root) => {
      if (!root) return; const isBase = root === baseRoot;
      if (isBase) { if (baseObserver) return; baseObserver = makeObserver(root); WorkQ.enqueue(root); return; }
      if (shadowObserverMap.has(root)) return; if (root.host && !root.host.isConnected) return;
      if (shadowObserverMap.size >= MAX_SHADOW_OBS) {
        let evicted = false; for (const [sr, mo] of shadowObserverMap) { if (!sr.host || !sr.host.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(sr); evicted = true; break; } }
        if (!evicted) { for (const [sr, mo] of shadowObserverMap) { if (!sr.querySelector?.('video')) { disconnectSafe(mo); shadowObserverMap.delete(sr); evicted = true; break; } } }
        if (!evicted) { const oldest = shadowObserverMap.keys().next().value; disconnectSafe(shadowObserverMap.get(oldest)); shadowObserverMap.delete(oldest); }
      }
      const mo = makeObserver(root, () => shadowObserverMap.delete(root)); shadowObserverMap.set(root, mo); WorkQ.enqueue(root);
    };

    __vscNs._onShadow = (host, sr) => { if (host.isConnected && shadowObserverMap.size < MAX_SHADOW_OBS) { if (sr.querySelector?.('video')) connectObserver(sr); } };

    const refreshObservers = () => { disconnectBaseObserver(); for (const [sr, mo] of [...shadowObserverMap]) { if (!sr.host?.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(sr); } else if (shadowObserverMap.size > 2 && !sr.querySelector?.('video')) { disconnectSafe(mo); shadowObserverMap.delete(sr); } } baseRoot = document.body || document.documentElement; if (baseRoot) { WorkQ.enqueue(baseRoot); connectObserver(baseRoot); } };
    refreshObservers();

    function startVideoPolling() {
      return setRecurring(() => {
        if (!__vscNs.__alive || destroyed) return;
        if (document.hidden) return;
        const allVideos = document.querySelectorAll('video'); for (let i = 0; i < allVideos.length; i++) observeVideo(allVideos[i]);
        for (const [sr] of shadowObserverMap) { if (!sr.host?.isConnected) continue; const vs = sr.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); }
      }, 3000);
    }
    const pollTimer = startVideoPolling();

    on(document, 'play', (e) => {
      if (e.target?.tagName === 'VIDEO') observeVideo(e.target);
    }, { capture: true, passive: true });

    function pruneDisconnectedVideos() { let removed = 0; for (const el of [...videos]) { if (!el?.isConnected) { videos.delete(el); visible.videos.delete(el); dirtyA.videos.delete(el); dirtyB.videos.delete(el); io?.unobserve(el); ro?.unobserve(el); removed++; } } return removed; }

    return { videos, visible, rev: () => rev, refreshObservers, prune: () => { for (const [root, mo] of [...shadowObserverMap]) { const host = root.host; if (!host || !host.isConnected) { disconnectSafe(mo); shadowObserverMap.delete(root); for (const v of [...videos]) { try { if (v.getRootNode() === root) untrackVideo(v); } catch (_) {} } } } const removed = pruneDisconnectedVideos(); if (removed) rev++; }, consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
    rescanAll: () => { if (destroyed) return; if (rescanTimerId) clearTimeout(rescanTimerId); rescanTimerId = setTimer(() => { rescanTimerId = 0; if (destroyed) return; try { const base = document.documentElement || document.body; if (!base) return; function* walkRoots(rootBase) { if (!rootBase) return; const stack = [rootBase]; const seen = new Set(); while (stack.length > 0) { const r = stack.pop(); if (!r || seen.has(r)) continue; seen.add(r); yield r; const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT); let node = walker.nextNode(); while (node) { if (node.shadowRoot) stack.push(node.shadowRoot); node = walker.nextNode(); } } } for (const r of walkRoots(base)) WorkQ.enqueue(r); } catch (_) {} }, 0); },
    destroy: () => { destroyed = true; if (refreshRafId) { cancelAnimationFrame(refreshRafId); refreshRafId = 0; } if (rescanTimerId) { clearTimeout(rescanTimerId); rescanTimerId = 0; } WorkQ.destroy(); disconnectBaseObserver(); for (const mo of shadowObserverMap.values()) disconnectSafe(mo); shadowObserverMap.clear(); disconnectSafe(io); disconnectSafe(ro); videos.clear(); visible.videos.clear(); dirtyA.videos.clear(); dirtyB.videos.clear(); } };
  }

  /* ── Audio Utilities ─────────────────────────────────────────── */
  const audioSourceMap = new WeakMap();

  function getOrCreateAudioSource(ctx, video) {
    const existing = audioSourceMap.get(video);
    if (existing) {
      if (existing.context !== ctx) throw new DOMException('MediaElementSource already bound to different AudioContext', 'InvalidStateError');
      return existing;
    }
    const src = ctx.createMediaElementSource(video);
    audioSourceMap.set(video, src);
    return src;
  }

  function detachAudioSource(video) {
    const src = audioSourceMap.get(video);
    if (src) disconnectSafe(src);
  }

  function createAudioParamCache() {
    const _cache = new Map();
    return { sttIfChanged(param, key, newVal, time, tc) { const prev = _cache.get(key); if (prev !== undefined && Math.abs(prev - newVal) < 0.005) return; _cache.set(key, newVal); try { param.setTargetAtTime(newVal, time, tc); } catch (_) { param.value = newVal; } }, invalidate: (k) => _cache.delete(k), clear: () => _cache.clear() };
  }

  const mkComp = (actx) => (thr, knee, ratio, atk, rel) => { const c = actx.createDynamicsCompressor(); c.threshold.value = thr; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel; return c; };

  function buildAudioGraph(audioCtx) {
    const n = { inputGain: audioCtx.createGain(), dryGain: audioCtx.createGain(), wetGain: audioCtx.createGain(), masterOut: audioCtx.createGain(), boostGain: audioCtx.createGain() };
    const comp = mkComp(audioCtx)(-18.0, 12.0, 3.0, 0.02, 0.2); const lim = mkComp(audioCtx)(-1.0, 1.0, 20.0, 0.001, 0.1);
    n.inputGain.connect(n.dryGain); n.dryGain.connect(n.masterOut);
    n.inputGain.connect(n.boostGain); n.boostGain.connect(comp); comp.connect(lim); lim.connect(n.wetGain); n.wetGain.connect(n.masterOut);
    n.masterOut.connect(audioCtx.destination);
    Object.assign(n, { _compressor: comp, _limiter: lim, _paramCache: createAudioParamCache() }); return n;
  }

  function createAudioFeature(sm) {
    let ctx, target = null, currentSrc = null, currentNodes = null; const _audioAC = new AbortController();
    const syncMixAndParams = () => {
      if (!ctx || !currentNodes) return;
      const pc = currentNodes._paramCache, dynAct = !!(sm.get(CONFIG.P.A_EN) && sm.get(CONFIG.P.APP_ACT)), isHooked = !!currentSrc, wetT = (dynAct && isHooked) ? 0.7 : 0;
      pc.sttIfChanged(currentNodes.dryGain.gain, 'dryGain', 1 - wetT, ctx.currentTime, 0.005); pc.sttIfChanged(currentNodes.wetGain.gain, 'wetGain', wetT, ctx.currentTime, 0.005);
      if (!dynAct || !isHooked) return;
      const bLv = Number(sm.get(CONFIG.P.A_BST)) || 0;
      pc.sttIfChanged(currentNodes.boostGain.gain, 'boostGain', Math.pow(10, bLv / 20), ctx.currentTime, 0.05);
    };
    const setTarget = (v) => {
      if (v == null) { detachCurrentSource(); syncMixAndParams(); return; } if (v === target && currentSrc) { syncMixAndParams(); return; }
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; try { ctx = new AC({ latencyHint: 'interactive' }); currentNodes = buildAudioGraph(ctx); } catch (_) { return; } }
      const connect = (vid) => {
        let s = audioSourceMap.get(vid); if (s && s.context !== ctx) { detachAudioSource(vid); s = null; }
        if (!s) { try { s = getOrCreateAudioSource(ctx, vid); } catch (e) { getVState(vid).audioFailUntil = performance.now() + 5000; target = vid; currentSrc = null; syncMixAndParams(); return; } }
        disconnectSafe(s); s.connect(currentNodes.inputGain); currentSrc = s; target = vid; syncMixAndParams();
      };
      if (target && target !== v) detachCurrentSource(); connect(v);
    };
    const detachCurrentSource = () => {
      if (currentSrc && ctx) { disconnectSafe(currentSrc); try { currentSrc.connect(ctx.destination); } catch (_) {} }
      currentSrc = null; target = null;
    };
    return defineFeature({
      name: 'audio', phase: PHASE.PROCESS,
      onInit() { this.subscribe('target:changed', ({ video }) => { const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT)); setTarget((want || currentSrc) ? video : null); }); },
      onUpdate(updateCtx) { const want = !!(this.getSetting(CONFIG.P.A_EN) && this.getSetting(CONFIG.P.APP_ACT)), vid = (want || currentSrc) ? (updateCtx.target || this.getActiveVideo()) : null; if (vid && vid !== target) { const st = getVState(vid); if (performance.now() < (st.audioFailUntil || 0)) return; } setTarget(vid); },
      methods: { warmup: () => { if (ctx?.state === 'suspended') ctx.resume(); }, syncMixAndParams, hasCtx: () => !!ctx },
      async onDestroy() { _audioAC.abort(); detachCurrentSource(); if (ctx) await ctx.close(); ctx = null; currentNodes = null; }
    });
  }

  /* ── Playback Rate Management ────────────────────────────────── */
  function getRateState(v) { const st = getVState(v); if (!st.rateState) st.rateState = { orig: null, lastSetAt: 0, suppressSyncUntil: 0, retryCount: 0 }; return st.rateState; }
  function markInternalRateChange(v, ms = 300) { const st = getRateState(v), now = performance.now(); st.lastSetAt = now; st.suppressSyncUntil = Math.max(st.suppressSyncUntil || 0, now + ms); }
  function restoreRateOne(el) { try { const st = getRateState(el); if (!st || st.orig == null) return; const rate = Number(st.orig) > 0.01 ? Number(st.orig) : 1.0; st.orig = null; markInternalRateChange(el, 500); el.playbackRate = rate; } catch (_) {} }
  function handleExternalRateChange(video, storeRef) {
    const rSt = getRateState(video), now = performance.now(); if (now < (rSt.suppressSyncUntil || 0) || (now - (rSt.lastSetAt || 0)) < 500) return;
    const captured = video.playbackRate; if (!Number.isFinite(captured) || captured < 0.07) return; rSt._pendingExternalRate = captured; rSt._pendingExternalT = now;
    if (rSt._externalMtQueued) return; rSt._externalMtQueued = true;
    queueMicrotask(() => {
      rSt._externalMtQueued = false;
      const finalRate = rSt._pendingExternalRate, activeVideo = __vscNs.App?.getActiveVideo?.();
      if (!storeRef || !activeVideo || video !== activeVideo) return;
      if (!storeRef.get(CONFIG.P.PB_EN)) return;
      const desired = storeRef.get(CONFIG.P.PB_RATE);
      if (Math.abs(finalRate - desired) < 0.01) return;
      markInternalRateChange(video, 250);
      try { video.playbackRate = desired; } catch (_) {}
    });
  }
  function applyPlaybackRate(el, desiredRate) {
    const st = getVState(el), rSt = getRateState(el), now = performance.now(); if (now < (rSt.suppressSyncUntil || 0)) return; if (rSt.orig == null) rSt.orig = el.playbackRate;
    if (Object.is(st.desiredRate, desiredRate) && Math.abs(el.playbackRate - desiredRate) < 0.01) { rSt.retryCount = 0; TOUCHED.rateVideos.add(el); return; }
    if (rSt.retryCount > 6) { rSt.suppressSyncUntil = now + Math.min(6000, 800 << Math.min(rSt.retryCount - 6, 3)); rSt.retryCount = 0; return; }
    st.desiredRate = desiredRate; markInternalRateChange(el, 250); try { el.playbackRate = desiredRate; } catch (_) {} rSt.retryCount++;
    requestAnimationFrame(() => { if (!el.isConnected) return; if (Math.abs(el.playbackRate - desiredRate) > 0.01) { markInternalRateChange(el, 250); try { el.playbackRate = desiredRate; } catch (_) {} rSt.retryCount++; } else { rSt.retryCount = 0; } }); TOUCHED.rateVideos.add(el);
  }
/* ── Video Binding & Pipeline ────────────────────────────────── */
  const bindVideoOnce = (v, ApplyReq, storeRef) => { const st = getVState(v); if (st.bound) return; st.bound = true; st._ac = new AbortController(); const opts = { passive: true, signal: combineSignals(st._ac.signal, __globalSig) }; const reset = () => { queueMicrotask(() => { st.audioFailUntil = 0; st.rect = null; ApplyReq.hard(); }); }; for (const ev of ['loadstart', 'loadedmetadata', 'emptied']) on(v, ev, reset, opts); on(v, 'ratechange', () => handleExternalRateChange(v, storeRef), opts); on(v, 'resize', () => { __vscNs.Filters?.invalidateCache(v); ApplyReq.hard(); }, opts); };
  function batchReadRects(candidates) { for (const el of candidates) { if (!el.isConnected) continue; const st = getVState(el); if (st.rect && st._rectRev === __vscLayoutRev) continue; st.rect = el.getBoundingClientRect(); st._rectRev = __vscLayoutRev; } }

  function reconcileVideoEffects({ applySet, dirtyVideos, getParamsForVideo, desiredRate, pbActive, Adapter, ApplyReq, scratch, activeTarget, storeRef }) {
    const candidates = scratch; candidates.clear(); const isApplyAll = !!storeRef?.get('app.applyAll'), addIfConnected = (v) => { if (v?.isConnected && !candidates.has(v)) candidates.add(v); };
    for (const v of applySet) addIfConnected(v); if (activeTarget) addIfConnected(activeTarget); for (const v of dirtyVideos) addIfConnected(v); if (TOUCHED.videos.size > 0) for (const v of TOUCHED.videos) addIfConnected(v); if (TOUCHED.rateVideos.size > 0) for (const v of TOUCHED.rateVideos) addIfConnected(v);
    batchReadRects(candidates);
    for (const el of candidates) {
      if (!el.isConnected) { TOUCHED.videos.delete(el); TOUCHED.rateVideos.delete(el); const st = getVState(el); if (st) st.desiredRate = undefined; continue; }
      bindVideoOnce(el, ApplyReq, storeRef); const st = getVState(el), shouldApply = applySet.has(el) || el === activeTarget || isApplyAll;
      if (!shouldApply) { if (!st.applied && st.desiredRate === undefined) continue; Adapter.clear(el); TOUCHED.videos.delete(el); st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); continue; }
      const params = getParamsForVideo(el); Adapter.apply(el, params.video, params.shadow); TOUCHED.videos.add(el);
      if (pbActive) applyPlaybackRate(el, desiredRate); else if (st.desiredRate !== undefined) { st.desiredRate = undefined; restoreRateOne(el); TOUCHED.rateVideos.delete(el); }
    }
  }

  function computeResolutionSharpMul(video) {
    const nW = video.videoWidth || 0, nH = video.videoHeight || 0, dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0, dpr = Math.max(1, window.devicePixelRatio || 1);
    if (nW < 16 || dW < 16) return 0.0; const ratio = Math.max((dW * dpr) / nW, (dH * dpr) / Math.max(1, nH)); let mul = 1.0;
    if (ratio < 0.5) mul = 0.25; else if (ratio < 1.0) mul = 0.25 + (ratio - 0.5) * (0.85 - 0.25) / 0.5; else if (ratio <= 1.5) mul = 1.0; else if (ratio <= 2.5) mul = 1.0 + (ratio - 1.5) * 0.20; else mul = Math.max(0.45, 1.20 - (ratio - 2.5) * 0.20);
    if (nW <= 640 && nH <= 480) mul *= 0.40; else if (nW <= 960) mul *= 0.65;
    if (CONFIG.IS_MOBILE) mul *= VSC_CLAMP(1.05 / dpr, 0.55, 0.85); else if (dpr >= 1.25) mul *= VSC_CLAMP(1.5 / dpr, 0.75, 1.0); return VSC_CLAMP(mul, 0.0, 0.85);
  }

  function createVideoParamsMemo() {
    const _cache = new WeakMap();
    return {
      get(vfUser, video) {
        const dW = video?.clientWidth || video?.offsetWidth || 0, nW = video?.videoWidth || 0, hasValid = (nW >= 16 && dW >= 16);
        const resKey = hasValid ? `|${dW}|${nW}` : '|pending';
        const cacheKey = `${vfUser.presetS}|${vfUser.brightLevel}|${vfUser.shadowBandMask}|${vfUser.temp}${resKey}`;
        if (video) { const prev = _cache.get(video); if (prev && prev.key === cacheKey) return prev.result; }

        const detailP = CONFIG.PRESETS.detail[vfUser.presetS || 'off'], brightP = CONFIG.PRESETS.bright[VSC_CLAMP(vfUser.brightLevel || 0, 0, 5)] || CONFIG.PRESETS.bright[0];
        const rawSharpMul = video ? computeResolutionSharpMul(video) : 0.0;
        const finalSharpMul = (rawSharpMul === 0.0 && vfUser.presetS !== 'off') ? 0.50 : rawSharpMul;
        const finalSigmaScale = (video && dW >= 16) ? Math.sqrt(Math.max(640, Math.min(3840, dW)) / 1920) : 1.0;

        const videoOut = { sharp: Math.round((detailP.sharpAdd || 0) * finalSharpMul), sharp2: Math.round((detailP.sharp2Add || 0) * finalSharpMul), satF: detailP.sat || 1.0, gamma: brightP.gammaF || 1.0, bright: brightP.brightAdd || 0, contrast: 1.0, temp: vfUser.temp || 0, _sigmaScale: finalSigmaScale, _refW: Math.max(640, Math.min(3840, dW || 1280)), _microBase: detailP.microBase || 0.20, _microScale: detailP.microScale || (1/120), _fineBase: detailP.fineBase || 0.34, _fineScale: detailP.fineScale || (1/24), _microAmt: detailP.microAmt || [0.55, 0.10], _fineAmt: detailP.fineAmt || [0.22, 0.78] };
        const shadowLevel = Math.min(VSC_CLAMP(vfUser.shadowBandMask || 0, 0, 3) | 0, 3), shadowOut = { level: shadowLevel, active: shadowLevel > 0, factor: 1.0 }, result = { video: videoOut, shadow: shadowOut };
        if (video && hasValid) _cache.set(video, { key: cacheKey, result }); return result;
      }
    };
  }

  function createPipelineFeature(Store, Registry, Adapter, ApplyReq, Targeting, videoParamsMemo) {
    const _applySet = new Set(), _scratchCandidates = new Set();
    return defineFeature({
      name: 'pipeline', phase: PHASE.COMPUTE,
      onUpdate(ctx) {
        const { active, target, vidsDirty, pbActive, isApplyAll, desiredRate } = ctx;
        if (!active) { TOUCHED.videos.forEach(v => { Adapter.clear(v); getVState(v).desiredRate = undefined; restoreRateOne(v); }); TOUCHED.rateVideos.forEach(v => { getVState(v).desiredRate = undefined; restoreRateOne(v); }); TOUCHED.videos.clear(); TOUCHED.rateVideos.clear(); return; }
        const vf0 = Store.getCatRef('video'), getParamsForVideo = (el) => videoParamsMemo.get(vf0, el);
        _applySet.clear(); if (isApplyAll) for (const v of Registry.visible.videos) _applySet.add(v); if (target) _applySet.add(target);
        reconcileVideoEffects({ applySet: _applySet, dirtyVideos: vidsDirty, getParamsForVideo, desiredRate, pbActive, Adapter, ApplyReq, scratch: _scratchCandidates, activeTarget: target, storeRef: Store });
      },
      onDestroy() { TOUCHED.videos.forEach(v => safe(() => Adapter.clear(v))); TOUCHED.rateVideos.forEach(v => safe(() => restoreRateOne(v))); TOUCHED.videos.clear(); TOUCHED.rateVideos.clear(); }
    });
  }

  /* ── Hybrid Filter Engine ────────────────────────────────────── */
  function createFiltersVideoOnly(Utils, config) {
    const { h } = Utils, ctxMap = new WeakMap(), __vscBgMemo = new WeakMap();
    const SHADOW_TABLES = {
      1: '0 0.19 0.34 0.51 0.68 0.85 1',
      2: '0 0.18 0.33 0.51 0.68 0.85 1',
      3: '0 0.17 0.32 0.51 0.68 0.85 1'
    };

    function buildCssFilterString(s) {
      const parts = []; const gamma = s.gamma || 1, brightAdd = s.bright || 0; let bf = 1.0;
      if (Math.abs(brightAdd) > 0.5) bf *= (1.0 + brightAdd / 250); if (Math.abs(gamma - 1.0) > 0.01) bf *= Math.pow(gamma, 0.5); if (Math.abs(bf - 1.0) > 0.001) parts.push(`brightness(${bf.toFixed(4)})`);
      let cf = s.contrast || 1; if (Math.abs(gamma - 1.0) > 0.01) cf *= (1 + (gamma - 1) * 0.15); if (Math.abs(cf - 1.0) > 0.005) parts.push(`contrast(${cf.toFixed(4)})`);
      const sat = s.satF ?? 1; if (Math.abs(sat - 1.0) > 0.005) parts.push(`saturate(${sat.toFixed(3)})`);

      const temp = s.temp || 0;
      if (temp !== 0) {
        const absT = Math.abs(temp);
        if (temp > 0) {
          const sepiaAmount = Math.min(absT / 200, 0.15);
          const hueShift = temp * -0.2;
          const satRestore = 1.0 + absT / 350;
          if (sepiaAmount > 0.005) parts.push(`sepia(${sepiaAmount.toFixed(3)})`);
          if (Math.abs(hueShift) > 0.1) parts.push(`hue-rotate(${hueShift.toFixed(1)}deg)`);
          if (satRestore > 1.005) parts.push(`saturate(${satRestore.toFixed(3)})`);
        } else {
          const satDamp = Math.max(0.85, 1.0 - absT / 500);
          const hueShift = absT * 0.3;
          if (Math.abs(satDamp - 1.0) > 0.005) parts.push(`saturate(${satDamp.toFixed(3)})`);
          if (hueShift > 0.1) parts.push(`hue-rotate(${hueShift.toFixed(1)}deg)`);
        }
      }
      return parts.join(' ');
    }

    function needsSvgFilter(s, shadowParams) { return (s.sharp | 0) > 0 || (s.sharp2 | 0) > 0 || (shadowParams && shadowParams.active); }

    function ensureOpaqueBg(video) {
      if (!video || __vscBgMemo.has(video) || !config.FLAGS?.FILTER_FORCE_OPAQUE_BG) return;
      try { const cs = getComputedStyle(video).backgroundColor, isTransparent = !cs || cs === 'transparent' || cs.endsWith(', 0)') || cs.endsWith(',0)'); if (isTransparent) { __vscBgMemo.set(video, video.style.backgroundColor || ''); video.style.backgroundColor = '#000'; } else { __vscBgMemo.set(video, null); } } catch (_) {}
    }
    function restoreOpaqueBg(video) { if (!video) return; const prev = __vscBgMemo.get(video); if (prev === undefined) return; __vscBgMemo.delete(video); if (prev !== null) video.style.backgroundColor = prev; }

    function buildSvg(root) {
      const fidMain = `vsc-main-${config.VSC_ID}`, svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden;' }), defs = h('defs', { ns: 'svg' }); svg.append(defs);
      const mkFuncRGB = (attrs) => [h('feFuncR', { ns: 'svg', ...attrs }), h('feFuncG', { ns: 'svg', ...attrs }), h('feFuncB', { ns: 'svg', ...attrs })], mainFilter = h('filter', { ns: 'svg', id: fidMain, 'color-interpolation-filters': 'sRGB', x: '-8%', y: '-8%', width: '116%', height: '116%' });

      const shadowToneFuncs = mkFuncRGB({ type: 'table', tableValues: '0 1' }), shadowToneXfer = h('feComponentTransfer', { ns: 'svg', in: 'SourceGraphic', result: 'shadow' }, ...shadowToneFuncs);
      const blurMicro = h('feGaussianBlur', { ns: 'svg', in: 'shadow', stdDeviation: '0.22', result: 'bMicro' }), usmMicro = h('feComposite', { ns: 'svg', in: 'shadow', in2: 'bMicro', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpMicro' }), blurFine = h('feGaussianBlur', { ns: 'svg', in: 'shadow', stdDeviation: '0.60', result: 'bFine' }), usmFine = h('feComposite', { ns: 'svg', in: 'shadow', in2: 'bFine', operator: 'arithmetic', k1: '0', k2: '1', k3: '0', k4: '0', result: 'sharpFine' }), blend = h('feComposite', { ns: 'svg', in: 'sharpMicro', in2: 'sharpFine', operator: 'arithmetic', k1: '0', k2: '0.55', k3: '0.45', k4: '0', result: 'sharpOut' });

      mainFilter.append(shadowToneXfer, blurMicro, usmMicro, blurFine, usmFine, blend); defs.append(mainFilter);
      const tryAppend = () => { const tgt = root.body || root.documentElement || root; if (tgt?.appendChild) { tgt.appendChild(svg); return true; } return false; };
      if (!tryAppend() && root.nodeType === 9) {
        const mo = new MutationObserver(() => { if (tryAppend()) mo.disconnect(); });
        try { mo.observe(root.documentElement || root, { childList: true, subtree: true }); } catch (_) {}
        setTimeout(() => mo.disconnect(), 5000);
      }
      return { fidMain, sharp: { blurMicro, usmMicro, blurFine, usmFine, blend }, color: { shadowToneFuncs }, st: { lastKey: '', blurKey: '', sharpKey: '', shadowKey: '' } };
    }

    function updateSharpNodes(nodes, st, s, sharpTotal) {
      if (sharpTotal > 0) {
        const qSharp = Math.max(0, Math.round(Number(s.sharp || 0))), qSharp2 = Math.max(0, Math.round(Number(s.sharp2 || 0))), sigmaScale = Number(s._sigmaScale) || 1.0, microBase = Number(s._microBase) || 0.18, microScale = Number(s._microScale) || (1/120), fineBase = Number(s._fineBase) || 0.32, fineScale = Number(s._fineScale) || (1/24), microAmtCoeffs = s._microAmt || [0.55, 0.10], fineAmtCoeffs = s._fineAmt || [0.20, 0.85], sigMicro = VSC_CLAMP((microBase + qSharp * microScale) * Math.min(1.0, sigmaScale), 0.30, 1.20), sigFine = VSC_CLAMP((fineBase + qSharp2 * fineScale) * sigmaScale, 0.18, 2.50), microAmt = VSC_CLAMP((qSharp * microAmtCoeffs[0] + qSharp2 * microAmtCoeffs[1]) / 45, 0, 1.5), fineAmt = VSC_CLAMP((qSharp * fineAmtCoeffs[0] + qSharp2 * fineAmtCoeffs[1]) / 24, 0, 1.2), totalAmt = microAmt + fineAmt + 1e-6, microWeight = VSC_CLAMP(0.35 + 0.30 * (microAmt / totalAmt), 0.25, 0.70), fineWeight = 1.0 - microWeight, blurKeyNext = `${sigMicro.toFixed(3)}|${sigFine.toFixed(3)}`;
        if (st.blurKey !== blurKeyNext) { st.blurKey = blurKeyNext; nodes.sharp.blurMicro.setAttribute('stdDeviation', sigMicro.toFixed(3)); nodes.sharp.blurFine.setAttribute('stdDeviation', sigFine.toFixed(3)); }
        const sharpKeyNext = `${microAmt.toFixed(5)}|${fineAmt.toFixed(5)}`; if (st.sharpKey !== sharpKeyNext) { st.sharpKey = sharpKeyNext; nodes.sharp.usmMicro.setAttribute('k2', (1 + microAmt).toFixed(5)); nodes.sharp.usmMicro.setAttribute('k3', (-microAmt).toFixed(5)); nodes.sharp.usmFine.setAttribute('k2', (1 + fineAmt).toFixed(5)); nodes.sharp.usmFine.setAttribute('k3', (-fineAmt).toFixed(5)); nodes.sharp.blend.setAttribute('k2', microWeight.toFixed(4)); nodes.sharp.blend.setAttribute('k3', fineWeight.toFixed(4)); }
      } else { const bypassKey = 'bypass'; if (st.sharpKey !== bypassKey) { st.sharpKey = bypassKey; st.blurKey = bypassKey; nodes.sharp.blurMicro.setAttribute('stdDeviation', '0'); nodes.sharp.blurFine.setAttribute('stdDeviation', '0'); nodes.sharp.usmMicro.setAttribute('k2', 1); nodes.sharp.usmMicro.setAttribute('k3', 0); nodes.sharp.usmFine.setAttribute('k2', 1); nodes.sharp.usmFine.setAttribute('k3', 0); nodes.sharp.blend.setAttribute('k2', 1); nodes.sharp.blend.setAttribute('k3', 0); } }
    }

    function updateColorNodes(nodes, st, shadowParams) {
      if (shadowParams && shadowParams.active) { const level = shadowParams.level || 0, factor = shadowParams.factor !== undefined ? shadowParams.factor : 1.0, shadowKey = `crush_v4|${level}|${factor.toFixed(3)}`; if (st.shadowKey !== shadowKey) { st.shadowKey = shadowKey; const tv = SHADOW_TABLES[level] || SHADOW_TABLES[1]; for (const fn of nodes.color.shadowToneFuncs) fn.setAttribute('tableValues', tv); } } else { const neutralKey = 'shadow_off'; if (st.shadowKey !== neutralKey) { st.shadowKey = neutralKey; for (const fn of nodes.color.shadowToneFuncs) fn.setAttribute('tableValues', '0 1'); } }
    }

    function getSvgUrl(video, s, shadowParams) {
      const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document); ensureOpaqueBg(video);
      const sharpTotal = Math.round(Number(s.sharp || 0)) + Math.round(Number(s.sharp2 || 0)), shadowActive = !!(shadowParams && shadowParams.active), stableKey = `u|${s.sharp}|${s.sharp2}|${(s._sigmaScale||1).toFixed(2)}|sh:${shadowActive ? 'lv' + shadowParams.level : 'off'}`;
      let nodes = ctxMap.get(root); if (!nodes) { nodes = buildSvg(root); ctxMap.set(root, nodes); }
      if (nodes.st.lastKey !== stableKey) { nodes.st.lastKey = stableKey; updateSharpNodes(nodes, nodes.st, s, sharpTotal); updateColorNodes(nodes, nodes.st, shadowParams); }
      return `url(#${nodes.fidMain})`;
    }

    return {
      invalidateCache: (video) => { try { const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document); const nodes = ctxMap.get(root); if (nodes) { nodes.st.lastKey = ''; nodes.st.blurKey = ''; nodes.st.sharpKey = ''; nodes.st.shadowKey = ''; } } catch (_) {} },
      applyCombined: (video, vVals, shadowParams) => {
        const st = getVState(video);
        ensureOpaqueBg(video);
        let finalFilter = buildCssFilterString(vVals);
        const svgNeeded = needsSvgFilter(vVals, shadowParams);

        if (svgNeeded) {
           const svgUrl = getSvgUrl(video, vVals, shadowParams);
           finalFilter = finalFilter ? `${svgUrl} ${finalFilter}` : svgUrl;
        }

        if (!finalFilter) {
           restoreOpaqueBg(video);
           if (st.applied) {
             video.style.removeProperty('transition');
             if (st.origFilter != null && st.origFilter !== '') video.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else video.style.removeProperty('filter');
             st.applied = false; st.lastFilterUrl = null; st.origFilter = null; st.origFilterPrio = '';
           }
           return;
        }

        if (!st.applied) {
           st.origFilter = video.style.getPropertyValue('filter'); st.origFilterPrio = video.style.getPropertyPriority('filter') || '';
        }

        if (st.lastFilterUrl !== finalFilter) {
           if (svgNeeded) {
             video.style.setProperty('transition', 'none', 'important');
           } else {
             video.style.setProperty('transition', 'filter 0.5s ease', 'important');
           }
           video.style.setProperty('filter', finalFilter, 'important');
           st.applied = true; st.lastFilterUrl = finalFilter;
        }
      },
      clear: (video) => {
        const st = getVState(video);
        if (st.applied) {
          restoreOpaqueBg(video);
          video.style.removeProperty('transition');
          if (st.origFilter != null && st.origFilter !== '') video.style.setProperty('filter', st.origFilter, st.origFilterPrio || ''); else video.style.removeProperty('filter');
          st.applied = false; st.lastFilterUrl = null; st.origFilter = null; st.origFilterPrio = '';
        }
      }
    };
  }

  function createBackendAdapter(Filters) {
    return {
      apply(video, vVals, shadowParams) { Filters.applyCombined(video, vVals, shadowParams); },
      clear(video) { Filters.clear(video); }
    };
  }

  /* ── Targeting ───────────────────────────────────────────────── */
  function createTargeting() {
    let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
    const isInPlayer = (vid) => { if (vid.closest(PLAYER_CONTAINER_SELECTORS)) return true; const root = vid.getRootNode(); if (root instanceof ShadowRoot && root.host) return !!root.host.closest(PLAYER_CONTAINER_SELECTORS); return false; };
    function getViewportSnapshot() { const vv = window.visualViewport; if (vv) return { w: vv.width, h: vv.height, cx: vv.offsetLeft + vv.width * 0.5, cy: vv.offsetTop + vv.height * 0.5 }; return { w: innerWidth, h: innerHeight, cx: innerWidth * 0.5, cy: innerHeight * 0.5 }; }

    function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
      if (videos.size === 0) return { target: null };
      if (videos.size === 1) { const v = videos.values().next().value; return { target: (v?.readyState >= 1) ? v : null }; }

      const now = performance.now(), vp = getViewportSnapshot();
      let best = null, bestScore = -Infinity;

      const evalScore = (v) => {
        if (!v || v.readyState < 2) return;
        if (typeof v.checkVisibility === 'function') { try { if (!v.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return; } catch (_) {} }

        // [Patch 17 적용] 캐시된 rect를 최우선으로 사용하여 Layout Thrashing 방지
        const st = getVState(v);
        const r = st.rect || v.getBoundingClientRect();
        const area = (r?.width || 0) * (r?.height || 0);
        const hasDecoded = ((v.videoWidth | 0) > 0) && ((v.videoHeight | 0) > 0);

        if (!hasDecoded && area < 160 * 120) return;

        const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5; let s = 0;
        if (!v.paused && !v.ended) s += 6.0; else if (v.currentTime > 5.0 && (v.duration || 0) > 30) s += 3.0;
        if (v.currentTime > 0.2) s += 2.0; s += Math.log2(1 + area / 20000) * 1.1;
        const ptAge = Math.max(0, now - (lastUserPt.t || 0)), userBias = Math.exp(-ptAge / 1800), dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
        s += (2.0 * userBias) / (1 + (dx * dx + dy * dy) / 722500); const cdx = cx - vp.cx, cdy = cy - vp.cy; s += 0.7 / (1 + (cdx * cdx + cdy * cdy) / 810000);
        if (v.muted || v.volume < 0.01) s -= 1.5; if (v.autoplay && (v.muted || v.volume < 0.01)) s -= 2.0;
        if (!v.controls && !isInPlayer(v)) s -= 1.0; if (!v.muted && v.volume > 0.01) s += (audioBoostOn ? 2.2 : 1.2);

        const vSrc = v.currentSrc || v.src || '';
        if (vSrc.startsWith('blob:')) s += 1.5;

        if (s > bestScore) { bestScore = s; best = v; }
      };

      for (const v of videos) evalScore(v);
      const hysteresis = Math.min(1.5, 0.5 + videos.size * 0.15);
      if (stickyTarget?.isConnected && now < stickyUntil && best && stickyTarget !== best && bestScore < stickyScore + hysteresis) return { target: stickyTarget };
      stickyTarget = best; stickyScore = bestScore; stickyUntil = now + 1000; return { target: best };
    }
    return Object.freeze({ pickFastActiveOnly });
  }

  /* ── UI, Zoom ────────────────────────────────────────────────── */
  function showToast(text) { const v = __vscNs.App?.getActiveVideo(), target = v?.parentNode?.isConnected ? v.parentNode : (document.body || document.documentElement); if (!target) return; let t = target.querySelector('.vsc-toast'); if (!t) { t = document.createElement('div'); t.className = 'vsc-toast'; t.style.cssText = 'position:absolute !important;bottom:15% !important;left:50% !important;transform:translateX(-50%) !important;background:rgba(0,0,0,0.82) !important;color:#fff !important;padding:8px 18px !important;border-radius:20px !important;font:600 13.5px/1.3 system-ui,sans-serif !important;z-index:2147483647 !important;pointer-events:none !important;opacity:0 !important;transition:opacity 0.2s ease-in-out !important;backdrop-filter:blur(6px) !important;border:1px solid rgba(255,255,255,0.15) !important;white-space:pre-line !important;letter-spacing:-0.3px !important;'; if (target !== document.body && getComputedStyle(target).position === 'static') target.style.position = 'relative'; target.appendChild(t); } t.textContent = text; t.style.setProperty('opacity', '1', 'important'); clearTimeout(t._tid); t._tid = setTimeout(() => { if (t) t.style.setProperty('opacity', '0', 'important'); }, 1500); }
  __vscNs.showToast = showToast;
  function seekVideo(video, offset) { const sr = video.seekable; let minT = 0, maxT = video.duration; const isLive = !Number.isFinite(maxT); if (isLive) { if (!sr || sr.length === 0) return; minT = sr.start(0); maxT = sr.end(sr.length - 1); } const target = VSC_CLAMP(video.currentTime + offset, minT, maxT - (isLive ? 2.0 : 0.1)); try { video.currentTime = target; } catch (_) {} }
  function execVideoAction(action, val) { const v = __vscNs.App?.getActiveVideo(); if (!v) return; if (action === 'play') v.play().catch(() => {}); else if (action === 'pause') v.pause(); else if (action === 'seek') seekVideo(v, val); }

  function bindElementDrag(el, onMove, onEnd) { const ac = new AbortController(); on(el, 'pointermove', (e) => { if (e.cancelable) e.preventDefault(); onMove?.(e); }, { passive: false, signal: ac.signal }); const up = (e) => { ac.abort(); try { el.releasePointerCapture(e.pointerId); } catch (_) {} onEnd?.(e); }; on(el, 'pointerup', up, { signal: ac.signal }); on(el, 'pointercancel', up, { signal: ac.signal }); return () => ac.abort(); }

  function createUI(sm, registry, ApplyReq, Utils, P) {
    const { h } = Utils; let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0, wakeGear = null, hasUserDraggedUI = false; const uiWakeCtrl = new AbortController(), uiUnsubs = []; const sub = (k, fn) => { const unsub = sm.sub(k, fn); uiUnsubs.push(unsub); return fn; };
    const detachNodesHard = () => { removeSafe(container); removeSafe(gearHost); };
    const allowUiInThisDoc = () => { const hn = location.hostname, pn = location.pathname; if (hn.includes('netflix.com')) return pn.startsWith('/watch'); if (hn.includes('coupangplay.com')) return pn.startsWith('/play'); return true; };
    const getUiRoot = () => { const fs = document.fullscreenElement; return fs ? (fs.tagName === 'VIDEO' ? (fs.parentElement || document.documentElement || document.body) : fs) : (document.body || document.documentElement); };
    const setAndHint = (path, value) => { if (!Object.is(sm.get(path), value)) { sm.set(path, value); (path === P.APP_ACT || path === P.APP_APPLY_ALL || path.startsWith('video.')) ? ApplyReq.hard() : ApplyReq.soft(); } };
    function bindReactive(btn, paths, apply) { const pathArr = Array.isArray(paths) ? paths : [paths]; let pending = false, destroyed = false; const sync = () => { if (pending || destroyed) return; pending = true; queueMicrotask(() => { pending = false; if (!destroyed && btn?.isConnected !== false) apply(btn, ...pathArr.map(p => sm.get(p))); }); }; pathArr.forEach(p => sub(p, sync)); if (btn) apply(btn, ...pathArr.map(p => sm.get(p))); return sync; }
    function bindActGate(btn, extraPaths, applyFn) { return bindReactive(btn, [...(Array.isArray(extraPaths) ? extraPaths : []), P.APP_ACT], (el, ...vals) => { const act = vals[vals.length - 1]; el.style.setProperty('opacity', act ? '1' : '0.45', 'important'); el.style.setProperty('cursor', act ? 'pointer' : 'not-allowed', 'important'); el.disabled = !act; if (applyFn) applyFn(el, ...vals); }); }
    const guardedClick = (fn) => (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; fn(e); };

    function renderButtonRow({ label, items, key, offValue = 0 }) {
      const row = h('div', { class: 'prow' }, h('div', { style: 'font-size:11px !important;width:35px !important;line-height:34px !important;font-weight:bold !important;' }, label));
      const onChange = (val) => { if (!sm.get(P.APP_ACT)) return; const cur = sm.get(key); if (offValue !== null && cur === val && val !== offValue) setAndHint(key, offValue); else setAndHint(key, val); };
      for (const it of items) { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, it.text); b.onclick = (e) => { e.stopPropagation(); onChange(it.value); }; bindReactive(b, [key, P.APP_ACT], (el, v, act) => { const isActive = v === it.value; el.classList.toggle('active', isActive); el.style.setProperty('opacity', act ? '1' : (isActive ? '0.65' : '0.45'), 'important'); el.style.setProperty('cursor', act ? 'pointer' : 'not-allowed', 'important'); el.disabled = !act; }); row.append(b); }
      if (offValue != null) { const offBtn = h('button', { class: 'pbtn', style: 'flex:0.9 !important;' }, 'OFF'); offBtn.onclick = (e) => { e.stopPropagation(); if (!sm.get(P.APP_ACT)) return; setAndHint(key, offValue); }; bindReactive(offBtn, [key, P.APP_ACT], (el, v, act) => { const isOff = v === offValue; el.classList.toggle('active', isOff); el.style.setProperty('opacity', act ? '1' : (isOff ? '0.65' : '0.45'), 'important'); el.style.setProperty('cursor', act ? 'pointer' : 'not-allowed', 'important'); el.disabled = !act; }); row.append(offBtn); }
      return row;
    }

    const clampPanelIntoViewport = () => {
      try { const mainPanel = container?.shadowRoot?.querySelector('.main'); if (!mainPanel || mainPanel.style.display === 'none') return;
        if (!hasUserDraggedUI) { mainPanel.style.removeProperty('left'); mainPanel.style.removeProperty('transform'); mainPanel.style.setProperty('right', 'var(--vsc-safe-right)', 'important'); mainPanel.style.setProperty('top', 'calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2))', 'important'); mainPanel.style.setProperty('display', 'block', 'important'); return; }
        const r = mainPanel.getBoundingClientRect(), vv = window.visualViewport, vw = vv?.width || window.innerWidth || 0, vh = vv?.height || window.innerHeight || 0, offL = vv?.offsetLeft || 0, offT = vv?.offsetTop || 0; if (!vw || !vh) return;
        const left = VSC_CLAMP(r.left, offL + 8, Math.max(offL + 8, offL + vw - (r.width || 300) - 8)), top = VSC_CLAMP(r.top, offT + 8, Math.max(offT + 8, offT + vh - (r.height || 400) - 8));
        mainPanel.style.setProperty('right', 'auto', 'important'); mainPanel.style.setProperty('transform', 'none', 'important'); mainPanel.style.setProperty('left', `${left}px`, 'important'); mainPanel.style.setProperty('top', `${top}px`, 'important');
      } catch (_) {}
    };

    const syncVVVars = () => { try { const root = document.documentElement, vv = window.visualViewport; if (!root) return; if (!vv) { root.style.setProperty('--vsc-vv-top', '0px'); root.style.setProperty('--vsc-vv-h', `${window.innerHeight}px`); return; } root.style.setProperty('--vsc-vv-top', `${Math.round(vv.offsetTop)}px`); root.style.setProperty('--vsc-vv-h', `${Math.round(vv.height)}px`); } catch (_) {} };
    syncVVVars(); let _clampRafId = 0; const onLayoutChange = () => { if (_clampRafId) return; _clampRafId = requestAnimationFrame(() => { _clampRafId = 0; clampPanelIntoViewport(); }); }; const uiSig = combineSignals(uiWakeCtrl.signal, __globalSig); try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); on(vv, 'scroll', () => { syncVVVars(); onLayoutChange(); }, { passive: true, signal: uiSig }); } } catch (_) {} on(window, 'resize', onLayoutChange, { passive: true, signal: uiSig });
    on(document, 'fullscreenchange', () => { const isFs = !!document.fullscreenElement; if (isFs) { if (container) container._prevUiState = sm.get(P.APP_UI); if (sm.get(P.APP_UI)) sm.set(P.APP_UI, false); } else { if (container?._prevUiState) { sm.set(P.APP_UI, true); container._prevUiState = false; } } setTimeout(() => { mount(); clampPanelIntoViewport(); }, 100); }, { passive: true, signal: uiSig });
    const getMainPanel = () => container?.shadowRoot?.querySelector('.main');
    function attachShadowStyles(shadowRoot, cssText) { try { if ('adoptedStyleSheets' in shadowRoot && typeof CSSStyleSheet !== 'undefined') { const sheet = new CSSStyleSheet(); sheet.replaceSync(cssText); shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]; return; } } catch (_) {} const styleEl = document.createElement('style'); styleEl.textContent = cssText; shadowRoot.appendChild(styleEl); }

    const CSS_VARS = `:host{--bg:rgba(18,18,22,.97);--bg-elevated:rgba(35,35,42,.95);--c:#e8e8ec;--c-dim:#888;--b:1px solid rgba(255,255,255,.12);--btn-bg:rgba(255,255,255,.06);--btn-bg-hover:rgba(255,255,255,.12);--ac:#4a9eff;--ac-glow:rgba(74,158,255,.15);--danger:#ff4757;--success:#2ed573;--br:8px;--gap:6px;--font:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;--vsc-safe-right:max(70px,calc(env(safe-area-inset-right,0px) + 70px))}*,*::before,*::after{box-sizing:border-box}`;
    const PANEL_CSS = `${CSS_VARS}.main{position:fixed!important;top:calc(var(--vsc-vv-top,0px) + (var(--vsc-vv-h,100vh) / 2))!important;right:var(--vsc-safe-right)!important;transform:translateY(-50%)!important;width:min(320px,calc(100vw - 24px))!important;background:var(--bg)!important;backdrop-filter:blur(12px)!important;color:var(--c)!important;padding:15px!important;border-radius:16px!important;z-index:2147483647!important;border:1px solid rgba(255,255,255,.08)!important;font-family:var(--font)!important;box-shadow:0 16px 64px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.05)!important;overflow-y:auto!important;max-height:95vh!important;-webkit-overflow-scrolling:touch!important;display:none}.main.visible{display:block!important}@media(max-width:520px){.main{width:calc(100vw - 24px)!important;max-width:300px!important;max-height:65vh!important;padding:10px!important;font-size:12px!important}.main::-webkit-scrollbar{width:3px!important}.main::-webkit-scrollbar-thumb{background:#666!important;border-radius:10px!important}.prow{gap:4px!important}.btn,.pbtn{min-height:38px!important;font-size:11px!important}.tab{padding:8px 0!important;font-size:11px!important}}.btn,.pbtn{border:var(--b)!important;background:var(--btn-bg)!important;color:var(--c)!important;border-radius:var(--br)!important;cursor:pointer!important;font-weight:600!important;font-family:var(--font)!important;transition:background .12s,border-color .12s,color .12s!important;display:flex!important;align-items:center!important;justify-content:center!important;padding:10px 0!important;flex:1!important}.pbtn{padding:10px 6px!important}.btn:hover,.pbtn:hover{background:var(--btn-bg-hover)!important}.btn.active,.pbtn.active{background:var(--ac-glow)!important;border-color:var(--ac)!important;color:var(--ac)!important}.prow{display:flex!important;gap:var(--gap)!important;align-items:center!important}hr{border:0!important;border-top:1px solid rgba(255,255,255,.14)!important;margin:8px 0!important}`;
    const TAB_CSS = `${PANEL_CSS}.tabs{display:flex!important;border-bottom:2px solid #444!important;margin:0 -15px!important;padding:0 15px!important}.tab{flex:1!important;padding:10px 0!important;text-align:center!important;font-size:12px!important;font-weight:700!important;cursor:pointer!important;color:var(--c-dim)!important;border-bottom:2px solid transparent!important;margin-bottom:-2px!important;transition:color .15s,border-color .15s!important}.tab.active{color:var(--ac)!important;border-bottom-color:var(--ac)!important}.tab-content{display:none!important;flex-direction:column!important;gap:6px!important;padding-top:12px!important}.tab-content.active{display:flex!important}.header{display:flex!important;align-items:center!important;justify-content:space-between!important;cursor:move!important;padding-bottom:10px!important;border-bottom:none!important;margin-bottom:0!important}.header-title{font-size:14px!important;font-weight:700!important}.header-actions{display:flex!important;gap:6px!important}.header-actions .btn{padding:6px 12px!important;font-size:11px!important;min-width:auto!important}`;
    const GEAR_CSS = `.gear{--size:46px;position:fixed!important;top:50%!important;right:max(10px,calc(env(safe-area-inset-right,0px) + 10px))!important;transform:translateY(-50%)!important;width:var(--size)!important;height:var(--size)!important;border-radius:50%!important;background:rgba(25,25,25,.92)!important;backdrop-filter:blur(10px)!important;border:1px solid rgba(255,255,255,.18)!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:center!important;font:700 22px/1 sans-serif!important;cursor:pointer!important;pointer-events:auto!important;z-index:2147483647!important;box-shadow:0 12px 44px rgba(0,0,0,.55)!important;user-select:none!important;transition:transform .12s ease,opacity .3s ease!important;opacity:1!important;-webkit-tap-highlight-color:transparent!important}.gear:not(.open){opacity:0.45!important}.gear.open{outline:2px solid rgba(52,152,219,.85)!important;opacity:1!important}.gear.inactive{opacity:.45!important}`;

    const build = () => {
      if (container) return;
      const host = h('div', { id: `vsc-host-${CONFIG.VSC_ID}`, 'data-vsc-ui': '1', 'data-vsc-id': CONFIG.VSC_ID });
      const shadow = host.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, TAB_CSS);

      const pwrBtn = h('button', { class: 'btn' }, '⚡');
      pwrBtn.onclick = () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT));
      bindReactive(pwrBtn, [P.APP_ACT], (el, v) => { el.style.setProperty('color', v ? 'var(--success)' : 'var(--danger)', 'important'); el.style.setProperty('border-color', v ? 'var(--success)' : 'var(--danger)', 'important'); });

      const closeBtn = h('button', { class: 'btn', onclick: (e) => { e.stopPropagation(); sm.set(P.APP_UI, false); } }, '✕');
      const resetBtn = h('button', { class: 'btn' }, '↺');
      resetBtn.onclick = guardedClick(() => { sm.batch('video', CONFIG.DEFAULTS.video); sm.batch('audio', CONFIG.DEFAULTS.audio); sm.batch('playback', CONFIG.DEFAULTS.playback); ApplyReq.hard(); showToast('초기화 완료'); });

      const dragHandle = h('div', { class: 'header' }, h('div', { class: 'header-title' }, 'VSC'), h('div', { class: 'header-actions' }, pwrBtn, resetBtn, closeBtn));

      const tabNames = ['영상', '소리', '재생']; const tabBtns = [], tabContents = []; let activeTabIdx = 0;
      const switchTab = (idx) => { activeTabIdx = idx; tabBtns.forEach((b, i) => b.classList.toggle('active', i === idx)); tabContents.forEach((c, i) => c.classList.toggle('active', i === idx)); };
      for (let i = 0; i < tabNames.length; i++) { const btn = h('div', { class: `tab${i === 0 ? ' active' : ''}` }, tabNames[i]); btn.onclick = (e) => { e.stopPropagation(); switchTab(i); }; tabBtns.push(btn); }
      const tabBar = h('div', { class: 'tabs' }, ...tabBtns);

      const videoTab = h('div', { class: 'tab-content active' },
        renderButtonRow({ label: '선명', key: P.V_PRE_S, offValue: 'off', items: [{ text: 'Soft', value: 'Soft' }, { text: 'Med', value: 'Medium' }, { text: 'Ultra', value: 'Ultra' }, { text: 'MST', value: 'Master' }] }),
        renderButtonRow({ label: '밝기', key: P.V_BRIGHT_LV, offValue: 0, items: [{ text: '1', value: 1 }, { text: '2', value: 2 }, { text: '3', value: 3 }, { text: '4', value: 4 }, { text: '5', value: 5 }] }),
        renderButtonRow({ label: '블랙', key: P.V_SHADOW_MASK, offValue: 0, items: [{ text: '-2', value: CONFIG.DARK_BAND.LV1 }, { text: '-1', value: CONFIG.DARK_BAND.LV2 }, { text: '+1', value: CONFIG.DARK_BAND.LV3 }] }),
        renderButtonRow({ label: '색온', key: P.V_TEMP, offValue: 0, items: [{ text: '보호', value: 35 }, { text: '따뜻', value: 18 }, { text: '맑음', value: -15 }, { text: '냉색', value: -30 }] }),
        (() => { const zoomBtn = h('button', { class: 'btn', style: 'width:100% !important;' }, '🔍 줌 토글'); zoomBtn.onclick = guardedClick(() => { const zm = __vscNs.ZoomManager, v = __vscNs.App?.getActiveVideo(); if (!zm || !v) return; if (zm.isZoomed(v)) { zm.resetZoom(v); setAndHint(P.APP_ZOOM_EN, false); } else { const rect = v.getBoundingClientRect(); zm.zoomTo(v, 1.5, rect.left + rect.width / 2, rect.top + rect.height / 2); setAndHint(P.APP_ZOOM_EN, true); } }); bindActGate(zoomBtn, [P.APP_ZOOM_EN], (el, v) => el.classList.toggle('active', !!v)); return zoomBtn; })()
      ); tabContents.push(videoTab);

      const boostToggle = h('button', { class: 'btn', style: 'width:100% !important;' }, '🔊 Audio Mastering'); boostToggle.onclick = guardedClick(() => { __vscNs.AudioWarmup?.(); setAndHint(P.A_EN, !sm.get(P.A_EN)); }); bindActGate(boostToggle, [P.A_EN], (el, aEn) => { el.classList.toggle('active', !!aEn); el.style.setProperty('color', aEn ? 'var(--ac)' : '#eee', 'important'); });
      const boostRow = renderButtonRow({ label: '음량', key: P.A_BST, offValue: 0, items: [{ text: '+3', value: 3 }, { text: '+6', value: 6 }, { text: '+9', value: 9 }, { text: '+12', value: 12 }] }); bindReactive(boostRow, [P.A_EN, P.APP_ACT], (el, aEn, act) => { const on = act && aEn; el.style.setProperty('opacity', on ? '1' : '0.45', 'important'); el.style.setProperty('pointer-events', on ? 'auto' : 'none', 'important'); });
      const audioTab = h('div', { class: 'tab-content' }, boostToggle, boostRow); tabContents.push(audioTab);

      const speedBtns = h('div', { class: 'prow', style: 'flex-wrap:wrap !important;gap:4px !important;' }, ...[0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;min-height:36px !important;' }, s + 'x'); b.onclick = guardedClick(() => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }); bindActGate(b, [P.PB_RATE, P.PB_EN], (el, rate, en) => el.classList.toggle('active', !!en && Math.abs(Number(rate || 1) - s) < 0.01)); return b; }));
      const fineRow = h('div', { class: 'prow', style: 'gap:4px !important;' }, (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '- 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.max(0.1, Math.round((cur - 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); return b; })(), (() => { const lbl = h('div', { style: 'flex:2 !important;text-align:center !important;font-size:13px !important;font-weight:bold !important;line-height:36px !important;' }, '1.00x'); bindReactive(lbl, [P.PB_RATE, P.PB_EN], (el, rate, en) => { const r = Number(rate) || 1.0; el.textContent = en ? `${r.toFixed(2)}x` : '1.00x'; el.style.setProperty('color', en && Math.abs(r - 1.0) > 0.01 ? 'var(--ac)' : '#eee', 'important'); }); return lbl; })(), (() => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;' }, '+ 0.05'); b.onclick = guardedClick(() => { const cur = Number(sm.get(P.PB_RATE)) || 1.0; setAndHint(P.PB_RATE, Math.min(16, Math.round((cur + 0.05) * 100) / 100)); setAndHint(P.PB_EN, true); }); return b; })(), (() => { const b = h('button', { class: 'pbtn', style: 'flex:0.8 !important;' }, 'OFF'); b.onclick = guardedClick(() => { sm.batch('playback', { rate: 1.0, enabled: false }); ApplyReq.hard(); }); return b; })());
      const seekRow = h('div', { class: 'prow', style: 'gap:2px !important;' }, ...[{ text: '◀30', val: -30 }, { text: '◀15', val: -15 }, { text: '⏸', action: 'pause' }, { text: '▶', action: 'play' }, { text: '15▶', val: 15 }, { text: '30▶', val: 30 }].map(cfg => { const b = h('button', { class: 'pbtn', style: 'flex:1 !important;min-height:34px !important;font-size:11px !important;' }, cfg.text); b.onclick = guardedClick(() => execVideoAction(cfg.action || 'seek', cfg.val)); bindActGate(b, []); return b; }));
      const timerRow = h('div', { style: 'display:flex !important;gap:6px !important;align-items:center !important;' }, renderButtonRow({ label: '시계', key: P.APP_TIME_EN, offValue: false, items: [{ text: 'ON', value: true }] }));
      const timerPosRow = renderButtonRow({ label: '위치', key: P.APP_TIME_POS, items: [{ text: '좌', value: 0 }, { text: '중', value: 1 }, { text: '우', value: 2 }] });
      const kbRow = renderButtonRow({ label: '단축', key: P.APP_KB_EN, offValue: false, items: [{ text: 'Alt 단축키', value: true }] });
      const playbackTab = h('div', { class: 'tab-content' }, speedBtns, fineRow, h('hr'), seekRow, h('hr'), timerRow, timerPosRow, kbRow); tabContents.push(playbackTab);

      const mainPanel = h('div', { class: 'main' }, dragHandle, tabBar, ...tabContents); shadow.append(mainPanel); if (__vscNs.blockInterference) __vscNs.blockInterference(mainPanel);

      let stopDrag = null;
      const startPanelDrag = (e) => { if (e.target?.tagName === 'BUTTON') return; if (e.cancelable) e.preventDefault(); stopDrag?.(); hasUserDraggedUI = true; let startX = e.clientX, startY = e.clientY; const rect = mainPanel.getBoundingClientRect(); mainPanel.style.setProperty('transform', 'none', 'important'); mainPanel.style.setProperty('top', `${rect.top}px`, 'important'); mainPanel.style.setProperty('right', 'auto', 'important'); mainPanel.style.setProperty('left', `${rect.left}px`, 'important'); try { dragHandle.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(dragHandle, (ev) => { const dx = ev.clientX - startX, dy = ev.clientY - startY, pr = mainPanel.getBoundingClientRect(); mainPanel.style.setProperty('left', `${Math.max(0, Math.min(window.innerWidth - pr.width, rect.left + dx))}px`, 'important'); mainPanel.style.setProperty('top', `${Math.max(0, Math.min(window.innerHeight - pr.height, rect.top + dy))}px`, 'important'); }, () => { stopDrag = null; }); };
      on(dragHandle, 'pointerdown', startPanelDrag); on(dragHandle, 'dblclick', () => { hasUserDraggedUI = false; clampPanelIntoViewport(); });
      container = host; getUiRoot().appendChild(container);
    };

    const ensureGear = () => {
      if (gearHost) return; gearHost = h('div', { 'data-vsc-ui': '1', style: 'all:initial !important;position:fixed !important;inset:0 !important;pointer-events:none !important;z-index:2147483647 !important;isolation:isolate !important;' }); const shadow = gearHost.attachShadow({ mode: 'open' }); attachShadowStyles(shadow, GEAR_CSS);
      let dragThresholdMet = false, stopDrag = null; gearBtn = h('button', { class: 'gear' }, '⚙'); shadow.append(gearBtn); if (__vscNs.blockInterference) __vscNs.blockInterference(gearBtn);
      const wake = () => { if (gearBtn) gearBtn.style.setProperty('opacity', '1', 'important'); clearTimeout(fadeTimer); if (!!document.fullscreenElement || CONFIG.IS_MOBILE) return; fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.matches(':hover')) gearBtn.style.setProperty('opacity', '0.45', 'important'); }, 2500); };
      wakeGear = wake; on(window, 'mousemove', wake, { passive: true, signal: uiSig }); on(window, 'touchstart', wake, { passive: true, signal: uiSig }); bootWakeTimer = setTimeout(wake, 2000);
      const handleGearDrag = (e) => { if (e.target !== gearBtn) return; dragThresholdMet = false; stopDrag?.(); const startY = e.clientY, rect = gearBtn.getBoundingClientRect(); try { gearBtn.setPointerCapture(e.pointerId); } catch (_) {} stopDrag = bindElementDrag(gearBtn, (ev) => { if (Math.abs(ev.clientY - startY) > 10) { if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.setProperty('transition', 'none', 'important'); gearBtn.style.setProperty('transform', 'none', 'important'); gearBtn.style.setProperty('top', `${rect.top}px`, 'important'); } if (ev.cancelable) ev.preventDefault(); } if (dragThresholdMet) gearBtn.style.setProperty('top', `${Math.max(0, Math.min(window.innerHeight - gearBtn.offsetHeight, rect.top + (ev.clientY - startY)))}px`, 'important'); }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); }); };
      on(gearBtn, 'pointerdown', handleGearDrag); let lastToggle = 0; on(gearBtn, 'pointerup', (e) => { if (e.cancelable) e.preventDefault(); e.stopPropagation?.(); if (dragThresholdMet) return; const now = performance.now(); if (now - lastToggle < 300) return; lastToggle = now; setAndHint(P.APP_UI, !sm.get(P.APP_UI)); }, { passive: false });
      const syncGear = () => { if (!gearBtn) return; gearBtn.classList.toggle('open', !!sm.get(P.APP_UI)); gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT)); wake(); }; sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
    };

    const mount = () => { const root = getUiRoot(); if (!root) return; try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) { try { (document.body || document.documentElement).appendChild(gearHost); } catch (__) {} } try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) { try { (document.body || document.documentElement).appendChild(container); } catch (__) {} } };
    const ensure = () => { if (!allowUiInThisDoc() || (registry.videos.size === 0 && !sm.get(P.APP_UI))) { detachNodesHard(); return; } ensureGear(); const mainPanel = getMainPanel(); if (sm.get(P.APP_UI)) { build(); const mp = getMainPanel(); if (mp && !mp.classList.contains('visible')) { mp.style.setProperty('display', 'block', 'important'); mp.classList.add('visible'); queueMicrotask(clampPanelIntoViewport); } } else { if (mainPanel) { mainPanel.classList.remove('visible'); mainPanel.style.setProperty('display', 'none', 'important'); } } mount(); wakeGear?.(); };
    onPageReady(() => { ensure(); ApplyReq.hard(); });
    return { ensure, destroy: () => { uiUnsubs.forEach(u => u()); uiUnsubs.length = 0; uiWakeCtrl.abort(); clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); if (_clampRafId) { cancelAnimationFrame(_clampRafId); _clampRafId = 0; } detachNodesHard(); } };
  }
  function createUIFeature(Store, Registry, ApplyReq, Utils, P) { let uiInst = null; return defineFeature({ name: 'ui', phase: PHASE.RENDER, onInit() { uiInst = createUI(Store, Registry, ApplyReq, Utils, P); this.subscribe('video:detected', () => uiInst?.ensure()); }, onUpdate() { uiInst?.ensure(); }, onDestroy() { uiInst?.destroy(); } }); }

  /* ── Zoom Manager ────────────────────────────────────────────── */
  function createZoomManager(Store, P) {
    const stateMap = new WeakMap(); let rafId = null, activeVideo = null, isPanning = false, startX = 0, startY = 0; let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 }; const zoomedVideos = new Set(); let activePointerId = null; const zoomAC = new AbortController(), zsig = combineSignals(zoomAC.signal, __globalSig);
    const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, origStyle: '' }; stateMap.set(v, st); } return st; };
    const update = (v) => { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = null; const st = getSt(v); const panning = isPanning || pinchState.active; if (st.scale <= 1) { if (st.zoomed) { v.style.cssText = st.origStyle; st.zoomed = false; } st.scale = 1; st.tx = 0; st.ty = 0; zoomedVideos.delete(v); return; } if (!st.zoomed) { st.origStyle = v.style.cssText; st.zoomed = true; } v.style.cssText = st.origStyle + `; will-change: transform !important; contain: paint !important; backface-visibility: hidden !important; transition: ${panning ? 'none' : 'transform 80ms ease-out'} !important; transform-origin: 0 0 !important; transform: translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)}) !important; cursor: ${panning ? 'grabbing' : 'grab'} !important; z-index: 2147483646 !important; position: relative !important;`; zoomedVideos.add(v); }); };
    function clampPan(v, st) { const r = v.getBoundingClientRect(); if (!r || r.width <= 1 || r.height <= 1) return; const sw = r.width * st.scale, sh = r.height * st.scale; st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75); st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75); }
    const zoomTo = (v, newScale, cx, cy) => { const st = getSt(v), r = v.getBoundingClientRect(); if (!r || r.width <= 1) return; const ix = (cx - r.left) / st.scale, iy = (cy - r.top) / st.scale; st.tx = cx - (r.left - st.tx) - ix * newScale; st.ty = cy - (r.top - st.ty) - iy * newScale; st.scale = newScale; update(v); }, resetZoom = (v) => { if (!v) return; const st = getSt(v); st.scale = 1; update(v); }, isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; }, getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let unsubAct = null, unsubZoomEn = null; if (Store?.sub) { const resetAll = () => { for (const v of [...zoomedVideos]) resetZoom(v); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; }; unsubAct = Store.sub(P.APP_ACT, (act) => { if (!act) resetAll(); }); unsubZoomEn = Store.sub(P.APP_ZOOM_EN, (en) => { if (!en) { resetAll(); zoomedVideos.clear(); } }); }
    function getTargetVideo(e) { if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } } const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null); if (cx != null && cy != null) { const el = document.elementFromPoint(cx, cy); if (el?.tagName === 'VIDEO') return el; } return __vscNs.App?.getActiveVideo() || null; }
    on(window, 'wheel', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !(e.altKey && e.shiftKey)) return; const v = getTargetVideo(e); if (!v) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const st = getSt(v); let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10); if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY); }, { passive: false, capture: true, signal: zsig });
    on(window, 'pointerdown', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || e.pointerType === 'touch' || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; const st = getSt(v); if (st.scale <= 1) return; if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false; startX = e.clientX - st.tx; startY = e.clientY - st.ty; try { v.setPointerCapture?.(e.pointerId); } catch (_) {} update(v); }, { capture: true, passive: false, signal: zsig });
    on(window, 'pointermove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const st = getSt(activeVideo); if (e.cancelable) { e.preventDefault(); e.stopPropagation(); } const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e], last = events[events.length - 1] || e; const nextTx = last.clientX - startX, nextTy = last.clientY - startY; if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true; st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo); }, { capture: true, passive: false, signal: zsig });
    function endPointerPan(e) { if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return; const v = activeVideo, st = getSt(v); try { v.releasePointerCapture?.(e.pointerId); } catch (_) {} if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); } activePointerId = null; isPanning = false; activeVideo = null; update(v); }
    on(window, 'pointerup', endPointerPan, { capture: true, passive: false, signal: zsig }); on(window, 'pointercancel', endPointerPan, { capture: true, passive: false, signal: zsig });
    on(window, 'dblclick', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !e.altKey) return; const v = getTargetVideo(e); if (!v) return; e.preventDefault(); e.stopPropagation(); const st = getSt(v); if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v); }, { capture: true, signal: zsig });
    on(window, 'touchstart', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN)) return; const v = getTargetVideo(e); if (!v) return; if (e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const st = getSt(v); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = st.scale; pinchState.lastCx = (e.touches[0].clientX + e.touches[1].clientX) / 2; pinchState.lastCy = (e.touches[0].clientY + e.touches[1].clientY) / 2; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchmove', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; const st = getSt(activeVideo); if (pinchState.active && e.touches.length === 2) { if (e.cancelable) e.preventDefault(); const dist = getTouchDist(e.touches), cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, cy = (e.touches[0].clientY + e.touches[1].clientY) / 2; let newScale = Math.min(Math.max(1, pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist))), 10); if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; activeVideo = null; } else { zoomTo(activeVideo, newScale, cx, cy); st.tx += cx - pinchState.lastCx; st.ty += cy - pinchState.lastCy; clampPan(activeVideo, st); update(activeVideo); } pinchState.lastCx = cx; pinchState.lastCy = cy; } }, { passive: false, capture: true, signal: zsig });
    on(window, 'touchend', e => { if (!Store?.get(P.APP_ACT) || !Store?.get(P.APP_ZOOM_EN) || !activeVideo) return; if (e.touches.length < 2) pinchState.active = false; if (e.touches.length === 0) { update(activeVideo); activeVideo = null; } }, { passive: false, capture: true, signal: zsig });
    return { resetZoom, zoomTo, isZoomed, setEnabled: () => {}, pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } }, destroy: () => { safe(() => unsubAct?.()); safe(() => unsubZoomEn?.()); zoomAC.abort(); if (rafId) { cancelAnimationFrame(rafId); rafId = null; } for (const v of [...zoomedVideos]) { const st = getSt(v); v.style.cssText = st.origStyle; st.scale = 1; st.zoomed = false; } zoomedVideos.clear(); isPanning = false; pinchState.active = false; activeVideo = null; activePointerId = null; } };
  }
  function createZoomFeature(Store, P) { let zm = null; return defineFeature({ name: 'zoom', phase: PHASE.PROCESS, onInit() { zm = createZoomManager(Store, P); }, onDestroy() { zm?.destroy(); }, methods: { pruneDisconnected: () => zm?.pruneDisconnected(), isZoomed: (v) => zm?.isZoomed(v), zoomTo: (v, s, x, y) => zm?.zoomTo(v, s, x, y), resetZoom: (v) => zm?.resetZoom(v) } }); }

  /* ── Timer Feature (Strict: position:fixed + polling) ────────── */
  function createTimerFeature() {
    let _rafId = 0, _timerEl = null, _lastSecond = -1, _destroyed = false, _lastLayoutKey = '';
    let _pollId = 0;

    function getFullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

    function createTimerEl() {
      const el = document.createElement('div'); el.className = 'vsc-fs-timer'; el.setAttribute('data-vsc-ui', '1');
      el.style.cssText = [
        'position:fixed !important', 'z-index:2147483647 !important', 'color:#FFE600 !important', 'font-family:monospace !important',
        'font-weight:bold !important', 'pointer-events:none !important', 'user-select:none !important', 'font-variant-numeric:tabular-nums !important',
        'letter-spacing:1px !important', '-webkit-text-stroke:1.5px #000 !important', 'paint-order:stroke fill !important',
        'transition:opacity 0.2s !important', 'opacity:0.5 !important', 'margin:0 !important', 'padding:0 !important',
        'border:none !important', 'display:block !important', 'background:transparent !important', 'box-shadow:none !important', 'text-shadow:none !important'
      ].join(';');
      return el;
    }

    function getTimerParent() { const fs = getFullscreenElement(); if (!fs) return null; if (fs.tagName === 'VIDEO') return fs.parentElement || document.body; return fs; }

    function ensureTimerAttached() {
      const parent = getTimerParent();
      if (!parent) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); return null; }
      if (_timerEl && _timerEl.parentNode === parent && _timerEl.isConnected) return parent;
      removeSafe(_timerEl); _timerEl = createTimerEl(); parent.appendChild(_timerEl); _lastLayoutKey = ''; return parent;
    }

    function verifyAndFixPosition(vRect, pos) {
      if (!_timerEl) return;
      const timerRect = _timerEl.getBoundingClientRect(), vWidth = vRect.width, topOffset = vWidth > 1200 ? 16 : 8, expectedTop = vRect.top + topOffset;
      if (Math.abs(timerRect.top - expectedTop) > 10) {
        const parent = _timerEl.parentNode;
        if (parent) {
          const pRect = parent.getBoundingClientRect(), correctedTop = vRect.top - pRect.top + topOffset, edgeMargin = vWidth > 1200 ? 20 : 10;
          _timerEl.style.setProperty('top', `${correctedTop}px`, 'important');
          if (pos === 0) { _timerEl.style.setProperty('left', `${vRect.left - pRect.left + edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'none', 'important'); }
          else if (pos === 1) { _timerEl.style.setProperty('left', `${vRect.left - pRect.left + vWidth / 2}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-50%)', 'important'); }
          else { _timerEl.style.setProperty('left', `${vRect.right - pRect.left - edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-100%)', 'important'); }
        }
      }
    }

    function tick() {
      _rafId = 0; if (_destroyed) return;
      const store = __vscNs.Store; if (!store) { scheduleNext(); return; }
      const act = store.get('app.active'), timeEn = store.get('app.timeEn'), isFs = !!getFullscreenElement();
      if (!act || !timeEn || !isFs) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); _lastSecond = -1; _lastLayoutKey = ''; return; }
      const activeVideo = __vscNs.App?.getActiveVideo?.();
      if (!activeVideo?.isConnected) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); _lastSecond = -1; _lastLayoutKey = ''; scheduleNext(); return; }
      const parent = ensureTimerAttached(); if (!parent) { return; }
      const now = new Date(), curSecond = now.getSeconds(), timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(curSecond).padStart(2, '0')}`;
      _timerEl.style.setProperty('display', 'block', 'important'); if (_timerEl.textContent !== timeStr) _timerEl.textContent = timeStr; _lastSecond = curSecond;
      const vRect = activeVideo.getBoundingClientRect(), vWidth = vRect.width, pos = store.get('app.timePos') ?? 1, layoutKey = `${vRect.left | 0},${vRect.top | 0},${vRect.width | 0},${pos}`;
      if (_lastLayoutKey !== layoutKey) {
        _lastLayoutKey = layoutKey; _timerEl.style.setProperty('font-size', `${vWidth >= 2500 ? 36 : vWidth >= 1900 ? 30 : vWidth >= 1200 ? 24 : 18}px`, 'important');
        const topOffset = vWidth > 1200 ? 16 : 8, edgeMargin = vWidth > 1200 ? 20 : 10;
        _timerEl.style.setProperty('top', `${vRect.top + topOffset}px`, 'important'); _timerEl.style.setProperty('bottom', 'auto', 'important'); _timerEl.style.setProperty('right', 'auto', 'important');
        if (pos === 0) { _timerEl.style.setProperty('left', `${vRect.left + edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'none', 'important'); }
        else if (pos === 1) { _timerEl.style.setProperty('left', `${vRect.left + vWidth / 2}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-50%)', 'important'); }
        else { _timerEl.style.setProperty('left', `${vRect.right - edgeMargin}px`, 'important'); _timerEl.style.setProperty('transform', 'translateX(-100%)', 'important'); }
        requestAnimationFrame(() => { if (!_destroyed && _timerEl?.isConnected) verifyAndFixPosition(activeVideo.getBoundingClientRect(), pos); });
      }
      scheduleNext();
    }

    function scheduleNext() { if (!_destroyed && !_rafId) _rafId = requestAnimationFrame(tick); }
    function startPolling() { stopPolling(); _pollId = setRecurring(() => { if (_destroyed) { stopPolling(); return; } const store = __vscNs.Store; if (!store) return; const isFs = !!getFullscreenElement(), timeEn = store.get('app.timeEn'), act = store.get('app.active'); if (isFs && timeEn && act && !_rafId) scheduleNext(); }, 1000); }
    function stopPolling() { if (_pollId) { clearInterval(_pollId); _pollId = 0; } }

    return defineFeature({
      name: 'timer', phase: PHASE.RENDER,
      onInit() { _destroyed = false; this.subscribe('fullscreen:changed', ({ active }) => { if (!active) { if (_timerEl) _timerEl.style.setProperty('display', 'none', 'important'); _lastSecond = -1; _lastLayoutKey = ''; } scheduleNext(); }); this.subscribe('settings:changed', ({ path }) => { if (path === 'app.active' || path === 'app.timeEn' || path === 'app.timePos' || path === 'app.*') scheduleNext(); }); this.subscribe('target:changed', () => { if (getFullscreenElement()) { _lastLayoutKey = ''; scheduleNext(); } }); startPolling(); if (getFullscreenElement()) scheduleNext(); },
      onDestroy() { _destroyed = true; stopPolling(); if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; } removeSafe(_timerEl); _timerEl = null; _lastSecond = -1; _lastLayoutKey = ''; }
    });
  }

  /* ── Keyboard Shortcuts Feature ──────────────────────────────── */
  function createKeyboardFeature() {
    return defineFeature({
      name: 'keyboard', phase: PHASE.PROCESS,
      onInit() {
        on(document, 'keydown', (e) => {
          if (!this.getSetting(CONFIG.P.APP_ACT)) return;
          if (!this.getSetting(CONFIG.P.APP_KB_EN)) return;
          const t = e.target;
          if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT' || t?.isContentEditable) return;
          if (!e.altKey || e.ctrlKey || e.metaKey) return;
          const store = __vscNs.Store; if (!store) return;

          let handled = false;
          switch (e.code) {
            case 'KeyS': {
              const order = ['off', 'Soft', 'Medium', 'Ultra', 'Master'];
              const idx = order.indexOf(store.get(CONFIG.P.V_PRE_S));
              const next = order[(idx + 1) % order.length];
              store.set(CONFIG.P.V_PRE_S, next);
              showToast(`선명: ${next}`); __vscNs.ApplyReq?.hard(); handled = true; break;
            }
            case 'KeyB': {
              const cur = store.get(CONFIG.P.V_BRIGHT_LV) || 0, next = (cur + 1) % 6;
              store.set(CONFIG.P.V_BRIGHT_LV, next); showToast(`밝기: ${next || 'OFF'}`); __vscNs.ApplyReq?.hard(); handled = true; break;
            }
            case 'KeyA': {
              __vscNs.AudioWarmup?.();
              const next = !store.get(CONFIG.P.A_EN);
              store.set(CONFIG.P.A_EN, next); showToast(`Audio: ${next ? 'ON' : 'OFF'}`); __vscNs.ApplyReq?.soft(); handled = true; break;
            }
            case 'KeyD': {
              const cur = Number(store.get(CONFIG.P.PB_RATE)) || 1.0;
              const next = Math.min(5.0, Math.round((cur + 0.25) * 100) / 100);
              store.set(CONFIG.P.PB_RATE, next); store.set(CONFIG.P.PB_EN, true);
              showToast(`${next.toFixed(2)}x`); __vscNs.ApplyReq?.hard(); handled = true; break;
            }
            case 'KeyF': {
              const cur = Number(store.get(CONFIG.P.PB_RATE)) || 1.0;
              const next = Math.max(0.25, Math.round((cur - 0.25) * 100) / 100);
              store.set(CONFIG.P.PB_RATE, next); store.set(CONFIG.P.PB_EN, true);
              showToast(`${next.toFixed(2)}x`); __vscNs.ApplyReq?.hard(); handled = true; break;
            }
            case 'KeyQ': {
              const next = !store.get(CONFIG.P.APP_ACT);
              store.set(CONFIG.P.APP_ACT, next); showToast(`Power: ${next ? 'ON' : 'OFF'}`); handled = true; break;
            }
            case 'KeyG': {
              store.set(CONFIG.P.APP_UI, !store.get(CONFIG.P.APP_UI)); handled = true; break;
            }
          }
          if (handled) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
        }, { capture: true });
      }
    });
  }

  /* ── App Controller ──────────────────────────────────────────── */
  function createAppController({ Store, Registry, Scheduler, Features, P, Targeting, Bus }) {
    Store.sub(P.APP_UI, () => Scheduler.request(true)); Store.sub(P.APP_ACT, (onState) => { if (onState) { Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); } });
    let __activeTarget = null, __lastApplyTarget = null, lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

    const emitFs = () => { const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement); Bus.emit('fullscreen:changed', { active: isFs }); if (isFs) Scheduler.request(true); };
    on(document, 'fullscreenchange', emitFs, { passive: true }); on(document, 'webkitfullscreenchange', emitFs, { passive: true });

    Scheduler.registerApply((force) => {
      try {
        const active = !!Store.getCatRef('app').active, sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscNs.__vscUserSignalRev || 0;
        const wantAudioNow = !!(Store.get(P.A_EN) && active), pbActive = active && !!Store.get(P.PB_EN);
        const { visible } = Registry, dirty = Registry.consumeDirty(), vidsDirty = dirty.videos, userPt = __vscNs.lastUserPt || { x: 0, y: 0, t: 0 };
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
        if (vidsDirty.size > 40 || (now - lastPrune > pruneInterval)) {
          if (typeof postIdleTask === 'function') postIdleTask(() => { Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); });
          else { Registry.prune(); Features.get('zoom')?.pruneDisconnected?.(); }
          lastPrune = now;
        }
        Features.updateAll({ active, force, vidsDirty, pbActive, target: __activeTarget, isApplyAll: !!Store.get(P.APP_APPLY_ALL), desiredRate: Store.get(P.PB_RATE) });
      } catch (e) { log.warn('apply crashed:', e); }
    });

    let tickTimer = 0, tickVisHandler = null;
    const startTick = () => { stopTick(); tickVisHandler = () => { if (document.visibilityState === 'visible' && Store.get(P.APP_ACT)) Scheduler.request(false); }; document.addEventListener('visibilitychange', tickVisHandler, { passive: true }); tickTimer = setRecurring(() => { if (!Store.get(P.APP_ACT) || document.hidden) return; Scheduler.request(false); }, 30000); };
    const stopTick = () => { if (tickTimer > 0) { clearInterval(tickTimer); tickTimer = 0; } if (tickVisHandler) { document.removeEventListener('visibilitychange', tickVisHandler); tickVisHandler = null; } };
    Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); }); if (Store.get(P.APP_ACT)) startTick();
    return Object.freeze({ getActiveVideo: () => __activeTarget, destroy() { stopTick(); safe(() => Features.destroyAll()); safe(() => Registry.destroy?.()); } });
  }

  /* ── Bootstrap ───────────────────────────────────────────────── */
  const Bus = createEventBus(), Utils = createUtils(), Scheduler = createScheduler(16);
  const Store = createLocalStore(CONFIG.DEFAULTS, Scheduler, Bus);
  const ApplyReq = Object.freeze({ soft: () => Scheduler.request(false), hard: () => Scheduler.request(true) });
  __vscNs.Store = Store; __vscNs.ApplyReq = ApplyReq;

  const Registry = createRegistry(Scheduler, Bus), Targeting = createTargeting();
  initSpaUrlDetector(createDebounced(() => { Registry.prune(); Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }, 150));

  onPageReady(() => {
    for (const delay of [3000, 10000]) { setTimer(() => { if (delay > 3000 && Registry.videos.size > 0) return; Registry.rescanAll(); Scheduler.request(true); }, delay); }
    (function ensureRegistryAfterBodyReady() { let ran = false; const runOnce = () => { if (ran) return; ran = true; Registry.refreshObservers(); Registry.rescanAll(); Scheduler.request(true); }; if (document.body) { runOnce(); return; } const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); runOnce(); } }); try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch (_) {} on(document, 'DOMContentLoaded', runOnce, { once: true }); })();

    try {
      if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('VSC 패널 열기/닫기', () => Store.set(CONFIG.P.APP_UI, !Store.get(CONFIG.P.APP_UI)));
        GM_registerMenuCommand('VSC 전원 토글', () => Store.set(CONFIG.P.APP_ACT, !Store.get(CONFIG.P.APP_ACT)));
        GM_registerMenuCommand('VSC 설정 초기화', () => { Store.batch('video', CONFIG.DEFAULTS.video); Store.batch('audio', CONFIG.DEFAULTS.audio); Store.batch('playback', CONFIG.DEFAULTS.playback); ApplyReq.hard(); showToast('초기화 완료'); });
      }
    } catch (_) {}

    const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, FLAGS: CONFIG.FLAGS }), Adapter = createBackendAdapter(Filters);
    __vscNs.Adapter = Adapter; __vscNs.Filters = Filters;

    const videoParamsMemo = createVideoParamsMemo(), Features = createFeatureRegistry(Bus);
    Features.register(createPipelineFeature(Store, Registry, Adapter, ApplyReq, Targeting, videoParamsMemo));
    const audioFeat = createAudioFeature(Store); Features.register(audioFeat);
    const zoomFeat = createZoomFeature(Store, CONFIG.P); Features.register(zoomFeat);
    const uiFeat = createUIFeature(Store, Registry, ApplyReq, Utils, CONFIG.P); Features.register(uiFeat);
    Features.register(createTimerFeature());
    Features.register(createKeyboardFeature());

    __vscNs.Features = Features; __vscNs.ZoomManager = zoomFeat; __vscNs.AudioWarmup = audioFeat.warmup;
    __vscNs.AudioSetTarget = (v) => safe(() => Bus.emit('target:changed', { video: v, prev: null }));
    __vscNs.UIEnsure = () => safe(() => uiFeat.update());

    let __vscLastUserSignalT = 0; __vscNs.lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() }; __vscNs.__vscUserSignalRev = 0;
    function updateLastUserPt(x, y, t) { __vscNs.lastUserPt.x = x; __vscNs.lastUserPt.y = y; __vscNs.lastUserPt.t = t; }
    function signalUserInteraction() { const now = performance.now(); if (now - __vscLastUserSignalT < 150) return; __vscLastUserSignalT = now; __vscNs.__vscUserSignalRev = (__vscNs.__vscUserSignalRev + 1) | 0; Scheduler.request(false); }

    for (const [evt, getPt] of [['pointerdown', e => [e.clientX, e.clientY]], ['wheel', e => [Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5, Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5]], ['keydown', () => [innerWidth * 0.5, innerHeight * 0.5]], ['resize', () => [innerWidth * 0.5, innerHeight * 0.5]]]) { on(window, evt, (e) => { if (evt === 'resize') { const now = performance.now(); if (!__vscNs.lastUserPt || (now - __vscNs.lastUserPt.t) > 1200) updateLastUserPt(...getPt(e), now); } else updateLastUserPt(...getPt(e), performance.now()); signalUserInteraction(); }, evt === 'keydown' ? undefined : OPT_P); }

    let __VSC_APP__ = null;
    Features.initAll({ bus: Bus, store: Store, getActiveVideo: () => __VSC_APP__?.getActiveVideo() || null });
    __VSC_APP__ = createAppController({ Store, Registry, Scheduler, Features, P: CONFIG.P, Targeting, Bus });
    __vscNs.App = __VSC_APP__; ApplyReq.hard();

    on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') ApplyReq.hard(); }, OPT_P);
    window.addEventListener('beforeunload', () => __VSC_APP__?.destroy(), { once: true });
  });
}

VSC_MAIN();
})();
