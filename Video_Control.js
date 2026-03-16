// ==UserScript==
// @name         Video_Control (v191.0.0)
// @namespace    https://github.com/
// @version      191.0.0
// @description  v191: dual-path sharpening (PC SVG isotropic + Mobile CSS pseudo-sharp), audio param tuning, CLAHE/color correction refinement, targeting rebalance, edge-case hardening, UI polish.
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
          if (++consecutiveErrors >= maxErrors) {
            clearInterval(id); _activeIntervals.delete(id);
            if (onKill) { try { onKill(); } catch (__) {} }
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

        // v191: blockInterference — Shadow DOM 내부 버튼 클릭을 보호
    const __blockedElements = new WeakSet();
    const BLOCK_EVENTS_PASSIVE = Object.freeze(['pointerdown', 'pointerup', 'dblclick', 'contextmenu']);
    function blockInterference(el) {
      if (!el || __blockedElements.has(el)) return;
      __blockedElements.add(el);
      const stop = (e) => {
        // v191: 버튼/인풋 클릭은 차단하지 않음
        const t = e.target;
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                  t.closest?.('button') || t.closest?.('input'))) return;
        e.stopPropagation();
      };
      for (const evt of BLOCK_EVENTS_PASSIVE) {
        on(el, evt, stop, { passive: true });
      }
      // v191: click은 별도 처리 — 버튼 계열은 통과시킴
      on(el, 'click', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'BUTTON' || t.tagName === 'INPUT' || t.tagName === 'SELECT' ||
                  t.closest?.('button') || t.closest?.('input'))) return;
        e.stopPropagation();
      }, { passive: true });
      on(el, 'wheel', (e) => {
        if (e.altKey) return;
        e.stopPropagation();
      }, { passive: true });
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
    const VSC_VERSION = '191.0.0';

    const COLOR_CAST_CORRECTION = 0.16;
    const MOBILE_COLOR_BIAS = { r: 1.00, g: 1.00, b: 0.97 };

    const STORAGE_KEY_BASE = 'vsc_v2_' + location.hostname;
    const PATH_SPECIFIC_HOSTS = Object.freeze({ 'youtube.com': ['/shorts', '/watch', '/live'] });
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
    const SPA_RESCAN_DEBOUNCE_MS = 250;
    const GUARD = Object.freeze({
      AUDIO_SRC_COOLDOWN: 3000,
      AUDIO_SRC_COOLDOWN_DRM: 8000,
      TARGET_HYSTERESIS_MS: 450,
      TARGET_HYSTERESIS_MARGIN: 0.8
    });

    const RATE_BLOCKED_HOSTS = Object.freeze(['netflix.com','disneyplus.com','primevideo.com','hulu.com','max.com','peacocktv.com','paramountplus.com','crunchyroll.com']);
    const RATE_BLOCKED_PATHS = Object.freeze([{ host: 'amazon.com', pathPrefix: '/gp/video' }]);
    function isRateBlockedContext() {
      const h = location.hostname;
      if (RATE_BLOCKED_HOSTS.some(d => h === d || h.endsWith('.' + d))) return true;
      return RATE_BLOCKED_PATHS.some(rule => (h === rule.host || h.endsWith('.' + rule.host)) && location.pathname.startsWith(rule.pathPrefix));
    }
    const __rateBlockedSite = isRateBlockedContext();

    const LITE_FORCED_HOSTS = Object.freeze(['ok.ru', 'mail.ru', 'vk.com', 'dzen.ru', 'rutube.ru']);
    const __liteForced = (() => { const h = location.hostname; return LITE_FORCED_HOSTS.some(d => h === d || h.endsWith('.' + d)); })();

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

    /* ── Presets ── */
    const PRESETS = Object.freeze({
      detail: {
        off: { sharpAdd: 0, sharp2Add: 0, clarityAdd: 0 },
        S: { sharpAdd: 12, sharp2Add: 2, clarityAdd: 3 },
        M: { sharpAdd: 15, sharp2Add: 8, clarityAdd: 8 },
        L: { sharpAdd: 16, sharp2Add: 18, clarityAdd: 14 },
        XL: { sharpAdd: 20, sharp2Add: 14, clarityAdd: 18 }
      },
      grade: {
        off: { gammaF: 1.00, brightAdd: 0 },
        S: { gammaF: 1.02, brightAdd: 1.5 },
        M: { gammaF: 1.06, brightAdd: 3.8 },
        L: { gammaF: 1.13, brightAdd: 8 },
        DS: { gammaF: 1.04, brightAdd: 3.0 },
        DM: { gammaF: 1.08, brightAdd: 6.0 },
        DL: { gammaF: 1.16, brightAdd: 9.5 }
      }
    });

    const PRESET_LABELS = Object.freeze({
      detail: { off: 'OFF', S: '1080p', M: '720p', L: '480p', XL: '360p' },
      grade: { off: 'OFF', S: '밝게S', M: '밝게M', L: '밝게L', DS: '암부S', DM: '암부M', DL: '암부L' }
    });

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

    /* ── SPA URL detector ── */
    function initSpaUrlDetector(onChanged) {
      if (window.__VSC_SPA_PATCHED__) return;
      window.__VSC_SPA_PATCHED__ = true;
      let lastHref = location.href;
      const origHistory = {};
      const emitIfChanged = () => { const next = location.href; if (next === lastHref) return; lastHref = next; onChanged(); };
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
          try { if (history[name]?.__vsc_patched && origHistory[name]) history[name] = origHistory[name]; } catch (_) {}
        }
      }, { once: true });
    }

    /* ── Iframe injection ── */
    const __VSC_INJECT_SOURCE = `;(${VSC_MAIN.toString()})();`;
    const __injectedIframes = new WeakSet();
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
        if (!ifr.__vscLoadHooked) {
          ifr.__vscLoadHooked = true;
          ifr.addEventListener('load', () => { if (canAccess(ifr)) tryInject(); }, { passive: true, signal: __globalSig });
        }
      };
      document.querySelectorAll("iframe").forEach(inject);
      const mo = new MutationObserver((muts) => {
        if (__globalSig.aborted) { mo.disconnect(); return; }
        for (const m of muts) {
          if (m.addedNodes) {
            m.addedNodes.forEach(n => {
              if (n.tagName === 'IFRAME') inject(n);
              else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(inject);
            });
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
        if (video.readyState > 0 && (video.src || video.srcObject || video.querySelector?.('source'))) {
          try {
            const target = document.body || document.documentElement;
            if (target) {
              const emergencyStyles = { position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', 'z-index': '2147483647', background: '#000' };
              for (const [prop, val] of Object.entries(emergencyStyles)) video.style.setProperty(prop, val, 'important');
              target.appendChild(video);
              log.warn('Video restored to body as emergency fallback');
              showOSD('비디오 복원됨 (비상 모드)', 3000);
              const cleanupEmergencyStyle = () => { for (const prop of Object.keys(emergencyStyles)) video.style.removeProperty(prop); };
              const emergencyAc = new AbortController();
              const emergencyMo = new MutationObserver(() => {
                if (video.parentNode !== target) { cleanupEmergencyStyle(); emergencyAc.abort(); }
              });
              try { emergencyMo.observe(target, { childList: true }); } catch (_) {}
              emergencyAc.signal.addEventListener('abort', () => emergencyMo.disconnect(), { once: true });
              setTimer(() => emergencyAc.abort(), 5000);
            }
          } catch (_) {}
        }
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

    // ─── END OF PART 1 ───
    // PART 2 continues with: enterPiP, exitPiP, togglePiPFor, captureVideoFrame,
    // createZoomManager, createTargeting, createEventBus, createApplyRequester, createUtils, createScheduler
    // ─── PART 2 START ───
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
              const oldAc = st._ac; st._ac = null; st.bound = false;
              if (oldAc) { try { oldAc.abort(); } catch (_) {} }
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
      const ZOOM_PROPS = ['will-change', 'contain', 'backface-visibility', 'transition', 'transform-origin', 'transform', 'cursor', 'z-index', 'position'];
      const getSt = (v) => { let st = stateMap.get(v); if (!st) { st = { scale: 1, tx: 0, ty: 0, hasPanned: false, zoomed: false, _savedPosition: '', _savedZIndex: '' }; stateMap.set(v, st); } return st; };
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
          zoomedVideos.delete(v); return;
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
        const ix = (clientX - rect.left) / st.scale, iy = (clientY - rect.top) / st.scale;
        st.tx = clientX - (rect.left - st.tx) - ix * newScale;
        st.ty = clientY - (rect.top - st.ty) - iy * newScale;
        st.scale = newScale; update(v);
      };

      const resetZoom = (v) => {
        if (!v) return;
        const st = getSt(v); st.scale = 1;
        if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
        pendingUpdates.delete(v); update(v);
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
              if (n.nodeType === 1) { if (n.hasAttribute?.('data-vsc-ui') || n.id === 'vsc-host' || n.id === 'vsc-gear-host') return true; }
              if (n.nodeType === 11 && n.host) { if (n.host.hasAttribute?.('data-vsc-ui') || n.host.id === 'vsc-host' || n.host.id === 'vsc-gear-host') return true; }
            }
          }
        } catch (_) {}
        return false;
      }

      function getTargetVideo(e) {
        if (typeof e.composedPath === 'function') { const path = e.composedPath(); for (let i = 0, len = Math.min(path.length, 10); i < len; i++) { if (path[i]?.tagName === 'VIDEO') return path[i]; } }
        const touch = e.touches?.[0], cx = Number.isFinite(e.clientX) ? e.clientX : (touch?.clientX ?? null), cy = Number.isFinite(e.clientY) ? e.clientY : (touch?.clientY ?? null);
        if (cx != null && cy != null) { const els = document.elementsFromPoint(cx, cy); for (const el of els) { if (el?.tagName === 'VIDEO') return el; } }
        return window.__VSC_INTERNAL__?.App?.getActiveVideo() || null;
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
        if (!activeVideo.isConnected) { isPanning = false; try { activeVideo.releasePointerCapture?.(e.pointerId); } catch (_) {} activePointerId = null; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (e.cancelable) { e.preventDefault(); e.stopPropagation(); }
        const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e], last = events[events.length - 1] || e;
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

      onWin('touchstart', e => {
        if (CONFIG.IS_MOBILE && !isZoomEnabled()) return;
        if (isVscUiEvent(e)) return;
        const v = getTargetVideo(e); if (!v) return;
        if (e.touches.length === 2) {
          isPanning = false; if (e.cancelable) e.preventDefault();
          const st = getSt(v);
          activeVideo = v; pinchState.active = true;
          pinchState.initialDist = getTouchDist(e.touches);
          pinchState.initialScale = st.scale;
          const c = getTouchCenter(e.touches);
          pinchState.lastCx = c.x; pinchState.lastCy = c.y;
        } else if (e.touches.length === 1) {
          const st = getSt(v);
          if (st.scale > 1) {
            if (e.cancelable) e.preventDefault();
            activeVideo = v; isPanning = true; st.hasPanned = false;
            startX = e.touches[0].clientX - st.tx; startY = e.touches[0].clientY - st.ty;
          }
        }
      }, { passive: false, capture: true });

      onWin('touchmove', e => {
        if (!activeVideo) return;
        if (!activeVideo.isConnected) { isPanning = false; pinchState.active = false; activeVideo = null; return; }
        const st = getSt(activeVideo);
        if (pinchState.active && e.touches.length === 2) {
          if (e.cancelable) e.preventDefault();
          const dist = getTouchDist(e.touches), center = getTouchCenter(e.touches);
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
          st.tx = nextTx; st.ty = nextTy; clampPan(activeVideo, st); update(activeVideo);
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
        } else if (e.touches.length === 0) { isPanning = false; update(activeVideo); activeVideo = null; }
      }, { passive: false, capture: true });

      return {
        resetZoom, zoomTo, isZoomed,
        pruneDisconnected: () => { for (const v of [...zoomedVideos]) { if (!v?.isConnected) resetZoom(v); } },
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
            st.scale = 1; st.zoomed = false;
          }
          zoomedVideos.clear(); isPanning = false; pinchState.active = false;
          activeVideo = null; activePointerId = null;
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
        AUDIO_BOOST_EXTRA: 0.8, PIP_BONUS: 6.0, MIN_AREA: 25600
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

    /* ── Utils ── */
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
          const state = {};
          for (const [cat, obj] of Object.entries(defaults)) {
            state[cat] = typeof obj === 'object' && obj !== null ? { ...obj } : obj;
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
      const pathCache = Utils.createCappedMap(256);
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

    /* ── Registry ── */
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
      }, { root: null, threshold: 0.02, rootMargin: '200px' }) : null;

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

    // ─── END OF PART 2 ───
    // PART 3 continues with: createAudio, createAutoSceneManager, curveToApproxParams
    // ─── PART 3 START ───
    // createAudio, createAutoSceneManager, curveToApproxParams

    /* ── Audio Engine ── */
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

      const VSC_AUD_HPF_HZ = 60;
      const VSC_AUD_HPF_Q = 0.707;
      const VSC_AUD_CLIP_KNEE = 0.85;
      const VSC_AUD_CLIP_DRIVE = 2.0;

      let __vscClipCurve = null;
      function getSoftClipCurve() {
        if (__vscClipCurve) return __vscClipCurve;
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
        __vscClipCurve = curve; return curve;
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
        ctx = null; compressor = null; limiter = null; wetInGain = null;
        dryOut = null; wetOut = null; masterOut = null; hpf = null;
        clipper = null; analyser = null; dataArray = null;
        currentSrc = null; target = null;
      };

      const buildAudioGraph = () => {
        compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 8;
        compressor.ratio.value = 4.0;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.15;

        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -1.0;
        limiter.knee.value = 0;
        limiter.ratio.value = 20.0;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.08;

        hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass';
        hpf.frequency.value = VSC_AUD_HPF_HZ;
        hpf.Q.value = VSC_AUD_HPF_Q;

        clipper = ctx.createWaveShaper();
        clipper.curve = getSoftClipCurve();
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
          __ctxBlockUntil = now + 60000;
          __ctxCreateCount = 0;
          log.warn('AudioContext creation limit reached, cooling down');
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
                log.debug('MediaElementSource already exists, marking cooldown');
                const cooldown = __rateBlockedSite ? GUARD.AUDIO_SRC_COOLDOWN_DRM : GUARD.AUDIO_SRC_COOLDOWN;
                if (st && VSC_DEFENSE.audioCooldown) st.audioFailUntil = performance.now() + cooldown;
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

    /* ── Auto Scene Manager ── */
    function createAutoSceneManager(Store, P, Scheduler) {
      const clamp = VSC_CLAMP;

      const HIST_BINS = 256;
      const TONE_STEPS = 256;
      const CANVAS_W = CONFIG.IS_MOBILE ? 96 : 128;
      const CANVAS_H = CONFIG.IS_MOBILE ? 54 : 72;
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
        let finalRG = VSC_CLAMP(rGain, 0.90, 1.10);
        let finalGG = VSC_CLAMP(gGain, 0.94, 1.06);
        let finalBG = VSC_CLAMP(bGain, 0.85, 1.15);
        if (CONFIG.IS_MOBILE && typeof MOBILE_COLOR_BIAS !== 'undefined') {
          finalRG *= MOBILE_COLOR_BIAS.r; finalGG *= MOBILE_COLOR_BIAS.g; finalBG *= MOBILE_COLOR_BIAS.b;
          finalRG = VSC_CLAMP(finalRG, 0.85, 1.15); finalBG = VSC_CLAMP(finalBG, 0.85, 1.20);
        }
        return { rGain: finalRG, gGain: finalGG, bGain: finalBG };
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
        [ST.BACKLIT]:       { clipLimit: 3.0, shadowProtect: 0.20, highlightProtect: 0.60, midtoneBoost: 0.10, strength: 0.35, satTarget: 1.04 }
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
      const cutScores = [], gradualScores = [];

      function detectTransition(stats, prev) {
        if (!prev) return { isCut: false, isFade: false };
        const score = Math.abs(stats.bright - prev.bright) * 1.3 + Math.abs(stats.contrast - prev.contrast) * 0.7 + Math.abs(stats.chroma - prev.chroma) * 0.5 + Math.abs(stats.edge - prev.edge) * 0.3 + Math.abs(stats.motionSAD || 0) * 0.35;
        cutScores.push(score); if (cutScores.length > CUT_HIST_LEN) cutScores.shift();
        const sorted = cutScores.slice().sort((a, b) => a - b);
        const q90 = sorted[Math.floor(sorted.length * 0.90)] || 0.15;
        const cutThr = Math.max(0.10, Math.min(0.28, q90 * 1.25));
        const isCut = score > cutThr;
        gradualScores.push(score); if (gradualScores.length > 10) gradualScores.shift();
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

      function computeFullAnalysis(data, sw, sh) {
        const step = 2;
        let sum = 0, sum2 = 0, sumEdge = 0, sumChroma = 0, count = 0, skinCount = 0;
        const lumHist = new Uint32Array(HIST_BINS);
        const rHist = new Uint32Array(HIST_BINS), gHist = new Uint32Array(HIST_BINS), bHist = new Uint32Array(HIST_BINS);
        const zoneW = Math.floor(sw / ZONE_COLS), zoneH = Math.floor(sh / ZONE_ROWS);
        const zoneHists = new Array(ZONE_COUNT), zoneCounts = new Uint32Array(ZONE_COUNT);
        for (let z = 0; z < ZONE_COUNT; z++) zoneHists[z] = new Uint32Array(HIST_BINS);
        const zoneBrightSum = new Float32Array(ZONE_COUNT), zoneBrightCount = new Uint32Array(ZONE_COUNT);
        const pixelCount = sw * sh;
        if (!__curLumBuf || __curLumBufSize !== pixelCount) { __curLumBuf = new Uint8Array(pixelCount); __curLumBufSize = pixelCount; }
        const curLum = __curLumBuf;
        let hiLumaRSum = 0, hiLumaBSum = 0, hiLumaCount = 0;
        const HI_LUMA_THR = 180;

        const zxLut = new Uint8Array(sw);
        const maxZx = ZONE_COLS - 1, maxZy = ZONE_ROWS - 1;
        const invZoneW = 1 / Math.max(1, zoneW), invZoneH = 1 / Math.max(1, zoneH);
        for (let x = 0; x < sw; x++) zxLut[x] = Math.min(maxZx, (x * invZoneW) | 0);
        const zyLut = new Uint8Array(sh);
        for (let y = 0; y < sh; y++) zyLut[y] = Math.min(maxZy, (y * invZoneH) | 0);

        for (let y = 0; y < sh; y += step) {
          const row = y * sw;
          const zy = zyLut[y];
          const zyBase = zy * ZONE_COLS;
          for (let x = 0; x < sw; x += step) {
            const idx = (row + x) << 2;
            const r = data[idx], g = data[idx | 1], b = data[idx | 2];
            const l = (r * 54 + g * 183 + b * 18 + 128) >> 8;
            const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            curLum[row + x] = l;
            sumChroma += mx - mn;
            sum += l; sum2 += l * l; count++;
            lumHist[l]++; rHist[r]++; gHist[g]++; bHist[b]++;
            const ni = idx + 8;
            if (x + step < sw) {
              const l2 = (data[ni] * 54 + data[ni | 1] * 183 + data[ni | 2] * 18 + 128) >> 8;
              const diff = l2 - l;
              sumEdge += (diff ^ (diff >> 31)) - (diff >> 31);
            }
            if (r > g && r > b && r >= 80 && g >= 35 && b >= 20 && (r - g) > 12) skinCount++;
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
              for (let dy = 0; dy < bh; dy += step) { for (let dx = 0; dx < bw; dx += step) { const pi = (by + dy) * sw + (bx + dx); blockSad += Math.abs(curLum[pi] - __prevLumBuf[pi]); } }
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
        boostMs: 700, fpsHist: [], minFps: 1.0, maxFps: 6, curFps: 2,
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

      function loop() {
        if (!AUTO.running || __globalSig.aborted) return;
        const now = performance.now();
        const en = !!Store.get(P.APP_AUTO_SCENE) && !!Store.get(P.APP_ACT);
        const v = window.__VSC_APP__?.getActiveVideo?.();
        if (!en) { AUTO.cur = { br: 1.0, ct: 1.0, sat: 1.0, _toneCurve: null, _channelGains: null }; prevToneCurve = null; scheduleNext(v, 500); return; }
        if (AUTO.drmBlocked && now < AUTO.blockUntilMs) { scheduleNext(v, 500); return; }
        if (document.hidden) { scheduleNext(v, 2000); return; }
        if (!v || !cvCtx || v.paused || v.seeking || v.readyState < 2) { try { Scheduler.request(true); } catch (_) {} scheduleNext(v, 300); return; }

        try {
          if (cv.width !== CANVAS_W || cv.height !== CANVAS_H) { cv.width = CANVAS_W; cv.height = CANVAS_H; }
          cvCtx.drawImage(v, 0, 0, CANVAS_W, CANVAS_H);
          const img = cvCtx.getImageData(0, 0, CANVAS_W, CANVAS_H);
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
        cutScores.length = 0; gradualScores.length = 0; flickerCount = 0; lastCurveDir = 0;
        __prevLumBuf = null; __fuzzyInited = false; __fuzzyEma.fill(0);
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

    /* ── curveToApproxParams ── */
    function curveToApproxParams(curve, satMul, channelGains) {
      const clamp = VSC_CLAMP;
      const N = 256;
      let S0 = 0, S1 = 0, S2 = 0, S3 = 0, S4 = 0, S5 = 0, S6 = 0;
      let T0 = 0, T1 = 0, T2 = 0, T3 = 0;
      for (let i = 0; i < N; i++) {
        const x = i / (N - 1), y = curve[i];
        const x2 = x * x, x3 = x2 * x;
        S0 += 1; S1 += x; S2 += x2; S3 += x3;
        S4 += x2 * x2; S5 += x2 * x3; S6 += x3 * x3;
        T0 += y; T1 += y * x; T2 += y * x2; T3 += y * x3;
      }
      const A = [ [S0, S1, S2, S3, T0], [S1, S2, S3, S4, T1], [S2, S3, S4, S5, T2], [S3, S4, S5, S6, T3] ];
      for (let col = 0; col < 4; col++) {
        let maxRow = col, maxVal = Math.abs(A[col][col]);
        for (let row = col + 1; row < 4; row++) { const v = Math.abs(A[row][col]); if (v > maxVal) { maxVal = v; maxRow = row; } }
        if (maxRow !== col) { const tmp = A[col]; A[col] = A[maxRow]; A[maxRow] = tmp; }
        const pivot = A[col][col]; if (Math.abs(pivot) < 1e-12) continue;
        for (let row = col + 1; row < 4; row++) { const factor = A[row][col] / pivot; for (let j = col; j < 5; j++) A[row][j] -= factor * A[col][j]; }
      }
      const coeffs = [0, 0, 0, 0];
      for (let row = 3; row >= 0; row--) {
        let s = A[row][4];
        for (let j = row + 1; j < 4; j++) s -= A[row][j] * coeffs[j];
        coeffs[row] = Math.abs(A[row][row]) > 1e-12 ? s / A[row][row] : 0;
      }
      const a0 = coeffs[0], a1 = coeffs[1], a2 = coeffs[2], a3 = coeffs[3];
      const mid = clamp(a0 + a1 * 0.5 + a2 * 0.25 + a3 * 0.125, 0.01, 0.99);
      let gamma = 1.0;
      if (mid > 0.01 && mid < 0.99) { gamma = Math.log(mid) / Math.log(0.5); gamma = clamp(gamma, 0.65, 1.6); }
      const slopeAtMid = a1 + 2 * a2 * 0.5 + 3 * a3 * 0.25;
      const contrast = clamp(slopeAtMid, 0.75, 1.35);
      const curveIntegral = a0 + a1 / 2 + a2 / 3 + a3 / 4;
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

    // ─── END OF PART 3 ───
    // PART 4 continues with: createFiltersVideoOnly, shadow/bright precomputed,
    // composeVideoParamsInto (with mobile CSS pseudo-sharp), createVideoParamsMemo,
    // createUI, and all UI helpers
    // ─── PART 4 START ───
    // createFiltersVideoOnly, shadow/bright precomputed, composeVideoParamsInto,
    // isNeutralVideoParams, createVideoParamsMemo, applyShadowStyle, createDisposerBag,
    // bindWindowDrag, VSC_ICONS, svgIcon, showOSD, getAutoPresetForResolution, createUI

    /* ── SVG Filter Engine ── */
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

      let _toneStrArr = null;
      function toneStr(idx) {
        if (!_toneStrArr) {
          _toneStrArr = new Array(10001);
          for (let i = 0; i <= 10000; i++) _toneStrArr[i] = (i / 10000).toFixed(4);
        }
        return _toneStrArr[idx] || (idx / 10000).toFixed(4);
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
      __globalSig.addEventListener('abort', () => {
        for (const svg of __createdSvgs) { try { if (svg.parentNode) svg.remove(); } catch (_) {} }
        __createdSvgs.clear();
      }, { once: true });

      function buildSvg(root) {
        const svg = h('svg', { ns: 'svg', style: 'position:absolute;left:-9999px;width:0;height:0;' });
        const defs = h('defs', { ns: 'svg' });
        svg.append(defs);
        __createdSvgs.add(svg);

        const fidLite = `vsc-lite-${config.VSC_ID}`;
        const lite = h('filter', { ns: 'svg', id: fidLite, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const liteConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'lSharp' });
        const liteTone = mkXfer({ in: 'lSharp', result: 'lBase' }, { type: 'table', tableValues: '0 1' });
        const liteTmp = mkXfer({ in: 'lBase', result: 'lOut' }, { type: 'linear', slope: '1' });
        lite.append(liteConv, liteTone, liteTmp);

        const fidFull = `vsc-full-${config.VSC_ID}`;
        const full = h('filter', { ns: 'svg', id: fidFull, 'color-interpolation-filters': 'sRGB', x: '0%', y: '0%', width: '100%', height: '100%' });
        const fConv = h('feConvolveMatrix', { ns: 'svg', in: 'SourceGraphic', order: '3', kernelMatrix: '0,0,0, 0,1,0, 0,0,0', divisor: '1', bias: '0', targetX: '1', targetY: '1', edgeMode: 'duplicate', preserveAlpha: 'true', result: 'conv' });
        const fTone = mkXfer({ in: 'conv', result: 'tone' }, { type: 'table', tableValues: '0 1' }, true);
        const fTemp = mkXfer({ in: 'tone', result: 'tmp' }, { type: 'linear', slope: '1' });
        const fFinal = h('feColorMatrix', { ns: 'svg', in: 'tmp', type: 'saturate', values: '1.0', result: 'final' });
        full.append(fConv, fTone, fTemp, fFinal);

        defs.append(lite, full);

        const tryAppend = () => {
          const target = (root instanceof ShadowRoot) ? root : (root.body || root.documentElement || root);
          if (!target?.appendChild) return false;
          try {
            const escapedFull = fidFull.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const existing = target.querySelector(`filter[id="${escapedFull}"]`);
            if (existing) { const oldSvg = existing.closest('svg'); if (oldSvg && oldSvg !== svg) oldSvg.remove(); }
          } catch (_) {}
          target.appendChild(svg); return true;
        };
        if (!tryAppend()) {
          let retryCount = 0;
          const t = setRecurring(() => { if (++retryCount > 40 || tryAppend()) clearRecurring(t); }, 50);
          setTimer(() => clearRecurring(t), 3000);
        }

        const fullToneFuncsAll = Array.from(fTone.children);
        const liteToneFuncsAll = Array.from(liteTone.children);

        return {
          fidLite, fidFull, liteConv,
          liteToneFuncs: liteToneFuncsAll,
          liteToneFuncsRGB: liteToneFuncsAll.filter(fn => fn.tagName !== 'feFuncA'),
          liteTmpFuncs: Array.from(liteTmp.children),
          fConv,
          fullToneFuncs: fullToneFuncsAll,
          fullToneFuncsRGB: fullToneFuncsAll.filter(fn => fn.tagName !== 'feFuncA'),
          fullTempFuncs: Array.from(fTemp.children),
          fFinal,
          st: { lastKey: '', liteToneKey: '', liteToneTable: '', liteConvKey: '', liteTempKey: '', fullToneKey: '', fullToneTable: '', fullSharpKey: '', fullDesatKey: '', fullTempKey: '' }
        };
      }

      function prepare(video, s) {
        const root = (video.getRootNode && video.getRootNode() !== video.ownerDocument) ? video.getRootNode() : (video.ownerDocument || document);
        let dc = urlCache.get(root);
        if (!dc) { dc = { key: '', url: '', filterStr: 'none' }; urlCache.set(root, dc); }

        const useFull = !__liteForced;
        const svgKey = (useFull ? 'F' : 'L') + '|' + (video.videoWidth || 0) + '|' + makeKeyBase(s);
        const fullKey = svgKey + '|css:' + s._cssBr.toFixed(3) + '|' + s._cssCt.toFixed(3) + '|' + s._cssSat.toFixed(3);
        if (dc.key === fullKey) return { svgUrl: dc.url, filterStr: dc.filterStr };

        let ctx = ctxMap.get(root);
        if (!ctx) { ctx = buildSvg(root); ctxMap.set(root, ctx); }
        const st = ctx.st;

        if (st.lastKey !== svgKey) {
          st.lastKey = svgKey;
          const steps = 256;
          const gamma = 1 / clamp(s.gamma || 1, 0.1, 5.0);
          const toneTable = s._autoToneCurve ? s._autoToneCurve.join(' ') : getToneTableCached(steps, 0, 0, 0, s.gain || 1, 1.0, 0, gamma);

          /* ── Sharpening kernel computation ── */
          let totalS, kernelStr;
          if (CONFIG.IS_MOBILE) {
            // 모바일: SVG 컨볼루션 비활성 — CSS pseudo-sharp가 composeVideoParamsInto에서 처리
            totalS = 0;
          } else {
            // PC: 등방성(isotropic) 8방향 커널
            const refH = 1080;
            const pxScale = clamp((video.videoHeight || refH) / refH, 0.5, 2.0);
            const rawS = (Number(s.sharp || 0) + Number(s.sharp2 || 0) * 0.6 + Number(s.clarity || 0) * 0.4) / 100.0;
            totalS = clamp(rawS * 0.35 * pxScale, 0, 0.30);
          }

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

          if (useFull) {
            if (st.fullToneKey !== toneTable) {
              st.fullToneKey = toneTable;
              for (const fn of ctx.fullToneFuncsRGB) fn.setAttribute('tableValues', toneTable);
            }
            const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);
            if (st.fullTempKey !== tmk) {
              st.fullTempKey = tmk;
              ctx.fullTempFuncs[0].setAttribute('slope', finalRs);
              ctx.fullTempFuncs[1].setAttribute('slope', finalGs);
              ctx.fullTempFuncs[2].setAttribute('slope', finalBs);
            }
            const sharpKey = kernelStr;
            if (st.fullSharpKey !== sharpKey) {
              st.fullSharpKey = sharpKey;
              ctx.fConv.setAttribute('kernelMatrix', kernelStr);
              const desatVal = totalS > 0.008 ? clamp(1.0 - totalS * 0.1, 0.90, 1.0).toFixed(3) : '1.000';
              if (st.fullDesatKey !== desatVal) { st.fullDesatKey = desatVal; ctx.fFinal.setAttribute('values', desatVal); }
            }
          } else {
            if (st.liteToneKey !== toneTable) {
              st.liteToneKey = toneTable;
              for (const fn of ctx.liteToneFuncsRGB) fn.setAttribute('tableValues', toneTable);
            }
            const tmk = finalRs.toFixed(3) + '|' + finalGs.toFixed(3) + '|' + finalBs.toFixed(3);
            if (st.liteTempKey !== tmk) {
              st.liteTempKey = tmk;
              ctx.liteTmpFuncs[0].setAttribute('slope', finalRs);
              ctx.liteTmpFuncs[1].setAttribute('slope', finalGs);
              ctx.liteTmpFuncs[2].setAttribute('slope', finalBs);
            }
            const mk = kernelStr;
            if (st.liteConvKey !== mk) { st.liteConvKey = mk; ctx.liteConv.setAttribute('kernelMatrix', kernelStr); }
          }
        }

        const fid = useFull ? ctx.fidFull : ctx.fidLite;
        const url = `url(#${fid})`;
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
              el.style.removeProperty('will-change'); el.style.removeProperty('filter');
              el.style.removeProperty('-webkit-filter'); el.style.removeProperty('background-color');
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

    /* ── Compose Video Params (with mobile CSS pseudo-sharp) ── */
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

      if (CONFIG.IS_MOBILE) {
        // 모바일: SVG 컨볼루션 비활성 — CSS contrast/brightness로 의사 샤프닝
        out.sharp = 0; out.sharp2 = 0; out.clarity = 0;
        const sharpIntent = ((dPreset.sharpAdd || 0) + (dPreset.sharp2Add || 0) * 0.6
                            + (dPreset.clarityAdd || 0) * 0.4) / 100.0 * mix;
        out._mobileSharpIntent = sharpIntent;
      } else {
        // PC: SVG 등방성 커널 사용
        out.sharp = (dPreset.sharpAdd || 0) * mix;
        out.sharp2 = (dPreset.sharp2Add || 0) * mix;
        out.clarity = (dPreset.clarityAdd || 0) * mix;
        out._mobileSharpIntent = 0;
      }

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
        out._autoToneCurve = autoMods._toneCurve;
        out._autoChannelGains = autoMods._channelGains || null;
      } else {
        out.gain = (out.gain || 1.0) * autoMods.br;
        out.contrast = (out.contrast || 1.0) * autoMods.ct;
        out.satF = (out.satF || 1.0) * autoMods.sat;
      }

      out._cssBr = VSC_CLAMP(1.0 + (out.bright || 0) * 0.008, 0.5, 2.0);
      out._cssCt = VSC_CLAMP(out.contrast || 1, 0.5, 2.0);
      out._cssSat = VSC_CLAMP(out.satF || 1, 0, 3.0);

      // 모바일 CSS 의사 샤프닝 적용
      const si = out._mobileSharpIntent || 0;
      if (si > 0.01) {
        const ctBoost = 1.0 + VSC_CLAMP(si * 0.24, 0, 0.12);
        const brComp = 1.0 - VSC_CLAMP(si * 0.03, 0, 0.015);
        const satComp = 1.0 - VSC_CLAMP(si * 0.04, 0, 0.02);
        out._cssCt = VSC_CLAMP(out._cssCt * ctBoost, 0.5, 2.0);
        out._cssBr = VSC_CLAMP(out._cssBr * brComp, 0.5, 2.0);
        out._cssSat = VSC_CLAMP(out._cssSat * satComp, 0, 3.0);
      }

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
          svgBase.sharp = Math.min(Number(svgBase.sharp || 0), 36);
          lastResult = svgBase; lastKey = key;
          return lastResult;
        }
      };
    }

    /* ── Shadow Style Helper ── */
    const __styleCacheMaxSize = 16;
    const __styleCache = new Map();
    function applyShadowStyle(shadow, cssText, h) {
      try {
        if ('adoptedStyleSheets' in shadow && 'replaceSync' in CSSStyleSheet.prototype) {
          let sheet = __styleCache.get(cssText);
          if (!sheet) {
            sheet = new CSSStyleSheet(); sheet.replaceSync(cssText);
            __styleCache.set(cssText, sheet);
            if (__styleCache.size > __styleCacheMaxSize) __styleCache.delete(__styleCache.keys().next().value);
          }
          const cur = shadow.adoptedStyleSheets || [];
          if (!cur.includes(sheet)) shadow.adoptedStyleSheets = [...cur, sheet];
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

    /* ── Icons ── */
    const VSC_ICONS = Object.freeze({
      gear: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
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
      upload: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`
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
          if (__osdEl) { clearTimeout(__osdEl._timer); if (__osdEl.isConnected) { try { __osdEl.remove(); } catch (_) {} } }
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
        // 모바일: CSS pseudo-sharp이므로 더 낮은 해상도 기준 적용
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

    /* ── UI ── */
        function createUI(sm, registry, ApplyReq, Utils) {
      const { h } = Utils;
      let container, gearHost, gearBtn, fadeTimer = 0, bootWakeTimer = 0;
      const uiWakeCtrl = new AbortController();
      const bag = createDisposerBag();
      const sub = (k, fn) => bag.add(sm.sub(k, fn));
      const detachNodesHard = () => {
        try { if (container?.isConnected) container.remove(); } catch (_) {}
        try { if (gearHost?.isConnected) gearHost.remove(); } catch (_) {}
      };
      const allowUiInThisDoc = () => {
        if (registry.videos.size > 0) return true;
        const hasVideoElements = !!document.querySelector('video, object, embed');
        if (hasVideoElements) return true;
        return false;
      };
      function setAndHint(path, value) {
        const prev = sm.get(path);
        const changed = !Object.is(prev, value);
        if (changed) sm.set(path, value);
        (changed ? ApplyReq.hard() : ApplyReq.soft());
      }
      function getFullscreenElementSafe() {
        return document.fullscreenElement || document.webkitFullscreenElement || null;
      }
      const getUiRoot = () => {
        const fs = getFullscreenElementSafe();
        if (fs) {
          if (fs.classList && fs.classList.contains('vsc-fs-wrap')) return fs;
          if (fs.tagName === 'VIDEO') return fs.parentElement || fs.getRootNode?.().host || document.body || document.documentElement;
          return fs;
        }
        return document.body || document.documentElement;
      };
      function bindClassToggle(btn, path, isActive) {
        const sync = () => { if (btn) btn.classList.toggle('active', isActive(sm.get(path))); };
        sub(path, sync); sync(); return sync;
      }
      function bindStyle(btn, path, apply) {
        const sync = () => { if (btn) apply(btn, sm.get(path)); };
        sub(path, sync); sync(); return sync;
      }
      function bindRateButtonActive(b, speed, sm, sub, P) {
        const sync = () => {
          const isEn = !!sm.get(P.PB_EN);
          const v = Number(sm.get(P.PB_RATE) || 1);
          b.classList.toggle('active', isEn && Math.abs(v - speed) < 0.01);
        };
        sub(P.PB_RATE, sync); sub(P.PB_EN, sync); sync();
      }
      function renderPresetRow({ items, key, offValue = null, toggleActiveToOff = false }) {
        const row = h('div', { class: 'row' });
        const addBtn = (text, value) => {
          const b = h('button', { class: 'preset-btn' }, text);
          b.onclick = () => {
            const cur = sm.get(key);
            if (toggleActiveToOff && offValue !== undefined && cur === value && value !== offValue) {
              setAndHint(key, offValue);
            } else {
              setAndHint(key, value);
            }
          };
          bindClassToggle(b, key, v => v === value);
          row.append(b);
        };
        for (const it of items) addBtn(it.text, it.value);
        if (offValue !== undefined && offValue !== null && !items.some(it => it.value === offValue)) {
          const off = h('button', { class: 'preset-btn', style: 'flex:0.7' }, 'OFF');
          off.onclick = () => setAndHint(key, offValue);
          bindClassToggle(off, key, v => v === offValue);
          row.append(off);
        }
        return row;
      }
      function renderShadowBandMaskRow({ key = P.V_SHADOW_MASK }) {
        const row = h('div', { class: 'row' });
        const items = [
          { text: '외암', bit: SHADOW_BAND.OUTER, title: '옅은 암부 진하게' },
          { text: '중암', bit: SHADOW_BAND.MID, title: '가운데 암부 진하게' },
          { text: '심암', bit: SHADOW_BAND.DEEP, title: '가장 진한 블랙' }
        ];
        for (const it of items) {
          const b = h('button', { class: 'preset-btn', title: it.title }, it.text);
          b.onclick = () => { sm.set(key, ShadowMask.toggle(sm.get(key), it.bit)); ApplyReq.hard(); };
          bindClassToggle(b, key, v => ShadowMask.has(v, it.bit));
          row.append(b);
        }
        const off = h('button', { class: 'preset-btn', style: 'flex:0.7' }, 'OFF');
        off.onclick = () => { sm.set(key, 0); ApplyReq.hard(); };
        bindClassToggle(off, key, v => (Number(v) | 0) === 0);
        row.append(off);
        return row;
      }

      function sectionLabel(iconName, text) {
        const label = h('div', { class: 'section-label' });
        if (iconName) {
          const icon = svgIcon(iconName);
          icon.style.cssText = 'display:inline-flex;vertical-align:middle;margin-right:4px;opacity:0.6;';
          icon.querySelector('svg')?.setAttribute('width', '12');
          icon.querySelector('svg')?.setAttribute('height', '12');
          label.append(icon);
        }
        label.append(document.createTextNode(text));
        return label;
      }

      // v191: 기어/패널 겹침 방지 상수
      const GEAR_WIDTH = 44;
      const GEAR_RIGHT = 12;
      const PANEL_GAP = 12;
      const PANEL_RIGHT = GEAR_RIGHT + GEAR_WIDTH + PANEL_GAP; // 68px

      const build = () => {
        if (container) return;
        const host = h('div', { id: 'vsc-host', 'data-vsc-ui': '1' });
        const shadow = host.attachShadow({ mode: 'open' });

        // v191: 패널 right 값을 동적 계산값(68px)으로 변경
        const style = `:host{all:initial}*{box-sizing:border-box}.panel{position:fixed;top:50%;right:${PANEL_RIGHT}px;transform:translateY(-50%);width:min(320px, calc(100vw - 40px));background:rgba(18,18,22,0.97);backdrop-filter:blur(16px) saturate(180%);color:#e8e8ec;padding:0;border-radius:14px;z-index:2147483647;border:1px solid rgba(255,255,255,0.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(255,255,255,0.05) inset;overflow:hidden;max-height:90vh;display:flex;flex-direction:column}@media(min-width:1200px){.panel{width:340px}}.header{padding:14px 16px 12px;cursor:move;user-select:none;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;justify-content:space-between;gap:8px;background:linear-gradient(180deg, rgba(255,255,255,0.03) 0%, transparent 100%)}.header:active{cursor:grabbing;background:rgba(255,255,255,0.04)}.header-title{font-size:13px;font-weight:700;letter-spacing:0.5px;color:rgba(255,255,255,0.9)}.header-info{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500;font-variant-numeric:tabular-nums;flex:1;text-align:center}.header-ver{font-size:10px;color:rgba(255,255,255,0.3);font-weight:500}.tab-bar{display:flex;border-bottom:1px solid rgba(255,255,255,0.06);padding:0 8px}.tab{flex:1;padding:8px 4px 6px;text-align:center;cursor:pointer;border-bottom:2px solid transparent;font-size:10px;font-weight:600;color:rgba(255,255,255,0.4);transition:all 0.15s;user-select:none;display:flex;flex-direction:column;align-items:center;gap:2px}.tab:hover{color:rgba(255,255,255,0.6);background:rgba(255,255,255,0.03);border-radius:6px 6px 0 0}.tab.active{color:#60a5fa;border-bottom-color:#3b82f6;background:rgba(59,130,246,0.06);border-radius:6px 6px 0 0}.tab-icon{display:flex;align-items:center;justify-content:center;width:20px;height:20px}.tab-icon svg{width:18px;height:18px;display:block}.tab-content{display:none;padding:10px 12px;overflow-y:auto;flex:1}.tab-content.active{display:block}.tab-content[data-tab="video"] .section{border-left:2px solid rgba(96,165,250,0.3)}.tab-content[data-tab="audio"] .section{border-left:2px solid rgba(251,191,36,0.3)}.tab-content[data-tab="speed"] .section{border-left:2px solid rgba(74,222,128,0.3)}.tab-content[data-tab="tools"] .section{border-left:2px solid rgba(167,139,250,0.3)}.drag-indicator{display:none;width:36px;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;margin:8px auto 4px}.section{margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.04)}.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,0.35);margin-bottom:8px}.row{display:flex;gap:4px;margin-bottom:4px;align-items:center}.row:last-child{margin-bottom:0}.btn{flex:1;height:36px;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.82);cursor:pointer;font-size:12px;font-weight:600;transition:all 0.12s ease;display:flex;align-items:center;justify-content:center;gap:4px}.btn:hover{background:rgba(255,255,255,0.12)}.btn:active{transform:scale(0.97)}.btn.active{background:rgba(59,130,246,0.25);border-color:rgba(59,130,246,0.5);color:#60a5fa}.btn.danger{color:#f87171;border-color:rgba(248,113,113,0.3)}.btn.danger:hover{background:rgba(248,113,113,0.15)}.btn.success{color:#4ade80;border-color:rgba(74,222,128,0.3)}.btn-sm{height:30px;font-size:11px}.preset-btn{flex:1;height:32px;border:1px solid rgba(255,255,255,0.08);border-radius:6px;background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.65);cursor:pointer;font-size:11px;font-weight:700;transition:all 0.12s ease}.preset-btn:hover{background:rgba(255,255,255,0.10)}.preset-btn.active{background:rgba(245,158,11,0.20);border-color:rgba(245,158,11,0.5);color:#fbbf24;position:relative}.preset-btn.active::after{content:'✓';position:absolute;top:2px;right:4px;font-size:8px;opacity:0.7}.speed-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}.divider{height:1px;background:rgba(255,255,255,0.04);margin:6px 0}.footer{padding:8px 12px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:4px}.icon{font-size:14px;line-height:1;display:inline-flex;align-items:center}.icon svg{display:block}input[type=range]{-webkit-appearance:none;width:100%;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;outline:none;cursor:pointer}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}input[type=range]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#60a5fa;cursor:pointer;border:2px solid rgba(255,255,255,0.2)}.speed-display{flex:1;text-align:center;font-size:16px;font-weight:800;color:#e8e8ec;line-height:30px;font-variant-numeric:tabular-nums;background:rgba(255,255,255,0.04);border-radius:8px;padding:2px 0;transition:color 0.15s}.speed-display.modified{color:#4ade80}.custom-speed-input{flex:1;height:28px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:6px;color:#e8e8ec;padding:0 8px;font-size:12px;font-weight:600;text-align:center;outline:none;font-variant-numeric:tabular-nums;-moz-appearance:textfield}.custom-speed-input::-webkit-inner-spin-button,.custom-speed-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}@media(max-width:480px){.panel{position:fixed!important;top:auto!important;bottom:0!important;left:0!important;right:auto!important;width:100%!important;max-height:75vh!important;border-radius:16px 16px 0 0!important;transform:none!important;transition:transform 0.3s cubic-bezier(0.32,0.72,0,1)!important;padding-bottom:env(safe-area-inset-bottom,0)!important}.drag-indicator{display:block}.tab{font-size:11px;padding:10px 4px 8px}.btn{height:40px}.preset-btn{height:36px;font-size:12px}.footer{padding:10px 12px}}`;
        applyShadowStyle(shadow, style, h);

        const videoInfo = h('span', { class: 'header-info' });
        let infoTimer = 0;
        function updateVideoInfo() {
          const v = window.__VSC_APP__?.getActiveVideo();
          if (!v || !container?.isConnected) { videoInfo.textContent = ''; return; }
          const w = v.videoWidth, ht = v.videoHeight;
          const mode = __liteForced ? 'LITE' : 'FULL';
          videoInfo.textContent = `${w}\u00D7${ht} \u00B7 ${mode}`;
        }
        sub(P.APP_UI, (visible) => {
          if (infoTimer) { clearInterval(infoTimer); infoTimer = 0; }
          if (visible) {
            updateVideoInfo();
            infoTimer = setInterval(() => {
              if (!sm.get(P.APP_UI)) { clearInterval(infoTimer); infoTimer = 0; return; }
              updateVideoInfo();
            }, 2000);
          }
        });

        const dragIndicator = h('div', { class: 'drag-indicator' });
        const dragHandle = h('div', { class: 'header' },
          h('span', { class: 'header-title' }, 'Video Control'),
          videoInfo,
          h('span', { class: 'header-ver' }, 'v' + VSC_VERSION));

        const TABS = [
          { id: 'video', icon: 'palette', label: '비디오' },
          { id: 'audio', icon: 'speaker', label: '오디오' },
          { id: 'speed', icon: 'zap', label: '속도' },
          { id: 'tools', icon: 'monitor', label: '도구' },
        ];
        const tabBar = h('div', { class: 'tab-bar' });
        let activeTabId = 'video';
        const tabBtns = {};
        const tabContents = {};

        for (const tab of TABS) {
          const iconEl = svgIcon(tab.icon);
          iconEl.classList.add('tab-icon');
          const btn = h('div', { class: `tab${tab.id === activeTabId ? ' active' : ''}` }, iconEl, tab.label);
          btn.addEventListener('click', () => {
            if (activeTabId === tab.id) return;
            tabBtns[activeTabId]?.classList.remove('active');
            tabContents[activeTabId]?.classList.remove('active');
            activeTabId = tab.id;
            btn.classList.add('active');
            tabContents[tab.id]?.classList.add('active');
          });
          tabBtns[tab.id] = btn;
          tabBar.append(btn);
        }

        const advToggleBtn = h('button', { class: 'btn btn-sm', style: 'width:100%;margin-top:6px;color:rgba(255,255,255,0.5);' });
        advToggleBtn.onclick = () => setAndHint(P.APP_ADV, !sm.get(P.APP_ADV));
        bindStyle(advToggleBtn, P.APP_ADV, (el, v) => { el.textContent = v ? '▲ 고급 설정 닫기' : '▼ 고급 설정'; });

        const advContainer = h('div', { style: 'display:none;' },
          h('div', { class: 'section', style: 'margin-top:8px' },
            sectionLabel(null, '블랙 밴드'),
            renderShadowBandMaskRow({ key: P.V_SHADOW_MASK }),
            h('div', { class: 'divider' }),
            sectionLabel(null, '밝기 복구'),
            renderPresetRow({ key: P.V_BRIGHT_STEP, offValue: 0, toggleActiveToOff: true, items: [{ text: '1단', value: 1 }, { text: '2단', value: 2 }, { text: '3단', value: 3 }] }),
            h('div', { class: 'divider' }),
            sectionLabel(null, '밝기 등급'),
            renderPresetRow({ key: P.V_PRE_B, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.grade).filter(k => k !== 'off').map(k => ({ text: PRESET_LABELS.grade[k] || k, value: k })) })
          )
        );
        bindStyle(advContainer, P.APP_ADV, (el, v) => { el.style.display = v ? 'block' : 'none'; });

        const videoSection = h('div', {},
          h('div', { class: 'section' },
            sectionLabel('palette', '비디오 효과'),
            renderPresetRow({ key: P.V_PRE_S, offValue: 'off', toggleActiveToOff: true, items: Object.keys(PRESETS.detail).filter(k => k !== 'off').map(k => ({ text: PRESET_LABELS.detail[k] || k, value: k })) }),
            h('div', { class: 'row', style: 'margin-top:6px' },
              (() => { const autoBtn = h('button', { class: 'btn' }); autoBtn.append(svgIcon('sparkles'), document.createTextNode(' Auto Scene')); autoBtn.onclick = () => setAndHint(P.APP_AUTO_SCENE, !sm.get(P.APP_AUTO_SCENE)); bindClassToggle(autoBtn, P.APP_AUTO_SCENE, v => !!v); return autoBtn; })(),
              (() => { const apBtn = h('button', { class: 'btn' }); apBtn.append(svgIcon('wand'), document.createTextNode(' 자동')); apBtn.addEventListener('click', (e) => { e.stopPropagation(); setAndHint(P.APP_AUTO_PRESET, !sm.get(P.APP_AUTO_PRESET)); }); bindClassToggle(apBtn, P.APP_AUTO_PRESET, v => !!v); return apBtn; })()
            )
          ),
          advToggleBtn,
          advContainer
        );

        const audioSection = h('div', {},
          h('div', { class: 'section' },
            sectionLabel('speaker', '오디오'),
            h('div', { class: 'row' },
              (() => { const boostBtn = h('button', { class: 'btn' }); boostBtn.append(svgIcon('speaker'), document.createTextNode(' Brickwall')); boostBtn.onclick = () => setAndHint(P.A_EN, !sm.get(P.A_EN)); bindClassToggle(boostBtn, P.A_EN, v => !!v); return boostBtn; })()
            ),
            h('div', { class: 'row', style: 'gap:8px;margin-top:6px' },
              h('span', { style: 'font-size:10px;color:rgba(255,255,255,0.4);min-width:24px' }, '0dB'),
              (() => {
                const slider = h('input', { type: 'range', min: '0', max: '12', step: '0.5', style: 'flex:1' });
                slider.value = sm.get(P.A_BST) || 6;
                const label = h('span', { style: 'font-size:11px;font-weight:700;color:rgba(255,255,255,0.7);min-width:36px;text-align:right;font-variant-numeric:tabular-nums' }, `${Number(slider.value).toFixed(1)}dB`);
                slider.addEventListener('input', () => { const val = parseFloat(slider.value); sm.set(P.A_BST, val); label.textContent = `${val.toFixed(1)}dB`; ApplyReq.soft(); });
                sm.sub(P.A_BST, (v) => { slider.value = v; label.textContent = `${Number(v).toFixed(1)}dB`; });
                return [slider, label];
              })().flat()
            )
          )
        );

        const speedSection = h('div', {},
          h('div', { class: 'section' },
            sectionLabel('zap', '재생 속도'),
            h('div', { class: 'speed-grid' },
              ...[0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map(s => { const b = h('button', { class: 'preset-btn' }, s + 'x'); b.onclick = () => { setAndHint(P.PB_RATE, s); setAndHint(P.PB_EN, true); }; bindRateButtonActive(b, s, sm, sub, P); return b; })
            ),
            h('div', { class: 'row', style: 'margin-top:6px' },
              (() => { const minusBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.8' }, '\u22120.1'); minusBtn.onclick = () => { const cur = Number(sm.get(P.PB_RATE) || 1); const next = Math.round(VSC_CLAMP(cur - 0.1, 0.1, 16) * 10) / 10; setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }; return minusBtn; })(),
              (() => {
                const display = h('span', { class: 'speed-display' });
                const sync = () => {
                  const rate = sm.get(P.PB_EN) ? Number(sm.get(P.PB_RATE) || 1) : 1;
                  display.textContent = rate.toFixed(1) + 'x';
                  display.classList.toggle('modified', Math.abs(rate - 1.0) > 0.01);
                };
                sub(P.PB_RATE, sync); sub(P.PB_EN, sync); sync(); return display;
              })(),
              (() => { const plusBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.8' }, '+0.1'); plusBtn.onclick = () => { const cur = Number(sm.get(P.PB_RATE) || 1); const next = Math.round(VSC_CLAMP(cur + 0.1, 0.1, 16) * 10) / 10; setAndHint(P.PB_RATE, next); setAndHint(P.PB_EN, true); }; return plusBtn; })(),
              (() => { const resetBtn = h('button', { class: 'btn btn-sm', style: 'flex:0.7' }, '1x'); resetBtn.onclick = () => { setAndHint(P.PB_RATE, 1.0); setAndHint(P.PB_EN, false); }; return resetBtn; })()
            ),
            h('div', { class: 'row', style: 'margin-top:6px;align-items:center;gap:6px' },
              h('span', { style: 'font-size:10px;color:rgba(255,255,255,0.4)' }, '직접입력:'),
              (() => {
                const input = h('input', { type: 'number', min: '0.1', max: '16', step: '0.05', class: 'custom-speed-input' });
                input.value = sm.get(P.PB_RATE) || 1;
                input.addEventListener('change', () => {
                  const val = VSC_CLAMP(parseFloat(input.value) || 1, 0.1, 16);
                  input.value = val;
                  setAndHint(P.PB_RATE, val);
                  setAndHint(P.PB_EN, true);
                });
                input.addEventListener('keydown', (e) => e.stopPropagation());
                sm.sub(P.PB_RATE, (v) => { input.value = Number(v).toFixed(2); });
                return input;
              })()
            )
          )
        );

        const toolsSection = h('div', {},
          h('div', { class: 'section' },
            sectionLabel('monitor', '도구'),
            h('div', { class: 'row' },
              h('button', { class: 'btn', onclick: async () => { const v = window.__VSC_APP__?.getActiveVideo(); if (v) await togglePiPFor(v); } }, svgIcon('pip'), ' PiP'),
              (() => {
                const zoomBtn = h('button', { class: 'btn' });
                zoomBtn.append(svgIcon('zoom'), document.createTextNode(' 줌'));
                zoomBtn.onclick = () => {
                  const zm = window.__VSC_INTERNAL__?.ZoomManager;
                  const v = window.__VSC_APP__?.getActiveVideo?.();
                  if (zm && v) {
                    if (zm.isZoomed(v)) {
                      zm.resetZoom(v);
                      sm.set(P.APP_ZOOM_EN, false);
                    } else {
                      const rect = v.getBoundingClientRect();
                      zm.zoomTo(v, 2.5, rect.left + rect.width * 0.5, rect.top + rect.height * 0.5);
                      sm.set(P.APP_ZOOM_EN, true);
                    }
                    ApplyReq.soft();
                  } else {
                    setAndHint(P.APP_ZOOM_EN, !sm.get(P.APP_ZOOM_EN));
                  }
                };
                bindClassToggle(zoomBtn, P.APP_ZOOM_EN, v => !!v);
                return zoomBtn;
              })()
            ),
            h('div', { class: 'row', style: 'margin-top:4px' },
              h('button', { class: 'btn', onclick: () => { const v = window.__VSC_APP__?.getActiveVideo(); if (v) captureVideoFrame(v); } }, svgIcon('camera'), ' 캡처')
            ),
            h('div', { class: 'divider' }),
            sectionLabel(null, '설정 관리'),
            h('div', { class: 'row' },
              h('button', { class: 'btn btn-sm', onclick: () => {
                try {
                  const data = window.__VSC_INTERNAL__?._buildSaveData?.();
                  if (!data) { showOSD('내보내기 실패', 1500); return; }
                  data._version = VSC_VERSION;
                  data._exportedAt = new Date().toISOString();
                  data._hostname = location.hostname;
                  const json = JSON.stringify(data, null, 2);
                  const blob = new Blob([json], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url; a.download = `vsc-settings-${location.hostname}-${Date.now()}.json`; a.click();
                  setTimer(() => URL.revokeObjectURL(url), 5000);
                  showOSD('설정 내보내기 완료', 1500);
                } catch (_) { showOSD('내보내기 실패', 1500); }
              } }, svgIcon('download'), ' 내보내기'),
              h('button', { class: 'btn btn-sm', onclick: () => {
                try {
                  const input = document.createElement('input');
                  input.type = 'file'; input.accept = '.json';
                  input.onchange = () => {
                    const file = input.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = () => {
                      try {
                        const data = JSON.parse(reader.result);
                        if (!data || typeof data !== 'object') { showOSD('잘못된 설정 파일', 2000); return; }
                        window.__VSC_INTERNAL__?._applyDataToStore?.(data);
                        ApplyReq.hard();
                        showOSD('설정 가져오기 완료', 1500);
                      } catch (_) { showOSD('설정 파일 파싱 실패', 2000); }
                    };
                    reader.readAsText(file);
                  };
                  input.click();
                } catch (_) { showOSD('가져오기 실패', 1500); }
              } }, svgIcon('upload'), ' 가져오기')
            )
          )
        );

        tabContents.video = h('div', { class: `tab-content${activeTabId === 'video' ? ' active' : ''}`, 'data-tab': 'video' }, videoSection);
        tabContents.audio = h('div', { class: `tab-content${activeTabId === 'audio' ? ' active' : ''}`, 'data-tab': 'audio' }, audioSection);
        tabContents.speed = h('div', { class: `tab-content${activeTabId === 'speed' ? ' active' : ''}`, 'data-tab': 'speed' }, speedSection);
        tabContents.tools = h('div', { class: `tab-content${activeTabId === 'tools' ? ' active' : ''}`, 'data-tab': 'tools' }, toolsSection);

        const contentArea = h('div', { style: 'flex:1;overflow-y:auto;' });
        for (const [id, el] of Object.entries(tabContents)) contentArea.append(el);

        const footer = h('div', { class: 'footer' },
          h('button', { class: 'btn btn-sm', onclick: () => sm.set(P.APP_UI, false) }, '\u2715 닫기'),
          (() => { const pwrBtn = h('button', { class: 'btn btn-sm' }); pwrBtn.onclick = () => setAndHint(P.APP_ACT, !sm.get(P.APP_ACT)); bindStyle(pwrBtn, P.APP_ACT, (el, v) => { el.className = 'btn btn-sm ' + (v ? 'success' : 'danger'); el.innerHTML = ''; el.append(svgIcon('zap'), document.createTextNode(v ? ' ON' : ' OFF')); }); return pwrBtn; })(),
          (() => {
            let confirmState = false; let confirmTimer = null;
            const resetBtn = h('button', { class: 'btn btn-sm' }, '\u21BA 리셋');
            resetBtn.onclick = () => {
              if (!confirmState) {
                confirmState = true; resetBtn.textContent = '⚠ 확인?'; resetBtn.classList.add('danger');
                confirmTimer = setTimeout(() => { confirmState = false; resetBtn.textContent = '\u21BA 리셋'; resetBtn.classList.remove('danger'); }, 2000);
              } else {
                clearTimeout(confirmTimer); confirmState = false; resetBtn.textContent = '\u21BA 리셋'; resetBtn.classList.remove('danger');
                sm.batch('video', DEFAULTS.video); sm.batch('audio', DEFAULTS.audio); sm.batch('playback', DEFAULTS.playback); sm.set(P.APP_AUTO_SCENE, false); sm.set(P.APP_AUTO_PRESET, false); ApplyReq.hard(); showOSD('설정 초기화됨', 1200);
              }
            };
            return resetBtn;
          })()
        );

        const mainPanel = h('div', { class: 'panel' }, dragIndicator, dragHandle, tabBar, contentArea, footer);
        blockInterference(mainPanel);

        if (CONFIG.IS_MOBILE) {
          let sheetStartY = 0, sheetDragging = false, lastTouchY = 0, velocity = 0, lastTouchTime = 0;
          dragIndicator.addEventListener('touchstart', (e) => { sheetStartY = e.touches[0].clientY; lastTouchY = sheetStartY; lastTouchTime = performance.now(); velocity = 0; sheetDragging = true; mainPanel.style.transition = 'none'; }, { passive: true });
          window.addEventListener('touchmove', (e) => {
            if (!sheetDragging) return;
            const currentY = e.touches[0].clientY;
            const dy = currentY - sheetStartY;
            const now = performance.now();
            if (lastTouchTime > 0) {
              const dt = Math.max(1, now - lastTouchTime);
              velocity = (currentY - lastTouchY) / dt;
            }
            lastTouchY = currentY;
            lastTouchTime = now;
            if (dy > 0) mainPanel.style.transform = `translateY(${dy}px)`;
          }, { passive: true, signal: __globalSig });
          window.addEventListener('touchend', () => {
            if (!sheetDragging) return;
            sheetDragging = false;
            mainPanel.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
            const current = parseFloat(mainPanel.style.transform.replace(/[^0-9.\-]/g, '')) || 0;
            const panelHeight = mainPanel.getBoundingClientRect().height;
            const dismissed = current > panelHeight * 0.35 || velocity > 0.5;
            if (dismissed) {
              mainPanel.style.transform = `translateY(${panelHeight}px)`;
              setTimeout(() => { sm.set(P.APP_UI, false); mainPanel.style.transform = ''; }, 300);
            } else {
              mainPanel.style.transform = 'translateY(0)';
            }
            velocity = 0; lastTouchTime = 0;
          }, { passive: true, signal: __globalSig });
        }

        shadow.append(mainPanel);
        let stopDrag = null;
        dragHandle.addEventListener('mousedown', (e) => {
          e.preventDefault(); stopDrag?.();
          let startX = e.clientX, startY = e.clientY;
          const rect = mainPanel.getBoundingClientRect();
          mainPanel.style.transform = 'none';
          mainPanel.style.top = `${rect.top}px`;
          mainPanel.style.right = 'auto';
          mainPanel.style.left = `${rect.left}px`;
          stopDrag = bindWindowDrag((ev) => {
            const panelRect = mainPanel.getBoundingClientRect();
            let nextLeft = Math.max(0, Math.min(window.innerWidth - panelRect.width, rect.left + (ev.clientX - startX)));
            let nextTop = Math.max(0, Math.min(window.innerHeight - panelRect.height, rect.top + (ev.clientY - startY)));
            mainPanel.style.left = `${nextLeft}px`;
            mainPanel.style.top = `${nextTop}px`;
          }, () => { stopDrag = null; });
        });
        container = host;
        getUiRoot().appendChild(container);
      };

      // v191: 기어 아이콘 — 패널 열릴 때 숨김 처리로 겹침 완전 방지
      const ensureGear = () => {
        if (!allowUiInThisDoc()) return;
        if (gearHost) return;
        gearHost = h('div', { id: 'vsc-gear-host', 'data-vsc-ui': '1', style: 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;' });
        const shadow = gearHost.attachShadow({ mode: 'open' });
        // v191: 기어 right 값을 상수로 통일, 패널 열림시 transition 추가
        const style = `.gear{position:fixed;top:50%;right:${GEAR_RIGHT}px;transform:translateY(-50%);width:${GEAR_WIDTH}px;height:${GEAR_WIDTH}px;border-radius:12px;background:rgba(18,18,22,0.92);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.10);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.4);user-select:none;transition:all 0.2s ease;-webkit-tap-highlight-color:transparent}@media(hover:hover) and (pointer:fine){.gear:hover{transform:translateY(-50%) scale(1.05);background:rgba(30,30,38,0.95)}}.gear:active{transform:translateY(-50%) scale(0.95)}.gear.open{border-color:rgba(59,130,246,0.5);box-shadow:0 0 0 2px rgba(59,130,246,0.2),0 8px 32px rgba(0,0,0,0.4)}.gear.inactive{opacity:0.35}.gear.panel-open{opacity:0!important;pointer-events:none!important;transform:translateY(-50%) scale(0.8)!important}.status-badge{position:absolute;top:4px;right:4px;min-width:14px;height:14px;border-radius:7px;background:#3b82f6;color:#fff;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 3px;transition:all 0.15s}.gear.inactive .status-badge{background:#f87171}.status-badge:empty{width:6px;height:6px;min-width:6px;padding:0;border-radius:50%}.hint{position:fixed;right:70px;top:50%;transform:translateY(-50%);padding:6px 10px;border-radius:8px;background:rgba(18,18,22,0.92);border:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);font:600 11px/1.2 sans-serif;white-space:nowrap;z-index:2147483647;opacity:0;transition:opacity 0.15s,transform 0.15s;pointer-events:none}.gear:hover+.hint{opacity:1}.gear.panel-open+.hint{opacity:0!important}${CONFIG.IS_MOBILE ? '.hint{display:none!important;}' : ''}@media(max-width:480px){.gear{right:8px!important;bottom:16px!important;top:auto!important;transform:none!important}.gear.panel-open{opacity:0!important;pointer-events:none!important;transform:scale(0.8)!important}}`;
        applyShadowStyle(shadow, style, h);
        let dragThresholdMet = false, stopDrag = null;
        gearBtn = h('button', { class: 'gear', onclick: (e) => {
          if (dragThresholdMet) { e.preventDefault(); e.stopPropagation(); return; }
          setAndHint(P.APP_UI, !sm.get(P.APP_UI));
        } });
        gearBtn.innerHTML = VSC_ICONS.gear;
        const statusBadge = h('div', { class: 'status-badge' });
        gearBtn.append(statusBadge);
        blockInterference(gearBtn);
        shadow.append(gearBtn, h('div', { class: 'hint' }, 'Alt+Shift+V'));
        const wake = () => {
          if (gearBtn) gearBtn.style.opacity = '1';
          clearTimeout(fadeTimer);
          fadeTimer = setTimeout(() => {
            if (gearBtn && !gearBtn.classList.contains('open') && !gearBtn.classList.contains('panel-open') && !gearBtn.matches(':hover')) gearBtn.style.opacity = '0.4';
          }, 3500);
        };
        window.addEventListener('mousemove', wake, { passive: true, signal: uiWakeCtrl.signal });
        window.addEventListener('touchstart', wake, { passive: true, signal: uiWakeCtrl.signal });
        bootWakeTimer = setTimeout(wake, 2000);
        const handleGearDrag = (e) => {
          if (e.target !== gearBtn) return;
          dragThresholdMet = false; stopDrag?.();
          const startY = e.type.includes('touch') ? e.touches[0].clientY : e.clientY;
          const rect = gearBtn.getBoundingClientRect();
          stopDrag = bindWindowDrag((ev) => {
            const currentY = ev.type.includes('touch') ? ev.touches[0].clientY : ev.clientY;
            if (Math.abs(currentY - startY) > 10) {
              if (!dragThresholdMet) { dragThresholdMet = true; gearBtn.style.transition = 'none'; gearBtn.style.transform = 'none'; gearBtn.style.top = `${rect.top}px`; }
              if (ev.cancelable) ev.preventDefault();
            }
            if (dragThresholdMet) {
              let newTop = rect.top + (currentY - startY);
              newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));
              gearBtn.style.top = `${newTop}px`;
            }
          }, () => { gearBtn.style.transition = ''; setTimeout(() => { dragThresholdMet = false; stopDrag = null; }, 100); });
        };
        gearBtn.addEventListener('mousedown', handleGearDrag);
        gearBtn.addEventListener('touchstart', handleGearDrag, { passive: false });
        const syncGearTitle = () => {
          if (!gearBtn) return;
          let count = 0;
          const parts = [];
          if (sm.get(P.APP_ACT)) {
            const ps = sm.get(P.V_PRE_S);
            if (ps !== 'off') { parts.push('샤프: ' + (PRESET_LABELS.detail[ps] || ps)); count++; }
            if (sm.get(P.A_EN)) { parts.push('오디오 부스트'); count++; }
            if (sm.get(P.PB_EN)) {
              parts.push(Number(sm.get(P.PB_RATE)).toFixed(1) + 'x');
              if (Number(sm.get(P.PB_RATE)) !== 1) count++;
            }
            if (sm.get(P.APP_AUTO_SCENE)) { parts.push('Auto'); count++; }
            if (sm.get(P.APP_AUTO_PRESET)) { parts.push('자동프리셋'); }
            if ((Number(sm.get(P.V_SHADOW_MASK)) | 0) > 0) count++;
            if ((Number(sm.get(P.V_BRIGHT_STEP)) | 0) > 0) count++;
            if (sm.get(P.V_PRE_B) !== 'off') count++;
          }
          statusBadge.textContent = count > 0 ? String(count) : '';
          gearBtn.title = parts.length ? parts.join(' \u00B7 ') : (sm.get(P.APP_ACT) ? '설정 없음' : 'OFF');
        };
        sub(P.APP_ACT, syncGearTitle); sub(P.V_PRE_S, syncGearTitle); sub(P.V_PRE_B, syncGearTitle); sub(P.A_EN, syncGearTitle); sub(P.PB_EN, syncGearTitle); sub(P.PB_RATE, syncGearTitle); sub(P.APP_AUTO_SCENE, syncGearTitle); sub(P.APP_AUTO_PRESET, syncGearTitle); sub(P.V_SHADOW_MASK, syncGearTitle); sub(P.V_BRIGHT_STEP, syncGearTitle);
        syncGearTitle();
        // v191: syncGear — 패널 열림시 기어에 .panel-open 클래스 부여
        const syncGear = () => {
          if (!gearBtn) return;
          const showHere = allowUiInThisDoc();
          const uiOpen = !!sm.get(P.APP_UI);
          gearBtn.classList.toggle('open', uiOpen);
          gearBtn.classList.toggle('panel-open', uiOpen);
          gearBtn.classList.toggle('inactive', !sm.get(P.APP_ACT));
          gearBtn.style.display = showHere ? 'flex' : 'none';
          if (!showHere) detachNodesHard();
          else if (!uiOpen) wake();
        };
        sub(P.APP_ACT, syncGear); sub(P.APP_UI, syncGear); syncGear();
      };
      const mount = () => {
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        const root = getUiRoot();
        if (!root) return;
        try { if (gearHost && gearHost.parentNode !== root) root.appendChild(gearHost); } catch (_) {}
        try { if (container && container.parentNode !== root) root.appendChild(container); } catch (_) {}
      };
      const ensure = () => {
        if (!allowUiInThisDoc()) { detachNodesHard(); return; }
        ensureGear();
        if (sm.get(P.APP_UI)) { build(); if (container) container.style.display = 'block'; }
        else { if (container) container.style.display = 'none'; }
        mount();
      };

      if (!document.body) {
        document.addEventListener('DOMContentLoaded', () => { try { ensure(); ApplyReq.hard(); } catch (_) {} }, { once: true, signal: __globalSig });
      }
      if (CONFIG.DEBUG) window.__VSC_UI_Ensure = ensure;

      return {
        ensure,
        destroy: () => { try { uiWakeCtrl.abort(); } catch {} clearTimeout(fadeTimer); clearTimeout(bootWakeTimer); bag.flush(); detachNodesHard(); }
      };
    }

    // ─── END OF PART 4 ───
    // PART 5 continues with: markInternalRateChange, restoreRateOne, bindVideoOnce,
    // clearVideoRuntimeState, applyPlaybackRate, reconcileVideoEffects,
    // createBackendAdapter, createApplyLoop, persistence (save/load),
    // setupKeyboard, setupOsdNotifications, setupMediaSession, setupGmMenus,
    // setupUserTracking, setupMaintenance, setupSpaWatcher, setupAutoPresetWatcher,
    // bootstrap, and the outer IIFE closing
// ═══════════════════════════════════════════════════════════
//  PART 5 — v191.0.0
//  markInternalRateChange → bootstrap → VSC_MAIN 종료
//  이전 PART 4의 createUI return { ensure, destroy } 직후부터 이어짐
// ═══════════════════════════════════════════════════════════

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
      const toDelete = [];
      for (const v of TOUCHED.videos) {
        if (!v || !v.isConnected) toDelete.push(v);
      }
      for (const v of toDelete) {
        TOUCHED.videos.delete(v);
        try { window.__VSC_INTERNAL__?.Adapter?.clear(v); } catch (_) {}
      }

      toDelete.length = 0;
      for (const v of TOUCHED.rateVideos) {
        if (!v || !v.isConnected) toDelete.push(v);
      }
      for (const v of toDelete) {
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

    // v191: queueMicrotask 제거 — double-bind race 방지
    function clearVideoRuntimeState(el, Adapter, ApplyReq) {
      const st = getVState(el);
      if (st._ac) { try { st._ac.abort(); } catch (_) {} st._ac = null; }
      Adapter.clear(el);
      TOUCHED.videos.delete(el);
      st.desiredRate = undefined;
      restoreRateOne(el);
      TOUCHED.rateVideos.delete(el);
      st.bound = false;
      // v191: 제거 — queueMicrotask 내에서 bindVideoOnce 를 호출하면
      //       다음 applyLoop 사이클에서 이미 rebind 처리되므로 불필요하며
      //       race condition (double-bind) 유발 가능
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

        bindVideoOnce(el, ApplyReq);
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

        if (rSt._rateRetryCount > 5) {
          rSt.permanentlyBlocked = true;
          showOSD('속도 조절이 차단됨 (충돌 방지)', 2000);
          return;
        }

        rSt._externalMtQueued = true;

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
        }, 16);
      }, { passive: true, signal: sig });
    }

    function createApplyLoop(Store, Registry, Targeting, Adapter, Audio, AutoScene, ZoomMgr, ApplyReq, UI) {
      const paramsMemo = createVideoParamsMemo(Store, P, createUtils());
      const lightSigChanged = createLightSigTracker();
      const __applySet = new Set();

      let __activeTarget = null;
      let __lastAudioTarget = null;
      let __lastAudioWant = null;
      let __lastAutoPresetHeight = 0;
      let lastSRev = -1, lastRRev = -1, lastUserSigRev = -1, lastPrune = 0;

      const audioUpdateThrottled = (() => {
        let last = 0, timer = 0;
        return () => {
          const now = performance.now();
          if (now - last >= 120) { last = now; Audio.update(); return; }
          if (!timer) { timer = setTimeout(() => { timer = 0; last = performance.now(); Audio.update(); }, 120); }
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

          if (!__uiVideoKicked && Registry.videos.size > 0) {
            __uiVideoKicked = true;
            try { UI.ensure(); } catch (_) {}
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

          // v191: early-return 전 cleanup 보장
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

    // v191: store load → normalize 순서 보정
    //       loadFromDisk 이후 normalizeBySchema 가 bootstrap 에서 호출되므로
    //       여기서는 raw apply 만 수행
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
              const mode = __liteForced ? 'LITE' : 'FULL';
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
        tickTimer = setInterval(() => {
          if (!Store.get(P.APP_ACT)) return;
          if (document.hidden) return;
          Scheduler.request(false);
        }, 12000);
      };
      const stopTick = () => {
        if (!tickTimer) return;
        clearInterval(tickTimer);
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
          Registry.refreshObservers();
          Registry.rescanAll();
          Scheduler.request(true);
          try { ZoomMgr?.pruneDisconnected(); } catch (_) {}
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
        const v = window.__VSC_APP__?.getActiveVideo?.();
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
    //  Bootstrap — 모든 모듈 조립 및 시작
    // ═══════════════════════════════════════════════════════════

    function bootstrap() {
      log.info(`Video_Control v${VSC_VERSION} bootstrap start`);

      const Utils = createUtils();
      const Scheduler = createScheduler(14);
      const Bus = createEventBus();
      const ApplyReq = createApplyRequester(Bus, Scheduler);
      const Store = createLocalStore(DEFAULTS, Scheduler, Utils);

      // v191: load → normalize 순서 보정
      //       loadFromDisk 로 raw 값 적용 후 bindNormalizer 에서 정규화
      loadFromDisk(Store);

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

      Store.sub('app.*', () => UI.ensure());
      Store.sub('video.*', () => UI.ensure());
      Store.sub('audio.*', () => UI.ensure());
      Store.sub('playback.*', () => UI.ensure());

      // v191: scheduler.postTask for background storage writes
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
        if (Registry.videos.size > 0 || document.querySelector('video')) {
          UI.ensure();
          clearRecurring(__uiRetryId);
        } else if (__uiRetryCount > 15) {
          clearRecurring(__uiRetryId);
        }
      }, 200);

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
