// ==UserScript==
// @name         Video_Control (v200.0.0-Hybrid)
// @namespace    https://github.com/
// @version      200.0.0-Hybrid
// @description  v200.0: FeatureRegistry, Symbol isolation, EME DRM guard, CSS vars, SVG DOM icons, per-video AC, memory-leak hardening
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

  function VSC_MAIN() {
    if (location.href.includes('/cdn-cgi/') || location.host.includes('challenges.cloudflare.com') || location.protocol === 'about:' || location.href === 'about:blank') return;

    /* ── Symbol-based boot lock & namespace (v200: collision-proof) ── */
    const VSC_SYM = Symbol.for('__VSC__');
    const VSC_BOOT_SYM = Symbol.for('__VSC_BOOT_LOCK__');
    const VSC_SPA_SYM = Symbol.for('__VSC_SPA_PATCHED__');
    const VSC_APP_SYM = Symbol.for('__VSC_APP__');
    const VSC_INTERNAL_SYM = Symbol.for('__VSC_INTERNAL__');

    if (window[VSC_BOOT_SYM]) return;
    try {
      Object.defineProperty(window, VSC_BOOT_SYM, { value: true, writable: false, configurable: false, enumerable: false });
    } catch (e) {
      window[VSC_BOOT_SYM] = true;
    }

    if (!window[VSC_INTERNAL_SYM]) {
      try {
        Object.defineProperty(window, VSC_INTERNAL_SYM, { value: {}, writable: false, configurable: false, enumerable: false });
      } catch (e) {
        window[VSC_INTERNAL_SYM] = {};
      }
    }
    const __internal = window[VSC_INTERNAL_SYM];

    /* backward-compat shim (will be removed in future) */
    if (!window.__VSC_INTERNAL__) {
      try {
        Object.defineProperty(window, '__VSC_INTERNAL__', { get() { return window[VSC_INTERNAL_SYM]; }, configurable: true, enumerable: false });
      } catch (_) {
        window.__VSC_INTERNAL__ = __internal;
      }
    }

    let __vscUserSignalRev = 0;

    function isEditableTarget(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); }

    /* ── Global AbortController ── */
    const __globalHooksAC = new AbortController();
    const __globalSig = __globalHooksAC.signal;

    /* ── Timer management ── */
    const _activeTimers = new Set();
    const _activeIntervals = new Set();
    __globalSig.addEventListener('abort', () => {
      for (const id of _activeTimers) clearTimeout(id);
      _activeTimers.clear();
      for (const id of _activeIntervals) clearInterval(id);
      _activeIntervals.clear();
    }, { once: true });

    const setTimer = (fn, ms) => {
      if (__globalSig.aborted) return 0;
      const id = setTimeout(() => { _activeTimers.delete(id); fn(); }, ms);
      _activeTimers.add(id);
      return id;
    };
    const clearTimer = (id) => { if (!id) return; clearTimeout(id); _activeTimers.delete(id); };

    const setRecurring = (fn, ms, opts = {}) => {
      if (__globalSig.aborted) return 0;
      let consecutiveErrors = 0;
      const maxErrors = opts.maxErrors ?? 50;
      const onKill = opts.onKill ?? null;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _activeIntervals.delete(id); return; }
        try { fn(); consecutiveErrors = 0; } catch (_) {
          consecutiveErrors = (consecutiveErrors | 0) + 1;
          if (consecutiveErrors >= maxErrors) {
            clearInterval(id); _activeIntervals.delete(id);
            try { onKill?.(); } catch (__) {}
          }
        }
      }, ms);
      _activeIntervals.add(id);
      return id;
    };
    const clearRecurring = (id) => { if (!id) return; clearInterval(id); _activeIntervals.delete(id); };

    /* ── Signal combinators ── */
    const combineSignals = (...signals) => {
      const existing = signals.filter(Boolean);
      if (existing.length === 0) return undefined;
      if (existing.length === 1) return existing[0];
      if (typeof AbortSignal.any === 'function') return AbortSignal.any(existing);
      for (const sig of existing) { if (sig.aborted) return sig; }
      const ac = new AbortController();
      const onAbort = () => { if (!ac.signal.aborted) ac.abort(); };
      for (const sig of existing) {
        sig.addEventListener('abort', onAbort, { once: true, signal: ac.signal });
      }
      return ac.signal;
    };

    /* ── Event binding with auto-cleanup ── */
    function on(target, type, fn, opts) {
      if (!target?.addEventListener) return;
      const o = opts ? { ...opts } : {};
      o.signal = o.signal ? combineSignals(o.signal, __globalSig) : __globalSig;
      if (o.signal?.aborted) return;
      target.addEventListener(type, fn, o);
    }
    const onWin = (type, fn, opts) => on(window, type, fn, opts);
    const onDoc = (type, fn, opts) => on(document, type, fn, opts);
    const onAll = (el, events, fn, opts) => { for (const ev of events) on(el, ev, fn, opts); };

    /* ── Interference blocker ── */
    const __blockedElements = new WeakSet();
    const BLOCK_EVENTS = Object.freeze(['pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'click']);
    function blockInterference(el) {
      if (!el || __blockedElements.has(el)) return;
      __blockedElements.add(el);
      const isInteractiveInPath = (e) => {
        try {
          const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
          for (let i = 0, len = Math.min(path.length, 12); i < len; i++) {
            const n = path[i];
            if (!n || n.nodeType !== 1) continue;
            const tag = n.tagName;
            if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A' || n.getAttribute?.('role') === 'button') return true;
          }
        } catch (_) {}
        return false;
      };
      const stop = (e) => { if (isInteractiveInPath(e)) return; e.stopPropagation(); };
      for (const evt of BLOCK_EVENTS) on(el, evt, stop, { passive: true });
      on(el, 'wheel', (e) => { if (e.altKey) return; e.stopPropagation(); }, { passive: true });
    }

    /* ── Mobile detection ── */
    function detectMobile() {
      try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {}
      return /Mobi|Android|iPhone/i.test(navigator.userAgent);
    }

    /* ── Core config ── */
    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ''),
      DEBUG: false
    });
    const VSC_VERSION = '200.0.0-Hybrid';

    /* ── Storage keys (path-specific for YouTube etc.) ── */
    const STORAGE_KEY_BASE = 'vsc_v2_' + location.hostname;
    const PATH_SPECIFIC_HOSTS = Object.freeze({ 'youtube.com': ['/shorts', '/watch'] });
    function getStorageKey() {
      const h = location.hostname;
      for (const [host, paths] of Object.entries(PATH_SPECIFIC_HOSTS)) {
        if (h === host || h.endsWith('.' + host)) {
          for (const p of paths) {
            if (location.pathname.startsWith(p)) return STORAGE_KEY_BASE + '_' + p.replace(/\//g, '_');
          }
        }
      }
      return STORAGE_KEY_BASE;
    }
    const STORAGE_KEY = getStorageKey();

    /* ── Clamp & color temperature ── */
    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      if (Math.abs(t) < 0.001) return { rs: 1, gs: 1, bs: 1 };
      const r = 1 + 0.14 * t;
      const g = 1 - 0.02 * Math.abs(t);
      const b = 1 - 0.14 * t;
      const m = t > 0 ? r : b;
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    /* ── Defense & feature flags ── */
    const VSC_DEFENSE = Object.freeze({ audioCooldown: true, autoSceneDrmBackoff: true });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true });
    const SHADOW_ROOT_LRU_MAX = 10;
    const SPA_RESCAN_DEBOUNCE_MS = 500;
    const GUARD = Object.freeze({
      AUDIO_SRC_COOLDOWN: 3000,
      AUDIO_SRC_COOLDOWN_DRM: 8000,
      TARGET_HYSTERESIS_MS: 500,
      TARGET_HYSTERESIS_MARGIN: 1.2
    });

    /* ── DRM rate-control constants (v200: expanded host list, EME detection) ── */
    const RATE_BLOCKED_HOSTS = Object.freeze([
      'netflix.com', 'disneyplus.com', 'primevideo.com', 'hulu.com',
      'max.com', 'peacocktv.com', 'paramountplus.com', 'crunchyroll.com',
      'apple.com', 'discoveryplus.com', 'funimation.com', 'britbox.com',
      'showtime.com', 'starz.com', 'epix.com',
      'stan.com.au', 'binge.com.au', 'skygo.co.nz',
      'now.com', 'hotstar.com',
      'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com',
      'serieson.naver.com',
      'abema.tv', 'unext.jp', 'fod.fujitv.co.jp', 'paravi.jp', 'dmm.com',
      'dazn.com', 'espnplus.com', 'fubo.tv'
    ]);
    const RATE_BLOCKED_PATHS = Object.freeze([
      { host: 'amazon.com', pathPrefix: '/gp/video' },
      { host: 'amazon.com', pathPrefix: '/Amazon-Video' },
      { host: 'amazon.co.jp', pathPrefix: '/gp/video' },
      { host: 'amazon.co.uk', pathPrefix: '/gp/video' },
      { host: 'youtube.com', pathPrefix: '/paid' },
      { host: 'naver.com', pathPrefix: '/serieson' },
      { host: 'apple.com', pathPrefix: '/tv' }
    ]);

    const RATE_MAX_RETRY = 5;
    const RATE_BACKOFF_BASE = 16;
    const RATE_BACKOFF_MAX = 256;
    const RATE_SESSION_MAX = 30;
    const RATE_SUPPRESS_MS = 800;

    function isRateBlockedContext() {
      const h = location.hostname;
      if (RATE_BLOCKED_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
      return RATE_BLOCKED_PATHS.some(rule => (h === rule.host || h.endsWith('.' + rule.host)) && location.pathname.startsWith(rule.pathPrefix));
    }
    let __rateBlockedSite = isRateBlockedContext();

    /* ── EME encrypted video tracking (v200) ── */
    const __encryptedVideos = new WeakSet();
    function isVideoEncrypted(video) {
      try { if (video.mediaKeys) return true; } catch (_) {}
      if (__encryptedVideos.has(video)) return true;
      return false;
    }

    /* ── Logging ── */
    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
    const log = {
      error: (...args) => console.error('[VSC]', ...args),
      warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args),
      info: LOG_LEVEL >= 3 ? ((...args) => console.info('[VSC]', ...args)) : (() => {}),
      debug: LOG_LEVEL >= 4 ? ((...args) => console.debug('[VSC]', ...args)) : (() => {})
    };

    /* ── Video State (v200: per-video AC, EME hooks) ── */
    function createRateState() {
      return {
        orig: null, suppressSyncUntil: 0,
        permanentlyBlocked: false,
        _rateRetryCount: 0, _totalRetries: 0
      };
    }
    function createVideoState() {
      return {
        visible: false, rect: null, bound: false,
        audioFailUntil: 0, applied: false, desiredRate: undefined,
        lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false,
        _resizeDirty: false, _ac: null, _inPiP: false,
        lastCssFilterStr: null, _transitionCleared: false,
        __abCompare: false,
        rateState: createRateState(),
        resetTransient() {
          this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
          this.desiredRate = undefined;
          Object.assign(this.rateState, createRateState());
        }
      };
    }
    const videoStateMap = new WeakMap();
    function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = createVideoState(); videoStateMap.set(v, st); } return st; }
    function getRateState(v) { return getVState(v).rateState; }

    /* ── Shadow Band bitmask ── */
    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({
      has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; },
      toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); }
    });

    /* ── Presets ── */
    const PRESETS = Object.freeze({
      detail: {
        none: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'OFF' },
        off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'AUTO' },
        S: { sharpAdd: 12, sharp2Add: 2, clarityAdd: 3, label: '1단' },
        M: { sharpAdd: 15, sharp2Add: 8, clarityAdd: 8, label: '2단' },
        L: { sharpAdd: 16, sharp2Add: 18, clarityAdd: 14, label: '3단' },
        XL: { sharpAdd: 20, sharp2Add: 14, clarityAdd: 18, label: '4단' }
      },
      grade: {
        off: { gammaF: 1.00, brightAdd: 0, label: 'OFF' },
        DS: { gammaF: 1.04, brightAdd: 3.0, label: '복원1' },
        DM: { gammaF: 1.08, brightAdd: 6.0, label: '복원2' },
        DL: { gammaF: 1.16, brightAdd: 9.5, label: '복원3' }
      }
    });
    const getPresetLabel = (group, key) => PRESETS[group]?.[key]?.label || key;

    /* ── Defaults & Paths ── */
    const DEFAULTS = {
      video: { presetS: 'off', presetB: 'off', presetMix: 1.0, shadowBandMask: 0, brightStepLevel: 0 },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false, slots: [null, null, null] }
    };
    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll',
      APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced',
      V_PRE_S: 'video.presetS', V_PRE_B: 'video.presetB', V_PRE_MIX: 'video.presetMix',
      V_SHADOW_MASK: 'video.shadowBandMask', V_BRIGHT_STEP: 'video.brightStepLevel',
      A_EN: 'audio.enabled', A_BST: 'audio.boost',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled'
    });

    /* ── Schemas ── */
    const APP_SCHEMA = [
      { type: 'bool', path: P.APP_APPLY_ALL },
      { type: 'bool', path: P.APP_ZOOM_EN },
      { type: 'bool', path: P.APP_AUTO_SCENE },
      { type: 'bool', path: P.APP_ADV }
    ];
    const VIDEO_SCHEMA = [
      { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS },
      { type: 'enum', path: P.V_PRE_B, values: Object.keys(PRESETS.grade), fallback: () => DEFAULTS.video.presetB },
      { type: 'num', path: P.V_PRE_MIX, min: 0, max: 1, fallback: () => DEFAULTS.video.presetMix },
      { type: 'num', path: P.V_SHADOW_MASK, min: 0, max: 7, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_BRIGHT_STEP, min: 0, max: 3, round: true, fallback: () => 0 }
    ];
    const AUDIO_PLAYBACK_SCHEMA = [
      { type: 'bool', path: P.A_EN },
      { type: 'num', path: P.A_BST, min: 0, max: 12, fallback: () => DEFAULTS.audio.boost },
      { type: 'bool', path: P.PB_EN },
      { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate }
    ];
    const ALL_SCHEMAS = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];

    /* ── attachShadow patch (v200: Symbol-based marking) ── */
    if (FEATURE_FLAGS.trackShadowRoots) {
      __internal._onShadow = null;
      const _origAttach = Element.prototype.attachShadow;
      if (typeof _origAttach === 'function' && !_origAttach[VSC_SYM]) {
        const patchedAttach = function (init) {
          const sr = _origAttach.call(this, init);
          const internalRef = window[VSC_INTERNAL_SYM];
          if (internalRef?._onShadow && !__globalSig.aborted) {
            if (init && init.mode === 'open') queueMicrotask(() => internalRef._onShadow(this, sr));
          }
          return sr;
        };
        patchedAttach[VSC_SYM] = true;
        patchedAttach.__vsc_original = _origAttach;
        Element.prototype.attachShadow = patchedAttach;
        __globalSig.addEventListener('abort', () => {
          try { if (Element.prototype.attachShadow === patchedAttach) Element.prototype.attachShadow = _origAttach; } catch (_) {}
        }, { once: true });
      }
    }

    /* ── TOUCHED sets & eviction ── */
    const TOUCHED = { videos: new Set(), rateVideos: new Set() };
    function touchedAddLimited(set, el, onEvict) {
      if (!el) return;
      if (set.has(el)) { set.delete(el); set.add(el); return; }
      set.add(el);
      if (set.size <= CONFIG.TOUCHED_MAX) return;
      const targetDrop = Math.ceil(CONFIG.TOUCHED_MAX * 0.25);
      const toDrop = [];
      for (const v of set) {
        if (v === el) continue;
        const isActive = v.isConnected && (!v.paused || isPiPActiveVideo(v)) && !v.ended;
        if (!isActive) toDrop.push(v);
        if (toDrop.length >= targetDrop) break;
      }
      if (toDrop.length === 0) { for (const v of set) { if (v !== el) { toDrop.push(v); break; } } }
      for (const v of toDrop) { set.delete(v); try { onEvict?.(v); } catch (_) {} }
    }

    /* ── Rect caching & viewport ── */
    let __vscRectEpoch = 0, __vscRectEpochQueued = false;
    function bumpRectEpoch() {
      if (__vscRectEpochQueued) return;
      __vscRectEpochQueued = true;
      requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; });
    }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true });
    onWin('resize', bumpRectEpoch, { passive: true });
    onWin('orientationchange', bumpRectEpoch, { passive: true });
    try {
      const vv = window.visualViewport;
      if (vv) { on(vv, 'resize', bumpRectEpoch, { passive: true }); on(vv, 'scroll', bumpRectEpoch, { passive: true }); }
    } catch (_) {}

    function getRectCached(v, now, maxAgeMs = 350) {
      const st = getVState(v);
      if (!st.rect || (now - (st.rectT || 0)) > maxAgeMs || (st.rectEpoch || 0) !== __vscRectEpoch || st._resizeDirty) {
        st.rect = v.getBoundingClientRect(); st.rectT = now; st.rectEpoch = __vscRectEpoch; st._resizeDirty = false;
      }
      return st.rect;
    }

    const __vpSnap = { w: 0, h: 0, cx: 0, cy: 0 };
    const __cachedVV = window.visualViewport || null;
    function getViewportSnapshot() {
      const vv = __cachedVV;
      if (vv) { __vpSnap.w = vv.width; __vpSnap.h = vv.height; __vpSnap.cx = vv.offsetLeft + vv.width * 0.5; __vpSnap.cy = vv.offsetTop + vv.height * 0.5; }
      else { __vpSnap.w = innerWidth; __vpSnap.h = innerHeight; __vpSnap.cx = innerWidth * 0.5; __vpSnap.cy = innerHeight * 0.5; }
      return __vpSnap;
    }

    function createDebounced(fn, ms = 250) { let t = 0; return (...args) => { clearTimer(t); t = setTimer(() => fn(...args), ms); }; }

    /* ── CircularBuffer ── */
    class CircularBuffer {
      constructor(maxLen) { this._buf = new Float64Array(maxLen); this._head = 0; this._size = 0; this._max = maxLen; }
      push(val) { this._buf[this._head] = val; this._head = (this._head + 1) % this._max; if (this._size < this._max) this._size++; }
      reduce(fn, init) {
        let acc = init;
        const start = (this._head - this._size + this._max) % this._max;
        for (let i = 0; i < this._size; i++) acc = fn(acc, this._buf[(start + i) % this._max]);
        return acc;
      }
      get length() { return this._size; }
      toSorted() {
        if (this._size === 0) return new Float64Array(0);
        const arr = new Float64Array(this._size);
        const start = (this._head - this._size + this._max) % this._max;
        if (start + this._size <= this._max) {
          arr.set(this._buf.subarray(start, start + this._size));
        } else {
          const firstPart = this._max - start;
          arr.set(this._buf.subarray(start, this._max));
          arr.set(this._buf.subarray(0, this._size - firstPart), firstPart);
        }
        arr.sort((a, b) => a - b);
        return arr;
      }
      clear() { this._head = 0; this._size = 0; }
    }

    /* ── SPA URL detector (v200: Symbol-based guard) ── */
    function initSpaUrlDetector(onChanged) {
      if (window[VSC_SPA_SYM]) return;
      window[VSC_SPA_SYM] = true;
      let lastHref = location.href;
      const origHistory = {};
      const emitIfChanged = () => {
        const next = location.href;
        if (next === lastHref) return;
        lastHref = next;
        __rateBlockedSite = isRateBlockedContext();
        onChanged();
      };
      if (typeof navigation !== 'undefined' && navigation.addEventListener) {
        try {
          navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: __globalSig });
          navigation.addEventListener('navigateerror', emitIfChanged, { signal: __globalSig });
          onWin('popstate', emitIfChanged, { passive: true });
          return;
        } catch (_) {}
      }
      const wrap = (name) => {
        const orig = history[name];
        if (typeof orig !== 'function') return;
        if (orig[VSC_SYM]) return;
        origHistory[name] = orig;
        __internal[`_orig_${name}`] = orig;
        let patched;
        try {
          patched = new Proxy(orig, {
            apply(target, thisArg, argsList) {
              const ret = Reflect.apply(target, thisArg, argsList);
              if (!__globalSig.aborted) queueMicrotask(emitIfChanged);
              return ret;
            }
          });
          patched[VSC_SYM] = true;
          patched.__vsc_original = orig;
        } catch (_) {
          patched = function (...args) {
            const ret = Reflect.apply(orig, this, args);
            if (!__globalSig.aborted) queueMicrotask(emitIfChanged);
            return ret;
          };
          patched[VSC_SYM] = true;
          patched.__vsc_original = orig;
        }
        history[name] = patched;
      };
      wrap('pushState'); wrap('replaceState');
      onWin('popstate', emitIfChanged, { passive: true });
      __internal._spaOrigHistory = origHistory;
      __globalSig.addEventListener('abort', () => {
        for (const name of Object.keys(origHistory)) {
          try { const current = history[name]; if (current?.[VSC_SYM] && current.__vsc_original === origHistory[name]) history[name] = origHistory[name]; } catch (_) {}
        }
      }, { once: true });
    }

    /* ── Iframe injection (v200: Symbol-based boot lock check) ── */
    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    const __injectedIframes = new WeakSet();
    const __iframeLoadHooked = new WeakSet();
    const __iframeFailed = new WeakSet();
    function watchIframes() {
      const canAccess = (ifr) => { try { const w = ifr.contentWindow; if (!w) return false; void w.location.href; return true; } catch (_) { return false; } };
      const inject = (ifr) => {
        if (!ifr || __injectedIframes.has(ifr) || __iframeFailed.has(ifr)) return;
        if (!canAccess(ifr)) {
          if (ifr.contentWindow) __iframeFailed.add(ifr);
          return;
        }
        const tryInject = () => {
          try {
            const win = ifr.contentWindow;
            const doc = ifr.contentDocument || win?.document;
            if (!win || !doc) return;
            if (win[Symbol.for('__VSC_BOOT_LOCK__')]) { __injectedIframes.add(ifr); return; }
            const host = doc.head || doc.documentElement;
            if (!host) return;
            const s = doc.createElement('script');
            s.textContent = __VSC_INJECT_SOURCE;
            host.appendChild(s);
            s.remove?.();
            __injectedIframes.add(ifr);
          } catch (_) {
            __iframeFailed.add(ifr);
          }
        };
        tryInject();
        if (!__iframeLoadHooked.has(ifr)) {
          __iframeLoadHooked.add(ifr);
          ifr.addEventListener('load', () => {
            __iframeFailed.delete(ifr);
            if (canAccess(ifr)) tryInject();
            else __iframeFailed.add(ifr);
          }, { passive: true, signal: __globalSig });
        }
      };
      document.querySelectorAll('iframe').forEach(inject);
      const mo = new MutationObserver((muts) => {
        if (__globalSig.aborted) { mo.disconnect(); return; }
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'IFRAME') { inject(n); }
            else if (n.getElementsByTagName) {
              const iframes = n.getElementsByTagName('iframe');
              for (let i = 0; i < iframes.length; i++) inject(iframes[i]);
            }
          }
        }
      });
      const observeRoot = document.documentElement || document.body;
      if (observeRoot) mo.observe(observeRoot, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => { if (__globalSig.aborted) return; const r = document.documentElement || document.body; if (r) mo.observe(r, { childList: true, subtree: true }); }, { once: true, signal: __globalSig });
      __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
    }

    /* ── Fullscreen wrapper ── */
    const fsWraps = new WeakMap();
    function ensureFsWrapper(video) {
      if (fsWraps.has(video)) {
        const existing = fsWraps.get(video);
        if (existing.isConnected && existing.contains(video)) return existing;
        restoreFromFsWrapper(video);
      }
      if (!video || !video.parentNode) return null;
      const parent = video.parentNode;
      if (!parent.isConnected || parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return null;
      try {
        const rootNode = video.getRootNode();
        if (rootNode instanceof ShadowRoot) {
          if (video.assignedSlot || rootNode.host !== parent) return null;
        }
      } catch (_) {}
      const wrap = document.createElement('div');
      wrap.className = 'vsc-fs-wrap';
      wrap.style.cssText = 'position:relative;display:inline-block;width:100%;height:100%;max-width:100%;background:black;';
      const ph = document.createComment('vsc-video-placeholder');
      try {
        parent.insertBefore(ph, video);
        parent.insertBefore(wrap, ph);
        wrap.appendChild(video);
      } catch (e) {
        try { if (wrap.contains(video) && ph.parentNode) ph.parentNode.insertBefore(video, ph); } catch (_) {}
        try { if (ph.parentNode) ph.remove(); } catch (_) {}
        try { if (wrap.parentNode) wrap.remove(); } catch (_) {}
        return null;
      }
      wrap.__vscPlaceholder = ph;
      fsWraps.set(video, wrap);
      return wrap;
    }

    function restoreFromFsWrapper(video) {
      const wrap = fsWraps.get(video);
      if (!wrap) return;
      const ph = wrap.__vscPlaceholder;
      let restored = false;
      if (ph?.parentNode?.isConnected) {
        try { ph.parentNode.insertBefore(video, ph); ph.remove(); restored = true; } catch (_) {}
      }
      if (!restored && wrap.parentNode?.isConnected) {
        try { wrap.parentNode.insertBefore(video, wrap); restored = true; } catch (_) {}
      }
      if (!restored && !video.isConnected) {
        log.warn('Video could not be restored to DOM after fullscreen exit.');
      }
      try { if (ph?.parentNode) ph.remove(); } catch (_) {}
      try {
        if (wrap.parentNode) {
          const remaining = wrap.querySelector('video');
          if (!remaining || remaining !== video) wrap.remove();
        }
      } catch (_) {}
      fsWraps.delete(video);
      const st = getVState(video);
      st.fsPatched = false;
    }

    function patchMethodSafe(obj, name, wrappedFn) { try { obj[name] = wrappedFn; return true; } catch (_) { return false; } }

    function patchFullscreenRequest(video) {
      const st = getVState(video);
      if (!video || st.fsPatched) return;
      try {
        const parent = video.parentNode;
        if (!parent || !parent.isConnected) return;
        const testComment = document.createComment('');
        parent.insertBefore(testComment, video);
        testComment.remove();
      } catch (_) { return; }
      st.fsPatched = true;
      const origStd = video.requestFullscreen;
      const origWebkit = video.webkitRequestFullscreen;
      if (!origStd && !origWebkit) return;
      if (origStd) video.__vsc_orig_requestFullscreen = origStd;
      if (origWebkit) video.__vsc_orig_webkitRequestFullscreen = origWebkit;
      const runWrappedFs = function (origFn, ...args) {
        const wrap = ensureFsWrapper(video);
        const cleanupIfNotFullscreen = () => { const fsEl = document.fullscreenElement || document.webkitFullscreenElement; if (!fsEl && fsWraps.has(video)) restoreFromFsWrapper(video); };
        if (wrap) {
          const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
          if (typeof req === 'function') {
            try { const ret = req.apply(wrap, args); if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; }
          }
        }
        try { const ret = origFn.apply(video, args); if (ret && typeof ret.then === 'function') return ret.catch(err => { cleanupIfNotFullscreen(); throw err; }); return ret; } catch (err) { cleanupIfNotFullscreen(); throw err; }
      };
      if (origStd) patchMethodSafe(video, 'requestFullscreen', function (...args) { return runWrappedFs.call(this, origStd, ...args); });
      if (origWebkit) patchMethodSafe(video, 'webkitRequestFullscreen', function (...args) { return runWrappedFs.call(this, origWebkit, ...args); });
      __globalSig.addEventListener('abort', () => {
        try {
          if (video.__vsc_orig_requestFullscreen) { video.requestFullscreen = video.__vsc_orig_requestFullscreen; delete video.__vsc_orig_requestFullscreen; }
          if (video.__vsc_orig_webkitRequestFullscreen) { video.webkitRequestFullscreen = video.__vsc_orig_webkitRequestFullscreen; delete video.__vsc_orig_webkitRequestFullscreen; }
          st.fsPatched = false;
        } catch (_) {}
      }, { once: true });
    }

    function onFsChange() {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl) {
        const candidates = [];
        for (const v of TOUCHED.videos) { if (fsWraps.has(v)) candidates.push(v); }
        if (candidates.length === 0) return;
        requestAnimationFrame(() => {
          const currentFs = document.fullscreenElement || document.webkitFullscreenElement;
          for (const v of candidates) {
            if (!v.isConnected) continue;
            const wrap = fsWraps.get(v);
            if (wrap && currentFs === wrap) continue;
            restoreFromFsWrapper(v);
          }
          try { __internal.ApplyReq?.hard(); } catch (_) {}
        });
      }
      if (__internal._uiEnsure) requestAnimationFrame(() => { try { __internal._uiEnsure(); } catch (_) {} });
    }
    onDoc('fullscreenchange', onFsChange);
    onDoc('webkitfullscreenchange', onFsChange);

    /* ── PiP state ── */
    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ''; }
    function getActivePiPVideo() {
      if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
      if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo;
      return null;
    }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }

    function cleanupPipDocumentSvg(pipDoc) {
      try {
        if (!pipDoc || pipDoc === document) return;
        const svgs = pipDoc.querySelectorAll('svg');
        for (const svg of svgs) { if (svg.querySelector('[id^="vsc-"]')) { try { svg.remove(); } catch (_) {} } }
      } catch (_) {}
    }

    setRecurring(() => {
      if (__activeDocumentPiPWindow) {
        if (__activeDocumentPiPWindow.closed) {
          const video = __activeDocumentPiPVideo;
          resetPiPState();
          if (video) { const st = getVState(video); st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; }
        } else if (__activeDocumentPiPVideo && !__activeDocumentPiPVideo.isConnected) {
          try { __activeDocumentPiPWindow.close(); } catch (_) {}
          resetPiPState();
        }
      }
    }, 2000);

    /* ── FeatureRegistry (v200: modular feature system) ── */
    function createFeatureRegistry(globalSig) {
      const features = new Map();
      const initOrder = [];
      const STATUS = Object.freeze({ PENDING: 0, ACTIVE: 1, DESTROYED: 2, ERROR: 3 });

      function register(name, factory, deps = []) {
        if (features.has(name)) {
          log.warn(`[FeatureRegistry] duplicate registration ignored: ${name}`);
          return;
        }
        features.set(name, { factory, deps, instance: null, ac: null, status: STATUS.PENDING });
      }

      function resolve(name) {
        const entry = features.get(name);
        if (!entry) throw new Error(`[FeatureRegistry] unknown feature: ${name}`);
        if (entry.status === STATUS.ACTIVE) return entry.instance;
        if (entry.status === STATUS.DESTROYED) throw new Error(`[FeatureRegistry] already destroyed: ${name}`);
        const resolvedDeps = {};
        for (const dep of entry.deps) {
          if (dep === name) throw new Error(`[FeatureRegistry] self-dependency: ${name}`);
          resolvedDeps[dep] = resolve(dep);
        }
        const ac = new AbortController();
        const moduleSignal = combineSignals(globalSig, ac.signal);
        try {
          entry.instance = entry.factory(resolvedDeps, moduleSignal);
          entry.ac = ac;
          entry.status = STATUS.ACTIVE;
          initOrder.push(name);
          log.debug(`[FeatureRegistry] activated: ${name}`);
          return entry.instance;
        } catch (e) {
          entry.status = STATUS.ERROR;
          ac.abort();
          log.error(`[FeatureRegistry] init failed: ${name}`, e);
          throw e;
        }
      }

      function destroy(name) {
        const entry = features.get(name);
        if (!entry || entry.status !== STATUS.ACTIVE) return;
        entry.status = STATUS.DESTROYED;
        if (entry.ac) { entry.ac.abort(); entry.ac = null; }
        if (typeof entry.instance?.destroy === 'function') {
          try { entry.instance.destroy(); } catch (e) { log.warn(`[FeatureRegistry] destroy error: ${name}`, e); }
        }
        entry.instance = null;
        log.debug(`[FeatureRegistry] destroyed: ${name}`);
      }

      function destroyAll() {
        for (let i = initOrder.length - 1; i >= 0; i--) {
          destroy(initOrder[i]);
        }
        initOrder.length = 0;
      }

      function get(name) {
        return features.get(name)?.instance ?? null;
      }

      function getStatus(name) {
        return features.get(name)?.status ?? null;
      }

      function listActive() {
        const result = [];
        for (const [name, entry] of features) {
          if (entry.status === STATUS.ACTIVE) result.push(name);
        }
        return result;
      }

      globalSig.addEventListener('abort', destroyAll, { once: true });

      return Object.freeze({ register, resolve, destroy, destroyAll, get, getStatus, listActive, STATUS });
    }

    // ═══ END OF PART 1 (v200.0.0-Hybrid) ═══
    // PART 2 continues with: createTargeting, createEventBus, createUtils, createScheduler, createLocalStore, normalizeBySchema, createRegistry
    // ═══ PART 2 START (v200.0.0-Hybrid) — continues directly from PART 1's createFeatureRegistry ═══

    /* ── Targeting (v200: MIN_AREA 완화, unchanged logic) ── */
    function createTargeting() {
      let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
      const SCORE = Object.freeze({
        PLAYING: 5.0, HAS_PROGRESS: 1.5, AREA_SCALE: 1.5, AREA_DIVISOR: 12000,
        USER_PROX_MAX: 2.5, USER_PROX_DECAY: 1500, USER_PROX_RAD_SQ: 722500,
        CENTER_BIAS: 0.5, CENTER_RAD_SQ: 810000, AUDIO_BASE: 1.5,
        AUDIO_BOOST_EXTRA: 0.8, PIP_BONUS: 6.0
      });
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now(); const vp = getViewportSnapshot();
        let best = null, bestScore = -Infinity;
        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, now, 350); const area = r.width * r.height;
          const pip = isPiPActiveVideo(v);
          if (area < 100 && !pip) return;
          const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.5;
          let s = 0;
          if (!v.paused && !v.ended) s += SCORE.PLAYING;
          if (v.currentTime > 0.2) s += SCORE.HAS_PROGRESS;
          s += Math.log2(1 + area / SCORE.AREA_DIVISOR) * SCORE.AREA_SCALE;
          const ptAge = Math.max(0, now - (lastUserPt.t || 0));
          const userBias = Math.exp(-ptAge / SCORE.USER_PROX_DECAY);
          const dx = cx - lastUserPt.x, dy = cy - lastUserPt.y;
          s += (SCORE.USER_PROX_MAX * userBias) / (1 + (dx * dx + dy * dy) / SCORE.USER_PROX_RAD_SQ);
          const cdx = cx - vp.cx, cdy = cy - vp.cy;
          s += SCORE.CENTER_BIAS / (1 + (cdx * cdx + cdy * cdy) / SCORE.CENTER_RAD_SQ);
          if (!v.muted && v.volume > 0.01) s += SCORE.AUDIO_BASE + (audioBoostOn ? SCORE.AUDIO_BOOST_EXTRA : 0);
          if (pip) s += SCORE.PIP_BONUS;
          if (s > bestScore) { bestScore = s; best = v; }
        };
        for (const v of videos) evalScore(v);
        const activePip = getActivePiPVideo();
        if (activePip && activePip.isConnected && !videos.has(activePip)) evalScore(activePip);
        if (stickyTarget && stickyTarget.isConnected && now < stickyUntil) {
          if (!stickyTarget.paused && !stickyTarget.ended && best && stickyTarget !== best && (bestScore < stickyScore + GUARD.TARGET_HYSTERESIS_MARGIN)) return { target: stickyTarget };
        }
        stickyTarget = best; stickyScore = bestScore; stickyUntil = now + GUARD.TARGET_HYSTERESIS_MS;
        return { target: best };
      }
      return Object.freeze({ pickFastActiveOnly });
    }

    /* ── Event Bus ── */
    function createEventBus() {
      const subs = new Map();
      const on = (name, fn) => { let s = subs.get(name); if (!s) { s = new Set(); subs.set(name, s); } s.add(fn); return () => s.delete(fn); };
      const emit = (name, payload) => { const s = subs.get(name); if (!s) return; for (const fn of s) { try { fn(payload); } catch (_) {} } };
      let queued = false, flushTimer = 0, forceApplyAgg = false;
      function flush() {
        queued = false;
        if (flushTimer) { clearTimer(flushTimer); flushTimer = 0; }
        const payload = { forceApply: forceApplyAgg };
        emit('signal', payload);
        forceApplyAgg = false;
      }
      const signal = (p) => {
        if (p) { if (p.forceApply) forceApplyAgg = true; }
        if (!queued) {
          queued = true;
          if (document.visibilityState === 'hidden') flushTimer = setTimer(flush, 0);
          else requestAnimationFrame(flush);
        }
      };
      return Object.freeze({ on, signal });
    }

    function createApplyRequester(Bus, Scheduler) {
      return Object.freeze({
        soft() { try { Bus.signal(); } catch (_) { try { Scheduler.request(false); } catch (_) {} } },
        hard() { try { Bus.signal({ forceApply: true }); } catch (_) { try { Scheduler.request(true); } catch (_) {} } }
      });
    }

    /* ── Utils (v200: SVG_TAGS unchanged, deepClone simplified) ── */
    function createUtils() {
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const SVG_NS = 'http://www.w3.org/2000/svg';
          const SVG_TAGS = new Set([
            'svg', 'defs', 'filter', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA',
            'feConvolveMatrix', 'feColorMatrix', 'feGaussianBlur', 'feMerge', 'feMergeNode',
            'feComposite', 'feBlend', 'g', 'path', 'circle', 'rect', 'line', 'text',
            'polyline'
          ]);
          const isSvgEl = props.ns === 'svg' || SVG_TAGS.has(tag);
          const el = isSvgEl ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
          for (const [k, v] of Object.entries(props)) {
            if (k === 'ns') continue;
            if (k.startsWith('on')) { el.addEventListener(k.slice(2).toLowerCase(), (e) => { if (k === 'onclick' && (tag === 'button' || tag === 'input')) e.stopPropagation(); v(e); }); }
            else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
            else if (k === 'class') { if (isSvgEl) el.setAttribute('class', v); else el.className = v; }
            else if (v !== false && v != null) el.setAttribute(k, v);
          }
          children.flat().forEach(c => { if (c != null) el.append(typeof c === 'string' ? document.createTextNode(c) : c); });
          return el;
        },
        deepClone: (defaults) => {
          const state = {};
          for (const [cat, obj] of Object.entries(defaults)) {
            if (Array.isArray(obj)) state[cat] = obj.map(v => v && typeof v === 'object' ? { ...v } : v);
            else if (typeof obj === 'object' && obj !== null) state[cat] = { ...obj };
            else state[cat] = obj;
          }
          return state;
        },
        createCappedMap: (max = 64) => {
          const m = new Map();
          return {
            get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
            set(k, v) { if (m.has(k)) m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }
          };
        }
      };
    }

    /* ── Scheduler ── */
    function createScheduler(minIntervalMs = 14) {
      let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0, epoch = 0;
      function clearPending() { epoch++; if (timer) { clearTimer(timer); timer = 0; } if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
      function queueRaf() {
        if (rafId) return;
        const myEpoch = epoch;
        rafId = requestAnimationFrame(() => { rafId = 0; if (myEpoch !== epoch) return; run(); });
      }
      function run() {
        queued = false;
        const now = performance.now(), doForce = force; force = false;
        const dt = now - lastRun;
        if (!doForce && dt < minIntervalMs) {
          const wait = Math.max(0, minIntervalMs - dt);
          if (!timer) {
            const myEpoch = epoch;
            timer = setTimer(() => { timer = 0; if (myEpoch !== epoch) return; queueRaf(); }, wait);
          }
          return;
        }
        lastRun = now;
        if (applyFn) { try { applyFn(doForce); } catch (_) {} }
      }
      const request = (immediate = false) => {
        if (immediate) { force = true; clearPending(); queued = true; queueRaf(); return; }
        if (queued) return; queued = true; clearPending(); queueRaf();
      };
      return { registerApply: (fn) => { applyFn = fn; }, request };
    }

    /* ── Local Store ── */
    function createLocalStore(defaults, scheduler, Utils) {
      let rev = 0;
      const listeners = new Map();
      const state = Utils.deepClone(defaults);
      const pathCache = new Map();
      let batchDepth = 0, batchChanged = false;
      const batchEmits = new Map();

      const emit = (key, val) => {
        const a = listeners.get(key);
        if (a) for (const cb of a) { try { cb(val); } catch (_) {} }
        const dot = key.indexOf('.');
        if (dot > 0) {
          const catStar = key.slice(0, dot) + '.*';
          const b = listeners.get(catStar);
          if (b) for (const cb of b) { try { cb(val); } catch (_) {} }
        }
      };

      const parsePath = (p) => {
        let hit = pathCache.get(p);
        if (hit) return hit;
        const dot = p.indexOf('.');
        hit = (dot < 0) ? [p, null] : [p.slice(0, dot), p.slice(dot + 1)];
        pathCache.set(p, hit); return hit;
      };

      function flushBatch() {
        if (!batchChanged) return;
        const emitsSnapshot = new Map(batchEmits);
        batchEmits.clear(); batchChanged = false; rev++;
        for (const [key, val] of emitsSnapshot) emit(key, val);
        scheduler.request(false);
      }

      function notifyChange(fullPath, val) {
        if (batchDepth > 0) { batchChanged = true; batchEmits.set(fullPath, val); return; }
        rev++; emit(fullPath, val); scheduler.request(false);
      }

      return {
        state, rev: () => rev,
        getCatRef: (cat) => state[cat],
        get: (p) => { const [c, k] = parsePath(p); return k ? state[c]?.[k] : state[c]; },
        set: (p, val) => {
          const [c, k] = parsePath(p);
          if (k == null) {
            if (typeof state[c] === 'object' && state[c] !== null && typeof val === 'object' && val !== null) {
              for (const [subK, subV] of Object.entries(val)) {
                if (!Object.is(state[c][subK], subV)) { state[c][subK] = subV; notifyChange(`${c}.${subK}`, subV); }
              }
            } else { if (Object.is(state[c], val)) return; state[c] = val; notifyChange(c, val); }
            return;
          }
          if (Object.is(state[c]?.[k], val)) return;
          state[c][k] = val; notifyChange(p, val);
        },
        batch: (cat, obj) => {
          batchDepth++;
          try {
            for (const [k, v] of Object.entries(obj)) {
              if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; batchChanged = true; batchEmits.set(`${cat}.${k}`, v); }
            }
          } catch (e) { log.warn('batch partial error:', e); }
          finally { batchDepth--; if (batchDepth === 0) flushBatch(); }
        },
        sub: (k, f) => {
          let s = listeners.get(k);
          if (!s) { s = new Set(); listeners.set(k, s); }
          s.add(f); return () => listeners.get(k)?.delete(f);
        }
      };
    }

    function normalizeBySchema(sm, schema) {
      let changed = false;
      const setIfDiff = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
      for (const rule of schema) {
        const { type, path } = rule;
        if (type === 'bool') { setIfDiff(path, !!sm.get(path)); continue; }
        if (type === 'enum') { const cur = sm.get(path); if (!rule.values.includes(cur)) setIfDiff(path, rule.fallback()); continue; }
        if (type === 'num') {
          let n = Number(sm.get(path));
          if (!Number.isFinite(n)) n = rule.fallback();
          if (rule.round) n = Math.round(n);
          n = Math.max(rule.min, Math.min(rule.max, n));
          setIfDiff(path, n); continue;
        }
      }
      return changed;
    }

    /* ── Registry (v200: ShadowRoot disconnect detection, WorkQ background priority) ── */
    function createRegistry(scheduler) {
      const videos = new Set(), visible = { videos: new Set() };
      let dirtyA = { videos: new Set() }, dirtyB = { videos: new Set() }, dirty = dirtyA, rev = 0;
      const shadowRootsLRU = [];
      const observedShadowHosts = new WeakSet();
      let __refreshQueued = false;

      function requestRefreshCoalesced() {
        if (__refreshQueued) return;
        __refreshQueued = true;
        requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(false); });
      }

      const io = (typeof IntersectionObserver === 'function') ? new IntersectionObserver((entries) => {
        let changed = false; const now = performance.now();
        for (const e of entries) {
          const el = e.target;
          const isVis = e.isIntersecting || e.intersectionRatio > 0;
          const st = getVState(el);
          st.visible = isVis; st.rect = e.boundingClientRect; st.rectT = now;
          if (isVis) { if (!visible.videos.has(el)) { visible.videos.add(el); dirty.videos.add(el); changed = true; } }
          else { if (visible.videos.has(el)) { visible.videos.delete(el); dirty.videos.add(el); changed = true; } }
        }
        if (changed) { rev++; requestRefreshCoalesced(); }
      }, { root: null, threshold: [0, 0.05, 0.5], rootMargin: '150px' }) : null;

      const isInVscUI = (node) => (node.closest?.('[data-vsc-ui="1"]') || (node.getRootNode?.().host?.closest?.('[data-vsc-ui="1"]')));

      const ro = (typeof ResizeObserver === 'function') ? new ResizeObserver((entries) => {
        let changed = false; const now = performance.now();
        for (const e of entries) {
          const el = e.target;
          if (!el || el.tagName !== 'VIDEO') continue;
          const st = getVState(el);
          st.rect = e.contentRect ? el.getBoundingClientRect() : null;
          st.rectT = now; st.rectEpoch = -1; st._resizeDirty = true;
          dirty.videos.add(el); changed = true;
        }
        if (changed) requestRefreshCoalesced();
      }) : null;

      const observeVideo = (el) => {
        if (!el || el.tagName !== 'VIDEO' || isInVscUI(el) || videos.has(el)) return;
        videos.add(el);
        if (io) {
          io.observe(el);
        } else {
          const st = getVState(el);
          st.visible = true;
          if (!visible.videos.has(el)) {
            visible.videos.add(el); dirty.videos.add(el); rev++;
            if (!__refreshQueued) {
              __refreshQueued = true;
              requestAnimationFrame(() => { __refreshQueued = false; scheduler.request(true); });
            }
          }
        }
        if (ro) ro.observe(el);
      };

      /* ── WorkQ ── */
      const WorkQ = (() => {
        const MAX_QUEUE_SIZE = 500;
        const q = [], bigQ = [];
        let head = 0, bigHead = 0, scheduled = false, epoch = 1;
        const mark = new WeakMap();

        function drainRunnerIdle(dl) { drain(dl); }
        function drainRunnerRaf() { drain(); }

        const postTaskBg = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function')
          ? (fn) => globalThis.scheduler.postTask(fn, { priority: 'background' }) : null;

        const schedule = () => {
          if (scheduled) return; scheduled = true;
          if (postTaskBg) { postTaskBg(drainRunnerRaf).catch(() => { if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 }); else requestAnimationFrame(drainRunnerRaf); }); return; }
          if (window.requestIdleCallback) requestIdleCallback(drainRunnerIdle, { timeout: 120 });
          else requestAnimationFrame(drainRunnerRaf);
        };

        const enqueue = (n) => {
          if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return;
          if ((q.length - head) + (bigQ.length - bigHead) >= MAX_QUEUE_SIZE) { scanNode(n); return; }
          const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch);
          (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n);
          schedule();
        };

        const scanNode = (n) => {
          if (!n) return;
          if (n.nodeType === 1) {
            if (n.tagName === 'VIDEO') { observeVideo(n); return; }
            try { const vs = n.getElementsByTagName ? n.getElementsByTagName('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {}
            return;
          }
          if (n.nodeType === 11) {
            try { const vs = n.querySelectorAll ? n.querySelectorAll('video') : null; if (!vs || vs.length === 0) return; for (let i = 0; i < vs.length; i++) observeVideo(vs[i]); } catch (_) {}
          }
        };

        const drain = (dl) => {
          scheduled = false;
          const start = performance.now();
          const budget = dl?.timeRemaining ? () => dl.timeRemaining() > 2 : () => (performance.now() - start) < 6;
          let bigProcessed = 0;
          while (budget()) {
            if (bigHead < bigQ.length && bigProcessed < 1) { scanNode(bigQ[bigHead++]); bigProcessed++; continue; }
            bigProcessed = 0;
            if (head < q.length) { scanNode(q[head++]); if ((head & 3) === 0 && bigHead < bigQ.length) continue; }
            else if (bigHead < bigQ.length) { scanNode(bigQ[bigHead++]); }
            else break;
          }
          if (head >= q.length && bigHead >= bigQ.length) { q.length = 0; bigQ.length = 0; head = 0; bigHead = 0; epoch++; return; }
          schedule();
        };

        return Object.freeze({ enqueue });
      })();

      function nodeMayContainVideo(n) {
        if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) return false;
        if (n.nodeType === 1) {
          if (n.tagName === 'VIDEO') return true;
          if ((n.childElementCount || 0) === 0) return false;
          try { const list = n.getElementsByTagName ? n.getElementsByTagName('video') : null; return !!(list && list.length); } catch (_) { try { return !!(n.querySelector && n.querySelector('video')); } catch (_) { return false; } }
        }
        try { const list = n.querySelectorAll ? n.querySelectorAll('video') : null; return !!(list && list.length); } catch (_) { return false; }
      }

      const observers = new Set();
      const isVscOwnNode = (n) => {
        if (!n || n.nodeType !== 1) return false;
        if (n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host' || n.id === 'vsc-osd') return true;
        const tag = n.tagName;
        if ((tag === 'svg' || tag === 'SVG') && n.querySelector?.('[id^="vsc-"]')) return true;
        return false;
      };

      /* v200: ShadowRoot disconnect detection via periodic check */
      const connectObserver = (root) => {
        if (!root) return;
        const mo = new MutationObserver((muts) => {
          if (__globalSig.aborted) { mo.disconnect(); observers.delete(mo); return; }
          if (root !== document && root !== document.body && root !== document.documentElement) {
            const host = root.host || root;
            if (host && typeof host.isConnected === 'boolean' && !host.isConnected) {
              mo.disconnect();
              observers.delete(mo);
              return;
            }
          }
          let touchedVideoTree = false;
          for (const m of muts) {
            if (m.addedNodes && m.addedNodes.length) {
              for (const n of m.addedNodes) {
                if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
                if (n.nodeType === 1 && isVscOwnNode(n)) continue;
                WorkQ.enqueue(n);
                if (!touchedVideoTree && nodeMayContainVideo(n)) touchedVideoTree = true;
              }
            }
            if (!touchedVideoTree && m.removedNodes && m.removedNodes.length) {
              for (const n of m.removedNodes) {
                if (!n || n.nodeType !== 1) continue;
                if (n.tagName === 'VIDEO') { touchedVideoTree = true; break; }
                if ((n.childElementCount || 0) > 0) {
                  try { const list = n.getElementsByTagName?.('video'); if (list && list.length) { touchedVideoTree = true; break; } } catch (_) {}
                }
              }
            }
          }
          if (touchedVideoTree) requestRefreshCoalesced();
        });
        mo.observe(root, { childList: true, subtree: true });
        observers.add(mo);

        /* v200: periodic disconnect check for ShadowRoot hosts */
        if (root instanceof ShadowRoot && root.host) {
          const hostEl = root.host;
          const checkDisconnect = setRecurring(() => {
            if (!hostEl.isConnected) {
              mo.disconnect();
              observers.delete(mo);
              clearRecurring(checkDisconnect);
            }
          }, 5000, { maxErrors: 10 });
        }

        WorkQ.enqueue(root);
      };

      const refreshObservers = () => {
        for (const o of observers) o.disconnect(); observers.clear();
        if (!FEATURE_FLAGS.trackShadowRoots) {
          const root = document.body || document.documentElement;
          if (root) { WorkQ.enqueue(root); connectObserver(root); } return;
        }
        for (const it of shadowRootsLRU) { if (it.host?.isConnected) connectObserver(it.root); }
        const root = document.body || document.documentElement;
        if (root) { WorkQ.enqueue(root); connectObserver(root); }
      };

      if (FEATURE_FLAGS.trackShadowRoots) {
        __internal._onShadow = (host, sr) => {
          try {
            if (!sr || !host || observedShadowHosts.has(host)) return;
            observedShadowHosts.add(host);
            if (shadowRootsLRU.length >= SHADOW_ROOT_LRU_MAX) {
              const idx = shadowRootsLRU.findIndex(it => !it.host?.isConnected);
              if (idx >= 0) shadowRootsLRU.splice(idx, 1); else shadowRootsLRU.shift();
            }
            shadowRootsLRU.push({ host, root: sr });
            connectObserver(sr);
          } catch (_) {}
        };
      }

      refreshObservers();

      __globalSig.addEventListener('abort', () => {
        for (const o of observers) { try { o.disconnect(); } catch (_) {} }
        observers.clear();
        if (io) { try { io.disconnect(); } catch (_) {} }
        if (ro) { try { ro.disconnect(); } catch (_) {} }
      }, { once: true });

      function pruneBatch(set, visibleSet, dirtySet, limit = 200) {
        let removed = 0, scanned = 0;
        for (const el of set) {
          if (++scanned > limit) break;
          if (!el || !el.isConnected) {
            set.delete(el); visibleSet.delete(el); dirtySet.delete(el);
            if (fsWraps.has(el)) {
              const wrap = fsWraps.get(el);
              try { if (wrap?.__vscPlaceholder?.parentNode) wrap.__vscPlaceholder.remove(); } catch (_) {}
              try { if (wrap?.parentNode && !wrap.querySelector('video')) wrap.remove(); } catch (_) {}
              fsWraps.delete(el);
            }
            /* v200: _ac abort now actually disconnects per-video listeners */
            const vst = videoStateMap.get(el);
            if (vst?._ac) { vst._ac.abort(); vst._ac = null; vst.bound = false; }
            if (io) { try { io.unobserve(el); } catch (_) {} }
            if (ro) { try { ro.unobserve(el); } catch (_) {} }
            removed++;
          }
        }
        return removed;
      }

      return {
        videos, visible, rev: () => rev, refreshObservers,
        prune: () => { const removed = pruneBatch(videos, visible.videos, dirty.videos, 220); if (removed) rev++; },
        consumeDirty: () => { const out = dirty; dirty = (dirty === dirtyA) ? dirtyB : dirtyA; dirty.videos.clear(); return out; },
        rescanAll: () => {
          const body = document.body || document.documentElement;
          if (body) WorkQ.enqueue(body);
          for (const it of shadowRootsLRU) { if (it.host?.isConnected) WorkQ.enqueue(it.root); }
        }
      };
    }

    /* ── Audio Engine (v200: unchanged from v199.5 except Symbol refs) ── */
    function createAudio(sm) {
      let ctx, compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, clipper, analyser, dataArray;
      let target = null, currentSrc = null;
      let srcMap = new WeakMap();
      let makeupDbEma = 0;
      let switchTimer = 0, switchTok = 0;
      let gestureHooked = false;
      let loopTok = 0;
      let __audioLoopTimer = 0;
      let __ctxCreateCount = 0;
      const MAX_CTX_RECREATES = 5;
      let __ctxBlockUntil = 0;
      let __ctxCooldownCount = 0;
      const MAX_COOLDOWNS = 3;

      const VSC_AUD_HPF_HZ = 55;
      const VSC_AUD_HPF_Q = 0.707;
      const VSC_AUD_CLIP_KNEE = 0.82;
      const VSC_AUD_CLIP_DRIVE = 2.2;

      const __vscClipCurve = (() => {
        const n = 2048, knee = VSC_AUD_CLIP_KNEE, drive = VSC_AUD_CLIP_DRIVE;
        const curve = new Float32Array(n);
        const tanhD = Math.tanh(drive);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          const ax = Math.abs(x);
          let y;
          if (ax <= knee) y = x;
          else { const t = (ax - knee) / Math.max(1e-6, (1 - knee)); const s = Math.tanh(drive * t) / tanhD; y = Math.sign(x) * (knee + (1 - knee) * s); }
          curve[i] = y;
        }
        return curve;
      })();

      const onGesture = async () => {
        try {
          if (ctx && ctx.state === 'suspended') {
            const resumePromise = ctx.resume();
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('AudioContext resume timeout')), 3000));
            try { await Promise.race([resumePromise, timeoutPromise]); } catch (e) { log.debug('AudioContext resume failed/timed out:', e.message); }
            if (ctx && ctx.state === 'running') updateMix();
          }
          if (ctx && ctx.state === 'running' && gestureHooked) {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
            window.removeEventListener('touchstart', onGesture, true);
            window.removeEventListener('click', onGesture, true);
            gestureHooked = false;
          } else if (ctx && ctx.state === 'suspended') {
            ensureGestureResumeHook();
          }
        } catch (_) {}
      };

      const ensureGestureResumeHook = () => {
        if (gestureHooked) return;
        gestureHooked = true;
        for (const evt of ['pointerdown', 'keydown', 'touchstart', 'click']) {
          onWin(evt, onGesture, { passive: true, capture: true });
        }
      };

      const clamp = VSC_CLAMP;
      const VSC_AUDIO_AUTO_MAKEUP = true;

      function runAudioLoop(tok) {
        if (tok !== loopTok || !ctx || __globalSig.aborted) return;
        if (ctx.state === 'suspended') { makeupDbEma = 0; return; }
        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const actuallyEnabled = en && currentSrc;

        if (document.hidden && !actuallyEnabled) {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
          if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
          return;
        }

        if (!actuallyEnabled) {
          makeupDbEma += (0 - makeupDbEma) * 0.1;
          if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
          const delay = document.hidden ? 800 : 120;
          if (__audioLoopTimer) clearTimer(__audioLoopTimer);
          const currentTok = tok;
          __audioLoopTimer = setTimer(() => { __audioLoopTimer = 0; if (currentTok !== loopTok || __globalSig.aborted) return; runAudioLoop(currentTok); }, delay);
          return;
        }

        if (VSC_AUDIO_AUTO_MAKEUP && analyser) {
          analyser.getFloatTimeDomainData(dataArray);
          let sumSquare = 0;
          for (let i = 0; i < dataArray.length; i++) sumSquare += dataArray[i] * dataArray[i];
          const rms = Math.sqrt(sumSquare / dataArray.length);
          const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
          let redDb = 0;
          try { const r = compressor?.reduction; redDb = (typeof r === 'number') ? r : (r && typeof r.value === 'number') ? r.value : 0; } catch (_) {}
          if (!Number.isFinite(redDb)) redDb = 0;
          const redPos = clamp(-redDb, 0, 18);
          let gateMult = 1.0;
          if (db < -50) gateMult = 0.0;
          else if (db < -44) gateMult = (db - (-50)) / 6.0;
          const makeupDbTarget = clamp(Math.max(0, redPos - 3.0) * 0.25, 0, 5.0) * gateMult;
          const isAttack = makeupDbTarget < makeupDbEma;
          const alpha = isAttack ? 0.25 : 0.015;
          makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
        } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }

        const boostDb = Number(sm.get(P.A_BST) || 0);
        const userBoost = Math.pow(10, boostDb / 20);
        const makeup = Math.pow(10, makeupDbEma / 20);
        if (wetInGain) {
          const finalGain = userBoost * makeup;
          try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; }
        }

        const delay = document.hidden ? 800 : 120;
        if (__audioLoopTimer) clearTimer(__audioLoopTimer);
        const currentTok = tok;
        __audioLoopTimer = setTimer(() => { __audioLoopTimer = 0; if (currentTok !== loopTok || __globalSig.aborted) return; runAudioLoop(currentTok); }, delay);
      }

      const resetCtx = () => {
        try { compressor?.disconnect(); } catch (_) {}
        try { limiter?.disconnect(); } catch (_) {}
        try { hpf?.disconnect(); } catch (_) {}
        try { clipper?.disconnect(); } catch (_) {}
        try { wetInGain?.disconnect(); } catch (_) {}
        try { dryOut?.disconnect(); } catch (_) {}
        try { wetOut?.disconnect(); } catch (_) {}
        try { masterOut?.disconnect(); } catch (_) {}
        try { analyser?.disconnect(); } catch (_) {}
        ctx = null; compressor = null; limiter = null; wetInGain = null;
        dryOut = null; wetOut = null; masterOut = null; hpf = null;
        clipper = null; analyser = null; dataArray = null;
        currentSrc = null; target = null;
      };

      const buildAudioGraph = () => {
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18.0;
        compressor.knee.value = 8.0;
        compressor.ratio.value = 2.5;
        compressor.attack.value = 0.008;
        compressor.release.value = 0.15;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -0.5;
        limiter.knee.value = 0.0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0005;
        limiter.release.value = 0.10;

        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = VSC_AUD_HPF_HZ;
        hpf.Q.value = VSC_AUD_HPF_Q;

        clipper = ctx.createWaveShaper();
        clipper.curve = __vscClipCurve;
        try { clipper.oversample = '2x'; } catch (_) {}

        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        dataArray = new Float32Array(analyser.fftSize);

        dryOut = ctx.createGain();
        wetOut = ctx.createGain();
        wetInGain = ctx.createGain();
        masterOut = ctx.createGain();

        dryOut.connect(masterOut);
        wetOut.connect(masterOut);
        hpf.connect(compressor);
        hpf.connect(analyser);
        compressor.connect(wetInGain);
        wetInGain.connect(limiter);
        limiter.connect(clipper);
        clipper.connect(wetOut);
        masterOut.connect(ctx.destination);
      };

      const disconnectAllKnownSources = () => {
        for (const v of TOUCHED.videos) { try { const s = srcMap.get(v); if (s) { s.disconnect(); srcMap.delete(v); } } catch (_) {} }
        for (const v of TOUCHED.rateVideos) { try { const s = srcMap.get(v); if (s) { s.disconnect(); srcMap.delete(v); } } catch (_) {} }
      };

      const resetAllAudioFailUntil = () => {
        for (const v of TOUCHED.videos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
        for (const v of TOUCHED.rateVideos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
      };

      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') {
          disconnectAllKnownSources();
          srcMap = new WeakMap();
          resetAllAudioFailUntil();
          resetCtx();
          __ctxCreateCount++;
        }
        if (ctx) return true;
        const now = performance.now();
        if (now < __ctxBlockUntil) return false;
        if (__ctxCreateCount >= MAX_CTX_RECREATES) {
          __ctxCooldownCount++;
          if (__ctxCooldownCount >= MAX_COOLDOWNS) {
            __ctxBlockUntil = now + 300000;
            __ctxCooldownCount = 0;
            __ctxCreateCount = 0;
            log.warn('AudioContext creation blocked for 5 minutes');
            try { sm.set(P.A_EN, false); } catch (_) {}
            showOSD('오디오 부스트: 5분간 비활성화됨', 3000);
            return false;
          }
          const cooldownMs = Math.min(60000 * Math.pow(2, __ctxCooldownCount - 1), 240000);
          __ctxBlockUntil = now + cooldownMs;
          __ctxCreateCount = 0;
          log.warn(`AudioContext cooling down for ${cooldownMs / 1000}s (attempt ${__ctxCooldownCount}/${MAX_COOLDOWNS})`);
          return false;
        }
        disconnectAllKnownSources();
        srcMap = new WeakMap();
        resetAllAudioFailUntil();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); }
        catch (_) { try { ctx = new AC(); } catch (__) { return false; } }
        __ctxCreateCount++;
        ensureGestureResumeHook();
        buildAudioGraph();

        if (ctx && !ctx.__vscStateWatched) {
          ctx.__vscStateWatched = true;
          ctx.addEventListener('statechange', () => {
            if (ctx.state === 'suspended' && !document.hidden) {
              ctx.resume().catch(() => {});
              ensureGestureResumeHook();
            }
            if (ctx.state === 'running') updateMix();
          });
        }

        return true;
      };

      const rampGainsSafe = (dryTarget, wetTarget, tc = 0.015) => {
        if (!ctx || !dryOut || !wetOut) return;
        const t = ctx.currentTime;
        try { dryOut.gain.cancelScheduledValues(t); wetOut.gain.cancelScheduledValues(t); dryOut.gain.setTargetAtTime(dryTarget, t, tc); wetOut.gain.setTargetAtTime(wetTarget, t, tc); }
        catch (_) { dryOut.gain.value = dryTarget; wetOut.gain.value = wetTarget; }
      };

      const fadeOutThen = (fn) => {
        if (!ctx || !masterOut) { try { fn(); } catch (_) {} return; }
        const tok = ++switchTok;
        if (switchTimer) { clearTimer(switchTimer); switchTimer = 0; }
        makeupDbEma = 0;
        const savedCtx = ctx, savedMaster = masterOut;
        try {
          const t = savedCtx.currentTime;
          savedMaster.gain.cancelScheduledValues(t);
          savedMaster.gain.setValueAtTime(savedMaster.gain.value, t);
          savedMaster.gain.linearRampToValueAtTime(0, t + 0.04);
        } catch (_) { try { savedMaster.gain.value = 0; } catch (__) {} }
        switchTimer = setTimer(() => {
          switchTimer = 0;
          if (tok !== switchTok) return;
          try { fn(); } catch (_) {}
          if (ctx && masterOut && ctx.state !== 'closed') {
            try {
              const t2 = ctx.currentTime;
              masterOut.gain.cancelScheduledValues(t2);
              masterOut.gain.setValueAtTime(0, t2);
              masterOut.gain.linearRampToValueAtTime(1, t2 + 0.04);
            } catch (_) { try { masterOut.gain.value = 1; } catch (__) {} }
          }
        }, 60);
      };

      const disconnectAll = () => { if (currentSrc) { try { currentSrc.disconnect(); } catch (_) {} } currentSrc = null; target = null; };

      const updateMix = () => {
        if (!ctx) return;
        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const isHooked = !!currentSrc;
        const actuallyEnabled = en && isHooked;
        const dryTarget = actuallyEnabled ? 0 : 1;
        const wetTarget = actuallyEnabled ? 1 : 0;
        rampGainsSafe(dryTarget, wetTarget, 0.015);
        loopTok++;
        if (__audioLoopTimer) { clearTimer(__audioLoopTimer); __audioLoopTimer = 0; }
        if (actuallyEnabled) runAudioLoop(loopTok);
      };

      onDoc('visibilitychange', () => {
        if (document.visibilityState === 'visible' && ctx && ctx.state === 'running' && currentSrc) {
          loopTok++; runAudioLoop(loopTok);
        }
      }, { passive: true });

      function connectSource(v) {
        const st = v ? getVState(v) : null;
        try {
          let s = srcMap.get(v);
          if (!s) {
            try { s = ctx.createMediaElementSource(v); }
            catch (e) {
              if (e.name === 'InvalidStateError') {
                log.debug('MediaElementSource already exists for this element, permanently skipping');
                if (st) st.audioFailUntil = Infinity;
                return false;
              }
              throw e;
            }
            srcMap.set(v, s);
          }
          if (s.context !== ctx) {
            srcMap.delete(v);
            const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN;
            if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + cooldown;
            return false;
          }
          s.connect(dryOut);
          s.connect(hpf || compressor);
          currentSrc = s;
          return true;
        } catch (e) {
          log.warn('Audio source connection failed:', e);
          const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN;
          if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + cooldown;
          return false;
        }
      }

      function setTarget(v) {
        const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const st = v ? getVState(v) : null;
        if (st && st.audioFailUntil > performance.now()) {
          if (v !== target) fadeOutThen(() => { disconnectAll(); target = v; });
          updateMix(); return;
        }
        if (!ensureCtx()) return;
        if (v && ctx?.state === 'suspended' && !v.paused) ctx.resume().catch(() => {});
        if (v === target) { updateMix(); return; }
        fadeOutThen(() => {
          disconnectAll(); target = v;
          if (!v) { updateMix(); return; }
          if (!connectSource(v)) disconnectAll();
          updateMix();
        });
      }

      async function destroy() {
        loopTok++;
        if (__audioLoopTimer) { clearTimer(__audioLoopTimer); __audioLoopTimer = 0; }
        try {
          if (gestureHooked) {
            window.removeEventListener('pointerdown', onGesture, true);
            window.removeEventListener('keydown', onGesture, true);
            window.removeEventListener('touchstart', onGesture, true);
            window.removeEventListener('click', onGesture, true);
            gestureHooked = false;
          }
        } catch (_) {}
        if (switchTimer) { clearTimer(switchTimer); }
        switchTok++;
        disconnectAll();
        disconnectAllKnownSources();
        srcMap = new WeakMap();
        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        resetCtx();
        makeupDbEma = 0;
      }

      return { setTarget, update: updateMix, hasCtx: () => !!ctx, isHooked: () => !!currentSrc, destroy };
    }

    // ═══ END OF PART 2 (v200.0.0-Hybrid) ═══
    // PART 3 continues with: createAutoSceneManager (full), curveToApproxParams
    // ═══ PART 3 START (v200.0.0-Hybrid) — continues directly from PART 2's createAudio return ═══

    /* ══════════════════════════════════════════════════════════════════
       Auto Scene Manager (v200.0.0-Hybrid)
       ──────────────────────────────────────────────────────────────
       Patches carried from v199.5:
         #1  captureSceneFrame — VideoFrame timestamp fix
         #3  loop() — static scene fallback (framesSinceUpdate counter)
         #4  detectTransition — motionSAD delta comparison
         #5  interpolateCurves — double-buffer (no per-frame alloc)
         #6  flickerCount decay 0.5, max 5
         #7  classifySceneFuzzy — LOW_KEY boundary 0.30
         #8  buildAdaptiveToneCurve — dead-code non-zonal path removed
         #10 computeFullAnalysis — skinCount && short-circuit
         #11 adaptiveFps — fpsHist → CircularBuffer
         #13 AUTO.motionThresh 0.012
       v200 additions:
         - Symbol-based internal refs
         - showOSD via managed timer
       ══════════════════════════════════════════════════════════════════ */
    function createAutoSceneManager(Store, P, Scheduler) {
      const clamp = VSC_CLAMP;

      const HIST_BINS = 256;
      const TONE_STEPS = 256;
      const CANVAS_W = CONFIG.IS_MOBILE ? 80 : 112;
      const CANVAS_H = CONFIG.IS_MOBILE ? 45 : 63;
      const ZONE_COLS = 4, ZONE_ROWS = 4, ZONE_COUNT = 16;

      const ST = Object.freeze({ NORMAL: 0, LOW_KEY: 1, HIGH_KEY: 2, HIGH_CONTRAST: 3, LOW_SAT: 4, SKIN: 5, BACKLIT: 6 });
      const ST_NAMES = ['NORMAL', 'LOW_KEY', 'HIGH_KEY', 'HI_CONT', 'LOW_SAT', 'SKIN', 'BACKLIT'];
      const ST_COUNT = ST_NAMES.length;

      /* ── CLAHE shared buffers ── */
      const _claheClipped = new Float32Array(HIST_BINS);
      const _claheCdf = new Float32Array(HIST_BINS);
      const _claheZoneCDFPool = new Array(ZONE_COUNT);
      for (let i = 0; i < ZONE_COUNT; i++) _claheZoneCDFPool[i] = new Float32Array(HIST_BINS);
      const _claheCurveOut = new Float32Array(TONE_STEPS);

      function buildZonalCLAHE(zoneHists, zoneCounts, clipLimit) {
        const bins = HIST_BINS;
        const zoneCount = ZONE_COLS * ZONE_ROWS;
        for (let z = 0; z < zoneCount; z++) {
          const hist = zoneHists[z];
          const n = Math.max(1, zoneCounts[z]);
          const limit = (n / bins) * clipLimit;
          const clipped = _claheClipped;
          let excess = 0;
          for (let i = 0; i < bins; i++) {
            if (hist[i] > limit) { excess += hist[i] - limit; clipped[i] = limit; }
            else clipped[i] = hist[i];
          }
          const perBin = excess / bins;
          for (let i = 0; i < bins; i++) clipped[i] += perBin;
          const cdf = _claheCdf;
          cdf[0] = clipped[0];
          for (let i = 1; i < bins; i++) cdf[i] = cdf[i - 1] + clipped[i];
          const cdfMin = cdf[0];
          const cdfRange = Math.max(1, cdf[bins - 1] - cdfMin);
          const normalized = _claheZoneCDFPool[z];
          for (let i = 0; i < bins; i++) normalized[i] = (cdf[i] - cdfMin) / cdfRange;
        }
        const curve = _claheCurveOut;
        for (let i = 0; i < TONE_STEPS; i++) {
          const x = i / (TONE_STEPS - 1);
          const bin = Math.min(bins - 1, (x * (bins - 1)) | 0);
          let totalWeight = 0, totalVal = 0;
          for (let zy = 0; zy < ZONE_ROWS; zy++) {
            for (let zx = 0; zx < ZONE_COLS; zx++) {
              const zi = zy * ZONE_COLS + zx;
              const n = zoneCounts[zi];
              if (n < 4) continue;
              const cx = (zx + 0.5) / ZONE_COLS, cy = (zy + 0.5) / ZONE_ROWS;
              const dx = Math.abs(0.5 - cx), dy = Math.abs(0.5 - cy);
              const dist = Math.sqrt(dx * dx + dy * dy);
              const w = 1.0 / (0.1 + dist);
              totalVal += _claheZoneCDFPool[zi][bin] * w;
              totalWeight += w;
            }
          }
          curve[i] = totalWeight > 0 ? totalVal / totalWeight : x;
        }
        for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
        return curve.slice();
      }

      function buildAdaptiveToneCurve(lumHist, totalSamples, params, zoneHists, zoneCounts) {
        const { clipLimit = 2.5, shadowProtect = 0.4, highlightProtect = 0.3, midtoneBoost = 0.0, strength = 0.35 } = params;
        const equalized = buildZonalCLAHE(zoneHists, zoneCounts, clipLimit);
        const identity = new Float32Array(TONE_STEPS);
        for (let i = 0; i < TONE_STEPS; i++) identity[i] = i / (TONE_STEPS - 1);
        const raw = new Float32Array(TONE_STEPS);
        for (let i = 0; i < TONE_STEPS; i++) {
          const x = i / (TONE_STEPS - 1);
          const eq = equalized[i], id = identity[i];
          let regionWeight = 1.0;
          if (x < 0.18) { const t = x / 0.18; regionWeight = 1.0 - shadowProtect * (1 - t * t); }
          else if (x > 0.82) { const t = (x - 0.82) / 0.18; regionWeight = 1.0 - highlightProtect * (t * t); }
          let midBoost = 0;
          if (Math.abs(midtoneBoost) > 0.001) { const midW = Math.exp(-((x - 0.5) * (x - 0.5)) / (2 * 0.14 * 0.14)); midBoost = midtoneBoost * midW * 0.15; }
          const effectiveStrength = strength * regionWeight;
          raw[i] = clamp(id * (1 - effectiveStrength) + eq * effectiveStrength + midBoost, 0, 1);
        }
        const curve = new Float32Array(TONE_STEPS);
        curve[0] = raw[0]; curve[TONE_STEPS - 1] = raw[TONE_STEPS - 1];
        for (let i = 1; i < TONE_STEPS - 1; i++) curve[i] = raw[i] * 0.6 + (raw[i - 1] + raw[i + 1]) * 0.2;
        for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
        return curve;
      }

      function computeChannelBalance(rHist, gHist, bHist, totalSamples, skinRatio, hiLumaRBratio) {
        const correctionStrength = 0.14;
        const n = Math.max(1, totalSamples);
        let rMean = 0, gMean = 0, bMean = 0;
        for (let i = 0; i < HIST_BINS; i++) {
          const v = i / (HIST_BINS - 1);
          rMean += v * rHist[i]; gMean += v * gHist[i]; bMean += v * bHist[i];
        }
        rMean /= n; gMean /= n; bMean /= n;
        const avgMean = (rMean + gMean + bMean) / 3;
        if (avgMean < 0.01) return { rGain: 1, gGain: 1, bGain: 1 };
        const skinDampen = VSC_CLAMP(skinRatio || 0, 0, 0.4) / 0.4;
        const rMul = 0.45 * (1 - skinDampen * 0.6);
        let rGain = 1 + (avgMean / Math.max(0.01, rMean) - 1) * (correctionStrength * rMul);
        let gGain = 1 + (avgMean / Math.max(0.01, gMean) - 1) * (correctionStrength * 0.80);
        let bGain = 1 + (avgMean / Math.max(0.01, bMean) - 1) * correctionStrength;
        if (Number.isFinite(hiLumaRBratio) && hiLumaRBratio > 0) {
          const deviation = clamp(hiLumaRBratio - 1.0, -0.4, 0.4);
          const tempCorr = deviation * 0.10;
          rGain -= tempCorr * 0.5; bGain += tempCorr * 0.5;
        }
        return { rGain: VSC_CLAMP(rGain, 0.90, 1.10), gGain: VSC_CLAMP(gGain, 0.94, 1.06), bGain: VSC_CLAMP(bGain, 0.85, 1.15) };
      }

      const __fuzzyScores = new Float64Array(ST_COUNT);
      const __fuzzyEma = new Float64Array(ST_COUNT);
      let __fuzzyInited = false;

      function classifySceneFuzzy(stats, zoneStats) {
        const scores = __fuzzyScores; scores.fill(0);
        const br = stats.bright, ct = stats.contrast, ch = stats.chroma, sk = stats.skinRatio;
        scores[ST.NORMAL] = 1.0;
        if (br < 0.30) scores[ST.LOW_KEY] += (0.30 - br) / 0.30 * 3.0;
        if (ct < 0.22) scores[ST.LOW_KEY] += (0.22 - ct) / 0.22 * 1.5;
        if (br > 0.55) scores[ST.HIGH_KEY] += (br - 0.55) / 0.45 * 3.0;
        if (ct > 0.25) scores[ST.HIGH_CONTRAST] += (ct - 0.25) / 0.25 * 2.5;
        if (ch < 0.10) scores[ST.LOW_SAT] += (0.10 - ch) / 0.10 * 2.0;
        if (sk > 0.04) scores[ST.SKIN] += sk / 0.15 * 2.5;
        if (zoneStats) {
          const centerBr = zoneStats.centerBright, edgeBr = zoneStats.edgeAvgBright;
          if (edgeBr > 0.42 && centerBr < 0.42) {
            const gap = edgeBr - centerBr;
            if (gap > 0.08) scores[ST.BACKLIT] += gap / 0.20 * 3.5;
          }
        }
        const emaAlpha = 0.08;
        if (!__fuzzyInited) { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] = scores[i]; __fuzzyInited = true; }
        else { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] += (scores[i] - __fuzzyEma[i]) * emaAlpha; }
        let bestIdx = 0, bestVal = __fuzzyEma[0];
        for (let i = 1; i < ST_COUNT; i++) { if (__fuzzyEma[i] > bestVal) { bestVal = __fuzzyEma[i]; bestIdx = i; } }
        return bestIdx;
      }

      const SCENE_TONE_PARAMS = Object.freeze({
        [ST.NORMAL]:        { clipLimit: 2.0, shadowProtect: 0.35, highlightProtect: 0.30, midtoneBoost: 0.03, strength: 0.20, satTarget: 1.04 },
        [ST.LOW_KEY]:       { clipLimit: 2.0, shadowProtect: 0.55, highlightProtect: 0.20, midtoneBoost: 0.05, strength: 0.22, satTarget: 1.03 },
        [ST.HIGH_KEY]:      { clipLimit: 1.8, shadowProtect: 0.25, highlightProtect: 0.65, midtoneBoost: -0.03, strength: 0.18, satTarget: 1.04 },
        [ST.HIGH_CONTRAST]: { clipLimit: 1.5, shadowProtect: 0.50, highlightProtect: 0.50, midtoneBoost: 0.0, strength: 0.15, satTarget: 1.02 },
        [ST.LOW_SAT]:       { clipLimit: 2.2, shadowProtect: 0.35, highlightProtect: 0.30, midtoneBoost: 0.03, strength: 0.25, satTarget: 1.12 },
        [ST.SKIN]:          { clipLimit: 2.0, shadowProtect: 0.45, highlightProtect: 0.40, midtoneBoost: 0.02, strength: 0.16, satTarget: 1.02 },
        [ST.BACKLIT]:       { clipLimit: 2.2, shadowProtect: 0.25, highlightProtect: 0.55, midtoneBoost: 0.08, strength: 0.26, satTarget: 1.03 }
      });

      let prevToneCurve = null;
      let prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 };
      let prevSatMul = 1.0;

      const _interpBufA = new Float32Array(TONE_STEPS);
      const _interpBufB = new Float32Array(TONE_STEPS);
      let _interpActive = 0;

      function interpolateCurves(prev, next, alpha) {
        if (!prev) {
          const out = _interpActive === 0 ? _interpBufA : _interpBufB;
          out.set(next);
          _interpActive ^= 1;
          return out;
        }
        const out = _interpActive === 0 ? _interpBufA : _interpBufB;
        for (let i = 0; i < TONE_STEPS; i++) out[i] = prev[i] + (next[i] - prev[i]) * alpha;
        _interpActive ^= 1;
        return out;
      }

      function interpolateGains(prev, next, alpha) {
        return { rGain: prev.rGain + (next.rGain - prev.rGain) * alpha, gGain: prev.gGain + (next.gGain - prev.gGain) * alpha, bGain: prev.bGain + (next.bGain - prev.bGain) * alpha };
      }

      const CUT_HIST_LEN = 20;
      const cutScores = new CircularBuffer(CUT_HIST_LEN);
      const gradualScores = new CircularBuffer(10);

      function detectTransition(stats, prev) {
        if (!prev) return { isCut: false, isFade: false, score: 0 };
        const motionDelta = Math.abs((stats.motionSAD || 0) - (prev.motionSAD || 0));
        const score = Math.abs(stats.bright - prev.bright) * 1.3
          + Math.abs(stats.contrast - prev.contrast) * 0.7
          + Math.abs(stats.chroma - prev.chroma) * 0.5
          + Math.abs(stats.edge - prev.edge) * 0.3
          + motionDelta * 0.35;
        cutScores.push(score);
        const sorted = cutScores.toSorted();
        const q90 = sorted[Math.floor(sorted.length * 0.90)] || 0.15;
        const cutThr = Math.max(0.10, Math.min(0.28, q90 * 1.25));
        const isCut = score > cutThr;
        gradualScores.push(score);
        const gradualSum = gradualScores.reduce((a, b) => a + b, 0);
        const isFade = !isCut && gradualSum > cutThr * 3.5 && gradualScores.length >= 6;
        return { isCut, isFade, score };
      }

      let flickerCount = 0, lastCurveDir = 0;
      const FLICKER_MAX = 5;
      const FLICKER_DECAY = 0.5;

      function getTemporalAlpha(isCut, isFade) {
        const base = isCut ? 0.40 : (isFade ? 0.10 : 0.05);
        return base / (1 + flickerCount * 0.5);
      }

      let __prevLumBuf = null, __curLumBuf = null, __curLumBufSize = 0;

      let __cachedZxLut = null, __cachedZyLut = null, __cachedLutW = 0, __cachedLutH = 0;
      function getZoneLuts(sw, sh) {
        if (__cachedLutW === sw && __cachedLutH === sh && __cachedZxLut && __cachedZyLut) return { zxLut: __cachedZxLut, zyLut: __cachedZyLut };
        const maxZx = ZONE_COLS - 1, maxZy = ZONE_ROWS - 1;
        const zoneW = Math.floor(sw / ZONE_COLS), zoneH = Math.floor(sh / ZONE_ROWS);
        const invZoneW = 1 / Math.max(1, zoneW), invZoneH = 1 / Math.max(1, zoneH);
        const zxLut = new Uint8Array(sw);
        const zyLut = new Uint8Array(sh);
        for (let x = 0; x < sw; x++) zxLut[x] = Math.min(maxZx, (x * invZoneW) | 0);
        for (let y = 0; y < sh; y++) zyLut[y] = Math.min(maxZy, (y * invZoneH) | 0);
        __cachedZxLut = zxLut; __cachedZyLut = zyLut; __cachedLutW = sw; __cachedLutH = sh;
        return { zxLut, zyLut };
      }

      const _pool_lumHist = new Uint32Array(HIST_BINS);
      const _pool_rHist = new Uint32Array(HIST_BINS);
      const _pool_gHist = new Uint32Array(HIST_BINS);
      const _pool_bHist = new Uint32Array(HIST_BINS);
      const _pool_zoneCounts = new Uint32Array(ZONE_COUNT);
      const _pool_zoneHists = Array.from({ length: ZONE_COUNT }, () => new Uint32Array(HIST_BINS));
      const _pool_zoneBrightSum = new Float32Array(ZONE_COUNT);
      const _pool_zoneBrightCount = new Uint32Array(ZONE_COUNT);

      function computeFullAnalysis(data, sw, sh) {
        const step = 2;
        let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0, skinCount = 0;

        const lumHist = _pool_lumHist; lumHist.fill(0);
        const rHist = _pool_rHist; rHist.fill(0);
        const gHist = _pool_gHist; gHist.fill(0);
        const bHist = _pool_bHist; bHist.fill(0);
        const zoneCounts = _pool_zoneCounts; zoneCounts.fill(0);
        const zoneHists = _pool_zoneHists;
        for (let z = 0; z < ZONE_COUNT; z++) zoneHists[z].fill(0);
        const zoneBrightSum = _pool_zoneBrightSum; zoneBrightSum.fill(0);
        const zoneBrightCount = _pool_zoneBrightCount; zoneBrightCount.fill(0);

        const pixelCount = sw * sh;
        if (!__curLumBuf || __curLumBufSize !== pixelCount) { __curLumBuf = new Uint8Array(pixelCount); __curLumBufSize = pixelCount; }
        const curLum = __curLumBuf;
        let hiLumaRSum = 0, hiLumaBSum = 0, hiLumaCount = 0;
        const HI_LUMA_THR = 180;

        const { zxLut, zyLut } = getZoneLuts(sw, sh);
        const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);

        for (let y = 0; y < sh; y += step) {
          const rowPixelOffset = y * sw;
          const zyBase = zyLut[y] * ZONE_COLS;
          for (let x = 0; x < sw; x += step) {
            const pi = rowPixelOffset + x;
            const px = u32[pi];

            const r = px & 0xFF, g = (px >>> 8) & 0xFF, b = (px >>> 16) & 0xFF;
            const l = (r * 54 + g * 183 + b * 18 + 128) >> 8;

            let mx, mn;
            if (r >= g) { mx = r >= b ? r : b; mn = g <= b ? g : b; }
            else { mx = g >= b ? g : b; mn = r <= b ? r : b; }

            curLum[pi] = l;
            sumChroma += mx - mn;
            sum += l; sum2 += l * l; count++;
            lumHist[l]++; rHist[r]++; gHist[g]++; bHist[b]++;

            if (x + step < sw) {
              const ni = pi + step;
              const npx = u32[ni];
              const nr = npx & 0xFF, ng = (npx >>> 8) & 0xFF, nb = (npx >>> 16) & 0xFF;
              const l2 = (nr * 54 + ng * 183 + nb * 18 + 128) >> 8;
              const diff = l2 - l;
              sumEdge += diff < 0 ? -diff : diff;
            }

            if ((r - g) > 12 && r >= 80 && g >= 35 && b >= 20 && r > g && r > b) skinCount++;

            const zi = zyBase + zxLut[x];
            zoneHists[zi][l]++; zoneCounts[zi]++;
            zoneBrightSum[zi] += l; zoneBrightCount[zi]++;

            if (l >= HI_LUMA_THR && b > 10) { hiLumaRSum += r; hiLumaBSum += b; hiLumaCount++; }
          }
        }

        let motionSAD = 0;
        if (__prevLumBuf && __prevLumBuf.length === pixelCount) {
          let sadSum = 0, sadCount = 0;
          const bw = 8, bh = 8;
          for (let by = 0; by + bh <= sh; by += bh) {
            for (let bx = 0; bx + bw <= sw; bx += bw) {
              let blockSad = 0;
              for (let dy = 0; dy < bh; dy += step) {
                for (let dx = 0; dx < bw; dx += step) {
                  const pi = (by + dy) * sw + (bx + dx);
                  blockSad += Math.abs(curLum[pi] - __prevLumBuf[pi]);
                }
              }
              sadSum += blockSad; sadCount++;
            }
          }
          motionSAD = sadCount > 0 ? (sadSum / sadCount) / 255 : 0;
        }
        if (!__prevLumBuf || __prevLumBuf.length !== pixelCount) __prevLumBuf = new Uint8Array(pixelCount);
        __prevLumBuf.set(curLum);

        const n = Math.max(1, count);
        const mean = sum / n, std = Math.sqrt(Math.max(0, (sum2 / n) - mean * mean));
        const centerIndices = [5, 6, 9, 10];
        let centerSum = 0, centerCnt = 0;
        for (const ci of centerIndices) { if (zoneBrightCount[ci] > 0) { centerSum += zoneBrightSum[ci] / zoneBrightCount[ci]; centerCnt++; } }
        const centerBright = centerCnt > 0 ? centerSum / centerCnt / 255 : mean / 255;
        let edgeSum = 0, edgeCount = 0;
        for (let z = 0; z < ZONE_COUNT; z++) {
          if (centerIndices.includes(z)) continue;
          if (zoneBrightCount[z] > 0) { edgeSum += zoneBrightSum[z] / zoneBrightCount[z]; edgeCount++; }
        }
        const edgeAvgBright = edgeCount > 0 ? edgeSum / edgeCount / 255 : mean / 255;
        const hiLumaRBratio = hiLumaCount >= 10 ? hiLumaRSum / Math.max(1, hiLumaBSum) : NaN;

        return {
          bright: mean / 255, contrast: std / 64, chroma: sumChroma / n / 255,
          edge: sumEdge / n, motionSAD, skinRatio: skinCount / n,
          centerBright, edgeAvgBright, hiLumaRBratio,
          lumHist, rHist, gHist, bHist, totalSamples: count,
          zoneHists, zoneCounts, zoneStats: { centerBright, edgeAvgBright }
        };
      }

      const AUTO = {
        running: false, canvasW: CANVAS_W, canvasH: CANVAS_H,
        cur: { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null },
        lastStats: null, statsEma: null, statsAlpha: 0.08,
        motionEma: 0, motionAlpha: 0.20, motionThresh: 0.012,
        motionFrames: 0,
        drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0,
        boostMs: 700,
        minFps: 0.5, maxFps: CONFIG.IS_MOBILE ? 4 : 8, curFps: 2,
        _sceneType: ST.NORMAL, _sceneStable: 0, _sceneTypeEma: ST.NORMAL, _lastMean: 0,
        _framesSinceUpdate: 0
      };

      const _fpsHistBuf = new CircularBuffer(6);

      let drmRetryCount = 0;
      const MAX_DRM_RETRIES = 3;

      let cv, cvCtx;
      if (typeof OffscreenCanvas === 'function') {
        try { cv = new OffscreenCanvas(CANVAS_W, CANVAS_H); cvCtx = cv.getContext('2d', { willReadFrequently: true, alpha: false }); } catch (_) { cv = null; cvCtx = null; }
      }
      if (!cvCtx) {
        cv = document.createElement('canvas'); cv.width = CANVAS_W; cv.height = CANVAS_H;
        try { cvCtx = cv.getContext('2d', { willReadFrequently: true, alpha: false }); }
        catch (_) { try { cvCtx = cv.getContext('2d', { willReadFrequently: true }); } catch (__) {} }
      }

      let __asRvfcId = 0, __asRvfcVideo = null, __asTimeoutId = 0;

      function scheduleNext(v, delayMs) {
        if (!AUTO.running || __globalSig.aborted) return;
        if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; }
        if (__asRvfcId && __asRvfcVideo && typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') {
          try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
          __asRvfcId = 0; __asRvfcVideo = null;
        }
        const useRvfc = v && !v.paused && typeof v.requestVideoFrameCallback === 'function';
        const RVFC_THRESHOLD = 200;
        if (delayMs > RVFC_THRESHOLD) {
          const waitMs = delayMs - (useRvfc ? 80 : 0);
          __asTimeoutId = setTimer(() => {
            __asTimeoutId = 0;
            if (!AUTO.running || __globalSig.aborted) return;
            if (useRvfc) {
              __asRvfcVideo = v;
              __asRvfcId = v.requestVideoFrameCallback((now, metadata) => {
                __asRvfcId = 0; __asRvfcVideo = null;
                if (metadata && Number.isFinite(metadata.presentedFrames)) {
                  const dropped = metadata.expectedDisplayTime - now;
                  if (dropped > 33) AUTO.curFps = Math.max(AUTO.minFps, AUTO.curFps * 0.8);
                }
                loop();
              });
            } else loop();
          }, Math.max(16, waitMs));
          return;
        }
        if (useRvfc) {
          const target = performance.now() + Math.max(0, delayMs | 0);
          __asRvfcVideo = v;
          __asRvfcId = v.requestVideoFrameCallback((now, metadata) => {
            __asRvfcId = 0; __asRvfcVideo = null;
            if (metadata && Number.isFinite(metadata.presentedFrames)) {
              const dropped = metadata.expectedDisplayTime - now;
              if (dropped > 33) AUTO.curFps = Math.max(AUTO.minFps, AUTO.curFps * 0.8);
            }
            const remain = target - performance.now();
            if (remain > 6) { scheduleNext(v, remain); return; }
            loop();
          });
          return;
        }
        __asTimeoutId = setTimer(loop, Math.max(16, delayMs | 0));
      }

      function adaptiveFps(motionSAD, isCut, isFade) {
        _fpsHistBuf.push(motionSAD);
        const avg = _fpsHistBuf.length > 0 ? _fpsHistBuf.reduce((a, b) => a + b, 0) / _fpsHistBuf.length : 0;
        let target = avg < 0.02 ? 2 : (avg < 0.08 ? 3 + avg / 0.08 * 2 : 5 + Math.min((avg - 0.08) / 0.2, 1) * 3);
        if (isCut) target = AUTO.maxFps; else if (isFade) target = Math.max(target, 5);
        AUTO.curFps += clamp(target - AUTO.curFps, -1.5, 1.5);
        return clamp(AUTO.curFps, AUTO.minFps, AUTO.maxFps);
      }

      async function captureSceneFrame(v) {
        if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }
        if (typeof createImageBitmap === 'function') {
          try {
            const bmp = await createImageBitmap(v, { resizeWidth: CANVAS_W, resizeHeight: CANVAS_H, resizeQuality: 'low' });
            cvCtx.drawImage(bmp, 0, 0);
            bmp.close();
            return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
          } catch (_) {}
        }
        if (typeof VideoFrame === 'function') {
          try {
            const frame = new VideoFrame(v, { timestamp: (v.currentTime * 1e6) | 0 });
            cvCtx.drawImage(frame, 0, 0, CANVAS_W, CANVAS_H);
            frame.close();
            return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
          } catch (_) {}
        }
        try { cvCtx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H); return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H); }
        catch (_) { return null; }
      }

      const STATIC_SCENE_FORCE_INTERVAL = 30;

      async function loop() {
        if (!AUTO.running || __globalSig.aborted) return;
        if (globalThis.scheduler?.yield) {
          try { await globalThis.scheduler.yield(); } catch (_) {}
          if (!AUTO.running || __globalSig.aborted) return;
        }

        const now = performance.now();
        const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
        const v = window[VSC_APP_SYM]?.getActiveVideo?.();
        if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null }; prevToneCurve = null; scheduleNext(v, 500); return; }
        if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; }
        if (document.hidden) { scheduleNext(v, 2000); return; }
        if (!v || !cvCtx || v.paused || v.seeking || v.readyState < 2) { try { Scheduler.request(true); } catch (_) {} scheduleNext(v, 300); return; }

        try {
          const img = await captureSceneFrame(v);
          if (!AUTO.running || __globalSig.aborted) return;
          if (!v.isConnected || v.paused || v.readyState < 2) { scheduleNext(v, 300); return; }
          if (!img) { scheduleNext(v, 500); return; }
          AUTO.drmBlocked = false; drmRetryCount = 0;

          const stats = computeFullAnalysis(img.data, CANVAS_W, CANVAS_H);
          AUTO.motionEma = AUTO.motionEma * (1 - AUTO.motionAlpha) + stats.motionSAD * AUTO.motionAlpha;
          AUTO.motionFrames = AUTO.motionEma >= AUTO.motionThresh ? AUTO.motionFrames + 1 : 0;
          const transition = detectTransition(stats, AUTO.lastStats);
          AUTO.lastStats = stats;

          if (!AUTO.statsEma) AUTO.statsEma = { ...stats };
          else {
            const a = transition.isCut ? 0.40 : AUTO.statsAlpha;
            const e = AUTO.statsEma;
            for (const k of ['bright', 'contrast', 'chroma', 'edge', 'skinRatio', 'centerBright', 'edgeAvgBright']) e[k] = (e[k] ?? stats[k]) * (1 - a) + stats[k] * a;
          }

          const newScene = classifySceneFuzzy(AUTO.statsEma, stats.zoneStats);
          if (newScene !== AUTO._sceneType) AUTO._sceneStable = 0; else AUTO._sceneStable++;
          AUTO._sceneType = newScene;
          if (AUTO._sceneStable >= 4) AUTO._sceneTypeEma = newScene;
          if (transition.isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; flickerCount = Math.max(0, flickerCount - 2); }

          AUTO._framesSinceUpdate++;
          const staticForceTrigger = AUTO._framesSinceUpdate >= STATIC_SCENE_FORCE_INTERVAL;
          const allowUpdate = transition.isCut || transition.isFade || AUTO.motionFrames >= 4 || staticForceTrigger;

          let fps = AUTO.curFps;
          if (allowUpdate) {
            AUTO._framesSinceUpdate = 0;
            fps = adaptiveFps(stats.motionSAD, transition.isCut, transition.isFade);
            if (now < AUTO.tBoostUntil) fps = Math.max(fps, transition.isCut ? AUTO.maxFps : 5);
            const sceneType = AUTO._sceneTypeEma;
            const toneParams = { ...SCENE_TONE_PARAMS[sceneType] };
            const rawCurve = buildAdaptiveToneCurve(stats.lumHist, stats.totalSamples, toneParams, stats.zoneHists, stats.zoneCounts);
            const rawGains = computeChannelBalance(stats.rHist, stats.gHist, stats.bHist, stats.totalSamples, stats.skinRatio, stats.hiLumaRBratio);
            const rawSat = toneParams.satTarget;
            const alpha = getTemporalAlpha(transition.isCut, transition.isFade);

            const newMid = rawCurve[128], oldMid = prevToneCurve ? prevToneCurve[128] : 0.5;
            const dir = newMid > oldMid ? 1 : (newMid < oldMid ? -1 : 0);
            if (dir !== 0 && dir !== lastCurveDir && lastCurveDir !== 0) flickerCount = Math.min(flickerCount + 1, FLICKER_MAX);
            else if (dir !== 0) flickerCount = Math.max(0, flickerCount - FLICKER_DECAY);
            lastCurveDir = dir || lastCurveDir;

            const smoothedCurve = interpolateCurves(prevToneCurve, rawCurve, alpha);
            const smoothedGains = interpolateGains(prevChannelGains, rawGains, alpha);
            const smoothedSat = prevSatMul + (rawSat - prevSatMul) * alpha;

            if (!prevToneCurve) prevToneCurve = new Float32Array(TONE_STEPS);
            prevToneCurve.set(smoothedCurve);
            prevChannelGains = smoothedGains;
            prevSatMul = smoothedSat;

            const result = curveToApproxParams(smoothedCurve, smoothedSat, smoothedGains);
            const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat;
            AUTO.cur.br = result.br; AUTO.cur.ct = result.ct; AUTO.cur.sat = result.sat;
            AUTO.cur._toneCurve = smoothedCurve; AUTO.cur._channelGains = smoothedGains;
            AUTO.cur._gamma = result._gamma; AUTO.cur._bright = result._bright; AUTO.cur._temp = result._temp;
            if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001) Scheduler.request(true);
          }
          scheduleNext(v, Math.max(100, Math.round(1000 / Math.max(1, fps))));
        } catch (e) {
          const isDrm = (e.name === 'SecurityError' || e.message?.includes('tainted'));
          if (VSC_DEFENSE.autoSceneDrmBackoff && isDrm) {
            drmRetryCount++; AUTO.drmBlocked = true;
            if (drmRetryCount >= MAX_DRM_RETRIES) {
              AUTO.running = false; AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
              Store.set(P.APP_AUTO_SCENE, false); showOSD('자동 장면: DRM 제한으로 비활성화됨', 3000);
              Scheduler.request(true); return;
            }
            scheduleNext(v, Math.min(30000, 8000 * Math.pow(1.5, drmRetryCount - 1)));
          } else scheduleNext(v, 1000);
        }
      }

      function resetAllModuleState() {
        AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
        AUTO.statsEma = null; AUTO.lastStats = null; AUTO._lastMean = 0; AUTO._sceneStable = 0;
        AUTO._sceneTypeEma = ST.NORMAL; AUTO._sceneType = ST.NORMAL;
        AUTO.motionEma = 0; AUTO.motionFrames = 0; AUTO.curFps = 2;
        AUTO._framesSinceUpdate = 0;
        _fpsHistBuf.clear();
        prevToneCurve = null; prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; prevSatMul = 1.0;
        cutScores.clear(); gradualScores.clear(); flickerCount = 0; lastCurveDir = 0;
        __prevLumBuf = null; __curLumBuf = null; __curLumBufSize = 0;
        __fuzzyInited = false; __fuzzyEma.fill(0);
        _interpActive = 0;
      }

      function cleanupScheduler() {
        if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; }
        if (__asRvfcId && __asRvfcVideo && typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') {
          try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {}
          __asRvfcId = 0; __asRvfcVideo = null;
        }
      }

      __globalSig.addEventListener('abort', () => { AUTO.running = false; cleanupScheduler(); }, { once: true });

      Store.sub(P.APP_AUTO_SCENE, (en) => {
        if (en && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; resetAllModuleState(); loop(); }
        else if (!en) { AUTO.running = false; cleanupScheduler(); resetAllModuleState(); Scheduler.request(true); }
      });
      Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } });

      return {
        getMods: () => AUTO.cur,
        getSceneType: () => AUTO._sceneType,
        getSceneTypeName: () => ST_NAMES[AUTO._sceneType] || 'UNKNOWN',
        hasToneCurve: () => !!AUTO.cur._toneCurve,
        start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } },
        stop: () => { AUTO.running = false; cleanupScheduler(); resetAllModuleState(); }
      };
    }

    /* ── curveToApproxParams (v200: NaN guard, unchanged logic) ── */
    function curveToApproxParams(curve, satMul, channelGains) {
      const clamp = VSC_CLAMP;
      const N = 32;
      const curveLen = curve.length;
      const step = (curveLen - 1) / (N - 1);

      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0;
      let T0 = 0, T1 = 0, T2 = 0;

      for (let i = 0; i < N; i++) {
        const ci = Math.min(curveLen - 1, Math.round(step * i));
        const x = ci / (curveLen - 1);
        const y = curve[ci];
        const x2 = x * x;
        S0 += 1; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
        T0 += y; T1 += x * y; T2 += x2 * y;
      }

      const D = S4 * (S2 * S0 - S1 * S1) - S3 * (S3 * S0 - S1 * S2) + S2 * (S3 * S1 - S2 * S2);

      let a2, a1, a0;
      if (Math.abs(D) < 1e-12) {
        a2 = 0; a1 = 1; a0 = 0;
      } else {
        const invD = 1 / D;
        a2 = (T2 * (S2 * S0 - S1 * S1) - S3 * (T1 * S0 - S1 * T0) + S2 * (T1 * S1 - S2 * T0)) * invD;
        a1 = (S4 * (T1 * S0 - S1 * T0) - T2 * (S3 * S0 - S1 * S2) + S2 * (S3 * T0 - T1 * S2)) * invD;
        a0 = (S4 * (S2 * T0 - S1 * T1) - S3 * (S3 * T0 - T1 * S2) + T2 * (S3 * S1 - S2 * S2)) * invD;
      }

      if (!Number.isFinite(a2)) a2 = 0;
      if (!Number.isFinite(a1)) a1 = 1;
      if (!Number.isFinite(a0)) a0 = 0;

      const mid = clamp(a2 * 0.25 + a1 * 0.5 + a0, 0.01, 0.99);
      let gamma = 1.0;
      if (mid > 0.01 && mid < 0.99) { gamma = Math.log(mid) / Math.log(0.5); gamma = clamp(gamma, 0.65, 1.6); }

      const slopeAtMid = 2 * a2 * 0.5 + a1;
      const contrast = clamp(slopeAtMid, 0.75, 1.35);

      const curveIntegral = a2 / 3 + a1 / 2 + a0;
      const brightDiff = curveIntegral - 0.5;
      const bright = clamp(brightDiff * 45, -12, 12);

      const tempEstimate = (channelGains.rGain - channelGains.bGain) * 50;
      const temp = clamp(tempEstimate, -30, 30);

      return {
        br: clamp(1.0 + bright * 0.008, 0.90, 1.30), ct: clamp(contrast, 0.80, 1.30),
        sat: clamp(satMul, 0.85, 1.45), _gamma: gamma, _bright: bright, _temp: temp,
        _channelGains: channelGains, _toneCurve: curve
      };
    }

    // ═══ END OF PART 3 (v200.0.0-Hybrid) ═══
    // PART 4 continues with: createVideoMaximizer, createFiltersVideoOnly, Shadow Band table,
    //   Bright Step table, computeResolutionSharpMul, composeVideoParamsInto, createVideoParamsMemo,
    //   applyShadowStyle, createDisposerBag, bindWindowDrag, SVG Icon Builders (DOM API),
    //   CSS_VARS, OSD (accessible), PiP helpers, captureVideoFrame
    // ═══ PART 4 START (v200.0.0-Hybrid) — continues directly from PART 3's curveToApproxParams ═══

    /* ══════════════════════════════════════════════════════════════════
       createVideoMaximizer
       ══════════════════════════════════════════════════════════════════ */
    function createVideoMaximizer(Store, ApplyReq) {
      const MAX_CLASS = 'vsc-vmax-max';
      const HIDE_CLASS = 'vsc-vmax-hide';
      const ANCESTOR_CLASS = 'vsc-vmax-ancestor';
      const IFRAME_MAX_CLASS = 'vsc-vmax-iframe';

      let active = false;
      let targetVideo = null;
      let targetIframe = null;
      let savedStyles = [];
      let hiddenSiblings = [];
      let savedScrollX = 0, savedScrollY = 0;
      let classMO = null;
      let isIframeMode = false;

      let delegatedToTop = false;
      let innerMaxActive = false;
      let innerSavedStyles = [];

      function isInIframe() { try { return window !== window.top; } catch (_) { return true; } }

      function pickBestVideo() {
        const explicit = window[VSC_INTERNAL_SYM]?._activeVideo;
        if (explicit?.isConnected && explicit.readyState >= 2 && !explicit.ended) return explicit;
        let best = null, bestScore = -1;
        const allVideos = document.querySelectorAll('video');
        for (const v of allVideos) {
          if (!v.isConnected || v.readyState < 1) continue;
          let s = 0;
          const r = v.getBoundingClientRect();
          const area = r.width * r.height;
          if (!v.paused && !v.ended) s += 10;
          if (!v.muted && v.volume > 0.01) s += 3;
          s += Math.log2(1 + area / 10000);
          if (v.currentTime > 0.5) s += 2;
          if (s > bestScore) { bestScore = s; best = v; }
        }
        return best;
      }

      function findIframeForWindow(childWin) {
        try {
          const iframes = document.querySelectorAll('iframe');
          for (const ifr of iframes) { try { if (ifr.contentWindow === childWin) return ifr; } catch (_) {} }
        } catch (_) {}
        return null;
      }

      function backupAndApplyStyle(el, css) {
        savedStyles.push({ el, cssText: el.style.cssText });
        for (const [prop, val] of Object.entries(css)) el.style.setProperty(prop, val, 'important');
      }

      function hideSiblings(el) {
        if (!el.parentNode) return;
        for (const sib of el.parentNode.children) {
          if (sib === el || sib.nodeType !== 1) continue;
          if (sib.tagName === 'SCRIPT' || sib.tagName === 'LINK' || sib.tagName === 'STYLE') continue;
          if (sib.hasAttribute?.('data-vsc-ui') || sib.id === 'vsc-host' || sib.id === 'vsc-gear-host' || sib.id === 'vsc-osd') continue;
          const prev = sib.style.cssText;
          sib.classList.add(HIDE_CLASS);
          sib.style.setProperty('display', 'none', 'important');
          hiddenSiblings.push({ el: sib, prev });
        }
      }

      let styleInjected = false;
      function injectStyle() {
        if (styleInjected) return;
        styleInjected = true;
        const s = document.createElement('style');
        s.dataset.vscMaximizer = '1';
        s.textContent = [
          `.${MAX_CLASS}{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important;margin:0!important;padding:0!important;border:none!important;transform:none!important;}`,
          `.${HIDE_CLASS}{display:none!important;}`,
          `.${ANCESTOR_CLASS}{overflow:visible!important;position:static!important;transform:none!important;clip:auto!important;clip-path:none!important;contain:none!important;}`,
          `.${IFRAME_MAX_CLASS}{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;border:none!important;margin:0!important;padding:0!important;}`
        ].join('\n');
        (document.head || document.documentElement).appendChild(s);
      }

      function startClassGuard(primaryEl) {
        if (classMO) { classMO.disconnect(); classMO = null; }
        const guardClass = isIframeMode ? IFRAME_MAX_CLASS : MAX_CLASS;
        classMO = new MutationObserver((muts) => {
          for (const m of muts) {
            if (m.type !== 'attributes' || m.attributeName !== 'class' || !active) continue;
            const el = m.target;
            if (el === primaryEl && !el.classList.contains(guardClass)) el.classList.add(guardClass);
            if (el.dataset?.vscMaxAncestor === '1' && !el.classList.contains(ANCESTOR_CLASS)) el.classList.add(ANCESTOR_CLASS);
          }
        });
        classMO.observe(primaryEl, { attributes: true, attributeFilter: ['class'] });
        let cur = primaryEl.parentElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          classMO.observe(cur, { attributes: true, attributeFilter: ['class'] });
          cur = cur.parentElement;
        }
      }

      function stopClassGuard() { if (classMO) { classMO.disconnect(); classMO = null; } }

      function clearAncestorChain(startEl) {
        let ancestor = startEl.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          ancestor.dataset.vscMaxAncestor = '1';
          backupAndApplyStyle(ancestor, { overflow: 'visible', position: 'static', transform: 'none', clip: 'auto', 'clip-path': 'none', contain: 'none' });
          ancestor.classList.add(ANCESTOR_CLASS);
          hideSiblings(ancestor);
          ancestor = ancestor.parentElement;
        }
      }

      function lockBody() {
        backupAndApplyStyle(document.body, { overflow: 'hidden', margin: '0', padding: '0' });
        if (document.documentElement) backupAndApplyStyle(document.documentElement, { overflow: 'hidden' });
      }

      function doMaximizeDirect(video) {
        injectStyle(); targetVideo = video; isIframeMode = false;
        savedScrollX = window.scrollX; savedScrollY = window.scrollY;
        clearAncestorChain(video); lockBody();
        savedStyles.push({ el: video, cssText: video.style.cssText });
        video.classList.add(MAX_CLASS); hideSiblings(video); window.scrollTo(0, 0);
        startClassGuard(video); active = true; ApplyReq.hard();
        showOSD('최대화 ON (ESC 또는 Alt+M 해제)', 1800);
      }

      function doMaximizeIframe(iframeEl) {
        injectStyle(); targetIframe = iframeEl; isIframeMode = true;
        savedScrollX = window.scrollX; savedScrollY = window.scrollY;
        clearAncestorChain(iframeEl); lockBody();
        savedStyles.push({ el: iframeEl, cssText: iframeEl.style.cssText });
        iframeEl.classList.add(IFRAME_MAX_CLASS); hideSiblings(iframeEl); window.scrollTo(0, 0);
        startClassGuard(iframeEl); active = true; ApplyReq.hard();
        showOSD('최대화 ON — iframe (ESC 또는 Alt+M 해제)', 1800);
        try { iframeEl.contentWindow.postMessage({ __vsc_max: 'apply_inner' }, '*'); } catch (_) {}
      }

      function applyInnerMaximize() {
        if (innerMaxActive) return;
        const video = pickBestVideo(); if (!video) return;
        innerMaxActive = true; innerSavedStyles.push({ el: video, cssText: video.style.cssText });
        const props = { width: '100vw', height: '100vh', 'object-fit': 'contain', position: 'fixed', top: '0', left: '0', 'z-index': '2147483646', background: '#000', margin: '0', padding: '0', border: 'none' };
        for (const [k, v] of Object.entries(props)) video.style.setProperty(k, v, 'important');
        let ancestor = video.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
          innerSavedStyles.push({ el: ancestor, cssText: ancestor.style.cssText });
          ancestor.style.setProperty('overflow', 'visible', 'important'); ancestor.style.setProperty('position', 'static', 'important'); ancestor.style.setProperty('transform', 'none', 'important'); ancestor.style.setProperty('contain', 'none', 'important');
          ancestor = ancestor.parentElement;
        }
        if (document.body) {
          innerSavedStyles.push({ el: document.body, cssText: document.body.style.cssText });
          document.body.style.setProperty('overflow', 'hidden', 'important'); document.body.style.setProperty('margin', '0', 'important');
        }
      }

      function undoInnerMaximize() {
        if (!innerMaxActive) return;
        for (let i = innerSavedStyles.length - 1; i >= 0; i--) { try { innerSavedStyles[i].el.style.cssText = innerSavedStyles[i].cssText; } catch (_) {} }
        innerSavedStyles = []; innerMaxActive = false;
      }

      function undoMaximize() {
        if (!active) return;
        stopClassGuard();
        if (isIframeMode && targetIframe) {
          try { targetIframe.contentWindow.postMessage({ __vsc_max: 'undo_inner' }, '*'); } catch (_) {}
          try { targetIframe.contentWindow.postMessage({ __vsc_max: 'state_off' }, '*'); } catch (_) {}
        }
        for (const { el, prev } of hiddenSiblings) { try { el.classList.remove(HIDE_CLASS); el.style.cssText = prev; } catch (_) {} }
        hiddenSiblings = [];
        for (let i = savedStyles.length - 1; i >= 0; i--) {
          const { el, cssText } = savedStyles[i];
          try { el.style.cssText = cssText; el.classList.remove(MAX_CLASS, IFRAME_MAX_CLASS, ANCESTOR_CLASS); delete el.dataset.vscMaxAncestor; } catch (_) {}
        }
        savedStyles = [];
        window.scrollTo(savedScrollX, savedScrollY);
        active = false; targetVideo = null; targetIframe = null; isIframeMode = false;
        ApplyReq.hard(); showOSD('최대화 OFF', 1200);
      }

      function toggle() {
        if (isInIframe()) {
          if (delegatedToTop) { try { window.top.postMessage({ __vsc_max: 'undo' }, '*'); } catch (_) {} delegatedToTop = false; return; }
          try { window.top.postMessage({ __vsc_max: 'request' }, '*'); delegatedToTop = true; } catch (_) {
            const video = pickBestVideo(); if (video) doMaximizeDirect(video); else showOSD('최대화할 비디오를 찾을 수 없음', 1500);
          }
          return;
        }
        if (active) { undoMaximize(); return; }
        const video = pickBestVideo(); if (video) { doMaximizeDirect(video); return; }
        const iframes = document.querySelectorAll('iframe');
        let bestIframe = null, bestArea = 0;
        for (const ifr of iframes) {
          if (!ifr.isConnected) continue;
          const r = ifr.getBoundingClientRect(); const area = r.width * r.height;
          if (area < 10000) continue;
          try { const doc = ifr.contentDocument || ifr.contentWindow?.document; if (doc?.querySelector('video')) { if (area > bestArea) { bestArea = area; bestIframe = ifr; } } }
          catch (_) { if (area > bestArea) { bestArea = area; bestIframe = ifr; } }
        }
        if (bestIframe) { doMaximizeIframe(bestIframe); return; }
        showOSD('최대화할 비디오를 찾을 수 없음', 1500);
      }

      function onMessage(e) {
        if (!e.data || typeof e.data !== 'object' || !e.data.__vsc_max) return;
        const cmd = e.data.__vsc_max;
        if (!isInIframe()) {
          if (cmd === 'request') {
            const iframeEl = findIframeForWindow(e.source);
            if (iframeEl) { if (active) undoMaximize(); doMaximizeIframe(iframeEl); try { e.source.postMessage({ __vsc_max: 'state_on' }, '*'); } catch (_) {} }
            return;
          }
          if (cmd === 'undo') { if (active) undoMaximize(); return; }
          return;
        }
        if (cmd === 'apply_inner') { applyInnerMaximize(); return; }
        if (cmd === 'undo_inner') { undoInnerMaximize(); return; }
        if (cmd === 'state_on') { delegatedToTop = true; return; }
        if (cmd === 'state_off') { delegatedToTop = false; return; }
      }

      on(window, 'message', onMessage, { passive: true });
      __globalSig.addEventListener('abort', () => { if (active) { try { undoMaximize(); } catch (_) {} } if (innerMaxActive) { try { undoInnerMaximize(); } catch (_) {} } delegatedToTop = false; }, { once: true });

      return Object.freeze({ toggle, isActive: () => active || delegatedToTop, getTarget: () => targetVideo || targetIframe, doMaximize: toggle, undoMaximize() { if (isInIframe() && delegatedToTop) { try { window.top.postMessage({ __vsc_max: 'undo' }, '*'); } catch (_) {} delegatedToTop = false; return; } undoMaximize(); } });
    }

    /* ══════════════════════════════════════════════════════════════════
       SVG Filter Engine (v200: Symbol refs only, logic unchanged)
       ══════════════════════════════════════════════════════════════════ */
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(32);

      const _toneStrLut = new Array(10001);
      for (let i = 0; i <= 10000; i++) _toneStrLut[i] = (i / 10000).toFixed(4);
      function toneStr(idx) { return _toneStrLut[idx]; }

      function float32ArrayToSvgTable(arr) {
        const len = arr.length;
        const parts = new Array(len);
        for (let i = 0; i < len; i++) {
          parts[i] = _toneStrLut[Math.min(10000, Math.max(0, (arr[i] * 10000 + 0.5) | 0))];
        }
        return parts.join(' ');
      }

      function applyToeToAutoCurve(autoCurve, toe, mid, shoulder) {
        const len = autoCurve.length;
        const out = new Float32Array(len);
        const toeF = clamp(toe / 100, -0.15, 0.15);
        const midF = clamp(mid, -0.10, 0.10);
        const shouldF = clamp(shoulder / 100, -0.15, 0.15);
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const x0 = i / (len - 1);
          let y = autoCurve[i];
          if (Math.abs(toeF) > 0.0005) {
            const toeWeight = x0 < 0.25 ? (1.0 - x0 / 0.25) : 0;
            y += toeF * toeWeight * toeWeight;
          }
          if (Math.abs(midF) > 0.0005) {
            const midWeight = Math.exp(-((x0 - 0.5) * (x0 - 0.5)) / (2 * 0.18 * 0.18));
            y += midF * midWeight;
          }
          if (Math.abs(shouldF) > 0.0005) {
            const shouldWeight = x0 > 0.75 ? ((x0 - 0.75) / 0.25) : 0;
            y -= shouldF * shouldWeight * shouldWeight;
          }
          y = clamp(y, 0, 1);
          if (y < prev) y = prev;
          prev = y;
          out[i] = y;
        }
        return out;
      }

      function mkXfer(attrs, funcDefaults, withAlpha = false) {
        const xfer = h('feComponentTransfer', { ns: 'svg', ...attrs });
        const channels = ['R', 'G', 'B'];
        if (withAlpha) channels.push('A');
        for (const ch of channels) {
          const funcAttrs = { ns: 'svg' };
          if (ch === 'A') funcAttrs.type = 'identity';
          else { for (const [k, v] of Object.entries(funcDefaults)) funcAttrs[k] = v; }
          xfer.append(h(`feFunc${ch}`, funcAttrs));
        }
        return xfer;
      }

      const qInt = (v, step) => Math.round(v / step);

      const makeKeyBase = (s) => {
        let autoKey = '0';
        if (s._autoToneCurve && s._autoToneCurve.length === 256) {
          const c = s._autoToneCurve;
          autoKey = ((c[16] * 65536 + 0.5) | 0) + ',' + ((c[112] * 65536 + 0.5) | 0) + ',' + ((c[240] * 65536 + 0.5) | 0);
        }
        let chGainKey = '0';
        if (s._autoChannelGains) {
          const g = s._autoChannelGains;
          chGainKey = ((g.rGain * 1000 + 0.5) | 0) + '|' + ((g.bGain * 1000 + 0.5) | 0);
        }
        return qInt(s.gain, 0.04) + '|' + qInt(s.gamma, 0.01) + '|' + qInt(s.temp, 0.2) + '|'
          + qInt(s.sharp, 0.2) + '|'
          + qInt(s.toe || 0, 0.5) + '|' + qInt(s.mid || 0, 0.002) + '|' + qInt(s.shoulder || 0, 0.5) + '|'
          + 'ac:' + autoKey + '|cg:' + chGainKey;
      };

      function getToneTableCached(steps, toe, shoulder, mid, gain, contrast, brightOffset, gamma) {
        const key = `${steps}|${(toe*20+.5)|0}|${(shoulder*20+.5)|0}|${(mid*200+.5)|0}|${(gain*100+.5)|0}|${(contrast*100+.5)|0}|${(gamma*100+.5)|0}`;
        const hit = toneCache.get(key); if (hit) return hit;

        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const out = new Array(steps); let prev = 0;
        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = Number(gamma);

        const toeF = clamp(toe / 100, -0.15, 0.15);
        const midF = clamp(mid, -0.10, 0.10);
        const shouldF = clamp(shoulder / 100, -0.15, 0.15);

        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1);
          let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = x * contrast + intercept;

          if (Math.abs(toeF) > 0.0005) {
            const toeWeight = x0 < 0.25 ? (1.0 - x0 / 0.25) : 0;
            x += toeF * toeWeight * toeWeight;
          }
          if (Math.abs(midF) > 0.0005) {
            const midWeight = Math.exp(-((x0 - 0.5) * (x0 - 0.5)) / (2 * 0.18 * 0.18));
            x += midF * midWeight;
          }
          if (Math.abs(shouldF) > 0.0005) {
            const shouldWeight = x0 > 0.75 ? ((x0 - 0.75) / 0.25) : 0;
            x -= shouldF * shouldWeight * shouldWeight;
          }

          x = clamp(x, 0, 1);
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;

          const idx = Math.min(10000, Math.max(0, Math.round(x * 10000)));
          out[i] = toneStr(idx);
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      const __createdSvgs = new Set();
      setRecurring(() => { for (const svg of __createdSvgs) { if (!svg.isConnected) __createdSvgs.delete(svg); } }, 30000);
      __globalSig.addEventListener('abort', () => { for (const svg of __createdSvgs) { try { if (svg.parentNode) svg.remove(); } catch (_) {} } __createdSvgs.clear(); }, { once: true });

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
        const defs = h('defs', { ns: 'svg' });
        svg.append(defs);
        __createdSvgs.add(svg);

        const fid = `vsc-f-${config.VSC_ID}`;
        const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });

        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
        const fTone = mkXfer({ in: 'conv', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
        const fSat = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1.0', result: 'final' });

        filter.append(fConv, fTone, fTemp, fSat);
        defs.append(filter);

        const tryAppend = () => {
          const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
          if (!target?.appendChild) return false;
          try {
            const escapedFid = fid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const existing = target.querySelector(`filter[id="${escapedFid}"]`);
            if (existing) { const oldSvg = existing.closest('svg'); if (oldSvg && oldSvg !== svg) oldSvg.remove(); }
          } catch (_) {}
          target.appendChild(svg); return true;
        };
        if (!tryAppend()) {
          let retryCount = 0;
          const t = setRecurring(() => { if (++retryCount > 40 || tryAppend()) clearRecurring(t); }, 50);
          setTimer(() => clearRecurring(t), 3000);
        }

        const toneFuncR = fTone.querySelector('feFuncR');
        const toneFuncG = fTone.querySelector('feFuncG');
        const toneFuncB = fTone.querySelector('feFuncB');
        const toneFuncsRGB = [toneFuncR, toneFuncG, toneFuncB].filter(Boolean);
        const toneFuncsAll = Array.from(fTone.children);

        const tempChildren = Array.from(fTemp.children);
        const tempFuncR = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncr');
        const tempFuncG = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncg');
        const tempFuncB = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncb');

        return { fid, fConv, toneFuncs: toneFuncsAll, toneFuncsRGB, tempFuncR, tempFuncG, tempFuncB, fSat, st: { lastKey: '', toneKey: '', toneTable: '', sharpKey: '', desatKey: '', tempKey: '' } };
      }

      function needsSvgFilter(s) {
        return (
          Math.abs(s.sharp || 0) > 0.005 ||
          Math.abs(s.toe || 0) > 0.01 ||
          Math.abs(s.mid || 0) > 0.001 ||
          Math.abs(s.shoulder || 0) > 0.01 ||
          !!s._autoToneCurve ||
          !!s._autoChannelGains ||
          Math.abs((s.gain || 1) - 1) > 0.005 ||
          Math.abs((s.gamma || 1) - 1) > 0.005 ||
          Math.abs(s.temp || 0) > 0.5
        );
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root);
        if (!dc) { dc = { key: '', url: '', filterStr: 'none', cssOnly: false }; urlCache.set(root, dc); }

        const svgKey = (video.videoWidth || 0) + '|' + makeKeyBase(s);
        const fullKey = svgKey + '|css:' + s._cssBr.toFixed(3) + '|' + s._cssCt.toFixed(3) + '|' + s._cssSat.toFixed(3);
        if (dc.key === fullKey) return { svgUrl: dc.url, filterStr: dc.filterStr, cssOnly: dc.cssOnly };

        if (!needsSvgFilter(s)) {
          let filterStr = '';
          if (Math.abs(s._cssBr - 1) > 0.001) filterStr += `brightness(${s._cssBr.toFixed(4)}) `;
          if (Math.abs(s._cssCt - 1) > 0.001) filterStr += `contrast(${s._cssCt.toFixed(4)}) `;
          if (Math.abs(s._cssSat - 1) > 0.001) filterStr += `saturate(${s._cssSat.toFixed(4)})`;
          filterStr = filterStr.trim() || 'none';
          dc.key = fullKey; dc.url = ''; dc.filterStr = filterStr; dc.cssOnly = true;
          return { svgUrl: '', filterStr, cssOnly: true };
        }

        let ctx = ctxMap.get(root);
        if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== svgKey) {
          st.lastKey = svgKey;
          const steps = 256;
          const gamma = 1 / clamp(s.gamma || 1, 0.1, 5.0);

          const hasToeOrMid = Math.abs(s.toe || 0) > 0.01 || Math.abs(s.mid || 0) > 0.0005 || Math.abs(s.shoulder || 0) > 0.01;

          let toneTable;
          if (s._autoToneCurve) {
            if (hasToeOrMid) {
              const merged = applyToeToAutoCurve(s._autoToneCurve, s.toe || 0, s.mid || 0, s.shoulder || 0);
              toneTable = float32ArrayToSvgTable(merged);
            } else {
              toneTable = float32ArrayToSvgTable(s._autoToneCurve);
            }
          } else {
            toneTable = getToneTableCached(steps, s.toe || 0, s.shoulder || 0, s.mid || 0, s.gain || 1, s.contrast || 1, s.bright * 0.004 || 0, gamma);
          }

          const totalS = clamp(Number(s.sharp || 0), 0, 0.35);

          let kernelStr;
          if (totalS < 0.005) { kernelStr = '0,0,0, 0,1,0, 0,0,0'; }
          else {
            const diag = -totalS * 0.5; const edge = -totalS; const center = 1.0 - 4 * edge - 4 * diag;
            kernelStr = `${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}, ${edge.toFixed(5)},${center.toFixed(5)},${edge.toFixed(5)}, ${diag.toFixed(5)},${edge.toFixed(5)},${diag.toFixed(5)}`;
          }

          const userTemp = tempToRgbGain(s.temp);
          let finalRs = userTemp.rs, finalGs = userTemp.gs, finalBs = userTemp.bs;
          if (s._autoChannelGains) {
            const ag = s._autoChannelGains;
            finalRs = userTemp.rs * clamp(ag.rGain, 0.80, 1.20);
            finalGs = userTemp.gs * clamp(ag.gGain, 0.90, 1.10);
            finalBs = userTemp.bs * clamp(ag.bGain, 0.80, 1.20);
            const maxG = Math.max(finalRs, finalGs, finalBs, 1);
            finalRs /= maxG; finalGs /= maxG; finalBs /= maxG;
          }

          if (st.toneKey !== toneTable) { st.toneKey = toneTable; for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable); }
          const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);
          if (st.tempKey !== tmk) { st.tempKey = tmk; ctx.tempFuncR.setAttribute('slope', finalRs); ctx.tempFuncG.setAttribute('slope', finalGs); ctx.tempFuncB.setAttribute('slope', finalBs); }
          if (st.sharpKey !== kernelStr) {
            st.sharpKey = kernelStr; ctx.fConv.setAttribute('kernelMatrix', kernelStr);
            const desatVal = totalS > 0.008 ? clamp(1.0 - totalS * 0.1, 0.90, 1.0).toFixed(3) : '1.000';
            if (st.desatKey !== desatVal) { st.desatKey = desatVal; ctx.fSat.setAttribute('values', desatVal); }
          }
        }

        const url = `url(#${ctx.fid})`;
        let filterStr = url;
        if (Math.abs(s._cssBr - 1) > 0.001) filterStr += ` brightness(${s._cssBr.toFixed(4)})`;
        if (Math.abs(s._cssCt - 1) > 0.001) filterStr += ` contrast(${s._cssCt.toFixed(4)})`;
        if (Math.abs(s._cssSat - 1) > 0.001) filterStr += ` saturate(${s._cssSat.toFixed(4)})`;

        dc.key = fullKey; dc.url = url; dc.filterStr = filterStr; dc.cssOnly = false;
        return { svgUrl: url, filterStr, cssOnly: false };
      }

      return {
        prepareCached: (video, s) => { try { return prepare(video, s); } catch (e) { log.warn('filter prepare failed:', e); return null; } },
        applyFilter: (el, filterResult) => {
          if (!el) return;
          const st = getVState(el);
          if (st._inPiP) return;
          if (!filterResult) {
            if (st.applied) {
              if (!st._transitionCleared) el.style.removeProperty('transition');
              el.style.removeProperty('will-change'); el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color'); el.style.removeProperty('contain'); el.style.removeProperty('backface-visibility');
              st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false;
            }
            return;
          }
          const filterStr = filterResult.filterStr;
          if (st.lastCssFilterStr === filterStr && st.applied) return;
          if (!st._transitionCleared) { el.style.removeProperty('transition'); st._transitionCleared = true; }
          if (st.lastCssFilterStr !== filterStr) { el.style.setProperty('filter', filterStr, 'important'); el.style.setProperty('-webkit-filter', filterStr, 'important'); }
          if (!st.applied) {
            const willChangeVal = window[VSC_INTERNAL_SYM]?.ZoomManager?.isZoomed(el) ? 'filter, transform' : 'filter';
            el.style.setProperty('will-change', willChangeVal, 'important');
            el.style.setProperty('contain', 'content', 'important');
            el.style.setProperty('background-color', '#000', 'important');
            el.style.setProperty('backface-visibility', 'hidden', 'important');
          }
          st.applied = true; st.lastFilterUrl = filterResult.svgUrl; st.lastCssFilterStr = filterStr;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied) return;
          el.style.removeProperty('transition'); el.style.removeProperty('will-change'); el.style.removeProperty('contain'); el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color'); el.style.removeProperty('backface-visibility');
          st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false;
        }
      };
    }

    /* ── Shadow Band table ── */
    const _SHADOW_BANDS = Object.freeze([
      { toe: -3.0, mid: -0.010, shoulder: 1.5, bright: -0.4, gamma: 0.990, contrast: 1.015, sat: 1.005 },
      { toe: -6.0, mid: -0.015, shoulder: 2.5, bright: -0.6, gamma: 0.982, contrast: 1.020, sat: 1.008 },
      { toe: -9.0, mid: -0.008, shoulder: 3.0, bright: -0.3, gamma: 0.985, contrast: 1.022, sat: 1.000 }
    ]);
    const _SHADOW_TABLE = Array.from({ length: 8 }, (_, mask) => {
      const r = { toe: 0, mid: 0, shoulder: 0, bright: 0, gamma: 1, contrast: 1, sat: 1 };
      for (let i = 0; i < 3; i++) {
        if (!(mask & (1 << i))) continue;
        const b = _SHADOW_BANDS[i];
        r.toe += b.toe; r.mid += b.mid; r.shoulder += b.shoulder; r.bright += b.bright;
        r.gamma *= b.gamma; r.contrast *= b.contrast; r.sat *= b.sat;
      }
      return Object.freeze(r);
    });

    function applyShadowBandStack(out, mask) {
      const m = (Number(mask) | 0) & 7;
      if (!m) return out;
      const p = _SHADOW_TABLE[m];
      out.toe += p.toe; out.mid += p.mid; out.shoulder += p.shoulder;
      out.bright += p.bright; out.gamma *= p.gamma; out.contrast *= p.contrast; out.satF *= p.sat;
      return out;
    }

    /* ── Bright Step table ── */
    const _BRIGHT_STEP = [
      null,
      { brightAdd: 1.5, gammaMul: 1.018, contrastMul: 0.995 },
      { brightAdd: 3.2, gammaMul: 1.035, contrastMul: 0.990 },
      { brightAdd: 5.0, gammaMul: 1.06, contrastMul: 0.985 }
    ];

    function applyBrightStepStack(out, brightStepLevel) {
      const lvl = Math.max(0, Math.min(3, Math.round(Number(brightStepLevel) || 0)));
      if (!lvl) return out;
      const s = _BRIGHT_STEP[lvl];
      out.bright = (out.bright || 0) + s.brightAdd;
      out.gamma = (out.gamma || 1) * s.gammaMul;
      out.contrast = (out.contrast || 1) * s.contrastMul;
      return out;
    }

    /* ── Dynamic Sharpness Multiplier ── */
    function computeResolutionSharpMul(video) {
      const nW = video.videoWidth || 0, nH = video.videoHeight || 0;
      const dW = video.clientWidth || video.offsetWidth || 0;
      const dH = video.clientHeight || video.offsetHeight || 0;
      const dpr = Math.max(1, window.devicePixelRatio || 1);

      if (nW < 16 || dW < 16) return { mul: 0.0, autoBase: 0.0 };

      const ratio = Math.max(dW / nW, dH / Math.max(1, nH));
      let mul = 1.0;

      if (ratio < 0.15) mul = 0.30;
      else if (ratio < 0.5) mul = 0.30 + (ratio - 0.15) * 2.0;
      else if (ratio <= 1.5) mul = 1.0;
      else if (ratio <= 3.0) mul = 1.0 + (ratio - 1.5) * 0.10;
      else mul = Math.max(0.50, 1.15 - (ratio - 3.0) * 0.15);

      if (nW <= 640 && nH <= 480) mul *= 0.65;
      else if (nW <= 960) mul *= 0.75;

      if (dpr >= 2.0) mul *= VSC_CLAMP(1.6 / dpr, 0.70, 0.90);
      else if (dpr >= 1.25) mul *= VSC_CLAMP(1.4 / dpr, 0.80, 1.0);
      if (CONFIG.IS_MOBILE && mul < 0.35) mul = 0.35;
      mul = VSC_CLAMP(mul, 0.0, 1.0);

      let autoBase = 0.0;
      if (nW <= 640) autoBase = 0.14;
      else if (nW <= 960) autoBase = 0.11;
      else if (nW <= 1280) autoBase = 0.08;
      else if (nW <= 1920) autoBase = 0.04;
      else autoBase = 0.02;

      autoBase *= mul;
      autoBase = VSC_CLAMP(autoBase, 0.0, 0.18);

      return { mul, autoBase };
    }

    /* ══════════════════════════════════════════════════════════════════
       composeVideoParamsInto (v200: fix double correction)
       ══════════════════════════════════════════════════════════════════ */
    function composeVideoParamsInto(out, vUser, autoMods, sharpMul = 1.0, autoSharpBase = 0.0) {
      const gPreset = PRESETS.grade[vUser.presetB] || PRESETS.grade.off;
      const mix = VSC_CLAMP(Number(vUser.presetMix) || 1, 0, 1);

      out.gain = 1.0;
      out.gamma = 1 + ((gPreset.gammaF || 1) - 1) * mix;
      out.contrast = 1.0;
      out.bright = (gPreset.brightAdd || 0) * mix;
      out.satF = 1.0;
      out.toe = 0; out.mid = 0; out.shoulder = 0;
      out.temp = 0;

      if (vUser.presetS === 'none') {
        out.sharp = 0;
      } else if (vUser.presetS === 'off') {
        out.sharp = autoSharpBase;
      } else {
        const dPreset = PRESETS.detail[vUser.presetS] || PRESETS.detail.off;
        const baseS = (dPreset.sharpAdd || 0) + (dPreset.sharp2Add || 0) * 0.6 + (dPreset.clarityAdd || 0) * 0.4;
        out.sharp = (baseS / 100.0) * mix * sharpMul;
      }

      applyShadowBandStack(out, vUser.shadowBandMask);
      applyBrightStepStack(out, vUser.brightStepLevel);

      if (autoMods._toneCurve) {
        if (vUser.presetB && vUser.presetB !== 'off') {
          const ATTENUATION = 0.45;
          out.bright *= ATTENUATION;
          out.gamma = 1.0 + (out.gamma - 1.0) * ATTENUATION;
        }
        out.satF *= autoMods.sat;
        out._autoToneCurve = autoMods._toneCurve.slice();
        out._autoChannelGains = autoMods._channelGains || null;
        out._cssBr = 1.0;
        out._cssCt = 1.0;
        out._cssSat = VSC_CLAMP(out.satF, 0, 3.0);
      } else {
        out.gain *= autoMods.br;
        out.contrast *= autoMods.ct;
        out.satF *= autoMods.sat;
        out._cssBr = VSC_CLAMP(1.0 + out.bright * 0.008, 0.5, 2.0);
        out._cssCt = VSC_CLAMP(out.contrast, 0.5, 2.0);
        out._cssSat = VSC_CLAMP(out.satF, 0, 3.0);
      }

      return out;
    }

    const isNeutralVideoParams = (v) => (
      !v._autoToneCurve && !v._autoChannelGains &&
      Math.abs((v.gain ?? 1) - 1) < 0.001 &&
      Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
      Math.abs((v.contrast ?? 1) - 1) < 0.001 &&
      Math.abs((v.bright ?? 0)) < 0.01 &&
      Math.abs((v.toe ?? 0)) < 0.01 &&
      Math.abs((v.mid ?? 0)) < 0.001 &&
      Math.abs((v.shoulder ?? 0)) < 0.01 &&
      Math.abs((v.sharp ?? 0)) < 0.01 &&
      Math.abs((v.temp ?? 0)) < 0.01 &&
      Math.abs((v._cssBr ?? 1) - 1) < 0.001 &&
      Math.abs((v._cssCt ?? 1) - 1) < 0.001 &&
      Math.abs((v._cssSat ?? 1) - 1) < 0.001
    );

    /* ── Video Params Memoization ── */
    function createVideoParamsMemo(Store, P, Utils) {
      const cache = new Map();
      const MAX_CACHE_SIZE = 16;
      const sigVideo = (vf) => [vf.presetS, vf.presetB, Number(vf.presetMix).toFixed(3), (vf.shadowBandMask | 0), (vf.brightStepLevel | 0)].join('|');

      return {
        get(vfUser, activeTarget) {
          const w = activeTarget ? (activeTarget.videoWidth || 0) : 0;
          const ht = activeTarget ? (activeTarget.videoHeight || 0) : 0;
          const autoMods = window[VSC_INTERNAL_SYM]?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
          const { mul, autoBase } = activeTarget ? computeResolutionSharpMul(activeTarget) : { mul: 0.0, autoBase: 0.0 };
          const finalMul = (mul === 0.0 && vfUser.presetS !== 'off') ? 0.50 : mul;
          const key = `${sigVideo(vfUser)}|${w}x${ht}|auto:${autoMods.br.toFixed(3)}|smul:${finalMul.toFixed(3)}|ab:${autoBase.toFixed(3)}`;

          if (activeTarget) {
            const cached = cache.get(activeTarget);
            if (cached && cached.key === key) return cached.result;
          }

          const base = {};
          composeVideoParamsInto(base, vfUser, autoMods, finalMul, autoBase);
          const svgBase = { ...base };
          svgBase.sharp = Math.min(Number(svgBase.sharp || 0), 28);

          if (activeTarget) {
            cache.set(activeTarget, { key, result: svgBase });
            if (cache.size > MAX_CACHE_SIZE) {
              const firstKey = cache.keys().next().value;
              cache.delete(firstKey);
            }
          }
          return svgBase;
        },
        invalidate() { cache.clear(); }
      };
    }

    /* ── Shadow style helpers ── */
    const __styleCacheMaxSize = 16;
    const __styleCache = new Map();
    __globalSig.addEventListener('abort', () => { __styleCache.clear(); }, { once: true });

    function applyShadowStyle(shadow, cssText, h) {
      try {
        if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) {
          const cur = shadow.adoptedStyleSheets || [];
          let sheet = __styleCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __styleCache.set(cssText, sheet);
            if (__styleCache.size > __styleCacheMaxSize) __styleCache.delete(__styleCache.keys().next().value);
          }
          if (!cur.includes(sheet)) {
            const filtered = cur.filter(s => { try { const r = s.cssRules; if (r.length > 0 && r[0].cssText?.includes('.panel')) return false; } catch (_) {} return true; });
            shadow.adoptedStyleSheets = [...filtered, sheet];
          }
          return;
        }
      } catch (_) {}
      const marker = 'data-vsc-style';
      let stEl = shadow.querySelector(`style[${marker}="1"]`);
      if (!stEl) { stEl = h('style', { [marker]: '1' }, cssText); shadow.append(stEl); }
      else if (stEl.textContent !== cssText) stEl.textContent = cssText;
    }

    const createDisposerBag = () => {
      const fns = [];
      return { add: (fn) => (typeof fn === 'function' && fns.push(fn), fn), flush: () => { fns.forEach(fn => { try { fn(); } catch (_) {} }); fns.length = 0; } };
    };

    function bindWindowDrag(onMove, onEnd) {
      const ac = new AbortController(); const sig = ac.signal;
      window.addEventListener('mousemove', onMove, { passive: false, signal: sig });
      window.addEventListener('mouseup', end, { signal: sig });
      window.addEventListener('touchmove', onMove, { passive: false, signal: sig });
      window.addEventListener('touchend', end, { signal: sig });
      window.addEventListener('blur', end, { signal: sig });
      let ended = false;
      function end(ev) { if (ended) return; ended = true; try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} } }
      return () => { if (!ended) { ended = true; try { ac.abort(); } catch (_) {} } };
    }

    /* ══════════════════════════════════════════════════════════════════
       SVG Icon Builders (v200: DOM API — no innerHTML)
       ══════════════════════════════════════════════════════════════════ */
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function createSvgElement(tag, attrs = {}, ...children) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (v != null && v !== false) el.setAttribute(k, String(v));
      }
      for (const child of children.flat()) {
        if (child != null) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
      return el;
    }

    const _s = createSvgElement;

    const VSC_ICON_BUILDERS = Object.freeze({
      gear(size = 20) {
        return _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          _s('circle', { cx: '12', cy: '12', r: '3' }),
          _s('path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' })
        );
      },
      pip(size = 14) {
        return _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
          _s('rect', { x: '2', y: '3', width: '20', height: '14', rx: '2' }),
          _s('rect', { x: '12', y: '9', width: '8', height: '6', rx: '1' })
        );
      },
      maximize(size = 14) {
        return _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
          _s('polyline', { points: '15 3 21 3 21 9' }),
          _s('polyline', { points: '9 21 3 21 3 15' }),
          _s('line', { x1: '21', y1: '3', x2: '14', y2: '10' }),
          _s('line', { x1: '3', y1: '21', x2: '10', y2: '14' })
        );
      },
      zoom(size = 14) {
        return _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
          _s('circle', { cx: '11', cy: '11', r: '8' }),
          _s('line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }),
          _s('line', { x1: '11', y1: '8', x2: '11', y2: '14' }),
          _s('line', { x1: '8', y1: '11', x2: '14', y2: '11' })
        );
      },
      camera(size = 14) {
        return _s('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' },
          _s('path', { d: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z' }),
          _s('circle', { cx: '12', cy: '13', r: '4' })
        );
      }
    });

    function svgIcon(name, size) {
      const builder = VSC_ICON_BUILDERS[name];
      if (!builder) return document.createTextNode('');
      return builder(size);
    }

    /* ══════════════════════════════════════════════════════════════════
       CSS_VARS (v200: CSS custom properties, WCAG touch targets,
       safe-area, reduced-motion, high-contrast)
       ══════════════════════════════════════════════════════════════════ */
    const CSS_VARS = `
:host {
  --vsc-bg: rgba(18, 18, 22, 0.94);
  --vsc-bg-hover: rgba(50, 50, 60, 0.95);
  --vsc-border: rgba(255, 255, 255, 0.08);
  --vsc-border-active: rgba(110, 168, 254, 0.35);
  --vsc-text: rgba(255, 255, 255, 0.92);
  --vsc-text-dim: rgba(255, 255, 255, 0.55);
  --vsc-text-muted: rgba(255, 255, 255, 0.35);
  --vsc-accent: #6ea8fe;
  --vsc-accent-bg: rgba(110, 168, 254, 0.20);
  --vsc-accent-border: rgba(110, 168, 254, 0.35);
  --vsc-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
  --vsc-blur: blur(18px) saturate(180%);
  --vsc-space-xs: 4px;
  --vsc-space-sm: 6px;
  --vsc-space-md: 10px;
  --vsc-space-lg: 14px;
  --vsc-space-xl: 20px;
  --vsc-radius-sm: 5px;
  --vsc-radius-md: 7px;
  --vsc-radius-lg: 10px;
  --vsc-radius-xl: 14px;
  --vsc-font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vsc-font-xs: 10px;
  --vsc-font-sm: 11px;
  --vsc-font-md: 13px;
  --vsc-font-lg: 14px;
  --vsc-font-xl: 24px;
  --vsc-touch-min: ${CONFIG.IS_MOBILE ? '44px' : '32px'};
  --vsc-touch-slider: ${CONFIG.IS_MOBILE ? '24px' : '14px'};
  --vsc-panel-width: 330px;
  --vsc-panel-right: ${CONFIG.IS_MOBILE ? '56px' : '52px'};
  --vsc-panel-max-h: 82vh;
  --vsc-qbar-right: ${CONFIG.IS_MOBILE ? '6px' : '10px'};
  --vsc-qbar-btn-size: var(--vsc-touch-min);
  --vsc-transition-fast: 0.12s ease;
  --vsc-transition-normal: 0.18s ease;
  --vsc-transition-slow: 0.25s ease;
}`;

    /* ── OSD (v200: accessible, managed timer, enhanced shadow) ── */
    let __osdReady = false;
    onWin('pointerdown', () => { __osdReady = true; }, { passive: true, once: true });
    onWin('keydown', () => { __osdReady = true; }, { passive: true, once: true });
    let __osdEl = null;
    let __osdTimerId = 0;
    function showOSD(text, durationMs = 1200) {
      if (!__osdReady || !document.body) return;
      try {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const root = fsEl || document.body || document.documentElement;
        if (__osdEl && __osdEl.isConnected && __osdEl.parentNode !== root) {
          clearTimer(__osdTimerId); __osdTimerId = 0;
          __osdEl.remove();
          __osdEl = null;
        }
        if (!__osdEl || !__osdEl.isConnected) {
          if (__osdEl) { clearTimer(__osdTimerId); __osdTimerId = 0; __osdEl = null; }
          __osdEl = document.createElement('div'); __osdEl.id = 'vsc-osd';
          __osdEl.setAttribute('role', 'status');
          __osdEl.setAttribute('aria-live', 'polite');
          __osdEl.setAttribute('aria-atomic', 'true');
          __osdEl.style.cssText = [
            'position:fixed',
            'top:48px',
            'left:50%',
            'transform:translateX(-50%)',
            'background:rgba(18,18,22,0.94)',
            'backdrop-filter:blur(20px) saturate(180%)',
            'color:rgba(255,255,255,0.95)',
            'padding:10px 24px',
            'border-radius:10px',
            'border:1px solid rgba(255,255,255,0.12)',
            'font:600 13px/1.4 system-ui,-apple-system,sans-serif',
            'z-index:2147483647',
            'pointer-events:none',
            'opacity:0',
            'transition:opacity 0.18s ease',
            'box-shadow:0 8px 32px rgba(0,0,0,0.45),0 0 0 1px rgba(0,0,0,0.15)',
            'letter-spacing:0.3px',
            'white-space:pre-line',
            'max-width:90vw',
            'text-align:center',
            'word-break:keep-all'
          ].join(';');
          try { root.appendChild(__osdEl); } catch (_) { __osdEl = null; return; }
        }
        __osdEl.textContent = text; __osdEl.style.opacity = '1';
        clearTimer(__osdTimerId);
        __osdTimerId = setTimer(() => { __osdTimerId = 0; if (__osdEl) __osdEl.style.opacity = '0'; }, durationMs);
      } catch (_) {}
    }
    __globalSig.addEventListener('abort', () => { clearTimer(__osdTimerId); __osdTimerId = 0; if (__osdEl?.isConnected) { try { __osdEl.remove(); } catch (_) {} } __osdEl = null; }, { once: true });

    /* ══════════════════════════════════════════════════════════════════
       PiP helpers (v200: Symbol refs)
       ══════════════════════════════════════════════════════════════════ */
    async function enterPiP(video) {
      if (!video || !video.isConnected) return false;
      const st = getVState(video);
      if (st._inPiP) return true;

      if (window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        try {
          const pipWin = await window.documentPictureInPicture.requestWindow({
            width: video.clientWidth || 640,
            height: video.clientHeight || 360
          });
          __pipOrigParent = video.parentNode;
          __pipOrigNext = video.nextSibling;
          __pipOrigCss = video.style.cssText;

          const ph = document.createElement('div');
          ph.style.cssText = `width:${video.clientWidth}px;height:${video.clientHeight}px;background:#000;`;
          ph.dataset.vscPipPh = '1';
          __pipPlaceholder = ph;
          video.parentNode.insertBefore(ph, video);

          pipWin.document.body.style.cssText = 'margin:0;padding:0;background:#000;overflow:hidden;';
          pipWin.document.body.appendChild(video);
          video.style.cssText = 'width:100%;height:100%;object-fit:contain;';

          __activeDocumentPiPWindow = pipWin;
          __activeDocumentPiPVideo = video;
          st._inPiP = true;

          pipWin.addEventListener('pagehide', () => exitPiP(video), { once: true });
          return true;
        } catch (e) { log.debug('Document PiP failed, falling back:', e.message); }
      }

      if (typeof video.requestPictureInPicture === 'function') {
        try { await video.requestPictureInPicture(); st._inPiP = true; return true; }
        catch (e) { log.debug('Native PiP failed:', e.message); }
      }
      return false;
    }

    async function exitPiP(video) {
      const st = video ? getVState(video) : null;

      if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed) {
        try {
          if (__pipOrigParent?.isConnected) {
            if (__pipPlaceholder?.parentNode === __pipOrigParent) {
              __pipOrigParent.insertBefore(video, __pipPlaceholder);
              __pipPlaceholder.remove();
            } else if (__pipOrigNext?.parentNode === __pipOrigParent) {
              __pipOrigParent.insertBefore(video, __pipOrigNext);
            } else {
              __pipOrigParent.appendChild(video);
            }
          }
          video.style.cssText = __pipOrigCss || '';
          cleanupPipDocumentSvg(__activeDocumentPiPWindow.document);
          __activeDocumentPiPWindow.close();
        } catch (_) {}
        resetPiPState();
        if (st) {
          st._inPiP = false; st.applied = false;
          st.lastFilterUrl = null; st.lastCssFilterStr = null;
        }
        return;
      }

      if (document.pictureInPictureElement === video) {
        try { await document.exitPictureInPicture(); } catch (_) {}
      }
      if (st) st._inPiP = false;
    }

    async function togglePiPFor(video) {
      if (!video) return;
      const st = getVState(video);
      const isActive = st._inPiP ||
        document.pictureInPictureElement === video ||
        (__activeDocumentPiPVideo === video && __activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed);
      if (isActive) await exitPiP(video);
      else await enterPiP(video);
    }

    /* ── captureVideoFrame ── */
    function captureVideoFrame(video) {
      if (!video || video.readyState < 2) { showOSD('비디오 준비 안됨', 1000); return; }
      try {
        const c = document.createElement('canvas');
        c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0);
        c.toBlob(blob => {
          if (!blob) { showOSD('캡처 실패', 1000); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = `vsc-capture-${Date.now()}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimer(() => URL.revokeObjectURL(url), 3000);
          showOSD('프레임 저장됨', 1200);
        }, 'image/png');
      } catch (_) { showOSD('캡처 실패 (DRM?)', 1500); }
    }

    // ═══ END OF PART 4 (v200.0.0-Hybrid) ═══
    // PART 5 continues with: createZoomManager, createUI (CSS_VARS integrated),
    //   bindVideoOnce (per-video AC + EME hooks), createApplyLoop, createKeyboard,
    //   save/restore/persistence, bootstrap (FeatureRegistry wiring), entry point
    // ═══ PART 5 START (v200.0.0-Hybrid) — continues directly from PART 4's captureVideoFrame ═══

    /* ══════════════════════════════════════════════════════════════════
       createZoomManager (v200: cleanup touch residuals on zoom off)
       ══════════════════════════════════════════════════════════════════ */
    function createZoomManager() {
      const zoomStates = new WeakMap();
      const zoomedVideos = new Set();
      let activeVideo = null, activePointerId = null, isPanning = false;
      let startX = 0, startY = 0;
      const pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      let rafId = null, destroyed = false;
      const pendingUpdates = new Set();
      const ZOOM_PROPS = ['transform', 'transform-origin', 'will-change', 'z-index', 'position', 'contain', 'isolation'];

      const isZoomEnabled = () => !!window[VSC_INTERNAL_SYM]?.Store?.get(P.APP_ZOOM_EN);

      function getSt(v) {
        let s = zoomStates.get(v);
        if (!s) {
          s = { scale: 1, tx: 0, ty: 0, zoomed: false, hasPanned: false, _savedPosition: '', _savedZIndex: '' };
          zoomStates.set(v, s);
        }
        return s;
      }

      function clampPan(v, st) {
        try {
          const r = v.getBoundingClientRect();
          const maxTx = Math.max(0, (r.width * st.scale - r.width) / 2 / st.scale);
          const maxTy = Math.max(0, (r.height * st.scale - r.height) / 2 / st.scale);
          st.tx = VSC_CLAMP(st.tx, -maxTx, maxTx);
          st.ty = VSC_CLAMP(st.ty, -maxTy, maxTy);
        } catch (_) {}
      }

      function update(v) {
        if (destroyed) return;
        pendingUpdates.add(v);
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          for (const vid of pendingUpdates) {
            if (!vid.isConnected) continue;
            const st = getSt(vid);
            if (st.scale <= 1 && st.zoomed) { resetZoom(vid); continue; }
            if (st.scale > 1) {
              vid.style.setProperty('transform', `scale(${st.scale}) translate(${st.tx}px,${st.ty}px)`, 'important');
              vid.style.setProperty('transform-origin', 'center center', 'important');
              if (!st.zoomed) {
                st._savedPosition = vid.style.getPropertyValue('position');
                st._savedZIndex = vid.style.getPropertyValue('z-index');
                vid.style.setProperty('position', 'relative', 'important');
                vid.style.setProperty('z-index', '999999', 'important');
                st.zoomed = true; zoomedVideos.add(vid);
              }
              const wc = getVState(vid).applied ? 'filter, transform' : 'transform';
              vid.style.setProperty('will-change', wc, 'important');
            }
          }
          pendingUpdates.clear();
        });
      }

      function zoomTo(v, scale) {
        const st = getSt(v); st.scale = scale;
        clampPan(v, st); update(v);
      }

      function resetZoom(v) {
        const st = getSt(v);
        for (const prop of ZOOM_PROPS) v.style.removeProperty(prop);
        v.style.removeProperty('will-change');
        v.style.removeProperty('contain');
        v.style.removeProperty('isolation');
        v.style.removeProperty('-webkit-tap-highlight-color');

        if (st._savedPosition) v.style.setProperty('position', st._savedPosition);
        else v.style.removeProperty('position');
        if (st._savedZIndex) v.style.setProperty('z-index', st._savedZIndex);
        else v.style.removeProperty('z-index');

        st.scale = 1; st.tx = 0; st.ty = 0; st.zoomed = false; st.hasPanned = false;
        st._savedPosition = ''; st._savedZIndex = '';
        zoomedVideos.delete(v);
        __touchBlocked.delete(v);

        v.style.setProperty('touch-action', 'auto', 'important');
        void v.offsetHeight;

        requestAnimationFrame(() => {
          v.style.removeProperty('touch-action');
          v.style.removeProperty('-webkit-tap-highlight-color');
          let p = v.parentElement;
          while (p && p !== document.body && p !== document.documentElement) {
            if (p.dataset?.vscTouchBlocked) {
              p.style.setProperty('touch-action', 'auto', 'important');
              delete p.dataset.vscTouchBlocked;
              const parent = p;
              requestAnimationFrame(() => {
                parent.style.removeProperty('touch-action');
                parent.style.removeProperty('-webkit-tap-highlight-color');
              });
            }
            p = p.parentElement;
          }
        });
      }

      function isZoomed(v) { return !!(zoomStates.get(v)?.zoomed); }

      function isVscUiEvent(e) {
        try {
          const path = e.composedPath?.() || [];
          for (let i = 0, len = Math.min(path.length, 8); i < len; i++) {
            const n = path[i];
            if (n?.hasAttribute?.('data-vsc-ui') || n?.id === 'vsc-host' || n?.id === 'vsc-gear-host') return true;
          }
        } catch (_) {}
        return false;
      }

      function getTargetVideo(e) {
        const points = [];
        if (e.touches && e.touches.length > 0) {
          for (let i = 0; i < e.touches.length; i++) points.push({ x: e.touches[i].clientX, y: e.touches[i].clientY });
        } else if (typeof e.clientX === 'number') {
          points.push({ x: e.clientX, y: e.clientY });
        }
        if (points.length > 0) {
          const px = points[0].x, py = points[0].y;
          let bestVideo = null, bestArea = 0;
          for (const v of TOUCHED.videos) {
            if (!v?.isConnected) continue;
            try {
              const r = v.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                const area = r.width * r.height;
                if (area > bestArea) { bestArea = area; bestVideo = v; }
              }
            } catch (_) {}
          }
          if (bestVideo) return bestVideo;
        }
        if (points.length > 0) {
          const px = points[0].x, py = points[0].y;
          try {
            let bestVideo = null, bestArea = 0;
            for (const v of document.querySelectorAll('video')) {
              if (!v.isConnected) continue;
              const r = v.getBoundingClientRect();
              if (r.width < 10 || r.height < 10) continue;
              if (px >= r.left && px <= r.right && py >= r.top && py <= r.bottom) {
                const area = r.width * r.height;
                if (area > bestArea) { bestArea = area; bestVideo = v; }
              }
            }
            if (bestVideo) return bestVideo;
          } catch (_) {}
        }
        for (const pt of points) {
          try {
            const els = document.elementsFromPoint(pt.x, pt.y);
            for (const el of els) { if (el?.tagName === 'VIDEO') return el; }
            for (const el of els) {
              if (!el || el.nodeType !== 1) continue;
              const vid = el.querySelector?.('video');
              if (vid) return vid;
              if (el.shadowRoot) { const svid = el.shadowRoot.querySelector('video'); if (svid) return svid; }
              const p = el.parentElement;
              if (p) { const s = p.querySelector?.('video'); if (s) return s; }
              const ct = el.closest?.('[class*="player"],[class*="Player"],[class*="video"],[class*="Video"],[id*="player"],[id*="Player"],[id*="video"],[id*="Video"],[data-player],[data-testid*="player"],[data-testid*="video"]');
              if (ct) { const v2 = ct.querySelector('video'); if (v2) return v2; if (ct.shadowRoot) { const sv2 = ct.shadowRoot.querySelector('video'); if (sv2) return sv2; } }
            }
          } catch (_) {}
        }
        const active = window[VSC_INTERNAL_SYM]?._activeVideo;
        if (active?.isConnected) return active;
        try { const all = document.querySelectorAll('video'); if (all.length === 1 && all[0].isConnected) return all[0]; } catch (_) {}
        return null;
      }

      function getTouchDist(ts) { const dx = ts[0].clientX - ts[1].clientX; const dy = ts[0].clientY - ts[1].clientY; return Math.sqrt(dx * dx + dy * dy); }
      function getTouchCenter(ts) { return { x: (ts[0].clientX + ts[1].clientX) / 2, y: (ts[0].clientY + ts[1].clientY) / 2 }; }

      const __touchBlocked = new WeakSet();

      function setTouchActionBlocking(v, enable) {
        if (!v) return;
        if (enable) {
          v.style.setProperty('touch-action', 'none', 'important');
          v.style.setProperty('-webkit-tap-highlight-color', 'transparent', 'important');
          __touchBlocked.add(v);
          let p = v.parentElement;
          while (p && p !== document.body && p !== document.documentElement) {
            p.style.setProperty('touch-action', 'none', 'important');
            p.style.setProperty('-webkit-tap-highlight-color', 'transparent', 'important');
            p.dataset.vscTouchBlocked = '1';
            p = p.parentElement;
          }
        } else {
          v.style.setProperty('touch-action', 'auto', 'important');
          v.style.removeProperty('-webkit-tap-highlight-color');
          v.style.removeProperty('will-change');
          v.style.removeProperty('contain');
          v.style.removeProperty('transform');
          v.style.removeProperty('transform-origin');
          v.style.removeProperty('isolation');
          __touchBlocked.delete(v);
          let p = v.parentElement;
          while (p && p !== document.body && p !== document.documentElement) {
            if (p.dataset?.vscTouchBlocked) {
              p.style.setProperty('touch-action', 'auto', 'important');
              p.style.removeProperty('-webkit-tap-highlight-color');
              delete p.dataset.vscTouchBlocked;
            }
            p = p.parentElement;
          }
          void v.offsetHeight;
          requestAnimationFrame(() => {
            if (!__touchBlocked.has(v)) {
              v.style.removeProperty('touch-action');
              let p2 = v.parentElement;
              while (p2 && p2 !== document.body && p2 !== document.documentElement) {
                if (!p2.dataset?.vscTouchBlocked) { p2.style.removeProperty('touch-action'); }
                p2 = p2.parentElement;
              }
            }
          });
        }
      }

      function cleanupAllTouchBlocking() {
        try {
          for (const el of document.querySelectorAll('[data-vsc-touch-blocked]')) {
            el.style.setProperty('touch-action', 'auto', 'important');
            el.style.removeProperty('-webkit-tap-highlight-color');
            delete el.dataset.vscTouchBlocked;
          }
          const allVideos = new Set([...document.querySelectorAll('video'), ...TOUCHED.videos]);
          for (const v of allVideos) {
            if (!v?.isConnected) continue;
            v.style.setProperty('touch-action', 'auto', 'important');
            v.style.removeProperty('-webkit-tap-highlight-color');
            v.style.removeProperty('isolation');
            __touchBlocked.delete(v);
          }
          requestAnimationFrame(() => {
            for (const el of document.querySelectorAll('[style*="touch-action"]')) {
              if (!__touchBlocked.has(el)) { el.style.removeProperty('touch-action'); }
            }
            for (const v of allVideos) {
              if (v?.isConnected && !__touchBlocked.has(v)) { v.style.removeProperty('touch-action'); }
            }
          });
        } catch (_) {}
      }

      let __zoomModeWatcherUnsub = null;
      function watchZoomModeToggle() {
        const store = window[VSC_INTERNAL_SYM]?.Store;
        if (!store || __zoomModeWatcherUnsub) return;
        __zoomModeWatcherUnsub = store.sub(P.APP_ZOOM_EN, (enabled) => {
          if (enabled) {
            for (const v of TOUCHED.videos) { if (v?.isConnected) setTouchActionBlocking(v, true); }
          } else {
            for (const v of [...zoomedVideos]) { resetZoom(v); setTouchActionBlocking(v, false); }
            for (const v of TOUCHED.videos) {
              if (__touchBlocked.has(v)) setTouchActionBlocking(v, false);
              v.style.removeProperty('will-change');
              v.style.removeProperty('contain');
              v.style.removeProperty('transform');
              v.style.removeProperty('transform-origin');
              v.style.removeProperty('isolation');
            }
            cleanupAllTouchBlocking();
            activeVideo = null; isPanning = false; pinchState.active = false;
            activePointerId = null; __lastFoundVideo = null;
          }
        });
      }

      const __tryWatchInterval = setRecurring(() => {
        if (window[VSC_INTERNAL_SYM]?.Store) { watchZoomModeToggle(); clearRecurring(__tryWatchInterval); }
      }, 200, { maxErrors: 50 });

      function onNewVideoForZoom(v) {
        if (!v || !isZoomEnabled()) return;
        if (!__touchBlocked.has(v)) setTouchActionBlocking(v, true);
      }

      let __lastFoundVideo = null, __lastFoundVideoT = 0;
      const VIDEO_CACHE_TTL = 3000;
      function getCachedOrFindVideo(e) {
        const now = performance.now();
        if (__lastFoundVideo?.isConnected && (now - __lastFoundVideoT) < VIDEO_CACHE_TTL) return __lastFoundVideo;
        const v = getTargetVideo(e);
        if (v) { __lastFoundVideo = v; __lastFoundVideoT = now; }
        return v;
      }

      onWin('wheel', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        const newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale);
      }, { passive: false, capture: true });

      onWin('pointerdown', e => {
        if (!e.altKey || !isZoomEnabled() || e.pointerType === 'touch') return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        const st = getSt(v); if (st.scale <= 1) return;
        e.preventDefault(); e.stopPropagation();
        activeVideo = v; activePointerId = e.pointerId; isPanning = true; st.hasPanned = false;
        startX = e.clientX - st.tx; startY = e.clientY - st.ty;
        try { v.setPointerCapture?.(e.pointerId); } catch (_) {}
        update(v);
      }, { capture: true, passive: false });

      onWin('pointermove', e => {
        if (!isPanning || !activeVideo || e.pointerId !== activePointerId) return;
        if (!activeVideo.isConnected) { isPanning = false; try { activeVideo.releasePointerCapture?.(e.pointerId); } catch (_) {} activePointerId = null; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
        const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
        const last = events[events.length - 1] || e;
        const nextTx = last.clientX - startX, nextTy = last.clientY - startY;
        if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
        st.tx = nextTx; st.ty = nextTy;
        clampPan(activeVideo, st); update(activeVideo);
      }, { capture: true, passive: false });

      function endPointerPan(e) {
        if (e.pointerType === 'touch' || !isPanning || !activeVideo || e.pointerId !== activePointerId) return;
        const v = activeVideo, st = getSt(v);
        try { v.releasePointerCapture?.(e.pointerId); } catch (_) {}
        if (st.hasPanned && e.cancelable) { e.preventDefault(); e.stopPropagation(); }
        activePointerId = null; isPanning = false; activeVideo = null; update(v);
      }
      onWin('pointerup', endPointerPan, { capture: true, passive: false });
      onWin('pointercancel', endPointerPan, { capture: true, passive: false });

      onWin('dblclick', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        if (st.scale === 1) zoomTo(v, 2.5); else resetZoom(v);
      }, { capture: true });

      onWin('touchstart', e => {
        if (!isZoomEnabled() || isVscUiEvent(e)) return;
        if (e.touches.length === 2) {
          const v = getCachedOrFindVideo(e); isPanning = false;
          if (e.cancelable) e.preventDefault();
          if (!v) { pinchState.active = false; activeVideo = null; return; }
          setTouchActionBlocking(v, true);
          activeVideo = v; pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = getSt(v).scale;
          const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        } else if (e.touches.length === 1) {
          const v = getCachedOrFindVideo(e); if (!v) return;
          const st = getSt(v);
          if (st.scale > 1) { if (e.cancelable) e.preventDefault(); activeVideo = v; isPanning = true; st.hasPanned = false; startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty; }
        }
      }, { passive: false, capture: true });

      onWin('touchmove', e => {
        if (!activeVideo && !pinchState.active && e.touches.length === 2 && isZoomEnabled()) {
          if (e.cancelable) e.preventDefault();
          const v = getCachedOrFindVideo(e);
          if (v) { setTouchActionBlocking(v, true); activeVideo = v; pinchState.active = true; pinchState.initialDist = getTouchDist(e.touches); pinchState.initialScale = getSt(v).scale; const c = getTouchCenter(e.touches); pinchState.lastCx = c.x; pinchState.lastCy = c.y; }
          return;
        }
        if (!activeVideo) return;
        if (!activeVideo.isConnected) { isPanning = false; pinchState.active = false; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches); const center = getTouchCenter(e.touches);
          let ns = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist));
          ns = Math.min(Math.max(1, ns), 10);
          if (ns < 1.05) { resetZoom(activeVideo); pinchState.active = false; isPanning = false; activeVideo = null; }
          else { zoomTo(activeVideo, ns); st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy; clampPan(activeVideo, st); update(activeVideo); }
          pinchState.lastCx = center.x; pinchState.lastCy = center.y;
        } else if (isPanning && e.touches.length === 1 && st.scale > 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0]; const nextTx = t.clientX - startX, nextTy = t.clientY - startY;
          if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
          st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo);
        }
      }, { passive: false, capture: true });

      onWin('touchend', e => {
        if (!activeVideo) return;
        if (!activeVideo.isConnected) { isPanning = false; pinchState.active = false; activeVideo = null; return; }
        if (e.touches.length < 2) pinchState.active = false;
        if (e.touches.length === 1 && activeVideo?.isConnected && getSt(activeVideo).scale > 1) {
          isPanning = true; const st = getSt(activeVideo); st.hasPanned = false;
          startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
        } else if (e.touches.length === 0) { const v = activeVideo; isPanning = false; update(v); activeVideo = null; }
      }, { passive: false, capture: true });

      onWin('touchcancel', () => {
        if (!activeVideo) return;
        const v = activeVideo; isPanning = false; pinchState.active = false; activeVideo = null; update(v);
      }, { passive: true, capture: true });

      return Object.freeze({
        resetZoom(v) { resetZoom(v); if (!isZoomEnabled()) setTouchActionBlocking(v, false); },
        zoomTo, isZoomed, onNewVideoForZoom,
        pruneDisconnected() { for (const v of [...zoomedVideos]) { if (!v?.isConnected) { resetZoom(v); setTouchActionBlocking(v, false); } } },
        destroy() {
          destroyed = true;
          if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
          pendingUpdates.clear();
          for (const v of [...zoomedVideos]) { const st = getSt(v); if (st.zoomed) { for (const prop of ZOOM_PROPS) v.style.removeProperty(prop); } st.scale = 1; st.zoomed = false; setTouchActionBlocking(v, false); }
          zoomedVideos.clear(); isPanning = false; pinchState.active = false;
          activeVideo = null; activePointerId = null; __lastFoundVideo = null;
          cleanupAllTouchBlocking();
          if (__zoomModeWatcherUnsub) { __zoomModeWatcherUnsub(); __zoomModeWatcherUnsub = null; }
          try { clearRecurring(__tryWatchInterval); } catch (_) {}
        }
      });
    }

    /* ══════════════════════════════════════════════════════════════════
       createUI (v200: CSS_VARS integrated, SVG DOM icons, WCAG touch,
       safe-area, reduced-motion, high-contrast, Symbol refs)
       ══════════════════════════════════════════════════════════════════ */
    function createUI(Store, Bus, Utils, Audio, AutoScene, ZoomMgr,
                      Targeting, Maximizer, FiltersVO, Registry,
                      Scheduler, ApplyReq) {
      const { h, clamp } = Utils;
      const uiAC = new AbortController();
      const sig = combineSignals(__globalSig, uiAC.signal);
      const isMobile = CONFIG.IS_MOBILE;

      let panelHost = null, panelEl = null, quickBarHost = null;
      let activeTab = 'video', advancedOpen = false, panelOpen = false;
      const syncFns = [];
      let _shadow = null;
      let _qbarShadow = null;
      let qbarVisible = false;

      const PANEL_CSS = `
${CSS_VARS}
:host{all:initial;position:fixed;z-index:2147483647;font-family:var(--vsc-font-family);font-size:var(--vsc-font-md);color:var(--vsc-text);pointer-events:none}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.panel{pointer-events:none;position:fixed;right:var(--vsc-panel-right);width:var(--vsc-panel-width);max-height:var(--vsc-panel-max-h);background:var(--vsc-bg);border:1px solid var(--vsc-border);border-radius:var(--vsc-radius-xl);backdrop-filter:var(--vsc-blur);box-shadow:var(--vsc-shadow);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateX(8px) scale(.97);transition:opacity var(--vsc-transition-normal),transform var(--vsc-transition-normal);user-select:none}
.panel.open{opacity:1;transform:translateX(0) scale(1);pointer-events:auto}
.hdr{display:flex;align-items:center;justify-content:space-between;padding:var(--vsc-space-md) var(--vsc-space-lg);border-bottom:1px solid rgba(255,255,255,.06)}
.hdr .tl{font-weight:700;font-size:var(--vsc-font-lg);letter-spacing:.3px}
.hdr .ver{font-size:var(--vsc-font-xs);opacity:.45;margin-left:var(--vsc-space-sm)}
.tabs{display:flex;border-bottom:1px solid rgba(255,255,255,.06)}
.tab{flex:1;padding:8px 0;text-align:center;font-size:var(--vsc-font-sm);font-weight:600;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;opacity:.45;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s}
.tab:hover{opacity:.7}.tab.on{opacity:1;border-bottom-color:var(--vsc-accent)}
.body{overflow-y:auto;flex:1;padding:var(--vsc-space-md) var(--vsc-space-lg) var(--vsc-space-lg);scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
.row{display:flex;align-items:center;justify-content:space-between;padding:var(--vsc-space-xs) 0;min-height:var(--vsc-touch-min)}
.row label{font-size:12px;opacity:.8;flex:0 0 auto;max-width:48%}
.row .ctrl{display:flex;align-items:center;gap:var(--vsc-space-sm);flex:1;justify-content:flex-end}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;max-width:140px;height:4px;border-radius:2px;background:rgba(255,255,255,.12);outline:none;cursor:pointer}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:var(--vsc-touch-slider);height:var(--vsc-touch-slider);border-radius:50%;background:var(--vsc-accent);cursor:pointer;border:none}
input[type=range]::-moz-range-thumb{width:var(--vsc-touch-slider);height:var(--vsc-touch-slider);border-radius:50%;background:var(--vsc-accent);cursor:pointer;border:none}
.val{font-size:var(--vsc-font-sm);min-width:38px;text-align:right;font-variant-numeric:tabular-nums;opacity:.9}
.btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:var(--vsc-radius-md);color:var(--vsc-text);padding:var(--vsc-space-xs) var(--vsc-space-md);font-size:var(--vsc-font-sm);cursor:pointer;transition:background var(--vsc-transition-fast);min-height:var(--vsc-touch-min);min-width:44px;display:inline-flex;align-items:center;justify-content:center}
.btn:hover{background:rgba(255,255,255,.15)}.btn.pr{background:var(--vsc-accent-bg);border-color:var(--vsc-accent-border)}
.tgl{position:relative;width:36px;height:20px;border-radius:10px;background:rgba(255,255,255,.12);cursor:pointer;transition:background .2s}
.tgl.on{background:rgba(110,168,254,.5)}
.tgl::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .2s}
.tgl.on::after{transform:translateX(16px)}
.sep{height:1px;background:rgba(255,255,255,.06);margin:var(--vsc-space-sm) 0}
.chips{padding:3px 0;display:flex;flex-wrap:wrap;gap:var(--vsc-space-xs)}
.chip{display:inline-flex;align-items:center;justify-content:center;padding:var(--vsc-space-xs) var(--vsc-space-md);min-height:var(--vsc-touch-min);min-width:44px;font-size:var(--vsc-font-sm);border-radius:var(--vsc-radius-sm);cursor:pointer;background:rgba(255,255,255,.06);border:1px solid var(--vsc-border);transition:background var(--vsc-transition-fast),border-color var(--vsc-transition-fast);text-align:center;-webkit-tap-highlight-color:transparent}
.chip:hover{background:rgba(255,255,255,.10)}
.chip.on{background:var(--vsc-accent-bg);border-color:var(--vsc-accent-border)}
.stgl{display:inline-flex;align-items:center;gap:var(--vsc-space-xs);padding:3px var(--vsc-space-md);min-height:var(--vsc-touch-min);min-width:44px;font-size:var(--vsc-font-xs);border-radius:var(--vsc-radius-sm);cursor:pointer;background:rgba(255,255,255,.06);border:1px solid var(--vsc-border);transition:background .15s,border-color .15s;user-select:none;-webkit-tap-highlight-color:transparent}
.stgl.on{background:var(--vsc-accent-bg);border-color:var(--vsc-accent-border)}
.badge{display:inline-block;font-size:9px;padding:2px 6px;border-radius:4px;background:rgba(110,168,254,.15);color:#8ec5fc;margin-left:var(--vsc-space-sm)}
.adv-hd{display:flex;align-items:center;gap:var(--vsc-space-xs);padding:var(--vsc-space-xs) 0;cursor:pointer;font-size:var(--vsc-font-sm);opacity:.55;transition:opacity .15s}
.adv-hd:hover{opacity:.85}
.adv-hd .arr{transition:transform .2s;font-size:9px}
.adv-hd .arr.open{transform:rotate(90deg)}
.adv-bd{overflow:hidden;max-height:0;transition:max-height var(--vsc-transition-slow)}
.adv-bd.open{max-height:600px}
.info-bar{font-size:var(--vsc-font-xs);opacity:.5;padding:var(--vsc-space-xs) 0 var(--vsc-space-sm);line-height:1.5;font-variant-numeric:tabular-nums}
.shortcut-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:var(--vsc-font-xs);line-height:1.6;padding:var(--vsc-space-xs) 0}
.shortcut-grid .sk{font-weight:700;color:#8ec5fc;white-space:nowrap}
.shortcut-grid .sd{opacity:.7}
.rate-display{font-size:var(--vsc-font-xl);font-weight:700;text-align:center;color:#fff;padding:var(--vsc-space-sm) 0;font-variant-numeric:tabular-nums}
.fine-row{display:flex;gap:var(--vsc-space-xs);justify-content:center;padding:var(--vsc-space-xs) 0}
.fine-btn{padding:var(--vsc-space-sm) var(--vsc-space-md);min-height:var(--vsc-touch-min);min-width:44px;border-radius:var(--vsc-radius-sm);border:1px solid var(--vsc-border);background:rgba(255,255,255,.04);color:#aaa;font-size:var(--vsc-font-sm);cursor:pointer;transition:background var(--vsc-transition-fast);font-variant-numeric:tabular-nums;-webkit-tap-highlight-color:transparent}
.fine-btn:hover{background:rgba(255,255,255,.1)}
.qbar{pointer-events:auto;position:fixed;top:50%;right:var(--vsc-qbar-right);transform:translateY(-50%);display:flex;flex-direction:column;gap:var(--vsc-space-sm);align-items:center;opacity:.3;transition:opacity var(--vsc-transition-slow)}
.qbar:hover{opacity:.95}
.qb{width:var(--vsc-qbar-btn-size);height:var(--vsc-qbar-btn-size);min-width:44px;min-height:44px;border-radius:50%;background:var(--vsc-bg);border:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);transition:background var(--vsc-transition-fast),transform .1s,border-color var(--vsc-transition-fast);backdrop-filter:blur(8px);-webkit-tap-highlight-color:transparent}
.qb:hover{background:var(--vsc-bg-hover);transform:scale(1.12)}
.qb:active{transform:scale(0.95)}
.qb svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
.qb:focus-visible,.chip:focus-visible,.btn:focus-visible,.fine-btn:focus-visible{outline:2px solid var(--vsc-accent);outline-offset:2px}
@media(max-width:600px){:host{--vsc-panel-width:calc(100vw - 70px);--vsc-panel-right:56px;--vsc-panel-max-h:75vh;--vsc-radius-xl:12px;--vsc-font-md:14px}}
@media(max-width:400px){:host{--vsc-panel-width:calc(100vw - 52px);--vsc-panel-right:48px;--vsc-font-md:15px}.chips{gap:6px}.fine-row{gap:6px}}
@media(orientation:landscape) and (max-height:500px){:host{--vsc-panel-max-h:90vh}.panel{max-height:90vh}.body{max-height:calc(90vh - 90px)}}
@supports(padding:env(safe-area-inset-right)){.qbar{right:calc(var(--vsc-qbar-right) + env(safe-area-inset-right))}.panel{right:calc(var(--vsc-panel-right) + env(safe-area-inset-right))}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0.01ms!important;animation-duration:0.01ms!important}}
@media(prefers-contrast:high){:host{--vsc-bg:rgba(0,0,0,0.98);--vsc-border:rgba(255,255,255,0.3);--vsc-text:#fff}}`;

      /* ── helpers ── */
      function mkRow(label, ...ctrls) {
        return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls));
      }
      function mkSep() { return h('div', { class: 'sep' }); }

      function mkSlider(path, min, max, step) {
        const inp = h('input', { type: 'range', min, max, step: step || ((max - min) / 100) });
        const valEl = h('span', { class: 'val' });
        const digits = (step && step >= 1) ? 0 : 2;
        function sync() { const v = Number(Store.get(path)) || min; inp.value = String(v); valEl.textContent = v.toFixed(digits); }
        inp.addEventListener('input', () => { const nv = parseFloat(inp.value); Store.set(path, nv); valEl.textContent = nv.toFixed(digits); ApplyReq.soft(); }, { signal: sig });
        syncFns.push(sync); sync();
        return [inp, valEl];
      }

      function mkToggle(path, onChange) {
        const el = h('div', { class: 'tgl' });
        function sync() { el.classList.toggle('on', !!Store.get(path)); }
        el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); }, { signal: sig });
        syncFns.push(sync); sync();
        return el;
      }

      function mkChipRow(label, path, chips, onSelect) {
        const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.7;display:block;margin-bottom:2px' }, label));
        const row = h('div', { class: 'chips' });
        function sync() {
          const cur = String(Store.get(path));
          for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur);
        }
        for (const ch of chips) {
          const el = h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l);
          el.addEventListener('click', () => { Store.set(path, ch.v); sync(); if (onSelect) onSelect(ch.v); else ApplyReq.soft(); }, { signal: sig });
          row.appendChild(el);
        }
        wrap.appendChild(row);
        syncFns.push(sync); sync();
        return wrap;
      }

      function mkShadowBandToggles() {
        const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.7;display:block;margin-bottom:2px' }, '섀도우 밴드'));
        const row = h('div', { style: 'display:flex;gap:4px;padding:3px 0;flex-wrap:wrap' });
        const bands = [
          { bit: 0, label: 'OFF' },
          { bit: SHADOW_BAND.OUTER, label: '외곽' },
          { bit: SHADOW_BAND.MID, label: '중간' },
          { bit: SHADOW_BAND.DEEP, label: '심부' }
        ];
        const buttons = [];
        for (const band of bands) {
          const btn = h('span', { class: 'stgl' }, band.label);
          btn.addEventListener('click', () => {
            if (band.bit === 0) { Store.set(P.V_SHADOW_MASK, 0); }
            else { const cur = Number(Store.get(P.V_SHADOW_MASK)) || 0; Store.set(P.V_SHADOW_MASK, ShadowMask.toggle(cur, band.bit)); }
            syncBands(); ApplyReq.soft();
          }, { signal: sig });
          buttons.push({ el: btn, bit: band.bit });
          row.appendChild(btn);
        }
        function syncBands() {
          const cur = Number(Store.get(P.V_SHADOW_MASK)) || 0;
          for (const b of buttons) {
            if (b.bit === 0) b.el.classList.toggle('on', cur === 0);
            else b.el.classList.toggle('on', ShadowMask.has(cur, b.bit));
          }
        }
        syncFns.push(syncBands); syncBands();
        wrap.appendChild(row);
        return wrap;
      }

      /* ── buildVideoTab ── */
      function buildVideoTab() {
        const w = h('div', {});
        const infoBar = h('div', { class: 'info-bar' });
        function updateInfo() {
          const active = window[VSC_INTERNAL_SYM]._activeVideo;
          const video = (active && active.isConnected) ? active : (() => { try { return document.querySelector('video'); } catch (_) { return null; } })();
          if (!video || !video.isConnected) { infoBar.textContent = '영상 없음'; return; }
          const nW = video.videoWidth || 0, nH = video.videoHeight || 0;
          const dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0;
          if (nW === 0 || nH === 0) { infoBar.textContent = '로딩 중...'; return; }
          const { mul, autoBase } = computeResolutionSharpMul(video);
          const presetS = Store.get(P.V_PRE_S);
          let sharpLabel;
          if (presetS === 'none') sharpLabel = '꺼짐(OFF)';
          else if (presetS === 'off') sharpLabel = `자동(${autoBase.toFixed(3)})`;
          else sharpLabel = `${getPresetLabel('detail', presetS)} (수동)`;
          infoBar.textContent = `원본 ${nW}×${nH} → 출력 ${dW}×${dH}  │  샤프닝: ${sharpLabel}`;
        }
        Bus.on('signal', updateInfo); syncFns.push(updateInfo); updateInfo();
        const infoTimerId = setRecurring(() => { try { updateInfo(); } catch (_) {} }, 2500, { maxErrors: 50 });
        sig.addEventListener('abort', () => clearRecurring(infoTimerId), { once: true });
        w.append(infoBar, mkSep());
        w.append(
          mkChipRow('디테일', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: getPresetLabel('detail', k) })), () => ApplyReq.hard()),
          mkRow('강도', ...mkSlider(P.V_PRE_MIX, 0, 1, 0.01)),
          mkSep()
        );
        w.append(mkShadowBandToggles(), mkSep());
        w.append(
          mkChipRow('밝기 단계', P.V_BRIGHT_STEP, [{ v: 0, l: 'OFF' }, { v: 1, l: '1단계' }, { v: 2, l: '2단계' }, { v: 3, l: '3단계' }]),
          mkSep()
        );
        w.append(
          mkChipRow('암부 복원', P.V_PRE_B, Object.keys(PRESETS.grade).map(k => ({ v: k, l: getPresetLabel('grade', k) })), () => ApplyReq.hard()),
          mkSep()
        );
        const sceneBadge = h('span', { class: 'badge', style: 'display:none' }, '');
        function updateSceneBadge() {
          const isOn = !!Store.get(P.APP_AUTO_SCENE);
          if (isOn) { sceneBadge.style.display = ''; sceneBadge.textContent = AutoScene.getSceneTypeName?.() || ''; }
          else { sceneBadge.style.display = 'none'; sceneBadge.textContent = ''; }
        }
        w.append(
          h('div', { class: 'row' },
            h('label', {}, '자동 보정 ', sceneBadge),
            mkToggle(P.APP_AUTO_SCENE, v => { if (v) AutoScene.start(); else AutoScene.stop(); updateSceneBadge(); ApplyReq.hard(); }))
        );
        Bus.on('signal', updateSceneBadge); syncFns.push(updateSceneBadge); updateSceneBadge();
        w.append(mkSep());
        const arrSpan = h('span', { class: 'arr' }, '▶');
        const advHd = h('div', { class: 'adv-hd' }, arrSpan, ' 고급 설정');
        const advBd = h('div', { class: 'adv-bd' });
        advHd.addEventListener('click', () => { advancedOpen = !advancedOpen; arrSpan.classList.toggle('open', advancedOpen); advBd.classList.toggle('open', advancedOpen); }, { signal: sig });
        w.append(advHd, advBd);
        return w;
      }

      function buildAudioTab() {
        const w = h('div', {});
        w.append(mkRow('오디오 부스트', mkToggle(P.A_EN, () => ApplyReq.soft())), mkRow('부스트 (dB)', ...mkSlider(P.A_BST, 0, 12, 0.5)));
        const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0' }, '오디오: 대기');
        w.append(mkSep(), status);
        Bus.on('signal', () => { status.textContent = `오디오: ${Audio.hasCtx() ? (Audio.isHooked() ? '활성' : '준비') : '대기'}`; });
        return w;
      }

      function buildPlaybackTab() {
        const w = h('div', {});
        w.append(mkRow('속도 제어', mkToggle(P.PB_EN, () => ApplyReq.hard())));
        const rateDisplay = h('div', { class: 'rate-display' });
        function syncRateDisplay() { const r = Number(Store.get(P.PB_RATE)) || 1; rateDisplay.textContent = `${r.toFixed(2)}×`; }
        syncFns.push(syncRateDisplay); syncRateDisplay();
        w.append(rateDisplay);
        const presets = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0];
        const chipRow = h('div', { class: 'chips' });
        function syncChips() {
          const cur = Number(Store.get(P.PB_RATE)) || 1;
          for (const c of chipRow.children) { const cv = parseFloat(c.dataset.v); c.classList.toggle('on', Math.abs(cur - cv) < 0.01); }
        }
        for (const p of presets) {
          const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`);
          el.addEventListener('click', () => { Store.set(P.PB_RATE, p); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); syncRateDisplay(); syncChips(); }, { signal: sig });
          chipRow.appendChild(el);
        }
        syncFns.push(syncChips); syncChips();
        w.append(chipRow);
        const fineRow = h('div', { class: 'fine-row' });
        const adjustRate = (delta) => {
          const cur = Number(Store.get(P.PB_RATE)) || 1;
          const nv = VSC_CLAMP(cur + delta, 0.07, 16);
          Store.set(P.PB_RATE, nv);
          if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true);
          ApplyReq.hard(); syncRateDisplay(); syncChips();
        };
        const fineSteps = [{ label: '−0.25', delta: -0.25 }, { label: '−0.05', delta: -0.05 }, { label: '+0.05', delta: +0.05 }, { label: '+0.25', delta: +0.25 }];
        for (const fs of fineSteps) {
          const btn = h('button', { class: 'fine-btn' }, fs.label);
          btn.addEventListener('click', () => adjustRate(fs.delta), { signal: sig });
          fineRow.appendChild(btn);
        }
        w.append(fineRow);
        w.append(mkRow('속도 슬라이더', ...mkSlider(P.PB_RATE, 0.07, 4, 0.01)));
        w.append(h('div', { style: 'font-size:10px;opacity:.4;text-align:center;padding:4px 0' }, '단축키: [ ] 속도 ±0.1'));
        Store.sub(P.PB_RATE, () => { syncRateDisplay(); syncChips(); });
        return w;
      }

      function buildAppTab() {
        const w = h('div', {});
        w.append(mkRow('모든 영상 적용', mkToggle(P.APP_APPLY_ALL, () => ApplyReq.hard())));
        w.append(mkSep(), h('label', { style: 'font-size:12px;opacity:.8;display:block;padding:4px 0' }, '프리셋 슬롯'));
        const slotsRow = h('div', { style: 'display:flex;gap:6px;padding:4px 0' });
        for (let i = 0; i < 3; i++) {
          const saveBtn = h('button', { class: 'btn', style: 'font-size:10px;padding:3px 8px' }, `저장 ${i + 1}`);
          const loadBtn = h('button', { class: 'btn pr', style: 'font-size:10px;padding:3px 8px' }, `불러오기 ${i + 1}`);
          saveBtn.addEventListener('click', () => saveSlot(i), { signal: sig });
          loadBtn.addEventListener('click', () => { loadSlot(i); syncAll(); }, { signal: sig });
          slotsRow.append(h('div', { style: 'display:flex;flex-direction:column;gap:3px' }, saveBtn, loadBtn));
        }
        w.append(slotsRow, mkSep());
        const expBtn = h('button', { class: 'btn' }, '내보내기');
        const impBtn = h('button', { class: 'btn' }, '가져오기');
        const rstBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '전체 초기화');
        expBtn.addEventListener('click', doExport, { signal: sig });
        impBtn.addEventListener('click', doImport, { signal: sig });
        rstBtn.addEventListener('click', () => { resetDefaults(); syncAll(); ApplyReq.hard(); persistNow(); showOSD('설정이 초기화되었습니다', 1500); }, { signal: sig });
        w.append(h('div', { style: 'display:flex;gap:6px;padding:4px 0' }, expBtn, impBtn, rstBtn));
        w.append(mkSep());
        const shortcutArrSpan = h('span', { class: 'arr' }, '▶');
        const shortcutHd = h('div', { class: 'adv-hd' }, shortcutArrSpan, ' 단축키 안내');
        const shortcutBd = h('div', { class: 'adv-bd' });
        let shortcutOpen = false;
        shortcutHd.addEventListener('click', () => { shortcutOpen = !shortcutOpen; shortcutArrSpan.classList.toggle('open', shortcutOpen); shortcutBd.classList.toggle('open', shortcutOpen); }, { signal: sig });
        const shortcuts = [
          ['Alt + V', '설정 패널 열기/닫기'], ['Alt + P', 'PiP 전환'], ['Alt + M', '최대화 토글'],
          ['Alt + Z', '줌 ON/OFF 토글'], ['Alt + A', '자동 보정 ON/OFF'], ['Alt + S', '프레임 캡처'],
          ['Alt + 0', '줌 리셋'], ['Alt + 1~3', '프리셋 슬롯 불러오기'], ['Shift + Alt + 1~3', '프리셋 슬롯 저장'],
          ['Alt + R', '전체 초기화'], ['[ / ]', '재생 속도 ±0.1'], ['Esc', '패널 닫기 / 최대화 해제'],
          ['Alt + Wheel', '줌 확대/축소 (줌 ON 시)'], ['Alt + 드래그', '줌 팬 이동 (줌 ON 시)'],
          ['Alt + 더블클릭', '줌 2.5× / 리셋 토글']
        ];
        const grid = h('div', { class: 'shortcut-grid' });
        for (const [key, desc] of shortcuts) { grid.append(h('span', { class: 'sk' }, key), h('span', { class: 'sd' }, desc)); }
        shortcutBd.appendChild(grid);
        w.append(shortcutHd, shortcutBd);
        w.append(mkSep(), h('div', { style: 'font-size:10px;opacity:.35;padding:2px 0' }, `Video_Control v${VSC_VERSION}`));
        return w;
      }

      function syncAll() { for (const fn of syncFns) { try { fn(); } catch (_) {} } }

      function renderTab() {
        const body = _shadow?.querySelector('.body'); if (!body) return;
        body.innerHTML = ''; syncFns.length = 0;
        switch (activeTab) {
          case 'video': body.appendChild(buildVideoTab()); break;
          case 'audio': body.appendChild(buildAudioTab()); break;
          case 'playback': body.appendChild(buildPlaybackTab()); break;
          case 'app': body.appendChild(buildAppTab()); break;
        }
      }

      const TAB_LABELS = { video: '영상', audio: '오디오', playback: '재생', app: '설정' };

      function switchTab(t) {
        activeTab = t;
        if (_shadow) _shadow.querySelectorAll('.tab').forEach(el => el.classList.toggle('on', el.dataset.t === t));
        renderTab();
      }

      function hasAnyVideo() { if (Registry.videos.size > 0) return true; try { return document.querySelector('video') !== null; } catch (_) { return false; } }

      function updateQuickBarVisibility() {
        if (!quickBarHost) return;
        const has = hasAnyVideo();
        if (has && !qbarVisible) { quickBarHost.style.display = ''; qbarVisible = true; }
        else if (!has && qbarVisible) { quickBarHost.style.display = 'none'; qbarVisible = false; if (panelOpen) togglePanel(false); }
      }

      function reparentForFullscreen() {
        if (!quickBarHost) return;
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const targetParent = fsEl || document.body || document.documentElement;
        if (!targetParent) return;
        if (quickBarHost.parentNode !== targetParent) { try { targetParent.appendChild(quickBarHost); } catch (_) {} }
        if (panelHost && panelHost.parentNode !== targetParent) { try { targetParent.appendChild(panelHost); } catch (_) {} }
      }

      function positionPanel() {
        if (!panelEl) return;
        let anchorY = window.innerHeight / 2;
        if (_qbarShadow) { try { const qbar = _qbarShadow.querySelector('.qbar'); if (qbar) { const qr = qbar.getBoundingClientRect(); anchorY = qr.top + qr.height / 2; } } catch (_) {} }
        const panelH = panelEl.offsetHeight || 450, vh = window.innerHeight, margin = 10;
        let top = anchorY - panelH / 2;
        top = Math.max(margin, Math.min(top, vh - margin - panelH));
        panelEl.style.top = `${Math.round(top)}px`;
      }

      function buildPanel() {
        if (panelHost) return;
        panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host' });
        _shadow = panelHost.attachShadow({ mode: 'closed' });
        _shadow.appendChild(h('style', {}, PANEL_CSS));
        panelEl = h('div', { class: 'panel' });
        const closeBtn = h('button', { class: 'btn', style: 'padding:2px 8px;font-size:12px' }, '✕');
        closeBtn.addEventListener('click', () => togglePanel(false), { signal: sig });
        panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), h('span', { class: 'ver' }, `v${VSC_VERSION}`), closeBtn));
        const tabBar = h('div', { class: 'tabs' });
        for (const t of ['video', 'audio', 'playback', 'app']) {
          const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t }, TAB_LABELS[t]);
          tab.addEventListener('click', () => switchTab(t), { signal: sig });
          tabBar.appendChild(tab);
        }
        panelEl.appendChild(tabBar);
        panelEl.appendChild(h('div', { class: 'body' }));
        _shadow.appendChild(panelEl);
        renderTab();
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        (fsEl || document.documentElement || document.body).appendChild(panelHost);
        blockInterference(panelHost);
      }

      /* v200: QuickBar uses SVG DOM icon builders — no innerHTML */
      function buildQuickBar() {
        if (quickBarHost) return;
        quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: 'all:initial; position:fixed; top:0; left:0; width:0; height:0; z-index:2147483647 !important; pointer-events:none; display:none;' });
        qbarVisible = false;
        const sh = quickBarHost.attachShadow({ mode: 'closed' });
        _qbarShadow = sh;
        sh.appendChild(h('style', {}, PANEL_CSS));
        const bar = h('div', { class: 'qbar' });

        const makeIcon = (name) => {
          const builder = VSC_ICON_BUILDERS[name];
          if (!builder) return document.createTextNode('');
          const svg = builder(18);
          svg.style.display = 'block';
          svg.style.pointerEvents = 'none';
          return svg;
        };

        const qb = (iconName, title, fn) => {
          const b = h('div', { class: 'qb', title });
          b.appendChild(makeIcon(iconName));
          b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); }, { signal: sig });
          return b;
        };

        let zoomBtnEl = null;
        if (ZoomMgr) {
          zoomBtnEl = h('div', { class: 'qb', title: '줌 ON/OFF (Alt+Z)' });
          zoomBtnEl.appendChild(makeIcon('zoom'));
          const syncZoomStyle = () => {
            const en = !!Store.get(P.APP_ZOOM_EN);
            zoomBtnEl.style.background = en ? 'rgba(110,168,254,.35)' : '';
            zoomBtnEl.style.borderColor = en ? 'rgba(110,168,254,.5)' : '';
          };
          zoomBtnEl.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const wasOn = !!Store.get(P.APP_ZOOM_EN);
            if (wasOn) {
              Store.set(P.APP_ZOOM_EN, false);
              const v = window[VSC_INTERNAL_SYM]._activeVideo;
              if (v) ZoomMgr.resetZoom(v);
              showOSD('줌 OFF', 900);
            } else {
              Store.set(P.APP_ZOOM_EN, true);
              showOSD('줌 ON (Alt+Wheel 확대, Alt+드래그 이동)', 1500);
            }
            syncZoomStyle(); ApplyReq.soft(); persistNow();
          }, { signal: sig });
          Store.sub(P.APP_ZOOM_EN, syncZoomStyle);
          syncZoomStyle();
        }

        bar.append(
          qb('gear', '설정', () => togglePanel()),
          qb('pip', 'PiP 전환', () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) togglePiPFor(v); }),
          qb('maximize', '최대화', () => Maximizer.toggle()),
          ...(zoomBtnEl ? [zoomBtnEl] : []),
          qb('camera', '프레임 캡처', () => { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) captureVideoFrame(v); })
        );

        sh.appendChild(bar);
        const mount = () => (document.body || document.documentElement).appendChild(quickBarHost);
        if (document.body) mount(); else window.addEventListener('DOMContentLoaded', mount, { once: true });
      }

      function togglePanel(force) {
        const show = (force !== undefined) ? force : !panelOpen;
        if (show) {
          buildPanel(); reparentForFullscreen();
          if (panelHost) panelHost.style.pointerEvents = '';
          requestAnimationFrame(() => { positionPanel(); requestAnimationFrame(() => { panelEl?.classList.add('open'); requestAnimationFrame(() => positionPanel()); }); });
        } else {
          panelEl?.classList.remove('open');
          if (panelHost) {
            setTimer(() => { if (!panelOpen && panelHost) { panelHost.style.pointerEvents = 'none'; } }, 250);
          }
        }
        panelOpen = show; Store.set(P.APP_UI, show);
      }

      function init() {
        buildQuickBar();
        Store.sub('video.*', syncAll);
        Store.sub('audio.*', syncAll);
        Store.sub('playback.*', syncAll);
        Store.sub('app.*', syncAll);
        setRecurring(updateQuickBarVisibility, 1500, { maxErrors: 50 });
        Bus.on('signal', updateQuickBarVisibility);
        onDoc('fullscreenchange', reparentForFullscreen);
        onDoc('webkitfullscreenchange', reparentForFullscreen);
        updateQuickBarVisibility();
      }

      function destroy() {
        uiAC.abort();
        panelHost?.remove(); quickBarHost?.remove();
        panelHost = null; panelEl = null; quickBarHost = null;
        _shadow = null; _qbarShadow = null; syncFns.length = 0; qbarVisible = false;
      }

      return Object.freeze({ init, destroy, togglePanel, syncAll, switchTab });
    }

    /* ══════════════════════════════════════════════════════════════════
       Save / Restore / Reset / Import / Export
       ══════════════════════════════════════════════════════════════════ */
    function buildSaveDataFrom(sm) {
      return { version: VSC_VERSION, video: { ...sm.getCatRef('video') }, audio: { ...sm.getCatRef('audio') }, playback: { ...sm.getCatRef('playback') }, app: { ...sm.getCatRef('app') } };
    }

    function restoreData(sm, data) {
      if (!data) return;
      if (data.video) sm.batch('video', data.video);
      if (data.audio) sm.batch('audio', data.audio);
      if (data.playback) sm.batch('playback', data.playback);
      if (data.app) { const { slots, ...rest } = data.app; sm.batch('app', rest); if (Array.isArray(slots)) sm.set('app.slots', slots); }
      normalizeBySchema(sm, ALL_SCHEMAS);
    }

    let __Store = null, __ApplyReq = null;

    function resetDefaults() {
      if (!__Store) return;
      const d = typeof structuredClone === 'function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS));
      for (const [cat, vals] of Object.entries(d)) __Store.batch(cat, vals);
    }

    function saveSlot(idx) {
      if (!__Store) return;
      const data = buildSaveDataFrom(__Store);
      const slots = [...(__Store.getCatRef('app').slots || [null, null, null])];
      slots[idx] = data; __Store.set('app.slots', slots);
      persistNow(); showOSD(`슬롯 ${idx + 1} 저장됨`, 1200);
    }

    function loadSlot(idx) {
      if (!__Store) return;
      const slots = __Store.getCatRef('app').slots || [null, null, null];
      const data = slots[idx];
      if (!data) { showOSD(`슬롯 ${idx + 1} 비어있음`, 1000); return; }
      restoreData(__Store, data); __ApplyReq?.hard(); persistNow();
      showOSD(`슬롯 ${idx + 1} 불러옴`, 1200);
    }

    function doExport() {
      if (!__Store) return;
      const json = JSON.stringify(buildSaveDataFrom(__Store), null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `vsc-settings-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimer(() => URL.revokeObjectURL(url), 3000);
      showOSD('설정 내보내기 완료', 1200);
    }

    function doImport() {
      if (!__Store) return;
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'; inp.style.display = 'none';
      inp.addEventListener('change', () => {
        const f = inp.files?.[0]; if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { try { const data = JSON.parse(rd.result); restoreData(__Store, data); __ApplyReq?.hard(); persistNow(); showOSD('설정 가져오기 완료', 1200); } catch (e) { showOSD('가져오기 실패', 1500); log.warn('Import error', e); } };
        rd.readAsText(f);
      });
      document.body.appendChild(inp); inp.click(); inp.remove();
    }

    /* ── Persistence ── */
    let __persistTimer = 0;

    function persistNow() {
      if (!__Store) return;
      clearTimer(__persistTimer);
      __persistTimer = setTimer(() => { try { GM_setValue(STORAGE_KEY, JSON.stringify(buildSaveDataFrom(__Store))); log.debug('[Persist] saved', STORAGE_KEY); } catch (e) { log.warn('[Persist] save error', e); } }, 600);
    }

    function loadPersisted(sm) {
      try { const raw = GM_getValue(STORAGE_KEY, null); if (!raw) return; const data = (typeof raw === 'string') ? JSON.parse(raw) : raw; restoreData(sm, data); log.info('[Persist] loaded', STORAGE_KEY); }
      catch (e) { log.warn('[Persist] load error', e); }
    }

    /* ══════════════════════════════════════════════════════════════════
       bindVideoOnce (v200: per-video AbortController + EME hooks)
       ══════════════════════════════════════════════════════════════════ */
    function bindVideoOnce(video, Store, Registry, AutoScene, ApplyReq, ZoomMgr) {
      const st = getVState(video);
      if (st.bound) return;
      st.bound = true;

      const videoAC = new AbortController();
      const videoSig = combineSignals(__globalSig, videoAC.signal);
      st._ac = videoAC;

      touchedAddLimited(TOUCHED.videos, video, (evicted) => {
        const es = getVState(evicted);
        if (es._ac) { es._ac.abort(); es._ac = null; es.bound = false; }
      });

      on(video, 'resize', () => { st._resizeDirty = true; }, { signal: videoSig });

      const onVideoReady = () => { st._resizeDirty = true; ApplyReq.hard(); };
      on(video, 'loadedmetadata', onVideoReady, { signal: videoSig });
      on(video, 'loadeddata', onVideoReady, { signal: videoSig });
      if (video.readyState >= 1) setTimer(() => { if (!videoSig.aborted) ApplyReq.hard(); }, 80);

      /* v200: EME encrypted event detection */
      on(video, 'encrypted', () => {
        __encryptedVideos.add(video);
        const rs = getRateState(video);
        if (rs.orig != null) {
          rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
          try { video.playbackRate = rs.orig; } catch (_) {}
        }
        rs.permanentlyBlocked = true;
        log.info('[DRM] encrypted event detected, rate control blocked for this video');
      }, { signal: videoSig, once: true });

      on(video, 'waitingforkey', () => {
        __encryptedVideos.add(video);
        const rs = getRateState(video);
        if (!rs.permanentlyBlocked) {
          rs.permanentlyBlocked = true;
          if (rs.orig != null) {
            rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
            try { video.playbackRate = rs.orig; } catch (_) {}
          }
          log.info('[DRM] waitingforkey detected, rate control blocked');
        }
      }, { signal: videoSig });

      /* v200: ratechange with EME-aware DRM guard */
      on(video, 'ratechange', () => {
        if (!Store.get(P.PB_EN)) return;
        const expected = Number(Store.get(P.PB_RATE));
        if (!Number.isFinite(expected)) return;
        if (Math.abs(video.playbackRate - expected) < 0.002) { st.rateState._rateRetryCount = 0; return; }
        const now = performance.now();
        if (now < st.rateState.suppressSyncUntil) return;
        if (__rateBlockedSite || isVideoEncrypted(video)) {
          st.rateState.permanentlyBlocked = true;
          if (st.rateState.orig != null) {
            st.rateState.suppressSyncUntil = now + RATE_SUPPRESS_MS;
            try { video.playbackRate = st.rateState.orig; } catch (_) {}
          }
          log.info('[DRM] rate change blocked (host/EME)');
          return;
        }
        st.rateState._totalRetries++;
        if (st.rateState._totalRetries > RATE_SESSION_MAX) {
          st.rateState.permanentlyBlocked = true;
          log.warn('[RateGuard] session max — possible DRM or site interference');
          showOSD('속도 제어: 이 사이트에서 차단됨', 2000);
          return;
        }
        st.rateState._rateRetryCount++;
        if (st.rateState._rateRetryCount > RATE_MAX_RETRY) {
          st.rateState.permanentlyBlocked = true;
          log.warn('[RateGuard] retry max');
          return;
        }
        const delay = Math.min(RATE_BACKOFF_BASE * (1 << (st.rateState._rateRetryCount - 1)), RATE_BACKOFF_MAX);
        setTimer(() => {
          if (!video.isConnected || st.rateState.permanentlyBlocked || videoSig.aborted) return;
          if (isVideoEncrypted(video)) { st.rateState.permanentlyBlocked = true; return; }
          st.rateState.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
          try { video.playbackRate = expected; } catch (_) {}
        }, delay);
      }, { signal: videoSig });

      on(video, 'play', () => ApplyReq.soft(), { signal: videoSig });
      on(video, 'pause', () => ApplyReq.soft(), { signal: videoSig });
      if (ZoomMgr) ZoomMgr.onNewVideoForZoom(video);
      patchFullscreenRequest(video);

      videoSig.addEventListener('abort', () => {
        st.bound = false;
        st.resetTransient();
        log.debug('[bindVideo] unbound', video.src?.slice(0, 40) || '(blob)');
      }, { once: true });

      log.debug('[bindVideo]', video.src?.slice(0, 60) || '(blob)');
    }

    /* ══════════════════════════════════════════════════════════════════
       createApplyLoop (v200: EME-aware rate control)
       ══════════════════════════════════════════════════════════════════ */
    function createApplyLoop(Store, Scheduler, Registry, TargetingMod, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq) {
      const __lastUserPt = { x: 0, y: 0, t: 0 };
      onWin('pointermove', e => { __lastUserPt.x = e.clientX; __lastUserPt.y = e.clientY; __lastUserPt.t = performance.now(); }, { passive: true });
      onWin('touchstart', e => { if (e.touches.length > 0) { __lastUserPt.x = e.touches[0].clientX; __lastUserPt.y = e.touches[0].clientY; __lastUserPt.t = performance.now(); } }, { passive: true });

      let prevTarget = null;
      setRecurring(() => {
        Registry.prune();
        for (const key of ['videos', 'rateVideos']) {
          for (const v of TOUCHED[key]) { if (!v.isConnected) TOUCHED[key].delete(v); }
        }
      }, 4000, { maxErrors: 50 });

      function restoreRate(video) {
        const rs = getRateState(video);
        if (rs.orig != null && Math.abs(video.playbackRate - (rs.orig || 1)) > 0.002) {
          rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
          try { video.playbackRate = rs.orig || 1; } catch (_) {}
        }
        rs.orig = null; rs._rateRetryCount = 0; rs._totalRetries = 0; rs.permanentlyBlocked = false;
      }

      function apply(forceApply) {
        if (__globalSig.aborted) return;
        const applyAll = !!Store.get(P.APP_APPLY_ALL);

        if (!Store.get(P.APP_ACT)) {
          if (prevTarget) { FiltersVO.clear(prevTarget); prevTarget = null; }
          for (const v of TOUCHED.rateVideos) { if (v.isConnected) restoreRate(v); }
          return;
        }

        const audioBoostOn = !!Store.get(P.A_EN);
        const { target } = TargetingMod.pickFastActiveOnly(Registry.visible.videos, __lastUserPt, audioBoostOn);

        if (!target && !applyAll) return;

        if (target !== prevTarget || forceApply) {
          if (prevTarget && prevTarget !== target) FiltersVO.clear(prevTarget);
          prevTarget = target;
          window[VSC_INTERNAL_SYM]._activeVideo = target;
          Audio.setTarget(target);
        }

        const vfUser = Store.getCatRef('video');
        const pbEn = !!Store.get(P.PB_EN);
        const pbRate = Number(Store.get(P.PB_RATE));

        const targets = new Set();
        if (target) targets.add(target);
        if (applyAll) {
          for (const v of Registry.visible.videos) { if (v.isConnected) targets.add(v); }
        }

        for (const v of targets) {
          if (pbEn && Number.isFinite(pbRate) && pbRate > 0) {
            const rs = getRateState(v);
            if (!rs.permanentlyBlocked) {
              if (rs.orig == null) rs.orig = v.playbackRate;
              if (Math.abs(v.playbackRate - pbRate) > 0.002) {
                if (rs._totalRetries >= RATE_SESSION_MAX) {
                  rs.permanentlyBlocked = true;
                } else if (isVideoEncrypted(v)) {
                  rs.permanentlyBlocked = true;
                  if (rs.orig != null) {
                    rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
                    try { v.playbackRate = rs.orig; } catch (_) {}
                  }
                } else {
                  rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
                  try { v.playbackRate = pbRate; rs._rateRetryCount = 0; }
                  catch (_) { rs._rateRetryCount++; rs._totalRetries++; rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; }
                }
                touchedAddLimited(TOUCHED.rateVideos, v);
              }
            }
          } else {
            restoreRate(v);
          }

          const params = ParamsMemo.get(vfUser, v);
          if (!params || isNeutralVideoParams(params)) { FiltersVO.clear(v); }
          else { const filterResult = FiltersVO.prepareCached(v, params); FiltersVO.applyFilter(v, filterResult); }
          touchedAddLimited(TOUCHED.videos, v);
        }
      }

      Scheduler.registerApply(apply);
      return { apply };
    }

    /* ══════════════════════════════════════════════════════════════════
       createKeyboard
       ══════════════════════════════════════════════════════════════════ */
    function createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr) {
      const STEP_RATE = 0.1;
      onDoc('keydown', e => {
        if (isEditableTarget(e.target)) return;
        const k = e.key, shift = e.shiftKey, alt = e.altKey;
        if (k === 'Escape') { UI?.togglePanel(false); Maximizer?.isActive() && Maximizer.undoMaximize(); e.preventDefault(); return; }
        if (alt && k === 'v') { UI?.togglePanel(); e.preventDefault(); return; }
        if (alt && k === 'p') { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) togglePiPFor(v); e.preventDefault(); return; }
        if (alt && (k === 'm' || k === 'M')) { Maximizer?.toggle(); e.preventDefault(); return; }
        if (alt && k === 'a') {
          const nv = !Store.get(P.APP_AUTO_SCENE); Store.set(P.APP_AUTO_SCENE, nv);
          if (nv) AutoScene.start(); else AutoScene.stop();
          ApplyReq.hard(); persistNow();
          showOSD(`자동 보정: ${nv ? '켜짐' : '꺼짐'}`, 1000);
          e.preventDefault(); return;
        }
        if (alt && k === 's') { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v) captureVideoFrame(v); e.preventDefault(); return; }
        if (alt && k === '0') { const v = window[VSC_INTERNAL_SYM]._activeVideo; if (v && ZoomMgr) ZoomMgr.resetZoom(v); e.preventDefault(); return; }
        if (alt && (k === 'z' || k === 'Z')) {
          if (!ZoomMgr) return;
          const wasOn = !!Store.get(P.APP_ZOOM_EN);
          if (wasOn) {
            Store.set(P.APP_ZOOM_EN, false);
            const v = window[VSC_INTERNAL_SYM]._activeVideo;
            if (v) ZoomMgr.resetZoom(v);
            showOSD('줌 OFF', 900);
          } else {
            Store.set(P.APP_ZOOM_EN, true);
            showOSD('줌 ON', 900);
          }
          ApplyReq.soft(); persistNow(); UI?.syncAll();
          e.preventDefault(); return;
        }
        if (alt && k === 'r') { resetDefaults(); ApplyReq.hard(); persistNow(); UI?.syncAll(); showOSD('초기화 완료', 1000); e.preventDefault(); return; }
        if (alt && k >= '1' && k <= '3') { const idx = parseInt(k) - 1; if (shift) saveSlot(idx); else loadSlot(idx); UI?.syncAll(); e.preventDefault(); return; }
        if (k === '[' || k === ']') {
          const cur = Number(Store.get(P.PB_RATE)) || 1;
          const nv = VSC_CLAMP(cur + (k === ']' ? STEP_RATE : -STEP_RATE), 0.07, 16);
          Store.set(P.PB_RATE, nv);
          if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true);
          ApplyReq.hard(); persistNow(); UI?.syncAll();
          showOSD(`속도: ${nv.toFixed(2)}×`, 900);
          e.preventDefault(); return;
        }
      }, { signal: __globalSig, capture: true });
    }

    /* ══════════════════════════════════════════════════════════════════
       BOOTSTRAP (v200: FeatureRegistry wiring)
       ══════════════════════════════════════════════════════════════════ */
    function bootstrap() {
      log.info(`[VSC] v${VSC_VERSION} booting on ${location.hostname}`);

      const FeatReg = createFeatureRegistry(__globalSig);

      FeatReg.register('Utils', () => createUtils());
      FeatReg.register('Scheduler', () => createScheduler());
      FeatReg.register('Store', (deps) => {
        const store = createLocalStore(DEFAULTS, deps.Scheduler, deps.Utils);
        loadPersisted(store);
        return store;
      }, ['Utils', 'Scheduler']);
      FeatReg.register('Bus', () => createEventBus());
      FeatReg.register('ApplyReq', (deps) => createApplyRequester(deps.Bus, deps.Scheduler), ['Bus', 'Scheduler']);
      FeatReg.register('Registry', (deps) => createRegistry(deps.Scheduler), ['Scheduler']);
      FeatReg.register('Targeting', () => createTargeting());
      FeatReg.register('Audio', (deps) => createAudio(deps.Store), ['Store']);
      FeatReg.register('AutoScene', (deps) => createAutoSceneManager(deps.Store, P, deps.Scheduler), ['Store', 'Scheduler']);
      FeatReg.register('ParamsMemo', (deps) => createVideoParamsMemo(deps.Store, P, deps.Utils), ['Store', 'Utils']);
      FeatReg.register('FiltersVO', (deps) => createFiltersVideoOnly(deps.Utils, CONFIG), ['Utils']);
      FeatReg.register('Maximizer', (deps) => createVideoMaximizer(deps.Store, deps.ApplyReq), ['Store', 'ApplyReq']);
      FeatReg.register('ZoomMgr', () => FEATURE_FLAGS.zoomFeature ? createZoomManager() : null);

      const moduleNames = ['Utils', 'Scheduler', 'Store', 'Bus', 'ApplyReq', 'Registry', 'Targeting', 'Audio', 'AutoScene', 'ParamsMemo', 'FiltersVO', 'Maximizer', 'ZoomMgr'];
      for (const name of moduleNames) FeatReg.resolve(name);

      const Store = FeatReg.get('Store');
      const Scheduler = FeatReg.get('Scheduler');
      const Bus = FeatReg.get('Bus');
      const ApplyReq = FeatReg.get('ApplyReq');
      const Registry = FeatReg.get('Registry');
      const Targeting = FeatReg.get('Targeting');
      const Audio = FeatReg.get('Audio');
      const AutoScene = FeatReg.get('AutoScene');
      const ParamsMemo = FeatReg.get('ParamsMemo');
      const FiltersVO = FeatReg.get('FiltersVO');
      const Maximizer = FeatReg.get('Maximizer');
      const ZoomMgr = FeatReg.get('ZoomMgr');

      window[VSC_INTERNAL_SYM].Store = Store;
      window[VSC_INTERNAL_SYM].ApplyReq = ApplyReq;
      window[VSC_INTERNAL_SYM].AutoScene = AutoScene;
      window[VSC_INTERNAL_SYM].ZoomManager = ZoomMgr;
      __Store = Store; __ApplyReq = ApplyReq;

      Bus.on('signal', (p) => Scheduler.request(!!p?.forceApply));

      const __persistSubCategories = ['video.*', 'audio.*', 'playback.*', 'app.*'];
      for (const cat of __persistSubCategories) { Store.sub(cat, () => persistNow()); }

      createApplyLoop(Store, Scheduler, Registry, Targeting, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq);

      Store.sub(P.PB_RATE, () => {
        for (const v of TOUCHED.rateVideos) {
          const rs = getRateState(v);
          if (!isVideoEncrypted(v)) {
            rs.permanentlyBlocked = false;
            rs._rateRetryCount = 0;
            rs._totalRetries = 0;
          }
        }
      });

      Store.sub(P.PB_EN, (enabled) => {
        if (!enabled) {
          for (const v of TOUCHED.rateVideos) {
            const rs = getRateState(v);
            if (rs.orig != null && v.isConnected) {
              rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS;
              try { v.playbackRate = rs.orig; } catch (_) {}
            }
            rs.orig = null;
            rs.permanentlyBlocked = false;
            rs._rateRetryCount = 0;
            rs._totalRetries = 0;
          }
        }
      });

      const processVideo = (v) => bindVideoOnce(v, Store, Registry, AutoScene, ApplyReq, ZoomMgr);
      const scanAll = () => { for (const v of document.querySelectorAll('video')) processVideo(v); };
      const rescanDebounced = createDebounced(() => {
        scanAll(); Registry.rescanAll(); ApplyReq.hard();
        const wasBlocked = __rateBlockedSite;
        __rateBlockedSite = isRateBlockedContext();
        if (wasBlocked && !__rateBlockedSite) {
          for (const v of TOUCHED.rateVideos) {
            const rs = getRateState(v);
            if (rs.permanentlyBlocked && !isVideoEncrypted(v)) {
              rs.permanentlyBlocked = false; rs._rateRetryCount = 0; rs._totalRetries = 0;
            }
          }
        }
      }, SPA_RESCAN_DEBOUNCE_MS);
      initSpaUrlDetector(rescanDebounced);
      setRecurring(() => { for (const v of Registry.videos) { if (v.isConnected && !getVState(v).bound) processVideo(v); } }, 800, { maxErrors: 50 });

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { scanAll(); Scheduler.request(true); }, { once: true, signal: __globalSig });
      } else { scanAll(); Scheduler.request(true); }

      setTimer(() => {
        if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) AutoScene.start();
      }, 300);

      const UI = createUI(Store, Bus, createUtils(), Audio, AutoScene, ZoomMgr, Targeting, Maximizer, FiltersVO, Registry, Scheduler, ApplyReq);
      window[VSC_INTERNAL_SYM]._uiEnsure = () => {};

      const waitForBody = () => {
        if (document.body) { UI.init(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); UI.init(); } });
        mo.observe(document.documentElement || document, { childList: true });
      };
      waitForBody();

      createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr);
      if (FEATURE_FLAGS.iframeInjection) watchIframes();

      window[VSC_APP_SYM] = { getActiveVideo: () => window[VSC_INTERNAL_SYM]._activeVideo };
      if (ZoomMgr) setRecurring(() => ZoomMgr.pruneDisconnected(), 5000, { maxErrors: 50 });

      onDoc('visibilitychange', () => { if (!document.hidden) { ApplyReq.soft(); } }, { passive: true });

      onDoc('fullscreenchange', () => {
        if (!document.fullscreenElement && __osdEl) {
          if (!__osdEl.isConnected) { clearTimer(__osdTimerId); __osdTimerId = 0; __osdEl = null; }
        }
        ApplyReq.soft(); UI.syncAll();
      });

      __globalSig.addEventListener('abort', () => {
        FeatReg.destroyAll();
        for (const v of TOUCHED.videos) FiltersVO.clear(v);
        for (const v of TOUCHED.rateVideos) {
          const rs = getRateState(v);
          if (rs.orig != null && v.isConnected) { try { v.playbackRate = rs.orig; } catch (_) {} }
        }
        clearTimer(__osdTimerId); __osdTimerId = 0;
        if (__osdEl?.isConnected) { try { __osdEl.remove(); } catch (_) {} }
        __osdEl = null;
        log.info('[VSC] destroyed');
      }, { once: true });

      try {
        GM_registerMenuCommand('VSC 패널 열기/닫기', () => UI.togglePanel());
        GM_registerMenuCommand('VSC 설정 초기화', () => { resetDefaults(); ApplyReq.hard(); persistNow(); UI.syncAll(); showOSD('초기화 완료', 1000); });
      } catch (_) {}

      log.info(`[VSC] v${VSC_VERSION} ready — ${Registry.videos.size} video(s)`);
    }

    /* ════════════════════════════════════════════════
       ENTRY POINT
       ════════════════════════════════════════════════ */
    try { bootstrap(); } catch (e) { console.error('[VSC] bootstrap error', e); }

  } // ← closes function VSC_MAIN()

  VSC_MAIN();
})();
