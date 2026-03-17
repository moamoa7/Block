// ==UserScript==
// @name         Video_Control (v196.0.0)
// @namespace    https://github.com/
// @version      196.0.0
// @description  v196: Bottom-tab UI, Uint32 alignment, pooled histograms, long-press speed, AudioCtx permanent block, CircularBuffer, VideoFrame capture
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
    const VSC_BOOT_KEY = '__VSC_BOOT_LOCK__';
    if (window[VSC_BOOT_KEY]) return;
    try { Object.defineProperty(window, VSC_BOOT_KEY, { value: true, writable: false }); } catch (e) { window[VSC_BOOT_KEY] = true; }

    window.__VSC_INTERNAL__ ||= {};
    let __vscUserSignalRev = 0;

    function isEditableTarget(t) { return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)); }

    const __globalHooksAC = new AbortController();
    const __globalSig = __globalHooksAC.signal;

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
      const maxErrors = opts.maxErrors ?? 200;
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

    const combineSignals = (...signals) => {
      const existing = signals.filter(Boolean);
      if (existing.length === 0) return undefined;
      if (existing.length === 1) return existing[0];
      if (typeof AbortSignal.any === 'function') return AbortSignal.any(existing);
      const ac = new AbortController();
      for (const sig of existing) {
        if (sig.aborted) { ac.abort(sig.reason); return ac.signal; }
      }
      const onAbort = (reason) => { if (!ac.signal.aborted) ac.abort(reason); };
      for (const sig of existing) {
        sig.addEventListener('abort', () => onAbort(sig.reason), { once: true, signal: ac.signal });
      }
      return ac.signal;
    };

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

    const __blockedElements = new WeakSet();
    const BLOCK_EVENTS_PASSIVE = Object.freeze(['pointerdown', 'pointerup', 'dblclick', 'contextmenu']);
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
      for (const evt of BLOCK_EVENTS_PASSIVE) on(el, evt, stop, { passive: true });
      on(el, 'click', (e) => { if (isInteractiveInPath(e)) return; e.stopPropagation(); }, { passive: true });
      on(el, 'wheel', (e) => { if (e.altKey) return; e.stopPropagation(); }, { passive: true });
    }

    function detectMobile() {
      try { if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile; } catch (_) {}
      return /Mobi|Android|iPhone/i.test(navigator.userAgent);
    }

    const CONFIG = Object.freeze({
      IS_MOBILE: detectMobile(),
      TOUCHED_MAX: 140,
      VSC_ID: (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, ""),
      DEBUG: false
    });
    const VSC_VERSION = '196.0.0';

    const COLOR_CAST_CORRECTION = 0.14;

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

    const VSC_CLAMP = (v, min, max) => (v < min ? min : (v > max ? max : v));

    function tempToRgbGain(temp) {
      const t = VSC_CLAMP((Number(temp) || 0) / 50, -1, 1);
      const r = 1 + 0.14 * t;
      const g = 1 - 0.02 * Math.abs(t);
      const b = 1 - 0.14 * t;
      const m = Math.max(r, g, b);
      return { rs: r / m, gs: g / m, bs: b / m };
    }

    const VSC_DEFENSE = Object.freeze({ audioCooldown: true, autoSceneDrmBackoff: true });
    const FEATURE_FLAGS = Object.freeze({ trackShadowRoots: true, iframeInjection: true, zoomFeature: true });
    const SHADOW_ROOT_LRU_MAX = 6;
    const SPA_RESCAN_DEBOUNCE_MS = 350;
    const GUARD = Object.freeze({
      AUDIO_SRC_COOLDOWN: 3000,
      AUDIO_SRC_COOLDOWN_DRM: 8000,
      TARGET_HYSTERESIS_MS: 500,
      TARGET_HYSTERESIS_MARGIN: 1.2
    });

    const RATE_BLOCKED_HOSTS = Object.freeze(['netflix.com','disneyplus.com','primevideo.com','hulu.com','max.com','peacocktv.com','paramountplus.com','crunchyroll.com']);
    const RATE_BLOCKED_PATHS = Object.freeze([{ host: 'amazon.com', pathPrefix: '/gp/video' }]);
    function isRateBlockedContext() {
      const h = location.hostname;
      if (RATE_BLOCKED_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
      return RATE_BLOCKED_PATHS.some(rule => (h === rule.host || h.endsWith('.' + rule.host)) && location.pathname.startsWith(rule.pathPrefix));
    }
    const __rateBlockedSite = isRateBlockedContext();

    const LOG_LEVEL = CONFIG.DEBUG ? 4 : 1;
    const log = {
      error: (...args) => LOG_LEVEL >= 1 && console.error('[VSC]', ...args),
      warn: (...args) => LOG_LEVEL >= 2 && console.warn('[VSC]', ...args),
      info: (...args) => LOG_LEVEL >= 3 && console.info('[VSC]', ...args),
      debug: (...args) => LOG_LEVEL >= 4 && console.debug('[VSC]', ...args)
    };

    /* ── Video State ── */
    function createVideoState() {
      return {
        visible: false, rect: null, bound: false, rateState: null,
        audioFailUntil: 0, applied: false, desiredRate: undefined,
        lastFilterUrl: null, rectT: 0, rectEpoch: -1, fsPatched: false,
        _resizeDirty: false, _ac: null, _inPiP: false,
        lastCssFilterStr: null, _transitionCleared: false,
        resetTransient() {
          this.audioFailUntil = 0; this.rect = null; this.rectT = 0; this.rectEpoch = -1;
          if (this.rateState) {
            this.rateState.orig = null; this.rateState.lastSetAt = 0;
            this.rateState.retryCount = 0; this.rateState.failCount = 0;
            this.rateState.permanentlyBlocked = false; this.rateState.suppressSyncUntil = 0;
            this.rateState._externalMtQueued = false;
            this.rateState._rateRetryWindow = 0; this.rateState._rateRetryCount = 0;
          }
          this.desiredRate = undefined;
        }
      };
    }
    const videoStateMap = new WeakMap();
    function getVState(v) { let st = videoStateMap.get(v); if (!st) { st = createVideoState(); videoStateMap.set(v, st); } return st; }

    function getRateState(v) {
      const st = getVState(v);
      if (!st.rateState) {
        st.rateState = {
          orig: null, lastSetAt: 0, retryCount: 0, failCount: 0,
          permanentlyBlocked: false, suppressSyncUntil: 0,
          _externalMtQueued: false, _rateRetryWindow: 0, _rateRetryCount: 0
        };
      }
      return st.rateState;
    }

    /* ── Shadow Band ── */
    const SHADOW_BAND = Object.freeze({ OUTER: 1, MID: 2, DEEP: 4 });
    const ShadowMask = Object.freeze({
      has(mask, bit) { return ((Number(mask) | 0) & bit) !== 0; },
      toggle(mask, bit) { return (((Number(mask) | 0) ^ bit) & 7); }
    });

    /* ── Presets (v196: labels integrated) ── */
    const PRESETS = Object.freeze({
      detail: {
        off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0, label: 'OFF' },
        S:   { sharpAdd: 12, sharp2Add: 2, clarityAdd: 3, label: '1080p' },
        M:   { sharpAdd: 15, sharp2Add: 8, clarityAdd: 8, label: '720p' },
        L:   { sharpAdd: 16, sharp2Add: 18, clarityAdd: 14, label: '480p' },
        XL:  { sharpAdd: 20, sharp2Add: 14, clarityAdd: 18, label: '360p' }
      },
      grade: {
        off: { gammaF: 1.00, brightAdd: 0, label: 'OFF' },
        DS:  { gammaF: 1.04, brightAdd: 3.0, label: '복원1' },
        DM:  { gammaF: 1.08, brightAdd: 6.0, label: '복원2' },
        DL:  { gammaF: 1.16, brightAdd: 9.5, label: '복원3' }
      }
    });
    const getPresetLabel = (group, key) => PRESETS[group]?.[key]?.label || key;

    /* ── Defaults & Paths ── */
    const DEFAULTS = {
      video: { presetS: 'off', presetB: 'off', presetMix: 1.0, shadowBandMask: 0, brightStepLevel: 0 },
      audio: { enabled: false, boost: 6 },
      playback: { rate: 1.0, enabled: false },
      app: { active: true, uiVisible: false, applyAll: false, zoomEn: false, autoScene: false, advanced: false, autoPreset: false }
    };
    const P = Object.freeze({
      APP_ACT: 'app.active', APP_UI: 'app.uiVisible', APP_APPLY_ALL: 'app.applyAll',
      APP_ZOOM_EN: 'app.zoomEn', APP_AUTO_SCENE: 'app.autoScene', APP_ADV: 'app.advanced',
      APP_AUTO_PRESET: 'app.autoPreset',
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
      { type: 'bool', path: P.APP_ADV },
      { type: 'bool', path: P.APP_AUTO_PRESET }
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

    /* ── attachShadow patch ── */
    if (FEATURE_FLAGS.trackShadowRoots) {
      window.__VSC_INTERNAL__._onShadow = null;
      (function patchAttachShadowOnce() {
        try {
          const proto = Element.prototype;
          if (!proto.attachShadow) return;
          const VSC_PATCH = Symbol.for('vsc.patch.attachShadow');
          if (proto[VSC_PATCH]) return;
          const desc = Object.getOwnPropertyDescriptor(proto, 'attachShadow'), orig = desc && desc.value;
          if (typeof orig !== 'function') return;
          try { Object.defineProperty(proto, VSC_PATCH, { value: true }); } catch (_) { proto[VSC_PATCH] = true; }
          function wrappedAttachShadow(init) {
            const shadow = orig.call(this, init);
            if (__globalSig.aborted) return shadow;
            try {
              if (shadow && typeof init === 'object' && init !== null) {
                let mode;
                try { mode = init.mode; } catch (_) { return shadow; }
                if (mode === 'open') {
                  const onShadow = window.__VSC_INTERNAL__?._onShadow;
                  if (onShadow) queueMicrotask(() => onShadow(this, shadow));
                }
              }
            } catch (_) {}
            return shadow;
          }
          try {
            Object.defineProperty(wrappedAttachShadow, 'toString', { value: Function.prototype.toString.bind(orig), configurable: true });
            Object.defineProperty(wrappedAttachShadow, 'name', { value: orig.name || 'attachShadow', configurable: true });
            Object.defineProperty(wrappedAttachShadow, 'length', { value: orig.length, configurable: true });
          } catch (_) {}
          if (desc && desc.configurable === false && desc.writable === false) return;
          Object.defineProperty(proto, 'attachShadow', { ...desc, value: wrappedAttachShadow });
        } catch (e) { log.warn('attachShadow patch failed:', e); }
      })();
    }

    /* ── TOUCHED sets & rect caching ── */
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

    /* ── CircularBuffer (v196) ── */
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
        const arr = new Float64Array(this._size);
        const start = (this._head - this._size + this._max) % this._max;
        for (let i = 0; i < this._size; i++) arr[i] = this._buf[(start + i) % this._max];
        arr.sort();
        return arr;
      }
      clear() { this._head = 0; this._size = 0; }
    }

    /* ── SPA URL detector ── */
    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return;
      window.__VSC_SPA_PATCHED__ = true;
      let lastHref = location.href;
      const origHistory = {};
      const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
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
        if (orig.__vsc_patched) return;
        origHistory[name] = orig;
        window.__VSC_INTERNAL__[`_orig_${name}`] = orig;
        let patched;
        try {
          patched = new Proxy(orig, {
            apply(target, thisArg, argsList) {
              const ret = Reflect.apply(target, thisArg, argsList);
              if (!__globalSig.aborted) queueMicrotask(emitIfChanged);
              return ret;
            }
          });
          patched.__vsc_patched = true;
          patched.__vsc_original = orig;
        } catch (_) {
          patched = function (...args) {
            const ret = Reflect.apply(orig, this, args);
            if (!__globalSig.aborted) queueMicrotask(emitIfChanged);
            return ret;
          };
          patched.__vsc_patched = true;
          patched.__vsc_original = orig;
        }
        history[name] = patched;
      };
      wrap('pushState'); wrap('replaceState');
      onWin('popstate', emitIfChanged, { passive: true });
      window.__VSC_INTERNAL__._spaOrigHistory = origHistory;
      __globalSig.addEventListener('abort', () => {
        for (const name of Object.keys(origHistory)) {
          try {
            const current = history[name];
            if (current?.__vsc_patched && current.__vsc_original === origHistory[name]) history[name] = origHistory[name];
          } catch (_) {}
        }
      }, { once: true });
    }

    /* ── Iframe injection (v196: canAccess pre-check) ── */
    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    const __injectedIframes = new WeakSet();
    const __iframeLoadHooked = new WeakSet();
    function watchIframes() {
      const canAccess = (ifr) => { try { const w = ifr.contentWindow; if (!w) return false; void w.location.href; return true; } catch (_) { return false; } };
      const inject = (ifr) => {
        if (!ifr || !canAccess(ifr) || __injectedIframes.has(ifr)) return;
        const tryInject = () => {
          try {
            const win = ifr.contentWindow;
            const doc = ifr.contentDocument || win?.document;
            if (!win || !doc) return;
            if (win.__VSC_BOOT_LOCK__) { __injectedIframes.add(ifr); return; }
            const host = doc.head || doc.documentElement;
            if (!host) return;
            const s = doc.createElement('script');
            s.textContent = __VSC_INJECT_SOURCE;
            host.appendChild(s);
            s.remove?.();
            __injectedIframes.add(ifr);
          } catch (_) {}
        };
        tryInject();
        if (!__iframeLoadHooked.has(ifr)) {
          __iframeLoadHooked.add(ifr);
          ifr.addEventListener('load', () => { if (canAccess(ifr)) tryInject(); }, { passive: true, signal: __globalSig });
        }
      };
      document.querySelectorAll("iframe").forEach(inject);
      const mo = new MutationObserver((muts) => {
        if (__globalSig.aborted) { mo.disconnect(); return; }
        for (const m of muts) {
          if (!m.addedNodes || !m.addedNodes.length) continue;
          for (const n of m.addedNodes) {
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'IFRAME') { if (canAccess(n)) inject(n); }
            else if (n.getElementsByTagName) {
              const iframes = n.getElementsByTagName('iframe');
              for (let i = 0; i < iframes.length; i++) { if (canAccess(iframes[i])) inject(iframes[i]); }
            }
          }
        }
      });
      const observeRoot = document.documentElement || document.body;
      if (observeRoot) mo.observe(observeRoot, { childList: true, subtree: true });
      else document.addEventListener('DOMContentLoaded', () => { if (__globalSig.aborted) return; const r = document.documentElement || document.body; if (r) mo.observe(r, { childList: true, subtree: true }); }, { once: true, signal: __globalSig });
      __globalSig.addEventListener('abort', () => mo.disconnect(), { once: true });
    }

    /* ── Fullscreen wrapper (v196: DOM capability test) ── */
    const fsWraps = new WeakMap();
    function ensureFsWrapper(video) {
      if (fsWraps.has(video)) return fsWraps.get(video);
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
        parent.insertBefore(wrap, video);
        wrap.appendChild(video);
      } catch (e) {
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
        log.warn('Video could not be restored to DOM after fullscreen exit. Source may be lost.');
      }
      try { if (ph?.parentNode) ph.remove(); } catch (_) {}
      try { if (wrap.parentNode && !wrap.querySelector('video')) wrap.remove(); } catch (_) {}
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
          try { window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
        });
      }
      if (window.__VSC_UI_Ensure) requestAnimationFrame(() => { try { window.__VSC_UI_Ensure(); } catch (_) {} });
    }
    onDoc('fullscreenchange', onFsChange);
    onDoc('webkitfullscreenchange', onFsChange);

    /* ── PiP state ── */
    let __activeDocumentPiPWindow = null, __activeDocumentPiPVideo = null, __pipPlaceholder = null, __pipOrigParent = null, __pipOrigNext = null, __pipOrigCss = '';
    function resetPiPState() { __activeDocumentPiPWindow = null; __activeDocumentPiPVideo = null; __pipPlaceholder = null; __pipOrigParent = null; __pipOrigNext = null; __pipOrigCss = ""; }
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
      if (__activeDocumentPiPWindow && __activeDocumentPiPWindow.closed) {
        const video = __activeDocumentPiPVideo;
        resetPiPState();
        if (video) { const st = getVState(video); st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; }
      }
    }, 2000);

    // ─── END OF PART 1 (v196.0.0) ───
    // ─── PART 2 START (v196.0.0) ───
    // enterPiP, exitPiP, togglePiPFor, captureVideoFrame,
    // createZoomManager, createTargeting, createEventBus, createApplyRequester,
    // createUtils, createScheduler, createLocalStore, normalizeBySchema, createRegistry

    async function enterPiP(video) {
      if (!video || video.readyState < 2) return false;
      try { window.__VSC_INTERNAL__?.Adapter?.clear(video); } catch (_) {}
      const st = getVState(video);
      st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null;
      if ('documentPictureInPicture' in window && window.documentPictureInPicture && typeof window.documentPictureInPicture.requestWindow === 'function') {
        if (__activeDocumentPiPWindow) {
          if (__activeDocumentPiPWindow.closed) resetPiPState();
          else if (__activeDocumentPiPVideo === video) return true;
          else { try { __activeDocumentPiPWindow.close(); } catch (_) {} resetPiPState(); }
        }
        try {
          const pipWindow = await window.documentPictureInPicture.requestWindow({
            width: Math.max(video.videoWidth / 2, 400),
            height: Math.max(video.videoHeight / 2, 225)
          });
          if (!video.isConnected || !video.parentNode) {
            try { pipWindow.close(); } catch (_) {}
            st._inPiP = false; return false;
          }
          __activeDocumentPiPWindow = pipWindow;
          __activeDocumentPiPVideo = video;
          __pipOrigParent = video.parentNode;
          __pipOrigNext = video.nextSibling;
          __pipOrigCss = video.style.cssText;
          __pipPlaceholder = document.createElement('div');
          __pipPlaceholder.style.width = video.clientWidth + 'px';
          __pipPlaceholder.style.height = video.clientHeight + 'px';
          __pipPlaceholder.style.background = 'black';
          if (__pipOrigParent) __pipOrigParent.insertBefore(__pipPlaceholder, video);
          pipWindow.document.body.style.margin = '0';
          pipWindow.document.body.style.display = 'flex';
          pipWindow.document.body.style.justifyContent = 'center';
          pipWindow.document.body.style.alignItems = 'center';
          pipWindow.document.body.style.background = 'black';
          video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
          const adopted = pipWindow.document.adoptNode(video);
          pipWindow.document.body.append(adopted);
          try {
            const mainSvg = document.querySelector(`svg filter[id^="vsc-"]`)?.closest('svg');
            if (mainSvg) {
              const cloned = mainSvg.cloneNode(true);
              cloned.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;';
              pipWindow.document.body.prepend(cloned);
            }
          } catch (_) {}
          const pipSt = getVState(video);
          pipSt.applied = false; pipSt.lastFilterUrl = null; pipSt.lastCssFilterStr = null;
          video.style.removeProperty('filter');
          video.style.removeProperty('-webkit-filter');
          video.style.removeProperty('background-color');
          pipWindow.addEventListener('click', () => {
            if (video.paused) {
              const p = video.play();
              if (p && typeof p.catch === 'function') p.catch(() => { video.muted = true; video.play().catch(() => {}); });
            } else video.pause();
          });
          pipWindow.addEventListener('pagehide', () => {
            cleanupPipDocumentSvg(pipWindow.document);
            try {
              if (!video) { resetPiPState(); return; }
              video.style.cssText = __pipOrigCss;
              let restored = video;
              try {
                if (video.ownerDocument && video.ownerDocument !== document) restored = document.adoptNode(video);
              } catch (adoptErr) {
                log.warn('PiP adoptNode failed:', adoptErr);
                try { restored = document.importNode(video, true); }
                catch (_) { resetPiPState(); st._inPiP = false; return; }
              }
              if (__pipPlaceholder?.parentNode?.isConnected) {
                __pipPlaceholder.parentNode.insertBefore(restored, __pipPlaceholder);
                __pipPlaceholder.remove();
              } else if (__pipOrigParent?.isConnected) {
                if (__pipOrigNext && __pipOrigNext.parentNode === __pipOrigParent) __pipOrigParent.insertBefore(restored, __pipOrigNext);
                else __pipOrigParent.appendChild(restored);
              } else if (restored !== video) {
                const target = document.body || document.documentElement;
                if (target) target.appendChild(restored);
              }
            } finally {
              resetPiPState();
              st._inPiP = false; st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null;
              st._transitionCleared = false;
              const oldAc = st._ac; st._ac = null; st.bound = false;
              if (oldAc) { try { oldAc.abort(); } catch (_) {} }
              st.resetTransient();
              queueMicrotask(() => {
                try {
                  const ApplyReq = window.__VSC_INTERNAL__?.ApplyReq;
                  if (!ApplyReq) return;
                  const target = video.isConnected ? video : null;
                  if (target && !getVState(target).bound) {
                    if (typeof bindVideoOnce === 'function') bindVideoOnce(target, ApplyReq);
                  }
                  ApplyReq.hard();
                } catch (_) {}
              });
            }
          });
          setTimer(() => {
            try { st.lastFilterUrl = null; st.lastCssFilterStr = null; st.applied = false; window.__VSC_INTERNAL__?.ApplyReq?.hard(); } catch (_) {}
          }, 200);
          return true;
        } catch (e) { log.debug('Document PiP failed, fallback to video PiP', e); }
      }
      if (document.pictureInPictureElement === video) return true;
      if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function') {
        try { st._inPiP = true; await video.requestPictureInPicture(); return true; }
        catch (e) { st._inPiP = false; return false; }
      }
      return false;
    }

    async function exitPiP(preferredVideo = null) {
      if (__activeDocumentPiPWindow) {
        if (!__activeDocumentPiPWindow.closed) __activeDocumentPiPWindow.close();
        else resetPiPState();
        return true;
      }
      if (document.pictureInPictureElement && document.exitPictureInPicture) {
        try { await document.exitPictureInPicture(); return true; } catch (_) {}
      }
      return false;
    }

    async function togglePiPFor(video) {
      if (!video || video.readyState < 2) return false;
      if ((__activeDocumentPiPWindow && !__activeDocumentPiPWindow.closed) || document.pictureInPictureElement === video) return exitPiP(video);
      if (document.pictureInPictureElement && document.exitPictureInPicture) { try { await document.exitPictureInPicture(); } catch (_) {} }
      return enterPiP(video);
    }

    function captureVideoFrame(video) {
      if (!video || video.readyState < 2) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `capture_${Date.now()}.png`; a.click();
        setTimer(() => URL.revokeObjectURL(url), 5000);
      }, 'image/png');
      showOSD('스크린샷 저장됨', 1500);
    }

    /* ── Zoom Manager ── */
    function createZoomManager() {
      const stateMap = new WeakMap();
      let activeVideo = null, isPanning = false, startX = 0, startY = 0;
      let pinchState = { active: false, initialDist: 0, initialScale: 1, lastCx: 0, lastCy: 0 };
      const zoomedVideos = new Set();
      let activePointerId = null, destroyed = false;

      const ZOOM_PROPS = ['will-change','contain','backface-visibility','transition','transform-origin','transform','cursor','z-index','position','touch-action'];

      const getSt = (v) => {
        let st = stateMap.get(v);
        if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, _savedPosition: '', _savedZIndex: '' }; stateMap.set(v, st); }
        return st;
      };

      const pendingUpdates = new Set();
      let rafId = null;

      function applyZoomStyle(v) {
        const st = getSt(v);
        const panning = isPanning || pinchState.active;
        if (st.scale <= 1) {
          if (st.zoomed) {
            for (const prop of ZOOM_PROPS) v.style.removeProperty(prop);
            if (st._savedPosition) v.style.setProperty('position', st._savedPosition);
            if (st._savedZIndex) v.style.setProperty('z-index', st._savedZIndex);
            st.zoomed = false;
          }
          st.scale = 1; st.tx = 0; st.ty = 0;
          zoomedVideos.delete(v);
          return;
        }
        if (!st.zoomed) {
          st._savedPosition = v.style.getPropertyValue('position');
          st._savedZIndex = v.style.getPropertyValue('z-index');
          st.zoomed = true;
        }
        v.style.setProperty('will-change', 'transform', 'important');
        v.style.setProperty('contain', 'layout paint', 'important');
        v.style.setProperty('backface-visibility', 'hidden', 'important');
        v.style.setProperty('transition', panning ? 'none' : 'transform 80ms ease-out', 'important');
        v.style.setProperty('transform-origin', '0 0', 'important');
        v.style.setProperty('transform', `translate3d(${st.tx.toFixed(2)}px, ${st.ty.toFixed(2)}px, 0) scale(${st.scale.toFixed(4)})`, 'important');
        v.style.setProperty('cursor', panning ? 'grabbing' : 'grab', 'important');
        v.style.setProperty('z-index', '2147483646', 'important');
        v.style.setProperty('position', 'relative', 'important');
        v.style.setProperty('touch-action', 'none', 'important');
        zoomedVideos.add(v);
      }

      const update = (v) => {
        if (destroyed) return;
        pendingUpdates.add(v);
        if (rafId != null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null; if (destroyed) return;
          const batch = [...pendingUpdates]; pendingUpdates.clear();
          for (const video of batch) { if (video.isConnected) applyZoomStyle(video); }
        });
      };

      function clampPan(v, st) {
        const r = v.getBoundingClientRect();
        if (!r || r.width <= 1 || r.height <= 1) return;
        const sw = r.width * st.scale, sh = r.height * st.scale;
        st.tx = VSC_CLAMP(st.tx, -(sw - r.width * 0.25), r.width * 0.75);
        st.ty = VSC_CLAMP(st.ty, -(sh - r.height * 0.25), r.height * 0.75);
      }

      const zoomTo = (v, newScale, clientX, clientY) => {
        const st = getSt(v), rect = v.getBoundingClientRect();
        if (!rect || rect.width <= 1) return;
        const ix = (clientX - rect.left) / st.scale;
        const iy = (clientY - rect.top) / st.scale;
        st.tx = clientX - (rect.left - st.tx) - ix * newScale;
        st.ty = clientY - (rect.top - st.ty) - iy * newScale;
        st.scale = newScale;
        clampPan(v, st);
        update(v);
      };

      const resetZoom = (v) => {
        if (!v) return;
        const st = getSt(v); st.scale = 1;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        pendingUpdates.delete(v);
        update(v);
      };

      const isZoomed = (v) => { const st = stateMap.get(v); return st ? st.scale > 1 : false; };
      const isZoomEnabled = () => !!window.__VSC_INTERNAL__?.Store?.get(P.APP_ZOOM_EN);
      const getTouchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const getTouchCenter = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

      function isVscUiEvent(e) {
        try {
          if (typeof e.composedPath === 'function') {
            const path = e.composedPath();
            for (let i = 0, len = Math.min(path.length, 20); i < len; i++) {
              const n = path[i];
              if (!n || !n.nodeType) continue;
              if (n.nodeType === 1) {
                if (n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host') return true;
              }
              if (n.nodeType === 11 && n.host) {
                if (n.host.hasAttribute?.('data-vsc-ui') || n.host.id === 'vsc-host' || n.host.id === 'vsc-gear-host') return true;
              }
            }
          }
        } catch (_) {}
        return false;
      }

      function getTargetVideo(e) {
        const points = [];
        if (e.touches) {
          for (let i = 0; i < e.touches.length; i++) {
            const t = e.touches[i];
            if (Number.isFinite(t.clientX) && Number.isFinite(t.clientY)) points.push({ x: t.clientX, y: t.clientY });
          }
        }
        if (points.length === 0 && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) points.push({ x: e.clientX, y: e.clientY });
        if (points.length === 2) points.push({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
        if (typeof e.composedPath === 'function') {
          const path = e.composedPath();
          for (let i = 0, len = Math.min(path.length, 15); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; }
        }
        if (points.length > 0) {
          const px = points[0].x, py = points[0].y;
          let bestVideo = null, bestArea = 0;
          for (const v of TOUCHED.videos) {
            if (!v || !v.isConnected) continue;
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
            const allVids = document.querySelectorAll('video');
            let bestVideo = null, bestArea = 0;
            for (const v of allVids) {
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
              const parent = el.parentElement;
              if (parent) { const siblingVid = parent.querySelector?.('video'); if (siblingVid) return siblingVid; }
              const container = el.closest?.('[class*="player"],[class*="Player"],[class*="video"],[class*="Video"],[id*="player"],[id*="Player"],[id*="video"],[id*="Video"],[data-player],[data-testid*="player"],[data-testid*="video"]');
              if (container) {
                const vid2 = container.querySelector('video');
                if (vid2) return vid2;
                if (container.shadowRoot) { const svid2 = container.shadowRoot.querySelector('video'); if (svid2) return svid2; }
              }
            }
          } catch (_) {}
        }
        const active = window.__VSC_INTERNAL__?._activeVideo;
        if (active?.isConnected) return active;
        try { const allVideos = document.querySelectorAll('video'); if (allVideos.length === 1 && allVideos[0].isConnected) return allVideos[0]; } catch (_) {}
        return null;
      }

      const __touchBlocked = new WeakSet();
      function setTouchActionBlocking(v, enable) {
        if (!v) return;
        if (enable) {
          v.style.setProperty('touch-action', 'none', 'important');
          __touchBlocked.add(v);
          const p = v.parentElement;
          if (p && p !== document.body && p !== document.documentElement) { p.style.setProperty('touch-action', 'none', 'important'); p.dataset.vscTouchBlocked = '1'; }
        } else {
          v.style.removeProperty('touch-action');
          __touchBlocked.delete(v);
          const p = v.parentElement;
          if (p?.dataset?.vscTouchBlocked) { p.style.removeProperty('touch-action'); delete p.dataset.vscTouchBlocked; }
        }
      }

      let __zoomModeWatcherUnsub = null;
      function watchZoomModeToggle() {
        const store = window.__VSC_INTERNAL__?.Store;
        if (!store || __zoomModeWatcherUnsub) return;
        __zoomModeWatcherUnsub = store.sub(P.APP_ZOOM_EN, (enabled) => {
          if (enabled) { for (const v of TOUCHED.videos) { if (v?.isConnected) setTouchActionBlocking(v, true); } }
          else {
            for (const v of [...zoomedVideos]) { resetZoom(v); setTouchActionBlocking(v, false); }
            for (const v of TOUCHED.videos) { if (__touchBlocked.has(v)) setTouchActionBlocking(v, false); }
          }
        });
      }

      const __tryWatchInterval = setRecurring(() => {
        if (window.__VSC_INTERNAL__?.Store) { watchZoomModeToggle(); clearRecurring(__tryWatchInterval); }
      }, 200);

      function onNewVideoForZoom(v) {
        if (!v || !isZoomEnabled()) return;
        if (!__touchBlocked.has(v)) setTouchActionBlocking(v, true);
      }

      onWin('wheel', e => {
        if (!e.altKey || !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        e.preventDefault(); e.stopPropagation();
        const st = getSt(v);
        let newScale = Math.min(Math.max(1, st.scale * (e.deltaY > 0 ? 0.9 : 1.1)), 10);
        if (newScale < 1.05) resetZoom(v); else zoomTo(v, newScale, e.clientX, e.clientY);
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
        if (!activeVideo.isConnected) {
          isPanning = false;
          try { activeVideo.releasePointerCapture?.(e.pointerId); } catch (_) {}
          activePointerId = null; activeVideo = null; return;
        }
        const st = getSt(activeVideo);
        if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
        const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
        const last = events[events.length - 1] || e;
        const nextTx = last.clientX - startX, nextTy = last.clientY - startY;
        if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
        st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo);
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
        if (st.scale === 1) zoomTo(v, 2.5, e.clientX, e.clientY); else resetZoom(v);
      }, { capture: true });

      let __lastFoundVideo = null, __lastFoundVideoT = 0;
      const VIDEO_CACHE_TTL = 3000;
      function getCachedOrFindVideo(e) {
        const now = performance.now();
        if (__lastFoundVideo?.isConnected && (now - __lastFoundVideoT) < VIDEO_CACHE_TTL) return __lastFoundVideo;
        const v = getTargetVideo(e);
        if (v) { __lastFoundVideo = v; __lastFoundVideoT = now; }
        return v;
      }

      onWin('touchstart', e => {
        if (!isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        if (e.touches.length === 2) {
          const v = getCachedOrFindVideo(e);
          if (e.cancelable) e.preventDefault();
          if (!v) { pinchState.active = false; isPanning = false; activeVideo = null; return; }
          setTouchActionBlocking(v, true);
          isPanning = false;
          const st = getSt(v);
          activeVideo = v;
          pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches);
          pinchState.initialScale = st.scale;
          const c = getTouchCenter(e.touches);
          pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        } else if (e.touches.length === 1) {
          const v = getCachedOrFindVideo(e);
          if (!v) return;
          const st = getSt(v);
          if (st.scale > 1) {
            if (e.cancelable) e.preventDefault();
            activeVideo = v; isPanning = true; st.hasPanned = false;
            startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
          }
        }
      }, { passive: false, capture: true });

      onWin('touchmove', e => {
        if (!activeVideo && pinchState.active === false && e.touches.length === 2 && isZoomEnabled()) {
          if (e.cancelable) e.preventDefault();
          const v = getCachedOrFindVideo(e);
          if (v) {
            setTouchActionBlocking(v, true);
            const st = getSt(v);
            activeVideo = v; pinchState.active = true;
            pinchState.initialDist = getTouchDist(e.touches);
            pinchState.initialScale = st.scale;
            const c = getTouchCenter(e.touches);
            pinchState.lastCx = c.x; pinchState.lastCy = c.y;
          }
          return;
        }
        if (!activeVideo) return;
        if (!activeVideo.isConnected) { isPanning = false; pinchState.active = false; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches);
          const center = getTouchCenter(e.touches);
          let newScale = pinchState.initialScale * (dist / Math.max(1, pinchState.initialDist));
          newScale = Math.min(Math.max(1, newScale), 10);
          if (newScale < 1.05) { resetZoom(activeVideo); pinchState.active = false; isPanning = false; activeVideo = null; }
          else {
            zoomTo(activeVideo, newScale, center.x, center.y);
            st.tx += center.x - pinchState.lastCx; st.ty += center.y - pinchState.lastCy;
            clampPan(activeVideo, st); update(activeVideo);
          }
          pinchState.lastCx = center.x; pinchState.lastCy = center.y;
        } else if (isPanning && e.touches.length === 1 && st.scale > 1) {
          if (e.cancelable) e.preventDefault();
          const t = e.touches[0];
          const nextTx = t.clientX - startX, nextTy = t.clientY - startY;
          if (Math.abs(nextTx - st.tx) > 3 || Math.abs(nextTy - st.ty) > 3) st.hasPanned = true;
          st.tx = nextTx; st.ty = nextTy;
          clampPan(activeVideo, st); update(activeVideo);
        }
      }, { passive: false, capture: true });

      onWin('touchend', e => {
        if (!activeVideo) return;
        if (!activeVideo.isConnected) { isPanning = false; pinchState.active = false; activeVideo = null; return; }
        if (e.touches.length < 2) pinchState.active = false;
        if (e.touches.length === 1 && activeVideo?.isConnected && getSt(activeVideo).scale > 1) {
          isPanning = true;
          const st = getSt(activeVideo); st.hasPanned = false;
          startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
        } else if (e.touches.length === 0) {
          const v = activeVideo; isPanning = false; update(v); activeVideo = null;
        }
      }, { passive: false, capture: true });

      onWin('touchcancel', e => {
        if (!activeVideo) return;
        const v = activeVideo; isPanning = false; pinchState.active = false; activeVideo = null; update(v);
      }, { passive: true, capture: true });

      return {
        resetZoom: (v) => { resetZoom(v); if (!isZoomEnabled()) setTouchActionBlocking(v, false); },
        zoomTo, isZoomed, onNewVideoForZoom,
        pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) { resetZoom(v); setTouchActionBlocking(v, false); } } },
        destroy: () => {
          destroyed = true;
          if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
          pendingUpdates.clear();
          for (const v of [...zoomedVideos]) {
            const st = getSt(v);
            if (st.zoomed) {
              for (const prop of ZOOM_PROPS) v.style.removeProperty(prop);
              if (st._savedPosition) v.style.setProperty('position', st._savedPosition);
              if (st._savedZIndex) v.style.setProperty('z-index', st._savedZIndex);
            }
            st.scale = 1; st.zoomed = false; setTouchActionBlocking(v, false);
          }
          zoomedVideos.clear(); isPanning = false; pinchState.active = false;
          activeVideo = null; activePointerId = null; __lastFoundVideo = null;
          if (__zoomModeWatcherUnsub) { __zoomModeWatcherUnsub(); __zoomModeWatcherUnsub = null; }
          try { clearRecurring(__tryWatchInterval); } catch (_) {}
        }
      };
    }

    /* ── Targeting ── */
    function createTargeting() {
      let stickyTarget = null, stickyScore = -Infinity, stickyUntil = 0;
      const SCORE = Object.freeze({
        PLAYING: 5.0, HAS_PROGRESS: 1.5, AREA_SCALE: 1.5, AREA_DIVISOR: 12000,
        USER_PROX_MAX: 2.5, USER_PROX_DECAY: 1500, USER_PROX_RAD_SQ: 722500,
        CENTER_BIAS: 0.5, CENTER_RAD_SQ: 810000, AUDIO_BASE: 1.5,
        AUDIO_BOOST_EXTRA: 0.8, PIP_BONUS: 6.0, MIN_AREA: CONFIG.IS_MOBILE ? 16000 : 25600
      });
      function pickFastActiveOnly(videos, lastUserPt, audioBoostOn) {
        const now = performance.now(); const vp = getViewportSnapshot();
        let best = null, bestScore = -Infinity;
        const evalScore = (v) => {
          if (!v || v.readyState < 2) return;
          const r = getRectCached(v, now, 350); const area = r.width * r.height;
          const pip = isPiPActiveVideo(v);
          if (area < SCORE.MIN_AREA && !pip) return;
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

    /* ── Utils (v196: structuredClone) ── */
    function createUtils() {
      return {
        clamp: VSC_CLAMP,
        h: (tag, props = {}, ...children) => {
          const SVG_NS = 'http://www.w3.org/2000/svg';
          const SVG_TAGS = new Set(['svg','defs','filter','feComponentTransfer','feFuncR','feFuncG','feFuncB','feFuncA','feConvolveMatrix','feColorMatrix','feGaussianBlur','feMerge','feMergeNode','feComposite','feBlend','feFlood','feOffset','feTurbulence','feDisplacementMap','feImage','feMorphology','feSpecularLighting','feDiffuseLighting','fePointLight','feSpotLight','feDistantLight','g','path','circle','rect','line','polyline','polygon','text','use','clipPath','mask','pattern','linearGradient','radialGradient','stop','symbol','marker','image','foreignObject','animate','animateTransform','set','desc','title','metadata']);
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
          try { return structuredClone(defaults); }
          catch (_) {
            const state = {};
            for (const [cat, obj] of Object.entries(defaults)) {
              state[cat] = typeof obj === 'object' && obj !== null ? { ...obj } : obj;
            }
            return state;
          }
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

    /* ── Registry (v196: multi-threshold IO) ── */
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
        patchFullscreenRequest(el);
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

      const connectObserver = (root) => {
        if (!root) return;
        const mo = new MutationObserver((muts) => {
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
        window.__VSC_INTERNAL__._onShadow = (host, sr) => {
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

    // ─── END OF PART 2 (v196.0.0) ───
    // ─── PART 3 START (v196.0.0) ───
    // createAudio, createAutoSceneManager, curveToApproxParams,
    // Endian detection, pooled histograms, zone LUT cache, VideoFrame capture

    /* ── v196: Endian detection for Uint32Array pixel loop ── */
    const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x0A0B0C0D]).buffer)[0] === 0x0D;

    /* ── Audio Engine (v196: permanent block, tuned compressor) ── */
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

      const VSC_AUD_HPF_HZ = 60;
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
          const delay = document.hidden ? 500 : 80;
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

        const delay = document.hidden ? 500 : 80;
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
        compressor.threshold.value = -20;
        compressor.knee.value = 12;
        compressor.ratio.value = 3.5;
        compressor.attack.value = 0.008;
        compressor.release.value = 0.18;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.0;
        limiter.knee.value = 0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.0003;
        limiter.release.value = 0.08;

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

      const ensureCtx = () => {
        if (ctx && ctx.state === 'closed') {
          disconnectAllKnownSources();
          srcMap = new WeakMap();
          for (const v of TOUCHED.videos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
          for (const v of TOUCHED.rateVideos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
          resetCtx();
          __ctxCreateCount++;
        }
        if (ctx) return true;
        const now = performance.now();
        if (now < __ctxBlockUntil) return false;
        if (__ctxCreateCount >= MAX_CTX_RECREATES) {
          __ctxCooldownCount++;
          if (__ctxCooldownCount >= MAX_COOLDOWNS) {
            __ctxBlockUntil = Infinity;
            log.warn('AudioContext creation permanently blocked after repeated failures');
            try { sm.set(P.A_EN, false); } catch (_) {}
            showOSD('오디오 부스트: 이 사이트에서 사용할 수 없음', 3000);
            return false;
          }
          __ctxBlockUntil = now + 60000 * Math.pow(2, __ctxCooldownCount - 1);
          __ctxCreateCount = 0;
          log.warn(`AudioContext cooling down (attempt ${__ctxCooldownCount}/${MAX_COOLDOWNS})`);
          return false;
        }
        disconnectAllKnownSources();
        srcMap = new WeakMap();
        for (const v of TOUCHED.videos) { const vst = videoStateMap.get(v); if (vst) vst.audioFailUntil = 0; }
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

    /* ── Auto Scene Manager (v196: pooled arrays, zone LUT cache, VideoFrame, scheduler.yield, CircularBuffer) ── */
    function createAutoSceneManager(Store, P, Scheduler) {
      const clamp = VSC_CLAMP;

      const HIST_BINS = 256;
      const TONE_STEPS = 256;
      const CANVAS_W = CONFIG.IS_MOBILE ? 64 : 96;
      const CANVAS_H = CONFIG.IS_MOBILE ? 36 : 54;
      const ZONE_COLS = 4, ZONE_ROWS = 4, ZONE_COUNT = 16;

      const ST = Object.freeze({ NORMAL: 0, LOW_KEY: 1, HIGH_KEY: 2, HIGH_CONTRAST: 3, LOW_SAT: 4, SKIN: 5, BACKLIT: 6 });
      const ST_NAMES = ['NORMAL','LOW_KEY','HIGH_KEY','HI_CONT','LOW_SAT','SKIN','BACKLIT'];
      const ST_COUNT = ST_NAMES.length;

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
        let equalized;
        if (zoneHists && zoneCounts) {
          equalized = buildZonalCLAHE(zoneHists, zoneCounts, clipLimit);
        } else {
          const n = Math.max(1, totalSamples), bins = HIST_BINS;
          const limit = (n / bins) * clipLimit;
          const clipped = new Float32Array(bins);
          let excess = 0;
          for (let i = 0; i < bins; i++) { if (lumHist[i] > limit) { excess += lumHist[i] - limit; clipped[i] = limit; } else clipped[i] = lumHist[i]; }
          const perBin = excess / bins;
          for (let i = 0; i < bins; i++) clipped[i] += perBin;
          const cdf = new Float32Array(bins);
          cdf[0] = clipped[0];
          for (let i = 1; i < bins; i++) cdf[i] = cdf[i - 1] + clipped[i];
          const cdfMin = cdf[0], cdfRange = Math.max(1, cdf[bins - 1] - cdfMin);
          equalized = new Float32Array(TONE_STEPS);
          for (let i = 0; i < TONE_STEPS; i++) { const x = i / (TONE_STEPS - 1); const bin = Math.min(bins - 1, (x * (bins - 1)) | 0); equalized[i] = (cdf[bin] - cdfMin) / cdfRange; }
        }
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
        const n = Math.max(1, totalSamples);
        let rMean = 0, gMean = 0, bMean = 0;
        for (let i = 0; i < HIST_BINS; i++) {
          const v = i / (HIST_BINS - 1);
          rMean += v * rHist[i]; gMean += v * gHist[i]; bMean += v * bHist[i];
        }
        rMean /= n; gMean /= n; bMean /= n;
        const avgMean = (rMean + gMean + bMean) / 3;
        if (avgMean < 0.01) return { rGain: 1, gGain: 1, bGain: 1 };
        const correctionStrength = COLOR_CAST_CORRECTION;
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
        if (br < 0.35) scores[ST.LOW_KEY] += (0.35 - br) / 0.35 * 3.0;
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
        [ST.LOW_KEY]:       { clipLimit: 2.5, shadowProtect: 0.50, highlightProtect: 0.20, midtoneBoost: 0.06, strength: 0.28, satTarget: 1.03 },
        [ST.HIGH_KEY]:      { clipLimit: 1.8, shadowProtect: 0.25, highlightProtect: 0.65, midtoneBoost: -0.03, strength: 0.18, satTarget: 1.04 },
        [ST.HIGH_CONTRAST]: { clipLimit: 1.5, shadowProtect: 0.50, highlightProtect: 0.50, midtoneBoost: 0.0, strength: 0.15, satTarget: 1.02 },
        [ST.LOW_SAT]:       { clipLimit: 2.5, shadowProtect: 0.35, highlightProtect: 0.30, midtoneBoost: 0.03, strength: 0.25, satTarget: 1.12 },
        [ST.SKIN]:          { clipLimit: 1.8, shadowProtect: 0.50, highlightProtect: 0.45, midtoneBoost: 0.01, strength: 0.12, satTarget: 1.01 },
        [ST.BACKLIT]:       { clipLimit: 2.5, shadowProtect: 0.25, highlightProtect: 0.55, midtoneBoost: 0.08, strength: 0.28, satTarget: 1.03 }
      });

      let prevToneCurve = null;
      let prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 };
      let prevSatMul = 1.0;

      function interpolateCurves(prev, next, alpha) {
        if (!prev) return next;
        const out = new Float32Array(TONE_STEPS);
        for (let i = 0; i < TONE_STEPS; i++) out[i] = prev[i] + (next[i] - prev[i]) * alpha;
        return out;
      }
      function interpolateGains(prev, next, alpha) {
        return { rGain: prev.rGain + (next.rGain - prev.rGain) * alpha, gGain: prev.gGain + (next.gGain - prev.gGain) * alpha, bGain: prev.bGain + (next.bGain - prev.bGain) * alpha };
      }

      const CUT_HIST_LEN = 20;
      const cutScores = new CircularBuffer(CUT_HIST_LEN);
      const gradualScores = new CircularBuffer(10);

      function detectTransition(stats, prev) {
        if (!prev) return { isCut: false, isFade: false };
        const score = Math.abs(stats.bright - prev.bright) * 1.3 + Math.abs(stats.contrast - prev.contrast) * 0.7 + Math.abs(stats.chroma - prev.chroma) * 0.5 + Math.abs(stats.edge - prev.edge) * 0.3 + Math.abs(stats.motionSAD || 0) * 0.35;
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
      function getTemporalAlpha(isCut, isFade) {
        const base = isCut ? 0.40 : (isFade ? 0.10 : 0.05);
        return base / (1 + flickerCount * 0.5);
      }

      let __prevLumBuf = null, __curLumBuf = null, __curLumBufSize = 0;

      /* ── v196: Zone LUT cache ── */
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

      /* ── v196: Pooled histogram arrays ── */
      const _pool_lumHist = new Uint32Array(HIST_BINS);
      const _pool_rHist = new Uint32Array(HIST_BINS);
      const _pool_gHist = new Uint32Array(HIST_BINS);
      const _pool_bHist = new Uint32Array(HIST_BINS);
      const _pool_zoneCounts = new Uint32Array(ZONE_COUNT);
      const _pool_zoneHists = Array.from({ length: ZONE_COUNT }, () => new Uint32Array(HIST_BINS));
      const _pool_zoneBrightSum = new Float32Array(ZONE_COUNT);
      const _pool_zoneBrightCount = new Uint32Array(ZONE_COUNT);

      /* ── computeFullAnalysis (v196: Uint32 aligned, pooled, branchless skin, cached LUTs) ── */
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

        /* v196: Uint32Array view with alignment guard */
        let u32;
        if ((data.byteOffset & 3) === 0) {
          u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
        } else {
          const aligned = new Uint8Array(data.length);
          aligned.set(data);
          u32 = new Uint32Array(aligned.buffer);
        }
        const isLE = IS_LITTLE_ENDIAN;

        for (let y = 0; y < sh; y += step) {
          const rowPixelOffset = y * sw;
          const zyBase = zyLut[y] * ZONE_COLS;
          for (let x = 0; x < sw; x += step) {
            const pi = rowPixelOffset + x;
            const px = u32[pi];

            let r, g, b;
            if (isLE) { r = px & 0xFF; g = (px >>> 8) & 0xFF; b = (px >>> 16) & 0xFF; }
            else { r = (px >>> 24) & 0xFF; g = (px >>> 16) & 0xFF; b = (px >>> 8) & 0xFF; }

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
              let nr, ng, nb;
              if (isLE) { nr = npx & 0xFF; ng = (npx >>> 8) & 0xFF; nb = (npx >>> 16) & 0xFF; }
              else { nr = (npx >>> 24) & 0xFF; ng = (npx >>> 16) & 0xFF; nb = (npx >>> 8) & 0xFF; }
              const l2 = (nr * 54 + ng * 183 + nb * 18 + 128) >> 8;
              const diff = l2 - l;
              sumEdge += diff < 0 ? -diff : diff;
            }

            skinCount += ((r - g) > 12 & r >= 80 & g >= 35 & b >= 20 & r > g & r > b) | 0;

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
        motionEma: 0, motionAlpha: 0.20, motionThresh: 0.005, motionFrames: 0,
        drmBlocked: false, blockUntilMs: 0, tBoostUntil: 0, tBoostStart: 0,
        boostMs: 700, fpsHist: [],
        minFps: 0.5, maxFps: CONFIG.IS_MOBILE ? 4 : 8, curFps: 2,
        _sceneType: ST.NORMAL, _sceneStable: 0, _sceneTypeEma: ST.NORMAL, _lastMean: 0
      };

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
        AUTO.fpsHist.push(motionSAD); if (AUTO.fpsHist.length > 6) AUTO.fpsHist.shift();
        const avg = AUTO.fpsHist.reduce((a, b) => a + b, 0) / AUTO.fpsHist.length;
        let target = avg < 0.02 ? 2 : (avg < 0.08 ? 3 + avg / 0.08 * 2 : 5 + Math.min((avg - 0.08) / 0.2, 1) * 3);
        if (isCut) target = AUTO.maxFps; else if (isFade) target = Math.max(target, 5);
        AUTO.curFps += clamp(target - AUTO.curFps, -1.5, 1.5);
        return clamp(AUTO.curFps, AUTO.minFps, AUTO.maxFps);
      }

      /* ── v196: async capture with VideoFrame tier-1 ── */
      async function captureSceneFrame(v) {
        if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }
        /* Tier 1: VideoFrame API (Chrome 94+, zero-copy) */
        if (typeof VideoFrame === 'function' && typeof createImageBitmap === 'function') {
          try {
            const frame = new VideoFrame(v, { timestamp: 0 });
            const bmp = await createImageBitmap(frame, { resizeWidth: CANVAS_W, resizeHeight: CANVAS_H });
            frame.close();
            cvCtx.drawImage(bmp, 0, 0);
            bmp.close();
            return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
          } catch (_) { /* fall through */ }
        }
        /* Tier 2: createImageBitmap */
        try {
          if (typeof createImageBitmap === 'function') {
            const bmp = await createImageBitmap(v, { resizeWidth: CANVAS_W, resizeHeight: CANVAS_H });
            cvCtx.drawImage(bmp, 0, 0);
            bmp.close();
            return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
          }
        } catch (_) { /* fall through */ }
        /* Tier 3: direct drawImage */
        try { cvCtx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H); return cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H); }
        catch (_) { return null; }
      }

      /* ── v196: async loop with race guard + scheduler.yield ── */
      async function loop() {
        if (!AUTO.running || __globalSig.aborted) return;

        /* Yield to higher-priority tasks before heavy computation */
        if (globalThis.scheduler?.yield) {
          try { await globalThis.scheduler.yield(); } catch (_) {}
          if (!AUTO.running || __globalSig.aborted) return;
        }

        const now = performance.now();
        const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
        const v = window.__VSC_APP__?.getActiveVideo?.();
        if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null }; prevToneCurve = null; scheduleNext(v, 500); return; }
        if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; }
        if (document.hidden) { scheduleNext(v, 2000); return; }
        if (!v || !cvCtx || v.paused || v.seeking || v.readyState < 2) { try { Scheduler.request(true); } catch (_) {} scheduleNext(v, 300); return; }

        try {
          const img = await captureSceneFrame(v);
          /* v196: race guard after await */
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
            for (const k of ['bright','contrast','chroma','edge','skinRatio','centerBright','edgeAvgBright']) e[k] = (e[k] ?? stats[k]) * (1 - a) + stats[k] * a;
          }

          const newScene = classifySceneFuzzy(AUTO.statsEma, stats.zoneStats);
          if (newScene !== AUTO._sceneType) AUTO._sceneStable = 0; else AUTO._sceneStable++;
          AUTO._sceneType = newScene;
          if (AUTO._sceneStable >= 4) AUTO._sceneTypeEma = newScene;
          if (transition.isCut) { AUTO.tBoostStart = now; AUTO.tBoostUntil = now + AUTO.boostMs; flickerCount = Math.max(0, flickerCount - 2); }

          const allowUpdate = transition.isCut || transition.isFade || AUTO.motionFrames >= 4;
          let fps = AUTO.curFps;
          if (allowUpdate) {
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
            if (dir !== 0 && dir !== lastCurveDir && lastCurveDir !== 0) flickerCount = Math.min(flickerCount + 1, 8);
            else if (dir !== 0) flickerCount = Math.max(0, flickerCount - 0.3);
            lastCurveDir = dir || lastCurveDir;
            const smoothedCurve = interpolateCurves(prevToneCurve, rawCurve, alpha);
            const smoothedGains = interpolateGains(prevChannelGains, rawGains, alpha);
            const smoothedSat = prevSatMul + (rawSat - prevSatMul) * alpha;
            prevToneCurve = smoothedCurve; prevChannelGains = smoothedGains; prevSatMul = smoothedSat;
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
              Store.set(P.APP_AUTO_SCENE, false); showOSD('Auto Scene: DRM 제한으로 비활성화됨', 3000);
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
        AUTO.motionEma = 0; AUTO.motionFrames = 0; AUTO.fpsHist.length = 0; AUTO.curFps = 2;
        prevToneCurve = null; prevChannelGains = { rGain: 1, gGain: 1, bGain: 1 }; prevSatMul = 1.0;
        cutScores.clear(); gradualScores.clear(); flickerCount = 0; lastCurveDir = 0;
        __prevLumBuf = null; __curLumBuf = null; __curLumBufSize = 0;
        __fuzzyInited = false; __fuzzyEma.fill(0);
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

    /* ── curveToApproxParams (v196: 32-point quadratic fit + NaN guard) ── */
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

    // ─── END OF PART 3 (v196.0.0) ───
    // ─── PART 4 START (v196.0.0) ───
    // createFiltersVideoOnly, shadow/bright precomputed, composeVideoParamsInto,
    // isNeutralVideoParams, createVideoParamsMemo, applyShadowStyle, createDisposerBag,
    // bindWindowDrag, VSC_ICONS, svgIcon, showOSD, getAutoPresetForResolution, createUI

    /* ── SVG Filter Engine (v196: explicit R/G/B tempFunc refs, toneStr Map cache) ── */
    function createFiltersVideoOnly(Utils, config) {
      const { h, clamp, createCappedMap } = Utils;
      const urlCache = new WeakMap(), ctxMap = new WeakMap(), toneCache = createCappedMap(32);
      const qInt = (v, step) => Math.round(v / step);

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

      /* v196: Map-based toneStr cache — lazy, ~256 entries vs 10001 */
      const _toneStrCache = new Map();
      function toneStr(idx) {
        let s = _toneStrCache.get(idx);
        if (s !== undefined) return s;
        s = (idx / 10000).toFixed(4);
        _toneStrCache.set(idx, s);
        return s;
      }

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
          + qInt(s.sharp, 0.2) + '|' + qInt(s.sharp2, 0.2) + '|' + qInt(s.clarity, 0.2) + '|'
          + 'ac:' + autoKey + '|cg:' + chGainKey;
      };

      function getToneTableCached(steps, toeN, shoulderN, midN, gain, contrast, brightOffset, gamma) {
        const key = `${steps}|${Math.round(toeN*1000)}|${Math.round(shoulderN*1000)}|${Math.round(gain*1000)}|${Math.round(gamma*1000)}`;
        const hit = toneCache.get(key); if (hit) return hit;
        const ev = Math.log2(Math.max(1e-6, gain)), g = ev * 0.90, denom = 1 - Math.exp(-g);
        const out = new Array(steps); let prev = 0;
        const intercept = 0.5 * (1 - contrast) + brightOffset;
        const gammaExp = Number(gamma);
        for (let i = 0; i < steps; i++) {
          const x0 = i / (steps - 1);
          let x = denom > 1e-6 ? (1 - Math.exp(-g * x0)) / denom : x0;
          x = x * contrast + intercept; x = clamp(x, 0, 1);
          if (Math.abs(gammaExp - 1.0) > 0.001) x = Math.pow(x, gammaExp);
          if (x < prev) x = prev; prev = x;
          const idx = Math.min(10000, Math.max(0, Math.round(x * 10000)));
          out[i] = toneStr(idx);
        }
        const res = out.join(' '); toneCache.set(key, res); return res;
      }

      const __createdSvgs = new Set();
      /* v196: periodic cleanup of detached SVGs */
      setRecurring(() => {
        for (const svg of __createdSvgs) { if (!svg.isConnected) __createdSvgs.delete(svg); }
      }, 30000);
      __globalSig.addEventListener('abort', () => {
        for (const svg of __createdSvgs) { try { if (svg.parentNode) svg.remove(); } catch (_) {} }
        __createdSvgs.clear();
      }, { once: true });

      /* v196: explicit R/G/B func references */
      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
        const defs = h('defs', { ns: 'svg' });
        svg.append(defs);
        __createdSvgs.add(svg);

        const fid = `vsc-f-${config.VSC_ID}`;
        const filter = h('filter', { ns: 'svg', id: fid, 'color-interpolation-filters': 'sRGB',
          x: '0%', y: '0%', width: '100%', height: '100%' });

        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3',
          kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0',
          targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });

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

        const toneFuncsAll = Array.from(fTone.children);
        const toneFuncsRGB = toneFuncsAll.filter(fn => {
          const tag = fn.tagName?.toLowerCase?.() || fn.tagName;
          return tag !== 'fefunca';
        });

        /* v196: explicit temp func refs by tagName */
        const tempChildren = Array.from(fTemp.children);
        const tempFuncR = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncr');
        const tempFuncG = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncg');
        const tempFuncB = tempChildren.find(f => (f.tagName?.toLowerCase?.() || f.tagName) === 'fefuncb');

        return {
          fid, fConv,
          toneFuncs: toneFuncsAll,
          toneFuncsRGB,
          tempFuncR, tempFuncG, tempFuncB,
          fSat,
          st: { lastKey: '', toneKey: '', toneTable: '', sharpKey: '', desatKey: '', tempKey: '' }
        };
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument)
          ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root);
        if (!dc) { dc = { key: '', url: '', filterStr: 'none' }; urlCache.set(root, dc); }

        const svgKey = (video.videoWidth || 0) + '|' + makeKeyBase(s);
        const fullKey = svgKey + '|css:' + s._cssBr.toFixed(3) + '|' + s._cssCt.toFixed(3) + '|' + s._cssSat.toFixed(3);
        if (dc.key === fullKey) return { svgUrl: dc.url, filterStr: dc.filterStr };

        let ctx = ctxMap.get(root);
        if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== svgKey) {
          st.lastKey = svgKey;
          const steps = 256;
          const gamma = 1 / clamp(s.gamma || 1, 0.1, 5.0);
          const toneTable = s._autoToneCurve
            ? s._autoToneCurve.join(' ')
            : getToneTableCached(steps, 0, 0, 0, s.gain || 1, 1.0, 0, gamma);

          const refH = CONFIG.IS_MOBILE ? 720 : 1080;
          const pxScale = clamp((video.videoHeight || refH) / refH, 0.5, 2.0);
          const rawS = (Number(s.sharp || 0) + Number(s.sharp2 || 0) * 0.6
                        + Number(s.clarity || 0) * 0.4) / 100.0;
          const totalS = clamp(rawS * 0.50 / Math.max(0.5, pxScale), 0, 0.35);

          let kernelStr;
          if (totalS < 0.005) {
            kernelStr = '0,0,0, 0,1,0, 0,0,0';
          } else {
            const diag = -totalS * 0.5;
            const edge = -totalS;
            const center = 1.0 - 4 * edge - 4 * diag;
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

          if (st.toneKey !== toneTable) {
            st.toneKey = toneTable;
            for (const fn of ctx.toneFuncsRGB) fn.setAttribute('tableValues', toneTable);
          }
          const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);
          if (st.tempKey !== tmk) {
            st.tempKey = tmk;
            ctx.tempFuncR.setAttribute('slope', finalRs);
            ctx.tempFuncG.setAttribute('slope', finalGs);
            ctx.tempFuncB.setAttribute('slope', finalBs);
          }
          if (st.sharpKey !== kernelStr) {
            st.sharpKey = kernelStr;
            ctx.fConv.setAttribute('kernelMatrix', kernelStr);
            const desatVal = totalS > 0.008
              ? clamp(1.0 - totalS * 0.1, 0.90, 1.0).toFixed(3) : '1.000';
            if (st.desatKey !== desatVal) {
              st.desatKey = desatVal;
              ctx.fSat.setAttribute('values', desatVal);
            }
          }
        }

        const url = `url(#${ctx.fid})`;
        let filterStr = url;
        if (Math.abs(s._cssBr - 1) > 0.001) filterStr += ` brightness(${s._cssBr.toFixed(4)})`;
        if (Math.abs(s._cssCt - 1) > 0.001) filterStr += ` contrast(${s._cssCt.toFixed(4)})`;
        if (Math.abs(s._cssSat - 1) > 0.001) filterStr += ` saturate(${s._cssSat.toFixed(4)})`;

        dc.key = fullKey; dc.url = url; dc.filterStr = filterStr;
        return { svgUrl: url, filterStr };
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
              el.style.removeProperty('will-change');
              el.style.removeProperty('filter');
              el.style.removeProperty('-webkit-filter');
              el.style.removeProperty('background-color');
              el.style.removeProperty('contain');
              st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false;
            }
            return;
          }
          const filterStr = filterResult.filterStr;
          if (st.lastCssFilterStr === filterStr && st.applied) return;
          if (!st._transitionCleared) { el.style.removeProperty('transition'); st._transitionCleared = true; }
          if (st.lastCssFilterStr !== filterStr) {
            el.style.setProperty('filter', filterStr, 'important');
            el.style.setProperty('-webkit-filter', filterStr, 'important');
          }
          if (!st.applied) {
            const willChangeVal = window.__VSC_INTERNAL__?.ZoomManager?.isZoomed(el) ? 'filter, transform' : 'filter';
            el.style.setProperty('will-change', willChangeVal, 'important');
            el.style.setProperty('contain', 'layout paint style', 'important');
            el.style.setProperty('background-color', '#000', 'important');
          }
          st.applied = true; st.lastFilterUrl = filterResult.svgUrl; st.lastCssFilterStr = filterStr;
        },
        clear: (el) => {
          if (!el) return;
          const st = getVState(el);
          if (!st.applied) return;
          el.style.removeProperty('transition'); el.style.removeProperty('will-change');
          el.style.removeProperty('contain');
          el.style.removeProperty('filter'); el.style.removeProperty('-webkit-filter');
          el.style.removeProperty('background-color');
          st.applied = false; st.lastFilterUrl = null; st.lastCssFilterStr = null; st._transitionCleared = false;
        }
      };
    }

    /* ── Shadow Band Precomputed ── */
    const _SHADOW_BANDS = Object.freeze([
      { toe: -0.8, mid: -0.010, bright: -0.4, gamma: 0.990, contrast: 1.015, sat: 1.005 },
      { toe: -1.3, mid: -0.012, bright: -0.8, gamma: 0.982, contrast: 1.018, sat: 1.008 },
      { toe: -1.8, mid: -0.005, bright: -0.3, gamma: 0.990, contrast: 1.018, sat: 1.000 }
    ]);
    const _SHADOW_TABLE = Array.from({ length: 8 }, (_, mask) => {
      const r = { toe: 0, mid: 0, bright: 0, gamma: 1, contrast: 1, sat: 1 };
      for (let i = 0; i < 3; i++) {
        if (!(mask & (1 << i))) continue;
        const b = _SHADOW_BANDS[i];
        r.toe += b.toe; r.mid += b.mid; r.bright += b.bright;
        r.gamma *= b.gamma; r.contrast *= b.contrast; r.sat *= b.sat;
      }
      return Object.freeze(r);
    });

    function applyShadowBandStack(out, mask) {
      const m = (Number(mask) | 0) & 7;
      if (!m) return out;
      const p = _SHADOW_TABLE[m];
      out.toe += p.toe; out.mid += p.mid; out.bright += p.bright;
      out.gamma *= p.gamma; out.contrast *= p.contrast; out.satF *= p.sat;
      return out;
    }

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

    /* ── Compose Video Params (v196: sharp cap 28) ── */
    function composeVideoParamsInto(out, vUser, autoMods) {
      const dPreset = PRESETS.detail[vUser.presetS] || PRESETS.detail.off;
      const gPreset = PRESETS.grade[vUser.presetB] || PRESETS.grade.off;
      const mix = VSC_CLAMP(Number(vUser.presetMix) || 1, 0, 1);

      out.gain = 1.0;
      out.gamma = 1 + ((gPreset.gammaF || 1) - 1) * mix;
      out.contrast = 1.0;
      out.bright = (gPreset.brightAdd || 0) * mix;
      out.satF = 1.0;
      out.mid = 0; out.toe = 0; out.shoulder = 0; out.temp = 0;

      const mobileDampen = CONFIG.IS_MOBILE ? 1.5 : 1.0;
      out.sharp = (dPreset.sharpAdd || 0) * mix * mobileDampen;
      out.sharp2 = (dPreset.sharp2Add || 0) * mix * mobileDampen;
      out.clarity = (dPreset.clarityAdd || 0) * mix * mobileDampen;
      out._mobileSharpIntent = 0;

      applyShadowBandStack(out, vUser.shadowBandMask);
      applyBrightStepStack(out, vUser.brightStepLevel);

      const autoSceneHasCurve = !!(autoMods._toneCurve);
      if (autoSceneHasCurve && vUser.presetB && vUser.presetB !== 'off') {
        const ATTENUATION = 0.45;
        out.bright = (out.bright || 0) * ATTENUATION;
        out.gamma = 1.0 + ((out.gamma || 1.0) - 1.0) * ATTENUATION;
      }

      if (autoMods._toneCurve) {
        out.satF = (out.satF || 1.0) * autoMods.sat;
        out._autoToneCurve = autoMods._toneCurve.slice();
        out._autoChannelGains = autoMods._channelGains || null;
      } else {
        out.gain = (out.gain || 1.0) * autoMods.br;
        out.contrast = (out.contrast || 1.0) * autoMods.ct;
        out.satF = (out.satF || 1.0) * autoMods.sat;
      }

      out._cssBr = VSC_CLAMP(1.0 + (out.bright || 0) * 0.008, 0.5, 2.0);
      out._cssCt = VSC_CLAMP(out.contrast || 1, 0.5, 2.0);
      out._cssSat = VSC_CLAMP(out.satF || 1, 0, 3.0);

      return out;
    }

    const isNeutralVideoParams = (v) => (
      !v._autoToneCurve && !v._autoChannelGains &&
      Math.abs((v.gain ?? 1) - 1) < 0.001 && Math.abs((v.gamma ?? 1) - 1) < 0.001 &&
      Math.abs((v.contrast ?? 1) - 1) < 0.001 && Math.abs((v.bright ?? 0)) < 0.01 &&
      Math.abs((v.mid ?? 0)) < 0.001 && Math.abs((v.sharp ?? 0)) < 0.01 &&
      Math.abs((v.sharp2 ?? 0)) < 0.01 && Math.abs((v.clarity ?? 0)) < 0.01 &&
      Math.abs((v.temp ?? 0)) < 0.01 && Math.abs((v.toe ?? 0)) < 0.01 &&
      Math.abs((v.shoulder ?? 0)) < 0.01 &&
      Math.abs((v._cssBr ?? 1) - 1) < 0.001 && Math.abs((v._cssCt ?? 1) - 1) < 0.001 &&
      Math.abs((v._cssSat ?? 1) - 1) < 0.001
    );

    function createVideoParamsMemo(Store, P, Utils) {
      let lastKey = '', lastResult = null;
      const sigVideo = (vf) => [
        vf.presetS, vf.presetB, Number(vf.presetMix).toFixed(3),
        (vf.shadowBandMask | 0), (vf.brightStepLevel | 0)
      ].join('|');
      return {
        get(vfUser, activeTarget) {
          const w = activeTarget ? (activeTarget.videoWidth || 0) : 0;
          const ht = activeTarget ? (activeTarget.videoHeight || 0) : 0;
          const autoMods = window.__VSC_INTERNAL__?.AutoScene?.getMods?.() || { br: 1.0, ct: 1.0, sat: 1.0 };
          let curveKey = '0';
          if (autoMods._toneCurve) {
            const c = autoMods._toneCurve;
            curveKey = ((c[32]*10000)|0)+','+((c[64]*10000)|0)+','+((c[96]*10000)|0)+','+((c[128]*10000)|0)+','+((c[160]*10000)|0)+','+((c[192]*10000)|0)+','+((c[224]*10000)|0);
          }
          let chKey = '0';
          if (autoMods._channelGains) {
            const g = autoMods._channelGains;
            chKey = `${(g.rGain*1000)|0}|${(g.gGain*1000)|0}|${(g.bGain*1000)|0}`;
          }
          const autoKey = `${autoMods.br.toFixed(3)}|${autoMods.ct.toFixed(3)}|${autoMods.sat.toFixed(3)}|tc:${curveKey}|cg:${chKey}`;
          const key = `${sigVideo(vfUser)}|${w}x${ht}|auto:${autoKey}|mob:${CONFIG.IS_MOBILE?1:0}`;
          if (key === lastKey && lastResult) return lastResult;
          const base = {};
          composeVideoParamsInto(base, vfUser, autoMods);
          const svgBase = { ...base };
          svgBase.sharp = Math.min(Number(svgBase.sharp || 0), 28);
          lastResult = svgBase; lastKey = key;
          return lastResult;
        }
      };
    }

    /* ── applyShadowStyle (v196: stale sheet cleanup) ── */
    const __styleCacheMaxSize = 16;
    const __styleCache = new Map();

    const __styleCacheSpaCleanup = () => { if (__styleCache.size > 0) __styleCache.clear(); };
    __globalSig.addEventListener('abort', () => { __styleCache.clear(); }, { once: true });

    function applyShadowStyle(shadow, cssText, h) {
      try {
        if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) {
          /* v196: remove stale VSC sheets before adding */
          const cur = shadow.adoptedStyleSheets || [];
          let sheet = __styleCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __styleCache.set(cssText, sheet);
            if (__styleCache.size > __styleCacheMaxSize) __styleCache.delete(__styleCache.keys().next().value);
          }
          if (!cur.includes(sheet)) {
            const filtered = cur.filter(s => {
              try { const r = s.cssRules; if (r.length > 0 && r[0].cssText?.includes('.panel')) return false; } catch (_) {}
              return true;
            });
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

    /* ── Disposer Bag ── */
    const createDisposerBag = () => {
      const fns = [];
      return {
        add: (fn) => (typeof fn === 'function' && fns.push(fn), fn),
        flush: () => { fns.forEach(fn => { try { fn(); } catch (_) {} }); fns.length = 0; }
      };
    };

    /* ── Window Drag ── */
    function bindWindowDrag(onMove, onEnd) {
      const ac = new AbortController();
      const sig = ac.signal;
      window.addEventListener('mousemove', onMove, { passive: false, signal: sig });
      window.addEventListener('mouseup', end, { signal: sig });
      window.addEventListener('touchmove', onMove, { passive: false, signal: sig });
      window.addEventListener('touchend', end, { signal: sig });
      window.addEventListener('blur', end, { signal: sig });
      let ended = false;
      function end(ev) {
        if (ended) return; ended = true;
        try { onEnd?.(ev); } finally { try { ac.abort(); } catch (_) {} }
      }
      return () => { if (!ended) { ended = true; try { ac.abort(); } catch (_) {} } };
    }

    /* ── Icons (v196: added equalizer) ── */
    const VSC_ICONS = Object.freeze({
      gear: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
      equalizer: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><circle cx="4" cy="12" r="2" fill="currentColor"/><line x1="12" y1="21" x2="12" y2="8"/><line x1="12" y1="4" x2="12" y2="3"/><circle cx="12" cy="6" r="2" fill="currentColor"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="20" cy="14" r="2" fill="currentColor"/></svg>`,
      speaker: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>`,
      monitor: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
      zap: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
      pip: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="12" y="9" width="8" height="6" rx="1"/></svg>`,
      zoom: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
      camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
      sparkles: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3z"/></svg>`,
      palette: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 011.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
      wand: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M12.2 11.8L11 13M12.2 6.2L11 5"/><line x1="15" y1="9" x2="3" y2="21"/></svg>`,
      download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
      upload: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
      sliders: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`
    });

    function svgIcon(name) {
      const span = document.createElement('span');
      span.className = 'icon';
      span.innerHTML = VSC_ICONS[name] || '';
      return span;
    }

    /* ── OSD ── */
    let __osdReady = false;
    onWin('pointerdown', () => { __osdReady = true; }, { passive: true, once: true });
    onWin('keydown', () => { __osdReady = true; }, { passive: true, once: true });

    let __osdEl = null;
    function showOSD(text, durationMs = 1200) {
      if (!__osdReady || !document.body) return;
      try {
        const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
        const root = fsEl || document.body || document.documentElement;
        if (!__osdEl || !__osdEl.isConnected || __osdEl.parentNode !== root) {
          if (__osdEl) { clearTimeout(__osdEl._timer); __osdEl._timer = 0; try { if (__osdEl.isConnected) __osdEl.remove(); } catch (_) {} __osdEl = null; }
          __osdEl = document.createElement('div'); __osdEl.id = 'vsc-osd';
          __osdEl.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);background:rgba(18,18,22,0.90);backdrop-filter:blur(20px) saturate(180%);color:rgba(255,255,255,0.92);padding:10px 24px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.18s ease;box-shadow:0 8px 32px rgba(0,0,0,0.35);letter-spacing:0.3px;white-space:pre-line;';
          try { root.appendChild(__osdEl); } catch (_) { return; }
        }
        __osdEl.textContent = text; __osdEl.style.opacity = '1';
        clearTimeout(__osdEl._timer);
        __osdEl._timer = setTimeout(() => { if (__osdEl) __osdEl.style.opacity = '0'; }, durationMs);
      } catch (_) {}
    }
    __globalSig.addEventListener('abort', () => {
      if (__osdEl) { clearTimeout(__osdEl._timer); try { if (__osdEl.isConnected) __osdEl.remove(); } catch (_) {} __osdEl = null; }
    }, { once: true });

    function getAutoPresetForResolution(videoHeight) {
      const h = videoHeight || 0;
      if (CONFIG.IS_MOBILE) {
        if (h <= 480) return 'L';
        if (h <= 720) return 'M';
        if (h <= 1080) return 'S';
        return 'off';
      }
      if (h <= 480) return 'L';
      if (h <= 720) return 'M';
      if (h <= 1080) return 'S';
      return 'off';
    }

    /* ══════════════════════════════════════════════════════════
       createUI — v196 Bottom-Tab UI redesign
       ══════════════════════════════════════════════════════════ */
    function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils;
      let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0;
      let __videoInfoIntervalId = 0;
      const uiWakeCtrl = new AbortController();
      const bag = createDisposerBag();
      const sub = (k, fn) => bag.add(sm.sub(k, fn));

      const detachNodesHard = () => {
        try { if (container?.isConnected) container.remove(); } catch (_) {}
        try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {}
        container = null; gearHost = null; gearBtn = null;
      };

      const allowUiInThisDoc = () => {
        if (registry.videos.size > 0) return true;
        return !!document.querySelector('video, object, embed');
      };

      function setAndHint(path, value) {
        const prev = sm.get(path);
        const changed = !Object.is(prev, value);
        if (changed) sm.set(path, value);
        (changed ? ApplyReq.hard() : ApplyReq.soft());
      }

      const getUiRoot = () => {
        const fs = document.fullscreenElement || document.webkitFullscreenElement || null;
        if (fs) return fs.tagName === 'VIDEO' ? (fs.parentElement || document.body) : fs;
        return document.body || document.documentElement;
      };

      function bindClassToggle(btn, path, isActive) {
        const sync = () => { if (btn) btn.classList.toggle('active', isActive(sm.get(path))); };
        sub(path, sync); sync(); return sync;
      }

      function bindStyle(el, path, applyFn) {
        const sync = () => { try { applyFn(el, sm.get(path)); } catch (_) {} };
        sub(path, sync); sync();
      }

      /* v196: unified toggle row builder */
      function renderToggleRow({ items, key, offValue, offLabel = 'OFF', isBitmask = false }) {
        const row = h('div', { class: 'chip-grid' });
        for (const it of items) {
          const b = h('button', { class: 'chip' + (it.warn ? ' warn' : ''), title: it.title || '' }, it.text);
          b.onclick = () => {
            if (isBitmask) { sm.set(key, ShadowMask.toggle(sm.get(key), it.value)); }
            else { const cur = sm.get(key); if (cur === it.value && it.value !== offValue) setAndHint(key, offValue); else setAndHint(key, it.value); }
            ApplyReq.hard();
          };
          if (isBitmask) bindClassToggle(b, key, v => ShadowMask.has(v, it.value));
          else bindClassToggle(b, key, v => v === it.value);
          row.appendChild(b);
        }
        const off = h('button', { class: 'chip', style: 'opacity:0.7' }, offLabel);
        off.onclick = () => { sm.set(key, isBitmask ? 0 : offValue); ApplyReq.hard(); };
        if (isBitmask) bindClassToggle(off, key, v => (Number(v)|0) === 0);
        else bindClassToggle(off, key, v => v === offValue);
        row.appendChild(off);
        return row;
      }

      /* v196: unified value row builder */
      function renderValueRow({ values, key, format, onClick, isActive }) {
        const row = h('div', { class: 'chip-grid' });
        for (const val of values) {
          const b = h('button', { class: 'chip' }, format(val));
          b.onclick = () => onClick(val);
          bindClassToggle(b, key, v => isActive(v, val));
          row.appendChild(b);
        }
        return row;
      }

      /* ── Tab definitions ── */
      const TAB_ID = Object.freeze({ VIDEO: 0, AUDIO: 1, SPEED: 2, TOOLS: 3 });
      const TAB_LABELS = ['Video', 'Audio', 'Speed', 'Tools'];
      const TAB_ICONS = ['palette', 'speaker', 'zap', 'monitor'];

      /* ── v196: Bottom-tab CSS ── */
      const PANEL_STYLE = `
        :host { all: initial; } * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        /* 1. 패널 중앙 정렬 및 너비 확보 (380px) */
        .panel { position: fixed!important; top: 50%!important; right: 72px!important; transform: translateY(-50%)!important; width: min(380px, calc(100vw - 32px))!important; max-height: min(85vh, 560px)!important; background: rgba(12,12,18,0.96)!important; backdrop-filter: blur(24px) saturate(200%)!important; color: #e8eaed!important; border-radius: 20px!important; z-index: 2147483647!important; border: 1px solid rgba(255,255,255,0.06)!important; font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif!important; box-shadow: 0 24px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset!important; display: flex!important; flex-direction: column!important; overflow: hidden!important; animation: vsc-slide-in 0.2s ease-out!important; }

        /* 2. 애니메이션을 중앙 기준(-50%)으로 보정 */
        @keyframes vsc-slide-in { from { opacity:0; transform:translateY(calc(-50% + 12px)) scale(0.97); } to { opacity:1; transform:translateY(-50%) scale(1); } }

        .hdr { padding:14px 16px 10px; display:flex; align-items:center; justify-content:space-between; cursor:move; }
        .hdr-left { display:flex; align-items:center; gap:8px; }
        .hdr-title { font-size:14px; font-weight:800; background:linear-gradient(135deg,#60a5fa,#a78bfa); -webkit-background-clip:text; -webkit-text-fill-color:transparent; letter-spacing:0.5px; }
        .hdr-ver { font-size:9px; color:rgba(255,255,255,0.2); font-weight:600; }
        .pwr-pill { padding:4px 10px; border-radius:20px; border:1.5px solid rgba(74,222,128,0.3); background:rgba(74,222,128,0.1); color:#4ade80; font-size:10px; font-weight:700; cursor:pointer; transition:all 0.15s; }
        .pwr-pill.off { border-color:rgba(248,113,113,0.3); background:rgba(248,113,113,0.1); color:#f87171; }
        .quickbar { display:flex; gap:4px; padding:8px 12px; background:rgba(255,255,255,0.02); border-bottom:1px solid rgba(255,255,255,0.04); }
        .qbtn { flex:1; height:38px; border:1px solid rgba(255,255,255,0.06); border-radius:10px; background:rgba(255,255,255,0.03); color:rgba(255,255,255,0.45); cursor:pointer; display:flex; flex-direction:column; align-items:center; justify-content:center; transition:all 0.15s; }
        .qbtn:hover { background:rgba(255,255,255,0.08); color:rgba(255,255,255,0.7); }
        .qbtn.active { background:rgba(59,130,246,0.18); border-color:rgba(59,130,246,0.35); color:#60a5fa; }
        .qlabel { font-size:8px; font-weight:700; margin-top:2px; }
        .tab-content { flex:1; overflow-y:auto; padding:12px 14px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.08) transparent; display:none; }
        .tab-content.visible { display:block; }
        .tab-content::-webkit-scrollbar { width:3px; } .tab-content::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:2px; }
        .tab-bar { display:flex; border-top:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.3); padding:4px 8px 8px; gap:2px; }
        .tab-item { flex:1; min-height:48px; border:none; background:none; color:rgba(255,255,255,0.4); cursor:pointer; font-size:10px; font-weight:600; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; border-radius:10px; transition:all 0.15s; position:relative; }
        .tab-item:hover { background:rgba(255,255,255,0.04); }
        .tab-item.active { color:#60a5fa; background:rgba(59,130,246,0.08); }
        .tab-item .icon svg { width:20px; height:20px; }
        .tab-item .dot { position:absolute; top:6px; right:calc(50% - 14px); width:5px; height:5px; border-radius:50%; background:#3b82f6; display:none; }
        .tab-item .dot.visible { display:block; }
        .card { margin-bottom:10px; padding:12px; background:rgba(255,255,255,0.025); border-radius:14px; border:1px solid rgba(255,255,255,0.04); }
        .card-title { font-size:10px; font-weight:700; text-transform:uppercase; color:rgba(255,255,255,0.35); margin-bottom:10px; display:flex; align-items:center; gap:6px; letter-spacing:0.8px; }
        .chip-grid { display:flex; flex-wrap:wrap; gap:6px; }

        /* 3. 버튼(Chip) 크기 최적화 - 5개 한 줄 정렬용 */
        .chip { height:34px; min-width:58px; padding:0 6px; border:1.5px solid rgba(255,255,255,0.08); border-radius:10px; background:rgba(255,255,255,0.04); color:rgba(255,255,255,0.7); cursor:pointer; font-size:12px; font-weight:700; transition:all 0.12s ease; display:flex; align-items:center; justify-content:center; user-select:none; }
        .chip:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.15); }
        .chip.active { background:rgba(59,130,246,0.15); border-color:rgba(59,130,246,0.4); color:#93bbfc; box-shadow:0 0 0 1px rgba(59,130,246,0.1); }
        .chip.warn.active { background:rgba(245,158,11,0.15); border-color:rgba(245,158,11,0.4); color:#fbbf24; }

        .speed-display { text-align:center; font-size:28px; font-weight:900; font-variant-numeric:tabular-nums; padding:8px 0; color:rgba(255,255,255,0.8); transition:color 0.15s; }
        .speed-display.modified { color:#4ade80; }
        .speed-stepper { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
        .step-btn { width:44px; height:44px; border-radius:12px; background:rgba(255,255,255,0.06); border:1.5px solid rgba(255,255,255,0.1); color:#fff; font-size:18px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:all 0.1s; }
        .step-btn:active { transform:scale(0.92); background:rgba(255,255,255,0.1); }
        .slider-row { display:flex; align-items:center; gap:10px; padding:4px 0; }
        .slider-label { font-size:10px; color:rgba(255,255,255,0.4); font-weight:600; min-width:40px; }
        .slider-value { font-size:12px; font-weight:700; min-width:36px; text-align:right; font-variant-numeric:tabular-nums; }
        input[type=range] { -webkit-appearance:none; flex:1; height:4px; background:rgba(255,255,255,0.08); border-radius:2px; outline:none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:16px; height:16px; border-radius:50%; background:#60a5fa; cursor:pointer; border:2px solid rgba(0,0,0,0.4); box-shadow:0 2px 8px rgba(0,0,0,0.3); }
        .actions { display:flex; gap:6px; flex-wrap:wrap; }
        .act-btn { flex:1; min-width:72px; height:36px; border-radius:10px; border:1.5px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); color:rgba(255,255,255,0.7); cursor:pointer; font-size:11px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:5px; transition:all 0.12s; }
        .act-btn:hover { background:rgba(255,255,255,0.08); }
        .act-btn .icon svg { width:14px; height:14px; }
        .custom-speed { flex:1; height:26px; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:#fff; text-align:center; font-size:11px; font-weight:bold; outline:none; }
        .footer-row { padding:8px 12px 6px; display:flex; gap:4px; border-top:1px solid rgba(255,255,255,0.04); }
        .footer-btn { flex:1; height:30px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); color:rgba(255,255,255,0.6); cursor:pointer; font-size:10px; font-weight:600; display:flex; align-items:center; justify-content:center; gap:3px; transition:background 0.15s; }
        .footer-btn:hover { background:rgba(255,255,255,0.08); }
        .footer-btn.danger { background:rgba(248,113,113,0.1); border-color:rgba(248,113,113,0.3); color:#f87171; }

        /* 4. 프레임(iframe) 대응: 좁은 화면에서도 하단을 다 차지하지 않고 중앙 유지 */
        @media (max-width:480px) {
          .panel { width: calc(100% - 32px)!important; right: 16px!important; left: 16px!important; top: 50%!important; transform: translateY(-50%)!important; border-radius: 20px!important; max-height: 80vh!important; bottom: auto!important; }
          .tab-bar { padding-bottom: 8px; }
        }
      `;

      const build = () => {
        if (container) return;
        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' });
        const shadow = host.attachShadow({ mode: 'open' });
        applyShadowStyle(shadow, PANEL_STYLE, h);

        /* ── Header ── */
        const videoInfo = h('span', { class: 'hdr-ver' });
        const updateVideoInfo = () => { const v = window.__VSC_APP__?.getActiveVideo(); if (v) videoInfo.textContent = `${v.videoWidth}\u00D7${v.videoHeight}`; };
        __videoInfoIntervalId = setRecurring(updateVideoInfo, 2000);
        updateVideoInfo();

        const pwrPill = h('button', { class: 'pwr-pill' });
        pwrPill.onclick = () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT));
        bindStyle(pwrPill, P.APP_ACT, (el, v) => { el.className = v ? 'pwr-pill' : 'pwr-pill off'; el.textContent = v ? 'ON' : 'OFF'; });

        const hdrLeft = h('div', { class: 'hdr-left' }, h('span', { class: 'hdr-title' }, 'VSC'), videoInfo);
        const hdr = h('div', { class: 'hdr' }, hdrLeft, pwrPill);

        /* ── Quickbar ── */
        const mkQBtn = (icon, label, path) => {
          const b = h('button', { class: 'qbtn' }, h('span', {}, svgIcon(icon)), h('span', { class: 'qlabel' }, label));
          b.onclick = () => {
            const nextVal = !sm.get(path);
            setAndHint(path, nextVal);
            if (path === P.APP_ZOOM_EN) showOSD(nextVal ? "Zoom ON (Alt+휠)" : "Zoom OFF", 1500);
          };
          bindClassToggle(b, path, v => !!v);
          return b;
        };
        const quickbar = h('div', { class: 'quickbar' },
          mkQBtn('sparkles', 'AUTO', P.APP_AUTO_SCENE),
          mkQBtn('wand', 'PRESET', P.APP_AUTO_PRESET),
          mkQBtn('speaker', 'AUDIO', P.A_EN),
          mkQBtn('zoom', 'ZOOM', P.APP_ZOOM_EN)
        );

        /* ── Tab bodies ── */
        let currentTab = TAB_ID.VIDEO;
        const tabBtns = [];
        const tabBodies = [];

        /* TAB 0: Video */
        const sharpItems = Object.keys(PRESETS.detail).filter(k=>k!=='off').map(k=>({ text: getPresetLabel('detail', k), value: k }));
        const sharpRow = renderToggleRow({ key: P.V_PRE_S, items: sharpItems, offValue: 'off' });
        const sharpSec = h('div', { class: 'card' }, h('div', { class: 'card-title' }, svgIcon('palette'), ' SHARPENING'), sharpRow);

        const shadowSec = h('div', { class: 'card' },
          h('div', { class: 'card-title' }, 'SHADOW BAND'),
          renderToggleRow({ key: P.V_SHADOW_MASK, isBitmask: true, items: [{text:'OUTER',value:1},{text:'MID',value:2},{text:'DEEP',value:4}] })
        );

        const gradeItems = Object.keys(PRESETS.grade).filter(k=>k!=='off').map(k=>({ text: getPresetLabel('grade', k), value: k }));
        const gradeSec = h('div', { class: 'card' },
          h('div', { class: 'card-title' }, 'SHADOW RESTORE'),
          renderToggleRow({ key: P.V_PRE_B, items: gradeItems, offValue: 'off' })
        );

        /* v196: presetMix slider exposed */
        const mixSlider = h('input', { type: 'range', min: '0', max: '1', step: '0.05' });
        mixSlider.value = sm.get(P.V_PRE_MIX) || 1;
        const mixLbl = h('span', { class: 'slider-value' }, Math.round(mixSlider.value * 100) + '%');
        mixSlider.oninput = () => { sm.set(P.V_PRE_MIX, parseFloat(mixSlider.value)); mixLbl.textContent = Math.round(mixSlider.value * 100) + '%'; ApplyReq.hard(); };
        sm.sub(P.V_PRE_MIX, (v) => { mixSlider.value = v; mixLbl.textContent = Math.round(v * 100) + '%'; });
        const mixSec = h('div', { class: 'card' },
          h('div', { class: 'card-title' }, svgIcon('sliders'), ' EFFECT MIX'),
          h('div', { class: 'slider-row' }, h('span', { class: 'slider-label' }, 'Mix'), mixSlider, mixLbl)
        );

        const videoTab = h('div', { class: 'tab-content visible' }, sharpSec, shadowSec, gradeSec, mixSec);

        /* TAB 1: Audio */
        const audioSlider = h('input', { type: 'range', min: '0', max: '12', step: '0.5' });
        audioSlider.value = sm.get(P.A_BST) || 6;
        const audioLbl = h('span', { class: 'slider-value' }, Number(audioSlider.value).toFixed(1) + 'dB');
        audioSlider.oninput = () => { sm.set(P.A_BST, parseFloat(audioSlider.value)); audioLbl.textContent = Number(audioSlider.value).toFixed(1) + 'dB'; ApplyReq.soft(); };
        sm.sub(P.A_BST, (v) => { audioSlider.value = v; audioLbl.textContent = Number(v).toFixed(1) + 'dB'; });
        const audioBoostSec = h('div', { class: 'card' },
          h('div', { class: 'card-title' }, svgIcon('speaker'), ' AUDIO BOOST'),
          h('div', { class: 'slider-row' }, h('span', { class: 'slider-label' }, 'Gain'), audioSlider, audioLbl)
        );
        const audioTab = h('div', { class: 'tab-content' }, audioBoostSec);

        /* TAB 2: Speed */
        const speedVal = h('span', { class: 'speed-display' });
        const syncSpeed = () => { const r = sm.get(P.PB_EN) ? Number(sm.get(P.PB_RATE)) : 1; speedVal.textContent = r.toFixed(1)+'x'; speedVal.classList.toggle('modified', Math.abs(r-1)>0.01); };
        sub(P.PB_RATE, syncSpeed); sub(P.PB_EN, syncSpeed); syncSpeed();

        const speedMinus = h('button', { class: 'step-btn', onclick: () => { setAndHint(P.PB_RATE, Math.round(VSC_CLAMP(Number(sm.get(P.PB_RATE))-0.1,0.1,16)*10)/10); setAndHint(P.PB_EN, true); } }, '\u2212');
        const speedPlus = h('button', { class: 'step-btn', onclick: () => { setAndHint(P.PB_RATE, Math.round(VSC_CLAMP(Number(sm.get(P.PB_RATE))+0.1,0.1,16)*10)/10); setAndHint(P.PB_EN, true); } }, '+');
        const speedRow1 = h('div', { class: 'speed-stepper' }, speedMinus, speedVal, speedPlus);

        const speedPresetRow = renderValueRow({
          values: [0.5, 1.0, 1.5, 2.0, 3.0],
          key: P.PB_RATE,
          format: r => r + 'x',
          onClick: r => { sm.set(P.PB_RATE, r); sm.set(P.PB_EN, true); ApplyReq.hard(); },
          isActive: (v, r) => sm.get(P.PB_EN) && Math.abs(v - r) < 0.01
        });

        const speedInput = h('input', { type: 'number', min: '0.1', max: '16', step: '0.05', class: 'custom-speed' });
        speedInput.onchange = () => { const val = VSC_CLAMP(parseFloat(speedInput.value)||1, 0.1, 16); speedInput.value = val; setAndHint(P.PB_RATE, val); setAndHint(P.PB_EN, true); };
        speedInput.onkeydown = (e) => e.stopPropagation();
        sm.sub(P.PB_RATE, (v) => speedInput.value = Number(v).toFixed(2));
        speedInput.value = sm.get(P.PB_RATE) || 1;
        const speedCustom = h('div', { style: 'display:flex;align-items:center;gap:6px;margin-top:8px' }, h('span', { class: 'slider-label' }, 'CUSTOM'), speedInput);

        const speedSec = h('div', { class: 'card' }, h('div', { class: 'card-title' }, svgIcon('zap'), ' SPEED'), speedRow1, speedPresetRow, speedCustom);
        const speedTab = h('div', { class: 'tab-content' }, speedSec);

        /* TAB 3: Tools */
        const toolsBtn1 = h('button', { class: 'act-btn', onclick: () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) togglePiPFor(v); } }, svgIcon('pip'), ' PiP');
        const toolsBtn2 = h('button', { class: 'act-btn', onclick: () => { const v = window.__VSC_APP__?.getActiveVideo(); if(v) captureVideoFrame(v); } }, svgIcon('camera'), ' Capture');

        const btnExport = h('button', { class: 'act-btn', onclick: () => {
          try {
            const data = window.__VSC_INTERNAL__?._buildSaveData?.();
            if (!data) return;
            data._version = VSC_VERSION; data._hostname = location.hostname;
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'}));
            const a = document.createElement('a'); a.href = url; a.download = `vsc-settings-${Date.now()}.json`; a.click();
            setTimer(() => URL.revokeObjectURL(url), 5000);
          } catch (_) {}
        } }, svgIcon('download'), ' Export');

        const btnImport = h('button', { class: 'act-btn', onclick: () => {
          const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
          input.onchange = () => {
            const file = input.files?.[0]; if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { try { window.__VSC_INTERNAL__?._applyDataToStore?.(JSON.parse(reader.result)); ApplyReq.hard(); } catch (_) {} };
            reader.readAsText(file);
          };
          input.click();
        } }, svgIcon('upload'), ' Import');

        const toolsSec = h('div', { class: 'card' },
          h('div', { class: 'card-title' }, svgIcon('monitor'), ' TOOLS'),
          h('div', { class: 'actions', style: 'margin-bottom:6px' }, toolsBtn1, toolsBtn2),
          h('div', { class: 'actions' }, btnExport, btnImport)
        );
        const toolsTab = h('div', { class: 'tab-content' }, toolsSec);

        /* Store tabs */
        tabBodies.push(videoTab, audioTab, speedTab, toolsTab);

        /* ── Tab bar (bottom, iOS-style) ── */
        const tabBar = h('div', { class: 'tab-bar' });
        function switchTab(idx) {
          if (idx === currentTab) return;
          tabBtns[currentTab].classList.remove('active');
          tabBodies[currentTab].classList.remove('visible');
          currentTab = idx;
          tabBtns[currentTab].classList.add('active');
          tabBodies[currentTab].classList.add('visible');
        }
        for (let i = 0; i < TAB_LABELS.length; i++) {
          const dot = h('div', { class: 'dot' });
          const btn = h('button', { class: 'tab-item' + (i === currentTab ? ' active' : '') },
            svgIcon(TAB_ICONS[i]), h('span', {}, TAB_LABELS[i]), dot);
          const tabIdx = i;
          btn.onclick = () => switchTab(tabIdx);
          btn.__dot = dot;
          tabBtns.push(btn);
          tabBar.appendChild(btn);
        }
        /* Dot sync */
        const syncDots = () => {
          const act = sm.get(P.APP_ACT);
          tabBtns[TAB_ID.VIDEO].__dot.classList.toggle('visible', act && sm.get(P.V_PRE_S) !== 'off');
          tabBtns[TAB_ID.AUDIO].__dot.classList.toggle('visible', act && !!sm.get(P.A_EN));
          tabBtns[TAB_ID.SPEED].__dot.classList.toggle('visible', act && !!sm.get(P.PB_EN) && Math.abs(Number(sm.get(P.PB_RATE)) - 1) > 0.01);
          tabBtns[TAB_ID.TOOLS].__dot.classList.toggle('visible', act && !!sm.get(P.APP_AUTO_SCENE));
        };
        [P.APP_ACT, P.V_PRE_S, P.A_EN, P.PB_EN, P.PB_RATE, P.APP_AUTO_SCENE].forEach(p => sub(p, syncDots));
        syncDots();

        /* ── Footer ── */
        let confirmState = false, confirmTimer = 0;
        const resetBtn = h('button', { class: 'footer-btn' }, '\u21BA Reset');
        resetBtn.onclick = () => {
          if (!confirmState) {
            confirmState = true; resetBtn.textContent = '\u26A0 Sure?'; resetBtn.classList.add('danger');
            confirmTimer = setTimer(() => { confirmState = false; resetBtn.textContent = '\u21BA Reset'; resetBtn.classList.remove('danger'); }, 2000);
          } else {
            clearTimer(confirmTimer); confirmState = false; resetBtn.textContent = '\u21BA Reset'; resetBtn.classList.remove('danger');
            sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback);
            sm.set(P.APP_AUTO_SCENE, false); sm.set(P.APP_AUTO_PRESET, false); ApplyReq.hard();
          }
        };
        const closeBtn = h('button', { class: 'footer-btn', onclick: () => sm.set(P.APP_UI, false) }, '\u2715 Close');
        const footerRow = h('div', { class: 'footer-row' }, resetBtn, closeBtn);

        /* ── Assemble panel ── */
        const panel = h('div', { class: 'panel' },
          hdr, quickbar,
          ...tabBodies,
          footerRow,
          tabBar
        );
        shadow.appendChild(panel);
        container = host;
        getUiRoot().appendChild(container);

        /* ── Panel drag ── */
        let stopDrag = null;
        hdr.onmousedown = (e) => {
          e.preventDefault(); const p = shadow.querySelector('.panel'); const r = p.getBoundingClientRect();
          let sx = e.clientX, sy = e.clientY;
          p.style.right = 'auto'; p.style.bottom = 'auto'; p.style.transform = 'none';
          p.style.top = r.top + 'px'; p.style.left = r.left + 'px';
          stopDrag = bindWindowDrag((ev) => {
            p.style.left = Math.max(0, Math.min(window.innerWidth - r.width, r.left + (ev.clientX - sx))) + 'px';
            p.style.top = Math.max(0, Math.min(window.innerHeight - r.height, r.top + (ev.clientY - sy))) + 'px';
          }, () => stopDrag = null);
        };
      };

      /* ── Gear button (v196: equalizer icon) ── */
      const ensureGear = () => {
        if (!allowUiInThisDoc()) return;
        if (gearHost && !gearHost.isConnected) { gearHost = null; gearBtn = null; }
        if (gearHost) return;

        gearHost = h('div', { id: 'vsc-gear-host', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        applyShadowStyle(shadow, `
          .gear{position:fixed!important;top:50%!important;right:12px!important;transform:translateY(-50%)!important;width:42px!important;height:42px!important;border-radius:12px!important;background:rgba(15,15,20,0.9)!important;backdrop-filter:blur(12px)!important;border:1.5px solid rgba(255,255,255,0.1)!important;color:#fff!important;display:flex!important;align-items:center!important;justify-content:center!important;cursor:pointer!important;pointer-events:auto!important;transition:all 0.2s ease;opacity:0.5}
          .gear:hover{opacity:1;border-color:rgba(255,255,255,0.25)}
          .gear:active{transform:translateY(-50%) scale(0.92)}
          .gear.open{opacity:1;border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,0.2)}
          .gear.inactive{opacity:0.3;border-color:#f87171}
          .gear.panel-open{opacity:0;pointer-events:none;transform:translateY(-50%) scale(0.7)}
          .badge{position:absolute;top:-4px;right:-4px;background:#3b82f6;color:#fff;font-size:10px;font-weight:900;min-width:16px;height:16px;border-radius:8px;border:1.5px solid rgba(12,12,16,0.95);display:flex;align-items:center;justify-content:center}
        `, h);

        gearBtn = h('button', { class: 'gear' });
        gearBtn.innerHTML = VSC_ICONS.equalizer;
        const badge = h('div', { class: 'badge', style: 'display:none' });
        gearBtn.appendChild(badge);
        shadow.appendChild(gearBtn);

        gearBtn.onclick = (e) => {
          if (gearBtn.__vscDrag) { e.preventDefault(); e.stopPropagation(); return; }
          setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        };

        let stopDrag = null;
        const handleGearDrag = (e) => {
          if (!e.target.closest('.gear')) return;
          gearBtn.__vscDrag = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          stopDrag = bindWindowDrag((ev) => {
            const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
            if (Math.abs(currentY - startY) > 8) {
              if (!gearBtn.__vscDrag) { gearBtn.__vscDrag = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = rect.top + 'px'; }
              if (ev.cancelable) ev.preventDefault();
            }
            if (gearBtn.__vscDrag) gearBtn.style.top = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top + (currentY - startY))) + 'px';
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { gearBtn.__vscDrag = false; stopDrag = null; }, 100); });
        };
        gearBtn.onmousedown = handleGearDrag; gearBtn.ontouchstart = handleGearDrag;
        blockInterference(gearBtn);

        const sync = () => {
          if (!gearBtn) return;
          const uiOpen = !!sm.get(P.APP_UI);
          gearBtn.classList.toggle('open', uiOpen);
          gearBtn.classList.toggle('panel-open', uiOpen);
          gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT));
          let count = 0;
          if (sm.get(P.APP_ACT)) {
            if (sm.get(P.V_PRE_S) !== 'off') count++;
            if (sm.get(P.A_EN)) count++;
            if (sm.get(P.PB_EN) && Number(sm.get(P.PB_RATE)) !== 1) count++;
            if (sm.get(P.APP_AUTO_SCENE)) count++;
          }
          badge.textContent = count;
          badge.style.display = count > 0 ? 'flex' : 'none';
        };
        [P.APP_UI, P.APP_ACT, P.V_PRE_S, P.A_EN, P.PB_EN, P.PB_RATE, P.APP_AUTO_SCENE].forEach(p => sub(p, sync));
        sync();

        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1';
          clearTimeout(fadeTimer);
          fadeTimer = setTimeout(() => { if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.classList.contains('panel-open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = ''; }, 3000);
        };
        window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal });
        bootWakeTimer = setTimeout(wake, 2000);
      };

      const ensure = () => {
        if (!document.body) return;
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        if (gearHost && !gearHost.isConnected) { gearHost = null; gearBtn = null; }
        ensureGear();
        if (gearHost) {
          const root = getUiRoot();
          if (root && root !== gearHost.parentNode) { try { root.appendChild(gearHost); } catch (_) {} }
        }
        if (sm.get(P.APP_UI)) {
          build();
          if (container) {
            container.style.display = 'block';
            const root = getUiRoot();
            if (root && container.parentNode !== root) { try { root.appendChild(container); } catch (_) {} }
          }
        } else {
          if (container) container.style.display = 'none';
        }
      };

      sub(P.APP_UI, () => ensure());
      ensure();

      return {
        ensure,
        destroy: () => {
          uiWakeCtrl.abort();
          clearTimeout(fadeTimer);
          clearTimeout(bootWakeTimer);
          clearRecurring(__videoInfoIntervalId);
          __videoInfoIntervalId = 0;
          bag.flush();
          detachNodesHard();
        }
      };
    }

    // ─── END OF PART 4 (v196.0.0) ───
    // ─── PART 5 START (v196.0.0) ───
    // markInternalRateChange, restoreRateOne, ensureMobileInlinePlaybackHints,
    // cleanupTouched, pruneTouchedDisconnected, createBackendAdapter,
    // clearVideoRuntimeState, applyPlaybackRate, reconcileVideoEffects,
    // bindVideoOnce, createApplyLoop, persistence, keyboard, OSD,
    // MediaSession, GM menus, user tracking, maintenance, SPA watcher,
    // auto-preset watcher, mobile long-press speed, bootstrap

    function markInternalRateChange(v) {
      const st = getRateState(v);
      st.lastSetAt = performance.now();
    }

    function restoreRateOne(el) {
      try {
        const st = getRateState(el);
        if (!st || st.orig == null) return;
        const nextRate = (Number.isFinite(st.orig) && st.orig > 0) ? st.orig : 1.0;
        markInternalRateChange(el);
        el.playbackRate = nextRate;
        st.orig = null;
        st.retryCount = 0;
        st.permanentlyBlocked = false;
        st.suppressSyncUntil = 0;
      } catch (_) {}
    }

    function ensureMobileInlinePlaybackHints(video) {
      if (!video) return;
      try {
        if (!video.hasAttribute('playsinline')) video.setAttribute('playsinline', '');
        if (!video.hasAttribute('webkit-playsinline')) video.setAttribute('webkit-playsinline', '');
      } catch (_) {}
    }

    const onEvictRateVideo = (v) => { try { restoreRateOne(v); } catch (_) {} };
    const onEvictVideo = (v) => {
      try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {}
      restoreRateOne(v);
      TOUCHED.rateVideos.delete(v);
    };

    function cleanupTouched() {
      for (const v of TOUCHED.videos) onEvictVideo(v);
      TOUCHED.videos.clear();
      for (const v of TOUCHED.rateVideos) onEvictRateVideo(v);
      TOUCHED.rateVideos.clear();
    }

    function pruneTouchedDisconnected() {
      const toDeleteVideos = [];
      const toDeleteRate = [];

      for (const v of TOUCHED.videos) {
        if (!v || !v.isConnected) toDeleteVideos.push(v);
      }
      for (const v of TOUCHED.rateVideos) {
        if (!v || !v.isConnected) toDeleteRate.push(v);
      }

      if (toDeleteVideos.length < Math.ceil(CONFIG.TOUCHED_MAX * 0.15) && TOUCHED.videos.size > CONFIG.TOUCHED_MAX * 0.9) {
        for (const v of TOUCHED.videos) {
          if (!v || toDeleteVideos.includes(v)) continue;
          if ((v.paused && !isPiPActiveVideo(v)) || v.ended) toDeleteVideos.push(v);
          if (TOUCHED.videos.size - toDeleteVideos.length <= CONFIG.TOUCHED_MAX * 0.7) break;
        }
      }
      if (toDeleteRate.length < Math.ceil(CONFIG.TOUCHED_MAX * 0.15) && TOUCHED.rateVideos.size > CONFIG.TOUCHED_MAX * 0.9) {
        for (const v of TOUCHED.rateVideos) {
          if (!v || toDeleteRate.includes(v)) continue;
          if ((v.paused && !isPiPActiveVideo(v)) || v.ended) toDeleteRate.push(v);
          if (TOUCHED.rateVideos.size - toDeleteRate.length <= CONFIG.TOUCHED_MAX * 0.7) break;
        }
      }

      for (const v of toDeleteVideos) {
        TOUCHED.videos.delete(v);
        try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {}
      }
      for (const v of toDeleteRate) {
        try { restoreRateOne(v); } catch (_) {}
        TOUCHED.rateVideos.delete(v);
      }
    }

    function createBackendAdapter(Filters) {
      return {
        apply(video, vVals) {
          const st = getVState(video);
          if (st._inPiP) return;
          const filterResult = Filters.prepareCached(video, vVals);
          Filters.applyFilter(video, filterResult);
        },
        clear(video) {
          Filters.clear(video);
        },
        prepareCached: Filters.prepareCached,
        applyFilter: Filters.applyFilter
      };
    }

    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el);
      if (st._ac) { try { st._ac.abort(); } catch (_) {} st._ac = null; }
      Adapter.clear(el);
      TOUCHED.videos.delete(el);
      st.desiredRate = undefined;
      restoreRateOne(el);
      TOUCHED.rateVideos.delete(el);
      st.bound = false;
    }

    function applyPlaybackRate(el, desiredRate) {
      const st = getVState(el);
      const rSt = getRateState(el);
      if (rSt.permanentlyBlocked) return;
      if (__rateBlockedSite) { rSt.permanentlyBlocked = true; return; }
      if (rSt.orig == null) {
        const current = el.playbackRate;
        rSt.orig = (current > 0.05 && current <= 16) ? current : 1.0;
      }
      const lastDesired = st.desiredRate;
      if (!Object.is(lastDesired, desiredRate) || Math.abs(el.playbackRate - desiredRate) > 0.01) {
        st.desiredRate = desiredRate;
        markInternalRateChange(el);
        try { el.playbackRate = desiredRate; } catch (_) {}
      }
      touchedAddLimited(TOUCHED.rateVideos, el, onEvictRateVideo);
    }

    function createLightSigTracker() {
      let lastTarget = null, lastPb = false, lastRate = 1, lastFx = false;
      return (activeTarget, pbActive, desiredRate, videoFxOn) => {
        if (activeTarget !== lastTarget || pbActive !== lastPb ||
            desiredRate !== lastRate || videoFxOn !== lastFx) {
          lastTarget = activeTarget; lastPb = pbActive;
          lastRate = desiredRate; lastFx = videoFxOn;
          return true;
        }
        return false;
      };
    }

    const __reconcileCandidates = new Set();

    /* ══════════════════════════════════════════════════════════
       [PATCH v196 3-1] reconcileVideoEffects — bindVideoOnce 순서 변경
       ──────────────────────────────────────────────────────────
       기존: Adapter.apply → bindVideoOnce (resize 리스너가 필터 상태 미인지)
       변경: bindVideoOnce → Adapter.apply (resize 리스너가 필터 상태를 인지)
       효과: 해상도 변경 시 필터 재적용이 즉시 올바르게 동작
       ══════════════════════════════════════════════════════════ */
    function reconcileVideoEffects({ applySet, dirtyVideos, vVals, videoFxOn,
                                     desiredRate, pbActive, Adapter, ApplyReq, mainTarget }) {
      const candidates = __reconcileCandidates;
      candidates.clear();

      for (const v of applySet) if (v) candidates.add(v);
      for (const v of dirtyVideos) if (v && !candidates.has(v)) candidates.add(v);
      for (const v of TOUCHED.videos) if (v && !candidates.has(v)) candidates.add(v);
      for (const v of TOUCHED.rateVideos) if (v && !candidates.has(v)) candidates.add(v);

      for (const el of candidates) {
        if (!el || !el.isConnected) {
          TOUCHED.videos.delete(el);
          TOUCHED.rateVideos.delete(el);
          continue;
        }
        const st = getVState(el);
        const visible = (st.visible !== false);
        const isMainTarget = (el === mainTarget);
        const shouldApply = applySet.has(el) && (visible || isPiPActiveVideo(el) || isMainTarget);

        if (!shouldApply) {
          clearVideoRuntimeState(el, Adapter, ApplyReq);
          continue;
        }

        /* v196 3-1: bind FIRST so resize listener is aware of filter state */
        bindVideoOnce(el, ApplyReq);

        if (videoFxOn) {
          Adapter.apply(el, vVals);
          touchedAddLimited(TOUCHED.videos, el, onEvictVideo);
        } else {
          Adapter.clear(el);
          TOUCHED.videos.delete(el);
        }

        if (pbActive) {
          applyPlaybackRate(el, desiredRate);
        } else {
          st.desiredRate = undefined;
          restoreRateOne(el);
          TOUCHED.rateVideos.delete(el);
        }
      }
      candidates.clear();
    }

    function bindVideoOnce(v, ApplyReq) {
      const st = getVState(v);
      if (st.bound) return;
      st.bound = true;

      if (CONFIG.IS_MOBILE) ensureMobileInlinePlaybackHints(v);

      const ac = new AbortController();
      st._ac = ac;
      const sig = ac.signal;

      const softResetTransientFlags = () => {
        st.resetTransient();
        ApplyReq.hard();
      };

      onAll(v, ['loadstart', 'loadedmetadata', 'emptied'], softResetTransientFlags,
        { passive: true, signal: sig });
      onAll(v, ['seeking', 'play'], () => { ApplyReq.hard(); },
        { passive: true, signal: sig });

      on(v, 'enterpictureinpicture', () => {
        st._inPiP = true;
        try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {}
      }, { passive: true, signal: sig });

      on(v, 'leavepictureinpicture', () => {
        st._inPiP = false;
        st.applied = false;
        st.lastFilterUrl = null;
        st.lastCssFilterStr = null;
        st._transitionCleared = false;
        setTimer(() => { try { ApplyReq.hard(); } catch (_) {} }, 200);
      }, { passive: true, signal: sig });

      on(v, 'resize', () => {
        st._resizeDirty = true;
        bumpRectEpoch();
        const Store = window.__VSC_INTERNAL__?.Store;
        if (!Store) return;
        if (Store.get(P.APP_AUTO_PRESET) && Store.get(P.APP_ACT)) {
          const ht = v.videoHeight || 0;
          const auto = getAutoPresetForResolution(ht);
          const cur = Store.get(P.V_PRE_S);
          if (auto !== cur) {
            Store.set(P.V_PRE_S, auto);
            showOSD(`자동 프리셋: ${PRESET_LABELS.detail[auto] || auto} (${ht}p)`, 1500);
          }
        }
        ApplyReq.hard();
      }, { passive: true, signal: sig });

      on(v, 'ratechange', () => {
        const rSt = getRateState(v);
        const now = performance.now();

        const cooldownEnd = Math.max(rSt.suppressSyncUntil || 0, (rSt.lastSetAt || 0) + 500);
        if (now < cooldownEnd) return;

        if (rSt.permanentlyBlocked) return;
        if (__rateBlockedSite) { rSt.permanentlyBlocked = true; return; }

        const refs = window.__VSC_INTERNAL__;
        const store = refs?.Store;
        if (!store || !store.get(P.PB_EN)) return;

        const desired = Number(st.desiredRate ?? store.get(P.PB_RATE));
        if (!Number.isFinite(v.playbackRate) || v.playbackRate < 0.07) return;
        if (!Number.isFinite(desired) || desired < 0.07) return;
        if (Math.abs(v.playbackRate - desired) < 0.01) return;

        if (rSt._externalMtQueued) return;

        if (!rSt._rateRetryWindow) rSt._rateRetryWindow = 0;
        if (!rSt._rateRetryCount) rSt._rateRetryCount = 0;

        if (now - rSt._rateRetryWindow > 2000) {
          rSt._rateRetryWindow = now;
          rSt._rateRetryCount = 0;
        }
        rSt._rateRetryCount++;

        const RATE_MAX_RETRY = 3;
        if (rSt._rateRetryCount > RATE_MAX_RETRY) {
          rSt.permanentlyBlocked = true;
          showOSD('속도 조절이 차단됨 (충돌 방지)', 2000);
          return;
        }

        rSt._externalMtQueued = true;

        const backoffMs = 16 * Math.pow(2, rSt._rateRetryCount - 1);
        setTimer(() => {
          rSt._externalMtQueued = false;
          if (performance.now() < (rSt.suppressSyncUntil || 0)) return;

          const activeVideo = refs?.App?.getActiveVideo?.();
          if (!activeVideo || v !== activeVideo || !store.get(P.PB_EN)) return;
          if (Math.abs(v.playbackRate - desired) < 0.01) return;

          st.desiredRate = desired;
          rSt.lastSetAt = performance.now();
          rSt.suppressSyncUntil = performance.now() + 800;

          try { v.playbackRate = desired; } catch (_) {}
        }, backoffMs);
      }, { passive: true, signal: sig });

      try {
        window.__VSC_INTERNAL__?.ZoomManager?.onNewVideoForZoom?.(v);
      } catch (_) {}
    }

    /* ══════════════════════════════════════════════════════════
       [PATCH v196 3-2] audioUpdateThrottled — abort 시 타이머 정리
       ──────────────────────────────────────────────────────────
       기존: __globalSig abort 시 내부 throttle timer 미정리 → 리소스 누수
       변경: abort 이벤트에 timer clear 등록
       ══════════════════════════════════════════════════════════ */
    function createApplyLoop(Store, Registry, Targeting, Adapter, Audio, AutoScene, ZoomMgr, ApplyReq, UI) {
      const paramsMemo = createVideoParamsMemo(Store, P, createUtils());
      const lightSigChanged = createLightSigTracker();
      const __applySet = new Set();

      let __activeTarget = null;
      let __lastAudioTarget = null;
      let __lastAudioWant = null;
      let __lastAutoPresetHeight = 0;
      Store.sub(P.APP_AUTO_PRESET, () => { __lastAutoPresetHeight = 0; });
      let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

      const audioUpdateThrottled = (() => {
        let last = 0, timer = 0;
        /* v196 3-2: abort 시 throttle timer 정리 */
        __globalSig.addEventListener('abort', () => {
          if (timer) { clearTimer(timer); timer = 0; }
        }, { once: true });
        return () => {
          const now = performance.now();
          if (now - last >= 120) { last = now; Audio.update(); return; }
          if (!timer) { timer = setTimer(() => { timer = 0; last = performance.now(); Audio.update(); }, 120); }
        };
      })();

      let __uiVideoKicked = false;

      return function applyToAllVideos(forceApply) {
        if (__globalSig.aborted) return;

        try {
          const active = !!Store.getCatRef('app').active;
          if (!active) { cleanupTouched(); Audio.update(); return; }

          if (document.hidden && !forceApply) return;

          const sRev = Store.rev(), rRev = Registry.rev(), userSigRev = __vscUserSignalRev;
          if (!forceApply && sRev === lastSRev && rRev === lastRRev && userSigRev === lastUserSigRev) return;
          lastSRev = sRev; lastRRev = rRev; lastUserSigRev = userSigRev;

          const now = performance.now();
          if (now - lastPrune > 2500) {
            Registry.prune();
            pruneTouchedDisconnected();
            lastPrune = now;
          }

          const dirty = Registry.consumeDirty();
          for (const v of dirty.videos) {
            if (v.isConnected && !getVState(v).bound) {
              bindVideoOnce(v, ApplyReq);
            }
          }

          if (Registry.videos.size > 0) {
            if (!__uiVideoKicked) {
              __uiVideoKicked = true;
              try { UI.ensure(); } catch (_) {}
            }
          } else {
            __uiVideoKicked = false;
          }

          const { visible } = Registry;
          const wantAudioNow = !!(Store.get(P.A_EN) && active);
          const pick = Targeting.pickFastActiveOnly(
            visible.videos, window.__lastUserPt, wantAudioNow
          );
          let nextTarget = pick.target;
          if (!nextTarget && __activeTarget) nextTarget = __activeTarget;
          if (nextTarget !== __activeTarget) __activeTarget = nextTarget;
          window.__VSC_INTERNAL__._activeVideo = __activeTarget;

          if (Store.get(P.APP_AUTO_PRESET) && __activeTarget) {
            const vh = __activeTarget.videoHeight || 0;
            if (vh > 0 && vh !== __lastAutoPresetHeight) {
              __lastAutoPresetHeight = vh;
              const suggested = getAutoPresetForResolution(vh);
              const current = Store.get(P.V_PRE_S);
              if (current !== suggested) {
                Store.set(P.V_PRE_S, suggested);
                showOSD(`자동 프리셋: ${PRESET_LABELS.detail[suggested] || suggested} (${vh}p)`, 1500);
              }
            }
          }

          const nextAudioTarget = (wantAudioNow || Audio.hasCtx?.() || Audio.isHooked?.())
            ? (__activeTarget || null) : null;
          if (nextAudioTarget !== __lastAudioTarget || wantAudioNow !== __lastAudioWant) {
            Audio.setTarget(nextAudioTarget);
            Audio.update();
            __lastAudioTarget = nextAudioTarget;
            __lastAudioWant = wantAudioNow;
          } else {
            audioUpdateThrottled();
          }

          const vCat = Store.state.video;
          const vfUser = {
            presetS: vCat.presetS, presetB: vCat.presetB, presetMix: vCat.presetMix,
            shadowBandMask: vCat.shadowBandMask, brightStepLevel: vCat.brightStepLevel
          };
          const vValsEffective = paramsMemo.get(vfUser, __activeTarget);
          const videoFxOn = !isNeutralVideoParams(vValsEffective);

          const applyToAllVisible = !!Store.get(P.APP_APPLY_ALL);
          __applySet.clear();
          if (applyToAllVisible) {
            for (const v of visible.videos) __applySet.add(v);
          } else if (__activeTarget) {
            __applySet.add(__activeTarget);
          }

          const desiredRate = Store.get(P.PB_RATE);
          const pbActive = active && !!Store.get(P.PB_EN);

          if (!forceApply && dirty.videos.size === 0 &&
              !lightSigChanged(__activeTarget, pbActive, desiredRate, videoFxOn)) return;

          reconcileVideoEffects({
            applySet: __applySet,
            dirtyVideos: dirty.videos,
            vVals: vValsEffective,
            videoFxOn,
            desiredRate,
            pbActive,
            Adapter,
            ApplyReq,
            mainTarget: __activeTarget
          });

          if (forceApply || dirty.videos.size) UI.ensure();

        } catch (e) { log.warn('apply crashed:', e); }
      };
    }

    // ═══════════════════════════════════════════════════════════
    //  Persistence — save / load / migrate
    // ═══════════════════════════════════════════════════════════

    const __hasGM = (typeof GM_getValue === 'function' && typeof GM_setValue === 'function');
    const SAVE_DEBOUNCE_MS = 500;
    let __saveTimer = 0;

    function buildSaveData(Store) {
      return {
        active: Store.get(P.APP_ACT),
        applyAll: Store.get(P.APP_APPLY_ALL),
        advanced: Store.get(P.APP_ADV),
        presetS: Store.get(P.V_PRE_S),
        presetB: Store.get(P.V_PRE_B),
        presetMix: Store.get(P.V_PRE_MIX),
        shadowBandMask: Store.get(P.V_SHADOW_MASK),
        brightStepLevel: Store.get(P.V_BRIGHT_STEP),
        audioEnabled: Store.get(P.A_EN),
        audioBoost: Store.get(P.A_BST),
        autoScene: Store.get(P.APP_AUTO_SCENE),
        zoomEn: Store.get(P.APP_ZOOM_EN),
        autoPreset: Store.get(P.APP_AUTO_PRESET),
        playbackRate: Store.get(P.PB_RATE),
        playbackEnabled: Store.get(P.PB_EN)
      };
    }

    function applyDataToStore(Store, data) {
      if (!data || typeof data !== 'object') return;
      const safeSet = (path, val) => {
        try { if (val != null) Store.set(path, val); } catch (_) {}
      };
      safeSet(P.APP_ACT, data.active);
      safeSet(P.APP_APPLY_ALL, data.applyAll);
      safeSet(P.APP_ADV, data.advanced);
      safeSet(P.V_PRE_S, data.presetS);
      safeSet(P.V_PRE_B, data.presetB);
      safeSet(P.V_PRE_MIX, data.presetMix);
      safeSet(P.V_SHADOW_MASK, data.shadowBandMask);
      safeSet(P.V_BRIGHT_STEP, data.brightStepLevel);
      safeSet(P.A_EN, data.audioEnabled);
      safeSet(P.A_BST, data.audioBoost);
      safeSet(P.APP_AUTO_SCENE, data.autoScene);
      safeSet(P.APP_ZOOM_EN, data.zoomEn);
      safeSet(P.APP_AUTO_PRESET, data.autoPreset);
      safeSet(P.PB_RATE, data.playbackRate);
      safeSet(P.PB_EN, data.playbackEnabled);
    }

    function migrateV185Format(data) {
      if (!data || typeof data !== 'object') return null;
      if ('app.active' in data || 'video.presetS' in data || 'audio.enabled' in data) {
        return {
          active: data['app.active'],
          applyAll: data['app.applyAll'],
          advanced: data['app.advanced'],
          presetS: data['video.presetS'],
          presetB: data['video.presetB'],
          presetMix: data['video.presetMix'],
          shadowBandMask: data['video.shadowBandMask'],
          brightStepLevel: data['video.brightStepLevel'],
          audioEnabled: data['audio.enabled'],
          audioBoost: data['audio.boost'],
          autoScene: data['app.autoScene'],
          zoomEn: data['app.zoomEn'],
          autoPreset: data['app.autoPreset'],
          playbackRate: data['playback.rate'],
          playbackEnabled: data['playback.enabled']
        };
      }
      return data;
    }

    function saveToDisk(Store) {
      clearTimer(__saveTimer);
      __saveTimer = setTimer(() => {
        __saveTimer = 0;
        try {
          const data = buildSaveData(Store);
          const json = JSON.stringify(data);
          if (__hasGM) {
            try { GM_setValue(STORAGE_KEY, json); } catch (_) {}
          }
          try { localStorage.setItem(STORAGE_KEY, json); } catch (_) {}
        } catch (_) {}
      }, SAVE_DEBOUNCE_MS);
    }

    function loadFromDisk(Store) {
      let data = null;
      if (__hasGM) {
        try {
          const raw = GM_getValue(STORAGE_KEY, null);
          if (raw) { try { data = (typeof raw === 'string') ? JSON.parse(raw) : raw; } catch (_) {} }
        } catch (_) {}
      }
      if (!data) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) { try { data = JSON.parse(raw); } catch (_) {} }
        } catch (_) {}
      }

      if (data && typeof data === 'object') {
        data = migrateV185Format(data);
        applyDataToStore(Store, data);
        return true;
      }
      return false;
    }

    function bindNormalizer(Store, keys, schema, ApplyReq) {
      const run = () => {
        if (normalizeBySchema(Store, schema)) ApplyReq.hard();
      };
      keys.forEach(k => Store.sub(k, run));
      run();
    }

    // ═══════════════════════════════════════════════════════════
    //  Keyboard shortcuts
    // ═══════════════════════════════════════════════════════════

    function setupKeyboard(Store, ApplyReq, ZoomMgr) {
      onWin('keydown', async (e) => {
        if (isEditableTarget(e.target)) return;
        const alt = e.altKey, shift = e.shiftKey;
        let handled = false;

        if (alt && shift) {
          handled = true;
          switch (e.code) {
            case 'KeyV':
              Store.set(P.APP_UI, !Store.get(P.APP_UI));
              ApplyReq.hard();
              break;
            case 'KeyA':
              Store.set(P.A_EN, !Store.get(P.A_EN));
              ApplyReq.hard();
              break;
            case 'KeyS': {
              const keys = Object.keys(PRESETS.detail);
              const cur = Store.get(P.V_PRE_S);
              const idx = keys.indexOf(cur);
              Store.set(P.V_PRE_S, keys[(idx + 1) % keys.length]);
              ApplyReq.hard();
              break;
            }
            case 'KeyP': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (v) await togglePiPFor(v);
              break;
            }
            case 'KeyC': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (v) captureVideoFrame(v);
              break;
            }
            case 'Comma': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (v) {
                v.pause();
                v.currentTime = Math.max(0, v.currentTime - 1 / 30);
                showOSD('◀ 1프레임');
              }
              break;
            }
            case 'Period': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (v) {
                v.pause();
                v.currentTime = Math.min(v.duration || 0, v.currentTime + 1 / 30);
                showOSD('1프레임 ▶');
              }
              break;
            }
            case 'KeyI': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (!v) { showOSD('활성 비디오 없음'); break; }
              const w = v.videoWidth, ht = v.videoHeight;
              const fps = v.getVideoPlaybackQuality?.()?.totalVideoFrames
                ? Math.round(v.getVideoPlaybackQuality().totalVideoFrames / Math.max(0.1, v.currentTime))
                : '?';
              const dropped = v.getVideoPlaybackQuality?.()?.droppedVideoFrames ?? '?';
              const mode = 'SVG';
              const sceneInfo = window.__VSC_INTERNAL__?.AutoScene?.getSceneTypeName?.() || '-';
              showOSD(`${w}\u00D7${ht} | ~${fps}fps | drop:${dropped} | ${mode} | scene:${sceneInfo}`, 3000);
              break;
            }
            case 'Slash':
              showOSD('Alt+Shift+V: UI | S: 샤프 | A: 오디오 | P: PiP | C: 캡처 | I: 정보 | < >: 1프레임', 3500);
              break;
            case 'ArrowUp':
            case 'ArrowDown': {
              const delta = e.code === 'ArrowUp' ? 0.1 : -0.1;
              const cur = Number(Store.get(P.PB_RATE) || 1);
              const next = Math.round(VSC_CLAMP(cur + delta, 0.1, 16) * 10) / 10;
              Store.set(P.PB_RATE, next);
              Store.set(P.PB_EN, true);
              ApplyReq.hard();
              showOSD(`속도: ${next.toFixed(1)}x`);
              break;
            }
            case 'NumpadAdd':
              Store.set(P.PB_EN, true);
              Store.set(P.PB_RATE, Math.round(VSC_CLAMP(Number(Store.get(P.PB_RATE) || 1) + 0.25, 0.1, 16) * 100) / 100);
              ApplyReq.hard();
              showOSD(`속도: ${Number(Store.get(P.PB_RATE)).toFixed(1)}x`);
              break;
            case 'NumpadSubtract':
              Store.set(P.PB_EN, true);
              Store.set(P.PB_RATE, Math.round(VSC_CLAMP(Number(Store.get(P.PB_RATE) || 1) - 0.25, 0.1, 16) * 100) / 100);
              ApplyReq.hard();
              showOSD(`속도: ${Number(Store.get(P.PB_RATE)).toFixed(1)}x`);
              break;
            default: handled = false;
          }
        }

        if (!handled && alt && !shift && !(e.ctrlKey || e.metaKey)) {
          handled = true;
          switch (e.key) {
            case '1': Store.set(P.V_PRE_S, Store.get(P.V_PRE_S) === 'S' ? 'off' : 'S'); ApplyReq.hard(); break;
            case '2': Store.set(P.V_PRE_S, Store.get(P.V_PRE_S) === 'M' ? 'off' : 'M'); ApplyReq.hard(); break;
            case '3': Store.set(P.V_PRE_S, Store.get(P.V_PRE_S) === 'L' ? 'off' : 'L'); ApplyReq.hard(); break;
            case '4': Store.set(P.V_PRE_S, Store.get(P.V_PRE_S) === 'XL' ? 'off' : 'XL'); ApplyReq.hard(); break;
            case '0': Store.batch('video', DEFAULTS.video); ApplyReq.hard(); break;
            case 'a': Store.set(P.A_EN, !Store.get(P.A_EN)); ApplyReq.hard(); break;
            case 'q': Store.set(P.APP_AUTO_SCENE, !Store.get(P.APP_AUTO_SCENE)); ApplyReq.hard();
              showOSD(Store.get(P.APP_AUTO_SCENE) ? 'Auto Scene ON' : 'Auto Scene OFF', 1200); break;
            case 'x': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (ZoomMgr && v) {
                if (ZoomMgr.isZoomed(v)) { ZoomMgr.resetZoom(v); Store.set(P.APP_ZOOM_EN, false); }
                else { const r = v.getBoundingClientRect(); ZoomMgr.zoomTo(v, 2.5, r.left + r.width / 2, r.top + r.height / 2); Store.set(P.APP_ZOOM_EN, true); }
              } else { Store.set(P.APP_ZOOM_EN, !Store.get(P.APP_ZOOM_EN)); }
              ApplyReq.soft(); break;
            }
            case 'p': { const v = window.__VSC_APP__?.getActiveVideo?.(); if (v) togglePiPFor(v); break; }
            case 'c': { const v = window.__VSC_APP__?.getActiveVideo?.(); if (v) captureVideoFrame(v); break; }
            default: handled = false;
          }
        }

        if (!handled && !alt && !(e.ctrlKey || e.metaKey) && !shift) {
          handled = true;
          switch (e.key) {
            case 'd': case 'D':
              Store.set(P.PB_EN, true);
              Store.set(P.PB_RATE, Math.round(VSC_CLAMP(Number(Store.get(P.PB_RATE) || 1) + 0.1, 0.1, 16) * 100) / 100);
              ApplyReq.hard(); break;
            case 's': case 'S':
              Store.set(P.PB_EN, true);
              Store.set(P.PB_RATE, Math.round(VSC_CLAMP(Number(Store.get(P.PB_RATE) || 1) - 0.1, 0.1, 16) * 100) / 100);
              ApplyReq.hard(); break;
            case 'r': case 'R':
              Store.set(P.PB_RATE, 1.0); Store.set(P.PB_EN, false); ApplyReq.hard(); break;
            case 'Escape': {
              const v = window.__VSC_APP__?.getActiveVideo?.();
              if (ZoomMgr && v && ZoomMgr.isZoomed(v)) {
                ZoomMgr.resetZoom(v); Store.set(P.APP_ZOOM_EN, false); ApplyReq.soft();
              }
              break;
            }
            default: handled = false;
          }
        }

        if (handled) { e.preventDefault(); e.stopPropagation(); }
      }, { capture: true });
    }

    // ═══════════════════════════════════════════════════════════
    //  OSD notifications, MediaSession, GM menus
    // ═══════════════════════════════════════════════════════════

    function setupOsdNotifications(Store) {
      Store.sub(P.V_PRE_S, (v) => showOSD('샤프닝: ' + (PRESET_LABELS.detail[v] || v)));
      Store.sub(P.V_PRE_B, (v) => showOSD('밝기등급: ' + (PRESET_LABELS.grade[v] || v)));
      Store.sub(P.A_EN, (v) => showOSD('오디오 부스트: ' + (v ? 'ON' : 'OFF')));
      Store.sub(P.PB_RATE, (v) => { if (Store.get(P.PB_EN)) showOSD('재생속도: ' + Number(v).toFixed(1) + 'x'); });
      Store.sub(P.PB_EN, (v) => { if (!v) showOSD('재생속도: 기본'); });
      Store.sub(P.APP_AUTO_PRESET, (v) => showOSD('자동 프리셋: ' + (v ? 'ON' : 'OFF')));
    }

    function setupMediaSession(Store) {
      Store.sub(P.PB_RATE, (rate) => {
        if (!Store.get(P.PB_EN)) return;
        try {
          if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
            const v = window.__VSC_APP__?.getActiveVideo?.();
            if (v && Number.isFinite(v.duration) && v.duration > 0) {
              navigator.mediaSession.setPositionState({
                duration: v.duration,
                playbackRate: rate,
                position: Math.min(v.currentTime, v.duration)
              });
            }
          }
        } catch (_) {}
      });
    }

    function setupGmMenus(Store, ApplyReq) {
      let __gmMenuId = null;
      const updateGmMenu = () => {
        if (typeof GM_unregisterMenuCommand === 'function' && __gmMenuId !== null) {
          try { GM_unregisterMenuCommand(__gmMenuId); } catch (_) {}
        }
        if (typeof GM_registerMenuCommand === 'function') {
          const isAll = !!Store.get(P.APP_APPLY_ALL);
          try {
            __gmMenuId = GM_registerMenuCommand(
              '전체 비디오에 적용 : ' + (isAll ? 'ON 🟢' : 'OFF 🔴'),
              () => { Store.set(P.APP_APPLY_ALL, !isAll); ApplyReq.hard(); }
            );
          } catch (_) {}
        }
      };
      Store.sub(P.APP_APPLY_ALL, updateGmMenu);
      updateGmMenu();
    }

    // ═══════════════════════════════════════════════════════════
    //  User tracking for targeting
    // ═══════════════════════════════════════════════════════════

    function setupUserTracking(Scheduler) {
      window.__lastUserPt = { x: innerWidth * 0.5, y: innerHeight * 0.5, t: performance.now() };
      function updateLastUserPt(x, y, t) {
        window.__lastUserPt.x = x;
        window.__lastUserPt.y = y;
        window.__lastUserPt.t = t;
      }
      let __vscLastUserSignalT = 0;
      function signalUserInteractionForRetarget() {
        const now = performance.now();
        if (now - __vscLastUserSignalT < 50) return;
        __vscLastUserSignalT = now;
        __vscUserSignalRev = (__vscUserSignalRev + 1) | 0;
        try { Scheduler.request(false); } catch (_) {}
      }
      onWin('pointerdown', (e) => {
        updateLastUserPt(e.clientX, e.clientY, performance.now());
        signalUserInteractionForRetarget();
      }, { passive: true });
      onWin('wheel', (e) => {
        const x = Number.isFinite(e.clientX) ? e.clientX : innerWidth * 0.5;
        const y = Number.isFinite(e.clientY) ? e.clientY : innerHeight * 0.5;
        updateLastUserPt(x, y, performance.now());
        signalUserInteractionForRetarget();
      }, { passive: true });
      onWin('keydown', () => {
        updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, performance.now());
        signalUserInteractionForRetarget();
      });
      onWin('resize', () => {
        const now = performance.now();
        if (!window.__lastUserPt || (now - window.__lastUserPt.t) > 1200)
          updateLastUserPt(innerWidth * 0.5, innerHeight * 0.5, now);
        signalUserInteractionForRetarget();
      }, { passive: true });
    }

    // ═══════════════════════════════════════════════════════════
    //  Maintenance — periodic refresh, page lifecycle
    // ═══════════════════════════════════════════════════════════

    function setupMaintenance(Store, Registry, ApplyReq, Scheduler, ZoomMgr) {
      let tickTimer = 0;
      const startTick = () => {
        if (tickTimer) return;
        tickTimer = setRecurring(() => {
          if (!Store.get(P.APP_ACT)) return;
          if (document.hidden) return;
          Scheduler.request(false);
        }, 12000);
      };
      const stopTick = () => {
        if (!tickTimer) return;
        clearRecurring(tickTimer);
        tickTimer = 0;
      };
      Store.sub(P.APP_ACT, () => { Store.get(P.APP_ACT) ? startTick() : stopTick(); });
      if (Store.get(P.APP_ACT)) startTick();
      onDoc('visibilitychange', () => {
        if (document.hidden) stopTick();
        else if (Store.get(P.APP_ACT)) startTick();
      }, { passive: true });

      const debouncedPageResume = createDebounced(() => {
        try {
          Registry.refreshObservers();
          Registry.rescanAll();
          ApplyReq.hard();
          try { ZoomMgr?.pruneDisconnected(); } catch (_) {}
        } catch (_) {}
      }, 100);

      onWin('freeze', () => { try { ApplyReq.hard(); } catch (_) {} }, { capture: true });
      onWin('pageshow', debouncedPageResume, { capture: true });
      onWin('resume', debouncedPageResume, { capture: true });
      onDoc('visibilitychange', () => {
        if (document.visibilityState === 'visible') debouncedPageResume();
      }, { passive: true });
    }

    // ═══════════════════════════════════════════════════════════
    //  SPA watcher
    // ═══════════════════════════════════════════════════════════

    function setupSpaWatcher(Registry, Scheduler, ApplyReq, ZoomMgr) {
      const onUrlChange = createDebounced(() => {
        try {
          __styleCacheSpaCleanup();
          Registry.refreshObservers();
          Registry.rescanAll();
          Scheduler.request(true);
          try { ZoomMgr?.pruneDisconnected(); } catch (_) {}
          try { window.__VSC_UI_Ensure?.(); } catch (_) {}
        } catch (_) {}
      }, SPA_RESCAN_DEBOUNCE_MS);
      initSpaUrlDetector(onUrlChange);
    }

    // ═══════════════════════════════════════════════════════════
    //  Auto-preset watcher
    // ═══════════════════════════════════════════════════════════

    function setupAutoPresetWatcher(Store, ApplyReq) {
      Store.sub(P.APP_AUTO_PRESET, (en) => {
        if (!en) return;
        let v = window.__VSC_APP__?.getActiveVideo?.();
        if (!v || !v.isConnected || v.readyState < 1) {
          const all = document.querySelectorAll('video');
          let best = null, bestArea = 0;
          for (const vid of all) {
            if (!vid.isConnected || vid.readyState < 1) continue;
            const area = (vid.videoWidth || 0) * (vid.videoHeight || 0);
            if (area > bestArea) { bestArea = area; best = vid; }
          }
          if (best) v = best;
        }
        if (!v) return;
        const ht = v.videoHeight || 0;
        if (ht > 0) {
          const auto = getAutoPresetForResolution(ht);
          Store.set(P.V_PRE_S, auto);
          showOSD(`자동 프리셋: ${PRESET_LABELS.detail[auto] || auto} (${ht}p)`, 1500);
          ApplyReq.hard();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════
    //  [PATCH v196 12-2] Mobile long-press 2x speed
    //  ─────────────────────────────────────────────────────────
    //  모바일: 비디오 위에서 길게 누르면 2x 재생, 손을 떼면 복귀
    //  체감 큰 UX 개선, 별도 오버헤드 없음
    // ═══════════════════════════════════════════════════════════

    function setupMobileLongPressSpeed(Store, ApplyReq) {
      if (!CONFIG.IS_MOBILE) return;

      const LONG_PRESS_MS = 400;
      const LONG_PRESS_RATE = 2.0;
      let longPressTimer = 0;
      let longPressVideo = null;
      let longPressOrigRate = null;
      let longPressActive = false;
      let startX = 0, startY = 0;

      const getVideoFromTouch = (e) => {
        if (!e.touches || e.touches.length !== 1) return null;
        const t = e.touches[0];
        try {
          const els = document.elementsFromPoint(t.clientX, t.clientY);
          for (const el of els) {
            if (el?.tagName === 'VIDEO') return el;
          }
          for (const el of els) {
            if (el?.querySelector) {
              const v = el.querySelector('video');
              if (v) return v;
            }
            if (el?.shadowRoot) {
              const v = el.shadowRoot.querySelector('video');
              if (v) return v;
            }
          }
        } catch (_) {}
        return window.__VSC_APP__?.getActiveVideo?.() || null;
      };

      const cancelLongPress = () => {
        if (longPressTimer) { clearTimer(longPressTimer); longPressTimer = 0; }
        if (longPressActive && longPressVideo) {
          try {
            if (longPressOrigRate != null) {
              longPressVideo.playbackRate = longPressOrigRate;
            }
          } catch (_) {}
          longPressActive = false;
          longPressVideo = null;
          longPressOrigRate = null;
        }
      };

      onWin('touchstart', (e) => {
        if (!e.touches || e.touches.length !== 1) { cancelLongPress(); return; }
        const v = getVideoFromTouch(e);
        if (!v || v.paused || v.ended || v.readyState < 2) return;

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;

        longPressTimer = setTimer(() => {
          longPressTimer = 0;
          if (!v.isConnected || v.paused || v.ended) return;
          longPressVideo = v;
          longPressOrigRate = v.playbackRate;
          longPressActive = true;
          try { v.playbackRate = LONG_PRESS_RATE; } catch (_) {}
          showOSD(`⏩ ${LONG_PRESS_RATE}x`, 600);
        }, LONG_PRESS_MS);
      }, { passive: true, capture: true });

      onWin('touchmove', (e) => {
        if (!longPressTimer && !longPressActive) return;
        if (e.touches && e.touches.length === 1) {
          const dx = e.touches[0].clientX - startX;
          const dy = e.touches[0].clientY - startY;
          if (dx * dx + dy * dy > 400) cancelLongPress();
        }
      }, { passive: true, capture: true });

      onWin('touchend', cancelLongPress, { passive: true, capture: true });
      onWin('touchcancel', cancelLongPress, { passive: true, capture: true });

      __globalSig.addEventListener('abort', cancelLongPress, { once: true });
    }

    // ═══════════════════════════════════════════════════════════
    //  Bootstrap — 모든 모듈 조립 및 시작
    // ═══════════════════════════════════════════════════════════

    function bootstrap() {
      log.info(`Video_Control v${VSC_VERSION} bootstrap start`);

      const Utils = createUtils();
      const Scheduler = createScheduler(14);
      const Bus = createEventBus();
      const ApplyReq = createApplyRequester(Bus, Scheduler);
      const Store = createLocalStore(DEFAULTS, Scheduler, Utils);

      loadFromDisk(Store);

      const __origRegApply = Scheduler.registerApply;
      let __schedulerMuted = true;
      const __pendingRequests = [];
      const origRequest = Scheduler.request;
      Scheduler.request = function(immediate) {
        if (__schedulerMuted) { __pendingRequests.push(immediate); return; }
        origRequest.call(this, immediate);
      };

      bindNormalizer(Store,
        [P.APP_APPLY_ALL, P.APP_ZOOM_EN, P.APP_AUTO_SCENE, P.APP_ADV, P.APP_AUTO_PRESET],
        APP_SCHEMA, ApplyReq);
      bindNormalizer(Store,
        [P.V_PRE_S, P.V_PRE_B, P.V_PRE_MIX, P.V_SHADOW_MASK, P.V_BRIGHT_STEP],
        VIDEO_SCHEMA, ApplyReq);
      bindNormalizer(Store,
        [P.A_EN, P.A_BST, P.PB_EN, P.PB_RATE],
        AUDIO_PLAYBACK_SCHEMA, ApplyReq);

      window.__VSC_INTERNAL__.Bus = Bus;
      window.__VSC_INTERNAL__.Store = Store;
      window.__VSC_INTERNAL__.ApplyReq = ApplyReq;

      Bus.on('signal', (s) => { if (s && s.forceApply) Scheduler.request(true); });

      const Registry = createRegistry(Scheduler);
      const Targeting = createTargeting();
      const Audio = createAudio(Store);
      const Filters = createFiltersVideoOnly(Utils, { VSC_ID: CONFIG.VSC_ID, IS_MOBILE: CONFIG.IS_MOBILE });
      const Adapter = createBackendAdapter(Filters);
      const ZoomMgr = FEATURE_FLAGS.zoomFeature ? createZoomManager() : null;
      const AutoScene = createAutoSceneManager(Store, P, Scheduler);

      window.__VSC_INTERNAL__.Adapter = Adapter;
      window.__VSC_INTERNAL__.AutoScene = AutoScene;
      window.__VSC_INTERNAL__.ZoomManager = ZoomMgr;
      window.__VSC_INTERNAL__.Audio = Audio;

      window.__VSC_INTERNAL__._buildSaveData = () => buildSaveData(Store);
      window.__VSC_INTERNAL__._applyDataToStore = (data) => {
        const migrated = migrateV185Format(data);
        applyDataToStore(Store, migrated);
        normalizeBySchema(Store, APP_SCHEMA);
        normalizeBySchema(Store, VIDEO_SCHEMA);
        normalizeBySchema(Store, AUDIO_PLAYBACK_SCHEMA);
      };

      const UI = createUI(Store, Registry, ApplyReq, Utils);
      window.__VSC_UI_Ensure = UI.ensure;

      setupUserTracking(Scheduler);

      const applyFn = createApplyLoop(
        Store, Registry, Targeting, Adapter, Audio, AutoScene, ZoomMgr, ApplyReq, UI
      );
      Scheduler.registerApply(applyFn);

      Scheduler.request = origRequest;
      __schedulerMuted = false;
      const hadForce = __pendingRequests.some(v => v === true);
      if (__pendingRequests.length > 0) {
        Scheduler.request(hadForce);
      }
      __pendingRequests.length = 0;

      Store.sub('app.*', () => UI.ensure());
      Store.sub('video.*', () => UI.ensure());
      Store.sub('audio.*', () => UI.ensure());
      Store.sub('playback.*', () => UI.ensure());

      const __postTaskBgSave = (globalThis.scheduler && typeof globalThis.scheduler.postTask === 'function')
        ? () => { globalThis.scheduler.postTask(() => saveToDisk(Store), { priority: 'background' }).catch(() => saveToDisk(Store)); }
        : () => saveToDisk(Store);
      const saveDebounced = createDebounced(__postTaskBgSave, 500);
      Store.sub('video.*', saveDebounced);
      Store.sub('app.*', saveDebounced);
      Store.sub('audio.*', saveDebounced);
      Store.sub('playback.*', saveDebounced);

      setupKeyboard(Store, ApplyReq, ZoomMgr);
      setupOsdNotifications(Store);
      setupMediaSession(Store);
      setupGmMenus(Store, ApplyReq);
      setupAutoPresetWatcher(Store, ApplyReq);
      setupSpaWatcher(Registry, Scheduler, ApplyReq, ZoomMgr);
      setupMaintenance(Store, Registry, ApplyReq, Scheduler, ZoomMgr);
      /* v196 12-2: 모바일 롱프레스 2x 재생 */
      setupMobileLongPressSpeed(Store, ApplyReq);

      Store.sub(P.APP_ACT, (on) => {
        if (on) {
          try {
            Registry.refreshObservers();
            Registry.rescanAll();
            Scheduler.request(true);
          } catch (_) {}
        }
      });

      if (FEATURE_FLAGS.iframeInjection) {
        try { watchIframes(); } catch (_) {}
      }

      __globalSig.addEventListener('abort', () => {
        log.info('VSC global abort — cleaning up');
        try { Audio.destroy(); } catch (_) {}
        try { if (ZoomMgr) ZoomMgr.destroy(); } catch (_) {}
        try { UI.destroy(); } catch (_) {}
        clearTimer(__saveTimer);
        saveToDisk(Store);
        cleanupTouched();
      }, { once: true });

      if (Store.get(P.APP_AUTO_SCENE) && Store.get(P.APP_ACT)) {
        AutoScene.start();
      }

      const doInitial = () => {
        Registry.refreshObservers();
        Registry.rescanAll();
        UI.ensure();
        ApplyReq.hard();
      };

      if (document.body) {
        requestAnimationFrame(doInitial);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          try { doInitial(); } catch (_) {}
        }, { once: true, signal: __globalSig });
      }

      let __uiRetryCount = 0;
      const __uiRetryId = setRecurring(() => {
        __uiRetryCount++;
        if (Registry.videos.size > 0 || document.querySelector('video, object, embed')) {
          UI.ensure();
          if (__uiRetryCount > 3) clearRecurring(__uiRetryId);
        } else if (__uiRetryCount > 30) {
          clearRecurring(__uiRetryId);
        }
      }, 500);

      window.__VSC_APP__ = Object.freeze({
        getActiveVideo: () => window.__VSC_INTERNAL__._activeVideo || null,
        getStore: () => Store,
        version: VSC_VERSION
      });
      window.__VSC_INTERNAL__.App = window.__VSC_APP__;

      log.info(`Video_Control v${VSC_VERSION} bootstrap complete`);
    }

    // ═══════════════════════════════════════════════════════════
    //  Bootstrap trigger
    // ═══════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        try { bootstrap(); } catch (e) { log.error('Bootstrap failed:', e); }
      }, { once: true });
    } else {
      try { bootstrap(); } catch (e) { log.error('Bootstrap failed:', e); }
    }

  } // end VSC_MAIN

  // ═══════════════════════════════════════════════════════════
  //  Entry point — visibility-gated VSC_MAIN invocation
  // ═══════════════════════════════════════════════════════════

  if (document.visibilityState === 'visible' || document.readyState !== 'complete') {
    VSC_MAIN();
  } else {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', onVisible);
        VSC_MAIN();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    setTimeout(() => {
      document.removeEventListener('visibilitychange', onVisible);
      if (!window.__VSC_BOOT_LOCK__ || window.__VSC_BOOT_LOCK__ !== true) {
        VSC_MAIN();
      }
    }, 10000);
  }

})();
