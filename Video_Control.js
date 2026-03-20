// ==UserScript==
// @name         Video_Control (v204.1.0-Hybrid)
// @namespace    https://github.com/
// @version      204.1.0-Hybrid
// @description  v204.1.0: 7 Intelligent AutoSense features (2D Adaptive Sharpening, Color Clipping Guard, Skin-Tone Protection, Auto Letterbox Zoom, Zonal Contrast Enhancement, Independent Parameter Interpolation, HDR Tone Mapping)
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

    /* ══ Symbol-based boot lock & namespace ══ */
    const VSC_SYM = Symbol.for('__VSC__');
    const VSC_BOOT_SYM = Symbol.for('__VSC_BOOT_LOCK__');
    const VSC_SPA_SYM = Symbol.for('__VSC_SPA_PATCHED__');
    const VSC_APP_SYM = Symbol.for('__VSC_APP__');
    const VSC_INTERNAL_SYM = Symbol.for('__VSC_INTERNAL__');
    const VSC_MANAGED_PROPS = Symbol.for('__VSC_MANAGED_PROPS__');

    if (window[VSC_BOOT_SYM]) return;
    try { Object.defineProperty(window, VSC_BOOT_SYM, { value: true, writable: false, configurable: false, enumerable: false }); }
    catch (e) { window[VSC_BOOT_SYM] = true; }

    if (!window[VSC_INTERNAL_SYM]) {
      try { Object.defineProperty(window, VSC_INTERNAL_SYM, { value: {}, writable: false, configurable: false, enumerable: false }); }
      catch (e) { window[VSC_INTERNAL_SYM] = {}; }
    }
    const __internal = window[VSC_INTERNAL_SYM];

    if (!window.__VSC_INTERNAL__) {
      try { Object.defineProperty(window, '__VSC_INTERNAL__', { get() { return window[VSC_INTERNAL_SYM]; }, configurable: true, enumerable: false }); }
      catch (_) { window.__VSC_INTERNAL__ = __internal; }
    }

    function isEditableTarget(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); }

    /* ══ Global AbortController ══ */
    const __globalHooksAC = new AbortController();
    const __globalSig = __globalHooksAC.signal;

    /* ══ Timer management ══ */
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
      let consecutiveErrors = 0, consecutiveSuccess = 0;
      const maxErrors = opts.maxErrors ?? 50, resetWindow = opts.resetWindow ?? 5;
      const id = setInterval(() => {
        if (__globalSig.aborted) { clearInterval(id); _activeIntervals.delete(id); return; }
        try {
          fn();
          consecutiveErrors = 0; consecutiveSuccess++;
          if (consecutiveSuccess >= resetWindow) consecutiveSuccess = resetWindow;
        } catch (_) {
          consecutiveSuccess = 0; consecutiveErrors = (consecutiveErrors | 0) + 1;
          if (consecutiveErrors >= maxErrors) {
            clearInterval(id); _activeIntervals.delete(id);
            try { opts.onKill?.(); } catch (__) {}
          }
        }
      }, ms);
      _activeIntervals.add(id);
      return id;
    };
    const clearRecurring = (id) => { if (!id) return; clearInterval(id); _activeIntervals.delete(id); };

    /* ══ Signal combinators ══ */
    const combineSignals = (...signals) => {
      const existing = signals.filter(Boolean);
      if (existing.length === 0) return undefined;
      if (existing.length === 1) return existing[0];
      return AbortSignal.any(existing);
    };

    /* ══ Event binding ══ */
    function on(target, type, fn, opts) {
      if (!target?.addEventListener) return;
      const o = opts ? { ...opts } : {};
      o.signal = o.signal ? combineSignals(o.signal, __globalSig) : __globalSig;
      if (o.signal?.aborted) return;
      target.addEventListener(type, fn, o);
    }
    const onWin = (type, fn, opts) => on(window, type, fn, opts);
    const onDoc = (type, fn, opts) => on(document, type, fn, opts);

    /* ══ Interference blocker ══ */
    const __blockedElements = new WeakSet();
    function blockInterference(el) {
      if (!el || __blockedElements.has(el)) return;
      __blockedElements.add(el);
      const stop = (e) => {
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        for (let i = 0, len = Math.min(path.length, 10); i < len; i++) {
          const n = path[i];
          if (n && n.nodeType === 1 && (n.tagName === 'BUTTON' || n.tagName === 'A' || n.getAttribute?.('role') === 'button')) return;
        }
        e.stopPropagation();
      };
      ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu'].forEach(ev => on(el, ev, stop, { passive: true }));
      on(el, 'wheel', (e) => { if (!e.altKey) e.stopPropagation(); }, { passive: true });
    }

    /* ══ Mobile detection ══ */
    const detectMobile = () => navigator.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(navigator.userAgent);

    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ''),
      DEBUG: false
    });
    const VSC_VERSION = '204.1.0-Hybrid';

    /* ══ Storage keys ══ */
    const STORAGE_KEY_BASE = 'vsc_v2_' + location.hostname;
    function getStorageKey() {
      const h = location.hostname;
      if (h.endsWith('youtube.com')) {
        if (location.pathname.startsWith('/shorts')) return STORAGE_KEY_BASE + '_shorts';
        if (location.pathname.startsWith('/watch')) return STORAGE_KEY_BASE + '_watch';
      }
      return STORAGE_KEY_BASE;
    }
    const STORAGE_KEY = getStorageKey();

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      if (Math.abs(t) < 0.001) return { rs: 1, gs: 1, bs: 1 };
      const r = 1 + 0.14 * t, g = 1 - 0.02 * Math.abs(t), b = 1 - 0.14 * t;
      const m = t > 0 ? r : b;
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    const VSC_DEFENSE = Object.freeze({ audioCooldown: true, autoSceneDrmBackoff: true });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true, gpuAnalysis: true, audioWorklet: true });
    const GUARD = Object.freeze({ AUDIO_SRC_COOLDOWN: 2000, AUDIO_SRC_COOLDOWN_DRM: 6000, TARGET_HYSTERESIS_MS: 350, TARGET_HYSTERESIS_MARGIN: 1.5 });
    const SHADOW_ROOT_LRU_MAX = 16;
    const SPA_RESCAN_DEBOUNCE_MS = 500;

    /* ══ DRM rate-control ══ */
    const RATE_MAX_RETRY = 4;
    const RATE_BACKOFF_BASE = 24;
    const RATE_BACKOFF_MAX = 512;
    const RATE_SESSION_MAX = 20;
    const RATE_SUPPRESS_MS = 600;

    /* ══ RATE_BLOCKED_HOSTS ══ */
    const RATE_BLOCKED_HOST_SET = new Set([
      'netflix.com', 'disneyplus.com', 'primevideo.com', 'hulu.com', 'max.com', 'peacocktv.com', 'paramountplus.com', 'crunchyroll.com',
      'apple.com', 'discoveryplus.com', 'britbox.com', 'stan.com.au', 'binge.com.au',
      'skygo.co.nz', 'now.com', 'hotstar.com', 'wavve.com', 'tving.com', 'coupangplay.com', 'watcha.com', 'serieson.naver.com', 'abema.tv',
      'unext.jp', 'fod.fujitv.co.jp', 'dmm.com', 'dazn.com', 'espnplus.com', 'fubo.tv'
    ]);
    const RATE_BLOCKED_PATHS = Object.freeze([{ host: 'amazon.com', pathPrefix: '/gp/video' }, { host: 'amazon.com', pathPrefix: '/Amazon-Video' }, { host: 'amazon.co.jp', pathPrefix: '/gp/video' }, { host: 'amazon.co.uk', pathPrefix: '/gp/video' }, { host: 'youtube.com', pathPrefix: '/paid' }, { host: 'naver.com', pathPrefix: '/serieson' }, { host: 'apple.com', pathPrefix: '/tv' }]);

    function isHostBlocked(hostname) {
      if (RATE_BLOCKED_HOST_SET.has(hostname)) return true;
      const dot = hostname.indexOf('.');
      if (dot > 0) {
        const parent = hostname.slice(dot + 1);
        if (RATE_BLOCKED_HOST_SET.has(parent)) return true;
        const dot2 = parent.indexOf('.');
        if (dot2 > 0 && RATE_BLOCKED_HOST_SET.has(parent.slice(dot2 + 1))) return true;
      }
      return false;
    }

    function isRateBlockedContext() {
      const h = location.hostname; const p = location.pathname;
      if (isHostBlocked(h)) return true;
      return RATE_BLOCKED_PATHS.some(rule => (h === rule.host || h.endsWith('.' + rule.host)) && p.startsWith(rule.pathPrefix));
    }

    let __rateBlockedSite = isRateBlockedContext();
    const __encryptedVideos = new WeakSet();
    function isVideoEncrypted(video) { try { if (video.mediaKeys) return true; } catch (_) {} return __encryptedVideos.has(video); }

    const log = {
      error: (...args) => console.error('[VSC]', ...args),
      warn: (...args) => CONFIG.DEBUG && console.warn('[VSC]', ...args),
      info: (...args) => CONFIG.DEBUG && console.info('[VSC]', ...args),
      debug: (...args) => CONFIG.DEBUG && console.debug('[VSC]', ...args)
    };

    /* ══ StyleGuard (Map-based) ══ */
    function vscSetStyle(el, prop, value, priority = 'important') {
      if (!el?.style) return;
      const managed = el[VSC_MANAGED_PROPS] ??= new Map();
      if (!managed.has(prop)) managed.set(prop, el.style.getPropertyValue(prop) || '');
      el.style.setProperty(prop, value, priority);
    }
    function vscRemoveStyle(el, prop) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed?.has(prop)) return;
      const saved = managed.get(prop);
      managed.delete(prop);
      if (saved) el.style.setProperty(prop, saved);
      else el.style.removeProperty(prop);
    }
    function vscClearAllStyles(el) {
      const managed = el?.[VSC_MANAGED_PROPS];
      if (!managed?.size) return;
      for (const [prop, saved] of managed) { if (saved) el.style.setProperty(prop, saved); else el.style.removeProperty(prop); }
      managed.clear();
    }
    function vscHasManagedStyles(el) { return !!(el?.[VSC_MANAGED_PROPS]?.size); }

    /* ══ Video State (class-based) ══ */
    class RateState {
      constructor() { this.orig = null; this.suppressSyncUntil = 0; this.permanentlyBlocked = false; this._rateRetryCount = 0; this._totalRetries = 0; }
    }

    class VideoState {
      constructor() {
        this.visible = false; this.rect = null; this.bound = false; this.audioFailUntil = 0;
        this.applied = false; this.desiredRate = undefined; this.lastFilterUrl = null;
        this.rectT = 0; this.rectEpoch = -1; this.fsPatched = false; this._resizeDirty = false;
        this._ac = null; this._inPiP = false; this.lastCssFilterStr = null; this._transitionCleared = false;
        this.__abCompare = false; this.__pipOrigComputed = null; this.__pipHadFilter = false;
        this.__pipSavedFilterStr = null; this.rateState = new RateState();
      }
      resetTransient() {
        this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
        this.desiredRate = undefined; Object.assign(this.rateState, new RateState());
      }
    }

    const videoStateMap = new WeakMap();
    function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = new VideoState(); videoStateMap.set(v, st); } return st; }
    function getRateState(v) { return getVState(v).rateState; }

    /* ══ Presets ══ */
    const PRESETS = Object.freeze({
      detail: {
        none: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'OFF' },
        off:  { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'AUTO' },
        S:    { sharpAdd: 16, sharp2Add: 4, clarityAdd: 5, label: '1단' },
        M:    { sharpAdd: 22, sharp2Add: 12, clarityAdd: 12, label: '2단' },
        L:    { sharpAdd: 26, sharp2Add: 24, clarityAdd: 20, label: '3단' },
        XL:   { sharpAdd: 32, sharp2Add: 22, clarityAdd: 26, label: '4단' }
      }
    });
    const getPresetLabel = (group, key) => PRESETS[group]?.[key]?.label || key;

    /* ══ Defaults & Paths (v204.0.0: 7 intelligent feature toggles added) ══ */
    const DEFAULTS = {
      video: { presetS: 'off', presetMix: 1.0, manualShadow: 0, manualRecovery: 0, manualBright: 0 },
      audio: { enabled: false, boost: 9 },
      playback: { rate: 1.0, enabled: false },
      app: {
        active: true, uiVisible: false, applyAll: false, zoomEn: false,
        autoScene: false, advanced: false, slots: [null, null, null], gpuEn: false,
        smartSharpEn: true,
        adaptSatEn: true,
        skinProtectEn: true,
        autoZoomEn: false,
        zonalContrastEn: true,
        smoothTransEn: true,
        hdrToneMapEn: false
      }
    };
    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll',
      APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced', APP_GPU_EN: 'app.gpuEn',
      V_PRE_S: 'video.presetS', V_PRE_MIX: 'video.presetMix',
      V_MAN_SHAD: 'video.manualShadow', V_MAN_REC: 'video.manualRecovery', V_MAN_BRT: 'video.manualBright',
      A_EN: 'audio.enabled', A_BST: 'audio.boost',
      PB_RATE: 'playback.rate', PB_EN: 'playback.enabled',
      APP_SMART_SHARP: 'app.smartSharpEn',
      APP_ADAPT_SAT: 'app.adaptSatEn',
      APP_SKIN_PROTECT: 'app.skinProtectEn',
      APP_AUTO_ZOOM: 'app.autoZoomEn',
      APP_ZONAL_CONTRAST: 'app.zonalContrastEn',
      APP_SMOOTH_TRANS: 'app.smoothTransEn',
      APP_HDR_TONEMAP: 'app.hdrToneMapEn'
    });

    /* ══ Schemas (v204.0.0: 7 intelligent feature toggles added) ══ */
    const APP_SCHEMA = [
      { type: 'bool', path: P.APP_APPLY_ALL }, { type: 'bool', path: P.APP_ZOOM_EN },
      { type: 'bool', path: P.APP_AUTO_SCENE }, { type: 'bool', path: P.APP_ADV },
      { type: 'bool', path: P.APP_GPU_EN },
      { type: 'bool', path: P.APP_SMART_SHARP },
      { type: 'bool', path: P.APP_ADAPT_SAT },
      { type: 'bool', path: P.APP_SKIN_PROTECT },
      { type: 'bool', path: P.APP_AUTO_ZOOM },
      { type: 'bool', path: P.APP_ZONAL_CONTRAST },
      { type: 'bool', path: P.APP_SMOOTH_TRANS },
      { type: 'bool', path: P.APP_HDR_TONEMAP }
    ];
    const VIDEO_SCHEMA = [
      { type: 'enum', path: P.V_PRE_S, values: Object.keys(PRESETS.detail), fallback: () => DEFAULTS.video.presetS },
      { type: 'num', path: P.V_PRE_MIX, min: 0, max: 1, fallback: () => DEFAULTS.video.presetMix },
      { type: 'num', path: P.V_MAN_SHAD, min: 0, max: 100, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_MAN_REC, min: 0, max: 100, round: true, fallback: () => 0 },
      { type: 'num', path: P.V_MAN_BRT, min: 0, max: 100, round: true, fallback: () => 0 }
    ];
    const AUDIO_PLAYBACK_SCHEMA = [
      { type: 'bool', path: P.A_EN }, { type: 'num', path: P.A_BST, min: 0, max: 18, fallback: () => DEFAULTS.audio.boost },
      { type: 'bool', path: P.PB_EN }, { type: 'num', path: P.PB_RATE, min: 0.07, max: 16, fallback: () => DEFAULTS.playback.rate }
    ];
    const ALL_SCHEMAS = [...APP_SCHEMA, ...VIDEO_SCHEMA, ...AUDIO_PLAYBACK_SCHEMA];

    const _schemaHandlers = {
      bool: (sm, rule, set) => set(rule.path, !!sm.get(rule.path)),
      enum: (sm, rule, set) => { if (!rule.values.includes(sm.get(rule.path))) set(rule.path, rule.fallback()); },
      num: (sm, rule, set) => {
        let n = Number(sm.get(rule.path));
        if (!Number.isFinite(n)) n = rule.fallback();
        if (rule.round) n = Math.round(n);
        set(rule.path, Math.max(rule.min, Math.min(rule.max, n)));
      }
    };

    /* ══ attachShadow patch ══ */
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

    /* ══ TOUCHED sets & eviction ══ */
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
      for (const v of toDrop) set.delete(v);
      if (onEvict) queueMicrotask(() => { for (const v of toDrop) { try { onEvict(v); } catch (_) {} } });
    }

    /* ══ Rect caching & viewport ══ */
    let __vscRectEpoch = 0, __vscRectEpochQueued = false;
    function bumpRectEpoch() {
      if (__vscRectEpochQueued) return;
      __vscRectEpochQueued = true;
      requestAnimationFrame(() => { __vscRectEpochQueued = false; __vscRectEpoch++; });
    }
    onWin('scroll', bumpRectEpoch, { passive: true, capture: true });
    onWin('resize', bumpRectEpoch, { passive: true });
    onWin('orientationchange', bumpRectEpoch, { passive: true });
    try { const vv = window.visualViewport; if (vv) { on(vv, 'resize', bumpRectEpoch, { passive: true }); on(vv, 'scroll', bumpRectEpoch, { passive: true }); } } catch (_) {}

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

    /* ══ CircularBuffer (monotonic version counter) ══ */
    class CircularBuffer {
      constructor(maxLen) { this._buf = new Float64Array(maxLen); this._head = 0; this._size = 0; this._max = maxLen; this._sortedCache = null; this._sortedCacheVer = -1; this._mutVer = 0; }
      push(val) { this._buf[this._head] = val; this._head = (this._head + 1) % this._max; if (this._size < this._max) this._size++; this._mutVer++; }
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
        if (start + this._size <= this._max) { arr.set(this._buf.subarray(start, start + this._size)); }
        else {
          const firstPart = this._max - start;
          arr.set(this._buf.subarray(start, this._max));
          arr.set(this._buf.subarray(0, this._size - firstPart), firstPart);
        }
        arr.sort((a, b) => a - b);
        return arr;
      }
      getSorted() { if (this._sortedCacheVer === this._mutVer && this._sortedCache) return this._sortedCache; this._sortedCache = this.toSorted(); this._sortedCacheVer = this._mutVer; return this._sortedCache; }
      clear() { this._head = 0; this._size = 0; this._mutVer++; this._sortedCacheVer = -1; }
    }

    /* ══ SPA URL detector ══ */
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
      let hasNavigationAPI = false;
      if (typeof navigation !== 'undefined' && navigation.addEventListener) {
        try {
          navigation.addEventListener('navigatesuccess', emitIfChanged, { signal: __globalSig });
          navigation.addEventListener('navigateerror', emitIfChanged, { signal: __globalSig });
          hasNavigationAPI = true;
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
          patched = new Proxy(orig, { apply(target, thisArg, argsList) { const ret = Reflect.apply(target, thisArg, argsList); if (!__globalSig.aborted) queueMicrotask(emitIfChanged); return ret; } });
          patched[VSC_SYM] = true; patched.__vsc_original = orig;
        } catch (_) {
          patched = function (...args) { const ret = Reflect.apply(orig, this, args); if (!__globalSig.aborted) queueMicrotask(emitIfChanged); return ret; };
          patched[VSC_SYM] = true; patched.__vsc_original = orig;
        }
        history[name] = patched;
      };
      wrap('pushState'); wrap('replaceState');
      onWin('popstate', emitIfChanged, { passive: true });
      __internal._spaOrigHistory = origHistory;
      __globalSig.addEventListener('abort', () => {
        for (const name of Object.keys(origHistory)) {
          try {
            const current = history[name];
            if (current?.[VSC_SYM] && current.__vsc_original === origHistory[name]) {
              history[name] = origHistory[name];
            } else if (current?.__vsc_original) {
              log.debug(`[SPA] ${name} was re-wrapped by another script, skipping restore`);
            }
          } catch (_) {}
        }
      }, { once: true });
    }

    /* ══ Iframe injection ══ */
    let __VSC_INJECT_SOURCE, __injectedIframes, __iframeLoadHooked, __iframeFailed;
    function watchIframes() {
      if (!FEATURE_FLAGS.iframeInjection) return;
      if (!__VSC_INJECT_SOURCE) {
        __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
        __injectedIframes = new WeakSet();
        __iframeLoadHooked = new WeakSet();
        __iframeFailed = new WeakSet();
      }
      const canAccess = (ifr) => { try { const w = ifr.contentWindow; if (!w) return false; void w.location.href; return true; } catch (_) { return false; } };
      const inject = (ifr) => {
        if (!ifr || __injectedIframes.has(ifr) || __iframeFailed.has(ifr)) return;
        if (!canAccess(ifr)) { if (ifr.contentWindow) __iframeFailed.add(ifr); return; }
        const tryInject = () => {
          try {
            const win = ifr.contentWindow; const doc = ifr.contentDocument || win?.document;
            if (!win || !doc) return;
            if (win[Symbol.for('__VSC_BOOT_LOCK__')]) { __injectedIframes.add(ifr); return; }
            const host = doc.head || doc.documentElement; if (!host) return;
            const s = doc.createElement('script'); s.textContent = __VSC_INJECT_SOURCE; host.appendChild(s); s.remove?.();
            __injectedIframes.add(ifr);
          } catch (_) { __iframeFailed.add(ifr); }
        };
        tryInject();
        if (!__iframeLoadHooked.has(ifr)) {
          __iframeLoadHooked.add(ifr);
          ifr.addEventListener('load', () => { __iframeFailed.delete(ifr); if (canAccess(ifr)) tryInject(); else __iframeFailed.add(ifr); }, { passive: true, signal: __globalSig });
        }
      };
      document.querySelectorAll('iframe').forEach(inject);
      const mo = new MutationObserver((muts) => {
        if (__globalSig.aborted) { mo.disconnect(); return; }
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'IFRAME') inject(n);
            else if (n.getElementsByTagName) { const iframes = n.getElementsByTagName('iframe'); for (let i = 0; i < iframes.length; i++) inject(iframes[i]); }
          }
        }
      });
      const observeRoot = document.documentElement || document.body;
      if (observeRoot) mo.observe(observeRoot, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => { if (__globalSig.aborted) return; const r = document.documentElement || document.body; if (r) mo.observe(r, { childList: true, subtree: true }); }, { once: true, signal: __globalSig });
      __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
    }

    /* ══ Fullscreen wrapper ══ */
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
      try { parent.insertBefore(ph, video); parent.insertBefore(wrap, ph); wrap.appendChild(video); } catch (e) {
        try {
          if (wrap.contains(video)) {
            if (ph.parentNode) ph.parentNode.insertBefore(video, ph);
            else if (wrap.parentNode) wrap.parentNode.insertBefore(video, wrap);
          }
          if (!video.isConnected && parent.isConnected) parent.appendChild(video);
        } catch (_) {}
        try { if (ph?.parentNode) ph.remove(); } catch (_) {}
        try { if (wrap?.parentNode && !wrap.contains(video)) wrap.remove(); } catch (_) {}
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
      if (ph?.parentNode?.isConnected) { try { ph.parentNode.insertBefore(video, ph); ph.remove(); restored = true; } catch (_) {} }
      if (!restored && wrap.parentNode?.isConnected) { try { wrap.parentNode.insertBefore(video, wrap); restored = true; } catch (_) {} }
      if (!restored && !video.isConnected) { log.warn('Video could not be restored to DOM after fullscreen exit.'); }
      try { if (ph?.parentNode) ph.remove(); } catch (_) {}
      try { if (wrap.parentNode) { const remaining = wrap.querySelector('video'); if (!remaining || remaining !== video) wrap.remove(); } } catch (_) {}
      fsWraps.delete(video);
      getVState(video).fsPatched = false;
    }

    function patchMethodSafe(obj, name, wrappedFn) { try { obj[name] = wrappedFn; return true; } catch (_) { return false; } }

    function patchFullscreenRequest(video) {
      const st = getVState(video);
      if (!video || st.fsPatched) return;
      try { const parent = video.parentNode; if (!parent || !parent.isConnected) return; const testComment = document.createComment(''); parent.insertBefore(testComment, video); testComment.remove(); } catch (_) { return; }
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
          for (const v of candidates) { if (!v.isConnected) continue; const wrap = fsWraps.get(v); if (wrap && currentFs === wrap) continue; restoreFromFsWrapper(v); }
          try { __internal.ApplyReq?.hard(); } catch (_) {}
        });
      }
      if (__internal._uiEnsure) requestAnimationFrame(() => { try { __internal._uiEnsure(); } catch (_) {} });
    }
    onDoc('fullscreenchange', onFsChange); onDoc('webkitfullscreenchange', onFsChange);

    /* ══ PiP state ══ */
    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ''; }
    function getActivePiPVideo() {
      if (document.pictureInPictureElement instanceof HTMLVideoElement) return document.pictureInPictureElement;
      if (__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed && __activeDocumentPiPVideo?.isConnected) return __activeDocumentPiPVideo;
      return null;
    }
    function isPiPActiveVideo(el) { return !!el && (el === getActivePiPVideo()); }
    function cleanupPipDocumentSvg(pipDoc) { try { if (!pipDoc || pipDoc === document) return; const svgs = pipDoc.querySelectorAll('svg'); for (const svg of svgs) { if (svg.querySelector('[id^="vsc-"]')) { try { svg.remove(); } catch (_) {} } } } catch (_) {} }

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

// ═══ END OF PART 1 (v204.0.0-Hybrid) ═══
// ═══ PART 2 START (v204.0.0-Hybrid) — GPU Analyzer, Audio Engine, Foundation Modules ═══
// ═══ 7 Intelligent Features: Runtime DEFAULTS/P/SCHEMA patch + GPU + Audio + Modules ═══

    /* ══ v204 Feature Toggles — Runtime Patch ══
       Part 1의 DEFAULTS/P/APP_SCHEMA에 누락된 7가지 토글을
       런타임에 안전하게 주입합니다. 이미 존재하면 건너뜁니다. */
    {
      const _d = DEFAULTS.app;
      if (!('smartSharpEn' in _d)) _d.smartSharpEn = true;
      if (!('adaptSatEn' in _d)) _d.adaptSatEn = true;
      if (!('skinProtectEn' in _d)) _d.skinProtectEn = true;
      if (!('autoZoomEn' in _d)) _d.autoZoomEn = false;
      if (!('zonalContrastEn' in _d)) _d.zonalContrastEn = true;
      if (!('smoothTransEn' in _d)) _d.smoothTransEn = true;
      if (!('hdrToneMapEn' in _d)) _d.hdrToneMapEn = false;
    }
    /* P 경로 확장 */
    if (!P.APP_SMART_SHARP) {
      const _ext = {
        APP_SMART_SHARP: 'app.smartSharpEn',
        APP_ADAPT_SAT: 'app.adaptSatEn',
        APP_SKIN_PROTECT: 'app.skinProtectEn',
        APP_AUTO_ZOOM: 'app.autoZoomEn',
        APP_ZONAL_CONTRAST: 'app.zonalContrastEn',
        APP_SMOOTH_TRANS: 'app.smoothTransEn',
        APP_HDR_TONEMAP: 'app.hdrToneMapEn'
      };
      for (const [k, v] of Object.entries(_ext)) {
        try { Object.defineProperty(P, k, { value: v, writable: false, enumerable: true, configurable: false }); } catch (_) { P[k] = v; }
      }
    }
    /* APP_SCHEMA 확장 */
    {
      const _existingPaths = new Set(APP_SCHEMA.map(s => s.path));
      const _newToggles = [
        P.APP_SMART_SHARP, P.APP_ADAPT_SAT, P.APP_SKIN_PROTECT,
        P.APP_AUTO_ZOOM, P.APP_ZONAL_CONTRAST, P.APP_SMOOTH_TRANS, P.APP_HDR_TONEMAP
      ];
      for (const p of _newToggles) {
        if (!_existingPaths.has(p)) {
          APP_SCHEMA.push({ type: 'bool', path: p });
          ALL_SCHEMAS.push({ type: 'bool', path: p });
        }
      }
    }

    /* ══════════════════════════════════════════════════════════════════
       WebGPU Scene Analysis Compute Shader (v204.0.0: unchanged from v203)
       ══════════════════════════════════════════════════════════════════ */
    const VSC_GPU_WGSL = /* wgsl */ `
struct Params { width : u32, height : u32, step : u32, _pad : u32, };
@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var<storage, read> pixels : array<u32>;
@group(0) @binding(2) var<storage, read> prevLum : array<u32>;
@group(0) @binding(3) var<storage, read_write> lumHist : array<atomic<u32>, 256>;
@group(0) @binding(4) var<storage, read_write> rHist   : array<atomic<u32>, 256>;
@group(0) @binding(5) var<storage, read_write> gHist   : array<atomic<u32>, 256>;
@group(0) @binding(6) var<storage, read_write> bHist   : array<atomic<u32>, 256>;
struct ZoneData { counts : array<atomic<u32>, 16>, brightSum : array<atomic<u32>, 16>, };
@group(0) @binding(7) var<storage, read_write> zones : ZoneData;
struct ZoneHist { data : array<atomic<u32>, 4096>, };
@group(0) @binding(8) var<storage, read_write> zoneHists : ZoneHist;
struct Accum { sumLum : atomic<u32>, sumLumSq : atomic<u32>, sumChroma : atomic<u32>, sumEdge : atomic<u32>, skinCount : atomic<u32>, count : atomic<u32>, motionSadSum : atomic<u32>, motionSadCnt : atomic<u32>, hiLumaRSum : atomic<u32>, hiLumaBSum : atomic<u32>, hiLumaCount : atomic<u32>, _pad0 : u32, };
@group(0) @binding(9) var<storage, read_write> accum : Accum;
@group(0) @binding(10) var<storage, read_write> curLum : array<u32>;

fn luminance(r : u32, g : u32, b : u32) -> u32 { return (r * 54u + g * 183u + b * 18u + 128u) >> 8u; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let w = params.width; let h = params.height; let step = params.step;
  let totalCols = (w + step - 1u) / step; let totalRows = (h + step - 1u) / step; let totalPixels = totalCols * totalRows;
  let idx = gid.x; if (idx >= totalPixels) { return; }
  let row = idx / totalCols; let col = idx % totalCols; let x = col * step; let y = row * step;
  if (x >= w || y >= h) { return; }
  let pi = y * w + x; let px = pixels[pi];
  let r = px & 0xFFu; let g = (px >> 8u) & 0xFFu; let b = (px >> 16u) & 0xFFu;
  let l = luminance(r, g, b); curLum[pi] = l;
  var mx = r; if (g > mx) { mx = g; } if (b > mx) { mx = b; }
  var mn = r; if (g < mn) { mn = g; } if (b < mn) { mn = b; }
  let chroma = mx - mn;
  atomicAdd(&accum.sumLum, l); atomicAdd(&accum.sumLumSq, l * l); atomicAdd(&accum.sumChroma, chroma); atomicAdd(&accum.count, 1u);
  atomicAdd(&lumHist[l], 1u); atomicAdd(&rHist[r], 1u); atomicAdd(&gHist[g], 1u); atomicAdd(&bHist[b], 1u);
  if (x + step < w) {
    let ni = pi + step; let npx = pixels[ni];
    let nr = npx & 0xFFu; let ng = (npx >> 8u) & 0xFFu; let nb = (npx >> 16u) & 0xFFu;
    let l2 = luminance(nr, ng, nb); var diff = l2 - l; if (l2 < l) { diff = l - l2; }
    atomicAdd(&accum.sumEdge, diff);
  }
  let rdiff = i32(r) - i32(g);
  if (rdiff > 12 && r >= 80u && g >= 35u && b >= 20u && r > g && r > b) { atomicAdd(&accum.skinCount, 1u); }
  let zx = min(3u, (x * 4u) / w); let zy = min(3u, (y * 4u) / h); let zi = zy * 4u + zx;
  atomicAdd(&zones.counts[zi], 1u); atomicAdd(&zones.brightSum[zi], l); atomicAdd(&zoneHists.data[zi * 256u + l], 1u);
  if (l >= 180u && b > 10u) { atomicAdd(&accum.hiLumaRSum, r); atomicAdd(&accum.hiLumaBSum, b); atomicAdd(&accum.hiLumaCount, 1u); }
}

@compute @workgroup_size(256)
fn motionPass(@builtin(global_invocation_id) gid : vec3<u32>) {
  let w = params.width; let h = params.height; let bw = 8u; let bh = 8u; let step = params.step;
  let gridW = w / bw; let gridH = h / bh; let totalBlocks = gridW * gridH;
  let blockIdx = gid.x; if (blockIdx >= totalBlocks) { return; }
  let by = (blockIdx / gridW) * bh; let bx = (blockIdx % gridW) * bw;
  var blockSad : u32 = 0u;
  for (var dy : u32 = 0u; dy < bh; dy = dy + step) {
    for (var dx : u32 = 0u; dx < bw; dx = dx + step) {
      let pi = (by + dy) * w + (bx + dx); let cur = curLum[pi]; let prev = prevLum[pi];
      var d = cur - prev; if (prev > cur) { d = prev - cur; }
      blockSad = blockSad + d;
    }
  }
  atomicAdd(&accum.motionSadSum, blockSad); atomicAdd(&accum.motionSadCnt, 1u);
}
`;

    /* ── WebGPU Analyzer Module (v204.0.0: unchanged from v203) ── */
    function createWebGPUAnalyzer() {
      let device = null, mainPipeline = null, motionPipeline = null, bindGroupLayout = null;
      let uniformBuf = null, pixelBuf = null, prevLumBuf = null, curLumBuf = null;
      let lumHistBuf = null, rHistBuf = null, gHistBuf = null, bHistBuf = null, zoneBuf = null, zoneHistBuf = null, accumBuf = null;
      let readbackAccumBuf = null, readbackHistBuf = null, readbackZoneHistBuf = null, readbackZoneBuf = null;
      let lastW = 0, lastH = 0, hasPrevLum = false, initFailed = false, initAttempted = false, gpuReady = false;
      const GPU_STEP = 1;
      const HIST_BINS = 256, ZONE_COUNT = 16, ACCUM_U32_COUNT = 12;
      const ACCUM_BYTES = ACCUM_U32_COUNT * 4, HIST_BYTES = HIST_BINS * 4, ZONE_DATA_BYTES = ZONE_COUNT * 4 * 2, ZONE_HIST_BYTES = ZONE_COUNT * HIST_BINS * 4;

      async function initGPU() {
        if (initAttempted) return gpuReady;
        initAttempted = true;
        if (!navigator.gpu) { log.info('[GPU] WebGPU not available, using CPU fallback'); initFailed = true; return false; }
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
          if (!adapter) { log.info('[GPU] No adapter found, using CPU fallback'); initFailed = true; return false; }
          const requiredLimits = {};
          const adapterLimits = adapter.limits;
          requiredLimits.maxStorageBufferBindingSize = Math.min(adapterLimits.maxStorageBufferBindingSize || 134217728, 134217728);
          requiredLimits.maxBufferSize = Math.min(adapterLimits.maxBufferSize || 268435456, 268435456);
          device = await adapter.requestDevice({ requiredLimits });
          device.lost.then((info) => { log.warn('[GPU] Device lost:', info.message); gpuReady = false; device = null; initAttempted = false; initFailed = false; });
          const shaderModule = device.createShaderModule({ code: VSC_GPU_WGSL });
          const compilationInfo = await shaderModule.getCompilationInfo();
          if (compilationInfo.messages.some(m => m.type === 'error')) { log.warn('[GPU] Shader compilation errors:', compilationInfo.messages); device.destroy(); device = null; initFailed = true; return false; }
          bindGroupLayout = device.createBindGroupLayout({
            entries: [
              { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
              { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
              { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
              { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
              { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
            ]
          });
          const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
          mainPipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shaderModule, entryPoint: 'main' } });
          motionPipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module: shaderModule, entryPoint: 'motionPass' } });
          uniformBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'vsc-uniform' });
          readbackAccumBuf = device.createBuffer({ size: ACCUM_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'vsc-readback-accum' });
          readbackHistBuf = device.createBuffer({ size: HIST_BYTES * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'vsc-readback-hist' });
          readbackZoneBuf = device.createBuffer({ size: ZONE_DATA_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'vsc-readback-zone' });
          readbackZoneHistBuf = device.createBuffer({ size: ZONE_HIST_BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'vsc-readback-zonehist' });
          gpuReady = true; log.info('[GPU] WebGPU analyzer initialized successfully'); return true;
        } catch (e) { log.warn('[GPU] Init failed:', e.message); initFailed = true; if (device) { try { device.destroy(); } catch (_) {} device = null; } return false; }
      }

      function ensureBuffers(sw, sh) {
        if (!device || (sw === lastW && sh === lastH)) return;
        const pixelBytes = sw * sh * 4, lumBytes = sw * sh * 4;
        [pixelBuf, prevLumBuf, curLumBuf, lumHistBuf, rHistBuf, gHistBuf, bHistBuf, zoneBuf, zoneHistBuf, accumBuf].forEach(b => { if (b) b.destroy(); });
        const SB = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;
        pixelBuf = device.createBuffer({ size: pixelBytes, usage: SB | CD, label: 'vsc-pixels' });
        prevLumBuf = device.createBuffer({ size: lumBytes, usage: SB | CD, label: 'vsc-prevlum' });
        curLumBuf = device.createBuffer({ size: lumBytes, usage: SB | CS, label: 'vsc-curlum' });
        lumHistBuf = device.createBuffer({ size: HIST_BYTES, usage: SB | CS | CD, label: 'vsc-lumhist' });
        rHistBuf = device.createBuffer({ size: HIST_BYTES, usage: SB | CS | CD, label: 'vsc-rhist' });
        gHistBuf = device.createBuffer({ size: HIST_BYTES, usage: SB | CS | CD, label: 'vsc-ghist' });
        bHistBuf = device.createBuffer({ size: HIST_BYTES, usage: SB | CS | CD, label: 'vsc-bhist' });
        zoneBuf = device.createBuffer({ size: ZONE_DATA_BYTES, usage: SB | CS | CD, label: 'vsc-zones' });
        zoneHistBuf = device.createBuffer({ size: ZONE_HIST_BYTES, usage: SB | CS | CD, label: 'vsc-zonehists' });
        accumBuf = device.createBuffer({ size: ACCUM_BYTES, usage: SB | CS | CD, label: 'vsc-accum' });
        lastW = sw; lastH = sh; hasPrevLum = false;
      }

      async function analyzeFrame(imageData, sw, sh) {
        if (!gpuReady || !device) return null;
        try {
          ensureBuffers(sw, sh);
          const pixelCount = sw * sh;
          const u32Data = new Uint32Array(imageData.buffer, imageData.byteOffset, imageData.byteLength >>> 2);
          device.queue.writeBuffer(uniformBuf, 0, new Uint32Array([sw, sh, GPU_STEP, 0]));
          device.queue.writeBuffer(pixelBuf, 0, u32Data);
          const zeros256 = new Uint32Array(HIST_BINS);
          device.queue.writeBuffer(lumHistBuf, 0, zeros256); device.queue.writeBuffer(rHistBuf, 0, zeros256); device.queue.writeBuffer(gHistBuf, 0, zeros256); device.queue.writeBuffer(bHistBuf, 0, zeros256);
          device.queue.writeBuffer(zoneBuf, 0, new Uint32Array(ZONE_COUNT * 2));
          device.queue.writeBuffer(zoneHistBuf, 0, new Uint32Array(ZONE_COUNT * HIST_BINS));
          device.queue.writeBuffer(accumBuf, 0, new Uint32Array(ACCUM_U32_COUNT));
          if (!hasPrevLum) device.queue.writeBuffer(prevLumBuf, 0, new Uint32Array(pixelCount));
          const bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuf } }, { binding: 1, resource: { buffer: pixelBuf } }, { binding: 2, resource: { buffer: prevLumBuf } },
              { binding: 3, resource: { buffer: lumHistBuf } }, { binding: 4, resource: { buffer: rHistBuf } }, { binding: 5, resource: { buffer: gHistBuf } },
              { binding: 6, resource: { buffer: bHistBuf } }, { binding: 7, resource: { buffer: zoneBuf } }, { binding: 8, resource: { buffer: zoneHistBuf } },
              { binding: 9, resource: { buffer: accumBuf } }, { binding: 10, resource: { buffer: curLumBuf } }
            ]
          });
          const encoder = device.createCommandEncoder();
          const mainGroups = Math.ceil((Math.ceil(sw / GPU_STEP) * Math.ceil(sh / GPU_STEP)) / 256);
          const mainPass = encoder.beginComputePass();
          mainPass.setPipeline(mainPipeline); mainPass.setBindGroup(0, bindGroup); mainPass.dispatchWorkgroups(mainGroups); mainPass.end();
          if (hasPrevLum) {
            const motionGroups = Math.ceil((Math.floor(sw / 8) * Math.floor(sh / 8)) / 256);
            if (motionGroups > 0) { const motionPass = encoder.beginComputePass(); motionPass.setPipeline(motionPipeline); motionPass.setBindGroup(0, bindGroup); motionPass.dispatchWorkgroups(motionGroups); motionPass.end(); }
          }
          encoder.copyBufferToBuffer(accumBuf, 0, readbackAccumBuf, 0, ACCUM_BYTES);
          encoder.copyBufferToBuffer(lumHistBuf, 0, readbackHistBuf, 0, HIST_BYTES); encoder.copyBufferToBuffer(rHistBuf, 0, readbackHistBuf, HIST_BYTES, HIST_BYTES);
          encoder.copyBufferToBuffer(gHistBuf, 0, readbackHistBuf, HIST_BYTES * 2, HIST_BYTES); encoder.copyBufferToBuffer(bHistBuf, 0, readbackHistBuf, HIST_BYTES * 3, HIST_BYTES);
          encoder.copyBufferToBuffer(zoneBuf, 0, readbackZoneBuf, 0, ZONE_DATA_BYTES); encoder.copyBufferToBuffer(zoneHistBuf, 0, readbackZoneHistBuf, 0, ZONE_HIST_BYTES);
          encoder.copyBufferToBuffer(curLumBuf, 0, prevLumBuf, 0, pixelCount * 4);
          device.queue.submit([encoder.finish()]);

          await Promise.all([readbackAccumBuf.mapAsync(GPUMapMode.READ), readbackHistBuf.mapAsync(GPUMapMode.READ), readbackZoneBuf.mapAsync(GPUMapMode.READ), readbackZoneHistBuf.mapAsync(GPUMapMode.READ)]);
          const accumData = new Uint32Array(readbackAccumBuf.getMappedRange().slice(0)); readbackAccumBuf.unmap();
          const histData = new Uint32Array(readbackHistBuf.getMappedRange().slice(0)); readbackHistBuf.unmap();
          const zoneData = new Uint32Array(readbackZoneBuf.getMappedRange().slice(0)); readbackZoneBuf.unmap();
          const zoneHistData = new Uint32Array(readbackZoneHistBuf.getMappedRange().slice(0)); readbackZoneHistBuf.unmap();
          hasPrevLum = true;

          const count = Math.max(1, accumData[5]), sumLum = accumData[0], sumLumSq = accumData[1], sumChroma = accumData[2], sumEdge = accumData[3], skinCount = accumData[4];
          const motionSadSum = accumData[6], motionSadCnt = Math.max(1, accumData[7]), hiLumaRSum = accumData[8], hiLumaBSum = accumData[9], hiLumaCount = accumData[10];
          const mean = sumLum / count, variance = Math.max(0, (sumLumSq / count) - mean * mean), std = Math.sqrt(variance);
          const motionSAD = motionSadCnt > 0 ? (motionSadSum / motionSadCnt) / 255 : 0;
          const hiLumaRBratio = hiLumaCount >= 10 ? hiLumaRSum / Math.max(1, hiLumaBSum) : NaN;

          const lumHist = new Uint32Array(HIST_BINS), rHist = new Uint32Array(HIST_BINS), gHist = new Uint32Array(HIST_BINS), bHist = new Uint32Array(HIST_BINS);
          lumHist.set(histData.subarray(0, HIST_BINS)); rHist.set(histData.subarray(HIST_BINS, HIST_BINS * 2));
          gHist.set(histData.subarray(HIST_BINS * 2, HIST_BINS * 3)); bHist.set(histData.subarray(HIST_BINS * 3, HIST_BINS * 4));

          const zoneCounts = new Uint32Array(ZONE_COUNT), zoneBrightSum = new Float32Array(ZONE_COUNT);
          for (let z = 0; z < ZONE_COUNT; z++) { zoneCounts[z] = zoneData[z]; zoneBrightSum[z] = zoneData[ZONE_COUNT + z]; }
          const zoneHists = Array.from({ length: ZONE_COUNT }, (_, z) => new Uint32Array(zoneHistData.buffer, z * HIST_BINS * 4, HIST_BINS));

          const centerIndices = [5, 6, 9, 10]; let centerSum = 0, centerCnt = 0;
          for (const ci of centerIndices) { if (zoneCounts[ci] > 0) { centerSum += zoneBrightSum[ci] / zoneCounts[ci]; centerCnt++; } }
          const centerBright = centerCnt > 0 ? centerSum / centerCnt / 255 : mean / 255;

          let edgeSum = 0, edgeCnt = 0;
          for (let z = 0; z < ZONE_COUNT; z++) { if (centerIndices.includes(z)) continue; if (zoneCounts[z] > 0) { edgeSum += zoneBrightSum[z] / zoneCounts[z]; edgeCnt++; } }
          const edgeAvgBright = edgeCnt > 0 ? edgeSum / edgeCnt / 255 : mean / 255;

          return { bright: mean / 255, contrast: std / 64, chroma: sumChroma / count / 255, edge: sumEdge / count, motionSAD, skinRatio: skinCount / count, centerBright, edgeAvgBright, hiLumaRBratio, lumHist, rHist, gHist, bHist, totalSamples: count, zoneHists, zoneCounts, zoneStats: { centerBright, edgeAvgBright }, _gpuPath: true };
        } catch (e) { log.warn('[GPU] analyzeFrame error:', e.message); return null; }
      }

      function destroy() {
        gpuReady = false;
        [pixelBuf, prevLumBuf, curLumBuf, lumHistBuf, rHistBuf, gHistBuf, bHistBuf, zoneBuf, zoneHistBuf, accumBuf, readbackAccumBuf, readbackHistBuf, readbackZoneBuf, readbackZoneHistBuf, uniformBuf].forEach(b => { if (b) { try { b.destroy(); } catch (_) {} } });
        pixelBuf = prevLumBuf = curLumBuf = lumHistBuf = rHistBuf = gHistBuf = bHistBuf = zoneBuf = zoneHistBuf = accumBuf = readbackAccumBuf = readbackHistBuf = readbackZoneBuf = readbackZoneHistBuf = uniformBuf = null;
        if (device) { try { device.destroy(); } catch (_) {} device = null; }
        lastW = 0; lastH = 0; hasPrevLum = false; mainPipeline = null; motionPipeline = null; bindGroupLayout = null;
      }
      __globalSig.addEventListener('abort', destroy, { once: true });
      return Object.freeze({ initGPU, analyzeFrame, isReady: () => gpuReady, isFailed: () => initFailed, destroy });
    }

    /* ══════════════════════════════════════════════════════════════════
       AudioWorklet DSP Processor Source (v204.0.0: sceneAudioParams 추가)
       ══════════════════════════════════════════════════════════════════ */
    const VSC_AUDIO_WORKLET_SOURCE = `
class VSCDSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(); const pd = (options && options.processorOptions) || {};
    this.sampleRate = pd.sampleRate || 48000; this.enabled = false; this.boostLinear = 1.0; this.wetMix = 0.0; this.dryMix = 1.0;
    this._hpfState = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }]; this._computeHPFCoeffs(65, 0.707);
    this._compEnvDb = -100; this._compThreshDb = -30; this._compRatio = 4.5; this._compKneeDb = 4; this._compAttack = 0.0015; this._compRelease = 0.10;
    this._limEnvDb = -100; this._limThreshDb = -1.5; this._limRatio = 20; this._limAttack = 0.0003; this._limRelease = 0.06;
    this._clipKnee = 0.65; this._clipDrive = 3.0; this._clipTanhD = Math.tanh(this._clipDrive);
    this._makeupDbEma = 0; this._rmsDb = -100; this._compReductionDb = 0; this._targetWet = 0; this._targetDry = 1; this._rampRate = 0.004;
    this._sceneVoiceBoost = 0; this._sceneBassBoost = 0; this._sceneVoiceEma = 0; this._sceneBassEma = 0;
    this._voiceBpfState = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }];
    this._computeVoiceBPFCoeffs(2500, 1.2);
    this._bassShelfState = [{ x1: 0, x2: 0, y1: 0, y2: 0 }, { x1: 0, x2: 0, y1: 0, y2: 0 }];
    this._computeBassShelfCoeffs(120, 0);
    this.port.onmessage = (e) => {
      const d = e.data; if (!d) return;
      if (d.type === 'params') { if (typeof d.enabled === 'boolean') this.enabled = d.enabled; if (typeof d.boostDb === 'number') this.boostLinear = Math.pow(10, d.boostDb / 20); this._updateMixTargets(); }
      if (d.type === 'sceneAudioParams') {
        if (typeof d.voiceBoostDb === 'number') this._sceneVoiceBoost = d.voiceBoostDb;
        if (typeof d.bassBoostDb === 'number') this._sceneBassBoost = d.bassBoostDb;
        if (Math.abs(this._sceneBassBoost) > 0.1) this._computeBassShelfCoeffs(120, this._sceneBassBoost);
      }
      if (d.type === 'getMetrics') { this.port.postMessage({ type: 'metrics', rmsDb: this._rmsDb, compReduction: this._compReductionDb, makeupDb: this._makeupDbEma }); }
    };
  }
  _updateMixTargets() { if (this.enabled) { this._targetWet = 1; this._targetDry = 0; } else { this._targetWet = 0; this._targetDry = 1; } }
  _computeHPFCoeffs(freq, Q) { const w0 = 2 * Math.PI * freq / this.sampleRate; const cosW0 = Math.cos(w0); const sinW0 = Math.sin(w0); const alpha = sinW0 / (2 * Q); const a0 = 1 + alpha; this._hpfB0 = ((1 + cosW0) / 2) / a0; this._hpfB1 = (-(1 + cosW0)) / a0; this._hpfB2 = ((1 + cosW0) / 2) / a0; this._hpfA1 = (-2 * cosW0) / a0; this._hpfA2 = (1 - alpha) / a0; }
  _applyHPF(sample, chState) { const y = this._hpfB0 * sample + this._hpfB1 * chState.x1 + this._hpfB2 * chState.x2 - this._hpfA1 * chState.y1 - this._hpfA2 * chState.y2; chState.x2 = chState.x1; chState.x1 = sample; chState.y2 = chState.y1; chState.y1 = y; return y; }
  _computeVoiceBPFCoeffs(freq, Q) { const w0 = 2 * Math.PI * freq / this.sampleRate; const cosW0 = Math.cos(w0); const sinW0 = Math.sin(w0); const alpha = sinW0 / (2 * Q); const a0 = 1 + alpha; this._vbpfB0 = (alpha) / a0; this._vbpfB1 = 0; this._vbpfB2 = (-alpha) / a0; this._vbpfA1 = (-2 * cosW0) / a0; this._vbpfA2 = (1 - alpha) / a0; }
  _applyVoiceBPF(sample, chState) { const y = this._vbpfB0 * sample + this._vbpfB1 * chState.x1 + this._vbpfB2 * chState.x2 - this._vbpfA1 * chState.y1 - this._vbpfA2 * chState.y2; chState.x2 = chState.x1; chState.x1 = sample; chState.y2 = chState.y1; chState.y1 = y; return y; }
  _computeBassShelfCoeffs(freq, gainDb) { const A = Math.pow(10, gainDb / 40); const w0 = 2 * Math.PI * freq / this.sampleRate; const cosW0 = Math.cos(w0); const sinW0 = Math.sin(w0); const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 / 0.707 - 1) + 2); const sqrtA2alpha = 2 * Math.sqrt(A) * alpha; const a0 = (A + 1) + (A - 1) * cosW0 + sqrtA2alpha; this._bsB0 = (A * ((A + 1) - (A - 1) * cosW0 + sqrtA2alpha)) / a0; this._bsB1 = (2 * A * ((A - 1) - (A + 1) * cosW0)) / a0; this._bsB2 = (A * ((A + 1) - (A - 1) * cosW0 - sqrtA2alpha)) / a0; this._bsA1 = (-2 * ((A - 1) + (A + 1) * cosW0)) / a0; this._bsA2 = ((A + 1) + (A - 1) * cosW0 - sqrtA2alpha) / a0; }
  _applyBassShelf(sample, chState) { const y = this._bsB0 * sample + this._bsB1 * chState.x1 + this._bsB2 * chState.x2 - this._bsA1 * chState.y1 - this._bsA2 * chState.y2; chState.x2 = chState.x1; chState.x1 = sample; chState.y2 = chState.y1; chState.y1 = y; return y; }
  _compressDb(inputDb, threshDb, ratio, kneeDb) { const halfKnee = kneeDb / 2; if (inputDb < threshDb - halfKnee) return inputDb; if (inputDb > threshDb + halfKnee) { return threshDb + (inputDb - threshDb) / ratio; } const x = inputDb - threshDb + halfKnee; return inputDb + ((1 / ratio) - 1) * x * x / (2 * kneeDb); }
  _envFollow(envDb, inputDb, attack, release) { const coeff = inputDb > envDb ? 1 - Math.exp(-1 / (this.sampleRate * attack)) : 1 - Math.exp(-1 / (this.sampleRate * release)); return envDb + coeff * (inputDb - envDb); }
  _softClip(x) { const ax = Math.abs(x); if (ax <= this._clipKnee) return x; const t = (ax - this._clipKnee) / Math.max(1e-6, 1 - this._clipKnee); const s = Math.tanh(this._clipDrive * t) / this._clipTanhD; return Math.sign(x) * (this._clipKnee + (1 - this._clipKnee) * s); }
  process(inputs, outputs, parameters) {
    const input = inputs[0]; const output = outputs[0]; if (!input || !input.length || !output || !output.length) return true;
    const numChannels = Math.min(input.length, output.length, 2); const blockSize = input[0].length;
    this.wetMix += (this._targetWet - this.wetMix) * Math.min(1, this._rampRate * blockSize); this.dryMix += (this._targetDry - this.dryMix) * Math.min(1, this._rampRate * blockSize);
    const doProcess = this.wetMix > 0.001;
    const voiceAlpha = 0.02; this._sceneVoiceEma += (this._sceneVoiceBoost - this._sceneVoiceEma) * voiceAlpha;
    const bassAlpha = 0.02; this._sceneBassEma += (this._sceneBassBoost - this._sceneBassEma) * bassAlpha;
    const voiceGainLin = Math.pow(10, this._sceneVoiceEma / 20);
    if (!doProcess) { for (let ch = 0; ch < numChannels; ch++) { const inp = input[ch]; const out = output[ch]; for (let i = 0; i < blockSize; i++) out[i] = inp[i] * this.dryMix; } for (let ch = numChannels; ch < output.length; ch++) output[ch].fill(0); return true; }
    let sumSq = 0; let peakCompReduction = 0;
    for (let i = 0; i < blockSize; i++) {
      let monoIn = 0; for (let ch = 0; ch < numChannels; ch++) monoIn += input[ch][i]; monoIn /= numChannels;
      let filtered = 0; for (let ch = 0; ch < numChannels; ch++) { filtered += this._applyHPF(input[ch][i], this._hpfState[ch]); } filtered /= numChannels;
      const inAbs = Math.abs(filtered); const inDb = inAbs > 1e-8 ? 20 * Math.log10(inAbs) : -160;
      this._compEnvDb = this._envFollow(this._compEnvDb, inDb, this._compAttack, this._compRelease);
      const compOutDb = this._compressDb(this._compEnvDb, this._compThreshDb, this._compRatio, this._compKneeDb);
      const compGainDb = compOutDb - this._compEnvDb; const compReduction = -compGainDb; if (compReduction > peakCompReduction) peakCompReduction = compReduction;
      const compGainLinear = Math.pow(10, compGainDb / 20);
      let gateMult = 1.0; if (this._compEnvDb < -52) gateMult = 0.0; else if (this._compEnvDb < -42) gateMult = (this._compEnvDb + 52) / 10.0;
      const makeupDbTarget = Math.min(8, Math.max(0, compReduction - 2) * 0.40) * gateMult;
      const isAttack = makeupDbTarget < this._makeupDbEma; const alpha = isAttack ? 0.20 : 0.025; this._makeupDbEma += (makeupDbTarget - this._makeupDbEma) * alpha;
      const makeupLinear = Math.pow(10, this._makeupDbEma / 20); const totalGain = compGainLinear * this.boostLinear * makeupLinear;
      for (let ch = 0; ch < numChannels; ch++) {
        let wet = this._applyHPF(input[ch][i], this._hpfState[ch]) * totalGain;
        if (Math.abs(this._sceneVoiceEma) > 0.1) {
          const voiceBand = this._applyVoiceBPF(input[ch][i], this._voiceBpfState[ch]);
          wet += voiceBand * (voiceGainLin - 1.0) * totalGain;
        }
        if (Math.abs(this._sceneBassEma) > 0.1) {
          wet = this._applyBassShelf(wet, this._bassShelfState[ch]);
        }
        const wetAbs = Math.abs(wet); const wetDb = wetAbs > 1e-8 ? 20 * Math.log10(wetAbs) : -160;
        this._limEnvDb = this._envFollow(this._limEnvDb, wetDb, this._limAttack, this._limRelease);
        const limOutDb = this._compressDb(this._limEnvDb, this._limThreshDb, this._limRatio, 0); const limGainDb = limOutDb - this._limEnvDb; const limGainLinear = Math.pow(10, limGainDb / 20);
        wet *= limGainLinear; wet = this._softClip(wet); const dry = input[ch][i]; output[ch][i] = dry * this.dryMix + wet * this.wetMix;
      }
      const outSample = output[0][i]; sumSq += outSample * outSample;
    }
    for (let ch = numChannels; ch < output.length; ch++) output[ch].fill(0);
    const rms = Math.sqrt(sumSq / blockSize); this._rmsDb = rms > 1e-8 ? 20 * Math.log10(rms) : -100; this._compReductionDb = peakCompReduction;
    return true;
  }
  static get parameterDescriptors() { return []; }
}
registerProcessor('vsc-dsp-processor', VSCDSPProcessor);
`;

    /* ── AudioWorklet registration helper (v204.0.0: unchanged) ── */
    let __workletRegistered = false;
    let __workletBlobUrl = null;

    async function ensureAudioWorkletModule(audioCtx) {
      if (__workletRegistered) return true;
      if (!audioCtx.audioWorklet || typeof audioCtx.audioWorklet.addModule !== 'function') return false;
      try {
        if (!__workletBlobUrl) { const blob = new Blob([VSC_AUDIO_WORKLET_SOURCE], { type: 'application/javascript' }); __workletBlobUrl = URL.createObjectURL(blob); }
        await audioCtx.audioWorklet.addModule(__workletBlobUrl);
        __workletRegistered = true; log.info('[AudioWorklet] DSP processor registered successfully'); return true;
      } catch (e) { log.warn('[AudioWorklet] Registration failed:', e.message); return false; }
    }
    __globalSig.addEventListener('abort', () => { if (__workletBlobUrl) { try { URL.revokeObjectURL(__workletBlobUrl); } catch (_) {} __workletBlobUrl = null; } __workletRegistered = false; }, { once: true });

    /* ══ defineFeature — Declarative Module System (v204.0.0: unchanged) ══ */
    function createModuleSystem(globalSig) {
      const STATUS = Object.freeze({ PENDING: 0, INITIALIZING: 1, ACTIVE: 2, SUSPENDED: 3, DESTROYED: 4, ERROR: 5 });
      const modules = new Map(); const initOrder = []; const updateQueue = []; const destroyStack = []; let _resolving = new Set();

      function defineFeature(name, descriptor) {
        if (modules.has(name)) { log.warn(`[ModuleSystem] duplicate: ${name}, skipping`); return; }
        const { deps = [], init, update = null, destroy = null, priority = 100, updateCondition = null } = descriptor;
        if (typeof init !== 'function') { throw new Error(`[ModuleSystem] ${name}: init must be a function`); }
        modules.set(name, { name, deps, init, update, destroy, priority, updateCondition, instance: null, ac: null, signal: null, status: STATUS.PENDING, initTime: 0, updateCount: 0, lastError: null });
      }

      function resolve(name) {
        const mod = modules.get(name); if (!mod) throw new Error(`[ModuleSystem] unknown module: ${name}`);
        if (mod.status === STATUS.ACTIVE || mod.status === STATUS.SUSPENDED) return mod.instance;
        if (mod.status === STATUS.DESTROYED) throw new Error(`[ModuleSystem] ${name} already destroyed`);
        if (_resolving.has(name)) throw new Error(`[ModuleSystem] circular dependency: ${[..._resolving, name].join(' → ')}`);
        _resolving.add(name); mod.status = STATUS.INITIALIZING; const resolvedDeps = {};
        for (const depName of mod.deps) { try { resolvedDeps[depName] = resolve(depName); } catch (e) { mod.status = STATUS.ERROR; mod.lastError = e; _resolving.delete(name); throw new Error(`[ModuleSystem] ${name}: dep '${depName}' failed: ${e.message}`); } }
        const ac = new AbortController(); const moduleSignal = combineSignals(globalSig, ac.signal);
        try {
          const t0 = performance.now(); const instance = mod.init(resolvedDeps, moduleSignal); mod.initTime = performance.now() - t0;
          mod.instance = instance; mod.ac = ac; mod.signal = moduleSignal; mod.status = STATUS.ACTIVE;
          initOrder.push(name); destroyStack.push(name);
          if (typeof mod.update === 'function') { updateQueue.push(mod); updateQueue.sort((a, b) => a.priority - b.priority); }
          log.debug(`[ModuleSystem] ${name} initialized (${mod.initTime.toFixed(1)}ms)`); _resolving.delete(name); return instance;
        } catch (e) { mod.status = STATUS.ERROR; mod.lastError = e; ac.abort(); _resolving.delete(name); log.error(`[ModuleSystem] ${name} init failed:`, e); throw e; }
      }

      function resolveAll(names) { const results = new Map(); for (const name of names) results.set(name, resolve(name)); return results; }
      function runUpdates(ctx) {
        for (const mod of updateQueue) {
          if (mod.status !== STATUS.ACTIVE) continue;
          if (mod.updateCondition && !mod.updateCondition(ctx)) continue;
          try { mod.update(mod.instance, ctx); mod.updateCount++; } catch (e) { log.warn(`[ModuleSystem] ${mod.name} update error:`, e); mod.lastError = e; }
        }
      }

      function suspend(name) { const mod = modules.get(name); if (mod?.status === STATUS.ACTIVE) { mod.status = STATUS.SUSPENDED; log.debug(`[ModuleSystem] ${name} suspended`); } }
      function resume(name) { const mod = modules.get(name); if (mod?.status === STATUS.SUSPENDED) { mod.status = STATUS.ACTIVE; log.debug(`[ModuleSystem] ${name} resumed`); } }
      function destroyOne(name) {
        const mod = modules.get(name); if (!mod || mod.status === STATUS.DESTROYED) return;
        mod.status = STATUS.DESTROYED; if (mod.ac) { mod.ac.abort(); mod.ac = null; }
        if (typeof mod.destroy === 'function' && mod.instance != null) { try { mod.destroy(mod.instance); } catch (e) { log.warn(`[ModuleSystem] ${name} destroy error:`, e); } }
        const uIdx = updateQueue.indexOf(mod); if (uIdx >= 0) updateQueue.splice(uIdx, 1);
        mod.instance = null; mod.signal = null; log.debug(`[ModuleSystem] ${name} destroyed`);
      }
      function destroyAll() { while (destroyStack.length > 0) destroyOne(destroyStack.pop()); initOrder.length = 0; }
      function get(name) { return modules.get(name)?.instance ?? null; }
      function getStatus(name) { return modules.get(name)?.status ?? null; }
      function listActive() { const r = []; for (const [n, m] of modules) { if (m.status === STATUS.ACTIVE) r.push(n); } return r; }
      function getStats() { const stats = {}; for (const [name, mod] of modules) { stats[name] = { status: mod.status, initTime: mod.initTime, updateCount: mod.updateCount, lastError: mod.lastError?.message || null }; } return stats; }
      globalSig.addEventListener('abort', destroyAll, { once: true });
      return Object.freeze({ defineFeature, resolve, resolveAll, runUpdates, suspend, resume, destroyOne, destroyAll, get, getStatus, listActive, getStats, STATUS });
    }

    /* ══ Targeting (v204.0.0: unchanged) ══ */
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

    /* ══ Event Bus (v204.0.0: unchanged) ══ */
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

    /* ══ Utils (v204.0.0: unchanged) ══ */
    function createUtils() {
      const _SVG_NS = 'http://www.w3.org/2000/svg';
      const _SVG_TAGS = new Set([
        'svg', 'defs', 'filter', 'feComponentTransfer', 'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA',
        'feConvolveMatrix', 'feColorMatrix', 'feGaussianBlur', 'feMerge', 'feMergeNode',
        'feComposite', 'feBlend', 'g', 'path', 'circle', 'rect', 'line', 'text', 'polyline'
      ]);
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const isSvgEl = props.ns === 'svg' || _SVG_TAGS.has(tag);
          const el = isSvgEl ? document.createElementNS(_SVG_NS, tag) : document.createElement(tag);
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

    /* ══ Scheduler (v204.0.0: unchanged) ══ */
    function createScheduler(minIntervalMs = 14) {
      let queued = false, force = false, applyFn = null, lastRun = 0, timer = 0, rafId = 0, epoch = 0;
      function clearPending() { epoch++; if (timer) { clearTimer(timer); timer = 0; } if (rafId && rafId !== -1) { cancelAnimationFrame(rafId); rafId = 0; } }
      function queueRaf() {
        if (rafId) return;
        const myEpoch = epoch;
        if (force && globalThis.scheduler?.postTask) {
          rafId = -1;
          globalThis.scheduler.postTask(() => {
            rafId = 0;
            if (myEpoch !== epoch) return;
            run();
          }, { priority: 'user-visible' }).catch(() => {
            rafId = 0;
            requestAnimationFrame(() => { if (myEpoch !== epoch) return; run(); });
          });
        } else {
          rafId = requestAnimationFrame(() => { rafId = 0; if (myEpoch !== epoch) return; run(); });
        }
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

    /* ══ Local Store (v204.0.0: unchanged) ══ */
    function createLocalStore(defaults, scheduler, Utils) {
      let rev = 0;
      const listeners = new Map();
      const state = Utils.deepClone(defaults);
      const pathCache = new Map();

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

      function notifyChange(fullPath, val) {
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
          let changed = false;
          for (const [k, v] of Object.entries(obj)) {
            if (!Object.is(state[cat]?.[k], v)) { state[cat][k] = v; changed = true; emit(`${cat}.${k}`, v); }
          }
          if (changed) { rev++; scheduler.request(false); }
        },
        sub: (k, f) => {
          let s = listeners.get(k);
          if (!s) { s = new Set(); listeners.set(k, s); }
          s.add(f); return () => listeners.get(k)?.delete(f);
        }
      };
    }

    /* ══ normalizeBySchema (v204.0.0: unchanged) ══ */
    function normalizeBySchema(sm, schema) {
      let changed = false;
      const set = (path, val) => { if (!Object.is(sm.get(path), val)) { sm.set(path, val); changed = true; } };
      for (const rule of schema) _schemaHandlers[rule.type]?.(sm, rule, set);
      return changed;
    }

    /* ══ Registry (v204.0.0: unchanged from v203.1.1) ══ */
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
          const activeSize = (q.length - head) + (bigQ.length - bigHead);
          if (activeSize >= MAX_QUEUE_SIZE) {
            if (head > 0) { q.splice(0, head); head = 0; }
            const dropCount = Math.floor(q.length * 0.5);
            q.splice(0, dropCount);
            epoch++;
          }
          const m = mark.get(n); if (m === epoch) return; mark.set(n, epoch);
          (n.nodeType === 1 && (n.childElementCount || 0) > 1600 ? bigQ : q).push(n);
          schedule();
        };

        const scanNode = (n) => {
          if (!n) return;
          if (n.nodeType === 1) {
            if (n.tagName === 'VIDEO') { observeVideo(n); return; }
            if ((n.childElementCount || 0) === 0) return;
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

      const connectObserver = (root) => {
        if (!root) return;
        const mo = new MutationObserver((muts) => {
          if (__globalSig.aborted) { mo.disconnect(); observers.delete(mo); return; }
          if (root !== document && root !== document.body && root !== document.documentElement) {
            const host = root.host || root;
            if (host && typeof host.isConnected === 'boolean' && !host.isConnected) {
              mo.disconnect(); observers.delete(mo); return;
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

        if (root instanceof ShadowRoot && root.host) {
          const hostEl = root.host;
          const checkDisconnect = setRecurring(() => {
            if (!hostEl.isConnected) { mo.disconnect(); observers.delete(mo); clearRecurring(checkDisconnect); }
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
            const vst = videoStateMap.get(el);
            if (vst?._ac) { vst._ac.abort(); vst._ac = null; vst.bound = false; }
            vscClearAllStyles(el);
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

    /* ══ Audio Engine (v204.0.0: Scene-Aware Audio — applySceneAudioParams 추가) ══ */
    function createAudio(sm) {
      let ctx;
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
      let __ctxPermanentBlock = false;

      let bypassMode = false;
      let bypassVideo = null;

      let __useWorklet = false;
      let __workletNode = null;
      let __workletMasterGain = null;
      let __workletMetrics = { rmsDb: -100, compReduction: 0, makeupDb: 0 };
      let __workletMetricsTimer = 0;

      let compressor, limiter, wetInGain, dryOut, wetOut, masterOut, hpf, clipper, analyser, dataArray;

      const clamp = VSC_CLAMP;
      const VSC_AUDIO_AUTO_MAKEUP = true;

      /* ── v204 Scene-Aware Audio state ── */
      let __lastSceneAudioParams = { voiceBoostDb: 0, bassBoostDb: 0 };

      function enterBypass(v) {
        bypassMode = true;
        bypassVideo = v;
        log.info('[Audio] Entering bypass mode — audio routed directly to destination');
        if (v && ctx) {
          const s = srcMap.get(v);
          if (s) {
            try { s.disconnect(); } catch (_) {}
            try { s.connect(ctx.destination); } catch (_) {}
          }
        }
      }

      function exitBypass() {
        if (!bypassMode) return;
        bypassMode = false;
        bypassVideo = null;
        log.info('[Audio] Exiting bypass mode');
      }

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

      async function buildWorkletGraph() {
        if (!ctx) return false;
        try {
          const ok = await ensureAudioWorkletModule(ctx);
          if (!ok) return false;

          __workletNode = new AudioWorkletNode(ctx, 'vsc-dsp-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { sampleRate: ctx.sampleRate }
          });

          __workletNode.port.onmessage = (e) => {
            if (e.data && e.data.type === 'metrics') {
              __workletMetrics.rmsDb = e.data.rmsDb;
              __workletMetrics.compReduction = e.data.compReduction;
              __workletMetrics.makeupDb = e.data.makeupDb;
            }
          };

          __workletMasterGain = ctx.createGain();
          __workletNode.connect(__workletMasterGain);
          __workletMasterGain.connect(ctx.destination);
          __workletMasterGain.gain.value = 1.0;

          __useWorklet = true;
          log.info('[Audio] Using AudioWorklet DSP pipeline');
          return true;
        } catch (e) {
          log.warn('[Audio] AudioWorklet graph build failed:', e.message);
          __useWorklet = false;
          __workletNode = null;
          __workletMasterGain = null;
          return false;
        }
      }

      function buildLegacyGraph() {
        const __vscClipCurve = (() => {
          const n = 2048, knee = 0.65, drive = 3.0;
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

        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -28.0;
        compressor.knee.value = 5.0;
        compressor.ratio.value = 4.0;
        compressor.attack.value = 0.002;
        compressor.release.value = 0.08;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -2.0;
        limiter.knee.value = 0.0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0005;
        limiter.release.value = 0.06;

        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = 65;
        hpf.Q.value = 0.707;

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

        log.info('[Audio] Using legacy Web Audio node graph (fallback)');
      }

      function scheduleAudioLoop(tok) {
        const delay = document.hidden ? 600 : 80;
        if (__audioLoopTimer) clearTimer(__audioLoopTimer);
        const currentTok = tok;
        __audioLoopTimer = setTimer(() => {
          __audioLoopTimer = 0;
          if (currentTok !== loopTok || __globalSig.aborted) return;
          runAudioLoop(currentTok);
        }, delay);
      }

      function runAudioLoop(tok) {
        if (tok !== loopTok || !ctx || __globalSig.aborted) return;
        if (ctx.state === 'suspended') { if (!__useWorklet) makeupDbEma = 0; scheduleAudioLoop(tok); return; }

        if (bypassMode) { scheduleAudioLoop(tok); return; }

        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const actuallyEnabled = en && !!currentSrc;
        const boostDb = Number(sm.get(P.A_BST) || 0);

        if (__useWorklet) {
          if (__workletNode) {
            __workletNode.port.postMessage({ type: 'params', enabled: actuallyEnabled, boostDb });
            if (actuallyEnabled) __workletNode.port.postMessage({ type: 'getMetrics' });
          }
          makeupDbEma = actuallyEnabled ? __workletMetrics.makeupDb : makeupDbEma + (0 - makeupDbEma) * 0.1;
        } else {
          if (!actuallyEnabled || document.hidden) {
            makeupDbEma += (0 - makeupDbEma) * 0.1;
            if (wetInGain) { try { wetInGain.gain.setTargetAtTime(1.0, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = 1.0; } }
          } else {
            if (VSC_AUDIO_AUTO_MAKEUP && analyser) {
              analyser.getFloatTimeDomainData(dataArray);
              let sumSquare = 0;
              for (let i = 0; i < dataArray.length; i++) sumSquare += dataArray[i] * dataArray[i];
              const rms = Math.sqrt(sumSquare / dataArray.length);
              const db = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
              let redDb = 0;
              try { const r = compressor?.reduction; redDb = (typeof r === 'number') ? r : (r?.value ?? 0); } catch (_) {}
              if (!Number.isFinite(redDb)) redDb = 0;
              const redPos = clamp(-redDb, 0, 18);
              let gateMult = 1.0;
              if (db < -52) gateMult = 0.0;
              else if (db < -42) gateMult = (db + 52) / 10.0;
              const makeupDbTarget = clamp(Math.max(0, redPos - 2.0) * 0.40, 0, 8.0) * gateMult;
              const isAttack = makeupDbTarget < makeupDbEma;
              const alpha = isAttack ? 0.20 : 0.025;
              makeupDbEma += (makeupDbTarget - makeupDbEma) * alpha;
            } else { makeupDbEma += (0 - makeupDbEma) * 0.1; }

            const userBoost = Math.pow(10, boostDb / 20);
            const makeup = Math.pow(10, makeupDbEma / 20);
            if (wetInGain) {
              const finalGain = userBoost * makeup;
              try { wetInGain.gain.setTargetAtTime(finalGain, ctx.currentTime, 0.05); } catch (_) { wetInGain.gain.value = finalGain; }
            }
          }
        }
        scheduleAudioLoop(tok);
      }

      function disconnectWorkletGraph() {
        if (__workletNode) {
          try { __workletNode.port.close(); } catch (_) {}
          try { __workletNode.disconnect(); } catch (_) {}
        }
        try { __workletMasterGain?.disconnect(); } catch (_) {}
        __workletNode = null; __workletMasterGain = null;
      }

      function disconnectLegacyGraph() {
        try { compressor?.disconnect(); } catch (_) {}
        try { limiter?.disconnect(); } catch (_) {}
        try { hpf?.disconnect(); } catch (_) {}
        try { clipper?.disconnect(); } catch (_) {}
        try { wetInGain?.disconnect(); } catch (_) {}
        try { dryOut?.disconnect(); } catch (_) {}
        try { wetOut?.disconnect(); } catch (_) {}
        try { masterOut?.disconnect(); } catch (_) {}
        try { analyser?.disconnect(); } catch (_) {}
        compressor = null; limiter = null; wetInGain = null;
        dryOut = null; wetOut = null; masterOut = null; hpf = null;
        clipper = null; analyser = null; dataArray = null;
      }

      const resetCtx = () => {
        disconnectWorkletGraph();
        disconnectLegacyGraph();
        __useWorklet = false;
        __workletRegistered = false;
        ctx = null;
        currentSrc = null; target = null;
        exitBypass();
      };

      const disconnectAllKnownSources = () => {
        for (const v of TOUCHED.videos) { try { const s = srcMap.get(v); if (s) { s.disconnect(); } } catch (_) {} }
        for (const v of TOUCHED.rateVideos) { try { const s = srcMap.get(v); if (s) { s.disconnect(); } } catch (_) {} }
      };

      const reconnectAllSourcesToDestination = () => {
        if (!ctx || ctx.state === 'closed') return;
        const allVideos = new Set([...TOUCHED.videos, ...TOUCHED.rateVideos]);
        for (const v of allVideos) {
          try {
            const s = srcMap.get(v);
            if (s && s.context === ctx) {
              try { s.disconnect(); } catch (_) {}
              try { s.connect(ctx.destination); } catch (_) {}
            }
          } catch (_) {}
        }
      };

      const resetAllAudioFailUntil = () => {
        for (const v of TOUCHED.videos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
        for (const v of TOUCHED.rateVideos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
      };

      const ensureCtx = async () => {
        if (__ctxPermanentBlock) return false;
        if (ctx && ctx.state === 'closed') {
          disconnectAllKnownSources(); srcMap = new WeakMap(); resetAllAudioFailUntil(); resetCtx(); __ctxCreateCount++;
        }
        if (ctx) return true;
        const now = performance.now();
        if (now < __ctxBlockUntil) return false;
        if (__ctxBlockUntil > 0 && now >= __ctxBlockUntil) {
          __ctxCreateCount = 0;
          __ctxBlockUntil = 0;
        }
        if (__ctxCreateCount >= MAX_CTX_RECREATES) {
          __ctxCooldownCount++;
          if (__ctxCooldownCount >= MAX_COOLDOWNS) {
            __ctxPermanentBlock = true;
            log.warn('AudioContext permanently disabled after repeated failures');
            try { sm.set(P.A_EN, false); } catch (_) {}
            showOSD('오디오 부스트: 이 페이지에서 사용 불가', 3000);
            return false;
          }
          const cooldownMs = Math.min(60000 * Math.pow(2, __ctxCooldownCount - 1), 240000);
          __ctxBlockUntil = now + cooldownMs; __ctxCreateCount = 0;
          log.warn(`AudioContext cooling down for ${cooldownMs / 1000}s (attempt ${__ctxCooldownCount}/${MAX_COOLDOWNS})`);
          return false;
        }
        disconnectAllKnownSources(); srcMap = new WeakMap(); resetAllAudioFailUntil();
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { ctx = new AC({ latencyHint: 'playback' }); }
        catch (_) { try { ctx = new AC(); } catch (__) { return false; } }
        __ctxCreateCount++;
        ensureGestureResumeHook();

        if (FEATURE_FLAGS.audioWorklet) {
          const workletOk = await buildWorkletGraph();
          if (!workletOk) { buildLegacyGraph(); }
        } else {
          buildLegacyGraph();
        }

        if (ctx && !ctx.__vscStateWatched) {
          ctx.__vscStateWatched = true;
          ctx.addEventListener('statechange', () => {
            if (ctx.state === 'suspended' && !document.hidden) { ctx.resume().catch(() => {}); ensureGestureResumeHook(); }
            if (ctx.state === 'running') updateMix();
          });
        }

        return true;
      };

      const rampGainsSafe = (dryTarget, wetTarget, tc = 0.015) => {
        if (!ctx || bypassMode) return;
        if (__useWorklet) return;
        if (!dryOut || !wetOut) return;
        const t = ctx.currentTime;
        try {
          dryOut.gain.cancelScheduledValues(t); wetOut.gain.cancelScheduledValues(t);
          dryOut.gain.setTargetAtTime(dryTarget, t, tc); wetOut.gain.setTargetAtTime(wetTarget, t, tc);
        } catch (_) { dryOut.gain.value = dryTarget; wetOut.gain.value = wetTarget; }
      };

      const fadeOutThen = (fn) => {
        const getMasterGain = () => __useWorklet ? __workletMasterGain : masterOut;
        const master = getMasterGain();
        if (!ctx || !master || bypassMode) { try { fn(); } catch (_) {} return; }
        const tok = ++switchTok;
        if (switchTimer) { clearTimer(switchTimer); switchTimer = 0; }
        makeupDbEma = 0;

        const prevSrc = currentSrc;
        const savedCtx = ctx, savedMaster = master;
        try {
          const t = savedCtx.currentTime;
          savedMaster.gain.cancelScheduledValues(t);
          savedMaster.gain.setValueAtTime(savedMaster.gain.value, t);
          savedMaster.gain.linearRampToValueAtTime(0, t + 0.04);
        } catch (_) { try { savedMaster.gain.value = 0; } catch (__) {} }
        switchTimer = setTimer(() => {
          switchTimer = 0;
          if (tok !== switchTok) return;

          if (prevSrc && savedCtx && savedCtx.state !== 'closed') {
            try { prevSrc.disconnect(); } catch (_) {}
            try { prevSrc.connect(savedCtx.destination); } catch (_) {}
          }

          try { fn(); } catch (_) {}
          const curMaster = getMasterGain();
          if (ctx && curMaster && ctx.state !== 'closed') {
            try {
              const t2 = ctx.currentTime;
              curMaster.gain.cancelScheduledValues(t2);
              curMaster.gain.setValueAtTime(0, t2);
              curMaster.gain.linearRampToValueAtTime(1, t2 + 0.04);
            } catch (_) { try { curMaster.gain.value = 1; } catch (__) {} }
          }
        }, 60);
      };

      const disconnectAll = () => {
        if (currentSrc && ctx && ctx.state !== 'closed') {
          try { currentSrc.disconnect(); } catch (_) {}
          try { currentSrc.connect(ctx.destination); } catch (_) {}
        }
        currentSrc = null;
        target = null;
      };

      const updateMix = () => {
        if (!ctx) return;
        if (bypassMode) return;

        const en = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const isHooked = !!currentSrc;
        const actuallyEnabled = en && isHooked;
        const dryTarget = actuallyEnabled ? 0 : 1;
        const wetTarget = actuallyEnabled ? 1 : 0;
        rampGainsSafe(dryTarget, wetTarget, 0.015);

        if (__useWorklet && __workletNode) {
          const boostDb = Number(sm.get(P.A_BST) || 0);
          __workletNode.port.postMessage({ type: 'params', enabled: actuallyEnabled, boostDb });
        }

        loopTok++;
        if (__audioLoopTimer) { clearTimer(__audioLoopTimer); __audioLoopTimer = 0; }
        if (actuallyEnabled) scheduleAudioLoop(loopTok);
      };

      onDoc('visibilitychange', () => {
        if (document.visibilityState === 'visible' && ctx && ctx.state === 'running' && currentSrc) {
          loopTok++; scheduleAudioLoop(loopTok);
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
                log.debug('MediaElementSource already exists for this element — entering bypass mode');
                if (st) st.audioFailUntil = Infinity;
                enterBypass(v);
                return false;
              }
              throw e;
            }
            srcMap.set(v, s);
          }
          if (s.context !== ctx) {
            log.debug('Source belongs to different AudioContext — entering bypass mode');
            enterBypass(v);
            return false;
          }

          try { s.disconnect(); } catch (_) {}

          if (__useWorklet) {
            if (!__workletNode) { log.warn('AudioWorklet node not ready — entering bypass'); enterBypass(v); return false; }
            s.connect(__workletNode);
          } else {
            if (!dryOut || !(hpf || compressor)) { log.warn('Legacy audio graph not ready — entering bypass'); enterBypass(v); return false; }
            s.connect(dryOut);
            s.connect(hpf || compressor);
          }
          currentSrc = s;
          exitBypass();
          return true;
        } catch (e) {
          log.warn('Audio source connection failed — entering bypass:', e);
          enterBypass(v);
          return false;
        }
      }

      async function setTarget(v) {
        const enabled = !!(sm.get(P.A_EN) && sm.get(P.APP_ACT));
        const st = v ? getVState(v) : null;

        if (!enabled) {
          if (currentSrc || target) {
            fadeOutThen(() => { disconnectAll(); });
          }
          target = v;
          return;
        }

        if (st && st.audioFailUntil > performance.now()) {
          if (v !== target) fadeOutThen(() => { disconnectAll(); target = v; });
          updateMix(); return;
        }
        const ctxOk = await ensureCtx();
        if (!ctxOk) return;
        if (v && ctx?.state === 'suspended' && !v.paused) ctx.resume().catch(() => {});
        if (v === target) { updateMix(); return; }
        fadeOutThen(() => {
          disconnectAll(); target = v;
          if (!v) { updateMix(); return; }
          if (!connectSource(v)) {
            log.info('[Audio] connectSource failed, audio continues via bypass');
          }
          updateMix();
        });
      }

      /* ── v204 Scene-Aware Audio: 장면 기반 오디오 파라미터 전달 ── */
      function applySceneAudioParams(params) {
        if (!params) return;
        const voiceDb = VSC_CLAMP(Number(params.voiceBoostDb) || 0, -6, 12);
        const bassDb = VSC_CLAMP(Number(params.bassBoostDb) || 0, -6, 12);
        if (Math.abs(voiceDb - __lastSceneAudioParams.voiceBoostDb) < 0.1 &&
            Math.abs(bassDb - __lastSceneAudioParams.bassBoostDb) < 0.1) return;
        __lastSceneAudioParams = { voiceBoostDb: voiceDb, bassBoostDb: bassDb };
        if (__useWorklet && __workletNode) {
          __workletNode.port.postMessage({ type: 'sceneAudioParams', voiceBoostDb: voiceDb, bassBoostDb: bassDb });
        }
      }

      async function destroy() {
        loopTok++;
        if (__audioLoopTimer) { clearTimer(__audioLoopTimer); __audioLoopTimer = 0; }
        if (__workletMetricsTimer) { clearTimer(__workletMetricsTimer); __workletMetricsTimer = 0; }
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

        reconnectAllSourcesToDestination();

        currentSrc = null;
        target = null;

        try { if (ctx && ctx.state !== 'closed') await ctx.close(); } catch (_) {}
        resetCtx();
        makeupDbEma = 0;
      }

      return {
        setTarget,
        update: updateMix,
        hasCtx: () => !!ctx,
        isHooked: () => !!currentSrc,
        isBypassed: () => bypassMode,
        isWorklet: () => __useWorklet,
        getWorkletMetrics: () => __useWorklet ? { ...__workletMetrics } : null,
        applySceneAudioParams,
        destroy
      };
    }

// ═══ END OF PART 2 (v204.0.0-Hybrid) ═══
// ═══ PART 3 START (v204.0.0-Hybrid) — Auto Scene Manager + 7 Intelligent Features Core ═══

        /* ══════════════════════════════════════════════════════════════════
           Auto Scene Manager (v204.0.0: 7 Intelligent Features integrated)
           ══════════════════════════════════════════════════════════════════ */
        function createAutoSceneManager(Store, P, Scheduler) {
          const clamp = VSC_CLAMP;
          const HIST_BINS = 256; const TONE_STEPS = 256;
          const CANVAS_W = CONFIG.IS_MOBILE ? 80 : 112; const CANVAS_H = CONFIG.IS_MOBILE ? 45 : 63;
          const ZONE_COLS = 4, ZONE_ROWS = 4, ZONE_COUNT = 16;

          const ST = Object.freeze({ NORMAL: 0, LOW_KEY: 1, HIGH_KEY: 2, HIGH_CONTRAST: 3, LOW_SAT: 4, SKIN: 5, BACKLIT: 6 });
          const ST_NAMES = ['NORMAL', 'LOW_KEY', 'HIGH_KEY', 'HI_CONT', 'LOW_SAT', 'SKIN', 'BACKLIT'];
          const ST_COUNT = ST_NAMES.length;

          let gpuAnalyzer = null; let gpuInitAttempted = false;
          async function ensureGPUAnalyzer() {
            if (gpuInitAttempted) return gpuAnalyzer?.isReady() || false;
            gpuInitAttempted = true;
            if (!FEATURE_FLAGS.gpuAnalysis) return false;
            try { gpuAnalyzer = createWebGPUAnalyzer(); const ok = await gpuAnalyzer.initGPU(); if (ok) { log.info('[AutoScene] WebGPU analyzer ready — GPU offload active'); return true; } log.info('[AutoScene] WebGPU unavailable — using CPU analysis'); return false; }
            catch (e) { log.warn('[AutoScene] GPU init error:', e.message); return false; }
          }

          const _claheClipped = new Float32Array(HIST_BINS); const _claheCdf = new Float32Array(HIST_BINS); const _claheZoneCDFPool = new Array(ZONE_COUNT); for (let i = 0; i < ZONE_COUNT; i++) _claheZoneCDFPool[i] = new Float32Array(HIST_BINS); const _claheCurveOut = new Float32Array(TONE_STEPS);
          function buildZonalCLAHE(zoneHists, zoneCounts, clipLimit) {
            const bins = HIST_BINS; const zoneCount = ZONE_COLS * ZONE_ROWS;
            for (let z = 0; z < zoneCount; z++) {
              const hist = zoneHists[z]; const n = Math.max(1, zoneCounts[z]); const limit = (n / bins) * clipLimit; const clipped = _claheClipped; let excess = 0;
              for (let i = 0; i < bins; i++) { if (hist[i] > limit) { excess += hist[i] - limit; clipped[i] = limit; } else clipped[i] = hist[i]; }
              const perBin = excess / bins; for (let i = 0; i < bins; i++) clipped[i] += perBin;
              const cdf = _claheCdf; cdf[0] = clipped[0]; for (let i = 1; i < bins; i++) cdf[i] = cdf[i - 1] + clipped[i];
              const cdfMin = cdf[0]; const cdfRange = Math.max(1, cdf[bins - 1] - cdfMin); const normalized = _claheZoneCDFPool[z];
              for (let i = 0; i < bins; i++) normalized[i] = (cdf[i] - cdfMin) / cdfRange;
            }
            const curve = _claheCurveOut;
            for (let i = 0; i < TONE_STEPS; i++) {
              const x = i / (TONE_STEPS - 1); const bin = Math.min(bins - 1, (x * (bins - 1)) | 0); let totalWeight = 0, totalVal = 0;
              for (let zy = 0; zy < ZONE_ROWS; zy++) {
                for (let zx = 0; zx < ZONE_COLS; zx++) {
                  const zi = zy * ZONE_COLS + zx; const n = zoneCounts[zi]; if (n < 4) continue;
                  const cx = (zx + 0.5) / ZONE_COLS, cy = (zy + 0.5) / ZONE_ROWS; const dx = Math.abs(0.5 - cx), dy = Math.abs(0.5 - cy); const dist = Math.sqrt(dx * dx + dy * dy); const w = 1.0 / (0.1 + dist);
                  totalVal += _claheZoneCDFPool[zi][bin] * w; totalWeight += w;
                }
              }
              curve[i] = totalWeight > 0 ? totalVal / totalWeight : x;
            }
            for (let i = 1; i < TONE_STEPS; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
            return curve.slice();
          }

          /* ── v204 Feature #5: Zonal Contrast — BACKLIT centerLift + edgeSuppress ── */
          function buildAdaptiveToneCurve(lumHist, totalSamples, params, zoneHists, zoneCounts, sceneType) {
  const { clipLimit = 2.5, shadowProtect = 0.4, highlightProtect = 0.3, midtoneBoost = 0.0, strength = 0.35, userMods = {} } = params;

  /* [FIX] 수동 보정 계수를 대폭 축소 — 이전에는 이 값이 과도하게 커브를 올렸음 */
  const recMod    = VSC_CLAMP((userMods.recovery || 0) / 100, 0, 1);   // 0~1 정규화
  const shadMod   = VSC_CLAMP((userMods.shadow || 0) / 100, 0, 1);     // 0~1 정규화
  const brtMod    = VSC_CLAMP((userMods.brightness || 0) / 100, 0, 1); // 0~1 정규화

  /* [FIX] clipLimit 증가폭 제한 — 이전: recMod * 0.8 (raw값 기준이라 최대 80!) */
  const finalClipLimit = clipLimit + (recMod * 0.6);

  const equalized = buildZonalCLAHE(zoneHists, zoneCounts, finalClipLimit);
  const identity = new Float32Array(TONE_STEPS);
  for (let i = 0; i < TONE_STEPS; i++) identity[i] = i / (TONE_STEPS - 1);
  const raw = new Float32Array(TONE_STEPS);

  /* [FIX] 보호 계수 변화량 축소 */
  const finalShadowProtect    = Math.max(0, shadowProtect - (shadMod * 0.12));
  const finalHighlightProtect = Math.max(0, highlightProtect - (brtMod * 0.08));

  /* [FIX] shadowLift 계수 대폭 축소: 0.055 → 0.025 */
  const shadowLift = shadMod * 0.025;

  /* ── v204: BACKLIT 전용 zonal contrast 보강 ── */
  const zonalContrastEn = !!Store.get(P.APP_ZONAL_CONTRAST);
  let centerLift = 0, edgeSuppress = 0;
  if (zonalContrastEn && sceneType === ST.BACKLIT) {
    const centerIndices = [5, 6, 9, 10];
    let cBrightSum = 0, cCount = 0, eBrightSum = 0, eCount = 0;
    for (let z = 0; z < ZONE_COUNT; z++) {
      if (zoneCounts[z] < 4) continue;
      let zBright = 0; for (let b = 0; b < HIST_BINS; b++) zBright += b * zoneHists[z][b];
      zBright /= Math.max(1, zoneCounts[z]);
      if (centerIndices.includes(z)) { cBrightSum += zBright; cCount++; }
      else { eBrightSum += zBright; eCount++; }
    }
    const cAvg = cCount > 0 ? cBrightSum / cCount / 255 : 0.5;
    const eAvg = eCount > 0 ? eBrightSum / eCount / 255 : 0.5;
    const gap = eAvg - cAvg;
    if (gap > 0.06) {
      centerLift  = clamp(gap * 1.8, 0, 0.25);
      edgeSuppress = clamp(gap * 0.6, 0, 0.12);
    }
  }

  for (let i = 0; i < TONE_STEPS; i++) {
    const x = i / (TONE_STEPS - 1);
    const eq = equalized[i], id = identity[i];
    let regionWeight = 1.0;
    if (x < 0.18) {
      const t = x / 0.18;
      regionWeight = 1.0 - finalShadowProtect * (1 - t * t);
    } else if (x > 0.82) {
      const t = (x - 0.82) / 0.18;
      regionWeight = 1.0 - finalHighlightProtect * (t * t);
    }
    let midBoost = 0;
    if (Math.abs(midtoneBoost) > 0.001) {
      const midW = Math.exp(-((x - 0.5) * (x - 0.5)) / (2 * 0.14 * 0.14));
      midBoost = midtoneBoost * midW * 0.15;
    }
    const effectiveStrength = strength * regionWeight;

    /* [FIX] lowEndLift 범위를 좁히고 감쇠 곡선 적용 */
    const lowEndLift = (x < 0.25 && shadowLift > 0)
      ? shadowLift * Math.pow(1 - x / 0.25, 2)  // 제곱 감쇠 — 더 부드럽게
      : 0;

    /* ── v204: BACKLIT zonal contrast injection ── */
    let zonalBoost = 0;
    if (centerLift > 0 && x < 0.55) {
      const t = x / 0.55;
      zonalBoost = centerLift * (1 - t) * (1 - t);
    }
    if (edgeSuppress > 0 && x > 0.70) {
      const t = (x - 0.70) / 0.30;
      zonalBoost -= edgeSuppress * t * t;
    }

    /* [FIX] brightness 수동값의 전체 리프트를 매우 작게 — 이전에는 전 구간에 걸려서 하이라이트도 올림 */
    const globalBrightLift = brtMod * 0.012;  // 이전: 없거나 과도

    raw[i] = clamp(
      id * (1 - effectiveStrength) + eq * effectiveStrength
      + midBoost + lowEndLift + zonalBoost + globalBrightLift,
      0, 1
    );
  }

  /* 스무딩 + 모노토닉 보장 */
  const curve = new Float32Array(TONE_STEPS);
  curve[0] = raw[0];
  curve[TONE_STEPS - 1] = raw[TONE_STEPS - 1];
  for (let i = 1; i < TONE_STEPS - 1; i++) {
    curve[i] = raw[i] * 0.6 + (raw[i - 1] + raw[i + 1]) * 0.2;
  }
  for (let i = 1; i < TONE_STEPS; i++) {
    if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1];
  }

  /* [FIX] 하이라이트 클램핑 강화 — 밝은 영역이 1.0에 가까워지는 것 방지 */
  const n = Math.max(1, totalSamples);
  let pureBlackCount = 0;
  for (let i = 0; i <= 5; i++) pureBlackCount += lumHist[i];
  const pureBlackRatio = pureBlackCount / n;

  if (pureBlackRatio > 0.03) {
    const guardRange = 10;
    const guardStrength = clamp(pureBlackRatio * 6, 0.25, 0.90);
    for (let i = 0; i < guardRange; i++) {
      const x = i / (TONE_STEPS - 1);
      const t = i / guardRange;
      const blendToIdentity = guardStrength * (1 - t * t);
      curve[i] = curve[i] * (1 - blendToIdentity) + x * blendToIdentity;
    }
    for (let i = 1; i < TONE_STEPS; i++) {
      if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1];
    }
  }

  /* [FIX 추가] 하이라이트 보호 — 상위 15% 구간의 과도한 리프트 억제 */
  const hiGuardStart = Math.floor(TONE_STEPS * 0.85);
  for (let i = hiGuardStart; i < TONE_STEPS; i++) {
    const x = i / (TONE_STEPS - 1);
    const identityVal = x;
    const maxAllowedLift = 0.04;  // identity 대비 최대 4% 밝기 증가만 허용
    if (curve[i] > identityVal + maxAllowedLift) {
      curve[i] = identityVal + maxAllowedLift;
    }
  }
  for (let i = 1; i < TONE_STEPS; i++) {
    if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1];
  }

  return curve;
}

          /* ── v204 Feature #3: Skin-tone Preservation — 강화된 채널 댐핑 ── */
          function computeChannelBalance(rHist, gHist, bHist, totalSamples, skinRatio, hiLumaRBratio) {
            const correctionStrength = 0.22; const n = Math.max(1, totalSamples); let rMean = 0, gMean = 0, bMean = 0;
            for (let i = 0; i < HIST_BINS; i++) { const v = i / (HIST_BINS - 1); rMean += v * rHist[i]; gMean += v * gHist[i]; bMean += v * bHist[i]; }
            rMean /= n; gMean /= n; bMean /= n; const avgMean = (rMean + gMean + bMean) / 3; if (avgMean < 0.01) return { rGain: 1, gGain: 1, bGain: 1 };

            /* ── v204: skinProtect 토글 확인 후 댐핑 강화 ── */
            const skinProtectEn = !!Store.get(P.APP_SKIN_PROTECT);
            const effectiveSkinRatio = skinProtectEn ? clamp(skinRatio || 0, 0, 0.5) : clamp(skinRatio || 0, 0, 0.4);
            const skinDampen = effectiveSkinRatio / (skinProtectEn ? 0.35 : 0.4);
            const rMul = skinProtectEn ? 0.40 * (1 - skinDampen * 0.80) : 0.50 * (1 - skinDampen * 0.65);

            let rGain = 1 + (avgMean / Math.max(0.01, rMean) - 1) * (correctionStrength * rMul); let gGain = 1 + (avgMean / Math.max(0.01, gMean) - 1) * (correctionStrength * 0.80); let bGain = 1 + (avgMean / Math.max(0.01, bMean) - 1) * correctionStrength;
            if (Number.isFinite(hiLumaRBratio) && hiLumaRBratio > 0) { const deviation = clamp(hiLumaRBratio - 1.0, -0.4, 0.4); const tempCorr = deviation * 0.10; rGain -= tempCorr * 0.5; bGain += tempCorr * 0.5; }

            /* ── v204: skinProtect ON일 때 추가 온도 보정 ── */
            if (skinProtectEn && effectiveSkinRatio > 0.05) {
              const warmShift = clamp(effectiveSkinRatio * 0.08, 0, 0.04);
              rGain += warmShift * 0.5;
              bGain -= warmShift * 0.3;
            }

            return { rGain: clamp(rGain, 0.84, 1.16), gGain: clamp(gGain, 0.92, 1.08), bGain: clamp(bGain, 0.80, 1.20) };
          }

          const __fuzzyScores = new Float64Array(ST_COUNT); const __fuzzyEma = new Float64Array(ST_COUNT); let __fuzzyInited = false;
          function classifySceneFuzzy(stats, zoneStats) {
            const scores = __fuzzyScores; scores.fill(0); const br = stats.bright, ct = stats.contrast, ch = stats.chroma, sk = stats.skinRatio;
            scores[ST.NORMAL] = 1.0;
            if (br < 0.35) scores[ST.LOW_KEY] += (0.35 - br) / 0.35 * 3.5;
            if (ct < 0.20) scores[ST.LOW_KEY] += (0.20 - ct) / 0.20 * 1.8;
            if (br > 0.60) scores[ST.HIGH_KEY] += (br - 0.60) / 0.40 * 3.2;
            if (ct > 0.25) scores[ST.HIGH_CONTRAST] += (ct - 0.25) / 0.25 * 2.8;
            if (ch < 0.12) scores[ST.LOW_SAT] += (0.12 - ch) / 0.12 * 2.4;
            if (sk > 0.03) scores[ST.SKIN] += sk / 0.12 * 2.8;
            if (zoneStats) { const centerBr = zoneStats.centerBright, edgeBr = zoneStats.edgeAvgBright; if (edgeBr > 0.38 && centerBr < 0.38) { const gap = edgeBr - centerBr; if (gap > 0.06) scores[ST.BACKLIT] += gap / 0.18 * 3.8; } }
            const emaAlpha = 0.14;
            if (!__fuzzyInited) { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] = scores[i]; __fuzzyInited = true; } else { for (let i = 0; i < ST_COUNT; i++) __fuzzyEma[i] += (scores[i] - __fuzzyEma[i]) * emaAlpha; }
            let bestIdx = 0, bestVal = __fuzzyEma[0]; for (let i = 1; i < ST_COUNT; i++) { if (__fuzzyEma[i] > bestVal) { bestVal = __fuzzyEma[i]; bestIdx = i; } } return bestIdx;
          }

          /* ── v204 Feature #2: Adaptive Saturation — satTarget 동적 조절 추가 ── */
          const SCENE_TONE_PARAMS = Object.freeze({
            [ST.NORMAL]:        { clipLimit: 3.0, shadowProtect: 0.22, highlightProtect: 0.20, midtoneBoost: 0.08, strength: 0.34, satTarget: 1.10 },
            [ST.LOW_KEY]:       { clipLimit: 3.2, shadowProtect: 0.35, highlightProtect: 0.14, midtoneBoost: 0.10, strength: 0.38, satTarget: 1.08 },
            [ST.HIGH_KEY]:      { clipLimit: 2.6, shadowProtect: 0.18, highlightProtect: 0.40, midtoneBoost: -0.06, strength: 0.28, satTarget: 1.10 },
            [ST.HIGH_CONTRAST]: { clipLimit: 2.4, shadowProtect: 0.32, highlightProtect: 0.32, midtoneBoost: 0.0,  strength: 0.24, satTarget: 1.08 },
            [ST.LOW_SAT]:       { clipLimit: 3.4, shadowProtect: 0.22, highlightProtect: 0.20, midtoneBoost: 0.08, strength: 0.40, satTarget: 1.22 },
            [ST.SKIN]:          { clipLimit: 2.8, shadowProtect: 0.30, highlightProtect: 0.26, midtoneBoost: 0.05, strength: 0.26, satTarget: 1.06 },
            [ST.BACKLIT]:       { clipLimit: 3.5, shadowProtect: 0.12, highlightProtect: 0.35, midtoneBoost: 0.14, strength: 0.42, satTarget: 1.12 }
          });

          /* v204: chroma 기반 적응형 채도 계산 */
          function computeAdaptiveSatTarget(baseSatTarget, chroma) {
            if (!Store.get(P.APP_ADAPT_SAT)) return baseSatTarget;
            if (chroma > 0.35) {
              const excess = clamp((chroma - 0.35) / 0.30, 0, 1);
              return clamp(baseSatTarget - excess * 0.20, 0.90, baseSatTarget);
            }
            if (chroma < 0.08) {
              const deficit = clamp((0.08 - chroma) / 0.08, 0, 1);
              return clamp(baseSatTarget + deficit * 0.12, baseSatTarget, 1.35);
            }
            return baseSatTarget;
          }

          let prevToneCurve = null; let prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; let prevSatMul = 1.0;
          const _interpBufA = new Float32Array(TONE_STEPS); const _interpBufB = new Float32Array(TONE_STEPS); let _interpActive = 0;
          function interpolateCurves(prev, next, alpha) { if (!prev) { const out = _interpActive === 0 ? _interpBufA : _interpBufB; out.set(next); _interpActive ^= 1; return out; } const out = _interpActive === 0 ? _interpBufA : _interpBufB; for (let i = 0; i < TONE_STEPS; i++) out[i] = prev[i] + (next[i] - prev[i]) * alpha; _interpActive ^= 1; return out; }
          function interpolateGains(prev, next, alpha) { return { rGain: prev.rGain + (next.rGain - prev.rGain) * alpha, gGain: prev.gGain + (next.gGain - prev.gGain) * alpha, bGain: prev.bGain + (next.bGain - prev.bGain) * alpha }; }

          const CUT_HIST_LEN = 20; const cutScores = new CircularBuffer(CUT_HIST_LEN); const gradualScores = new CircularBuffer(10);
          function detectTransition(stats, prev) {
            if (!prev) return { isCut: false, isFade: false, score: 0 };
            const motionDelta = Math.abs((stats.motionSAD || 0) - (prev.motionSAD || 0));
            const score = Math.abs(stats.bright - prev.bright) * 1.3 + Math.abs(stats.contrast - prev.contrast) * 0.7 + Math.abs(stats.chroma - prev.chroma) * 0.5 + Math.abs(stats.edge - prev.edge) * 0.3 + motionDelta * 0.35;
            cutScores.push(score);
            const sorted = cutScores.getSorted();
            const q90 = sorted[Math.floor(sorted.length * 0.90)] || 0.15; const cutThr = Math.max(0.08, Math.min(0.24, q90 * 1.20)); const isCut = score > cutThr;
            gradualScores.push(score); const gradualSum = gradualScores.reduce((a, b) => a + b, 0); const isFade = !isCut && gradualSum > cutThr * 3.0 && gradualScores.length >= 5;
            return { isCut, isFade, score };
          }

          let flickerCount = 0, lastCurveDir = 0;
          const FLICKER_MAX = 8; const FLICKER_DECAY = 0.9;

          /* ── v204 Feature #6: Independent Temporal Alphas ── */
          function getTemporalAlphas(isCut, isFade) {
            const smoothTransEn = !!Store.get(P.APP_SMOOTH_TRANS);
            const flickerDampen = 1 / (1 + flickerCount * 0.7);
            if (!smoothTransEn) {
              const base = isCut ? 0.58 : (isFade ? 0.22 : 0.12);
              const single = base * flickerDampen;
              return { bright: single, color: single, sat: single };
            }
            if (isCut) {
              return {
                bright: 0.65 * flickerDampen,
                color: 0.40 * flickerDampen,
                sat: 0.35 * flickerDampen
              };
            }
            if (isFade) {
              return {
                bright: 0.28 * flickerDampen,
                color: 0.16 * flickerDampen,
                sat: 0.14 * flickerDampen
              };
            }
            return {
              bright: 0.14 * flickerDampen,
              color: 0.08 * flickerDampen,
              sat: 0.07 * flickerDampen
            };
          }

          let __prevLumBuf = null, __curLumBuf = null, __curLumBufSize = 0;

          let __zoneLutCache = null;
          function getZoneLuts(sw, sh) {
            if (__zoneLutCache?.w === sw && __zoneLutCache.h === sh) return __zoneLutCache;
            const maxZx = ZONE_COLS - 1, maxZy = ZONE_ROWS - 1;
            const invZoneW = 1 / Math.max(1, Math.floor(sw / ZONE_COLS));
            const invZoneH = 1 / Math.max(1, Math.floor(sh / ZONE_ROWS));
            const zxLut = new Uint8Array(sw); const zyLut = new Uint8Array(sh);
            for (let x = 0; x < sw; x++) zxLut[x] = Math.min(maxZx, (x * invZoneW) | 0);
            for (let y = 0; y < sh; y++) zyLut[y] = Math.min(maxZy, (y * invZoneH) | 0);
            return (__zoneLutCache = { w: sw, h: sh, zxLut, zyLut });
          }

          const _pool_lumHist = new Uint32Array(HIST_BINS); const _pool_rHist = new Uint32Array(HIST_BINS); const _pool_gHist = new Uint32Array(HIST_BINS); const _pool_bHist = new Uint32Array(HIST_BINS);
          const _pool_zoneCounts = new Uint32Array(ZONE_COUNT); const _pool_zoneHists = Array.from({ length: ZONE_COUNT }, () => new Uint32Array(HIST_BINS));
          const _pool_zoneBrightSum = new Float32Array(ZONE_COUNT);

          function computeFullAnalysis(data, sw, sh) {
            const step = 2; let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0, skinCount = 0, edgePairCount = 0;
            const lumHist = _pool_lumHist; lumHist.fill(0); const rHist = _pool_rHist; rHist.fill(0); const gHist = _pool_gHist; gHist.fill(0); const bHist = _pool_bHist; bHist.fill(0);
            const zoneCounts = _pool_zoneCounts; zoneCounts.fill(0); const zoneHists = _pool_zoneHists; for (let z = 0; z < ZONE_COUNT; z++) zoneHists[z].fill(0);
            const zoneBrightSum = _pool_zoneBrightSum; zoneBrightSum.fill(0);
            const pixelCount = sw * sh; if (!__curLumBuf || __curLumBufSize !== pixelCount) { __curLumBuf = new Uint8Array(pixelCount); __curLumBufSize = pixelCount; }
            const curLum = __curLumBuf; let hiLumaRSum = 0, hiLumaBSum = 0, hiLumaCount = 0; const HI_LUMA_THR = 180;
            const { zxLut, zyLut } = getZoneLuts(sw, sh);

            const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);

            const maxX = sw - step;
            for (let y = 0; y < sh; y += step) {
              const rowPixelOffset = y * sw; const zyBase = zyLut[y] << 2;
              for (let x = 0; x <= maxX; x += step) {
                const pi = rowPixelOffset + x; const px = u32[pi];
                const r = px & 0xFF, g = (px >>> 8) & 0xFF, b = (px >>> 16) & 0xFF;
                const l = (r * 54 + g * 183 + b * 18 + 128) >> 8;
                const rg = r - g; const mx = (rg > 0 ? r : g); const mn = (rg > 0 ? g : r);
                const finalMx = mx > b ? mx : b; const finalMn = mn < b ? mn : b;
                curLum[pi] = l; sumChroma += finalMx - finalMn; sum += l; sum2 += l * l; count++;
                lumHist[l]++; rHist[r]++; gHist[g]++; bHist[b]++;
                const nx = x + step;
                if (nx < sw) {
                  const npx = u32[rowPixelOffset + nx];
                  const nl = ((npx & 0xFF) * 54 + ((npx >>> 8) & 0xFF) * 183 + ((npx >>> 16) & 0xFF) * 18 + 128) >> 8;
                  const diff = l - nl; sumEdge += diff < 0 ? -diff : diff; edgePairCount++;
                }
                if (rg > 12 && r >= 80 && g >= 35 && b >= 20 && r > b) skinCount++;
                const zi = zyBase + zxLut[x];
                zoneHists[zi][l]++; zoneCounts[zi]++; zoneBrightSum[zi] += l;
                if (l >= HI_LUMA_THR && b > 10) { hiLumaRSum += r; hiLumaBSum += b; hiLumaCount++; }
              }
            }

            let motionSAD = 0;
            if (__prevLumBuf && __prevLumBuf.length === pixelCount) {
              let sadSum = 0, sadCount = 0; const bw = 8, bh = 8;
              for (let by = 0; by + bh <= sh; by += bh) {
                for (let bx = 0; bx + bw <= sw; bx += bw) {
                  let blockSad = 0;
                  for (let dy = 0; dy < bh; dy += step) { for (let dx = 0; dx < bw; dx += step) { const pi = (by + dy) * sw + (bx + dx); blockSad += Math.abs(curLum[pi] - __prevLumBuf[pi]); } }
                  sadSum += blockSad; sadCount++;
                }
              }
              motionSAD = sadCount > 0 ? (sadSum / sadCount) / 255 : 0;
            }
            if (!__prevLumBuf || __prevLumBuf.length !== pixelCount) __prevLumBuf = new Uint8Array(pixelCount);
            __prevLumBuf.set(curLum);

            const n = Math.max(1, count); const mean = sum / n, std = Math.sqrt(Math.max(0, (sum2 / n) - mean * mean));
            const centerIndices = [5, 6, 9, 10]; let centerSum = 0, centerCnt = 0;
            for (const ci of centerIndices) { if (zoneCounts[ci] > 0) { centerSum += zoneBrightSum[ci] / zoneCounts[ci]; centerCnt++; } }
            const centerBright = centerCnt > 0 ? centerSum / centerCnt / 255 : mean / 255;
            let edgeSum = 0, edgeCount = 0;
            for (let z = 0; z < ZONE_COUNT; z++) { if (centerIndices.includes(z)) continue; if (zoneCounts[z] > 0) { edgeSum += zoneBrightSum[z] / zoneCounts[z]; edgeCount++; } }
            const edgeAvgBright = edgeCount > 0 ? edgeSum / edgeCount / 255 : mean / 255;
            const hiLumaRBratio = hiLumaCount >= 10 ? hiLumaRSum / Math.max(1, hiLumaBSum) : NaN;

            return {
              bright: mean / 255, contrast: std / 64, chroma: sumChroma / n / 255, edge: edgePairCount > 0 ? sumEdge / edgePairCount : 0, motionSAD, skinRatio: skinCount / n,
              centerBright, edgeAvgBright, hiLumaRBratio, lumHist, rHist, gHist, bHist, totalSamples: count,
              zoneHists, zoneCounts, zoneStats: { centerBright, edgeAvgBright }, _gpuPath: false
            };
          }

          function generateManualMods() {
            return { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null };
          }

          function updateManual() {
            AUTO.cur = generateManualMods();
            Scheduler.request(true);
          }

          const AUTO = {
            running: false, canvasW: CANVAS_W, canvasH: CANVAS_H, cur: { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null },
            lastStats: null, statsEma: null, statsAlpha: 0.08, motionEma: 0, motionAlpha: 0.20, motionThresh: 0.012, motionFrames: 0,
            drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0, boostMs: 700, minFps: 1.0, maxFps: CONFIG.IS_MOBILE ? 6 : 12, curFps: 2,
            _sceneType: ST.NORMAL, _sceneStable: 0, _sceneTypeEma: ST.NORMAL, _lastMean: 0, _framesSinceUpdate: 0, _gpuActive: false,
            _lastBright: 0.5, _lastMotionSAD: 0
          };

          const _fpsHistBuf = new CircularBuffer(6); let drmRetryCount = 0; const MAX_DRM_RETRIES = 3; let cv, cvCtx;
          if (typeof OffscreenCanvas === 'function') { try { cv = new OffscreenCanvas(CANVAS_W, CANVAS_H); cvCtx = cv.getContext('2d', { willReadFrequently: true, alpha: false }); } catch (_) { cv = null; cvCtx = null; } }
          if (!cvCtx) { cv = document.createElement('canvas'); cv.width = CANVAS_W; cv.height = CANVAS_H; try { cvCtx = cv.getContext('2d', { willReadFrequently: true, alpha: false }); } catch (_) { try { cvCtx = cv.getContext('2d', { willReadFrequently: true }); } catch (__) {} } }
          let __asRvfcId = 0, __asRvfcVideo = null, __asTimeoutId = 0;

          function scheduleNext(v, delayMs) {
            if (!AUTO.running || __globalSig.aborted) return;
            if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; }
            if (__asRvfcId && __asRvfcVideo && typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') { try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {} __asRvfcId = 0; __asRvfcVideo = null; }
            const useRvfc = v && !v.paused && typeof v.requestVideoFrameCallback === 'function';
            const RVFC_THRESHOLD = 200;
            if (delayMs > RVFC_THRESHOLD) {
              const waitMs = delayMs - (useRvfc ? 80 : 0);
              __asTimeoutId = setTimer(() => {
                __asTimeoutId = 0; if (!AUTO.running || __globalSig.aborted) return;
                if (useRvfc) { __asRvfcVideo = v; __asRvfcId = v.requestVideoFrameCallback((now, metadata) => { __asRvfcId = 0; __asRvfcVideo = null; if (metadata && Number.isFinite(metadata.presentedFrames)) { const dropped = metadata.expectedDisplayTime - now; if (dropped > 33) AUTO.curFps = Math.max(AUTO.minFps, AUTO.curFps * 0.8); } loop(); }); } else loop();
              }, Math.max(16, waitMs)); return;
            }
            if (useRvfc) {
              const target = performance.now() + Math.max(0, delayMs | 0); __asRvfcVideo = v;
              __asRvfcId = v.requestVideoFrameCallback((now, metadata) => {
                __asRvfcId = 0; __asRvfcVideo = null; if (metadata && Number.isFinite(metadata.presentedFrames)) { const dropped = metadata.expectedDisplayTime - now; if (dropped > 33) AUTO.curFps = Math.max(AUTO.minFps, AUTO.curFps * 0.8); }
                const remain = target - performance.now(); if (remain > 6) { scheduleNext(v, remain); return; } loop();
              }); return;
            }
            __asTimeoutId = setTimer(loop, Math.max(16, delayMs | 0));
          }

          let _fpsMotionAvg = 0;
          function adaptiveFps(motionSAD, isCut, isFade) {
            _fpsHistBuf.push(motionSAD);
            const alpha = 1 / Math.min(_fpsHistBuf.length, 6);
            _fpsMotionAvg = _fpsMotionAvg * (1 - alpha) + motionSAD * alpha;
            let target = _fpsMotionAvg < 0.02 ? 3 : (_fpsMotionAvg < 0.08 ? 4 + _fpsMotionAvg / 0.08 * 2 : 6 + Math.min((_fpsMotionAvg - 0.08) / 0.2, 1) * 4);
            if (isCut) target = AUTO.maxFps; else if (isFade) target = Math.max(target, 5); AUTO.curFps += clamp(target - AUTO.curFps, -1.5, 1.5); return clamp(AUTO.curFps, AUTO.minFps, AUTO.maxFps);
          }

          async function captureSceneFrame(v) {
            if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }
            if (typeof createImageBitmap === 'function') { try { const bmp = await createImageBitmap(v, { resizeWidth: CANVAS_W, resizeHeight: CANVAS_H, resizeQuality: 'low' }); cvCtx.drawImage(bmp, 0, 0); bmp.close(); return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H); } catch (_) {} }
            if (typeof VideoFrame === 'function') { try { const frame = new VideoFrame(v, { timestamp: (v.currentTime * 1e6) | 0 }); cvCtx.drawImage(frame, 0, 0, CANVAS_W, CANVAS_H); frame.close(); return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H); } catch (_) {} }
            try { cvCtx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H); return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H); } catch (_) { return null; }
          }

          let __gpuConsecutiveFailures = 0;
          const GPU_MAX_CONSECUTIVE_FAILURES = 5;
          const STATIC_SCENE_FORCE_INTERVAL = 20;

          async function analyzeImageData(imgData, sw, sh) {
            if (AUTO._gpuActive && gpuAnalyzer && gpuAnalyzer.isReady() && __gpuConsecutiveFailures < GPU_MAX_CONSECUTIVE_FAILURES) {
              try {
                const gpuResult = await gpuAnalyzer.analyzeFrame(imgData.data, sw, sh);
                if (gpuResult) { __gpuConsecutiveFailures = 0; return gpuResult; }
                __gpuConsecutiveFailures++;
              } catch (e) {
                __gpuConsecutiveFailures++;
                log.debug(`[AutoScene] GPU analysis failed (${__gpuConsecutiveFailures}/${GPU_MAX_CONSECUTIVE_FAILURES}):`, e.message);
                if (__gpuConsecutiveFailures >= GPU_MAX_CONSECUTIVE_FAILURES) {
                  AUTO._gpuActive = false;
                  log.warn('[AutoScene] GPU disabled after consecutive failures, using CPU');
                  try { if (typeof showOSD === 'function') showOSD('GPU 분석 비활성화 → CPU', 2000); } catch (_) {}
                }
              }
            }
            return computeFullAnalysis(imgData.data, sw, sh);
          }

          /* ── v204 Feature #4: Intelligent Letterbox Auto-Zoom ── */
          let __letterboxState = { detected: false, ratio: 0, lastCheck: 0, notified: false, stableFrames: 0, lastDetectedRatio: 0, autoZoomed: false };
          const LETTERBOX_CHECK_INTERVAL = 3000;
          const LETTERBOX_STABLE_THRESHOLD = 3;

          function detectLetterbox(lumHist, zoneHists, zoneCounts) {
            const now = performance.now();
            if (now - __letterboxState.lastCheck < LETTERBOX_CHECK_INTERVAL) return;
            __letterboxState.lastCheck = now;

            const topZones = [0, 1, 2, 3]; const bottomZones = [12, 13, 14, 15]; const middleZones = [4, 5, 6, 7, 8, 9, 10, 11];

            let topDark = 0, topTotal = 0;
            for (const zi of topZones) {
              if (zoneCounts[zi] < 4) continue;
              let darkCount = 0; for (let b = 0; b <= 10; b++) darkCount += zoneHists[zi][b];
              topDark += darkCount; topTotal += zoneCounts[zi];
            }

            let bottomDark = 0, bottomTotal = 0;
            for (const zi of bottomZones) {
              if (zoneCounts[zi] < 4) continue;
              let darkCount = 0; for (let b = 0; b <= 10; b++) darkCount += zoneHists[zi][b];
              bottomDark += darkCount; bottomTotal += zoneCounts[zi];
            }

            let middleDark = 0, middleTotal = 0;
            for (const zi of middleZones) {
              if (zoneCounts[zi] < 4) continue;
              let darkCount = 0; for (let b = 0; b <= 10; b++) darkCount += zoneHists[zi][b];
              middleDark += darkCount; middleTotal += zoneCounts[zi];
            }

            const topBlackRatio = topTotal > 0 ? topDark / topTotal : 0;
            const bottomBlackRatio = bottomTotal > 0 ? bottomDark / bottomTotal : 0;
            const middleBlackRatio = middleTotal > 0 ? middleDark / middleTotal : 0;
            const isLetterbox = topBlackRatio > 0.85 && bottomBlackRatio > 0.85 && middleBlackRatio < 0.50;

            /* ── v204: 비율 추정 ── */
            let estimatedRatio = 0;
            if (isLetterbox) {
              const topBarFraction = topBlackRatio > 0.90 ? 0.25 : 0.20;
              const bottomBarFraction = bottomBlackRatio > 0.90 ? 0.25 : 0.20;
              const contentHeight = 1.0 - topBarFraction - bottomBarFraction;
              if (contentHeight > 0.1) {
                estimatedRatio = 16 / (9 * contentHeight);
                if (estimatedRatio > 2.20 && estimatedRatio < 2.50) estimatedRatio = 2.35;
                else if (estimatedRatio > 1.80 && estimatedRatio <= 2.20) estimatedRatio = 2.0;
                else if (estimatedRatio > 2.50 && estimatedRatio < 2.80) estimatedRatio = 2.66;
                else estimatedRatio = clamp(estimatedRatio, 1.78, 3.0);
              }
            }

            if (isLetterbox) {
              if (Math.abs(estimatedRatio - __letterboxState.lastDetectedRatio) < 0.15) {
                __letterboxState.stableFrames++;
              } else {
                __letterboxState.stableFrames = 1;
                __letterboxState.lastDetectedRatio = estimatedRatio;
              }

              if (__letterboxState.stableFrames >= LETTERBOX_STABLE_THRESHOLD && !__letterboxState.detected) {
                __letterboxState.detected = true;
                __letterboxState.ratio = estimatedRatio;

                /* ── v204: autoZoom 토글 확인 후 자동 줌 ── */
                const autoZoomEn = !!Store.get(P.APP_AUTO_ZOOM);
                if (autoZoomEn && !__letterboxState.autoZoomed) {
                  const zm = window[VSC_INTERNAL_SYM]?.ZoomManager;
                  const v = window[VSC_INTERNAL_SYM]?.getActiveVideo?.();
                  if (zm && v && v.isConnected) {
                    const zoomScale = clamp(estimatedRatio / (16 / 9), 1.0, 1.50);
                    if (zoomScale > 1.02) {
                      zm.zoomTo(v, zoomScale);
                      __letterboxState.autoZoomed = true;
                      try { if (typeof showOSD === 'function') showOSD(`레터박스 자동 줌 ${zoomScale.toFixed(2)}× (≈${estimatedRatio.toFixed(2)}:1)`, 2500); } catch (_) {}
                    }
                  }
                } else if (!autoZoomEn && !__letterboxState.notified) {
                  __letterboxState.notified = true;
                  try { if (typeof showOSD === 'function') showOSD(`레터박스 감지 (≈${estimatedRatio.toFixed(1)}:1) — Alt+Z 줌 후 Alt+Wheel 조절`, 3000); } catch (_) {}
                }
              }
            } else {
              if (__letterboxState.detected) {
                __letterboxState.stableFrames = 0;
                /* ── v204: 레터박스 해제 시 자동 줌 리셋 ── */
                if (__letterboxState.autoZoomed) {
                  const zm = window[VSC_INTERNAL_SYM]?.ZoomManager;
                  const v = window[VSC_INTERNAL_SYM]?.getActiveVideo?.();
                  if (zm && v && v.isConnected && zm.isZoomed(v)) {
                    zm.resetZoom(v);
                    try { if (typeof showOSD === 'function') showOSD('레터박스 해제 → 줌 리셋', 1500); } catch (_) {}
                  }
                  __letterboxState.autoZoomed = false;
                }
                __letterboxState.detected = false;
                __letterboxState.notified = false;
              }
            }
          }

          /* ── v204 Feature #7: HDR Tone-Mapping ── */
          let __hdrState = { detected: false, transferFn: 'sdr', maxCLL: 1000, maxFALL: 400 };

          function detectHDRMetadata(video) {
            if (!Store.get(P.APP_HDR_TONEMAP)) return false;
            if (!video) return false;
            try {
              if (typeof VideoFrame === 'function') {
                const vf = new VideoFrame(video, { timestamp: 0 });
                const cs = vf.colorSpace;
                vf.close();
                if (cs && (cs.transfer === 'pq' || cs.transfer === 'hlg')) {
                  __hdrState.detected = true;
                  __hdrState.transferFn = cs.transfer;
                  return true;
                }
              }
            } catch (_) {}
            const ms = video.getVideoPlaybackQuality?.();
            if (ms && typeof video.mozHasHDR === 'boolean' && video.mozHasHDR) {
              __hdrState.detected = true;
              __hdrState.transferFn = 'pq';
              return true;
            }
            __hdrState.detected = false;
            __hdrState.transferFn = 'sdr';
            return false;
          }

          function pqEOTF(v) {
            const m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
            const vp = Math.pow(Math.max(0, v), 1 / m2);
            const num = Math.max(0, vp - c1);
            const den = c2 - c3 * vp;
            return Math.pow(num / Math.max(1e-10, den), 1 / m1) * 10000;
          }

          function hlgOETFInv(v) {
            const a = 0.17883277, b = 0.28466892, c = 0.55991073;
            if (v <= 0.5) return v * v / 3;
            return (Math.exp((v - c) / a) + b) / 12;
          }

          function buildHDRToneMappingCurve(transferFn, maxCLL, targetNits) {
            const steps = TONE_STEPS;
            const curve = new Float32Array(steps);
            const peakNits = clamp(maxCLL || 1000, 400, 10000);
            const tgtNits = targetNits || 200;

            for (let i = 0; i < steps; i++) {
              const x = i / (steps - 1);
              let linearNits;
              if (transferFn === 'pq') {
                linearNits = pqEOTF(x);
              } else if (transferFn === 'hlg') {
                linearNits = hlgOETFInv(x) * peakNits;
              } else {
                linearNits = x * peakNits;
              }
              const normalized = linearNits / peakNits;
              const knee = tgtNits / peakNits;
              let mapped;
              if (normalized <= knee) {
                mapped = normalized / knee * 0.85;
              } else {
                const excess = (normalized - knee) / (1 - knee);
                const compressed = 1.0 - Math.exp(-excess * 2.5);
                mapped = 0.85 + compressed * 0.15;
              }
              const gamma22 = Math.pow(clamp(mapped, 0, 1), 1 / 2.2);
              curve[i] = clamp(gamma22, 0, 1);
            }
            for (let i = 1; i < steps; i++) { if (curve[i] < curve[i - 1]) curve[i] = curve[i - 1]; }
            return curve;
          }

          /* ── v204: Scene-Aware Audio 파라미터 계산 ── */
          function computeSceneAudioParams(stats, sceneType) {
            let voiceBoostDb = 0, bassBoostDb = 0;
            const motion = stats?.motionSAD || 0;
            const bright = stats?.bright || 0.5;
            if (sceneType === ST.LOW_KEY && motion < 0.03) {
              voiceBoostDb = 4.0;
              bassBoostDb = -1.0;
            } else if (motion > 0.12 && bright > 0.45) {
              voiceBoostDb = -1.5;
              bassBoostDb = 3.5;
            } else if (sceneType === ST.SKIN && motion < 0.05) {
              voiceBoostDb = 3.0;
              bassBoostDb = 0;
            }
            return { voiceBoostDb, bassBoostDb };
          }

          async function loop() {
            if (!AUTO.running || __globalSig.aborted) return;

            if (globalThis.scheduler?.yield) {
              try { await globalThis.scheduler.yield(); } catch (_) {}
              if (!AUTO.running || __globalSig.aborted) return;
            }

            const now = performance.now();
            const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
            const v = window[VSC_INTERNAL_SYM]?.getActiveVideo?.();

            if (!en) {
              scheduleNext(v, 1000);
              return;
            }

            if (AUTO.drmBlocked && now < AUTO.blockUntilMs) {
              scheduleNext(v, 500);
              return;
            }

            if (document.hidden) {
              scheduleNext(v, 2000);
              return;
            }

            if (!v || !cvCtx || v.paused || v.seeking || v.readyState < 2) {
              try { Scheduler.request(true); } catch (_) {}
              scheduleNext(v, 300);
              return;
            }

            if (!gpuInitAttempted && FEATURE_FLAGS.gpuAnalysis) {
              const gpuOk = await ensureGPUAnalyzer();
              AUTO._gpuActive = gpuOk;
              if (gpuOk) log.info('[AutoScene] GPU analysis path activated');
            }

            /* ── v204: HDR 감지 시도 (첫 프레임에서만) ── */
            if (Store.get(P.APP_HDR_TONEMAP) && !__hdrState.detected) {
              detectHDRMetadata(v);
            }

            try {
              const img = await captureSceneFrame(v); if (!AUTO.running || __globalSig.aborted) return; if (!v.isConnected || v.paused || v.readyState < 2) { scheduleNext(v, 300); return; } if (!img) { scheduleNext(v, 500); return; }
              AUTO.drmBlocked = false; drmRetryCount = 0; const stats = await analyzeImageData(img, CANVAS_W, CANVAS_H);
              AUTO.motionEma = AUTO.motionEma * (1 - AUTO.motionAlpha) + stats.motionSAD * AUTO.motionAlpha; AUTO.motionFrames = AUTO.motionEma >= AUTO.motionThresh ? AUTO.motionFrames + 1 : 0;

              /* ── v204: bright/motionSAD 캐시 (composeVideoParamsInto에서 사용) ── */
              AUTO._lastBright = stats.bright;
              AUTO._lastMotionSAD = stats.motionSAD;

              const transition = detectTransition(stats, AUTO.lastStats); AUTO.lastStats = stats;
              if (!AUTO.statsEma) AUTO.statsEma = { ...stats }; else { const a = transition.isCut ? 0.55 : 0.14; const e = AUTO.statsEma; for (const k of ['bright', 'contrast', 'chroma', 'edge', 'skinRatio', 'centerBright', 'edgeAvgBright']) e[k] = (e[k] ?? stats[k]) * (1 - a) + stats[k] * a; }

              const newScene = classifySceneFuzzy(AUTO.statsEma, stats.zoneStats); if (newScene !== AUTO._sceneType) AUTO._sceneStable = 0; else AUTO._sceneStable++;
              AUTO._sceneType = newScene; if (AUTO._sceneStable >= 4) AUTO._sceneTypeEma = newScene;
              if (transition.isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; flickerCount = Math.max(0, flickerCount - 2); }

              AUTO._framesSinceUpdate++; const staticForceTrigger = AUTO._framesSinceUpdate >= STATIC_SCENE_FORCE_INTERVAL; const allowUpdate = transition.isCut || transition.isFade || AUTO.motionFrames >= 4 || staticForceTrigger;
              let fps = AUTO.curFps;
              if (allowUpdate) {
                AUTO._framesSinceUpdate = 0; fps = adaptiveFps(stats.motionSAD, transition.isCut, transition.isFade); if (now < AUTO.tBoostUntil) fps = Math.max(fps, transition.isCut ? AUTO.maxFps : 5);
                const sceneType = AUTO._sceneTypeEma;

                /* ── v204 FIX: 수동 슬라이더 값을 톤커브 생성기에 주입 ── */
                const toneParams = {
                  ...SCENE_TONE_PARAMS[sceneType],
                  userMods: {
                    shadow:     Number(Store.get(P.V_MAN_SHAD)) || 0,
                    recovery:   Number(Store.get(P.V_MAN_REC))  || 0,
                    brightness: Number(Store.get(P.V_MAN_BRT))  || 0
                  }
                };

                /* ── v204 Feature #2: Adaptive Saturation ── */
                const adaptedSatTarget = computeAdaptiveSatTarget(toneParams.satTarget, stats.chroma);

                /* ── v204 Feature #5: sceneType 전달 ── */
                const rawCurve = buildAdaptiveToneCurve(stats.lumHist, stats.totalSamples, toneParams, stats.zoneHists, stats.zoneCounts, sceneType);

                /* ── v204 Feature #3: Skin-tone enhanced channel balance ── */
                const rawGains = computeChannelBalance(stats.rHist, stats.gHist, stats.bHist, stats.totalSamples, stats.skinRatio, stats.hiLumaRBratio);

                const rawSat = adaptedSatTarget;

                /* ── v204 Feature #6: Independent temporal alphas ── */
                const alphas = getTemporalAlphas(transition.isCut, transition.isFade);

                const newMid = rawCurve[128], oldMid = prevToneCurve ? prevToneCurve[128] : 0.5; const dir = newMid > oldMid ? 1 : (newMid < oldMid ? -1 : 0);
                if (dir !== 0 && dir !== lastCurveDir && lastCurveDir !== 0) flickerCount = Math.min(flickerCount + 1, FLICKER_MAX); else if (dir !== 0) flickerCount = Math.max(0, flickerCount - FLICKER_DECAY); lastCurveDir = dir || lastCurveDir;

                /* ── v204: 파라미터별 독립 보간 ── */
                const smoothedCurve = interpolateCurves(prevToneCurve, rawCurve, alphas.bright);
                const smoothedGains = interpolateGains(prevChannelGains, rawGains, alphas.color);
                const smoothedSat = prevSatMul + (rawSat - prevSatMul) * alphas.sat;

                if (!prevToneCurve) prevToneCurve = new Float32Array(TONE_STEPS); prevToneCurve.set(smoothedCurve); prevChannelGains = smoothedGains; prevSatMul = smoothedSat;

                /* ── v204 Feature #7: HDR 톤매핑 블렌드 ── */
                let finalCurve = smoothedCurve;
                if (__hdrState.detected && Store.get(P.APP_HDR_TONEMAP)) {
                  const hdrCurve = buildHDRToneMappingCurve(__hdrState.transferFn, __hdrState.maxCLL, 200);
                  const hdrBlend = 0.70;
                  const blended = new Float32Array(TONE_STEPS);
                  for (let i = 0; i < TONE_STEPS; i++) {
                    blended[i] = smoothedCurve[i] * (1 - hdrBlend) + hdrCurve[i] * hdrBlend;
                  }
                  for (let i = 1; i < TONE_STEPS; i++) { if (blended[i] < blended[i - 1]) blended[i] = blended[i - 1]; }
                  finalCurve = blended;
                }

                const result = curveToApproxParams(finalCurve, smoothedSat, smoothedGains);
                result.br = clamp(result.br, 0.88, 1.45);

                /* ── v204 Feature #3: Skin-tone temp 보정 ── */
                if (Store.get(P.APP_SKIN_PROTECT) && stats.skinRatio > 0.05) {
                  const skinTempShift = clamp(stats.skinRatio * 15, 0, 5);
                  result._temp = clamp((result._temp || 0) + skinTempShift, -30, 30);
                }

                const prevBr = AUTO.cur.br, prevCt = AUTO.cur.ct, prevSat = AUTO.cur.sat;
                AUTO.cur.br = result.br; AUTO.cur.ct = result.ct; AUTO.cur.sat = result.sat; AUTO.cur._toneCurve = finalCurve; AUTO.cur._channelGains = smoothedGains; AUTO.cur._gamma = result._gamma; AUTO.cur._bright = result._bright; AUTO.cur._temp = result._temp;
                if (Math.abs(prevBr - AUTO.cur.br) > 0.001 || Math.abs(prevCt - AUTO.cur.ct) > 0.001 || Math.abs(prevSat - AUTO.cur.sat) > 0.001) Scheduler.request(true);

                /* ── v204: Scene-Aware Audio 파라미터 전달 ── */
                try {
                  const audioEngine = window[VSC_INTERNAL_SYM]?.AudioEngine;
                  if (audioEngine?.applySceneAudioParams) {
                    const audioParams = computeSceneAudioParams(stats, sceneType);
                    audioEngine.applySceneAudioParams(audioParams);
                  }
                } catch (_) {}
              }

              if (stats.zoneHists && stats.zoneCounts) detectLetterbox(stats.lumHist, stats.zoneHists, stats.zoneCounts);

              scheduleNext(v, Math.max(100, Math.round(1000 / Math.max(1, fps))));
            } catch (e) {
              const isDrm = (e.name === 'SecurityError' || e.message?.includes('tainted'));
              if (VSC_DEFENSE.autoSceneDrmBackoff && isDrm) {
                drmRetryCount++; AUTO.drmBlocked = true; if (AUTO._gpuActive) { AUTO._gpuActive = false; log.info('[AutoScene] GPU path disabled due to DRM taint'); }
                if (drmRetryCount >= MAX_DRM_RETRIES) { AUTO.running = false; updateManual(); Store.set(P.APP_AUTO_SCENE, false); try { if (typeof showOSD === 'function') showOSD('자동 장면: DRM 제한으로 비활성화됨', 3000); } catch (_) {} Scheduler.request(true); return; }
                scheduleNext(v, Math.min(30000, 8000 * Math.pow(1.5, drmRetryCount - 1)));
              } else scheduleNext(v, 1000);
            }
          }

          function resetAllModuleState() {
            AUTO.statsEma = null; AUTO.lastStats = null; AUTO._lastMean = 0; AUTO._sceneStable = 0; AUTO._sceneTypeEma = ST.NORMAL; AUTO._sceneType = ST.NORMAL;
            AUTO.motionEma = 0; AUTO.motionFrames = 0; AUTO.curFps = 2; AUTO._framesSinceUpdate = 0; AUTO._lastBright = 0.5; AUTO._lastMotionSAD = 0;
            _fpsHistBuf.clear(); prevToneCurve = null; prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; prevSatMul = 1.0;
            cutScores.clear(); gradualScores.clear(); flickerCount = 0; lastCurveDir = 0; __prevLumBuf = null; __curLumBuf = null; __curLumBufSize = 0; __fuzzyInited = false; __fuzzyEma.fill(0); _interpActive = 0;
            _fpsMotionAvg = 0;
            __letterboxState = { detected: false, ratio: 0, lastCheck: 0, notified: false, stableFrames: 0, lastDetectedRatio: 0, autoZoomed: false };
            __hdrState = { detected: false, transferFn: 'sdr', maxCLL: 1000, maxFALL: 400 };
          }

          function cleanupScheduler() { if (__asTimeoutId) { clearTimer(__asTimeoutId); __asTimeoutId = 0; } if (__asRvfcId && __asRvfcVideo && typeof __asRvfcVideo.cancelVideoFrameCallback === 'function') { try { __asRvfcVideo.cancelVideoFrameCallback(__asRvfcId); } catch (_) {} __asRvfcId = 0; __asRvfcVideo = null; } }
          __globalSig.addEventListener('abort', () => { AUTO.running = false; cleanupScheduler(); if (gpuAnalyzer) { gpuAnalyzer.destroy(); gpuAnalyzer = null; } }, { once: true });

          Store.sub(P.APP_AUTO_SCENE, (en) => {
            if (en && !AUTO.running) {
              drmRetryCount = 0;
              AUTO.running = true;
              resetAllModuleState();
              loop();
            } else if (!en) {
              resetAllModuleState();
              updateManual();
            }
          });
          Store.sub(P.APP_ACT, (en) => { if (en && Store.get(P.APP_AUTO_SCENE) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } });

          return {
            getMods: () => AUTO.cur,
            getSceneType: () => AUTO._sceneType,
            getSceneTypeName: () => ST_NAMES[AUTO._sceneType] || 'UNKNOWN',
            hasToneCurve: () => !!AUTO.cur._toneCurve,
            isGpuActive: () => AUTO._gpuActive,
            getLastMotionSAD: () => AUTO.motionEma,
            getLastBright: () => AUTO._lastBright,
            isHDRDetected: () => __hdrState.detected,
            getHDRTransfer: () => __hdrState.transferFn,
            getLetterboxState: () => ({ detected: __letterboxState.detected, ratio: __letterboxState.ratio, autoZoomed: __letterboxState.autoZoomed }),
            start: () => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT) && !AUTO.running) { drmRetryCount = 0; AUTO.running = true; loop(); } },
            stop: () => { AUTO.running = false; cleanupScheduler(); resetAllModuleState(); updateManual(); }
          };
        }

        /* ══ curveToApproxParams (v204.0.0: unchanged) ══ */
        function curveToApproxParams(curve, satMul, channelGains) {
  const clamp = VSC_CLAMP;
  const N = 32;
  const curveLen = curve.length;
  const step = (curveLen - 1) / (N - 1);
  let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < N; i++) {
    const ci = Math.min(curveLen - 1, Math.round(step * i));
    const x = ci / (curveLen - 1), y = curve[ci], x2 = x * x;
    S0 += 1; S1 += x; S2 += x2; S3 += x2 * x; S4 += x2 * x2;
    T0 += y; T1 += x * y; T2 += x2 * y;
  }
  const D = S4 * (S2 * S0 - S1 * S1) - S3 * (S3 * S0 - S1 * S2) + S2 * (S3 * S1 - S2 * S2);
  let a2, a1, a0;
  if (Math.abs(D) < 1e-12) { a2 = 0; a1 = 1; a0 = 0; }
  else {
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
  if (mid > 0.01 && mid < 0.99) {
    gamma = Math.log(mid) / Math.log(0.5);
    gamma = clamp(gamma, 0.65, 1.6);
  }
  const slopeAtMid = 2 * a2 * 0.5 + a1;
  const contrast = clamp(slopeAtMid, 0.75, 1.35);
  const curveIntegral = a2 / 3 + a1 / 2 + a0;
  const brightDiff = curveIntegral - 0.5;

  /* [FIX] bright 계수 축소: 45 → 25, 범위 ±8 → ±6 */
  const bright = clamp(brightDiff * 25, -6, 6);

  const tempEstimate = (channelGains.rGain - channelGains.bGain) * 50;
  const temp = clamp(tempEstimate, -30, 30);

  /* [FIX] br 범위 축소: 0.88~1.45 → 0.92~1.25 */
  return {
    br:   clamp(1.0 + bright * 0.008, 0.92, 1.25),
    ct:   clamp(contrast, 0.82, 1.28),
    sat:  clamp(satMul, 0.85, 1.40),
    _gamma: gamma,
    _bright: bright,
    _temp: temp,
    _channelGains: channelGains,
    _toneCurve: curve
  };
}


// ═══ END OF PART 3 (v204.0.0-Hybrid) ═══
// ═══ PART 5 (v204.0.0-Hybrid) — Missing Definitions, UI, Persistence, Orchestrator, Bootstrap ═══
// ═══ 5개의 탭(영상, AI센스, 오디오, 재생, 설정) 적용 완료 ═══

    /* ══════════════════════════════════════════════════════════════
       5-A  MISSING DEFINITIONS (Part 3-5 에서 참조하지만 미정의였던 것들)
       ══════════════════════════════════════════════════════════════ */

    /* ── _s : SVG 네임스페이스 엘리먼트 생성 헬퍼 ── */
    const _SVG_NS = 'http://www.w3.org/2000/svg';
    function _s(tag, attrs, ...children) {
      const el = document.createElementNS(_SVG_NS, tag);
      if (attrs) { for (const [k, v] of Object.entries(attrs)) { if (v != null && v !== false) el.setAttribute(k, String(v)); } }
      for (const c of children.flat()) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
      return el;
    }

    /* ── showOSD / __osdEl / __osdTimerId ── */
    let __osdEl = null, __osdTimerId = 0;
    function showOSD(msg, durationMs = 1800) {
      if (__globalSig.aborted) return;
      if (__osdTimerId) { clearTimer(__osdTimerId); __osdTimerId = 0; }
      if (__osdEl?.isConnected) { try { __osdEl.remove(); } catch (_) {} }
      __osdEl = document.createElement('div');
      __osdEl.id = 'vsc-osd';
      __osdEl.setAttribute('data-vsc-ui', '1');
      __osdEl.textContent = msg;
      __osdEl.style.cssText = [
        'position:fixed', 'bottom:56px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483647', 'background:rgba(0,0,0,0.82)', 'color:#fff',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif',
        'padding:8px 20px', 'border-radius:20px', 'pointer-events:none',
        'white-space:nowrap', 'opacity:0', 'transition:opacity .25s',
        'box-shadow:0 4px 14px rgba(0,0,0,.45)', 'user-select:none'
      ].join(';');
      const mount = document.fullscreenElement || document.webkitFullscreenElement || document.body || document.documentElement;
      if (!mount) return;
      mount.appendChild(__osdEl);
      requestAnimationFrame(() => { if (__osdEl) __osdEl.style.opacity = '1'; });
      __osdTimerId = setTimer(() => {
        if (__osdEl) { __osdEl.style.opacity = '0'; __osdTimerId = setTimer(() => { try { __osdEl?.remove(); } catch (_) {} __osdEl = null; __osdTimerId = 0; }, 300); }
      }, durationMs);
    }

    /* ── CSS_VARS ── */
    const CSS_VARS = `
:host {
  --vsc-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --vsc-font-xs: 10px; --vsc-font-sm: 12px; --vsc-font-md: 14px;
  --vsc-font-lg: 16px; --vsc-font-xl: 22px;
  --vsc-bg: rgba(18,18,22,0.92); --vsc-bg-hover: rgba(30,30,38,0.95);
  --vsc-text: #e0e0e0; --vsc-text-dim: #888;
  --vsc-accent: #6ea8fe; --vsc-accent-bg: rgba(110,168,254,0.18);
  --vsc-accent-border: rgba(110,168,254,0.4);
  --vsc-border: rgba(255,255,255,0.08);
  --vsc-radius-sm: 6px; --vsc-radius-md: 8px; --vsc-radius-xl: 14px;
  --vsc-shadow: 0 8px 32px rgba(0,0,0,0.55);
  --vsc-blur: blur(16px) saturate(1.4);
  --vsc-space-xs: 4px; --vsc-space-sm: 8px; --vsc-space-md: 12px; --vsc-space-lg: 16px;
  --vsc-touch-min: 36px; --vsc-touch-slider: 18px;
  --vsc-transition-fast: .12s ease; --vsc-transition-normal: .2s ease; --vsc-transition-slow: .35s ease;
  --vsc-panel-width: 340px; --vsc-panel-max-h: 82vh;
  --vsc-panel-right: 56px; --vsc-qbar-right: 10px;
}`;

    /* ── VSC_ICON_BUILDERS ── */
    const VSC_ICON_BUILDERS = {
      gear: (size = 18) => _s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        _s('circle', { cx: 12, cy: 12, r: 3 }),
        _s('path', { d: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.2.57.77.99 1.39 1.02H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z' })
      ),
      pip: (size = 18) => _s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: '#fff', 'stroke-width': '2' },
        _s('rect', { x: 2, y: 3, width: 20, height: 14, rx: 2 }),
        _s('rect', { x: 12, y: 9, width: 8, height: 6, rx: 1, fill: 'rgba(255,255,255,0.2)' })
      ),
      maximize: (size = 18) => _s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: '#fff', 'stroke-width': '2' },
        _s('polyline', { points: '15 3 21 3 21 9' }), _s('polyline', { points: '9 21 3 21 3 15' }),
        _s('line', { x1: 21, y1: 3, x2: 14, y2: 10 }), _s('line', { x1: 3, y1: 21, x2: 10, y2: 14 })
      ),
      camera: (size = 18) => _s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: '#fff', 'stroke-width': '2' },
        _s('path', { d: 'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z' }),
        _s('circle', { cx: 12, cy: 13, r: 4 })
      ),
      zoom: (size = 18) => _s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: '#fff', 'stroke-width': '2' },
        _s('circle', { cx: 11, cy: 11, r: 8 }), _s('line', { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }),
        _s('line', { x1: 11, y1: 8, x2: 11, y2: 14 }), _s('line', { x1: 8, y1: 11, x2: 14, y2: 11 })
      )
    };

    /* ── computeResolutionSharpMul ── */
    function computeResolutionSharpMul(video) {
      const nW = video.videoWidth || 0, nH = video.videoHeight || 0;
      const dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0;
      if (nW === 0 || dW === 0) return { autoBase: 0, mul: 1 };
      const scaleRatio = dW / nW;
      let autoBase;
      if (scaleRatio >= 1.8) autoBase = 0.10;
      else if (scaleRatio >= 1.2) autoBase = 0.25;
      else if (scaleRatio >= 0.8) autoBase = 0.45;
      else if (scaleRatio >= 0.5) autoBase = 0.65;
      else autoBase = 0.80;
      const mul = VSC_CLAMP(1 + (1 - scaleRatio) * 0.4, 0.6, 1.8);
      return { autoBase, mul };
    }

    /* ── captureVideoFrame ── */
    function captureVideoFrame(video) {
      if (!video || !video.isConnected || video.readyState < 2) { showOSD('캡처 실패: 영상 없음', 1200); return; }
      try {
        const cv = document.createElement('canvas');
        cv.width = video.videoWidth || video.clientWidth;
        cv.height = video.videoHeight || video.clientHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(video, 0, 0, cv.width, cv.height);
        cv.toBlob((blob) => {
          if (!blob) { showOSD('캡처 실패', 1000); return; }
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `vsc-capture-${Date.now()}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          setTimer(() => URL.revokeObjectURL(url), 5000);
          showOSD('프레임 캡처 완료', 1200);
        }, 'image/png');
      } catch (e) {
        if (e.name === 'SecurityError') showOSD('캡처 실패: DRM 보호', 1500);
        else showOSD('캡처 실패', 1200);
      }
    }

    /* ── togglePiPFor ── */
    async function togglePiPFor(video) {
      if (!video || !video.isConnected) { showOSD('PiP: 영상 없음', 1000); return; }
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
          showOSD('PiP 종료', 800);
        } else {
          if (document.pictureInPictureElement) await document.exitPictureInPicture();
          await video.requestPictureInPicture();
          showOSD('PiP 시작', 800);
        }
      } catch (e) {
        log.warn('[PiP]', e.message);
        showOSD('PiP 지원 안됨', 1200);
      }
    }

    /* ── isNeutralVideoParams ── */
    function isNeutralVideoParams(params) {
      if (!params) return true;
      const { brightness, contrast, saturate, sharpAmount, gamma, temperature, toneCurve, channelGains } = params;
      if (toneCurve) return false;
      if (channelGains && (Math.abs(channelGains.rGain - 1) > 0.01 || Math.abs(channelGains.gGain - 1) > 0.01 || Math.abs(channelGains.bGain - 1) > 0.01)) return false;
      return (Math.abs((brightness ?? 1) - 1) < 0.005) &&
             (Math.abs((contrast ?? 1) - 1) < 0.005) &&
             (Math.abs((saturate ?? 1) - 1) < 0.005) &&
             ((sharpAmount ?? 0) < 0.01) &&
             (Math.abs((gamma ?? 1) - 1) < 0.01) &&
             (Math.abs(temperature ?? 0) < 0.5);
    }

    /* ── createVideoParamsMemo (v204.0.1 FIX) ── */
    function createVideoParamsMemo(Store, P, Utils) {
  let _cacheRev = -1;
  let _cached = null;

  function computeParams(vfUser, video) {
    const presetS = vfUser.presetS || 'off';
    const presetMix = VSC_CLAMP(Number(vfUser.presetMix) ?? 1, 0, 1);
    const manualShadow   = Number(vfUser.manualShadow)   || 0;
    const manualRecovery = Number(vfUser.manualRecovery) || 0;
    const manualBright   = Number(vfUser.manualBright)   || 0;
    const hasManual = (manualShadow > 0 || manualRecovery > 0 || manualBright > 0);

    const autoSceneOn = !!Store.get(P.APP_AUTO_SCENE);
    const autoMods = autoSceneOn
      ? (window[VSC_INTERNAL_SYM]?.AutoScene?.getMods?.() || { br: 1, ct: 1, sat: 1 })
      : null;

    let brightness = 1.0, contrast = 1.0, saturate = 1.0, gamma = 1.0, temperature = 0;
    let toneCurve = null, channelGains = null;

    if (autoSceneOn && autoMods) {
      /* ═══ AutoScene 결과 기준 ═══ */
      brightness   = autoMods.br;
      contrast     = autoMods.ct;
      saturate     = autoMods.sat;
      gamma        = autoMods._gamma || 1;
      temperature  = autoMods._temp  || 0;
      toneCurve    = autoMods._toneCurve    || null;
      channelGains = autoMods._channelGains || null;

      /* ═══ [FIX v204.1] 수동 보정 — v203 소프트 컴프레션 방식 ═══
       * 톤커브는 순수 장면 분석 결과이므로 건드리지 않음.
       * 수동값은 CSS brightness/contrast로만 적용하되,
       * v203의 (1.0 - x) 감쇄를 모방하여 하이라이트 폭주 방지.
       */
      if (hasManual) {
        // 현재 AutoScene이 산출한 brightness/contrast 기준으로 "남은 여유" 계산
        const currentBr = brightness;
        const currentCt = contrast;

        // ── 암부 부스트: 어두운 장면일수록 효과적, 밝은 장면에선 감쇄 ──
        const shadowRoom = Math.max(0, 1.35 - currentBr);
        const shadowEffect = (manualShadow / 100) * 0.08 * shadowRoom;

        // ── 밝기: 전체 리프트, 하이라이트 보호 감쇄 ──
        const brightRoom = Math.max(0, 1.30 - currentBr);
        const brightEffect = (manualBright / 100) * 0.06 * brightRoom;

        // ── 합산 (상한선 명확히) ──
        brightness += Math.min(shadowEffect + brightEffect, 0.12);

        // ── 디테일 복원 → contrast 미세 증가 및 gamma 조절 ──
        const contrastRoom = Math.max(0, 1.25 - currentCt);
        const recoveryEffect = (manualRecovery / 100) * 0.08 * contrastRoom;

        contrast += Math.min(recoveryEffect, 0.08);
        gamma -= (manualRecovery / 100) * 0.03; // 펀치감을 위해 감마를 살짝 내림
      }

    } else {
      /* ═══ AutoScene OFF — 수동 보정 단독 ═══ */
      brightness = 1.0;
      contrast   = 1.0;
      saturate   = 1.0;
      gamma      = 1.0;
      temperature = 0;
      toneCurve    = null;
      channelGains = null;

      if (hasManual) {
        const SOLO_SHADOW_COEFF = 0.005;
        const SOLO_BRIGHT_COEFF = 0.006;
        const SOLO_RECOVERY_CONTRAST = 0.003;
        const SOLO_RECOVERY_GAMMA = 0.002;

        brightness += manualShadow * SOLO_SHADOW_COEFF + manualBright * SOLO_BRIGHT_COEFF;
        contrast   += manualRecovery * SOLO_RECOVERY_CONTRAST;
        gamma      -= manualRecovery * SOLO_RECOVERY_GAMMA;
      }
    }

    /* ═══ 공통: 프리셋 샤프닝 ═══ */
    let sharpAmount = 0;
    if (presetS !== 'none' && presetS !== 'off') {
      const pr = PRESETS.detail[presetS];
      if (pr) {
        sharpAmount = (pr.sharpAdd || 0) / 100 * presetMix;
        if (pr.clarityAdd) contrast *= 1 + (pr.clarityAdd / 100) * presetMix * 0.15;
      }
    } else if (presetS === 'off') {
      const { autoBase } = computeResolutionSharpMul(video);
      sharpAmount = autoBase * presetMix * 0.5;
    }

    /* ═══ v204 Feature #1: 적응형 샤프닝 ═══ */
    if (Store.get(P.APP_SMART_SHARP) && sharpAmount > 0 && autoSceneOn) {
      const motionSAD  = window[VSC_INTERNAL_SYM]?.AutoScene?.getLastMotionSAD?.() || 0;
      const lastBright = window[VSC_INTERNAL_SYM]?.AutoScene?.getLastBright?.() || 0.5;
      const motionDampen = 1 - VSC_CLAMP(motionSAD / 0.15, 0, 0.6);
      const darkDampen   = lastBright < 0.2 ? 0.5 + lastBright * 2.5 : 1;
      sharpAmount *= motionDampen * darkDampen;
    }

    /* ═══ 최종 범위 제한 ═══ */
    brightness  = VSC_CLAMP(brightness,  0.7,  1.6);
    contrast    = VSC_CLAMP(contrast,    0.7,  1.5);
    saturate    = VSC_CLAMP(saturate,    0.7,  1.6);
    gamma       = VSC_CLAMP(gamma,       0.6,  1.7);
    temperature = VSC_CLAMP(temperature, -40,   40);

    return { brightness, contrast, saturate, sharpAmount, gamma, temperature, toneCurve, channelGains };
  }

  return {
    get(vfUser, video) {
      const rev = Store.rev();
      if (_cacheRev === rev && _cached) return _cached;
      _cached = computeParams(vfUser, video);
      _cacheRev = rev;
      return _cached;
    },
    invalidate() { _cacheRev = -1; _cached = null; }
  };
}


    /* ── createFiltersVideoOnly ── */
    function createFiltersVideoOnly(Utils, CONFIG) {
      const _filterSvgs = new WeakMap();
      const _NS = 'http://www.w3.org/2000/svg';

      function _buildSvgFilterStr(params) {
        const { brightness, contrast, saturate } = params;
        const parts = [];
        if (Math.abs(brightness - 1) > 0.003) parts.push(`brightness(${brightness.toFixed(4)})`);
        if (Math.abs(contrast - 1) > 0.003) parts.push(`contrast(${contrast.toFixed(4)})`);
        if (Math.abs(saturate - 1) > 0.003) parts.push(`saturate(${saturate.toFixed(4)})`);
        return parts.length > 0 ? parts.join(' ') : '';
      }

      function _getOrCreateSvgFilter(video, params) {
        let state = _filterSvgs.get(video);
        if (!state) {
          const svg = document.createElementNS(_NS, 'svg');
          svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
          svg.style.cssText = 'position:absolute;pointer-events:none;visibility:hidden';
          svg.setAttribute('data-vsc-ui', '1');
          const defs = document.createElementNS(_NS, 'defs');
          svg.appendChild(defs);
          state = { svg, defs, filterId: null, filterEl: null };
          _filterSvgs.set(video, state);
        }
        return state;
      }

      function _ensureSvgMounted(state) {
        if (!state.svg.isConnected) {
          const mount = document.body || document.documentElement;
          if (mount) mount.appendChild(state.svg);
        }
      }

      function _buildSvgFilterElements(state, params) {
        const { toneCurve, channelGains, sharpAmount } = params;
        const needsSvg = !!toneCurve || !!channelGains || (sharpAmount > 0.01);
        if (!needsSvg) {
          if (state.filterEl) { state.filterEl.remove(); state.filterEl = null; state.filterId = null; }
          return null;
        }
        if (state.filterEl) { state.filterEl.remove(); state.filterEl = null; }
        const id = 'vsc-f-' + (CONFIG.VSC_ID || Math.random().toString(36).slice(2)).slice(0, 8);
        const filter = document.createElementNS(_NS, 'filter');
        filter.setAttribute('id', id);
        filter.setAttribute('color-interpolation-filters', 'sRGB');
        let lastResult = 'SourceGraphic';

        if (toneCurve && toneCurve.length >= 256) {
          const ct = document.createElementNS(_NS, 'feComponentTransfer');
          ct.setAttribute('in', lastResult); ct.setAttribute('result', 'toned');
          const tableStr = Array.from(toneCurve, v => VSC_CLAMP(v, 0, 1).toFixed(5)).join(' ');
          for (const ch of ['feFuncR', 'feFuncG', 'feFuncB']) {
            const fn = document.createElementNS(_NS, ch);
            fn.setAttribute('type', 'table'); fn.setAttribute('tableValues', tableStr);
            ct.appendChild(fn);
          }
          filter.appendChild(ct);
          lastResult = 'toned';
        }

        if (channelGains) {
          const { rGain, gGain, bGain } = channelGains;
          if (Math.abs(rGain - 1) > 0.005 || Math.abs(gGain - 1) > 0.005 || Math.abs(bGain - 1) > 0.005) {
            const cm = document.createElementNS(_NS, 'feColorMatrix');
            cm.setAttribute('type', 'matrix');
            cm.setAttribute('in', lastResult); cm.setAttribute('result', 'balanced');
            cm.setAttribute('values', `${rGain.toFixed(5)} 0 0 0 0  0 ${gGain.toFixed(5)} 0 0 0  0 0 ${bGain.toFixed(5)} 0 0  0 0 0 1 0`);
            filter.appendChild(cm);
            lastResult = 'balanced';
          }
        }

        if (sharpAmount > 0.01) {
          const s = VSC_CLAMP(sharpAmount, 0, 1);
          const center = 1 + 4 * s;
          const edge = -s;
          const kernel = `0 ${edge.toFixed(4)} 0 ${edge.toFixed(4)} ${center.toFixed(4)} ${edge.toFixed(4)} 0 ${edge.toFixed(4)} 0`;
          const conv = document.createElementNS(_NS, 'feConvolveMatrix');
          conv.setAttribute('in', lastResult); conv.setAttribute('result', 'sharpened');
          conv.setAttribute('order', '3');
          conv.setAttribute('kernelMatrix', kernel);
          conv.setAttribute('divisor', '1');
          conv.setAttribute('bias', '0');
          conv.setAttribute('edgeMode', 'duplicate');
          conv.setAttribute('preserveAlpha', 'true');
          filter.appendChild(conv);
          lastResult = 'sharpened';
        }

        state.defs.appendChild(filter);
        state.filterId = id;
        state.filterEl = filter;
        _ensureSvgMounted(state);
        return id;
      }

      function prepareCached(video, params) {
        const cssStr = _buildSvgFilterStr(params);
        const state = _getOrCreateSvgFilter(video, params);
        const svgId = _buildSvgFilterElements(state, params);
        return { cssStr, svgId };
      }

      function applyFilter(video, filterResult) {
        if (!video?.style) return;
        const { cssStr, svgId } = filterResult;
        const parts = [];
        if (svgId) parts.push(`url(#${svgId})`);
        if (cssStr) parts.push(cssStr);
        const final = parts.join(' ');
        const vst = getVState(video);
        if (vst.lastCssFilterStr === final) return;
        vst.lastCssFilterStr = final;
        vst.applied = !!final;
        if (final) vscSetStyle(video, 'filter', final, 'important');
        else vscRemoveStyle(video, 'filter');
      }

      function clear(video) {
        if (!video) return;
        const vst = getVState(video);
        vst.applied = false; vst.lastCssFilterStr = null; vst.lastFilterUrl = null;
        vscRemoveStyle(video, 'filter');
        const state = _filterSvgs.get(video);
        if (state) {
          if (state.filterEl) { state.filterEl.remove(); state.filterEl = null; state.filterId = null; }
          if (state.svg?.isConnected) state.svg.remove();
          _filterSvgs.delete(video);
        }
      }

      return { prepareCached, applyFilter, clear };
    }

    /* ── createVideoMaximizer (팩토리 래퍼) ── */
    function createVideoMaximizer(Store, ApplyReq) {
      const STYLES_ID = 'vsc-maximizer-styles';
      const CSS = `.vc-maximized-video{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;object-fit:contain!important;background:#000!important}.vc-maximized-body-lock{overflow:hidden!important}`;
      let _active = false, _origStyles = null, _videoEl = null;

      function _injectCSS() {
        if (document.getElementById(STYLES_ID)) return;
        const s = document.createElement('style'); s.id = STYLES_ID; s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
      }
      function maximize(video) {
        if (_active || !video) return false;
        _injectCSS();
        _origStyles = { cssText: video.style.cssText, bodyOverflow: document.body?.style.overflow || '' };
        _videoEl = video; video.classList.add('vc-maximized-video');
        if (document.body) document.body.classList.add('vc-maximized-body-lock');
        _active = true; showOSD('최대화', 800); return true;
      }
      function undoMaximize() {
        if (!_active || !_videoEl) return false;
        _videoEl.classList.remove('vc-maximized-video');
        if (_origStyles) _videoEl.style.cssText = _origStyles.cssText;
        if (document.body) { document.body.classList.remove('vc-maximized-body-lock'); if (_origStyles) document.body.style.overflow = _origStyles.bodyOverflow; }
        _origStyles = null; _videoEl = null; _active = false; showOSD('최대화 해제', 800); return true;
      }
      function toggle() {
        if (_active) return undoMaximize();
        const v = window[VSC_INTERNAL_SYM]?._activeVideo;
        return v ? maximize(v) : false;
      }
      return { maximize, undoMaximize, toggle, isActive: () => _active };
    }

    /* ── createZoomManager (팩토리) ── */
    function createZoomManager() {
      const _state = new WeakMap();
      const LIMITS = { min: 1.0, max: 4.0, step: 0.25 };

      function _getS(v) { let s = _state.get(v); if (!s) { s = { level: 1, panX: 0, panY: 0 }; _state.set(v, s); } return s; }
      function _apply(v) {
        const s = _getS(v);
        if (s.level <= 1.001 && Math.abs(s.panX) < 0.5 && Math.abs(s.panY) < 0.5) {
          vscRemoveStyle(v, 'transform'); vscRemoveStyle(v, 'transform-origin'); return;
        }
        vscSetStyle(v, 'transform-origin', '50% 50%', 'important');
        vscSetStyle(v, 'transform', `scale(${s.level.toFixed(3)}) translate(${s.panX.toFixed(1)}px,${s.panY.toFixed(1)}px)`, 'important');
      }

      function zoomTo(v, level) { const s = _getS(v); s.level = VSC_CLAMP(level, LIMITS.min, LIMITS.max); _apply(v); }
      function zoomIn(v) { zoomTo(v, _getS(v).level + LIMITS.step); }
      function zoomOut(v) { zoomTo(v, _getS(v).level - LIMITS.step); }
      function resetZoom(v) { const s = _getS(v); s.level = 1; s.panX = 0; s.panY = 0; _apply(v); }
      function pan(v, dx, dy) {
        const s = _getS(v); if (s.level <= 1.001) return;
        const max = (s.level - 1) * 200;
        s.panX = VSC_CLAMP(s.panX + dx, -max, max);
        s.panY = VSC_CLAMP(s.panY + dy, -max, max);
        _apply(v);
      }
      function isZoomed(v) { return _getS(v).level > 1.005; }
      function getState(v) { const s = _getS(v); return { level: s.level, panX: s.panX, panY: s.panY }; }
      function onNewVideoForZoom(v) { }
      function pruneDisconnected() { }
      function destroy() { }

      return { zoomTo, zoomIn, zoomOut, resetZoom, pan, isZoomed, getState, onNewVideoForZoom, pruneDisconnected, destroy };
    }


    /* ══════════════════════════════════════════════════════════════
       5-B  createUI (v204.0.0-Hybrid)
       ══════════════════════════════════════════════════════════════ */
    function createUI(Store, Bus, Utils, Audio, AutoScene, ZoomMgr, Targeting, Maximizer, FiltersVO, Registry, Scheduler, ApplyReq) {
      const { h, clamp } = Utils;
      const uiAC = new AbortController();
      const sig = combineSignals(__globalSig, uiAC.signal);

      let panelHost = null, panelEl = null, quickBarHost = null;
      let activeTab = 'video', advancedOpen = false, panelOpen = false;
      let _panelTransitioning = false;

      const permanentSyncFns = [];
      const tabSyncFns = [];
      const syncFns = [];
      const _tabDomCache = new Map();
      const _tabSyncCache = new Map();
      let _shadow = null, _qbarShadow = null;
      let qbarVisible = false;
      const _busUnsubs = [];

      function getGpuStatus() { const g = window[VSC_INTERNAL_SYM]?._gpuSceneActive; return g === true ? 'active' : (g === 'fallback' ? 'fallback' : 'off'); }
      function getDspStatus() { const d = window[VSC_INTERNAL_SYM]?._dspMode; if (d === 'worklet') return 'worklet'; if (d === 'legacy') return 'legacy'; return 'off'; }
      function isDrmDetected() { const v = window[VSC_INTERNAL_SYM]?._activeVideo; return v ? isVideoEncrypted(v) : false; }

      const PANEL_CSS = `
${CSS_VARS}
:host{all:initial;position:fixed;z-index:2147483647;font-family:var(--vsc-font-family);font-size:var(--vsc-font-md);color:var(--vsc-text);pointer-events:none}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
.panel{pointer-events:none;position:fixed;right:calc(var(--vsc-panel-right) + 10px);top:50%;width:var(--vsc-panel-width);max-height:var(--vsc-panel-max-h);background:var(--vsc-bg);border:1px solid var(--vsc-border);border-radius:var(--vsc-radius-xl);backdrop-filter:var(--vsc-blur);box-shadow:var(--vsc-shadow);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translate(12px,-50%) scale(.96);transition:opacity var(--vsc-transition-normal),transform var(--vsc-transition-normal);user-select:none}
.panel.open{opacity:1;transform:translate(0,-50%) scale(1);pointer-events:auto}
.hdr{display:flex;align-items:center;padding:var(--vsc-space-md) var(--vsc-space-lg);border-bottom:1px solid rgba(255,255,255,.06);gap:8px}
.hdr .tl{font-weight:700;font-size:var(--vsc-font-lg);letter-spacing:.3px}
.hdr .ver{font-size:var(--vsc-font-xs);opacity:.45;margin-left:auto}
.hdr-status{display:flex;gap:6px;align-items:center}
.hdr-dot{width:8px;height:8px;border-radius:50%;display:inline-block;position:relative}
.hdr-dot.green{background:#4caf50;box-shadow:0 0 4px rgba(76,175,80,.5)}
.hdr-dot.amber{background:#ff9800;box-shadow:0 0 4px rgba(255,152,0,.5)}
.hdr-dot.red{background:#f44336;box-shadow:0 0 4px rgba(244,67,54,.5)}
.hdr-dot.gray{background:rgba(255,255,255,.2)}
.hdr-dot::after{content:attr(data-label);position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);font-size:8px;white-space:nowrap;opacity:0;transition:opacity .15s;pointer-events:none;color:var(--vsc-text-dim);background:var(--vsc-bg);padding:2px 4px;border-radius:3px;border:1px solid var(--vsc-border)}
.hdr-status:hover .hdr-dot::after{opacity:1}
.tabs{display:flex;border-bottom:1px solid rgba(255,255,255,.06);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{flex:1;padding:8px 0;text-align:center;font-size:var(--vsc-font-sm);font-weight:600;text-transform:uppercase;letter-spacing:.5px;cursor:pointer;opacity:.45;border-bottom:2px solid transparent;transition:opacity .15s,border-color .15s;display:flex;align-items:center;justify-content:center;gap:3px}
.tab svg{opacity:.7;flex-shrink:0;width:14px;height:14px}
.tab.on svg{opacity:1}
.tab:hover{opacity:.7}.tab.on{opacity:1;border-bottom-color:var(--vsc-accent)}
.body{overflow-y:auto;flex:1;min-height:0;padding:var(--vsc-space-md) var(--vsc-space-lg) var(--vsc-space-lg);scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.12) transparent}
.row{display:flex;align-items:center;justify-content:space-between;padding:var(--vsc-space-xs) 0;min-height:var(--vsc-touch-min)}
.row label{font-size:12px;opacity:.8;flex:0 0 auto;max-width:48%}
.row .ctrl{display:flex;align-items:center;gap:var(--vsc-space-sm);flex:1;justify-content:flex-end}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;max-width:140px;height:4px;border-radius:2px;outline:none;cursor:pointer;background:linear-gradient(to right,var(--vsc-accent) 0%,var(--vsc-accent) var(--fill,50%),rgba(255,255,255,.12) var(--fill,50%));padding:12px 0;margin:-12px 0;background-clip:content-box}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:var(--vsc-touch-slider);height:var(--vsc-touch-slider);border-radius:50%;background:var(--vsc-accent);cursor:pointer;border:none;box-shadow:0 0 0 4px rgba(110,168,254,.15);transition:box-shadow .15s}
input[type=range]:active::-webkit-slider-thumb{box-shadow:0 0 0 8px rgba(110,168,254,.25)}
input[type=range]::-moz-range-thumb{width:var(--vsc-touch-slider);height:var(--vsc-touch-slider);border-radius:50%;background:var(--vsc-accent);cursor:pointer;border:none}
.val{font-size:var(--vsc-font-sm);min-width:38px;text-align:right;font-variant-numeric:tabular-nums;opacity:.9}
.btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.1);border-radius:var(--vsc-radius-md);color:var(--vsc-text);padding:var(--vsc-space-xs) var(--vsc-space-md);font-size:var(--vsc-font-sm);cursor:pointer;transition:background var(--vsc-transition-fast);min-height:var(--vsc-touch-min);min-width:44px;display:inline-flex;align-items:center;justify-content:center}
.btn:hover{background:rgba(255,255,255,.15)}.btn.pr{background:var(--vsc-accent-bg);border-color:var(--vsc-accent-border)}
.tgl{position:relative;width:44px;height:22px;border-radius:11px;background:rgba(255,255,255,.12);cursor:pointer;transition:background .2s;overflow:hidden}
.tgl.on{background:rgba(110,168,254,.5)}
.tgl::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s;z-index:1}
.tgl.on::after{transform:translateX(22px)}
.tgl::before{content:'OFF';position:absolute;right:6px;top:50%;transform:translateY(-50%);font-size:8px;font-weight:700;opacity:.4;letter-spacing:.5px;z-index:0}
.tgl.on::before{content:'ON';left:6px;right:auto;opacity:.7;color:#fff}
.sep{height:1px;background:rgba(255,255,255,.06);margin:var(--vsc-space-sm) 0}
.chips{padding:3px 0;display:flex;flex-wrap:wrap;gap:var(--vsc-space-xs)}
.chip{display:inline-flex;align-items:center;justify-content:center;padding:var(--vsc-space-xs) var(--vsc-space-md);min-height:var(--vsc-touch-min);min-width:44px;font-size:var(--vsc-font-sm);border-radius:var(--vsc-radius-sm);cursor:pointer;background:rgba(255,255,255,.06);border:1px solid var(--vsc-border);transition:background var(--vsc-transition-fast),border-color var(--vsc-transition-fast);text-align:center;-webkit-tap-highlight-color:transparent}
.chip:hover{background:rgba(255,255,255,.10)}.chip.on{background:var(--vsc-accent-bg);border-color:var(--vsc-accent-border)}
.metrics-footer{font-size:9px;opacity:.4;padding:var(--vsc-space-xs) var(--vsc-space-lg);border-top:1px solid rgba(255,255,255,.04);line-height:1.6;font-variant-numeric:tabular-nums;display:flex;flex-wrap:wrap;gap:6px 12px}
.rate-display{font-size:var(--vsc-font-xl);font-weight:700;text-align:center;color:#fff;padding:var(--vsc-space-sm) 0;font-variant-numeric:tabular-nums}
.fine-row{display:flex;gap:var(--vsc-space-xs);justify-content:center;padding:var(--vsc-space-xs) 0}
.fine-btn{padding:var(--vsc-space-sm) var(--vsc-space-md);min-height:var(--vsc-touch-min);min-width:44px;border-radius:var(--vsc-radius-sm);border:1px solid var(--vsc-border);background:rgba(255,255,255,.04);color:#aaa;font-size:var(--vsc-font-sm);cursor:pointer;transition:background var(--vsc-transition-fast);font-variant-numeric:tabular-nums;-webkit-tap-highlight-color:transparent}
.fine-btn:hover{background:rgba(255,255,255,.1)}
.info-bar{font-size:var(--vsc-font-xs);opacity:.5;padding:var(--vsc-space-xs) 0 var(--vsc-space-sm);line-height:1.5;font-variant-numeric:tabular-nums}
.ab-indicator{display:none;background:rgba(244,67,54,.3);border:1px solid rgba(244,67,54,.5);border-radius:4px;padding:2px 6px;font-size:9px;font-weight:700;color:#ff8a80;letter-spacing:.5px;animation:abPulse 1.5s ease-in-out infinite}
.ab-indicator.active{display:inline-flex}
@keyframes abPulse{0%,100%{opacity:1}50%{opacity:.5}}
.shortcut-grid{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:var(--vsc-font-xs);line-height:1.6;padding:var(--vsc-space-xs) 0}
.shortcut-grid .sk{font-weight:700;color:#8ec5fc;white-space:nowrap}.shortcut-grid .sd{opacity:.7}
.feat-section{padding:var(--vsc-space-xs) 0}
.feat-title{font-size:var(--vsc-font-sm);font-weight:700;color:var(--vsc-accent);opacity:.85;padding:var(--vsc-space-xs) 0 var(--vsc-space-xs);letter-spacing:.3px}
.feat-desc{font-size:10px;opacity:.45;padding:0 0 2px;line-height:1.4}
.feat-row{display:flex;align-items:center;justify-content:space-between;padding:3px 0;min-height:30px}
.feat-row label{font-size:11px;opacity:.75;flex:1}
.feat-row .feat-badge{font-size:8px;padding:1px 5px;border-radius:3px;margin-right:6px;font-weight:600;text-transform:uppercase;letter-spacing:.4px}
.feat-badge.tier1{background:rgba(255,215,0,.15);color:#ffd700;border:1px solid rgba(255,215,0,.25)}
.feat-badge.tier2{background:rgba(192,192,192,.12);color:#c0c0c0;border:1px solid rgba(192,192,192,.2)}
.feat-status{font-size:9px;opacity:.5;padding:2px 0;line-height:1.5;font-variant-numeric:tabular-nums}
.qbar{pointer-events:none;position:fixed;top:50%;right:var(--vsc-qbar-right);transform:translateY(-50%);display:flex;flex-direction:row-reverse;align-items:center;gap:8px}
.qbar .qb-main{pointer-events:auto;width:44px;height:44px;border-radius:50%;background:var(--vsc-bg);border:1px solid rgba(255,255,255,.15);z-index:2;opacity:.25;transition:opacity .3s,transform .2s,background .2s;box-shadow:0 4px 12px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent;margin-right:env(safe-area-inset-right,0px)}
.qbar:hover .qb-main,.qbar.expanded .qb-main{opacity:1;transform:scale(1.08);background:var(--vsc-bg-hover);border-color:rgba(255,255,255,.3)}
.qbar .qb-sub{width:38px;height:38px;border-radius:50%;background:var(--vsc-bg);border:1px solid rgba(255,255,255,.12);opacity:0;transform:scale(0.3) translateX(20px);transition:opacity .2s,transform .2s,visibility 0s .2s;pointer-events:none;visibility:hidden;z-index:1;box-shadow:0 2px 8px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;cursor:pointer;-webkit-tap-highlight-color:transparent}
.qbar.expanded .qb-sub{opacity:1;transform:scale(1) translateX(0);pointer-events:auto;visibility:visible;transition:opacity .2s,transform .2s,visibility 0s 0s}
.qbar.expanded .qb-sub:nth-child(2){transition-delay:.03s}
.qbar.expanded .qb-sub:nth-child(3){transition-delay:.06s}
.qbar.expanded .qb-sub:nth-child(4){transition-delay:.09s}
.qbar.expanded .qb-sub:nth-child(5){transition-delay:.12s}
.qbar.expanded .qb-sub:nth-child(6){transition-delay:.15s}
.qbar .qb-sub:hover{background:var(--vsc-bg-hover);transform:scale(1.1)}
.qbar svg{width:22px;height:22px;fill:none;stroke:#fff;stroke-width:2;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))}
.qbar .qb-sub svg{width:18px;height:18px}
.qb:focus-visible,.chip:focus-visible,.btn:focus-visible,.fine-btn:focus-visible{outline:2px solid var(--vsc-accent);outline-offset:2px}
@media(pointer:coarse){.qbar .qb-main{width:48px;height:48px}.qbar .qb-sub{width:42px;height:42px}}
@media(max-width:600px){:host{--vsc-panel-width:calc(100vw - 80px);--vsc-panel-right:60px}}
@media(max-width:420px){.tab span{display:none}.tab svg{width:18px;height:18px;opacity:1}.tab{padding:8px 4px}}
@media(max-width:400px){:host{--vsc-panel-width:calc(100vw - 64px);--vsc-panel-right:52px;--vsc-font-md:15px}.chips{gap:6px}.fine-row{gap:6px}}
@media(max-width:350px){.tab{min-width:0;padding:8px 2px}}
@media(orientation:landscape) and (max-height:500px){.panel{max-height:85vh}.body{max-height:calc(85vh - 80px)}}
@supports(padding:env(safe-area-inset-right)){.qbar{right:calc(var(--vsc-qbar-right) + env(safe-area-inset-right))}.panel{right:calc(var(--vsc-panel-right) + 10px + env(safe-area-inset-right))}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:0.01ms!important;animation-duration:0.01ms!important}}
@media(prefers-contrast:high){:host{--vsc-bg:rgba(0,0,0,0.98);--vsc-border:rgba(255,255,255,0.3);--vsc-text:#fff}}
.feat-row label{color:var(--vsc-text)}
.feat-title{opacity:1}
.feat-row .tgl{width:38px;height:20px;border-radius:10px;overflow:hidden}
.feat-row .tgl::after{width:16px;height:16px}
.feat-row .tgl.on::after{transform:translateX(18px)}
`;

      const TAB_LABELS = { video: '영상', autosense: 'AI센스', audio: '오디오', playback: '재생', app: '설정' };
      const TAB_ICONS = {
        video: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, _s('rect', { x: 2, y: 4, width: 16, height: 16, rx: 2 }), _s('path', { d: 'M22 7l-6 4 6 4z' })),
        autosense: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, _s('path', { d: 'M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z' }), _s('path', { d: 'M9 12h6' }), _s('path', { d: 'M12 12v6' }), _s('circle', { cx: 12, cy: 21, r: 1 }), _s('path', { d: 'M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 7l1.4-1.4' })),
        audio: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, _s('path', { d: 'M11 5L6 9H2v6h4l5 4V5z' }), _s('path', { d: 'M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07' })),
        playback: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, _s('circle', { cx: 12, cy: 12, r: 10 }), _s('polygon', { points: '10 8 16 12 10 16' })),
        app: () => _s('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }, _s('circle', { cx: 12, cy: 12, r: 3 }), _s('path', { d: 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9c.2.57.77.99 1.39 1.02H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z' }))
      };

      function mkRow(label, ...ctrls) { return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, ...ctrls)); }
      function mkSep() { return h('div', { class: 'sep' }); }

      function mkSlider(path, min, max, step) {
        const inp = h('input', { type: 'range', min, max, step: step || ((max - min) / 100) });
        const valEl = h('span', { class: 'val' });
        const digits = (step && step >= 1) ? 0 : 2;
        function updateFill() { const v = Number(inp.value); const pct = ((v - min) / (max - min)) * 100; inp.style.setProperty('--fill', `${pct}%`); }
        function sync() { const v = Number(Store.get(path)) || min; inp.value = String(v); valEl.textContent = v.toFixed(digits); updateFill(); }
        inp.addEventListener('input', () => { const nv = parseFloat(inp.value); Store.set(path, nv); valEl.textContent = nv.toFixed(digits); updateFill(); ApplyReq.soft(); }, { signal: sig });
        tabSyncFns.push(sync); sync();
        return [inp, valEl];
      }

      function mkToggle(path, onChange) {
        const el = h('div', { class: 'tgl' });
        function sync() { el.classList.toggle('on', !!Store.get(path)); }
        el.addEventListener('click', () => { const nv = !Store.get(path); Store.set(path, nv); sync(); if (onChange) onChange(nv); }, { signal: sig });
        tabSyncFns.push(sync); sync();
        return el;
      }

      /* ── v204: 기능 토글 전용 행 빌더 ── */
      function mkFeatToggle(path, label, desc, tierClass, onChange) {
        const row = h('div', { class: 'feat-row' });
        const badge = h('span', { class: `feat-badge ${tierClass}` }, tierClass === 'tier1' ? 'T1' : 'T2');
        const labelEl = h('label', {}, label);
        const tgl = h('div', { class: 'tgl', style: 'width:38px;height:20px' });
        tgl.style.setProperty('--thumb-size', '16px');
        function sync() { tgl.classList.toggle('on', !!Store.get(path)); }
        tgl.addEventListener('click', () => {
          const nv = !Store.get(path);
          Store.set(path, nv); sync();
          ApplyReq.hard(); persistNow();
          if (onChange) onChange(nv);
        }, { signal: sig });
        tabSyncFns.push(sync); sync();
        row.append(badge, labelEl, tgl);
        const wrap = h('div', {});
        wrap.appendChild(row);
        if (desc) wrap.appendChild(h('div', { class: 'feat-desc' }, desc));
        return wrap;
      }

      function mkChipRow(label, path, chips, onSelect) {
        const wrap = h('div', {}, h('label', { style: 'font-size:11px;opacity:.7;display:block;margin-bottom:2px' }, label));
        const row = h('div', { class: 'chips' });
        function sync() { const cur = String(Store.get(path)); for (const c of row.children) c.classList.toggle('on', c.dataset.v === cur); }
        for (const ch of chips) {
          const el = h('span', { class: 'chip', 'data-v': String(ch.v) }, ch.l);
          el.addEventListener('click', () => { Store.set(path, ch.v); sync(); if (onSelect) onSelect(ch.v); else ApplyReq.soft(); }, { signal: sig });
          row.appendChild(el);
        }
        wrap.appendChild(row); tabSyncFns.push(sync); sync();
        return wrap;
      }

      /* ══ Tab builders ══ */

      function buildVideoTab() {
        const w = h('div', {});

        /* ── 1. 영상 정보 바 ── */
        const infoBar = h('div', { class: 'info-bar' });
        function updateInfo() {
          const active = window[VSC_INTERNAL_SYM]?._activeVideo;
          const video = (active && active.isConnected) ? active : (() => { try { return document.querySelector('video'); } catch (_) { return null; } })();
          if (!video || !video.isConnected) { infoBar.textContent = '영상 없음'; return; }
          const nW = video.videoWidth || 0, nH = video.videoHeight || 0, dW = video.clientWidth || video.offsetWidth || 0, dH = video.clientHeight || video.offsetHeight || 0;
          if (nW === 0 || nH === 0) { infoBar.textContent = '로딩 중...'; return; }
          const { autoBase } = computeResolutionSharpMul(video);
          const presetS = Store.get(P.V_PRE_S);
          let sharpLabel = presetS === 'none' ? '꺼짐(OFF)' : (presetS === 'off' ? `자동(${autoBase.toFixed(3)})` : `${getPresetLabel('detail', presetS)} (수동)`);
          const motionSAD = window[VSC_INTERNAL_SYM]?.AutoScene?.getLastMotionSAD?.() || 0;
          const motionStr = motionSAD > 0.001 ? ` | 모션: ${(motionSAD * 100).toFixed(1)}%` : '';
          infoBar.textContent = `원본 ${nW}×${nH} → 출력 ${dW}×${dH}  |  샤프닝: ${sharpLabel}${motionStr}`;
        }
        _busUnsubs.push(Bus.on('signal', updateInfo));
        tabSyncFns.push(updateInfo); updateInfo();
        const infoTimerId = setRecurring(() => { try { updateInfo(); } catch (_) {} }, 2500, { maxErrors: 50 });
        sig.addEventListener('abort', () => clearRecurring(infoTimerId), { once: true });
        w.append(infoBar, mkSep());

        /* ── 2. 자동 보정 & GPU ── */
        const sceneBadge = h('span', { style: 'font-size:10px;opacity:.6;display:none' }, '');
        function updateSceneBadge() { if (Store.get(P.APP_AUTO_SCENE)) { sceneBadge.style.display = ''; sceneBadge.textContent = ` [${AutoScene.getSceneTypeName?.() || ''}]`; } else { sceneBadge.style.display = 'none'; } }
        w.append(h('div', { class: 'row' }, h('label', {}, '자동 보정 (AutoScene) ', sceneBadge), mkToggle(P.APP_AUTO_SCENE, v => { if (v) AutoScene.start(); else AutoScene.stop(); updateSceneBadge(); ApplyReq.hard(); })));
        _busUnsubs.push(Bus.on('signal', updateSceneBadge));
        tabSyncFns.push(updateSceneBadge); updateSceneBadge();
        w.append(h('div', { class: 'row' }, h('label', {}, 'GPU 하드웨어 가속'), mkToggle(P.APP_GPU_EN, (nv) => { window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !!nv; showOSD(nv ? 'GPU 활성화 시도…' : 'GPU OFF → CPU', 1200); ApplyReq.soft(); })));
        w.append(mkSep());

        /* ── 4. 디테일 프리셋 & 강도 믹스 ── */
        w.append(
          mkChipRow('디테일 프리셋', P.V_PRE_S, Object.keys(PRESETS.detail).map(k => ({ v: k, l: getPresetLabel('detail', k) })), () => ApplyReq.hard()),
          mkRow('강도 믹스', ...mkSlider(P.V_PRE_MIX, 0, 1, 0.01)),
          mkSep()
        );

        /* ── 5. 수동 보정 ── */
        const manualHeader = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0' },
          h('label', { style: 'font-size:12px;opacity:.8;font-weight:600' }, '수동 보정'),
          h('div', { style: 'display:flex;gap:4px' },
            ...[
              { n: 'OFF', v: [0, 0, 0] }, { n: '표준', v: [20, 20, 15] }, { n: '영화', v: [50, 20, 10] },
              { n: '복원', v: [10, 50, 15] }, { n: '심야', v: [40, 15, 5] }, { n: '아트', v: [0, 40, 30] }
            ].map(p => {
              const btn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:36px;font-size:10px;background:rgba(110,168,254,0.1)' }, p.n);
              btn.addEventListener('click', () => {
                Store.batch('video', { manualShadow: p.v[0], manualRecovery: p.v[1], manualBright: p.v[2] });
                ApplyReq.hard(); persistNow(); syncAll(); showOSD(`추천 프리셋 [${p.n}] 적용됨`, 1000);
              }, { signal: sig });
              return btn;
            })
          )
        );

        function mkSliderWithFine(label, path, min, max, step, fineStep) {
          const [slider, valEl] = mkSlider(path, min, max, step);
          const syncSliderUI = () => { const v = Number(Store.get(path)) || 0; slider.value = String(v); valEl.textContent = String(Math.round(v)); const pct = ((v - min) / (max - min)) * 100; slider.style.setProperty('--fill', `${pct}%`); };
          const mkFine = (delta, text) => { const btn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:32px;min-height:28px;font-size:11px' }, text); btn.addEventListener('click', () => { const cur = Number(Store.get(path)) || 0; Store.set(path, VSC_CLAMP(Math.round(cur + delta), min, max)); ApplyReq.hard(); persistNow(); syncSliderUI(); }, { signal: sig }); return btn; };
          const resetBtn = h('button', { class: 'fine-btn', style: 'padding:2px 6px;min-width:24px;min-height:28px;font-size:10px;opacity:.6' }, '0');
          resetBtn.addEventListener('click', () => { Store.set(path, 0); ApplyReq.hard(); persistNow(); syncSliderUI(); }, { signal: sig });
          const fineRow = h('div', { style: 'display:flex;gap:3px;margin-left:4px' }, mkFine(-fineStep, `−${fineStep}`), mkFine(+fineStep, `+${fineStep}`), resetBtn);
          tabSyncFns.push(syncSliderUI);
          return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctrl' }, slider, valEl, fineRow));
        }

        w.append(
          manualHeader,
          mkSliderWithFine('암부 부스트', P.V_MAN_SHAD, 0, 100, 1, 5),
          mkSliderWithFine('디테일 복원', P.V_MAN_REC, 0, 100, 1, 5),
          mkSliderWithFine('밝기', P.V_MAN_BRT, 0, 100, 1, 5)
        );

        return w;
      }

      function buildAutoSenseTab() {
        const w = h('div', {});

        /* ── 헤더 ── */
        const headerRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:0 0 8px' },
          h('div', { style: 'font-size:14px;font-weight:800;color:#6ea8fe;text-shadow:0 0 6px rgba(110,168,254,0.3)' }, '🧠 AutoSense 7'),
          h('div', { style: 'font-size:10px;opacity:.45' }, 'v204.0.0')
        );
        w.appendChild(headerRow);

        /* ── 자동 보정 & GPU 토글 (이 탭에서 직접 제어) ── */
        const sceneBadge = h('span', { style: 'font-size:10px;opacity:.6;display:none' }, '');
        function updateSceneBadge() {
          if (Store.get(P.APP_AUTO_SCENE)) {
            sceneBadge.style.display = '';
            sceneBadge.textContent = ` [${AutoScene.getSceneTypeName?.() || ''}]`;
          } else { sceneBadge.style.display = 'none'; }
        }
        w.append(
          h('div', { class: 'row' }, h('label', {}, '자동 보정 (AutoScene) ', sceneBadge), mkToggle(P.APP_AUTO_SCENE, v => { if (v) AutoScene.start(); else AutoScene.stop(); updateSceneBadge(); ApplyReq.hard(); })),
          h('div', { class: 'row' }, h('label', {}, 'GPU 하드웨어 가속'), mkToggle(P.APP_GPU_EN, (nv) => { window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !!nv; showOSD(nv ? 'GPU 활성화 시도…' : 'GPU OFF → CPU', 1200); ApplyReq.soft(); }))
        );
        _busUnsubs.push(Bus.on('signal', updateSceneBadge));
        tabSyncFns.push(updateSceneBadge); updateSceneBadge();
        w.appendChild(mkSep());

        /* ── 일괄 버튼 ── */
        const ALL_FEAT_PATHS = [P.APP_SMART_SHARP, P.APP_ADAPT_SAT, P.APP_SKIN_PROTECT, P.APP_AUTO_ZOOM, P.APP_ZONAL_CONTRAST, P.APP_SMOOTH_TRANS, P.APP_HDR_TONEMAP];
        const FEAT_DEFAULTS = { [P.APP_SMART_SHARP]: true, [P.APP_ADAPT_SAT]: true, [P.APP_SKIN_PROTECT]: true, [P.APP_AUTO_ZOOM]: false, [P.APP_ZONAL_CONTRAST]: true, [P.APP_SMOOTH_TRANS]: true, [P.APP_HDR_TONEMAP]: false };

        const allOnBtn = h('button', { class: 'btn pr', style: 'font-size:10px;padding:4px 12px' }, '전체 ON');
        const allOffBtn = h('button', { class: 'btn', style: 'font-size:10px;padding:4px 12px' }, '전체 OFF');
        const allResetBtn = h('button', { class: 'btn', style: 'font-size:10px;padding:4px 12px;margin-left:auto' }, '기본값');
        allOnBtn.addEventListener('click', () => { for (const p of ALL_FEAT_PATHS) Store.set(p, true); ApplyReq.hard(); persistNow(); syncAll(); showOSD('지능형 기능 전체 ON', 1000); }, { signal: sig });
        allOffBtn.addEventListener('click', () => { for (const p of ALL_FEAT_PATHS) Store.set(p, false); ApplyReq.hard(); persistNow(); syncAll(); showOSD('지능형 기능 전체 OFF', 1000); }, { signal: sig });
        allResetBtn.addEventListener('click', () => { for (const [p, v] of Object.entries(FEAT_DEFAULTS)) Store.set(p, v); ApplyReq.hard(); persistNow(); syncAll(); showOSD('지능형 기능 기본값 복원', 1000); }, { signal: sig });
        w.appendChild(h('div', { style: 'display:flex;gap:6px;padding:4px 0' }, allOnBtn, allOffBtn, allResetBtn));
        w.appendChild(mkSep());

        /* ── Tier 1 ── */
        w.appendChild(h('div', { class: 'feat-title' }, '🥇 Tier 1 — 항상 활성 권장'));
        w.appendChild(mkFeatToggle(P.APP_SMART_SHARP, '적응형 샤프닝', '움직임이 많으면 샤프닝↓, 어두우면 노이즈 방지용↓ — 2D 매트릭스 기반', 'tier1', (nv) => showOSD(`적응형 샤프닝: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkFeatToggle(P.APP_ADAPT_SAT, '채도 클리핑 가드', 'chroma 기반 동적 채도 조절 — 과채도 클리핑 방지 + 저채도 보상', 'tier1', (nv) => showOSD(`채도 클리핑 가드: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkFeatToggle(P.APP_SKIN_PROTECT, '스킨톤 보호', '피부색 영역 감지 → R 채널 댐핑 + 따뜻한 색온도 보정', 'tier1', (nv) => showOSD(`스킨톤 보호: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkSep());

        /* ── Tier 2 ── */
        w.appendChild(h('div', { class: 'feat-title', style: 'margin-top:2px' }, '🥈 Tier 2 — 상황별 활성화'));
        w.appendChild(mkFeatToggle(P.APP_AUTO_ZOOM, '레터박스 자동 줌', '21:9 / 2.35:1 등 검은 바 감지 시 자동 확대 — 해제 시 자동 복원', 'tier2', (nv) => { if (!nv) { const zm = window[VSC_INTERNAL_SYM]?.ZoomManager; const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (zm && v && v.isConnected && zm.isZoomed(v)) zm.resetZoom(v); } showOSD(`레터박스 자동 줌: ${nv ? 'ON' : 'OFF'}`, 1000); }));
        w.appendChild(mkFeatToggle(P.APP_ZONAL_CONTRAST, '구역별 콘트라스트', '역광 장면에서 중앙 밝기↑ + 가장자리 억제 — BACKLIT 장면 전용', 'tier2', (nv) => showOSD(`구역별 콘트라스트: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkFeatToggle(P.APP_SMOOTH_TRANS, '독립 파라미터 보간', '밝기·색상·채도를 각각 다른 속도로 부드럽게 전환 — 컷 전환 번쩍임 방지', 'tier2', (nv) => showOSD(`독립 보간: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkFeatToggle(P.APP_HDR_TONEMAP, 'HDR 톤매핑', 'PQ/HLG HDR → SDR 디스플레이 최적화 — HDR 콘텐츠 감지 시 자동 활성', 'tier2', (nv) => showOSD(`HDR 톤매핑: ${nv ? 'ON' : 'OFF'}`, 1000)));
        w.appendChild(mkSep());

        /* ── 실시간 상태 ── */
        const featStatus = h('div', { class: 'feat-status', style: 'font-size:10px;opacity:.55;padding:4px 0;line-height:1.6' });
        function updateFeatStatus() {
          const lines = [];
          const as = AutoScene;
          if (Store.get(P.APP_AUTO_SCENE)) {
            lines.push(`장면: ${as.getSceneTypeName?.() || '—'}`);
            const motion = as.getLastMotionSAD?.() || 0;
            if (motion > 0.001) lines.push(`모션: ${(motion * 100).toFixed(1)}%`);
            if (as.isHDRDetected?.()) lines.push(`HDR: ${as.getHDRTransfer?.() || 'detected'}`);
            const lb = as.getLetterboxState?.();
            if (lb?.detected) lines.push(`레터박스: ${lb.ratio.toFixed(2)}:1${lb.autoZoomed ? ' (줌됨)' : ''}`);
            if (as.isGpuActive?.()) lines.push('GPU: 활성');
          } else {
            lines.push('자동 보정 꺼짐 — 위에서 활성화하세요');
          }
          featStatus.textContent = lines.join('  |  ');
        }
        _busUnsubs.push(Bus.on('signal', updateFeatStatus));
        tabSyncFns.push(updateFeatStatus);
        const featStatusTimer = setRecurring(updateFeatStatus, 2000, { maxErrors: 50 });
        sig.addEventListener('abort', () => clearRecurring(featStatusTimer), { once: true });
        updateFeatStatus();
        w.appendChild(featStatus);

        /* ── 간략 설명 ── */
        w.appendChild(h('div', { style: 'font-size:9px;opacity:.3;padding:8px 0 0;line-height:1.5' },
          'AutoSense는 프레임별 장면 분석을 통해 영상 품질을 자동 최적화합니다. ' +
          'Tier 1은 부작용이 적어 항상 켜둘 수 있으며, Tier 2는 특정 상황에서 효과적입니다.'
        ));

        return w;
      }

      function buildAudioTab() {
        const w = h('div', {});
        w.append(mkRow('오디오 부스트', mkToggle(P.A_EN, () => ApplyReq.soft())), mkRow('부스트 (dB)', ...mkSlider(P.A_BST, 0, 18, 0.5)));
        const status = h('div', { style: 'font-size:10px;opacity:.5;padding:4px 0' }, '오디오: 대기');
        _busUnsubs.push(Bus.on('signal', () => {
          const ctxReady = Audio.hasCtx(), hooked = Audio.isHooked(), bypassed = Audio.isBypassed(), worklet = Audio.isWorklet?.();
          let t = `상태: ${ctxReady ? (hooked ? '활성' : '준비') : '대기'}`; if (bypassed) t += ' (바이패스)'; if (worklet) t += ' [Worklet]';
          status.textContent = t;
        }));
        w.append(mkSep(), status);
        return w;
      }

      function buildPlaybackTab() {
        const w = h('div', {});
        w.append(mkRow('속도 제어', mkToggle(P.PB_EN, () => ApplyReq.hard())));
        const rateDisplay = h('div', { class: 'rate-display' });
        function syncRateDisplay() { rateDisplay.textContent = `${(Number(Store.get(P.PB_RATE)) || 1).toFixed(2)}×`; }
        tabSyncFns.push(syncRateDisplay); syncRateDisplay();
        w.append(rateDisplay);

        const chipRow = h('div', { class: 'chips' });
        function syncChips() { const cur = Number(Store.get(P.PB_RATE)) || 1; for (const c of chipRow.children) c.classList.toggle('on', Math.abs(cur - parseFloat(c.dataset.v)) < 0.01); }
        for (const p of [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 5.0]) {
          const el = h('span', { class: 'chip', 'data-v': String(p) }, `${p}×`);
          el.addEventListener('click', () => { Store.set(P.PB_RATE, p); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); syncRateDisplay(); syncChips(); }, { signal: sig });
          chipRow.appendChild(el);
        }
        tabSyncFns.push(syncChips); syncChips();
        w.append(chipRow);

        const fineRow = h('div', { class: 'fine-row' });
        const adjustRate = (delta) => { const nv = VSC_CLAMP((Number(Store.get(P.PB_RATE)) || 1) + delta, 0.07, 16); Store.set(P.PB_RATE, nv); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); syncRateDisplay(); syncChips(); };
        for (const fs of [{ label: '−0.25', delta: -0.25 }, { label: '−0.05', delta: -0.05 }, { label: '+0.05', delta: +0.05 }, { label: '+0.25', delta: +0.25 }]) {
          const btn = h('button', { class: 'fine-btn' }, fs.label);
          btn.addEventListener('click', () => adjustRate(fs.delta), { signal: sig });
          fineRow.appendChild(btn);
        }
        w.append(fineRow, mkRow('속도 슬라이더', ...mkSlider(P.PB_RATE, 0.07, 4, 0.01)), h('div', { style: 'font-size:10px;opacity:.4;text-align:center;padding:4px 0' }, '단축키: [ ] 속도 ±0.1'));
        Store.sub(P.PB_RATE, () => { syncRateDisplay(); syncChips(); });
        return w;
      }

      function buildAppTab() {
        const w = h('div', {});
        w.append(mkRow('모든 영상 적용', mkToggle(P.APP_APPLY_ALL, () => ApplyReq.hard())), mkSep(), h('label', { style: 'font-size:12px;opacity:.8;display:block;padding:4px 0' }, '프리셋 슬롯'));
        const slotsRow = h('div', { style: 'display:flex;gap:6px;padding:4px 0' });
        for (let i = 0; i < 3; i++) {
          const saveBtn = h('button', { class: 'btn', style: 'font-size:10px;padding:3px 8px' }, `저장 ${i + 1}`);
          const loadBtn = h('button', { class: 'btn pr', style: 'font-size:10px;padding:3px 8px' }, `적용 ${i + 1}`);
          saveBtn.addEventListener('click', () => saveSlot(i), { signal: sig });
          loadBtn.addEventListener('click', () => { loadSlot(i); syncAll(); }, { signal: sig });
          slotsRow.append(h('div', { style: 'display:flex;flex-direction:column;gap:3px' }, saveBtn, loadBtn));
        }
        w.append(slotsRow, mkSep());

        const expBtn = h('button', { class: 'btn' }, '내보내기'), impBtn = h('button', { class: 'btn' }, '가져오기'), rstBtn = h('button', { class: 'btn', style: 'margin-left:auto' }, '전체 초기화');
        expBtn.addEventListener('click', doExport, { signal: sig });
        impBtn.addEventListener('click', doImport, { signal: sig });
        rstBtn.addEventListener('click', () => { resetDefaults(); syncAll(); ApplyReq.hard(); persistNow(); showOSD('설정이 초기화되었습니다', 1500); }, { signal: sig });
        w.append(h('div', { style: 'display:flex;gap:6px;padding:4px 0' }, expBtn, impBtn, rstBtn), mkSep());

        const shortcutArrSpan = h('span', { class: 'arr' }, '▶');
        const shortcutHd = h('div', { class: 'adv-hd' }, shortcutArrSpan, ' 단축키 안내');
        const shortcutBd = h('div', { class: 'adv-bd-wrap collapsed' });
        let shortcutOpen = false;
        shortcutHd.addEventListener('click', () => {
          shortcutOpen = !shortcutOpen;
          shortcutArrSpan.classList.toggle('open', shortcutOpen);
          shortcutArrSpan.textContent = shortcutOpen ? '▼' : '▶';
          shortcutBd.classList.toggle('collapsed', !shortcutOpen);
        }, { signal: sig });
        const shortcuts = [['Alt + V', '설정 패널 열기/닫기'], ['Alt + P', 'PiP 전환'], ['Alt + M', '최대화 토글'], ['Alt + Z', '줌 ON/OFF 토글'], ['Alt + A', '자동 보정 ON/OFF'], ['Alt + S', '프레임 캡처'], ['Alt + G', 'GPU 장면분석 토글'], ['Alt + B', 'A/B 원본 비교 토글'], ['Alt + 0', '줌 리셋'], ['Alt + 1~3', '프리셋 슬롯 불러오기'], ['Shift + Alt + 1~3', '프리셋 슬롯 저장'], ['Alt + R', '전체 초기화'], ['[ / ]', '재생 속도 ±0.1'], ['Esc', '패널 닫기 / 최대화 해제'], ['Alt + Wheel', '줌 확대/축소']];
        const grid = h('div', { class: 'shortcut-grid' });
        for (const [key, desc] of shortcuts) { grid.append(h('span', { class: 'sk' }, key), h('span', { class: 'sd' }, desc)); }
        shortcutBd.appendChild(grid);
        w.append(shortcutHd, shortcutBd, mkSep(), h('div', { style: 'font-size:10px;opacity:.35;padding:2px 0' }, `Video_Control v${VSC_VERSION}`));
        return w;
      }

      function syncAll() { for (const fn of syncFns) { try { fn(); } catch (_) {} } }

      function renderTab() {
        const body = _shadow?.querySelector('.body'); if (!body) return;
        for (const child of body.children) child.style.display = 'none';
        tabSyncFns.length = 0;

        let cached = _tabDomCache.get(activeTab);
        if (cached && cached.isConnected) {
          cached.style.display = '';
          const cachedSyncs = _tabSyncCache.get(activeTab);
          if (cachedSyncs) tabSyncFns.push(...cachedSyncs);
        } else {
          const prevSyncLen = tabSyncFns.length;
          let tabDom;
          switch (activeTab) { case 'video': tabDom = buildVideoTab(); break; case 'autosense': tabDom = buildAutoSenseTab(); break; case 'audio': tabDom = buildAudioTab(); break; case 'playback': tabDom = buildPlaybackTab(); break; case 'app': tabDom = buildAppTab(); break; }
          if (tabDom) { body.appendChild(tabDom); _tabDomCache.set(activeTab, tabDom); _tabSyncCache.set(activeTab, tabSyncFns.slice(prevSyncLen)); }
        }
        syncFns.length = 0; syncFns.push(...permanentSyncFns, ...tabSyncFns);
        for (const fn of tabSyncFns) { try { fn(); } catch (_) {} }
      }

      function invalidateTabCache() { for (const [, dom] of _tabDomCache) { try { dom.remove(); } catch (_) {} } _tabDomCache.clear(); _tabSyncCache.clear(); }
      function switchTab(t) { activeTab = t; if (_shadow) _shadow.querySelectorAll('.tab').forEach(el => el.classList.toggle('on', el.dataset.t === t)); renderTab(); }
      function hasAnyVideo() { if (Registry.videos.size > 0) return true; try { return document.querySelector('video') !== null; } catch (_) { return false; } }
      function updateQuickBarVisibility() { if (!quickBarHost) return; const has = hasAnyVideo(); if (has && !qbarVisible) { quickBarHost.style.display = ''; qbarVisible = true; } else if (!has && qbarVisible) { quickBarHost.style.display = 'none'; qbarVisible = false; if (panelOpen) togglePanel(false); } }
      function reparentForFullscreen() { if (!quickBarHost) return; const fsEl = document.fullscreenElement || document.webkitFullscreenElement; const tp = fsEl || document.body || document.documentElement; if (!tp) return; if (quickBarHost.parentNode !== tp) { try { tp.appendChild(quickBarHost); } catch (_) {} } if (panelHost && panelHost.parentNode !== tp) { try { tp.appendChild(panelHost); } catch (_) {} } }

      function buildMetricsFooter() {
        const footer = h('div', { class: 'metrics-footer' }), elRes = h('span', {}, '—'), elRate = h('span', {}, '—');
        const abIndicator = h('span', { class: 'ab-indicator' }, 'A/B');
        footer.append(elRes, elRate, abIndicator);
        function updateMetrics() {
          const v = window[VSC_INTERNAL_SYM]?._activeVideo;
          if (v && v.isConnected) { elRes.textContent = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—'; elRate.textContent = `${v.playbackRate.toFixed(2)}×`; abIndicator.classList.toggle('active', !!getVState(v).__abCompare); }
          else { elRes.textContent = '—'; elRate.textContent = '—'; abIndicator.classList.remove('active'); }
        }
        _busUnsubs.push(Bus.on('signal', updateMetrics)); permanentSyncFns.push(updateMetrics); updateMetrics();
        const mt = setRecurring(updateMetrics, 2000, { maxErrors: 50 }); sig.addEventListener('abort', () => clearRecurring(mt), { once: true });
        return footer;
      }

      function buildPanel() {
        if (panelHost) return;
        panelHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-host' });
        _shadow = panelHost.attachShadow({ mode: 'closed' });
        _shadow.appendChild(h('style', {}, PANEL_CSS));
        panelEl = h('div', { class: 'panel' });
        const closeBtn = h('button', { class: 'btn', style: 'padding:2px 8px;font-size:12px;margin-left:8px' }, '✕');
        closeBtn.addEventListener('click', () => togglePanel(false), { signal: sig });

        const statusDots = h('div', { class: 'hdr-status', title: '상태 인디케이터' });
        const gpuDot = h('span', { class: 'hdr-dot gray', 'data-label': 'GPU' }), dspDot = h('span', { class: 'hdr-dot gray', 'data-label': 'DSP' }), drmDot = h('span', { class: 'hdr-dot gray', style: 'display:none', 'data-label': 'DRM' });
        statusDots.append(gpuDot, dspDot, drmDot);
        function syncStatusDots() {
          const gpuSt = getGpuStatus(); gpuDot.className = `hdr-dot ${gpuSt === 'active' ? 'green' : (gpuSt === 'fallback' ? 'amber' : 'gray')}`;
          const dspSt = getDspStatus(); dspDot.className = `hdr-dot ${dspSt === 'worklet' ? 'green' : (dspSt === 'legacy' ? 'amber' : 'gray')}`;
          if (isDrmDetected()) { drmDot.style.display = ''; drmDot.className = 'hdr-dot red'; } else drmDot.style.display = 'none';
        }
        _busUnsubs.push(Bus.on('signal', syncStatusDots)); permanentSyncFns.push(syncStatusDots);
        const dotT = setRecurring(syncStatusDots, 2000, { maxErrors: 50 }); sig.addEventListener('abort', () => clearRecurring(dotT), { once: true }); syncStatusDots();

        panelEl.appendChild(h('div', { class: 'hdr' }, h('span', { class: 'tl' }, 'VSC'), statusDots, h('span', { class: 'ver' }, `v${VSC_VERSION}`), closeBtn));
        const tabBar = h('div', { class: 'tabs' });
        for (const t of ['video', 'autosense', 'audio', 'playback', 'app']) {
          const tab = h('div', { class: `tab${t === activeTab ? ' on' : ''}`, 'data-t': t });
          const iconEl = TAB_ICONS[t]?.(); if (iconEl) tab.appendChild(iconEl);
          tab.appendChild(h('span', {}, TAB_LABELS[t]));
          tab.addEventListener('click', () => switchTab(t), { signal: sig });
          tabBar.appendChild(tab);
        }
        panelEl.appendChild(tabBar); panelEl.appendChild(h('div', { class: 'body' })); panelEl.appendChild(buildMetricsFooter());
        _shadow.appendChild(panelEl); renderTab();
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        (fsEl || document.documentElement || document.body).appendChild(panelHost);
        blockInterference(panelHost);
      }

      function buildQuickBar() {
        if (quickBarHost) return;
        quickBarHost = h('div', { 'data-vsc-ui': '1', id: 'vsc-gear-host', style: 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647!important;pointer-events:none;display:none;' });
        qbarVisible = false;
        const sh = quickBarHost.attachShadow({ mode: 'closed' }); _qbarShadow = sh;
        sh.appendChild(h('style', {}, PANEL_CSS));

        const bar = h('div', { class: 'qbar' }); let expanded = false; let expandTimer = 0;
        const makeIcon = (name) => { const builder = VSC_ICON_BUILDERS[name]; if (!builder) return document.createTextNode(''); const svg = builder(18); svg.style.display = 'block'; svg.style.pointerEvents = 'none'; return svg; };
        const EXPAND_TIMEOUT = CONFIG.IS_MOBILE ? 6000 : 4000;
        function collapseBar() { if (!expanded) return; expanded = false; bar.classList.remove('expanded'); }
        function resetExpandTimer() { if (expandTimer) clearTimer(expandTimer); if (expanded && !panelOpen) expandTimer = setTimer(collapseBar, EXPAND_TIMEOUT); }

        const mainBtn = h('div', { class: 'qb qb-main', title: '메뉴 열기' }); mainBtn.appendChild(makeIcon('gear'));
        mainBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); expanded = !expanded; bar.classList.toggle('expanded', expanded); if (!expanded) collapseBar(); resetExpandTimer(); }, { signal: sig });

        const subBtns = [
          { icon: 'gear', title: '설정 패널', fn: () => { togglePanel(); collapseBar(); } },
          { icon: 'pip', title: 'PiP 전환', fn: () => { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) togglePiPFor(v); resetExpandTimer(); } },
          { icon: 'maximize', title: '최대화', fn: () => { Maximizer.toggle(); resetExpandTimer(); } },
          { icon: 'camera', title: '프레임 캡처', fn: () => { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) captureVideoFrame(v); resetExpandTimer(); } }
        ].map(cfg => {
          const btn = h('div', { class: 'qb qb-sub', title: cfg.title }); btn.appendChild(makeIcon(cfg.icon));
          btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); cfg.fn(); }, { signal: sig });
          return btn;
        });

        if (ZoomMgr) {
          const zoomBtn = h('div', { class: 'qb qb-sub', title: '줌 ON/OFF (Alt+Z)' }); zoomBtn.appendChild(makeIcon('zoom'));
          const syncZoomStyle = () => { const en = !!Store.get(P.APP_ZOOM_EN); zoomBtn.style.background = en ? 'rgba(110,168,254,.35)' : ''; zoomBtn.style.borderColor = en ? 'rgba(110,168,254,.5)' : ''; };
          zoomBtn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const wasOn = !!Store.get(P.APP_ZOOM_EN);
            Store.set(P.APP_ZOOM_EN, !wasOn);
            if (wasOn) { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v && ZoomMgr) ZoomMgr.resetZoom(v); showOSD('줌 OFF', 900); }
            else showOSD('줌 ON', 1500);
            syncZoomStyle(); ApplyReq.soft(); persistNow(); resetExpandTimer();
          }, { signal: sig });
          Store.sub(P.APP_ZOOM_EN, syncZoomStyle); syncZoomStyle(); subBtns.push(zoomBtn);
        }
        bar.append(mainBtn, ...subBtns); sh.appendChild(bar);
        const mount = () => (document.body || document.documentElement).appendChild(quickBarHost);
        if (document.body) mount(); else window.addEventListener('DOMContentLoaded', mount, { once: true });
      }

      function togglePanel(force) {
        if (_panelTransitioning) return;
        const show = (force !== undefined) ? force : !panelOpen;
        if (show === panelOpen) return;
        _panelTransitioning = true;
        if (show) {
          buildPanel(); reparentForFullscreen();
          if (panelHost) panelHost.style.pointerEvents = '';
          requestAnimationFrame(() => { panelEl?.classList.add('open'); _panelTransitioning = false; });
        } else {
          panelEl?.classList.remove('open');
          setTimer(() => { if (!panelOpen && panelHost) panelHost.style.pointerEvents = 'none'; _panelTransitioning = false; }, 250);
        }
        panelOpen = show; Store.set(P.APP_UI, show);
      }

      function init() {
        buildQuickBar();
        Store.sub('video.*', syncAll); Store.sub('audio.*', syncAll); Store.sub('playback.*', syncAll); Store.sub('app.*', syncAll);
        setRecurring(updateQuickBarVisibility, 1500, { maxErrors: 50 });
        _busUnsubs.push(Bus.on('signal', updateQuickBarVisibility));
        onDoc('fullscreenchange', reparentForFullscreen); onDoc('webkitfullscreenchange', reparentForFullscreen);
        updateQuickBarVisibility();
      }
      function destroy() {
        uiAC.abort();
        for (const unsub of _busUnsubs) { try { unsub(); } catch (_) {} } _busUnsubs.length = 0;
        panelHost?.remove(); quickBarHost?.remove(); panelHost = null; panelEl = null; quickBarHost = null; _shadow = null; _qbarShadow = null;
        syncFns.length = 0; permanentSyncFns.length = 0; tabSyncFns.length = 0; qbarVisible = false;
        invalidateTabCache();
      }
      return Object.freeze({ init, destroy, togglePanel, syncAll, switchTab, invalidateTabCache });
    }


    /* ══════════════════════════════════════════════════════════════
       5-C  Save / Restore / Reset / Import / Export
       ══════════════════════════════════════════════════════════════ */
    function buildSaveDataFrom(sm) { return { version: VSC_VERSION, timestamp: Date.now(), video: { ...sm.getCatRef('video') }, audio: { ...sm.getCatRef('audio') }, playback: { ...sm.getCatRef('playback') }, app: { ...sm.getCatRef('app') } }; }

    function restoreData(sm, data) {
      if (!data || typeof data !== 'object') return;
      if (data.video && typeof data.video === 'object') sm.batch('video', data.video);
      if (data.audio && typeof data.audio === 'object') sm.batch('audio', data.audio);
      if (data.playback && typeof data.playback === 'object') sm.batch('playback', data.playback);
      if (data.app && typeof data.app === 'object') { const { slots, ...rest } = data.app; sm.batch('app', rest); if (Array.isArray(slots) && slots.length <= 10) sm.set('app.slots', slots); }
      normalizeBySchema(sm, ALL_SCHEMAS);
    }

    let __Store = null, __ApplyReq = null, __UI = null;
    function resetDefaults() {
      if (!__Store) return;
      const d = typeof structuredClone === 'function' ? structuredClone(DEFAULTS) : JSON.parse(JSON.stringify(DEFAULTS));
      for (const [cat, vals] of Object.entries(d)) __Store.batch(cat, vals);
      if (__UI?.invalidateTabCache) __UI.invalidateTabCache();
    }

    function saveSlot(idx) {
      if (!__Store) return; const data = buildSaveDataFrom(__Store);
      const slots = [...(__Store.getCatRef('app').slots || [null, null, null])];
      if (idx < 0 || idx >= slots.length) return;
      slots[idx] = data; __Store.set('app.slots', slots); persistNow();
      showOSD(`슬롯 ${idx + 1} 저장됨`, 1200);
    }

    function loadSlot(idx) {
      if (!__Store) return; const slots = __Store.getCatRef('app').slots || [null, null, null];
      if (idx < 0 || idx >= slots.length) return;
      const data = slots[idx];
      if (!data || typeof data !== 'object') { showOSD(`슬롯 ${idx + 1} 비어있음`, 1000); return; }
      if (!data.video && !data.audio && !data.playback) { showOSD(`슬롯 ${idx + 1} 데이터 손상`, 1000); return; }
      restoreData(__Store, data); __ApplyReq?.hard(); persistNow();
      showOSD(`슬롯 ${idx + 1} 불러옴`, 1200);
    }

    function doExport() {
      if (!__Store) return;
      const json = JSON.stringify(buildSaveDataFrom(__Store), null, 2);
      const blob = new Blob([json], { type: 'application/json' }); const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `vsc-settings-${Date.now()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimer(() => URL.revokeObjectURL(url), 3000); showOSD('설정 내보내기 완료', 1200);
    }

    function doImport() {
      if (!__Store) return;
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json'; inp.style.display = 'none';
      inp.addEventListener('change', () => { const f = inp.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => { try { const data = JSON.parse(rd.result); restoreData(__Store, data); __ApplyReq?.hard(); persistNow(); showOSD('설정 가져오기 완료', 1200); } catch (e) { showOSD('가져오기 실패', 1500); } }; rd.readAsText(f); });
      document.body.appendChild(inp); inp.click(); inp.remove();
    }

    let __persistTimer = 0;
    function persistNow(immediate = false) {
      if (!__Store) return;
      const doSave = () => { try { GM_setValue(STORAGE_KEY, JSON.stringify(buildSaveDataFrom(__Store))); } catch (e) { log.warn('[Persist] save error', e); } };
      clearTimer(__persistTimer);
      if (immediate) { doSave(); return; }
      __persistTimer = setTimer(doSave, 400);
    }

    function loadPersisted(sm) {
      try {
        let raw = GM_getValue(STORAGE_KEY, null);
        if (!raw && location.hostname.endsWith('youtube.com')) {
          const isShorts = location.pathname.startsWith('/shorts'), isWatch = location.pathname.startsWith('/watch');
          if (isShorts || isWatch) { const oldKey = STORAGE_KEY_BASE + (isShorts ? '__shorts' : '__watch'); const legacy = GM_getValue(oldKey, null); if (legacy) { raw = legacy; GM_setValue(STORAGE_KEY, raw); } }
        }
        if (!raw) return;
        const data = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        if (!data || typeof data !== 'object') return;
        restoreData(sm, data);
      } catch (e) { log.warn('[Persist] load error', e); }
    }


    /* ══════════════════════════════════════════════════════════════
       5-D  bindVideoOnce
       ══════════════════════════════════════════════════════════════ */
    function bindVideoOnce(video, Store, Registry, AutoScene, ApplyReq, ZoomMgr, FiltersVO) {
      const st = getVState(video); if (st.bound) return; st.bound = true;
      const videoAC = new AbortController(); const videoSig = combineSignals(__globalSig, videoAC.signal); st._ac = videoAC;
      touchedAddLimited(TOUCHED.videos, video, (evicted) => {
        queueMicrotask(() => { const es = getVState(evicted); if (es._ac) { es._ac.abort(); es._ac = null; es.bound = false; } try { FiltersVO.clear(evicted); } catch (_) {} vscClearAllStyles(evicted); });
      });
      on(video, 'resize', () => { st._resizeDirty = true; }, { signal: videoSig });
      const onVideoReady = () => { if (videoSig.aborted) return; st._resizeDirty = true; ApplyReq.hard(); };
      on(video, 'loadedmetadata', onVideoReady, { signal: videoSig }); on(video, 'loadeddata', onVideoReady, { signal: videoSig });
      if (video.readyState >= 1) setTimer(() => { if (!videoSig.aborted) ApplyReq.hard(); }, 80);

      on(video, 'encrypted', () => {
        if (__encryptedVideos.has(video)) return; __encryptedVideos.add(video);
        const rs = getRateState(video); if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig; } catch (_) {} } rs.permanentlyBlocked = true;
      }, { signal: videoSig });

      on(video, 'waitingforkey', () => { __encryptedVideos.add(video); const rs = getRateState(video); if (!rs.permanentlyBlocked) { rs.permanentlyBlocked = true; if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig; } catch (_) {} } } }, { signal: videoSig });

      on(video, 'ratechange', () => {
        if (!Store.get(P.PB_EN)) return; const expected = Number(Store.get(P.PB_RATE)); if (!Number.isFinite(expected)) return;
        if (Math.abs(video.playbackRate - expected) < 0.002) { st.rateState._rateRetryCount = 0; return; }
        const now = performance.now(); if (now < st.rateState.suppressSyncUntil) return;
        if (__rateBlockedSite || isVideoEncrypted(video)) { st.rateState.permanentlyBlocked = true; if (st.rateState.orig != null) { st.rateState.suppressSyncUntil = now + RATE_SUPPRESS_MS; try { video.playbackRate = st.rateState.orig; } catch (_) {} } return; }
        st.rateState._totalRetries++; if (st.rateState._totalRetries > RATE_SESSION_MAX) { st.rateState.permanentlyBlocked = true; showOSD('속도 제어: 이 사이트에서 차단됨', 2000); return; }
        st.rateState._rateRetryCount++; if (st.rateState._rateRetryCount > RATE_MAX_RETRY) { st.rateState.permanentlyBlocked = true; return; }
        const delay = Math.min(RATE_BACKOFF_BASE * (1 << (st.rateState._rateRetryCount - 1)), RATE_BACKOFF_MAX);
        setTimer(() => { if (!video.isConnected || st.rateState.permanentlyBlocked || videoSig.aborted) return; if (isVideoEncrypted(video)) { st.rateState.permanentlyBlocked = true; return; } st.rateState.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = expected; } catch (_) {} }, delay);
      }, { signal: videoSig });

      on(video, 'play', () => ApplyReq.soft(), { signal: videoSig });
      on(video, 'pause', () => ApplyReq.soft(), { signal: videoSig });
      if (ZoomMgr?.onNewVideoForZoom) ZoomMgr.onNewVideoForZoom(video);
      patchFullscreenRequest(video);

      videoSig.addEventListener('abort', () => {
        st.bound = false; st.resetTransient(); try { FiltersVO?.clear(video); } catch (_) {} vscClearAllStyles(video);
      }, { once: true });
    }


    /* ══════════════════════════════════════════════════════════════
       5-E  createApplyLoop
       ══════════════════════════════════════════════════════════════ */
    function createApplyLoop(Store, Scheduler, Registry, TargetingMod, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq) {
      const __lastUserPt = { x: 0, y: 0, t: 0 };
      onWin('pointermove', e => { __lastUserPt.x = e.clientX; __lastUserPt.y = e.clientY; __lastUserPt.t = performance.now(); }, { passive: true });
      onWin('touchstart', e => { if (e.touches.length > 0) { __lastUserPt.x = e.touches[0].clientX; __lastUserPt.y = e.touches[0].clientY; __lastUserPt.t = performance.now(); } }, { passive: true });

      let prevTarget = null;
      setRecurring(() => {
        if (Registry.videos.size === 0 && TOUCHED.videos.size === 0 && TOUCHED.rateVideos.size === 0) return;
        Registry.prune();
        for (const key of ['videos', 'rateVideos']) { for (const v of TOUCHED[key]) { if (!v.isConnected) TOUCHED[key].delete(v); } }
      }, 5000, { maxErrors: 50 });

      function restoreRate(video) {
        const rs = getRateState(video);
        if (rs.orig != null && video.isConnected && Math.abs(video.playbackRate - (rs.orig || 1)) > 0.002) {
          rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { video.playbackRate = rs.orig || 1; } catch (_) {}
        }
        rs.orig = null; rs._rateRetryCount = 0; rs._totalRetries = 0; rs.permanentlyBlocked = false;
      }

      function apply(forceApply) {
        if (__globalSig.aborted) return;
        const applyAll = !!Store.get(P.APP_APPLY_ALL);

        if (!Store.get(P.APP_ACT)) {
          if (prevTarget) { FiltersVO.clear(prevTarget); prevTarget = null; }
          window[VSC_INTERNAL_SYM]._activeVideo = null; Audio.setTarget(null);
          for (const v of TOUCHED.rateVideos) { if (v.isConnected) restoreRate(v); }
          for (const v of TOUCHED.videos) { const vst = getVState(v); if (vst.__abCompare) vst.__abCompare = false; }
          return;
        }

        const audioBoostOn = !!Store.get(P.A_EN);
        const { target } = TargetingMod.pickFastActiveOnly(Registry.visible.videos, __lastUserPt, audioBoostOn);
        if (!target && !applyAll) return;
        if (target !== prevTarget || forceApply) {
          if (prevTarget && prevTarget !== target) FiltersVO.clear(prevTarget);
          if (target !== prevTarget) ParamsMemo.invalidate();
          prevTarget = target; window[VSC_INTERNAL_SYM]._activeVideo = target; Audio.setTarget(target);
        }
        const vfUser = Store.getCatRef('video'); const pbEn = !!Store.get(P.PB_EN); const pbRate = Number(Store.get(P.PB_RATE));
        const targets = new Set(); if (target) targets.add(target); if (applyAll) { for (const v of Registry.visible.videos) { if (v.isConnected) targets.add(v); } }

        for (const v of TOUCHED.videos) { if (!v.isConnected || targets.has(v)) continue; const vst = getVState(v); if (vst.applied) FiltersVO.clear(v); }
        if (pbEn) { for (const v of TOUCHED.rateVideos) { if (!v.isConnected || targets.has(v)) continue; restoreRate(v); } }

        for (const v of targets) {
          if (pbEn && Number.isFinite(pbRate) && pbRate > 0) {
            const rs = getRateState(v);
            if (!rs.permanentlyBlocked) {
              if (rs.orig == null) rs.orig = v.playbackRate;
              if (Math.abs(v.playbackRate - pbRate) > 0.002) {
                if (rs._totalRetries >= RATE_SESSION_MAX) rs.permanentlyBlocked = true;
                else if (isVideoEncrypted(v)) { rs.permanentlyBlocked = true; if (rs.orig != null) { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { v.playbackRate = rs.orig; } catch (_) {} } }
                else { rs.suppressSyncUntil = performance.now() + RATE_SUPPRESS_MS; try { v.playbackRate = pbRate; rs._rateRetryCount = 0; } catch (_) { rs._rateRetryCount++; rs._totalRetries++; } }
                touchedAddLimited(TOUCHED.rateVideos, v);
              }
            }
          } else restoreRate(v);

          const vst = getVState(v);
          if (vst.__abCompare) { FiltersVO.clear(v); continue; }

          const params = ParamsMemo.get(vfUser, v);
          if (!params || isNeutralVideoParams(params)) FiltersVO.clear(v);
          else { const filterResult = FiltersVO.prepareCached(v, params); FiltersVO.applyFilter(v, filterResult); }
          touchedAddLimited(TOUCHED.videos, v);
        }
      }
      Scheduler.registerApply(apply);
      return { apply, restoreRate };
    }


    /* ══════════════════════════════════════════════════════════════
       5-F  createKeyboard
       ══════════════════════════════════════════════════════════════ */
    function createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr, FiltersVO) {
      const STEP_RATE = 0.1;
      function isPanelOpen() { try { return !!Store.get(P.APP_UI); } catch (_) { return false; } }

      onDoc('keydown', e => {
        if (isEditableTarget(e.target)) return;
        const k = e.key, shift = e.shiftKey, alt = e.altKey;

        if (k === 'Escape') {
          if (isPanelOpen()) { UI?.togglePanel(false); return; }
          if (Maximizer?.isActive()) { Maximizer.undoMaximize(); return; }
          if (ZoomMgr) { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v && ZoomMgr.isZoomed(v)) { ZoomMgr.resetZoom(v); showOSD('줌 리셋', 600); return; } }
          return;
        }
        if (alt && k === 'v') { UI?.togglePanel(); e.preventDefault(); return; }
        if (alt && k === 'p') { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) togglePiPFor(v); e.preventDefault(); return; }
        if (alt && (k === 'm' || k === 'M')) { Maximizer?.toggle(); e.preventDefault(); return; }
        if (alt && (k === 'a' || k === 'A')) { const nv = !Store.get(P.APP_AUTO_SCENE); Store.set(P.APP_AUTO_SCENE, nv); if (nv) AutoScene.start(); else AutoScene.stop(); ApplyReq.hard(); persistNow(); showOSD(`자동 보정: ${nv ? '켜짐' : '꺼짐'}`, 1000); e.preventDefault(); return; }
        if (alt && (k === 'g' || k === 'G')) { const wasOn = !!window[VSC_INTERNAL_SYM]?._gpuSceneEnabled; window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !wasOn; Store.set(P.APP_GPU_EN, !wasOn); showOSD(!wasOn ? 'GPU ON' : 'GPU OFF → CPU', 1200); ApplyReq.soft(); UI?.syncAll(); persistNow(); e.preventDefault(); return; }
        if (alt && (k === 's' || k === 'S')) { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) captureVideoFrame(v); e.preventDefault(); return; }
                if (alt && (k === 'b' || k === 'B')) {
          const v = window[VSC_INTERNAL_SYM]?._activeVideo;
          if (v) {
            const st = getVState(v);
            st.__abCompare = !st.__abCompare;
            if (st.__abCompare) {
              FiltersVO.clear(v);
              showOSD('원본 비교 모드 (Alt+B 해제)', 1500);
            } else {
              ApplyReq.hard();
              showOSD('필터 적용됨', 800);
            }
          }
          e.preventDefault(); return;
        }

        if (alt && k === '0') { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v && ZoomMgr) ZoomMgr.resetZoom(v); e.preventDefault(); return; }
        if (alt && (k === 'z' || k === 'Z')) {
          if (!ZoomMgr) return;
          const wasOn = !!Store.get(P.APP_ZOOM_EN);
          Store.set(P.APP_ZOOM_EN, !wasOn);
          if (wasOn) { const v = window[VSC_INTERNAL_SYM]?._activeVideo; if (v) ZoomMgr.resetZoom(v); showOSD('줌 OFF', 900); }
          else showOSD('줌 ON', 900);
          ApplyReq.soft(); persistNow(); UI?.syncAll(); e.preventDefault(); return;
        }
        if (alt && (k === 'r' || k === 'R')) { resetDefaults(); ApplyReq.hard(); persistNow(); UI?.syncAll(); showOSD('초기화 완료', 1000); e.preventDefault(); return; }
        if (alt && k >= '1' && k <= '3') { const idx = parseInt(k) - 1; if (shift) saveSlot(idx); else loadSlot(idx); UI?.syncAll(); e.preventDefault(); return; }
        if (k === '[' || k === ']') { const cur = Number(Store.get(P.PB_RATE)) || 1; const nv = VSC_CLAMP(cur + (k === ']' ? STEP_RATE : -STEP_RATE), 0.07, 16); Store.set(P.PB_RATE, nv); if (!Store.get(P.PB_EN)) Store.set(P.PB_EN, true); ApplyReq.hard(); persistNow(); UI?.syncAll(); showOSD(`속도: ${nv.toFixed(2)}×`, 900); e.preventDefault(); return; }
      }, { signal: __globalSig, capture: true });
    }


    /* ══════════════════════════════════════════════════════════════
       5-G  BOOTSTRAP
       ══════════════════════════════════════════════════════════════ */
    function bootstrap() {
      const VSC_VERSION_ID = '204.0.0-Hybrid';
      log.info(`[VSC] v${VSC_VERSION_ID} booting on ${location.hostname}`);

      window[VSC_INTERNAL_SYM]._gpuSceneActive = false;
      window[VSC_INTERNAL_SYM]._gpuSceneEnabled = false;
      window[VSC_INTERNAL_SYM]._gpuSceneInit = null;
      window[VSC_INTERNAL_SYM]._gpuSceneDestroy = null;
      window[VSC_INTERNAL_SYM]._dspMode = 'off';
      window[VSC_INTERNAL_SYM]._activeVideo = null;

      const MS = createModuleSystem(__globalSig);
      MS.defineFeature('Utils', { init: () => createUtils() });
      MS.defineFeature('Scheduler', { init: () => createScheduler() });
      MS.defineFeature('Store', { deps: ['Utils', 'Scheduler'], init: ({ Utils, Scheduler }) => { const store = createLocalStore(DEFAULTS, Scheduler, Utils); loadPersisted(store); return store; } });
      MS.defineFeature('Bus', { init: () => createEventBus() });
      MS.defineFeature('ApplyReq', { deps: ['Bus', 'Scheduler'], init: ({ Bus, Scheduler }) => createApplyRequester(Bus, Scheduler) });
      MS.defineFeature('Registry', { deps: ['Scheduler'], priority: 10, init: ({ Scheduler }) => createRegistry(Scheduler) });
      MS.defineFeature('Targeting', { init: () => createTargeting() });
      MS.defineFeature('Audio', { deps: ['Store'], init: ({ Store }) => createAudio(Store), destroy: (inst) => { inst.destroy(); } });
      MS.defineFeature('AutoScene', { deps: ['Store', 'Scheduler'], init: ({ Store, Scheduler }) => createAutoSceneManager(Store, P, Scheduler), destroy: (inst) => { inst.stop(); } });
      MS.defineFeature('ParamsMemo', { deps: ['Store', 'Utils'], init: ({ Store, Utils }) => createVideoParamsMemo(Store, P, Utils) });
      MS.defineFeature('FiltersVO', { deps: ['Utils'], init: ({ Utils }) => createFiltersVideoOnly(Utils, CONFIG) });
      MS.defineFeature('Maximizer', { deps: ['Store', 'ApplyReq'], init: ({ Store, ApplyReq }) => createVideoMaximizer(Store, ApplyReq) });
      MS.defineFeature('ZoomMgr', { init: () => FEATURE_FLAGS.zoomFeature ? createZoomManager() : null, destroy: (inst) => { if (inst) inst.destroy(); } });

      const moduleNames = ['Utils', 'Scheduler', 'Store', 'Bus', 'ApplyReq', 'Registry', 'Targeting', 'Audio', 'AutoScene', 'ParamsMemo', 'FiltersVO', 'Maximizer', 'ZoomMgr'];
      MS.resolveAll(moduleNames);

      const Store = MS.get('Store'), Scheduler = MS.get('Scheduler'), Bus = MS.get('Bus'), ApplyReq = MS.get('ApplyReq'),
            Registry = MS.get('Registry'), Targeting = MS.get('Targeting'), Audio = MS.get('Audio'),
            AutoScene = MS.get('AutoScene'), ParamsMemo = MS.get('ParamsMemo'), FiltersVO = MS.get('FiltersVO'),
            Maximizer = MS.get('Maximizer'), ZoomMgr = MS.get('ZoomMgr');

      window[VSC_INTERNAL_SYM].Store = Store;
      window[VSC_INTERNAL_SYM].ApplyReq = ApplyReq;
      window[VSC_INTERNAL_SYM].AutoScene = AutoScene;
      window[VSC_INTERNAL_SYM].ZoomManager = ZoomMgr;
      window[VSC_INTERNAL_SYM].AudioEngine = Audio;
      __Store = Store; __ApplyReq = ApplyReq;

      window[VSC_INTERNAL_SYM].getActiveVideo = () => window[VSC_INTERNAL_SYM]._activeVideo;
      window[VSC_INTERNAL_SYM]._gpuSceneEnabled = !!Store.get(P.APP_GPU_EN);

      Bus.on('signal', (p) => Scheduler.request(!!p?.forceApply));
      for (const cat of ['video.*', 'audio.*', 'playback.*', 'app.*']) Store.sub(cat, () => persistNow());
      onWin('beforeunload', () => { persistNow(true); }, { passive: true });

      const applyLoop = createApplyLoop(Store, Scheduler, Registry, Targeting, Audio, AutoScene, FiltersVO, ParamsMemo, ApplyReq);

      Store.sub(P.PB_RATE, () => { for (const v of TOUCHED.rateVideos) { const rs = getRateState(v); if (!isVideoEncrypted(v)) { rs.permanentlyBlocked = false; rs._rateRetryCount = 0; rs._totalRetries = 0; } } });
      Store.sub(P.PB_EN, (enabled) => { if (!enabled) { for (const v of TOUCHED.rateVideos) { if (v.isConnected) applyLoop.restoreRate(v); } } });

      const processVideo = (v) => bindVideoOnce(v, Store, Registry, AutoScene, ApplyReq, ZoomMgr, FiltersVO);

      const scanAll = () => {
        let count = 0;
        const scanIn = (root) => { if (!root) return; try { const vs = root.querySelectorAll('video'); for (let i = 0; i < vs.length; i++) { if (!Registry.videos.has(vs[i])) { processVideo(vs[i]); count++; } } } catch (_) {} };
        scanIn(document);
        try { const iframes = document.querySelectorAll('iframe'); for (let i = 0; i < iframes.length; i++) { try { const doc = iframes[i].contentDocument || iframes[i].contentWindow?.document; if (doc) scanIn(doc); } catch (_) {} } } catch (_) {}
        return count;
      };

      const _processedIframes = new WeakSet();
      const checkIframes = () => {
        try {
          const iframes = document.querySelectorAll('iframe');
          for (const ifr of iframes) {
            if (_processedIframes.has(ifr)) continue; _processedIframes.add(ifr);
            ifr.addEventListener('load', () => { setTimer(scanAll, 500); }, { signal: __globalSig, passive: true });
            try { const doc = ifr.contentDocument || ifr.contentWindow?.document; if (doc?.readyState === 'complete') scanAll(); } catch (_) {}
          }
        } catch (_) {}
      };

      const setupDynamicIframeMonitoring = () => {
        const mo = new MutationObserver(checkIframes);
        const root = document.body || document.documentElement;
        if (root) mo.observe(root, { childList: true, subtree: true });
        __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
        checkIframes();
      };

      const runInitialScan = () => {
        scanAll();
        setTimer(() => { const found = scanAll(); if (found === 0) setTimer(scanAll, 2000); }, 1500);
      };

      const rescanDebounced = createDebounced(() => {
        ParamsMemo.invalidate(); scanAll(); Registry.rescanAll(); ApplyReq.hard();
        __rateBlockedSite = isRateBlockedContext();
      }, SPA_RESCAN_DEBOUNCE_MS);

      initSpaUrlDetector(rescanDebounced);

      setRecurring(() => { for (const v of Registry.videos) { if (v.isConnected && !getVState(v).bound) processVideo(v); } }, 800, { maxErrors: 50 });

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { setupDynamicIframeMonitoring(); runInitialScan(); Scheduler.request(true); }, { once: true, signal: __globalSig });
      } else { setupDynamicIframeMonitoring(); runInitialScan(); Scheduler.request(true); }

      setTimer(() => { if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) AutoScene.start(); }, 300);

      const Utils = MS.get('Utils');
      const UI = createUI(Store, Bus, Utils, Audio, AutoScene, ZoomMgr, Targeting, Maximizer, FiltersVO, Registry, Scheduler, ApplyReq);
      __UI = UI;
      window[VSC_INTERNAL_SYM]._uiEnsure = () => {};

      const waitForBody = () => {
        if (document.body) { UI.init(); return; }
        const mo = new MutationObserver(() => { if (document.body) { mo.disconnect(); UI.init(); } });
        mo.observe(document.documentElement || document, { childList: true });
        __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
      };
      waitForBody();

      createKeyboard(Store, ApplyReq, UI, Maximizer, AutoScene, ZoomMgr, FiltersVO);
      if (FEATURE_FLAGS.iframeInjection) watchIframes();

      window[VSC_APP_SYM] = Object.freeze({
        getActiveVideo: () => window[VSC_INTERNAL_SYM]._activeVideo,
        getGpuStatus: () => window[VSC_INTERNAL_SYM]._gpuSceneActive,
        getDspMode: () => window[VSC_INTERNAL_SYM]._dspMode,
        version: VSC_VERSION_ID
      });

      onDoc('visibilitychange', () => { if (!document.hidden) ApplyReq.soft(); }, { passive: true });
      onDoc('fullscreenchange', () => {
        if (!document.fullscreenElement && __osdEl) {
          if (!__osdEl.isConnected) { clearTimer(__osdTimerId); __osdTimerId = 0; __osdEl = null; }
        }
        ApplyReq.soft(); UI.syncAll();
      });

      __globalSig.addEventListener('abort', () => {
        persistNow(true);
        MS.destroyAll();
        for (const v of TOUCHED.videos) { FiltersVO.clear(v); vscClearAllStyles(v); }
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
        GM_registerMenuCommand('VSC 설정 초기화', () => {
          resetDefaults(); ApplyReq.hard(); persistNow(); UI.syncAll();
          showOSD('초기화 완료', 1000);
        });
        GM_registerMenuCommand('VSC 자동 보정 토글', () => {
          const nv = !Store.get(P.APP_AUTO_SCENE);
          Store.set(P.APP_AUTO_SCENE, nv);
          if (nv) AutoScene.start(); else AutoScene.stop();
          ApplyReq.hard(); persistNow();
          showOSD(`자동 보정: ${nv ? '켜짐' : '꺼짐'}`, 1000);
        });
        GM_registerMenuCommand('VSC 비디오 재스캔', () => {
          const found = scanAll();
          Registry.rescanAll(); ApplyReq.hard();
          showOSD(`비디오 재스캔: ${found}개 발견`, 1200);
        });
      } catch (_) {}

      const gpuAvail = typeof navigator.gpu !== 'undefined' ? 'WebGPU ✓' : 'WebGPU ✗';
      const workletAvail = typeof AudioWorkletNode !== 'undefined' ? 'AudioWorklet ✓' : 'AudioWorklet ✗';
      try {
        console.log(
          `%c VSC %c v${VSC_VERSION_ID} %c ${Registry.videos.size} video(s) | ${gpuAvail} | ${workletAvail} `,
          'background:#6ea8fe;color:#000;font-weight:bold;padding:2px 6px;border-radius:4px 0 0 4px',
          'background:#333;color:#fff;padding:2px 6px',
          'background:#222;color:#888;padding:2px 6px;border-radius:0 4px 4px 0'
        );
      } catch (_) {
        log.info(`[VSC] v${VSC_VERSION_ID} ready — ${Registry.videos.size} video(s) | ${gpuAvail} | ${workletAvail}`);
      }
    }

    /* ════════════════════════════════════════════════
       ENTRY POINT
       ════════════════════════════════════════════════ */
    try { bootstrap(); } catch (e) { console.error('[VSC] bootstrap error', e); }

// ═══ END OF PART 5 (v204.0.0-Hybrid) — FINAL ═══
 } // ← VSC_MAIN 함수 종료

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', VSC_MAIN, { once: true });
  } else {
    VSC_MAIN();
  }
})(); // ← IIFE 종료
